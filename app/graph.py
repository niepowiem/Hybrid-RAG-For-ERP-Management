import json
from dataclasses import dataclass, field
from typing import Any

from neo4j.exceptions import ServiceUnavailable, AuthError

from app.core import GRAPH_DB_URL, GRAPH_DB_PASSWORD, ChatModel
from langchain.tools import tool

from neo4j import GraphDatabase, Driver

graph_driver: Driver | None = None
knowledge_graph: KnowledgeGraph | None = None

@dataclass
class GraphClass:
    id: str
    properties: dict[str, Any] = field(default_factory=dict)

class KnowledgeGraph:
    __slots__ = ('nodes', 'relations')

    def __init__(self):
        self.nodes: dict[str, GraphClass] = { }

        # Relacje zapisujemy f"{from}>{to}"
        self.relations: dict[tuple[str, str], list[str]] = { }

    def merge(self, node_id: str, node_class:str, properties: dict[str, Any] | None = None) -> str:
        if not properties:
            return "BŁĄD: Properties nie mogą być NULL lub pustym słownikiem. Dodaj przynajmniej jedną wartość do properties"

        node = self.nodes.get(node_id)
        if node is not None:
            # Nie porównujemy id noda, tylko id klasy GraphClass
            if node.id != node_class:
                return (f"BŁĄD: Node o id '{node_id}' już istnieje, ale ma klasę '{node.id}', ty podałeś '{node_class}'."
                        f"Użyj innego 'node_id' lub poprawnej klasy 'node_class'.")

            previous_properties = node.properties
            node.properties.update(properties)

            return f"OK: Zaktualizowano parametry dla tego node_id: '{node_id}'. Poprzednie parametry to: '{previous_properties}'"

        else:
            self.nodes[node_id] = GraphClass(id=node_class, properties=properties)
            return f"OK: Utworzono nowy node node_id={node_id}; node_class={node_class}; properties={{ {properties} }}"

    def relationship(self, node_from: str, node_to: str, relationship: str) -> str:
        missing_nodes = [node for node in (node_from, node_to) if node not in self.nodes]

        if missing_nodes:
            existing_nodes = ', '.join(self.nodes.keys()) or "(Brak node w grafie)"
            return (f"BŁĄD: Następujące node id nie istnieją: {', '.join(missing_nodes)}."
                    f"Dostępne id node: {existing_nodes}."
                    f"Najpierw utwórz brakujące node narzędziem 'merge'")

        node_relations = self.relations.setdefault((node_from, node_to), [])

        if relationship in node_relations:
            return f"BŁĄD: Relacja '{relationship}' między ({node_from})->({node_to}) już istnieje!"

        node_relations.append(relationship)

        return f"OK: Utworzono relację: ({node_from})-[{relationship}]->({node_to})"

    def context(self) -> str:
        if not self.nodes:
            return ("BŁĄD: Graf jest pusty! Nie ma żadnych node ani relations. "
                    "Użyj 'merge' aby utworzyć node i 'relationship', żeby dodać między nimi relację")

        nodes_description = '\n'.join(
            f" - {name} ({value.id}): {value.properties}" for name, value in self.nodes.items())

        relation_lines: list[str] = []
        for (node_from, node_to), relationship_list in self.relations.items():
            for relationship in relationship_list:
                relation_lines.append(f" - ({node_from})-[{relationship}]->({node_to})")

        relations_description = '\n'.join(relation_lines) or " (Brak relacji)"
        return f"Aktualne node:\n{nodes_description}\n\nAktualne relacje:\n{relations_description}"

    def cypher(self, mode: str = 'node') -> list[str]:
        mode = mode.lower()
        if mode not in ('node', 'relationship'):
            raise ValueError(f"Invalid mode: {mode}. Chose one of 'node' or 'relation'")

        lines: list[str] = []
        if mode == 'node':
            for name, value in self.nodes.items():
                properties = ', '.join(f"{k}: {v!r}" for k, v in value.properties.items())
                lines.append(f"MERGE ({name}:{value.id} {{ {properties} }})")
        else:
            for (n_from, n_to), relationship_list in self.relations.items():
                for relationship in relationship_list:
                    lines.append(f"MERGE ({n_from})-[:{relationship}]->({n_to})")

        return lines

    def clear(self) -> None:
        self.nodes.clear()
        self.relations.clear()

# TODO: Do @tools dodaj funkcje poprawiające zmienne, ponieważ czasami niektóre modele źle przekazują struktury

@tool
def merge(node_id: str, node_class:str, properties: dict[str, Any] | None = None) -> str:
    """
    If it doesn't exist it creates a node in knowledge graph. It consists of a unique id (node_id), class with its parameters.
    If it does exist it updates its properties and returns confirmation.

    :param node_id: A unique node id it can't appear more than once
    :param node_class: class of an entity, it can appear multiple times
    :param properties: dictionary of additional properties, e.g. {"opis": "Przyjęcie towaru", "skutek": "zwiększa stan"} IMPORTANT: pass this as a JSON object/dictionary, NOT as a string.
    :return: confirmation or error message
    """

    if isinstance(properties, str):
        try:
            properties = json.loads(properties)

        except json.JSONDecodeError as e:
            return (
                f"BŁĄD: 'properties' musi być prawidłowym obiektem JSON (słownikiem), "
                f"otrzymano nieprawidłowy string: {properties!r}. Błąd parsowania: {e}. "
                f"Popraw i wywołaj narzędzie ponownie z poprawnym properties jako obiekt."
            )

        if not isinstance(properties, dict):
            return (
                f"BŁĄD: 'properties' po sparsowaniu nie jest słownikiem (jest typu {type(properties).__name__}). "
                f"Podaj properties jako obiekt JSON, np. {{\"opis\": \"...\"}}."
            )

    return knowledge_graph.merge(node_id, node_class, properties)

@tool
def relationship(node_from: str, node_to: str, relationship: str) -> str:
    """
    Connects nodes to each other by their ids naming the relationship between them.
    Both id_from and id_to must already exist as nodes (use merge tool first).

    :param node_from: Connection from id
    :param node_to: Connection to id
    :param relationship: Relationship of id_from to id_to
    :return: confirmation or error message
    """

    return knowledge_graph.relationship(node_from, node_to, relationship)

@tool
def status() -> str:
    """
    Returns the current state of the knowledge graph — all existing nodes with their classes/properties
    and all existing relationships. Use this before creating relationships to check available node ids.
    """

    return knowledge_graph.context()

llm_tools = (merge, relationship, status)

def build_graph_with_ollama(model: str, system: str, documents: str):
    knowledge_graph.clear()

    llm = ChatModel(model=model,
                    system=system,
                    tools=llm_tools)

    llm.pretty(documents, max_tool_iterations=1024)

def initialize_graph_driver():
    global graph_driver

    graph_driver = GraphDatabase.driver(GRAPH_DB_URL, auth=("neo4j", GRAPH_DB_PASSWORD))

    # Jeżeli nie wywali bład, to znaczy, że działa
    try:
        graph_driver.verify_connectivity()

        print("OK: Połączenie z neo4j działa")

    except ServiceUnavailable as e:
        print(f"BŁĄD: Nie można połączyć się z bazą: {e}")

    except AuthError as e:
        print(f"BŁĄD: Błędne dane logowania: {e}")

    except Exception as e:
        print(f"BŁĄD: Inny nieoczekiwany błąd połączenia: {type(e).__name__}: {e}")

    # Sprawdza, czy w bazie zainstalowane jest APOC
    def is_apoc_available(driver: Driver, database: str = 'neo4j') -> bool:
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

def initialize_knowledge_graph():
    global knowledge_graph

    knowledge_graph = KnowledgeGraph()

def purge_database(driver: Driver, database: str = "neo4j", batch: int = 1024) -> None:
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