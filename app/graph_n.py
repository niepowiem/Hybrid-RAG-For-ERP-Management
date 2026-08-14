import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from langchain_core.tools import tool
from neo4j import Driver, GraphDatabase
from neo4j.exceptions import ServiceUnavailable, AuthError

from app.builder_n import KnowledgeGraph, GraphClassSchema, RelationSchema, GraphNode, RelationEdge
from app.core_n import EmbeddingModel, PROJECT_ROOT, GRAPH_DB_URL, GRAPH_DB_PASSWORD, EMBEDDING_MODEL, ChatModel
from app.schema_n import KB_DATATYPE

# Bufor budowania grafu w pamięci. Używany przez narzędzia zapisujące
# (KNOWLEDGE_GRAPH_TOOLS) -- narzędzia czytające z Neo4j go NIE potrzebują.
# Połączenie z Neo4j. Potrzebne narzędziom przeszukującym i 'sync()'.
# Model liczący wektory. Potrzebny przy 'sync(embed_model=...)' i przy
# wyszukiwaniu semantycznym (pytanie też trzeba zamienić na wektor).
graph_driver: Driver | None = None
knowledge_graph: KnowledgeGraph | None = None
embedding_model: EmbeddingModel | None = None

PROMPTS_DIR = PROJECT_ROOT / "system"
GRAPHS_DIR = PROJECT_ROOT / "database" / "graphs"

# ======================================================================
# INICJALIZACJA
# ======================================================================

def initialize_knowledge_graph() -> None:
    """
    Tworzy pusty bufor grafu w pamięci i podstawia go pod globalną nazwę.

    UWAGA: nadpisuje istniejący bufor bez pytania. Wywołanie tego po zbudowaniu
    grafu, a przed 'sync()', kasuje całą pracę modelu. Do wczytania zapisanej
    kopii służy 'load_graph'.
    """

    global knowledge_graph

    knowledge_graph = KnowledgeGraph()

def initialize_graph_driver() -> None:
    """
    Otwiera połączenie z Neo4j i sprawdza, czy da się z niego korzystać.

    Weryfikacja jest tutaj, a nie przy pierwszym zapytaniu, bo błąd połączenia
    w środku ingestu oznaczałby utratę całej dotychczasowej pracy modelu.
    Sprawdzamy też obecność APOC -- bez niej 'sync()' wywali się dopiero przy
    pierwszej partii węzłów, z komunikatem z bazy, który nie mówi, co zainstalować.
    """

    global graph_driver

    graph_driver = GraphDatabase.driver(GRAPH_DB_URL, auth=("neo4j", GRAPH_DB_PASSWORD))

    # Rozdzielone wyjątki, bo wymagają zupełnie różnych działań: podniesienia
    # kontenera, poprawienia hasła w .env, albo czegoś nieprzewidzianego.
    try:
        graph_driver.verify_connectivity()
        print("OK: Połączenie z neo4j działa")

    except ServiceUnavailable as e:
        raise RuntimeError(f"Nie można połączyć się z bazą pod {GRAPH_DB_URL}: {e}") from e

    except AuthError as e:
        raise RuntimeError(f"Błędne dane logowania do neo4j (sprawdź GRAPH_DB_PASSWORD): {e}") from e

    except Exception as e:
        raise RuntimeError(f"Nieoczekiwany błąd połączenia z neo4j: {type(e).__name__}: {e}") from e

    def is_apoc_available(driver: Driver, database: str = "neo4j") -> bool:
        """Pytamy o 'apoc.merge', bo to tej rodziny procedur używa 'sync()'."""

        records, _, _ = driver.execute_query(
            "SHOW PROCEDURES YIELD name WHERE name STARTS WITH 'apoc.merge' RETURN count(*) AS n",
            database_=database,
        )

        return bool(records) and records[0]["n"] > 0

    if not is_apoc_available(driver=graph_driver):
        raise RuntimeError(
            "APOC nie jest zainstalowane w tej bazie Neo4j! "
            "Zainstaluj wtyczkę APOC (w Neo4j Desktop: zakładka Plugins przy bazie, "
            "albo w Docker: zmienna środowiskowa NEO4J_PLUGINS=[\"apoc\"]), "
            "restart bazy, i spróbuj ponownie."
        )

    print("APOC jest dostępne.")

def initialize_embed_model() -> None:
    """
    Tworzy globalną instancję modelu embedding, używaną przez 'sync()' i przez
    wyszukiwanie semantyczne (pytanie użytkownika też trzeba zamienić na wektor).
    """

    global embedding_model

    embedding_model = EmbeddingModel(EMBEDDING_MODEL)

# ======================================================================
# UTILS
# ======================================================================

_MARKDOWN_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.S)
def _strip_markdown_fence(text: str) -> str:
    """Zdejmuje otoczkę ```json ... ``` jeśli jest; w przeciwnym razie zwraca wejście."""

    match = _MARKDOWN_FENCE.match(text)
    return match.group(1) if match else text

def _llm_passed_invalid_parameters(value: Any) -> tuple[dict[str, Any] | None, str | None]:
    """
    Sprowadza argument 'parameters' do słownika albo zwraca czytelny błąd.

    Modele czasem wysyłają zagnieżdżony obiekt jako string JSON (czasem ucięty).
    Przyjmujemy oba warianty i zwracamy komunikat zamiast wyjątku walidacji --
    wyjątek w narzędziu @tool zrywa pętlę tool-callingu, a komunikat daje
    modelowi szansę poprawić się w następnej turze.

    Próby naprawy ucięcia są heurystyczne i celowo zachowawcze: doklejamy
    domykający nawias, ewentualnie brakujący cudzysłów. Jeśli żadna nie da
    poprawnego słownika, zwracamy błąd -- lepszy jawny błąd niż zgadnięta treść
    parametrów, która po cichu wejdzie do grafu.

    :param value: to, co przysłał model -- słownik, tekst JSON albo coś innego
    :return: (słownik, None) przy powodzeniu, (None, komunikat 'BŁĄD:') przy porażce
    """

    # None znaczy "nie podano", a nie "błąd" -- wołający sam zdecyduje,
    # czy pusty słownik jest dla niego akceptowalny.
    if value is None:
        return {}, None

    if isinstance(value, dict):
        return value, None

    if isinstance(value, str):
        # POPRAWKA: model owijający argument w blok markdown dostawał wcześniej
        # błąd parsowania, choć treść JSON-a była poprawna.
        text = _strip_markdown_fence(value)

        for candidate in (text, text + "}", text + '"}', text.rstrip(", ") + "}"):
            try:
                parsed = json.loads(candidate)

            except json.JSONDecodeError:
                continue

            if isinstance(parsed, dict):
                return parsed, None

        return None, (f"BŁĄD: 'parameters' musi być obiektem JSON (słownikiem), otrzymano "
                      f"nieprawidłowy tekst: {value!r}. Użyj podwójnych cudzysłowów i nie "
                      f"otaczaj argumentu blokiem markdown. Popraw i wywołaj narzędzie ponownie.")

    return None, f"BŁĄD: 'parameters' musi być obiektem JSON, otrzymano typ {type(value).__name__}."

def _llm_passed_invalid_list(value: Any) -> tuple[list[str] | None, str | None]:
    """
    Sprowadza argument listowy do listy napisów albo zwraca czytelny błąd.

    Analogiczne do '_llm_passed_invalid_parameters', ale dla list -- modele czasem
    wysyłają listę jako string JSON (np. '["nazwa", "opis"]') zamiast prawdziwej listy.

    Pojedynczy napis NIE jest tu automatycznie opakowywany w listę jednoelementową.
    Zgadywanie w tym miejscu byłoby ryzykowne: '"WYMAGA"' to prawdopodobnie jeden
    typ relacji, ale 'proc_a, proc_b' to już prawie na pewno pomyłka modelu, której
    nie chcemy cicho naprawiać.

    :param value: to, co przysłał model -- lista, tekst JSON albo coś innego
    :return: (lista napisów, None) przy powodzeniu, (None, komunikat) przy porażce
    """

    if value is None:
        return [], None

    if isinstance(value, list):
        # Lista z elementami innego typu to błąd, nie coś do konwersji przez str():
        # nazwa węzła podana jako liczba i tak nie znajdzie się w grafie.
        if not all(isinstance(x, str) for x in value):
            bad = [type(x).__name__ for x in value if not isinstance(x, str)]

            return None, (f"BŁĄD: oczekiwano listy stringów, ale lista zawiera elementy typu: "
                          f"{', '.join(bad)}. Podaj nazwy jako tekst, np. [\"tytul\", \"opis\"].")

        return value, None

    if isinstance(value, str):
        text = _strip_markdown_fence(value)

        try:
            parsed = json.loads(text)

        except json.JSONDecodeError:
            return None, (f"BŁĄD: nie udało się sparsować jako listy stringów: {value!r}. "
                          f"Podaj listę w formacie [\"a\", \"b\"]. Popraw i wywołaj narzędzie ponownie.")

        if isinstance(parsed, list) and all(isinstance(x, str) for x in parsed):
            return parsed, None

        return None, f"BŁĄD: oczekiwano listy stringów, otrzymano: {value!r}"

    return None, f"BŁĄD: oczekiwano listy stringów, otrzymano typ {type(value).__name__}."

def _llm_passed_invalid_int(value: Any, nazwa: str, domyslna: int) -> tuple[int | None, str | None]:
    """
    Sprowadza argument liczbowy do int albo zwraca czytelny błąd.

    POPRAWKA: parametry 'top_k', 'hops' i 'max_hops' były przyjmowane bez
    konwersji. Model wysyłający '3' zamiast 3 przekazywał NAPIS dalej --
    'hops' trafiał do konfiguracji APOC jako tekst, a 'top_k' do zapytania
    Cypher, gdzie wywoływał błąd typu dopiero po stronie bazy.

    :param value: to, co przysłał model
    :param nazwa: nazwa argumentu, do komunikatu
    :param domyslna: wartość przy None
    :return: (liczba, None) przy powodzeniu, (None, komunikat) przy porażce
    """

    if value is None:
        return domyslna, None

    if isinstance(value, bool):
        # bool dziedziczy po int, więc przeszedłby niżej jako 0/1 -- prawie na
        # pewno nie o to modelowi chodziło.
        return None, f"BŁĄD: '{nazwa}' musi być liczbą całkowitą, otrzymano wartość logiczną."

    if isinstance(value, int):
        return value, None

    try:
        return int(str(value).strip()), None

    except (TypeError, ValueError):
        return None, f"BŁĄD: '{nazwa}' musi być liczbą całkowitą, otrzymano: {value!r}"

def __graph_required() -> None:
    """
    Wspólne sprawdzenie dla narzędzi zapisujących do bufora w pamięci.
    Zwraca komunikat, jeśli bufor nie istnieje -- inaczej None.
    """

    if knowledge_graph is None:
        raise Exception("BŁĄD: Graf w pamięci nie został zainicjalizowany. "
                        "Wywołaj 'initialize_knowledge_graph()' po stronie Pythona.")

# ======================================================================
# NARZĘDZIA: KLASY
# ======================================================================

@tool
def define_class(class_name: str, parameters: dict[str, Any] | str,parameters_to_embed: list[str] | str | None = None) -> str:
    """
    Defines a new node class (entity type) with a FIXED set of allowed parameters.
    Every node of this class must have exactly these parameters (no more, no less).
    Call this ONCE per class, before creating any node of that class with 'merge'.

    Use 'read_classes' first to check if a similar class already exists, to avoid
    creating near-duplicate classes (e.g. "Procedure" and "Procedura").

    :param class_name: Unique class name in PascalCase (letters, digits, underscore only,
        must start with a letter, e.g. "Procedura", "DokumentMagazynowy").
        Cannot start with "C_" -- that prefix is reserved for automatic class labels.
    :param parameters: Dict of {parameter_name: example_value}. The example value's TYPE
        becomes the required type for that parameter on every node of this class.
        Allowed types: str, int, float, bool, or a homogeneous NON-EMPTY list of one of
        these (e.g. ["a", "b"] for a list of strings). An empty list is rejected --
        the element type cannot be inferred from it. Nested objects/dicts are NOT allowed.
        Must contain at least one parameter. Do NOT include 'node_id', 'klasa' or
        'modul' -- these names are reserved and managed automatically by the system.
    :param parameters_to_embed: Optional list of parameter names (must be a subset of
        'parameters' above) whose content should be combined into a semantic embedding
        for every node of this class -- enables finding these nodes via
        'search_knowledge_graph'. Only set this for classes with real searchable
        content (procedures, error descriptions, concepts) -- omit for purely
        structural/technical classes. Can also be set later via 'add_embedding_parameters'.
    :return: confirmation message, or an explanation of what went wrong
    """

    __graph_required()

    params, error = _llm_passed_invalid_parameters(parameters)
    if error:
        return error

    embed_params, embed_error = _llm_passed_invalid_list(parameters_to_embed)
    if embed_error:
        return embed_error

    return knowledge_graph.define_class(class_name, params, parameters_to_embed=embed_params)

@tool
def add_class_parameters(class_name: str, parameters: dict[str, Any] | str) -> str:
    """
    Adds new parameters to an EXISTING class. Use this instead of 'define_class' when
    a class needs an additional field it didn't have before.
    Parameters that already exist on the class are silently skipped (not overwritten).

    Note: nodes created BEFORE this call do not get the new parameter retroactively --
    they will use the class default value when written to the database.

    :param class_name: Name of an existing class (check with 'read_classes')
    :param parameters: Dict of {parameter_name: example_value} to add. Same type rules
        as 'define_class'.
    :return: confirmation message, or an explanation of what went wrong
    """

    __graph_required()

    params, error = _llm_passed_invalid_parameters(parameters)
    if error:
        return error

    return knowledge_graph.add_class_parameters(class_name, params)

@tool
def read_classes() -> str:
    """
    Lists ALL defined classes with their parameters (name, type, default value).
    Call this before 'define_class' to avoid creating a near-duplicate class,
    or before 'merge' to check what parameters a given class expects.
    """

    __graph_required()

    return knowledge_graph.read_classes()

# ======================================================================
# NARZĘDZIA: EMBEDDINGI (wyszukiwanie wektorowe)
# ======================================================================

@tool
def add_embedding_parameters(class_name: str, parameters_to_embed: list[str] | str) -> str:
    """
    Marks existing parameters of a class as ones that should be used to compute a
    semantic embedding (vector) for every node of that class. This powers semantic
    search over the knowledge graph -- nodes whose classes have NO embedded parameters
    will never show up in semantic search results.

    Only call this for classes whose nodes are actually meaningful to search for
    semantically (e.g. procedures, error descriptions, concepts) -- not for purely
    structural/technical classes.

    The ORDER you list the parameters in matters: it determines the order of the text
    that gets embedded, and therefore the resulting vector.

    :param class_name: Name of an existing class (check with 'read_classes')
    :param parameters_to_embed: List of parameter names (must already exist on the
        class, e.g. ["nazwa", "opis"]) whose STRING content will be combined and
        embedded for every node of this class
    :return: confirmation message, or an explanation of what went wrong
    """

    __graph_required()

    parameters, error = _llm_passed_invalid_list(parameters_to_embed)
    if error:
        return error

    return knowledge_graph.add_embedding_parameters(class_name, parameters)

@tool
def remove_embedding_parameters(class_name: str, parameters_to_embed: list[str] | str) -> str:
    """
    Removes parameters from the list of ones used to compute a class's embedding
    (set via 'add_embedding_parameters'). The parameters themselves stay on the class
    schema -- they just stop being included in the embedded text.

    :param class_name: Name of an existing class
    :param parameters_to_embed: List of parameter names to remove from the embedding list
        (must currently be marked as embedded -- check with 'read_embedding_parameters')
    :return: confirmation message, or an explanation of what went wrong
    """

    # POPRAWKA: narzędzie nazywało się 'remove_embeddings_parameters' (liczba mnoga)
    # i wołało metodę o tej samej nazwie. Metoda w KnowledgeGraph została
    # ujednolicona do liczby pojedynczej, zgodnie z 'add_embedding_parameters'
    # i 'read_embedding_parameters'. Nazwa narzędzia trafia wprost do promptu,
    # więc niekonsekwencja w tym miejscu to realne źródło pomyłek modelu.
    __graph_required()

    parameters, error = _llm_passed_invalid_list(parameters_to_embed)
    if error:
        return error

    return knowledge_graph.remove_embedding_parameters(class_name, parameters)

@tool
def read_embedding_parameters(class_name: str) -> str:
    """
    Shows which parameters of a class are currently marked for embedding (used in
    semantic search). Call this to check before adding/removing embedded parameters,
    or to understand why a class's nodes may or may not appear in semantic search results.

    :param class_name: Name of an existing class to inspect
    """

    __graph_required()

    return knowledge_graph.read_embedding_parameters(class_name)

# ======================================================================
# NARZĘDZIA: WĘZŁY
# ======================================================================

@tool
def merge(node_name: str, class_name: str, module: str, parameters: dict[str, Any] | str) -> str:
    """
    Creates a NEW node in the knowledge graph. FAILS if a node with this name already
    exists -- this is intentional, to prevent accidentally overwriting existing data.
    Use 'edit_node_parameters' to update an existing node instead.

    The class must already be defined (use 'define_class' first). Parameters you omit
    are filled in with the class default values.

    :param node_name: Unique identifier for this node (e.g. "proc_pz_001"). Letters,
        digits and underscores only -- replace any dots or dashes from the source
        document with underscores ("proc.magazyn.przyjecie-pz" becomes
        "proc_magazyn_przyjecie_pz"). Must not already exist -- check with
        'read_node_names' if unsure.
    :param class_name: The class this node belongs to (must already be defined)
    :param module: ERP module this node belongs to, e.g. "Magazyn", "Sprzedaz",
        "Ksiegowosc". REQUIRED. Use the exact module name from the source document.
        Do NOT put the module inside 'parameters' -- it is a system field, like the
        node's name.
    :param parameters: Dict of {parameter_name: value} matching the class's schema.
        Check the class's expected parameters with 'read_classes' first if unsure.
    :return: confirmation message, or an explanation of what went wrong (e.g. wrong
        value types, unknown parameters, or a node with this name already exists)
    """

    __graph_required()

    params, error = _llm_passed_invalid_parameters(parameters)
    if error:
        return error

    return knowledge_graph.merge(node_name, class_name, module, params)

@tool
def edit_node_parameters(node_name: str, parameters: dict[str, Any] | str, module: str | None = None) -> str:
    """
    Updates parameters of an EXISTING node. This is a PARTIAL update -- only the
    parameters you provide are changed, everything else on the node stays the same.

    Use this to correct or update a node that was already created with 'merge'.
    If the node doesn't exist yet, use 'merge' instead to create it.

    :param node_name: Name of an existing node (check with 'read_node_names')
    :param parameters: Dict of {parameter_name: new_value} for only the fields you
        want to change
    :param module: Optional -- new ERP module for this node. Omit to leave it unchanged.
    :return: confirmation message, or an explanation of what went wrong
    """

    # POPRAWKA: narzędzie nie wystawiało argumentu 'module', choć metoda
    # KnowledgeGraph go przyjmuje. Model, który przy 'merge' wpisał zły moduł,
    # nie miał żadnej drogi, żeby to naprawić -- 'merge' odmawia nadpisania
    # istniejącego węzła, a edycja nie sięgała do tego pola.
    __graph_required()

    params, error = _llm_passed_invalid_parameters(parameters)
    if error:
        return error

    return knowledge_graph.edit_node_parameters(node_name, params, module=module)

@tool
def read_node_names() -> str:
    """
    Lists ALL existing node names in the graph. Call this before 'merge' to check
    whether a node already exists, or before 'relationship' to find valid target
    node names.
    """

    __graph_required()

    return knowledge_graph.read_node_names()

@tool
def read_node_parameters(node_name: str) -> str:
    """
    Shows the class, module and all parameter values (including class defaults) of a
    specific node.

    :param node_name: Name of the node to inspect
    """

    __graph_required()

    return knowledge_graph.read_node_parameters(node_name)

# ======================================================================
# NARZĘDZIA: RELACJE
# ======================================================================

@tool
def define_relation(relation: str, parameters: dict[str, Any] | str | None = None) -> str:
    """
    Registers a new TYPE of relationship that can later connect nodes (via 'relationship').
    Optionally gives it standardized properties that every use of this relation type must
    carry (e.g. a "WYMAGA" relation might always need a "priorytet" property).

    Call this ONCE per relation type, before using it in 'relationship'. If a relation
    type doesn't need any properties (e.g. a simple "ZNA" relation), just omit 'parameters'.

    :param relation: Name of the relation type, e.g. "WYMAGA", "DOTYCZY", "NALEZY_DO"
        (automatically uppercased). Letters, digits, underscore only -- no Polish
        diacritics.
    :param parameters: Optional dict of {property_name: example_value} that every use
        of this relation should carry. Omit entirely if this relation has no properties.
    :return: confirmation message, or an explanation of what went wrong
    """

    __graph_required()

    # None przekazujemy dalej jako None, a nie jako pusty słownik: 'define_relation'
    # po stronie grafu rozróżnia "brak właściwości" od "właściwości podane, ale puste"
    # tylko przez tę wartość.
    if parameters is None:
        params = None

    else:
        params, error = _llm_passed_invalid_parameters(parameters)
        if error:
            return error

    return knowledge_graph.define_relation(relation, params)

@tool
def add_relation_parameters(relation: str, parameters: dict[str, Any] | str) -> str:
    """
    Adds new standardized properties to an EXISTING relation type. Use this instead of
    'define_relation' when a relation type needs an additional property it didn't have before.

    :param relation: Name of an existing relation type (check with 'read_relationships')
    :param parameters: Dict of {property_name: example_value} to add
    :return: confirmation message, or an explanation of what went wrong
    """

    __graph_required()

    params, error = _llm_passed_invalid_parameters(parameters)
    if error:
        return error

    return knowledge_graph.add_relation_parameters(relation, params)


@tool
def relationship(from_node: str, to_nodes: list[str] | str, relation: str, parameters: dict[str, Any] | str | None = None) -> str:
    """
    Connects an EXISTING node ('from_node') to one or more other EXISTING nodes
    ('to_nodes') with a directed relationship of the given type. Both the relation type
    and all nodes must already exist -- use 'define_relation' and 'merge' first if not.

    Every target in 'to_nodes' gets the SAME properties in this one call, but separate
    calls to the same relation type CAN carry different properties for different targets
    (e.g. two "WYMAGA" relations from the same node can each have a different "priorytet").

    :param from_node: Source node (must already exist -- check with 'read_node_names')
    :param to_nodes: List of target node names (must already exist). Use a single-item
        list to connect to just one node, or multiple to connect to several at once.
    :param relation: Relation type (must already be registered via 'define_relation')
    :param parameters: Properties for this specific relationship, matching the relation
        type's schema. Omit if the relation type has no required properties.
    :return: confirmation message per target, or an explanation of what went wrong
    """

    __graph_required()

    targets, list_error = _llm_passed_invalid_list(to_nodes)
    if list_error:
        return list_error

    if not targets:
        return "BŁĄD: 'to_nodes' jest puste! Podaj co najmniej jeden istniejący node docelowy."

    if parameters is None:
        params = None

    else:
        params, error = _llm_passed_invalid_parameters(parameters)
        if error:
            return error

    # POPRAWKA: przekazywane było surowe 'to_nodes', a nie sparsowane 'targets'.
    # Gdy model wysłał listę jako tekst JSON ('["p1", "p2"]'), do grafu trafiał
    # NAPIS. 'set(to_nodes)' iterowało po nim ZNAK PO ZNAKU, więc zamiast dwóch
    # węzłów powstawała próba połączenia z '[', '"', 'p', '1'... -- każdy jako
    # osobny nieistniejący węzeł. Cała walidacja powyżej była w tym wariancie
    # bezużyteczna, bo jej wynik nigdzie nie szedł.
    return knowledge_graph.relationship(from_node, targets, relation, params)

@tool
def read_relationships() -> str:
    """
    Lists ALL defined relation types with their standardized properties (if any).
    Call this before 'define_relation' to avoid duplicates, or before 'relationship'
    to check what properties a relation type expects.
    """

    __graph_required()

    return knowledge_graph.read_relationships()

@tool
def read_node_relations(node_name: str, relation: str | None = None) -> str:
    """
    Shows the OUTGOING relationships of a specific node -- either all of them, or just
    one relation type if specified. Use this to check existing connections before adding
    new ones, to avoid creating duplicates.

    :param node_name: Name of the node to inspect
    :param relation: Optional -- limit results to just this relation type
    """

    __graph_required()

    return knowledge_graph.read_node_relations(node_name, relation)

# ======================================================================
# NARZĘDZIA: ETYKIETY
# ======================================================================

@tool
def define_label(label: str) -> str:
    """
    Registers a new, OPTIONAL tag that can later be attached to any node (via
    'add_node_label'), independent of its class. Use this for cross-cutting flags
    that don't fit the class system, e.g. "Priorytetowe", "DoWeryfikacji", "Przestarzale".

    Do NOT use this for the node's type/category -- that's what classes are for.
    Labels are for optional, orthogonal tagging, not for defining what a node IS.

    :param label: Name to register (letters, digits, underscore only, must start with
        a letter). Cannot start with "C_" (reserved for automatic class labels) and
        cannot be "SHARED" (applied to every node automatically).
    :return: confirmation message, or an explanation of what went wrong
    """

    __graph_required()

    return knowledge_graph.define_label(label)

@tool
def add_node_label(node_name: str, label: str) -> str:
    """
    Attaches an already-registered label (see 'define_label') to a specific, existing
    node. A node can have multiple labels at once -- call this once per label to add.

    :param node_name: Name of an existing node (check with 'read_node_names')
    :param label: Name of an already-registered label (check with 'read_labels')
    :return: confirmation message, or an explanation of what went wrong
    """

    __graph_required()

    return knowledge_graph.add_node_label(node_name, label)

@tool
def read_labels() -> str:
    """Lists all registered, optional labels available to attach to nodes via 'add_node_label'."""

    __graph_required()

    return knowledge_graph.read_labels()

@tool
def read_node_labels(node_name: str) -> str:
    """
    Shows all labels currently attached to a specific node, grouped by source:
    the shared system label, the automatic class label, and manually added ones.

    :param node_name: Name of the node to inspect
    """

    __graph_required()

    return knowledge_graph.read_node_labels(node_name)

# ======================================================================
# NARZĘDZIA: PRZESZUKIWANIE (czytają Neo4j, NIE bufor w pamięci)
# ======================================================================
# Te trzy narzędzia dostaje agent odpowiadający na pytania. Nie wymagają
# 'knowledge_graph' -- odpytują bazę, więc działają także w procesie, który
# nigdy nie budował grafu.

@tool
def search_knowledge_graph(query: str, top_k: int = 5, module: str | None = None) -> str:
    """
    Semantically searches the ENTIRE knowledge graph for nodes most relevant to the
    query, regardless of their class. Use this to find procedures, errors, or concepts
    related to a user's question, even if exact keywords don't match -- this is meaning-based
    search, not keyword search.

    Only classes with embedded parameters (see 'add_embedding_parameters') are searchable
    this way -- if a relevant class was never marked for embedding, its nodes won't appear here.

    :param query: Natural language question or description to search for
    :param top_k: How many results to return (default 5)
    :param module: Optional and rarely needed -- restrict results to a single ERP module.
        Leave this out by default: a user working in one module may legitimately ask
        about another, and narrowing the search would hide the answer.
    :return: matching nodes with their class, relevance score, and properties
    """

    if graph_driver is None or embedding_model is None:
        return "BŁĄD: Baza danych lub model embeddingów nie zostały zainicjalizowane."

    k, error = _llm_passed_invalid_int(top_k, "top_k", 5)
    if error:
        return error

    # encode() zwraca listę wektorów -- bierzemy pierwszy, bo embedujemy jedno
    # zapytanie. Ten sam kontrakt obowiązuje przy liczeniu embeddingów węzłów.
    query_embedding = embedding_model.embed(query).embeddings[0]

    results = KnowledgeGraph.search_semantic(graph_driver, query_embedding, top_k=k, module=module)

    return _format_search_results(results)

@tool
def explore_neighbors(node_id: str, hops: int = 2, relation_types: list[str] | str | None = None) -> str:
    """
    Multi-hop exploration: starting from a KNOWN node, explores its neighborhood up to
    'hops' steps away through relationships, returning all nodes and relationships found.
    Use this AFTER finding a relevant node (e.g. via 'search_knowledge_graph') to gather
    additional connected context -- for example, finding all documents a procedure requires,
    and everything THOSE documents relate to, two steps out.

    :param node_id: Starting node (must exist -- check with 'search_knowledge_graph' or 'read_node_names')
    :param hops: How many relationship steps to explore outward (default 2). Higher values
        return more context but grow quickly -- start small (1-2) unless you need more.
    :param relation_types: Optional list of relation types to restrict traversal to
        (e.g. ["WYMAGA", "DOTYCZY"]). Omit to follow any relationship type.
    :return: nodes and relationships found within the given number of hops
    """

    if graph_driver is None:
        return "BŁĄD: Baza danych nie została zainicjalizowana."

    types, list_error = _llm_passed_invalid_list(relation_types)
    if list_error:
        return list_error

    liczba_krokow, error = _llm_passed_invalid_int(hops, "hops", 2)
    if error:
        return error

    # POPRAWKA: przekazywane było surowe 'relation_types' zamiast sparsowanego
    # 'types'. Przy liście wysłanej jako tekst JSON filtr APOC dostawał
    # '[|"|W|Y|M|A|G|A|"...' -- każdy znak jako osobny typ relacji, więc
    # przeszukiwanie nie znajdowało niczego i wyglądało to na pusty graf.
    result = KnowledgeGraph.explore_neighbors(graph_driver, node_id, hops=liczba_krokow, relation_types=types or None)

    return _format_subgraph(result)

@tool
def find_path_between_nodes(from_node_id: str, to_node_id: str, max_hops: int = 6) -> str:
    """
    Finds the shortest connection path between two KNOWN nodes in the graph, through
    any relationships, in either direction. Use this to understand how two known
    entities relate to each other, e.g. how a specific error connects to a specific
    procedure.

    Note: the path ignores relationship direction, so it shows that a connection
    exists -- it is not a sequence of steps the user should perform.

    :param from_node_id: Starting node (must exist)
    :param to_node_id: Target node (must exist)
    :param max_hops: Maximum path length to consider (default 6)
    :return: the path as an alternating sequence of nodes and relationships, or a
        message saying no connection was found
    """

    if graph_driver is None:
        return "BŁĄD: Baza danych nie została zainicjalizowana."

    limit, error = _llm_passed_invalid_int(max_hops, "max_hops", 6)
    if error:
        return error

    path = KnowledgeGraph.find_shortest_path(graph_driver, from_node_id, to_node_id, max_hops=limit)

    return _format_path(path)

# Wersja formatu zrzutu grafu. Podniesienie oznacza, że starsze pliki mogą się
# wczytać, ale będą niepełne, 'load_graph' ostrzega o tym jawnie. Wersja 2
# wprowadziła pole 'modul'; pliki w wersji 1 wczytywały się wcześniej po cichu,
# a filtr modułu zwracał dla nich pustkę.
GRAPH_FORMAT_VERSION = 2
KNOWLEDGE_GRAPH_TOOLS = [
    # Klasy
    define_class,
    add_class_parameters,
    read_classes,

    # Embeddingi
    add_embedding_parameters,
    remove_embedding_parameters,
    read_embedding_parameters,

    # Nody
    merge,
    edit_node_parameters,
    read_node_names,
    read_node_parameters,

    # Relacje
    define_relation,
    add_relation_parameters,
    relationship,
    read_relationships,
    read_node_relations,

    # Etykiety
    define_label,
    add_node_label,
    read_labels,
    read_node_labels
]
KNOWLEDGE_GRAPH_TRAVERSE_TOOLS = [
    search_knowledge_graph,
    explore_neighbors,
    find_path_between_nodes
]

# ======================================================================
# AGENCI
# ======================================================================

def build_graph_with_llm(model:str, documents: str, provider:str | None = None):
    if knowledge_graph is None:
        raise RuntimeError("Wywołaj 'initialize_knowledge_graph()' przed 'build_graph_with_ollama'")

    system = (PROMPTS_DIR / "prompt_4_90826.md").read_text(encoding="utf-8")
    chat = ChatModel(model=model, system=system, provider=provider, tools=KNOWLEDGE_GRAPH_TOOLS)
    chat.pretty(documents, max_tool_iterations=1024, think=False)

    # Zapisujemy sporządzony graf
    save_graph(model=model, directory=GRAPHS_DIR / "preprocess")

def answer_with_llm(chat: ChatModel, question:str):
    chat.pretty(message=question)

# def answer_with_ollama(model: str, question: str, system: str | None = None) -> None:
#     """
#     Uruchamia agenta odpowiadającego na pytania, korzystającego WYŁĄCZNIE z narzędzi
#     wyszukiwania (KNOWLEDGE_GRAPH_TRAVERSE_TOOLS) -- bez dostępu do zapisu grafu.
#
#     W przeciwieństwie do 'build_graph_with_ollama' NIE wymaga zainicjalizowanego
#     'knowledge_graph' (bufora budującego) -- czyta z Neo4j, więc potrzebuje tylko
#     sterownika i modelu embeddingów.
#
#     :param model: nazwa modelu LLM
#     :param question: pytanie użytkownika
#     :param system: prompt systemowy; None = wczytaj domyślny z 'system/'
#     """
#
#     if graph_driver is None or embedding_model is None:
#         raise RuntimeError("Wywołaj 'initialize_graph_driver()' i 'initialize_embed_model()' przed 'answer_with_ollama'")
#
#     if system is None:
#         system = (PROMPTS_DIR / "q_prompt_1_120826.md").read_text(encoding="utf-8")
#
#     llm = ChatModel(model=model,
#                     system=system,
#                     tools=KNOWLEDGE_GRAPH_TRAVERSE_TOOLS)
#
#     llm.pretty(message=question)

# ======================================================================
# PODGLĄD I FORMATOWANIE
# ======================================================================

def print_graph(kg: KnowledgeGraph | None = None) -> None:
    """
    Szybki podgląd całego grafu w konsoli -- klasy, relacje, etykiety, węzły
    (z parametrami, relacjami i etykietami każdego z nich) -- bez potrzeby Neo4j,
    czyta bezpośrednio z bufora w pamięci.

    Używa metod z internal=True tam, gdzie to możliwe: prefiksy 'INFO:' są
    przeznaczone dla modelu, a nie dla człowieka czytającego zrzut.

    :param kg: graf do wypisania (domyślnie globalny bufor)
    """

    kg = kg if kg is not None else knowledge_graph

    # POPRAWKA: bez tego sprawdzenia wywołanie przed 'initialize_knowledge_graph()'
    # kończyło się AttributeError na None, zamiast powiedzieć, czego brakuje.
    if kg is None:
        print("BŁĄD: Brak grafu do wypisania -- wywołaj 'initialize_knowledge_graph()' "
              "albo 'load_graph(...)'.")
        return

    sep = "=" * 70

    print("\n\n" + sep)
    print("KLASY")
    print(sep)
    print(kg.read_classes())

    print(f"\n{sep}")
    print("RELACJE (zarejestrowane typy)")
    print(sep)
    print(kg.read_relationships())

    print(f"\n{sep}")
    print("ETYKIETY (zarejestrowane, opcjonalne)")
    print(sep)
    print(kg.read_labels())

    print(f"\n{sep}")
    print(f"WĘZŁY ({len(kg.nodes)})")
    print(sep)

    if not kg.nodes:
        print("(brak węzłów)")
        return

    for node_name in kg.nodes:
        print(f"\n--- {node_name} ---")
        print(kg.read_node_parameters(node_name, internal=True))
        print(kg.read_node_labels(node_name, internal=True))
        print(kg.read_node_relations(node_name))

def _format_search_results(results: list[dict[str, Any]]) -> str:
    """
    Zamienia wynik 'search_semantic' na tekst dla modelu.

    'node_id' i 'klasa' są pomijane w wyliczeniu właściwości, bo pojawiają się
    już w nagłówku wiersza -- powtórzenie ich zajmowałoby kontekst bez zysku.
    Wektor został usunięty wcześniej, po stronie 'search_semantic'.
    """

    if not results:
        return "Nie znaleziono żadnych pasujących węzłów."

    lines = []
    for r in results:
        props = ', '.join(f"{k}={v!r}" for k, v in r["properties"].items() if k not in ("node_id", "klasa"))
        lines.append(f" - {r['node_id']} ({r['klasa']}, score={r['score']:.3f}): {props}")

    return '\n'.join(lines)

def _format_subgraph(result: dict[str, Any]) -> str:
    """
    Zamienia wynik 'explore_neighbors' na tekst dla modelu.

    Węzły i relacje wypisywane osobno, a nie jako lista ścieżek: ten sam węzeł
    bywa osiągalny wieloma drogami, a powtarzanie go przy każdej rozdmuchiwałoby
    kontekst. Notacja (A)-[REL]->(B) niesie kierunek, którego sama lista nie ma.
    """

    if not result["nodes"]:
        return "Nie znaleziono żadnych sąsiadów (sprawdź, czy węzeł istnieje w bazie)."

    node_lines = [f" - {n['node_id']} ({n['klasa']})" for n in result["nodes"]]
    rel_lines = [f" - ({r['from']})-[{r['type']}]->({r['to']}) {r['properties']}" for r in result["relationships"]]

    return (f"Węzły ({len(result['nodes'])}):\n" + '\n'.join(node_lines) +
            f"\n\nRelacje ({len(result['relationships'])}):\n" + ('\n'.join(rel_lines) or " (brak)"))

def _format_path(path: list[dict[str, Any]] | None) -> str:
    """
    Zamienia wynik 'find_shortest_path' na tekst dla modelu.

    None (brak połączenia) i pusta ścieżka to dwie różne rzeczy, stąd osobny
    komunikat zamiast pustego stringa.
    """

    if path is None:
        return "Nie znaleziono ścieżki między tymi węzłami (brak połączenia w podanym limicie kroków)."

    parts = []
    for step in path:
        if step["type"] == "node":
            parts.append(f"({step['node_id']}:{step['klasa']})")
        else:
            parts.append(f"-[{step['relation']}]->")

    return ' '.join(parts)

# ======================================================================
# BAZA
# ======================================================================

def _safe_filename_part(text: str) -> str:
    """
    Nazwa modelu zawiera dwukropek ('qwen3.5:9b'), który jest niedozwolony
    w nazwach plików na Windows -- zamieniamy na myślnik.
    """

    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", text.strip())

    return cleaned.strip("-.") or "unknown"

def purge_database(driver: Driver, database: str = "neo4j", batch: int = 1024) -> None:
    """
    Kasuje WSZYSTKIE węzły i relacje z bazy.

    'apoc.periodic.iterate' zamiast zwykłego 'MATCH (n) DETACH DELETE n', bo
    to drugie próbuje zmieścić całe usunięcie w jednej transakcji i przy większym
    grafie wyczerpuje pamięć. Tutaj kasowanie idzie partiami.

    Nie dotyka ograniczeń ani indeksów -- zakłada je z powrotem 'sync()'.

    :param driver: połączenie neo4j
    :param database: nazwa bazy
    :param batch: ile węzłów na jedną transakcję
    """

    driver.execute_query(
        """
        CALL apoc.periodic.iterate(
            'MATCH (n) RETURN n',
            'DETACH DELETE n',
            {batchSize: $batch_size}
        )
        """,
        batch_size=batch,
        database_=database,
    )

def save_graph(model: str, directory: Path | str | None = None, embed_model_name: str | None = None) -> Path:
    """
    Zapisuje graf z pamięci do pliku JSON w 'knowledge/graphs/'. Nazwa pliku zawiera
    datę, godzinę i model, którym graf zbudowano, np.:
        2026-08-08_14-30-12_qwen3.5-9b.json

    Zapisujemy strukturę, a nie zrzut obiektów: dzięki temu plik jest czytelny
    dla człowieka i daje się porównać między przebiegami zwykłym diffem.

    POPRAWKA NAZWY: argument nazywał się 'embed_model' i PRZESŁANIAŁ globalną
    nazwę modelu embeddingów. Wewnątrz funkcji 'embed_model' było napisem albo
    None, więc gdyby ktoś chciał tu sięgnąć po prawdziwy model, dostałby cichą
    niespodziankę.

    :param model: nazwa modelu LLM użytego do budowy grafu (trafia do nazwy pliku i metadanych)
    :param kg: graf do zapisania (domyślnie globalny 'knowledge_graph')
    :param directory: katalog docelowy (domyślnie 'knowledge/graphs/')
    :param with_embeddings: czy zapisać wektory. Domyślnie NIE -- przy bge-m3 to 1024 liczby
        na węzeł, co potrafi rozdąć plik do dziesiątek MB. Embeddingi i tak są przeliczane
        od nowa przy 'sync()', więc do wersjonowania grafu nie są potrzebne.
    :param embed_model_name: opcjonalna nazwa modelu embeddingów (tylko do metadanych)
    :return: ścieżka zapisanego pliku
    """

    if knowledge_graph is None:
        raise RuntimeError("Brak grafu do zapisania - wywołaj 'initialize_knowledge_graph()'")

    with_embeddings:bool = embed_model_name is not None
    directory = Path(directory) if directory else GRAPHS_DIR
    directory.mkdir(parents=True, exist_ok=True)

    now = datetime.now()
    baza = f"{now:%Y-%m-%d_%H-%M-%S}_{_safe_filename_part(model)}"
    path = directory / f"{baza}.json"

    # Dwa zapisy w tej samej sekundzie miały tę samą nazwę i drugi po cichu
    # nadpisywał pierwszy. Przy kopii zapasowej to najgorszy możliwy błąd.
    licznik = 2
    while path.exists():
        path = directory / f"{baza}_{licznik}.json"
        licznik += 1

    nodes: dict[str, Any] = {}
    embeddings_saved: int = 0

    for node_name, node in knowledge_graph.nodes.items():
        # sorted() na etykietach: bez tego ten sam graf dawałby przy każdym
        # zapisie inaczej ułożony JSON i diff pokazywałby zmiany, których nie ma.
        entry: dict[str, Any] = {
            "klasa": node.c_name,
            "modul": node.module,
            "parametry": node.c_parameters,
            "etykiety": sorted(node.n_labels),
            "relacje": {
                relation: [{"target": edge.target, "parametry": edge.r_parameters} for edge in edges]
                for relation, edges in node.n_relations.items()
            },
        }

        if with_embeddings and node.embeddings is not None:
            entry["embeddings"] = node.embeddings
            embeddings_saved += 1

        nodes[node_name] = entry

    payload: dict[str, Any] = {
        # Metadane służą do rozpoznania, CZYM i KIEDY zbudowano graf. Przy
        # porównywaniu dwóch przebiegów to zwykle pierwsza rzecz, jakiej się szuka.
        "meta": {
            "format_version": GRAPH_FORMAT_VERSION,
            "zapisano": now.isoformat(timespec="seconds"),
            "model": model,
            "embed_model": embed_model_name,
            "liczba_klas": len(knowledge_graph.classes),
            "liczba_relacji": len(knowledge_graph.relations),
            "liczba_wezlow": len(knowledge_graph.nodes),
            "liczba_polaczen": sum(len(edges) for node in knowledge_graph.nodes.values() for edges in node.n_relations.values()),
            "embeddings_zapisane": embeddings_saved if with_embeddings else None,
        },
        "klasy": {name: schema.model_dump() for name, schema in knowledge_graph.classes.items()},
        "relacje": {name: schema.model_dump() for name, schema in knowledge_graph.relations.items()},
        "etykiety": sorted(knowledge_graph.labels),
        "wezly": nodes,
    }

    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    return path

def load_graph(path: Path | str, set_global: bool = True, strict: bool = True) -> KnowledgeGraph:
    """
    Wczytuje graf zapisany przez 'save_graph'. Domyślnie podstawia go pod globalny
    'knowledge_graph', żeby narzędzia i 'sync()' od razu na nim działały.

    Wczytywanie omija CAŁĄ walidację narzędzi -- węzły trafiają wprost do struktur,
    bez przejścia przez 'merge' czy 'define_class'. Dlatego zaraz po wczytaniu
    idzie '_validate_loaded_graph': to jedyne miejsce, w którym niespójny plik
    da się wykryć, zanim narobi szkód w Neo4j.

    :param path: ścieżka do pliku JSON
    :param set_global: czy podstawić wczytany graf jako globalny bufor
    :param strict: czy przerywać przy niespójnościach (nieznana klasa, relacja
        donikąd). Przy False problemy są tylko wypisywane.
    :return: wczytany graf
    """

    global knowledge_graph

    path = Path(path)

    try:
        data = json.loads(path.read_text(encoding="utf-8"))

    except json.JSONDecodeError as e:
        raise ValueError(f"Plik '{path.name}' nie jest poprawnym JSON-em: {e}") from e

    version = data.get("meta", {}).get("format_version")

    # Brak wersji oznacza plik z zupełnie innego źródła. Wczytanie go "na próbę"
    # skończyłoby się KeyError w losowym miejscu, więc odmawiamy od razu.
    if version is None:
        raise ValueError(f"Plik '{path.name}' nie ma pola 'meta.format_version' "
                         f"-- to nie jest zrzut grafu z 'save_graph'.")

    # Nowszy format może mieć pola, których ten kod nie rozumie -- wczytanie go
    # dałoby graf po cichu niepełny.
    if version > GRAPH_FORMAT_VERSION:
        raise ValueError(f"Plik '{path.name}' zapisano nowszą wersją formatu ({version}); "
                         f"ten kod obsługuje maksymalnie {GRAPH_FORMAT_VERSION}.")

    # Brakujące sekcje wychwytujemy tutaj, żeby zamiast gołego KeyError
    # dostać informację, czego brakuje.
    for sekcja in ("klasy", "relacje", "etykiety", "wezly"):
        if sekcja not in data:
            raise ValueError(f"Plik '{path.name}' jest niekompletny -- brak sekcji '{sekcja}'.")

    kg = KnowledgeGraph()
    kg.classes = {name: GraphClassSchema(**schema) for name, schema in data["klasy"].items()}
    kg.relations = {name: RelationSchema(**schema) for name, schema in data["relacje"].items()}
    kg.labels = set(data["etykiety"])

    for node_name, entry in data["wezly"].items():
        kg.nodes[node_name] = GraphNode(
            c_name=entry["klasa"],
            module=entry.get("modul", ""),
            c_parameters=entry.get("parametry", {}),
            n_labels=set(entry.get("etykiety", [])),
            n_relations={
                relation: [RelationEdge(target=e["target"], r_parameters=e.get("parametry", {}))
                           for e in edges]
                for relation, edges in entry.get("relacje", {}).items()
            },
            embeddings=entry.get("embeddings"),
        )

    problemy = _validate_loaded_graph(kg)

    # Starszy format wczytuje się, ale trzeba powiedzieć, czego w nim brakuje --
    # wersja 1 nie miała pola 'modul', a graf bez modułów wczytywał się kiedyś
    # po cichu i objawiał dopiero pustymi wynikami wyszukiwania.
    if version < GRAPH_FORMAT_VERSION:
        bez_modulu = sum(1 for n in kg.nodes.values() if not n.module)

        if bez_modulu:
            problemy.append(
                f"Format {version} (starszy niż {GRAPH_FORMAT_VERSION}): {bez_modulu} węzłów "
                f"nie ma modułu. Planer nie będzie miał czym preferować ścieżki -- "
                f"zbuduj graf od nowa zamiast wczytywać tę kopię."
            )

    if problemy:
        naglowek = f"Niespójności w '{path.name}':"

        if strict:
            raise ValueError(naglowek + "\n- " + "\n- ".join(problemy) +
                             "\n(użyj load_graph(..., strict=False), żeby wczytać mimo to)")

        print(naglowek)
        for x in problemy:
            print(f"  - {x}")

    if set_global:
        knowledge_graph = kg

    return kg

def _validate_loaded_graph(kg: KnowledgeGraph) -> list[str]:
    """
    Sprawdza spójność wczytanego grafu: czy klasy węzłów istnieją, czy etykiety są
    zarejestrowane, czy relacje są zadeklarowane i czy prowadzą do istniejących węzłów.

    Zwraca listę wszystkich problemów, a nie pierwszy napotkany: przy zepsutym pliku
    chcemy zobaczyć skalę, a nie naprawiać po jednym i wczytywać od nowa.

    Te same niezmienniki pilnują narzędzia przy budowaniu grafu -- ale wczytywanie
    z JSON-a je omija, więc bez tej funkcji plik z niespójnościami wszedłby do
    Neo4j bez słowa.
    """

    problemy: list[str] = []

    for node_name, node in kg.nodes.items():
        if node.c_name not in kg.classes:
            problemy.append(f"węzeł '{node_name}' ma nieznaną klasę '{node.c_name}'")

        for etykieta in sorted(node.n_labels):
            if etykieta not in kg.labels:
                problemy.append(f"węzeł '{node_name}' ma niezarejestrowaną etykietę '{etykieta}'")

        for relacja, edges in node.n_relations.items():
            if relacja not in kg.relations:
                problemy.append(f"węzeł '{node_name}' używa niezadeklarowanej relacji '{relacja}'")

            for edge in edges:
                if edge.target not in kg.nodes:
                    problemy.append(f"relacja '{node_name}' -[{relacja}]-> '{edge.target}' "
                                    f"prowadzi do nieistniejącego węzła")

    return problemy

def latest_graph(directory: Path | str | None = None) -> Path | None:
    """
    Najnowsza kopia zapasowa grafu, albo None gdy katalog jest pusty.

    Sortowanie po czasie modyfikacji, a nie po nazwie: nazwa zawiera datę, ale
    licznik dopisywany przy kolizji ('_2') psułby porządek leksykograficzny.

    :param directory: katalog z kopiami (domyślnie 'knowledge/graphs/')
    """

    directory = Path(directory) if directory else GRAPHS_DIR

    if not directory.exists():
        return None

    pliki = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)

    return pliki[0] if pliki else None