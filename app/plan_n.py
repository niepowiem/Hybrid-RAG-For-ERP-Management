"""
plan_n.py -- warstwa proceduralna grafu: kroki jako osobne węzły, stany jako
warunki i efekty, oraz budowanie planu przez trawersję.

Model danych zapisywany do grafu:

    (Procedura)-[:HAS_STEP {order}]->(Krok)
    (Procedura)-[:REQUIRES]->(Procedura)        # warunek wstępny między procedurami
    (Procedura)-[:HAS_GOAL]->(Stan)             # co znaczy "udało się"
    (Krok)-[:REQUIRES_STATE]->(Stan)            # czego krok potrzebuje
    (Krok)-[:PROVIDES_STATE]->(Stan)            # co krok wytwarza

NIEZMIENNIK CAŁEGO MODUŁU: treść kroku nigdy nie pochodzi od modelu językowego.
Węzły Krok tworzy 'attach_steps_from_documents' bezpośrednio ze zwalidowanych
obiektów Procedure, już PO tym, jak LLM zbuduje warstwę procedur i relacji.
Wynika to wprost z kontraktu AssistantStep: "tekst kroku dosłownie z korpusu
wiedzy, nie generowany przez model". Anchor przepisany z błędem to kliknięcie
w nieistniejący element.

Trzy funkcje budujące plan, w kolejności od najprostszej:

    build_plan   -- kroki JEDNEJ procedury w kolejności redakcyjnej z YAML-a,
                    rozwijając łańcuch REQUIRES między procedurami
    plan_for_goal -- regresja wsteczna od celu; ignoruje redakcję, za to potrafi
                    domknąć warunki krokami z INNEGO modułu
    full_plan    -- hybryda używana przez asystenta: treść procedury z build_plan,
                    brakujące warunki wstępne dobudowane przez plan_for_goal
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from neo4j import Driver

from app.builder_n import KnowledgeGraph
from app.schema_n import Procedure

# ======================================================================
# NAZWY SYSTEMOWE
# ======================================================================
# Klasy i relacje rejestrowane przez kod, nie przez LLM. API musi móc na tych
# nazwach polegać, a model przy każdym ingeście wymyśliłby je od nowa.

STEP_CLASS: str = "Krok"
STATE_CLASS: str = "Stan"

STEP_RELATION: str = "HAS_STEP"
REQUIRES_RELATION: str = "REQUIRES"
REQUIRES_STATE_RELATION: str = "REQUIRES_STATE"
PROVIDES_STATE_RELATION: str = "PROVIDES_STATE"
GOAL_RELATION: str = "HAS_GOAL"

# (Blad)-[:RESOLVED_BY {priority}]->(Procedura)
# Tworzona DETERMINISTYCZNIE z pola 'solutions[].ref' dokumentów Error, tak samo
# jak kroki. Wcześniej naprawa błędu szukała procedury przez DOWOLNĄ relację
# w grafie, a te buduje LLM po swojemu -- skutkiem był plan naprawczy dotyczący
# zupełnie innego obszaru niż zgłoszony błąd.
RESOLVED_BY_RELATION: str = "RESOLVED_BY"
RESOLVED_BY_PARAMETERS: dict[str, Any] = {"priority": 0}

# Parametry klasy Krok: nazwa -> wartość domyślna.
# 'action' trzymamy jako tekst JSON, bo parametry węzła w Neo4j są płaskie --
# zagnieżdżona mapa nie zapisze się jako właściwość.
STEP_CLASS_PARAMETERS: dict[str, Any] = {
    "text": "brak danych",
    "anchor": "",
    "action": "",
    "note": "",
    "why": "",
    # "tak"/"nie" zamiast bool, bo parametry węzła są typowane po wartości
    # domyślnej klasy, a mieszanie typów w jednym parametrze bywa odrzucane.
    "optional": "nie",
}

STEP_RELATION_PARAMETERS: dict[str, Any] = {"order": 0}

STATE_CLASS_PARAMETERS: dict[str, Any] = {"name": "brak danych"}


def register_system_schema(kg: KnowledgeGraph) -> list[str]:
    """
    Rejestruje klasy Krok i Stan oraz cztery relacje systemowe.

    Wywoływać PO 'build_graph_with_llm', a przed 'attach_steps_from_documents':
    builder woła 'knowledge_graph.clear()' na starcie, więc schemat zarejestrowany
    wcześniej zostałby zmieciony.

    :param kg: graf do uzupełnienia
    :return: komunikaty zwrócone przez metody grafu (do wypisania albo logu)
    """

    return [
        kg.define_class(STEP_CLASS, dict(STEP_CLASS_PARAMETERS), ["text"]),
        kg.define_class(STATE_CLASS, dict(STATE_CLASS_PARAMETERS), []),
        kg.define_relation(STEP_RELATION, dict(STEP_RELATION_PARAMETERS)),
        kg.define_relation(REQUIRES_RELATION, {}),
        kg.define_relation(REQUIRES_STATE_RELATION, {}),
        kg.define_relation(PROVIDES_STATE_RELATION, {}),
        kg.define_relation(GOAL_RELATION, {}),
        kg.define_relation(RESOLVED_BY_RELATION, dict(RESOLVED_BY_PARAMETERS)),
    ]


# ======================================================================
# NAZWY WĘZŁÓW
# ======================================================================

def node_id_from_document_id(document_id: str) -> str:
    """
    Konwencja wiążąca dokument z korpusu z węzłem w grafie:
        'proc.magazyn.przyjecie' -> 'proc_magazyn_przyjecie'
        'ERR-1004'               -> 'ERR_1004'

    Ta sama konwencja jest opisana w prompcie systemowym, więc LLM tworzy węzły
    procedur pod dokładnie takimi nazwami. Rozjazd wychodzi jako niepuste pole
    'missing' w raporcie 'attach_steps_from_documents'.
    """

    return document_id.replace(".", "_").replace("-", "_")


def state_node_id(state: str) -> str:
    """'dokument.typ-pz' -> 'stan_dokument_typ_pz'"""

    return "stan_" + state.strip().replace(".", "_").replace("-", "_")


def step_parameters(step: Any) -> dict[str, Any]:
    """
    Parametry WĘZŁA Krok -- dokładnie te i tylko te, które deklaruje
    STEP_CLASS_PARAMETERS.

    Stany tu NIE wchodzą: w grafie żyją jako relacje REQUIRES_STATE
    i PROVIDES_STATE, a nie jako właściwości węzła. Dopisanie ich tutaj kończy
    się błędem "Podano zbyt dużo parametrów dla klasy 'Krok'".
    """

    if step.action is None:
        action = ""
    else:
        # by_alias=True, bo kontrakt frontu używa camelCase ('inputType'),
        # a model pydantic pola snake_case. exclude_none pomija nieustawione
        # 'anchor' i 'hint', żeby hash nie zależał od domyślnych wartości.
        action = json.dumps(step.action.model_dump(by_alias=True, exclude_none=True),
                            ensure_ascii=False, sort_keys=True)

    return {
        "text": step.text,
        "anchor": step.anchor or "",
        "action": action,
        "note": step.note or "",
        "why": step.why or "",
        "optional": "tak" if step.optional else "nie",
    }


def step_identity(step: Any) -> dict[str, Any]:
    """
    Pełna tożsamość kroku: parametry węzła PLUS stany. Wyłącznie do liczenia hasha.

    Stany muszą wejść do tożsamości -- krok o tym samym tekście, ale innych
    warunkach wstępnych, to inna instrukcja i musi być osobnym węzłem.
    """

    return {
        **step_parameters(step),
        "requires": ",".join(sorted(step.requires)),
        "provides": ",".join(sorted(step.provides)),
    }


def step_node_id(step: Any) -> str:
    """
    Nazwa węzła kroku pochodzi z jego TREŚCI, nie z procedury-właściciela.

    Dzięki temu identyczny krok w kilku procedurach to jeden węzeł z kilkoma
    krawędziami HAS_STEP: poprawka tekstu propaguje się wszędzie, a plan łączący
    procedury nie powtarza tych samych instrukcji.

    UWAGA przy edycji korpusu: hash obejmuje CAŁY krok. Poprawienie literówki
    w jednej procedurze rozdzieli krok, który wcześniej był współdzielony --
    przy kopiowaniu kroku między procedurami kopiuj go dosłownie w całości.
    """

    payload = json.dumps(step_identity(step), ensure_ascii=False, sort_keys=True)

    return f"krok_{hashlib.sha1(payload.encode('utf-8')).hexdigest()[:12]}"


def _succeeded(result: str) -> bool:
    """
    'OK:' i 'INFO:' to sukces. INFO oznacza operację nieblokującą -- krawędź,
    która już istniała, albo parametr uzupełniony wartością domyślną.
    Awarią jest wyłącznie 'BŁĄD:'.
    """

    return result.startswith(("OK", "INFO"))


# ======================================================================
# BUDOWA WARSTWY PROCEDURALNEJ
# ======================================================================

def attach_steps_from_documents(kg: KnowledgeGraph, documents: list[Any],
                                verbose: bool = True) -> dict[str, Any]:
    """
    Tworzy węzły Krok i Stan oraz łączące je relacje, bezpośrednio z obiektów
    Procedure. Treść przepisywana jest 1:1 z YAML-a -- model nie ma tu głosu.

    Uruchamiać PO 'build_graph_with_llm' i 'register_system_schema',
    a PRZED 'sync()'.

    :param kg: graf zbudowany przez LLM, z zarejestrowanym schematem systemowym
    :param documents: lista dokumentów z 'load_knowledge()' (nie tylko procedur)
    :param verbose: czy wypisywać procedury pominięte z powodu braku węzła
    :return: raport {'steps', 'reused', 'edges', 'states', 'procedures', 'missing'}
    :raises RuntimeError: gdy zapis węzła albo relacji zwróci 'BŁĄD:'
    """

    created_steps: int = 0      # nowe węzły Krok
    reused_steps: int = 0       # kroki współdzielone z inną procedurą
    total_edges: int = 0        # krawędzie HAS_STEP (= liczba kroków w YAML-u)
    created_states: int = 0     # nowe węzły Stan
    linked_procedures: int = 0
    missing: list[str] = []

    for document in documents:
        if not isinstance(document, Procedure):
            continue

        procedure_node = node_id_from_document_id(document.id)

        # Węzeł procedury tworzy LLM. Jeśli nazwał go inaczej niż każe konwencja,
        # nie zgadujemy: raportujemy i zostawiamy procedurę bez kroków.
        if procedure_node not in kg.nodes:
            missing.append(document.id)
            continue

        for index, step in enumerate(document.steps, 1):
            node_name = step_node_id(step)

            if node_name in kg.nodes:
                # Krok współdzielony -- węzeł już istnieje, dokładamy tylko
                # krawędź HAS_STEP z własną kolejnością.
                reused_steps += 1

            else:
                merge_result = kg.merge(node_name, STEP_CLASS, document.module,
                                        step_parameters(step))

                # Wyniki SPRAWDZAMY: 'merge' zwraca tekst błędu, a nie rzuca
                # wyjątkiem. Bez tej kontroli nieudany zapis przechodzi bez śladu
                # i wychodzi dopiero jako pusty plan u użytkownika.
                if not _succeeded(merge_result):
                    raise RuntimeError(f"Nie udało się utworzyć węzła kroku '{node_name}' "
                                       f"({step.text[:40]}...):\n{merge_result}")

                created_steps += 1

            edge_result = kg.relationship(procedure_node, [node_name], STEP_RELATION,
                                          {"order": index})

            if not _succeeded(edge_result):
                raise RuntimeError(f"Nie udało się połączyć '{procedure_node}' -> "
                                   f"'{node_name}':\n{edge_result}")

            total_edges += 1

            for states, relation in ((step.requires, REQUIRES_STATE_RELATION),
                                     (step.provides, PROVIDES_STATE_RELATION)):
                created_states += _link_states(kg, node_name, states, relation, document.module)

        # Cel procedury: stany, których osiągnięcie oznacza sukces.
        created_states += _link_states(kg, procedure_node, document.goal,
                                       GOAL_RELATION, document.module)

        linked_procedures += 1

    if verbose and missing:
        print(f"\nUWAGA: {len(missing)} procedur nie ma węzła o oczekiwanej nazwie "
              f"-- ich kroki NIE zostały dodane:")

        for document_id in missing:
            print(f"  {document_id} -> oczekiwano węzła '{node_id_from_document_id(document_id)}'")

    return {
        "steps": created_steps,
        "reused": reused_steps,
        "edges": total_edges,
        "states": created_states,
        "procedures": linked_procedures,
        "missing": missing,
    }


def _link_states(kg: KnowledgeGraph, source_node: str, states: list[str],
                 relation: str, module: str) -> int:
    """
    Tworzy brakujące węzły Stan i łączy je z węzłem źródłowym.

    :return: liczba NOWO utworzonych węzłów Stan
    """

    created = 0

    for name in states:
        state_node = state_node_id(name)

        if state_node not in kg.nodes:
            result = kg.merge(state_node, STATE_CLASS, module, {"name": name})

            if not _succeeded(result):
                raise RuntimeError(f"Nie udało się utworzyć stanu '{name}':\n{result}")

            created += 1

        kg.relationship(source_node, [state_node], relation, None)

    return created


# ======================================================================
# ODCZYT Z GRAFU
# ======================================================================

def attach_error_links(kg: KnowledgeGraph, documents: list[Any],
                       verbose: bool = True) -> dict[str, Any]:
    """
    Łączy węzły błędów z procedurami, które je rozwiązują -- na podstawie pola
    'solutions[].ref' z korpusu, a nie relacji wymyślonych przez model.

    Kolejność ma znaczenie: pierwsze rozwiązanie w YAML-u dostaje priority=1
    i to ono zostanie zaproponowane najpierw. Autopilot bierze pierwszą
    procedurę, która ma kroki wykonalne w bieżącym kontekście.

    Uruchamiać razem z 'attach_steps_from_documents', PO 'build_graph_with_llm'.

    :return: raport {'links', 'errors', 'missing_errors', 'missing_procedures'}
    """

    links = 0
    linked_errors = 0
    missing_errors: list[str] = []
    missing_procedures: list[str] = []

    for document in documents:
        # Rozpoznajemy po strukturze, nie po imporcie klasy Error: dzięki temu
        # funkcja działa też dla dokumentów wczytanych innym schematem.
        solutions = getattr(document, "solutions", None)

        if solutions is None:
            continue

        error_node = node_id_from_document_id(document.id)

        if error_node not in kg.nodes:
            missing_errors.append(document.id)
            continue

        priority = 0

        for solution in solutions:
            for ref in (solution.ref or []):
                procedure_node = node_id_from_document_id(ref)

                if procedure_node not in kg.nodes:
                    missing_procedures.append(f"{document.id} -> {ref}")
                    continue

                priority += 1

                result = kg.relationship(error_node, [procedure_node],
                                         RESOLVED_BY_RELATION, {"priority": priority})

                if not _succeeded(result):
                    raise RuntimeError(f"Nie udało się połączyć '{error_node}' -> "
                                       f"'{procedure_node}':\n{result}")

                links += 1

        if priority:
            linked_errors += 1

    if verbose:
        if missing_errors:
            print(f"\nUWAGA: {len(missing_errors)} błędów nie ma węzła o oczekiwanej nazwie: "
                  f"{missing_errors}")

        if missing_procedures:
            print(f"\nUWAGA: {len(missing_procedures)} odwołań wskazuje na nieistniejącą "
                  f"procedurę:")
            for x in missing_procedures:
                print(f"  {x}")

    return {"links": links, "errors": linked_errors,
            "missing_errors": missing_errors, "missing_procedures": missing_procedures}


def build_plan(driver: Driver, node_id: str, max_depth: int = 3,
               database: str = "neo4j") -> list[dict[str, Any]]:
    """
    Kroki procedury w kolejności REDAKCYJNEJ, rozwijając warunki wstępne
    (REQUIRES) w głąb.

    Kolejność: procedury najgłębiej w łańcuchu wymagań idą pierwsze, sama
    procedura docelowa ostatnia; wewnątrz procedury kroki wg 'order'.
    To warstwowanie topologiczne -- procedura, do której prowadzi najdłuższa
    ścieżka REQUIRES, jest najgłębszym warunkiem wstępnym.

    :param driver: sterownik neo4j
    :param node_id: node_id procedury startowej
    :param max_depth: ile poziomów REQUIRES rozwijać (ucina po cichu powyżej)
    :param database: nazwa bazy
    :return: lista wierszy {'procedure', 'step_id', 'text', 'anchor', 'action',
        'note', 'why', 'optional'}
    """

    depth = max(0, int(max_depth))

    query = f"""
        MATCH path = (start:{KnowledgeGraph.SHARED_LABEL} {{node_id: $node_id}})
                     -[:{REQUIRES_RELATION}*0..{depth}]->(proc)
        WITH proc, max(length(path)) AS depth
        ORDER BY depth DESC, proc.node_id
        WITH collect(proc) AS procedures
        UNWIND range(0, size(procedures) - 1) AS idx
        WITH procedures[idx] AS proc, idx AS procedure_order
        MATCH (proc)-[r:{STEP_RELATION}]->(step)
        WITH proc, procedure_order, step, coalesce(r.order, 0) AS step_order
        ORDER BY procedure_order, step_order
        RETURN proc.node_id  AS procedure,
               step.node_id  AS step_id,
               step.text     AS text,
               step.anchor   AS anchor,
               step.action   AS action,
               step.note     AS note,
               step.why      AS why,
               step.optional AS optional
    """

    records, _, _ = driver.execute_query(query, node_id=node_id, database_=database)

    # Deduplikacja: ten sam węzeł kroku może należeć do kilku procedur w planie
    # (np. "Kliknij Nowy dokument" w procedurze wymaganej i docelowej).
    # Zostawiamy pierwsze wystąpienie, czyli najwcześniejsze w kolejności.
    plan: list[dict[str, Any]] = []
    seen: set[str] = set()

    for record in records:
        row = dict(record)

        if row["step_id"] in seen:
            continue

        seen.add(row["step_id"])
        plan.append(row)

    return plan


def goal_states(driver: Driver, node_id: str, database: str = "neo4j") -> list[str]:
    """Stany, które procedura ma osiągnąć (relacja HAS_GOAL)."""

    records, _, _ = driver.execute_query(
        f"MATCH (p {{node_id: $node_id}})-[:{GOAL_RELATION}]->(s) RETURN s.name AS name",
        node_id=node_id, database_=database,
    )

    return [r["name"] for r in records]


def resolving_procedures(driver: Driver, node_id: str, database: str = "neo4j") -> list[str]:
    """
    Procedury ROZWIĄZUJĄCE dany błąd, w kolejności z korpusu (pole 'priority'
    relacji RESOLVED_BY).

    Tylko ta jedna relacja, bo tylko ona jest tworzona deterministycznie
    z 'solutions[].ref'. Szukanie przez dowolną relację dawało procedury
    z zupełnie innego obszaru -- LLM łączy węzły swobodnie i nie ma powodu
    zakładać, że sąsiedztwo w grafie znaczy "to naprawia tamto".
    """

    query = f"""
        MATCH (n {{node_id: $node_id}})-[r:{RESOLVED_BY_RELATION}]->(p)
        WHERE (p)-[:{STEP_RELATION}]->()
        RETURN p.node_id AS node_id, coalesce(r.priority, 99) AS priority
        ORDER BY priority
    """

    records, _, _ = driver.execute_query(query, node_id=node_id, database_=database)

    return [r["node_id"] for r in records]


def related_procedures(driver: Driver, node_id: str, database: str = "neo4j") -> list[str]:
    """
    Procedury powiązane z węzłem DOWOLNĄ relacją -- luźne sąsiedztwo w grafie.

    Używane wyłącznie jako uzupełnienie przy pojęciach, gdzie nie ma pola
    odpowiadającego 'solutions[].ref'. Do naprawy błędów służy
    'resolving_procedures', bo tylko ono opiera się na deklaracji z korpusu.

    Procedurę rozpoznajemy PO STRUKTURZE (ma krawędzie HAS_STEP), a nie po nazwie
    klasy: nazwy klas wymyśla LLM przy ingeście i mogą się różnić między przebiegami.
    """

    query = f"""
        MATCH (n {{node_id: $node_id}})-[r]-(p)
        WHERE (p)-[:{STEP_RELATION}]->()
        RETURN DISTINCT p.node_id AS node_id, type(r) AS relation
        LIMIT 5
    """

    records, _, _ = driver.execute_query(query, node_id=node_id, database_=database)

    return [r["node_id"] for r in records]


def load_step_index(driver: Driver, database: str = "neo4j") -> dict[str, dict[str, Any]]:
    """
    Wczytuje WSZYSTKIE kroki wraz ze stanami do pamięci -- jednym zapytaniem.

    Planowanie robi setki sprawdzeń "kto wytwarza stan X"; odpytywanie bazy za
    każdym razem byłoby wolniejsze o rzędy wielkości niż wczytanie kilkuset
    węzłów naraz. Indeks zmienia się tylko przy ingeście, więc warto go buforować
    po stronie wołającego (robi to 'assistant_n.get_index').

    :return: {step_id: {'node_id','text','anchor','action','note','why','module',
        'optional', 'requires': set, 'provides': set}}
    """

    query = f"""
        MATCH (k {{klasa: '{STEP_CLASS}'}})
        OPTIONAL MATCH (k)-[:{REQUIRES_STATE_RELATION}]->(req)
        OPTIONAL MATCH (k)-[:{PROVIDES_STATE_RELATION}]->(prov)
        RETURN k.node_id  AS node_id,
               k.text     AS text,
               k.anchor   AS anchor,
               k.action   AS action,
               k.note     AS note,
               k.why      AS why,
               k.modul    AS module,
               k.optional AS optional,
               collect(DISTINCT req.name)  AS requires,
               collect(DISTINCT prov.name) AS provides
    """

    records, _, _ = driver.execute_query(query, database_=database)

    index: dict[str, dict[str, Any]] = {}

    for r in records:
        index[r["node_id"]] = {
            "node_id": r["node_id"],
            "text": r["text"],
            "anchor": r["anchor"],
            "action": r["action"],
            "note": r["note"],
            "why": r["why"],
            "module": r["module"],
            "optional": r["optional"] == "tak",
            # collect() wstawia None dla węzłów bez dopasowania w OPTIONAL MATCH
            "requires": set(filter(None, r["requires"])),
            "provides": set(filter(None, r["provides"])),
        }

    return index


def step_owner(driver: Driver, step_id: str, database: str = "neo4j") -> dict[str, Any] | None:
    """
    Procedura, do której należy krok, wraz z jego numerem w niej.

    Potrzebne, żeby odpowiedzieć na pytanie o konkretny krok: bez kontekstu
    procedury wyjaśnienie brzmiałoby jak oderwane zdanie z instrukcji.

    :return: {'procedure', 'order', 'title'} albo None, gdy krok nie należy
        do żadnej procedury (nie powinno się zdarzyć po poprawnym ingeście)
    """

    query = f"""
        MATCH (p)-[r:{STEP_RELATION}]->(k {{node_id: $step_id}})
        RETURN p.node_id AS procedure, coalesce(r.order, 0) AS order, properties(p) AS props
        ORDER BY order
        LIMIT 1
    """

    records, _, _ = driver.execute_query(query, step_id=step_id, database_=database)

    if not records:
        return None

    r = records[0]
    props = dict(r["props"])
    props.pop("embeddings", None)

    # Tytuł procedury to pierwsza tekstowa właściwość spoza systemowych --
    # nazwy parametrów nadaje LLM przy ingeście, więc nie zgadujemy klucza.
    title = next((v for k, v in props.items()
                  if isinstance(v, str) and v.strip()
                  and k not in ("node_id", "klasa", "modul")), r["procedure"])

    return {"procedure": r["procedure"], "order": r["order"], "title": title}


def step_states(driver: Driver, step_ids: list[str],
                database: str = "neo4j") -> dict[str, tuple[set[str], set[str]]]:
    """
    Dla listy kroków zwraca mapę: step_id -> (wymagane stany, wytwarzane stany).
    Jedno zapytanie zamiast N -- plany potrafią mieć kilkadziesiąt kroków.
    """

    query = f"""
        UNWIND $step_ids AS sid
        MATCH (k {{node_id: sid}})
        OPTIONAL MATCH (k)-[:{REQUIRES_STATE_RELATION}]->(req)
        OPTIONAL MATCH (k)-[:{PROVIDES_STATE_RELATION}]->(prov)
        RETURN sid AS step_id,
               collect(DISTINCT req.name)  AS requires,
               collect(DISTINCT prov.name) AS provides
    """

    records, _, _ = driver.execute_query(query, step_ids=step_ids, database_=database)

    return {r["step_id"]: (set(filter(None, r["requires"])), set(filter(None, r["provides"])))
            for r in records}


# ======================================================================
# PLANOWANIE OD CELU
# ======================================================================

class NoStepError(RuntimeError):
    """Żaden krok w bazie wiedzy nie wytwarza wymaganego stanu."""


def estimate_state_costs(index: dict[str, dict[str, Any]],
                         initial_state: set[str] | None = None) -> dict[str, int]:
    """
    Dla każdego stanu szacuje minimalną liczbę kroków potrzebnych do jego
    osiągnięcia (zrelaksowany graf planowania: koszt kroku = 1 + koszt
    najdroższego warunku).

    Bez tego planer traktuje wszystkie warunki jako równie tanie i przy remisie
    wybiera losowo -- np. domykając zwykłe PZ ścieżką "zapisz szkic, potem
    zatwierdź jako kierownik", która jest poprawna, ale należy do innej procedury.
    """

    cost: dict[str, int] = {s: 0 for s in (initial_state or set())}

    changed = True
    while changed:
        changed = False

        for step in index.values():
            if any(w not in cost for w in step["requires"]):
                continue

            candidate = 1 + max((cost[w] for w in step["requires"]), default=0)

            for name in step["provides"]:
                if name not in cost or candidate < cost[name]:
                    cost[name] = candidate
                    changed = True

    return cost


def plan_for_goal(goals: list[str], index: dict[str, dict[str, Any]],
                  initial_state: set[str] | None = None,
                  preferred_module: str | None = None,
                  limit: int = 60) -> list[dict[str, Any]]:
    """
    Buduje plan wsteczną regresją: dla każdego celu szuka kroku, który go
    wytwarza, a potem rekurencyjnie zaspokaja warunki tego kroku.

    W odróżnieniu od 'build_plan' nie jest przywiązany do jednej procedury --
    jeśli warunek da się spełnić krokiem z innego modułu, plan go użyje. To jest
    ta elastyczność, po którą wprowadzaliśmy stany, i to ona obsługuje zadania
    złożone ("utwórz zamówienie i wystaw fakturę" = dwa cele w jednym wywołaniu).

    :param goals: stany do osiągnięcia. KONIUNKCJA -- wszystkie muszą być
        spełnione, a stan zdobyty przy pierwszym celu przenosi się na kolejne
    :param index: wynik 'load_step_index'
    :param initial_state: co użytkownik ma już spełnione (z kontekstu UI)
    :param preferred_module: przy remisie kosztów wybieramy krok z tego modułu
    :param limit: bezpiecznik na długość planu
    :raises NoStepError: gdy w bazie wiedzy nie ma kroku wytwarzającego dany stan
    """

    state: set[str] = set(initial_state or set())
    plan: list[dict[str, Any]] = []
    used: set[str] = set()

    # Odwrócony indeks: stan -> kroki, które go wytwarzają.
    # Kroki warunkowe ('optional') pomijamy jako producentów: plan nie ma prawa
    # opierać się na czymś, co użytkownik może pominąć.
    producers: dict[str, list[dict[str, Any]]] = {}

    for step in index.values():
        if step.get("optional"):
            continue

        for name in step["provides"]:
            producers.setdefault(name, []).append(step)

    estimate = estimate_state_costs(index, state)

    def cost(step: dict[str, Any]) -> tuple[int, int, int, str]:
        # Szacowana liczba kroków do domknięcia warunków; potem ich liczba,
        # preferowany moduł, a na końcu node_id -- dla determinizmu wyniku.
        unmet = step["requires"] - state

        return (sum(estimate.get(w, 99) for w in unmet),
                len(unmet),
                0 if step["module"] == preferred_module else 1,
                step["node_id"])

    def achieve(goal: str, path: frozenset[str]) -> None:
        if goal in state:
            return

        if goal in path:
            raise NoStepError(f"Cykl w warunkach: stan '{goal}' wymaga sam siebie")

        if len(plan) >= limit:
            raise NoStepError(f"Przekroczono limit {limit} kroków przy celu '{goal}'")

        candidates = sorted(producers.get(goal, []), key=cost)

        if not candidates:
            raise NoStepError(f"Żaden krok nie wytwarza stanu '{goal}' -- luka w bazie wiedzy")

        last_error: Exception | None = None

        for step in candidates:
            if step["node_id"] in used:
                continue

            # Zrzut stanu przed próbą -- kandydat może nie domknąć swoich
            # warunków i wtedy trzeba cofnąć wszystko, co po drodze dodał.
            saved_plan = list(plan)
            saved_state = set(state)
            saved_used = set(used)

            try:
                for condition in sorted(step["requires"]):
                    achieve(condition, path | {goal})

                plan.append(step)
                used.add(step["node_id"])
                state.update(step["provides"])

                return

            except NoStepError as e:
                last_error = e
                plan[:] = saved_plan
                state.clear(); state.update(saved_state)
                used.clear(); used.update(saved_used)

        raise last_error or NoStepError(f"Nie da się osiągnąć stanu '{goal}'")

    for goal in goals:
        achieve(goal, frozenset())

    return plan


def _row_from_index(step: dict[str, Any], procedure: str) -> dict[str, Any]:
    """Sprowadza wpis z 'load_step_index' do kształtu wiersza z 'build_plan'."""

    return {
        "procedure": procedure,
        "step_id": step["node_id"],
        "text": step["text"],
        "anchor": step["anchor"],
        "action": step["action"],
        "note": step["note"],
        "why": step["why"],
        "optional": "tak" if step.get("optional") else "nie",
    }


def trim_satisfied(plan: list[dict[str, Any]], index: dict[str, dict[str, Any]],
                   initial_state: set[str]) -> list[dict[str, Any]]:
    """
    Usuwa z gotowego planu kroki, których efekt użytkownik już osiągnął.

    Krok zostaje, jeśli wnosi choć jeden nowy stan albo nie deklaruje żadnego --
    kroku bez 'provides' nie umiemy ocenić, więc go nie ruszamy.
    """

    state = set(initial_state)
    result: list[dict[str, Any]] = []

    for row in plan:
        described = index.get(row.get("step_id") or row.get("node_id"), {})
        provides = described.get("provides", set())

        if provides and provides <= state:
            continue

        result.append(row)
        state |= provides

    return result


def full_plan(driver: Driver, node_id: str, initial_state: set[str] | None = None,
              preferred_module: str | None = None,
              index: dict[str, dict[str, Any]] | None = None,
              database: str = "neo4j") -> list[dict[str, Any]]:
    """
    Plan hybrydowy -- to jest funkcja, której powinien używać asystent przy
    pojedynczej procedurze.

    Łączy trzy rzeczy, z których każda sama w sobie ma wadę:

    1. 'build_plan' daje kroki w kolejności REDAKCYJNEJ, dokładnie takiej jak
       w YAML-u. Nie umie jednak dociągnąć warunków spełnianych w innej procedurze.
    2. 'plan_for_goal' te warunki dociąga, także z innych modułów, ale pomija
       kroki nieistotne dla celu i porządkuje je po swojemu -- gubi redakcję.
    3. 'trim_satisfied' skraca początek o to, co użytkownik już zrobił.

    Tutaj: warunki wstępne buduje planer (bo tylko on widzi cały graf), a treść
    właściwej procedury zostaje w kolejności z korpusu.
    """

    index = load_step_index(driver, database=database) if index is None else index
    state = set(initial_state or set())

    rows = build_plan(driver, node_id, database=database)

    # Czego brakuje, żeby ta procedura w ogóle mogła się zacząć.
    unmet: set[str] = set()
    simulated = set(state)

    for row in rows:
        described = index.get(row["step_id"], {})

        # Krok warunkowy nie generuje wymagań dla całej procedury: jego
        # 'requires' opisuje, KIEDY krok ma sens, a nie co trzeba zrobić wcześniej.
        if not described.get("optional"):
            unmet |= described.get("requires", set()) - simulated

        simulated |= described.get("provides", set())

    prefix: list[dict[str, Any]] = []

    if unmet:
        try:
            prefix = [_row_from_index(step, "(warunek wstępny)") for step
                      in plan_for_goal(sorted(unmet), index, initial_state=state,
                                       preferred_module=preferred_module)]
        except NoStepError:
            # Luka w bazie wiedzy -- lepiej pokazać samą procedurę niż nic.
            prefix = []

    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in prefix + rows:
        if row["step_id"] in seen:
            continue

        seen.add(row["step_id"])
        merged.append(row)

    return trim_satisfied(merged, index, state)


# ======================================================================
# WALIDACJA
# ======================================================================

def parse_action(raw: str | None, step_anchor: str | None = None) -> dict[str, Any] | None:
    """
    Zamienia zapisany tekst JSON na obiekt AssistantAction -- ale tylko wtedy,
    gdy pasuje do jednego z pięciu wariantów z kontraktu. Cokolwiek innego jest
    odrzucane, żeby front nigdy nie dostał akcji, której nie umie wykonać.

    :param raw: zserializowana akcja z parametru 'action' węzła Krok
    :param step_anchor: anchor kroku. Kontrakt wymaga 'anchor' wewnątrz akcji,
        ale w YAML-u nie ma sensu go dublować -- jeśli akcja go nie podaje,
        dziedziczy go z kroku.
    """

    if not raw:
        return None

    try:
        action = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None

    if not isinstance(action, dict):
        return None

    kind = action.get("kind")

    # Dziedziczenie anchora z kroku; akcja podana jawnie ma pierwszeństwo.
    if not action.get("anchor") and step_anchor:
        action["anchor"] = step_anchor

    required: dict[str, tuple[str, ...]] = {
        "navigate": ("route",),
        "click": ("anchor",),
        "fill": ("anchor", "value"),
        "select": ("anchor", "label"),
        "ask": ("anchor", "inputType", "label"),
        "manual": ("anchor", "label"),
    }

    if kind not in required:
        return None

    if any(not isinstance(action.get(key), str) or not action.get(key) for key in required[kind]):
        return None

    result = {"kind": kind, **{key: action[key] for key in required[kind]}}

    # 'hint' jest opcjonalny, ale niesie wyjaśnienie pola dla użytkownika --
    # bez niego przerwanie na input traci połowę wartości.
    if kind in ("ask", "manual") and isinstance(action.get("hint"), str) and action["hint"]:
        result["hint"] = action["hint"]

    # Propozycje wartości: tylko niepuste teksty. Pustej listy nie wysyłamy,
    # żeby front rozróżniał "brak propozycji" od "propozycje są, ale puste".
    if kind == "ask" and isinstance(action.get("suggestions"), list):
        podpowiedzi = [x for x in action["suggestions"] if isinstance(x, str) and x.strip()]

        if podpowiedzi:
            result["suggestions"] = podpowiedzi

    return result


def validate_plan(driver: Driver, step_ids: list[str],
                  initial_state: set[str] | None = None,
                  database: str = "neo4j") -> list[str]:
    """
    Symuluje wykonanie planu, utrzymując zbiór spełnionych stanów.

    Zwraca listę problemów -- pustą, jeśli plan jest wykonalny. To jest odpowiedź
    na pytanie "czy ta kolejność kroków jest poprawna": krok żądający stanu,
    którego nikt wcześniej nie wytworzył, to błąd niezależnie od tego, jak
    sensownie brzmi jego tekst.
    """

    described = step_states(driver, step_ids, database=database)
    state = set(initial_state or set())
    problems: list[str] = []

    for i, step_id in enumerate(step_ids, 1):
        requires, provides = described.get(step_id, (set(), set()))

        if unmet := requires - state:
            problems.append(f"Krok {i} ({step_id}) wymaga niespełnionych stanów: {sorted(unmet)}")

        state |= provides

    return problems


def validate_corpus(driver: Driver, database: str = "neo4j") -> dict[str, list[Any]]:
    """
    Sprawdza spójność całej bazy wiedzy w grafie. Każda pozycja w wyniku to
    problem do naprawienia w YAML-u, nie w kodzie.

    UWAGA: 'unused_states' wskaże stany końcowe (np. 'inw.zamknieta'), których
    z definicji nikt nie wymaga. To nie jest błąd, tylko koniec łańcucha.
    """

    queries: dict[str, str] = {
        "states_without_producer": f"""
            MATCH (k)-[:{REQUIRES_STATE_RELATION}]->(s)
            WHERE NOT ()-[:{PROVIDES_STATE_RELATION}]->(s)
            RETURN DISTINCT s.name AS problem""",

        "unused_states": f"""
            MATCH (s {{klasa: '{STATE_CLASS}'}})
            WHERE NOT ()-[:{REQUIRES_STATE_RELATION}]->(s)
            RETURN s.name AS problem""",

        "steps_without_states": f"""
            MATCH (k {{klasa: '{STEP_CLASS}'}})
            WHERE NOT (k)-[:{PROVIDES_STATE_RELATION}]->()
            RETURN k.text AS problem""",

        "action_without_anchor": f"""
            MATCH (k {{klasa: '{STEP_CLASS}'}})
            WHERE k.action <> '' AND k.anchor = ''
            RETURN k.text AS problem""",

        "duplicate_order": f"""
            MATCH (p)-[r:{STEP_RELATION}]->()
            WITH p, r.order AS ord, count(*) AS cnt WHERE cnt > 1
            RETURN p.node_id + ' order=' + toString(ord) AS problem""",

        "requires_cycle": f"""
            MATCH (a)-[:{REQUIRES_RELATION}*1..10]->(a)
            RETURN DISTINCT a.node_id AS problem""",

        # Błąd bez procedury naprawczej: autopilot nie ma go czym naprawić
        # i zatrzyma się na nim. Rozpoznajemy błąd po wzorcu node_id (ERR_xxxx),
        # bo nazwę klasy nadaje LLM.
        "errors_without_resolution": f"""
            MATCH (e) WHERE e.node_id STARTS WITH 'ERR'
              AND NOT (e)-[:{RESOLVED_BY_RELATION}]->()
            RETURN e.node_id AS problem""",

        "procedures_without_goal": f"""
            MATCH (p)-[:{STEP_RELATION}]->()
            WHERE NOT (p)-[:{GOAL_RELATION}]->()
            RETURN DISTINCT p.node_id AS problem""",
    }

    result: dict[str, list[Any]] = {}

    for name, query in queries.items():
        records, _, _ = driver.execute_query(query, database_=database)

        if records:
            result[name] = [r["problem"] for r in records]

    return result