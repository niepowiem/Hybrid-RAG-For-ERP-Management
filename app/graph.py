from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import json
from langchain_core.tools import tool
from neo4j import Driver, GraphDatabase
from neo4j.exceptions import ServiceUnavailable, AuthError
from pydantic import BaseModel, Field, ValidationError
import re
from tqdm import tqdm

from app.core import ChatModel, EmbedModel, GRAPH_DB_URL, GRAPH_DB_PASSWORD, EMBED_MODEL, EMBED_MODEL_DIM, PROJECT_ROOT


class GraphClassSchema(BaseModel):
    parameters: dict[str, Any] = Field(min_length=1)
    parameters_to_embed: list[str] = []

    def describe(self) -> str:
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

class RelationSchema(BaseModel):
    parameters: dict[str, Any] = Field(default_factory=dict)

    def describe(self) -> str:
        if not self.parameters:
            return "(brak właściwości)"
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

@dataclass
class RelationEdge:
    target: str
    r_parameters: dict[str, Any] = field(default_factory=dict)

@dataclass
class GraphNode:
    c_name: str
    c_parameters: dict[str, Any] = field(default_factory=dict)
    n_relations: dict[str, list[RelationEdge]] = field(default_factory=dict)
    n_labels: set[str] = field(default_factory=set)
    embeddings: list[float] | None = None
    module: str = ""

class KnowledgeGraph:
    __slots__ = ("nodes", "relations", "classes", "labels")
    IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
    VALID_TYPES = (str, int, float, bool)
    VALID_NAMES = ('str', 'int', 'float', 'bool',
                   'list[str]', 'list[int]', 'list[float]', 'list[bool]')

    MODULE_NAMES = ('module', 'modul')
    RESERVED_PARAMETER_NAMES = ('node_id', 'klasa', 'embeddings', *MODULE_NAMES)
    CLASS_LABEL_PREFIX = "C_"
    SHARED_LABEL = "SHARED"

    def __init__(self):
        self.nodes: dict[str, GraphNode] = {}
        self.classes: dict[str, GraphClassSchema] = {}
        self.relations: dict[str, RelationSchema] = {}
        self.labels: set[str] = set()

    # ------------------------------------------------------------------
    # KLASY
    # ------------------------------------------------------------------

    def define_class(self, class_name: str, parameters: dict[str, Any], parameters_to_embed: list[str] | None = None) -> str:
        if class_name in self.classes:
            return (f"BŁĄD: Klasa '{class_name}' już istnieje: {self.read_class(class_name)}."
                    f"Aby sprawdzić wszystkie dostępne klasy użyj komendy: 'read_classes'")

        if mess := self._validate_name(class_name):
            return mess

        if mess := self._validate_initialize_parameters_type(parameters):
            return mess

        # sprawdzamy, czy wskazywane parametry podane parametry do embedding należą do parametrów
        parameters_to_embed = parameters_to_embed or []
        if invalid_keys := set(parameters_to_embed) - set(parameters.keys()):
            return (f"BŁĄD: Parametry {sorted(invalid_keys)} wskazane do embeddingu nie istnieją "
                    f"w definicji klasy '{class_name}'. Dostępne parametry: {', '.join(parameters.keys())}. "
                    f"Popraw i wywołaj 'define_class' ponownie.")

        try:
            new_class = GraphClassSchema(parameters=parameters, parameters_to_embed=parameters_to_embed)

        except ValidationError as e:
            return f"BŁĄD: Nie udało się dodać klasy: '{class_name}'.: {e}"

        self.classes[class_name] = new_class
        return (f"OK: Zdefiniowano klasę: {self.read_class(class_name)}. "
                f"Możesz ją od teraz przypisywać do node. "
                f"Każdy taki node dostanie automatycznie etykietę '{self.class_label(class_name)}'.")

    def add_class_parameters(self, class_name: str, parameters: dict[str, Any]) -> str:
        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return self.err_mess_class_doesnt_exist(class_name)

        class_keys: set[str] = set(class_in_question.parameters.keys())
        given_parameters: set[str] = set(parameters.keys())
        shared_parameters: set[str] = class_keys & given_parameters

        info_message: str = ''
        if shared_parameters:
            info_message = (f"INFO: Klasa '{class_name}' już posiada parametry: {', '.join(shared_parameters)}.\n"
                            f"Pominięto dodanie zduplikowanych parametrów.")

        new_parameters = {k: v for k, v in parameters.items() if k not in shared_parameters}

        if mess_type := self._validate_initialize_parameters_type(new_parameters):
            return mess_type

        class_in_question.parameters |= new_parameters
        return f"{info_message}\nOK: Dodano parametry do klasy '{class_name}'. Aktualne parametry to: {self.read_class(class_name)}"

    def _validate_parameters(self, class_name: str, parameters: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return None, self.err_mess_class_doesnt_exist(class_name)

        error: bool = False
        error_messages: list[str] = []
        class_keys = set(class_in_question.parameters.keys())
        given_params = set(parameters.keys())

        missing_params = class_keys - given_params
        if missing_params:
            error_messages.append((f"INFO: Nie podano wartości dla parametrów: {missing_params}."
                                   f"W ich miejsce wstawiam defaultowe wartości dla klasy: {self.read_class(class_name)}."
                                   f"Jeżeli chcesz zmienić parametry instancji klasy dla node użyj 'edit_node_parameters'"))
            parameters = {**class_in_question.parameters, **parameters}

        exc_mess = self.__validate_parameter_excessive_amount(entity_name=class_name,
                                                              entity_keys=class_keys,
                                                              given_parameters=given_params)
        if exc_mess:
            error_messages.append(exc_mess)
            error = True

        type_mess = self.__validate_parameter_types(shared_parameters=class_keys & given_params,
                                                    entity_parameters=class_in_question.parameters,
                                                    parameters=parameters)
        if type_mess:
            error_messages.append(type_mess)
            error = True

        return None if error else parameters, '\n'.join(error_messages)

    def read_class(self, name) -> str:
        return f"{name}: {{ {self.classes[name].describe()} }}"

    def read_classes(self, internal: bool = False) -> str:
        if self.classes:
            classes = '\n'.join([f' - {self.read_class(class_name)}' for class_name in self.classes.keys()])
            if internal:
                return classes
            return f"INFO: Dostępne klasy:\n{classes}"
        return "BŁĄD: Nie dodano jeszcze żadnej klasy! Aby dodać klasę skożystaj z 'define_class'"

    def err_mess_class_doesnt_exist(self, class_name: str, helper: bool = True) -> str:
        mess: str = f"BŁĄD: Klasa '{class_name}' nie jest zdefiniowana."
        if helper:
            return mess + (f"\nDostępne klasy:\n{self.read_classes(internal=True)}\n"
                           f"Aby zdefiniować klasę użyj: 'define_class'")
        return mess

    # ------------------------------------------------------------------
    # WĘZŁY (NODE)
    # ------------------------------------------------------------------

    def merge(self, node_name: str, class_name: str, module: str, parameters: dict[str, Any]) -> str:
        if mess := self._validate_name(class_name):
            return mess

        error_messages: list[str] = []
        node_already_exists: bool = node_name in self.nodes.keys()
        module_missing: bool = not module or not module.strip()

        if node_already_exists:
            error_messages.append(f"BŁĄD: Node '{node_name}' już istnieje! Aby sprawdzić wszystkie istniejące nody, użyj 'read_node_names'")

        if module_missing:
            error_messages.append(("BŁĄD: Nie podano modułu dla node. Każdy node musi należeć do modułu ERP "
                                   "(np. 'Magazyn', 'Sprzedaz', 'Ksiegowosc'). To po nim filtrowane jest wyszukiwanie."
                                   "Podaj moduł i spróbuj jeszcze raz."))

        parameters, message = self._validate_parameters(class_name=class_name, parameters=parameters)
        error_messages.append(message)

        if node_already_exists or module_missing or parameters is None:
            return '\n'.join(error_messages)

        self.nodes[node_name] = GraphNode(c_name=class_name, c_parameters=parameters, module=module.strip())

        return (f"OK: Pomyślnie utworzono node '{node_name}' "
                f"(etykiety: '{self.SHARED_LABEL}', '{self.class_label(class_name)}')."
                f"Aby zobaczyć wszystkie utworzone node użyj 'read_node_names'.\n"
                f"{'\n'.join(error_messages)}")

    def edit_node_parameters(self, node_name: str, parameters: dict[str, Any], module:str | None = None) -> str:
        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        error_messages: list[str] = []
        class_keys: set[str] = set(self.classes[node_in_question.c_name].parameters.keys())
        given_parameters: set[str] = set(parameters.keys())

        if exc_mess := self.__validate_parameter_excessive_amount(entity_name=node_in_question.c_name,
                                                                  entity_keys=class_keys,
                                                                  given_parameters=given_parameters):
            error_messages.append(exc_mess)

        if type_mess := self.__validate_parameter_types(shared_parameters=class_keys & given_parameters,
                                                        entity_parameters=self.classes[node_in_question.c_name].parameters,
                                                        parameters=parameters):
            error_messages.append(type_mess)

        if error_messages:
            return (f"BŁĄD: Nie udało się edytować parametrów node '{node_name}'."
                    f"Wyeliminuj poniższe błędy i spróbuj ponownie:\n{'\n'.join(error_messages)}")

        module_message: str = ''
        if module is not None and module.strip():
            module_message: str = f"\nOK: Module node '{node_name}' został pomyślnie zmieniony"
            node_in_question.module = module.strip()

        node_in_question.c_parameters = {**node_in_question.c_parameters, **parameters}
        return f"OK: Parametry node '{node_name}' zostały pomyślnie zaktualizowane." + module_message

    def read_node_parameters(self, node_name: str, internal: bool = False) -> str:
        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        node_class = self.classes.get(node_in_question.c_name)
        if node_class is None:
            return self.err_mess_class_doesnt_exist(node_in_question.c_name)

        merged_parameters = node_class.parameters | node_in_question.c_parameters
        node_info = (f"{node_name}: (klasa={node_in_question.c_name}, modul={node_in_question.module}), "
                     f"{{ {', '.join([f"'{k}': {type(v).__name__} = {v}" for k, v in merged_parameters.items()])} }}")

        if internal:
            return node_info
        return f"INFO: Parametry node {node_info}"

    def read_node_names(self, internal: bool = False) -> str:
        if self.nodes:
            nodes = '\n'.join([f" - {node_name}" for node_name in self.nodes.keys()])
            if internal:
                return nodes
            return f"INFO: Dostępne nody:\n{nodes}"
        return "BŁĄD: Nie dodano jeszcze żadnego noda! Aby dodać node skożystaj z 'merge'"

    def err_mess_node_doesnt_exist(self, node_name: str, helper: bool = True) -> str:
        mess: str = f"BŁĄD: Node '{node_name}' nie istnieje."
        if helper:
            return mess + (f"\nDostępne nody:\n{self.read_node_names(internal=True)}\n"
                           f"Aby stworzyć node użyj: 'merge'")
        return mess

    def class_label(self, class_name: str) -> str:
        return f"{self.CLASS_LABEL_PREFIX}{class_name}"

    # ------------------------------------------------------------------
    # EMBEDDINGI
    # ------------------------------------------------------------------

    @staticmethod
    def __make_embeddings(node_in_question: GraphNode, class_in_question: GraphClassSchema, embed_model: EmbedModel) -> bool:
        """
        Automatyczne embedowanie wskazanych wcześniej parametrów węzła. Wywoływane
        z 'sync () ', tuż przed zapisem do Neo4j.

        :param node_in_question:
        :param class_in_question:
        :param embed_model:
        :return:
        """

        if not class_in_question.parameters_to_embed:
            return False

        def prepare_for_vector(parameters: dict[str, Any]) -> str:
            output: list[str] = []

            for k, v in parameters.items():
                if isinstance(v, list):
                    items = [item if isinstance(item, str) else repr(item) for item in v]
                    output.append(f"'{k}': [{', '.join(items)}]")
                else:
                    output.append(f"'{k}': {v}")

            return '\n'.join(output)

        parameters: dict[str, Any] = {
            k: node_in_question.c_parameters[k]
            for k in class_in_question.parameters_to_embed
            if k in node_in_question.c_parameters
        }

        if not parameters:
            return False

        prepared_text_for_vector_embedding: str = prepare_for_vector(parameters)

        # embed_model.encode() zwraca listę wektorów (struktura [[...]]) — bierzemy pierwszy,
        # bo embedujemy jeden tekst na raz
        if embeddings := embed_model.encode(prepared_text_for_vector_embedding):
            node_in_question.embeddings = embeddings[0]
            return True

        return False

    def add_embedding_parameters(self, class_name: str, parameters_to_embed: list[str]) -> str:
        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return self.err_mess_class_doesnt_exist(class_name)

        class_keys: set[str] = set(class_in_question.parameters.keys())
        class_embed_keys: set[str] = set(class_in_question.parameters_to_embed)
        given_parameters: set[str] = set(parameters_to_embed)

        if invalid_keys := given_parameters - class_keys:
            return (f"BŁĄD: Parametry: {', '.join(invalid_keys)} nie istnieją w klasie '{class_name}'. "
                    f"Przejrzyj dostępne parametry: {', '.join(class_keys)} i spróbuj ponownie")

        shared_parameters = class_embed_keys & given_parameters
        info_message = ''
        if shared_parameters:
            info_message = (f"INFO: Klasa '{class_name}' już posiada parametry przeznaczone do embeddingu: "
                            f"{', '.join(shared_parameters)}.\nPominięto dodanie zduplikowanych parametrów embedingowych.")

        parameters_to_add = list(given_parameters - shared_parameters)
        class_in_question.parameters_to_embed += parameters_to_add

        return (f"{info_message}\nOK: Dodano parametry embedingowe do klasy '{class_name}'. "
                f"Aktualne parametry embedingowe to: {', '.join(class_in_question.parameters_to_embed)}")

    def remove_embeddings_parameters(self, class_name: str, parameters_to_embed: list[str]) -> str:
        """
        Usuwamy parametry z listy tych embedowanych dla danej klasy — sam parametr
        w schemacie klasy (class.parameters) NIE jest usuwany, tylko przestaje być
        brany pod uwagę przy liczeniu embeddingu węzłów tej klasy.

        :param class_name: Nazwa klasy
        :param parameters_to_embed: lista nazw parametrów do usunięcia z listy embedowanych
        :return:
        """

        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return self.err_mess_class_doesnt_exist(class_name)

        class_embed_keys: set[str] = set(class_in_question.parameters_to_embed)
        given_parameters: set[str] = set(parameters_to_embed)

        if not_embedded := given_parameters - class_embed_keys:
            current = ', '.join(class_embed_keys) or '(brak)'
            return (f"BŁĄD: Parametry {sorted(not_embedded)} nie są aktualnie oznaczone do "
                    f"embeddingu dla klasy '{class_name}'. Aktualnie embedowane: {current}")

        class_in_question.parameters_to_embed = [
            p for p in class_in_question.parameters_to_embed if p not in given_parameters
        ]

        remaining = ', '.join(class_in_question.parameters_to_embed) or '(brak)'
        return (f"OK: Usunięto parametry {sorted(given_parameters)} z listy embedowanych dla klasy "
                f"'{class_name}'. Aktualne parametry embedingowe to: {remaining}")

    def read_embedding_parameters(self, class_name: str, internal: bool = False) -> str:
        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return self.err_mess_class_doesnt_exist(class_name)

        if not class_in_question.parameters_to_embed:
            info = f"{class_name}: (brak parametrów oznaczonych do embeddingu)"
        else:
            info = f"{class_name}: {', '.join(class_in_question.parameters_to_embed)}"

        return info if internal else f"INFO: {info}"

    # ------------------------------------------------------------------
    # RELACJE
    # ------------------------------------------------------------------

    def define_relation(self, relation: str, parameters: dict[str, Any] | None = None) -> str:
        relation = relation.upper()

        if relation in self.relations:
            return (f"BŁĄD: Ta relacja: '{relation}' już istnieje. "
                    f"Nie można jej dodać drugi raz."
                    f"Aby sprawdzić wszystkie dostępne relacje użyj 'read_relationships'")

        if mess := self._validate_name(relation):
            return mess

        parameters = parameters or {}
        if parameters and (mess := self._validate_initialize_parameters_type(parameters)):
            return mess

        self.relations[relation] = RelationSchema(parameters=parameters)
        return (f"INFO: Zamieniono znaki relacji na wielkie.\n"
                f"OK: Dodano relację '{relation}' do zbioru dostępnych relacji: {self.read_relation(relation)}."
                f"Aby sprawdzić wszystkie dostępne relacje użyj 'read_relationships'")

    def add_relation_parameters(self, relation: str, parameters: dict[str, Any]) -> str:
        relation = relation.upper()
        relation_in_question = self.relations.get(relation, None)
        if relation_in_question is None:
            return self.err_mess_relation_doesnt_exist(relation)

        relation_keys: set[str] = set(relation_in_question.parameters.keys())
        given_parameters: set[str] = set(parameters.keys())
        shared_parameters: set[str] = relation_keys & given_parameters

        info_message: str = ''
        if shared_parameters:
            info_message = (f"INFO: Relacja '{relation}' już posiada właściwości: {', '.join(shared_parameters)}.\n"
                            f"Pominięto dodanie zduplikowanych właściwości.")

        new_parameters = {k: v for k, v in parameters.items() if k not in shared_parameters}

        if mess_type := self._validate_initialize_parameters_type(new_parameters):
            return mess_type

        relation_in_question.parameters |= new_parameters
        return f"{info_message}\nOK: Dodano właściwości do relacji '{relation}'. Aktualne właściwości to: {self.read_relation(relation)}"

    def _validate_relation_parameters(self, relation: str, parameters: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        relation_in_question = self.relations.get(relation, None)
        if relation_in_question is None:
            return None, self.err_mess_relation_doesnt_exist(relation)

        error: bool = False
        error_messages: list[str] = []
        relation_keys = set(relation_in_question.parameters.keys())
        given_params = set(parameters.keys())

        missing_params = relation_keys - given_params
        if missing_params:
            error_messages.append((f"INFO: Nie podano wartości dla właściwości: {missing_params}."
                                   f"W ich miejsce wstawiam defaultowe wartości dla relacji: {self.read_relation(relation)}."))
            parameters = {**relation_in_question.parameters, **parameters}

        exc_mess = self.__validate_parameter_excessive_amount(entity_name=relation, entity_keys=relation_keys, given_parameters=given_params)
        if exc_mess:
            error_messages.append(exc_mess)
            error = True

        type_mess = self.__validate_parameter_types(shared_parameters=relation_keys & given_params,
                                                    entity_parameters=relation_in_question.parameters,
                                                    parameters=parameters)
        if type_mess:
            error_messages.append(type_mess)
            error = True

        return None if error else parameters, '\n'.join(error_messages)

    def relationship(self, from_node: str, to_nodes: list[str], relation: str, parameters: dict[str, Any] | None = None) -> str:
        relation = relation.upper()
        parameters = parameters or {}
        set_to_nodes: set[str] = set(to_nodes)

        error_messages: list[str] = []
        n_error: bool = False

        if relation not in self.relations:
            error_messages.append(self.err_mess_relation_doesnt_exist(relation))

        node_in_question = self.nodes.get(from_node, None)
        if node_in_question is None:
            error_messages.append(self.err_mess_node_doesnt_exist(from_node, helper=False))
            n_error = True

        for node in set_to_nodes:
            if node not in self.nodes.keys():
                error_messages.append(self.err_mess_node_doesnt_exist(node, helper=False))
                n_error = True

        if error_messages:
            if n_error:
                error_messages.append((f"\nDostępne nody:\n{self.read_node_names(internal=True)}\n"
                                       f"Aby stworzyć node użyj: 'merge'\n"))
            return 'BŁĄD: Nie udało się wykonać połączeń. Najpierw napraw błędy i spróbuj ponownie:\n' + '\n'.join(error_messages)

        validated_parameters, mess = self._validate_relation_parameters(relation, parameters)
        if validated_parameters is None:
            return f"BŁĄD: Nie udało się utworzyć relacji '{relation}':\n{mess}"

        current_related_nodes: set[str] = {edge.target for edge in node_in_question.n_relations.get(relation, [])}
        if relation not in node_in_question.n_relations:
            node_in_question.n_relations[relation] = []

        result_messages: list[str] = [mess] if mess else []

        for node in set_to_nodes:
            if node in current_related_nodes:
                result_messages.append(f"INFO: node '{from_node}' już był połączony z '{node}' relacją '{relation}'. ({from_node}-[{relation}]->{node})")
                continue

            node_in_question.n_relations[relation].append(RelationEdge(target=node, r_parameters=validated_parameters))
            result_messages.append(f"OK: node '{from_node}' został połączony z '{node}' relacją '{relation}' {validated_parameters}. ({from_node}-[{relation}]->{node})")

        return '\n'.join(result_messages) + "\nAby zobaczyć wszystkie połaczenia z danego node użyj 'read_node_relations'"

    def read_relation(self, name) -> str:
        return f"{name}: {{ {self.relations[name].describe()} }}"

    def read_relationships(self, internal: bool = False) -> str:
        if self.relations:
            relations = '\n'.join([f" - {self.read_relation(name)}" for name in self.relations.keys()])
            if internal:
                return relations
            return f"INFO: Dostępne relacje:\n{relations}"
        return f"BŁĄD: Nie dodano jeszcze żadnej relacji! Aby dodać relację skożystaj z 'define_relation'"

    def read_node_relations(self, node_name: str, relation: str | None = None) -> str:
        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        if len(node_in_question.n_relations) == 0:
            return (f"INFO: Node '{node_name}' nie posiada jeszcze żadnej relacji."
                    f"Aby dodać relację użyj 'relationship'")

        if relation is None:
            relations = [
                f" - '{k}' -> ({', '.join(f'{edge.target} {edge.r_parameters}' if edge.r_parameters else edge.target for edge in edges)})"
                for k, edges in node_in_question.n_relations.items()
            ]
            return f"OK: Aktualnie, wszystkie relacje node '{node_name}' to:\n{'\n'.join(relations)}"

        relation = relation.upper()
        edges = node_in_question.n_relations.get(relation, None)
        if edges is None:
            return (f"BŁĄD: Node '{node_name}' nie posiada relacji '{relation}'."
                    f"Upewnij się, czy na pewno wpisałeś poprawnie lub użyj"
                    f"'read_node_relations' nie podając parametru relation, aby zobaczyć"
                    f"wszystkie relacje danego node")

        targets = ', '.join(f'{edge.target} {edge.r_parameters}' if edge.r_parameters else edge.target for edge in edges)
        return f"OK: Relacja '{relation}' dla node '{node_name}' to:\n - {relation} -> ({targets})"

    def err_mess_relation_doesnt_exist(self, relation_name: str, helper: bool = True) -> str:
        mess: str = f"BŁĄD: Relacja '{relation_name}' nie istnieje."
        if helper:
            return mess + (f"\nDostępne relacje:\n{self.read_relationships(internal=True)}\n"
                           f"Aby stworzyć relację użyj: 'define_relation'")
        return mess

    # ------------------------------------------------------------------
    # ETYKIETY
    # ------------------------------------------------------------------

    def define_label(self, label: str) -> str:
        if mess := self._validate_name(label):
            return mess

        if label.startswith(self.CLASS_LABEL_PREFIX):
            return (f"BŁĄD: Prefiks '{self.CLASS_LABEL_PREFIX}' jest zarezerwowany dla automatycznych "
                    f"etykiet klas (patrz 'define_class'). Wybierz etykietę bez tego prefiksu.")

        if label == self.SHARED_LABEL:
            return (f"BŁĄD: Etykieta '{label}' jest zarezerwowana systemowo -- jest już automatycznie "
                    f"nadawana KAŻDEMU node. Nie możesz jej zarejestrować ani nadać ręcznie.")

        if label in self.labels:
            return (f"BŁĄD: Etykieta '{label}' już jest zarejestrowana."
                    f"Aby sprawdzić wszystkie dostępne etykiety użyj 'read_labels'")

        self.labels.add(label)
        return f"OK: Zarejestrowano etykietę '{label}'. Możesz ją teraz przypisywać do node przez 'add_node_label'"

    def add_node_label(self, node_name: str, label: str) -> str:
        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        if label not in self.labels:
            return self.err_mess_label_doesnt_exist(label)

        if label in node_in_question.n_labels:
            return f"INFO: Node '{node_name}' już posiada etykietę '{label}'."

        node_in_question.n_labels.add(label)
        return f"OK: Dodano etykietę '{label}' do node '{node_name}'."

    def read_labels(self, internal: bool = False) -> str:
        if self.labels:
            labels = '\n'.join([f" - {label}" for label in sorted(self.labels)])
            if internal:
                return labels
            return f"INFO: Dostępne etykiety:\n{labels}"
        return "BŁĄD: Nie zarejestrowano jeszcze żadnej etykiety! Aby dodać etykietę skożystaj z 'define_label'"

    def read_node_labels(self, node_name: str, internal: bool = False) -> str:
        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        auto_label = self.class_label(node_in_question.c_name)
        manual_labels = ', '.join(sorted(node_in_question.n_labels)) if node_in_question.n_labels else "(brak)"
        info = f"wspólna: {self.SHARED_LABEL}; klasy: {auto_label}; dodatkowe: {manual_labels}"

        return info if internal else f"INFO: Etykiety node '{node_name}' -- {info}"

    def err_mess_label_doesnt_exist(self, label: str, helper: bool = True) -> str:
        mess: str = f"BŁĄD: Etykieta '{label}' nie jest zarejestrowana."
        if helper:
            return mess + (f"\nDostępne etykiety:\n{self.read_labels(internal=True)}\n"
                           f"Aby zarejestrować etykietę użyj: 'define_label'")
        return mess

    # ------------------------------------------------------------------
    # WALIDACJA WSPÓLNA
    # ------------------------------------------------------------------

    def _validate_name(self, name: str) -> str:
        if not self.IDENTIFIER_PATTERN.match(name):
            return (f"BŁĄD: Nieprawidłowa nazwa '{name}'!\n"
                    f"Wymagania:\n"
                    f" - Nazwa musi zaczynać się od litery (A-Z lub a-z)\n"
                    f" - Może zawierać tylko litery, cyfry oraz znak podkreślenia (_)\n"
                    f" - Długość może wynosić od 1 do 64 znaków włącznie\n"
                    f" - Polskie znaki (np. ą, ś, ż) nie są dozwolone!")

        if name.upper() in {reserved.upper() for reserved in self.RESERVED_PARAMETER_NAMES}:
            return (f"BŁĄD: Nazwa '{name}' jest zarezerwowana systemowo i nie może być "
                    f"nazwą klasy, relacji, etykiety ani parametru!")

        return ''

    @staticmethod
    def __deep_type(parameter: Any) -> str:
        if isinstance(parameter, list):
            if len(parameter) == 0:
                return "list[EMPTY]"

            base_type = type(parameter[0])
            different_types: list[str] = [base_type.__name__]

            for param in parameter:
                if not isinstance(param, base_type):
                    new_type = type(param).__name__
                    if new_type not in different_types:
                        different_types.append(new_type)

            return f"list[{', '.join(different_types)}]"
        return type(parameter).__name__

    def _validate_initialize_parameters_type(self, parameters: dict[str, Any]) -> str:
        error_messages: list[str] = []

        for name, value in parameters.items():
            if isinstance(value, self.VALID_TYPES):
               continue

            if isinstance(value, list):
                if len(value) > 0:
                    base_type = type(value[0])
                    if all(type(item) is base_type and isinstance(item, self.VALID_TYPES) for item in value):
                        continue

            error_messages.append(f"BŁĄD: Parametr '{name}' używa niedozwolonego typu wartości: {self.__deep_type(value)}!")

        reserved_used = [name for name in parameters if name in self.RESERVED_PARAMETER_NAMES]
        if reserved_used:
            reserved_message: str = f"BŁAD: Nazwy {reserved_used} są zarezerwowane systemowo i nie mogą być nazwą parametru!"

            if any(possible_module_name in reserved_used for possible_module_name in self.MODULE_NAMES):
                reserved_message += f"Moduł należy podać osobnym argumentem 'module' przy tworzeniu node ('merge'), a nie jako parametr klasy."

            error_messages.append(reserved_message)

        if error_messages:
            error_messages.append((f"Dozwolone typy parametrów to: {', '.join(self.VALID_NAMES)}.\n"
                                  f"Sprawdź poprawność przekazanych parametrów i spróbuj ponownie."))
            return '\n'.join(error_messages)

        return ''

    def __validate_parameter_excessive_amount(self, entity_name: str, entity_keys: set[str], given_parameters: set[str]) -> str:
        excessive_params = given_parameters - entity_keys
        if excessive_params:
            return (f"BŁĄD: Podano zbyt dużo parametrów dla: '{entity_name}'."
                    f"Nadmiarowe parametry to: {excessive_params}."
                    f"Aby dodać nowe parametry do istniejącej klasy użyj 'add_class_parameters', "
                    f"a dla relacji 'add_relation_parameters'")
        return ''

    def __validate_parameter_types(self, shared_parameters: set[str], entity_parameters: dict[str, Any], parameters: dict[str, Any]) -> str:
        different_parameter_type: dict[str, tuple[str, str]] = {}

        for key in shared_parameters:
            should_be_parameter_type = self.__deep_type(entity_parameters[key])
            new_parameter_type = self.__deep_type(parameters[key])

            if should_be_parameter_type != new_parameter_type:
                different_parameter_type[key] = (should_be_parameter_type, new_parameter_type)

        if different_parameter_type:
            return (f"BŁĄD: Typu parametrów różnią się od typów: "
                    f"{[f"'{k}': oczekiwany: {v[0]}, otrzymany: {v[1]}" for k, v in different_parameter_type.items()]}")
        return ''

    # ------------------------------------------------------------------
    # synchronizacja Z NEO4J
    # ------------------------------------------------------------------

    def ensure_constraints(self, driver, database: str = "neo4j") -> None:
        driver.execute_query(
            f"CREATE CONSTRAINT unique_node_id_{self.SHARED_LABEL} IF NOT EXISTS "
            f"FOR (n:{self.SHARED_LABEL}) REQUIRE n.node_id IS UNIQUE",
            database_=database,
        )

    def ensure_vector_index(self, driver, dimensions: int, database: str = "neo4j",
                             index_name: str = "entity_embeddings", similarity: str = "cosine") -> None:
        """
        Jeden indeks wektorowy na wspólnej etykiecie SHARED_LABEL — obejmuje Wszystkie
        klasy naraz, niezależnie od tego, ile ich model kiedykolwiek zdefiniuje.

        :param driver: Połączenie neo4j
        :param dimensions: wymiar wektora (musi zgadzać się z modelem embedding, np. EMBED_MODEL_DIM)
        :param database: nazwa bazy
        :param index_name: nazwa indeksu
        :param similarity: funkcja podobieństwa ('cosine' albo 'euclidean')
        :return:
        """

        driver.execute_query(
            f"CREATE VECTOR INDEX {index_name} IF NOT EXISTS "
            f"FOR (n:{self.SHARED_LABEL}) ON (n.embeddings) "
            f"OPTIONS {{ indexConfig: {{ "
            f"`vector.dimensions`: toInteger($dimensions), "
            f"`vector.similarity_function`: $similarity "
            f"}} }}",
            dimensions=dimensions,
            similarity=similarity,
            database_=database,
        )

    def _compute_embeddings(self, embed_model: EmbedModel) -> int:
        """
        Liczy embeddingi dla Wszystkich węzłów, których klasa ma zdefiniowane
        'parameters_to_embed'. Wywoływane z 'sync () ', PRZED zapisem do bazy.

        :param embed_model: Instancja modelu embedding (musi mieć metodę.encode())
        :return: liczba węzłów, dla których policzono embedding
        """

        computed = 0

        for node in tqdm(self.nodes.values(), desc="Liczenie embeddingów"):
            class_schema = self.classes.get(node.c_name)
            if class_schema is None or not class_schema.parameters_to_embed:
                continue

            if self.__make_embeddings(node, class_schema, embed_model):
                computed += 1

        return computed

    def _prepare_nodes(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []

        for node_name, node in self.nodes.items():
            labels = [self.SHARED_LABEL, self.class_label(node.c_name), *sorted(node.n_labels)]
            properties: dict[str, Any] = {
                **node.c_parameters,
                "node_id": node_name,
                "klasa": node.c_name,
                "modul": node.module
            }

            # Neo4j nie przyjmuje None jako wartości właściwości — dopisujemy
            # 'embeddings' TYLKO jeśli faktycznie zostało policzone
            if node.embeddings is not None:
                properties["embeddings"] = node.embeddings

            rows.append({"node_id": node_name, "labels": labels, "properties": properties})

        return rows

    def _relation_rows(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []

        for node_name, node in self.nodes.items():
            for relation_type, edges in node.n_relations.items():
                for edge in edges:
                    rows.append({
                        "from": node_name,
                        "to": edge.target,
                        "type": relation_type,
                        "properties": edge.r_parameters,
                    })

        return rows

    def sync(self, driver, database: str = "neo4j", batch_size: int = 500,
             embed_model: EmbedModel | None = None, embed_dimensions: int | None = None) -> dict[str, int]:
        """
        Zapisuje CAŁY graf (węzły + relacje) do Neo4j. Idempotentne — bezpieczne
        do wielokrotnego wywołania na tym samym stanie grafu.

        :param driver: Połączenie neo4j.graphdatabase.driver (...)
        :param database: nazwa bazy
        :param batch_size: ile wierszy na jeden UNWIND
        :param embed_model: opcjonalna instancja modelu embedding — jeśli podana,
            przed zapisem policzone zostaną embeddingi dla węzłów klas, które je mają
            skonfigurowane (patrz 'add_embedding_parameters'), i utworzony indeks wektorowy.
            Jeśli pominięta — embeddingi NIE są liczone (zachowanie jak dotychczas).
        :param embed_dimensions: Wymiar wektora, wymagany, jeśli podano embed_model
            (np. EMBED_MODEL_DIM)
        :return: {"nodes": ile zapisano, "relations": ile zapisano, "embeddings": ile policzono}
        """

        self.ensure_constraints(driver, database)

        embeddings_computed = 0
        if embed_model is not None:
            if embed_dimensions is None:
                raise ValueError("Podano 'embed_model', ale nie podano 'embed_dimensions' -- wymagane do utworzenia indeksu wektorowego.")

            embeddings_computed = self._compute_embeddings(embed_model)
            self.ensure_vector_index(driver, dimensions=embed_dimensions, database=database)

        node_rows = self._prepare_nodes()
        relation_rows = self._relation_rows()

        written_nodes, written_relations = 0, 0

        with driver.session(database=database) as session:
            with tqdm(total=len(node_rows), desc="Zapisywanie węzłów") as pbar:
                for i in range(0, len(node_rows), batch_size):
                    chunk = node_rows[i: i + batch_size]
                    written_nodes += session.execute_write(self.__write_node_batch, chunk)
                    pbar.update(len(chunk))

            with tqdm(total=len(relation_rows), desc="Zapisywanie relacji") as pbar:
                for i in range(0, len(relation_rows), batch_size):
                    chunk = relation_rows[i: i + batch_size]
                    written_relations += session.execute_write(
                        self.__write_relation_batch, chunk, self.SHARED_LABEL
                    )
                    pbar.update(len(chunk))

        return {"nodes": written_nodes, "relations": written_relations, "embeddings": embeddings_computed}

    @staticmethod
    def __write_node_batch(tx, rows: list[dict[str, Any]]) -> int:
        result = tx.run(
            """
            UNWIND $rows AS row
            CALL apoc.merge.node(row.labels, {node_id: row.node_id}, row.properties, row.properties)
            YIELD node
            RETURN count(node) AS written
            """,
            rows=rows,
        )
        return result.single()["written"]

    @staticmethod
    def __write_relation_batch(tx, rows: list[dict[str, Any]], shared_label: str) -> int:
        result = tx.run(
            f"""
            UNWIND $rows AS row
            MATCH (a:{shared_label} {{node_id: row.from}})
            MATCH (b:{shared_label} {{node_id: row.to}})
            CALL apoc.merge.relationship(a, row.type, {{}}, row.properties, b, row.properties)
            YIELD rel
            RETURN count(rel) AS written
            """,
            rows=rows,
        )
        return result.single()["written"]

    # ------------------------------------------------------------------
    # SEARCH
    # ------------------------------------------------------------------

    # TODO
    @classmethod
    def search_semantic(cls, driver: Driver, query_embedding: list[float], top_k: int = 5,
                        module: str | None = None, database: str = "neo4j",
                        index_name: str = "entity_embeddings") -> list[dict[str, Any]]:
        """
        Wyszukiwanie semantyczne po CAŁYM grafie (indeks na SHARED_LABEL, więc
        niezależnie od klasy). Jeśli podano 'module', wyniki są filtrowane po
        właściwości 'modul' PO STRONIE PYTHONA — pobieramy więcej surowych wyników
        niż top_k (over-fetch), żeby filtr nie obcinał trafnych wyników zbyt wcześnie
        (bezpieczne niezależnie od wersji Neo4j — nie polega na natywnym filtrowanym
        wyszukiwaniu wektorowym, które jest dostępne dopiero w najnowszych wersjach).

        :param driver: Połączenie neo4j
        :param query_embedding: wektor zapytania (ten sam model/wymiar co przy indeksowaniu)
        :param top_k: ile wyników zwrócić
        :param module: opcjonalny filtr po właściwości 'modul'
        :param database: nazwa bazy
        :param index_name: nazwa indeksu wektorowego
        :return: lista {"node_id", "klasa", "score", "properties"} (bez surowego wektora)
        """

        raw_k = top_k * 5 if module else top_k
        records, _, _ = driver.execute_query(
            """
            CALL db.index.vector.queryNodes($index_name, $raw_k, $query_embedding)
            YIELD node, score
            RETURN node.node_id AS node_id, node.klasa AS klasa, score, properties(node) AS properties
            ORDER BY score DESC
            """,
            index_name=index_name,
            raw_k=raw_k,
            query_embedding=query_embedding,
            database_=database,
        )

        results: list[dict[str, Any]] = []
        for r in records:
            props = dict(r["properties"])
            props.pop("embeddings", None)  # nigdy nie zwracamy surowego wektora do LLM

            if module is not None and props.get("modul", "").casefold() != module.casefold():
                continue

            results.append({
                "node_id": r["node_id"],
                "klasa": r["klasa"],
                "score": r["score"],
                "properties": props,
            })

            if len(results) >= top_k:
                break

        return results

    @classmethod
    def explore_neighbors(cls, driver: Driver, node_id: str, hops: int = 2,
                          relation_types: list[str] | None = None,
                          limit: int = 50, database: str = "neo4j") -> dict[str, Any]:
        """
        Multi-hop: eksploruje sąsiedztwo danego węzła do 'hops' kroków w głąb.
        Używa apoc.path.subgraphall — w przeciwieństwie do surowego cyphera
        (gdzie granice ścieżki zmiennej długości trudno bezpiecznie parametrization),
        APOC przyjmuje konfigurację jako zwykły parametr, z limitem węzłów i
        opcjonalnym filtrem typów relacji.

        :param driver: Połączenie neo4j
        :param node_id: węzeł startowy
        :param hops: maksymalna liczba kroków w głąb
        :param relation_types: opcjonalna lista typów relacji do przejścia (domyślnie: wszystkie)
        :param limit: maksymalna liczba węzłów w wyniku (zabezpieczenie przed eksplozją grafu)
        :param database: nazwa bazy
        :return: {"nodes": [...], "relationships": [...]}
        """

        config: dict[str, Any] = {"maxLevel": hops, "limit": limit}
        if relation_types:
            config["relationshipFilter"] = "|".join(relation_types)

        records, _, _ = driver.execute_query(
            f"""
            MATCH (start:{cls.SHARED_LABEL} {{node_id: $node_id}})
            CALL apoc.path.subgraphAll(start, $config)
            YIELD nodes, relationships
            RETURN nodes, relationships
            """,
            node_id=node_id,
            config=config,
            database_=database,
        )

        if not records:
            return {"nodes": [], "relationships": []}

        record = records[0]

        nodes_out = []
        for n in record["nodes"]:
            props = dict(n)
            props.pop("embeddings", None)
            nodes_out.append({"node_id": props.get("node_id"), "klasa": props.get("klasa"), "properties": props})

        relationships_out = []
        for r in record["relationships"]:
            relationships_out.append({
                "from": dict(r.start_node).get("node_id"),
                "to": dict(r.end_node).get("node_id"),
                "type": r.type,
                "properties": dict(r),
            })

        return {"nodes": nodes_out, "relationships": relationships_out}

    @classmethod
    def find_shortest_path(cls, driver: Driver, from_node_id: str, to_node_id: str,
                           max_hops: int = 6, database: str = "neo4j") -> list[dict[str, Any]] | None:
        """
        Najkrótsza ścieżka między dwoma ZNANYMI węzłami — natywna funkcja cyphera
        shortestPath (), bez potrzeby APOC.

        :param driver: Połączenie neo4j
        :param from_node_id: węzeł startowy
        :param to_node_id: węzeł docelowy
        :param max_hops: maksymalna długość ścieżki do rozważenia
        :param database: nazwa bazy
        :return: lista kroków ścieżki (węzeł/relacja na przemian) albo None, jeśli brak połączenia
        """

        records, _, _ = driver.execute_query(
            f"""
            MATCH (a:{cls.SHARED_LABEL} {{node_id: $from_id}}), (b:{cls.SHARED_LABEL} {{node_id: $to_id}})
            MATCH path = shortestPath((a)-[*..{int(max_hops)}]-(b))
            RETURN nodes(path) AS path_nodes, relationships(path) AS path_rels
            """,
            from_id=from_node_id,
            to_id=to_node_id,
            database_=database,
        )

        if not records:
            return None

        record = records[0]
        path_nodes = record["path_nodes"]
        path_rels = record["path_rels"]

        steps: list[dict[str, Any]] = []
        for i, node in enumerate(path_nodes):
            props = dict(node)
            props.pop("embeddings", None)
            steps.append({"type": "node", "node_id": props.get("node_id"), "klasa": props.get("klasa")})

            if i < len(path_rels):
                steps.append({"type": "relationship", "relation": path_rels[i].type})

        return steps

    def clear(self):
        self.nodes.clear()
        self.relations.clear()
        self.classes.clear()
        self.labels.clear()

def _llm_passed_invalid_parameters(value: Any) -> tuple[dict[str, Any] | None, str | None]:
    """
    Modele czasem wysyłają zagnieżdżony obiekt jako string JSON (czasem ucięty).
    Przyjmujemy oba warianty i zwracamy czytelny błąd zamiast wyjątku walidacji.

    :param value:
    :return:
    """

    if value is None:
        return {}, None

    if isinstance(value, dict):
        return value, None

    if isinstance(value, str):
        for candidate in (value, value + "}", value + '"}', value.rstrip(", ") + "}"):
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed, None

        return None, (f"BŁĄD: 'parameters' musi być obiektem JSON (słownikiem), otrzymano "
                      f"nieprawidłowy tekst: {value!r}. Popraw i wywołaj narzędzie ponownie.")

    return None, f"BŁĄD: 'parameters' musi być obiektem JSON, otrzymano typ {type(value).__name__}."

def _llm_passed_invalid_list(value: Any) -> tuple[list[str] | None, str | None]:
    """
    Analogiczne do '_llm_passed_invalid_parameters', ale dla list — modele czasem
    wysyłają listę jako string JSON (np. ' ["nazwa", "opis"] ') zamiast prawdziwej listy.

    :param value:
    :return:
    """

    if value is None:
        return [], None

    if isinstance(value, list):
        if not all(isinstance(x, str) for x in value):
            bad = [type(x).__name__ for x in value if not isinstance(x, str)]
            return None, (f"BŁĄD: oczekiwano listy stringów, ale lista zawiera elementy typu: "
                          f"{', '.join(bad)}. Podaj nazwy jako tekst, np. [\"tytul\", \"opis\"].")

        return value, None

    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None, (f"BŁĄD: nie udało się sparsować jako listy stringów: {value!r}. "
                          f"Popraw i wywołaj narzędzie ponownie.")

        if isinstance(parsed, list) and all(isinstance(x, str) for x in parsed):
            return parsed, None

        return None, f"BŁĄD: oczekiwano listy stringów, otrzymano: {value!r}"

    return None, f"BŁĄD: oczekiwano listy stringów, otrzymano typ {type(value).__name__}."

@tool
def define_class(class_name: str, parameters: dict[str, Any] | str,
                  parameters_to_embed: list[str] | str | None = None) -> str:
    """
    Defines a new node class (entity type) with a FIXED set of allowed parameters.
    Every node of this class must have exactly these parameters (no more, no less).
    Call this ONCE per class, before creating any node of that class with 'merge'.

    Use 'read_classes' first to check if a similar class already exists, to avoid
    creating near-duplicate classes (e.g. "Procedure" and "Procedura").

    :param class_name: Unique class name in PascalCase (letters, digits, underscore only,
        must start with a letter, e.g. "Procedura", "DokumentMagazynowy").
    :param parameters: Dict of {parameter_name: example_value}. The example value's TYPE
        becomes the required type for that parameter on every node of this class.
        Allowed types: str, int, float, bool, or a homogeneous list of one of these
        (e.g. ["a", "b"] for a list of strings). Nested objects/dicts are NOT allowed.
        Must contain at least one parameter. Do NOT include 'node_id' or 'klasa' --
        these names are reserved and managed automatically by the system.
    :param parameters_to_embed: Optional list of parameter names (must be a subset of
        'parameters' above) whose content should be combined into a semantic embedding
        for every node of this class -- enables finding these nodes via
        'search_knowledge_graph'. Only set this for classes with real searchable
        content (procedures, error descriptions, concepts) -- omit for purely
        structural/technical classes. Can also be set later via 'add_embedding_parameters'.
    :return: confirmation message, or an explanation of what went wrong
    """

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

    :param class_name: Name of an existing class (check with 'read_classes')
    :param parameters: Dict of {parameter_name: example_value} to add. Same type rules
        as 'define_class'.
    :return: confirmation message, or an explanation of what went wrong
    """

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

    return knowledge_graph.read_classes()

@tool
def add_embedding_parameters(class_name: str, parameters_to_embed: list[str]) -> str:
    """
    Marks existing parameters of a class as ones that should be used to compute a
    semantic embedding (vector) for every node of that class. This powers semantic
    search over the knowledge graph -- nodes whose classes have NO embedded parameters
    will never show up in semantic search results.

    Only call this for classes whose nodes are actually meaningful to search for
    semantically (e.g. procedures, error descriptions, concepts) -- not for purely
    structural/technical classes.

    :param class_name: Name of an existing class (check with 'read_classes')
    :param parameters_to_embed: List of parameter names (must already exist on the
        class, e.g. ["nazwa", "opis"]) whose STRING content will be combined and
        embedded for every node of this class
    :return: confirmation message, or an explanation of what went wrong
    """

    parameters, error = _llm_passed_invalid_list(parameters_to_embed)
    if error:
        return error

    return knowledge_graph.add_embedding_parameters(class_name, parameters)

@tool
def remove_embeddings_parameters(class_name: str, parameters_to_embed: list[str]) -> str:
    """
    Removes parameters from the list of ones used to compute a class's embedding
    (set via 'add_embedding_parameters'). The parameters themselves stay on the class
    schema -- they just stop being included in the embedded text.

    :param class_name: Name of an existing class
    :param parameters_to_embed: List of parameter names to remove from the embedding list
        (must currently be marked as embedded -- check with 'read_embedding_parameters')
    :return: confirmation message, or an explanation of what went wrong
    """

    parameters, error = _llm_passed_invalid_list(parameters_to_embed)
    if error:
        return error

    return knowledge_graph.remove_embeddings_parameters(class_name, parameters)

@tool
def read_embedding_parameters(class_name: str) -> str:
    """
    Shows which parameters of a class are currently marked for embedding (used in
    semantic search). Call this to check before adding/removing embedded parameters,
    or to understand why a class's nodes may or may not appear in semantic search results.

    :param class_name: Name of an existing class to inspect
    """

    return knowledge_graph.read_embedding_parameters(class_name)

@tool
def merge(node_name: str, class_name: str, module:str, parameters: dict[str, Any] | str) -> str:
    """
    Creates a NEW node in the knowledge graph. FAILS if a node with this name already
    exists -- this is intentional, to prevent accidentally overwriting existing data.
    Use 'edit_node_parameters' to update an existing node instead.

    The class must already be defined (use 'define_class' first). Optional parameters
    (ones with a default value) are filled in automatically if omitted, but required
    parameters (ones without a default) MUST be provided or this call will fail.

    :param node_name: Unique identifier for this node (e.g. "proc_pz_001"). Must not
        already exist -- check with 'read_node_names' if unsure.
    :param class_name: The class this node belongs to (must already be defined)
    :param module: ERP module this node belongs to, e.g. "Magazyn", "Sprzedaz",
        "Ksiegowosc". REQUIRED -- this is what lets the assistant later narrow a search
        to one module. Use the exact module name from the source document. Do NOT put
        the module inside 'parameters' -- it is a system field, like the node's name.
    :param parameters: Dict of {parameter_name: value} matching the class's schema.
        Check the class's expected parameters with 'read_classes' first if unsure.
    :return: confirmation message, or an explanation of what went wrong (e.g. missing
        required parameters, wrong value types, or a node with this name already exists)
    """

    params, error = _llm_passed_invalid_parameters(parameters)
    if error:
        return error
    return knowledge_graph.merge(node_name, class_name, module, params)

@tool
def edit_node_parameters(node_name: str, parameters: dict[str, Any] | str) -> str:
    """
    Updates parameters of an EXISTING node. This is a PARTIAL update -- only the
    parameters you provide are changed, everything else on the node stays the same.

    Use this to correct or update a node that was already created with 'merge'.
    If the node doesn't exist yet, use 'merge' instead to create it.

    :param node_name: Name of an existing node (check with 'read_node_names')
    :param parameters: Dict of {parameter_name: new_value} for only the fields you
        want to change
    :return: confirmation message, or an explanation of what went wrong
    """

    params, error = _llm_passed_invalid_parameters(parameters)
    if error:
        return error
    return knowledge_graph.edit_node_parameters(node_name, params)

@tool
def read_node_names() -> str:
    """
    Lists ALL existing node names in the graph. Call this before 'merge' to check
    whether a node already exists, or before 'relationship' to find valid target
    node names.
    """

    return knowledge_graph.read_node_names()

@tool
def read_node_parameters(node_name: str) -> str:
    """
    Shows the class and all parameter values (including class defaults) of a specific node.

    :param node_name: Name of the node to inspect
    """

    return knowledge_graph.read_node_parameters(node_name)

@tool
def define_relation(relation: str, parameters: dict[str, Any] | str | None = None) -> str:
    """
    Registers a new TYPE of relationship that can later connect nodes (via 'relationship').
    Optionally gives it standardized properties that every use of this relation type must
    carry (e.g. a "WYMAGA" relation might always need a "priorytet" property).

    Call this ONCE per relation type, before using it in 'relationship'. If a relation
    type doesn't need any properties (e.g. a simple "ZNA" relation), just omit 'parameters'.

    :param relation: Name of the relation type, e.g. "WYMAGA", "DOTYCZY", "NALEŻY_DO"
        (automatically uppercased). Letters, digits, underscore only.
    :param parameters: Optional dict of {property_name: example_value} that every use
        of this relation should carry. Omit entirely if this relation has no properties.
    :return: confirmation message, or an explanation of what went wrong
    """

    if parameters is None:
        params, error = None, None
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

    params, error = _llm_passed_invalid_parameters(parameters)
    if error:
        return error
    return knowledge_graph.add_relation_parameters(relation, params)

@tool
def relationship(from_node: str, to_nodes: list[str], relation: str, parameters: dict[str, Any] | str | None = None) -> str:
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

    targets, list_error = _llm_passed_invalid_list(to_nodes)

    if list_error:
        return list_error

    if not targets:
        return "BŁĄD: 'to_nodes' jest puste! Podaj co najmniej jeden istniejący node docelowy."

    if parameters is None:
        params, error = None, None

    else:
        params, error = _llm_passed_invalid_parameters(parameters)

    if error:
        return error

    return knowledge_graph.relationship(from_node, to_nodes, relation, params)

@tool
def read_relationships() -> str:
    """
    Lists ALL defined relation types with their standardized properties (if any).
    Call this before 'define_relation' to avoid duplicates, or before 'relationship'
    to check what properties a relation type expects.
    """

    return knowledge_graph.read_relationships()

@tool
def read_node_relations(node_name: str, relation: str | None = None) -> str:
    """
    Shows the relationships of a specific node -- either all of them, or just one
    relation type if specified. Use this to check existing connections before adding
    new ones, to avoid creating duplicates.

    :param node_name: Name of the node to inspect
    :param relation: Optional -- limit results to just this relation type
    """

    return knowledge_graph.read_node_relations(node_name, relation)

@tool
def define_label(label: str) -> str:
    """
    Registers a new, OPTIONAL tag that can later be attached to any node (via
    'add_node_label'), independent of its class. Use this for cross-cutting flags
    that don't fit the class system, e.g. "Priorytetowe", "DoWeryfikacji", "Przestarzale".

    Do NOT use this for the node's type/category -- that's what classes are for.
    Labels are for optional, orthogonal tagging, not for defining what a node IS.

    :param label: Name to register (letters, digits, underscore only, must start with
        a letter). Cannot start with "C_" (reserved for automatic class labels).
    :return: confirmation message, or an explanation of what went wrong
    """

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

    return knowledge_graph.add_node_label(node_name, label)

@tool
def read_labels() -> str:
    """Lists all registered, optional labels available to attach to nodes via 'add_node_label'."""

    return knowledge_graph.read_labels()

@tool
def read_node_labels(node_name: str) -> str:
    """
    Shows all labels currently attached to a specific node.

    :param node_name: Name of the node to inspect
    """

    return knowledge_graph.read_node_labels(node_name)

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
    :param module: Optional -- restrict results to a specific ERP module (e.g. "Magazyn").
        Omit to search across all modules.
    :return: matching nodes with their class, relevance score, and properties
    """

    if graph_driver is None or embed_model is None:
        return "BŁĄD: Baza danych lub model embeddingów nie zostały zainicjalizowane."

    query_embedding = embed_model.encode(query)[0]
    results = KnowledgeGraph.search_semantic(graph_driver, query_embedding, top_k=top_k, module=module)
    return _format_search_results(results)

@tool
def explore_neighbors(node_id: str, hops: int = 2, relation_types: list[str] | None = None) -> str:
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

    result = KnowledgeGraph.explore_neighbors(graph_driver, node_id, hops=hops, relation_types=relation_types)
    return _format_subgraph(result)

@tool
def find_path_between_nodes(from_node_id: str, to_node_id: str, max_hops: int = 6) -> str:
    """
    Finds the shortest connection path between two KNOWN nodes in the graph, through
    any relationships. Use this to understand how two known entities relate to each
    other, e.g. how a specific error connects to a specific procedure.

    :param from_node_id: Starting node (must exist)
    :param to_node_id: Target node (must exist)
    :param max_hops: Maximum path length to consider (default 6)
    :return: the path as an alternating sequence of nodes and relationships, or a
        message saying no connection was found
    """

    if graph_driver is None:
        return "BŁĄD: Baza danych nie została zainicjalizowana."

    path = KnowledgeGraph.find_shortest_path(graph_driver, from_node_id, to_node_id, max_hops=max_hops)
    return _format_path(path)

graph_driver: Driver | None = None
knowledge_graph: KnowledgeGraph | None = None
embed_model: EmbedModel | None = None

KNOWLEDGE_GRAPH_TOOLS = [
    # Klasy
    define_class,
    add_class_parameters,
    read_classes,

    # Embeddingi (vector search)
    add_embedding_parameters,
    remove_embeddings_parameters,
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
PROMPTS_DIR = PROJECT_ROOT / "system"

def build_graph_with_ollama(model: str, documents: str, system: str | None = None):
    if knowledge_graph is None:
        raise RuntimeError("Wywołaj 'initialize_knowledge_graph()' przed 'build_graph_with_ollama'")

    knowledge_graph.clear()

    if system is None:
        system = (PROMPTS_DIR / "prompt_4_90826.md").read_text(encoding="utf-8")

    llm = ChatModel(model=model,
                    system=system,
                    tools=KNOWLEDGE_GRAPH_TOOLS)

    llm.pretty(documents, max_tool_iterations=1024, think=False)

def initialize_graph_driver():
    global graph_driver

    graph_driver = GraphDatabase.driver(GRAPH_DB_URL, auth=("neo4j", GRAPH_DB_PASSWORD))

    # Jeżeli nie wywali błąd, to znaczy, że działa
    try:
        graph_driver.verify_connectivity()
        print("OK: Połączenie z neo4j działa")

    except ServiceUnavailable as e:
        raise RuntimeError(f"Nie można połączyć się z bazą pod {GRAPH_DB_URL}: {e}") from e

    except AuthError as e:
        raise RuntimeError(f"Błędne dane logowania do neo4j (sprawdź GRAPH_DB_PASSWORD): {e}") from e

    except Exception as e:
        raise RuntimeError(f"Nieoczekiwany błąd połączenia z neo4j: {type(e).__name__}: {e}") from e

    # sprawdza, czy w bazie zainstalowane jest APOC
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

def initialize_embed_model():
    """Tworzy globalną instancję modelu embedding, używaną przez narzędzia wyszukiwania."""
    global embed_model
    embed_model = EmbedModel(EMBED_MODEL)

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

def print_graph(kg: KnowledgeGraph | None = None) -> None:
    """
    szybki podgląd całego grafu w konsoli — klasy, relacje, etykiety, węzły
    (z parametrami, relacjami i etykietami każdego z nich) — bez potrzeby Neo4j,
    czyta bezpośrednio z bufora w pamięci.
    """

    kg = kg or knowledge_graph
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
    if not results:
        return "Nie znaleziono żadnych pasujących węzłów."

    lines = []
    for r in results:
        props = ', '.join(f"{k}={v!r}" for k, v in r["properties"].items() if k not in ("node_id", "klasa"))
        lines.append(f" - {r['node_id']} ({r['klasa']}, score={r['score']:.3f}): {props}")
    return '\n'.join(lines)

def _format_subgraph(result: dict[str, Any]) -> str:
    if not result["nodes"]:
        return "Nie znaleziono żadnych sąsiadów (sprawdź, czy węzeł istnieje w bazie)."

    node_lines = [f" - {n['node_id']} ({n['klasa']})" for n in result["nodes"]]
    rel_lines = [f" - ({r['from']})-[{r['type']}]->({r['to']}) {r['properties']}" for r in result["relationships"]]

    return (f"Węzły ({len(result['nodes'])}):\n" + '\n'.join(node_lines) +
            f"\n\nRelacje ({len(result['relationships'])}):\n" + ('\n'.join(rel_lines) or " (brak)"))

def _format_path(path: list[dict[str, Any]] | None) -> str:
    if path is None:
        return "Nie znaleziono ścieżki między tymi węzłami (brak połączenia w podanym limicie kroków)."

    parts = []
    for step in path:
        if step["type"] == "node":
            parts.append(f"({step['node_id']}:{step['klasa']})")
        else:
            parts.append(f"-[{step['relation']}]->")
    return ' '.join(parts)

def answer_with_ollama(model: str, question: str, system: str | None = None):
    """
    Uruchamia agenta odpowiadającego na pytania, korzystającego WYŁĄCZNIE z narzędzi
    wyszukiwania (KNOWLEDGE_GRAPH_TRAVERSE_TOOLS) — bez dostępu do zapisu grafu.
    W przeciwieństwie do build_graph_with_ollama NIE wymaga zainicjalizowanego
    knowledge_graph (bufora budującego) — tylko graph_driver i embed_model.
    """

    if graph_driver is None or embed_model is None:
        raise RuntimeError("Wywołaj 'initialize_graph_driver()' i 'initialize_embed_model()' "
                           "przed 'answer_with_ollama'")

    if system is None:
        system = (PROMPTS_DIR / "q_prompt_0_70826.md").read_text(encoding="utf-8")

    llm = ChatModel(model=model,
                    system=system,
                    tools=KNOWLEDGE_GRAPH_TRAVERSE_TOOLS)

    llm.pretty(message=question)

GRAPHS_DIR = PROJECT_ROOT / "database" / "graphs"
GRAPH_FORMAT_VERSION = 1

def _safe_filename_part(text: str) -> str:
    """
    Nazwa modelu zawiera dwukropek ('qwen3.5:9b'), który jest niedozwolony
    w nazwach plików na Windows -- zamieniamy na myślnik.
    """

    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", text.strip())

    return cleaned.strip("-.") or "unknown"

def save_graph(model: str, kg: KnowledgeGraph | None = None, directory: Path | str | None = None,
               with_embeddings: bool = False, embed_model: str | None = None) -> Path:
    """
    Zapisuje graf z pamięci do pliku JSON w 'knowledge/graphs/'. Nazwa pliku zawiera
    datę, godzinę i model, którym graf zbudowano, np.:
        2026-08-08_14-30-12_qwen3.5-9b.json

    :param model: nazwa modelu LLM użytego do budowy grafu (trafia do nazwy pliku i metadanych)
    :param kg: graf do zapisania (domyślnie globalny 'knowledge_graph')
    :param directory: katalog docelowy (domyślnie 'knowledge/graphs/')
    :param with_embeddings: czy zapisać wektory. Domyślnie NIE -- przy bge-m3 to 1024 liczby
        na węzeł, co potrafi rozdąć plik do dziesiątek MB. Embeddingi i tak są przeliczane
        od nowa przy 'sync()', więc do wersjonowania grafu nie są potrzebne.
    :param embed_model: opcjonalna nazwa modelu embeddingów (tylko do metadanych)
    :return: ścieżka zapisanego pliku
    """

    kg = kg or knowledge_graph
    if kg is None:
        raise RuntimeError("Brak grafu do zapisania -- wywołaj 'initialize_knowledge_graph()'")

    directory = Path(directory) if directory else GRAPHS_DIR
    directory.mkdir(parents=True, exist_ok=True)

    now = datetime.now()
    path = directory / f"{now:%Y-%m-%d_%H-%M-%S}_{_safe_filename_part(model)}.json"

    nodes: dict[str, Any] = {}
    embeddings_saved: int = 0

    for node_name, node in kg.nodes.items():
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
        "meta": {
            "format_version": GRAPH_FORMAT_VERSION,
            "zapisano": now.isoformat(timespec="seconds"),
            "model": model,
            "embed_model": embed_model,
            "liczba_klas": len(kg.classes),
            "liczba_relacji": len(kg.relations),
            "liczba_wezlow": len(kg.nodes),
            "liczba_polaczen": sum(len(edges) for node in kg.nodes.values() for edges in node.n_relations.values()),
            "embeddings_zapisane": embeddings_saved if with_embeddings else None,
        },
        "klasy": {name: schema.model_dump() for name, schema in kg.classes.items()},
        "relacje": {name: schema.model_dump() for name, schema in kg.relations.items()},
        "etykiety": sorted(kg.labels),
        "wezly": nodes,
    }

    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    return path

def load_graph(path: Path | str, set_global: bool = True) -> KnowledgeGraph:
    """
    Wczytuje graf zapisany przez 'save_graph'. Domyślnie podstawia go pod globalny
    'knowledge_graph', żeby narzędzia i 'sync()' od razu na nim działały.

    :param path: ścieżka do pliku JSON
    :param set_global: czy podstawić wczytany graf jako globalny bufor
    :return: wczytany graf
    """

    global knowledge_graph

    data = json.loads(Path(path).read_text(encoding="utf-8"))

    version = data.get("meta", {}).get("format_version")
    if version != GRAPH_FORMAT_VERSION:
        raise ValueError(f"Nieobsługiwana wersja formatu grafu: {version} "
                         f"(oczekiwano {GRAPH_FORMAT_VERSION})")

    kg = KnowledgeGraph()
    kg.classes = {name: GraphClassSchema(**schema) for name, schema in data["klasy"].items()}
    kg.relations = {name: RelationSchema(**schema) for name, schema in data["relacje"].items()}
    kg.labels = set(data["etykiety"])

    for node_name, entry in data["wezly"].items():
        kg.nodes[node_name] = GraphNode(
            c_name=entry["klasa"],
            module=entry.get("modul", ""),
            c_parameters=entry["parametry"],
            n_labels=set(entry.get("etykiety", [])),
            n_relations={
                relation: [RelationEdge(target=e["target"], r_parameters=e["parametry"]) for e in edges]
                for relation, edges in entry.get("relacje", {}).items()
            },
            embeddings=entry.get("embeddings"),
        )

    if set_global:
        knowledge_graph = kg

    return kg