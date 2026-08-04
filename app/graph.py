from dataclasses import dataclass, field
from typing import Any

from app.core import GRAPH_DB_URL, GRAPH_DB_PASSWORD
from langchain.tools import tool

from neo4j import GraphDatabase, Driver

def initialize_graph_driver() -> Driver:
    return GraphDatabase.driver(GRAPH_DB_URL, auth=("neo4j", GRAPH_DB_PASSWORD))

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

knowledge_graph = KnowledgeGraph()

# Chaty czasami źle wysyłąją zrób parsowani w narzędziach by naprawić elementy

@tool
def merge(node_id: str, node_class:str, properties: dict[str, Any] | None = None) -> str:
    """
    If it doesn't exist it creates a node in knowledge graph. It consists of a unique id (node_id), class with its parameters.
    If it does exist it updates its properties and returns confirmation.

    :param node_id: A unique node id it can't appear more than once
    :param node_class: class of an entity, it can appear multiple times
    :param properties: dictionary of additional properties for the entity
    :return: confirmation or error message
    """

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

if __name__ == "__main__":
    pass
