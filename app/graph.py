from dataclasses import dataclass, field
from typing import Any

import json
from langchain_core.tools import tool
from neo4j import Driver, GraphDatabase
from neo4j.exceptions import ServiceUnavailable, AuthError
from pydantic import BaseModel, Field, ValidationError
import re

from app.core import ChatModel, GRAPH_DB_URL, GRAPH_DB_PASSWORD

graph_driver: Driver | None = None
knowledge_graph: KnowledgeGraph | None = None

class GraphClassSchema(BaseModel):
    # Key to nazwa parametru, a value to defaultowy parametr
    # w wypadku gdyby model go nie podał

    parameters: dict[str, Any] = Field(min_length=1)

    def describe(self) -> str:
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

class RelationSchema(BaseModel):
    # Ustandaryzowane właściwości dla danego typu relacji.
    # W przeciwieństwie do GraphClassSchema -- relacja MOŻE nie mieć żadnych
    # właściwości (nie każda relacja musi coś ze sobą nieść, np. 'ZNA').

    parameters: dict[str, Any] = Field(default_factory=dict)

    def describe(self) -> str:
        if not self.parameters:
            return "(brak właściwości)"

        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

@dataclass
class RelationEdge:
    # Pojedyncze, konkretne połączenie do celu -- każdy cel niesie WŁASNE właściwości,
    # niezależne od innych celów tego samego typu relacji.
    target: str
    r_parameters: dict[str, Any] = field(default_factory=dict)

@dataclass
class GraphNode:
    c_name: str
    c_parameters: dict[str, Any] = field(default_factory=dict)
    n_relations: dict[str, list[RelationEdge]] = field(default_factory=dict)

    # Dodatkowe, OPCJONALNE etykiety wybierane swobodnie przez model
    # (niezależne od klasy. Klasa dostaje etykietę AUTOMATYCZNIE, patrz class_label())
    n_labels: set[str] = field(default_factory=set)

class KnowledgeGraph:
    __slots__ = ("nodes", "relations", "classes", "labels")
    IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
    VALID_TYPES = (str, int, float, bool)
    VALID_NAMES = ('str', 'int', 'float', 'bool',
                   'list[str]', 'list[int]', 'list[float]', 'list[bool]')

    # Nazwy zarezerwowane systemowo.
    # nigdy nie mogą być nazwą parametru/klasy/relacji/etykiety
    RESERVED_PARAMETER_NAMES = ('node_id', 'klasa')

    # Prefiks zarezerwowany dla AUTOMATYCZNYCH etykiet klas (class_label()) -
    # model nie może zarejestrować własnej etykiety zaczynającej się tak samo,
    # żeby uniknąć kolizji z etykietami systemowymi.
    CLASS_LABEL_PREFIX = "C_"

    # Etykieta WSPÓLNA dla KAŻDEGO węzła w grafie, niezależnie od klasy.
    # Bez tego nie da się zbudować JEDNEGO indeksu wektorowego obejmującego cały graf --
    # C_Procedura i C_Dokument to różne etykiety, więc same z siebie nie dają wspólnego zasięgu.
    SHARED_LABEL = "SHARED"

    def __init__(self):
        self.nodes: dict[str, GraphNode] = {}
        self.classes: dict[str, GraphClassSchema] = {}
        self.relations: dict[str, RelationSchema] = {}
        self.labels: set[str] = set()  # zbiór ZAREJESTROWANYCH, dozwolonych dodatkowych etykiet

    # ------------------------------------------------------------------
    # KLASY
    # ------------------------------------------------------------------

    def define_class(self, class_name: str, parameters: dict[str, Any]) -> str:
        """
        Definiujemy klasy, tak, żeby każdy node miał tą samą klase z tymi samymi parametrami

        :param class_name:
        :param parameters:
        :return:
        """

        if class_name in self.classes:
            return (f"BŁĄD: Klasa '{class_name}' już istnieje: {self.read_class(class_name)}."
                    f"Aby sprawdzić wszystkie dostępne klasy użyj komendy: 'read_classes'")

        if mess := self._validate_name(class_name):
            return mess

        if mess := self._validate_initialize_parameters_type(parameters):
            return mess

        try:
            new_class = GraphClassSchema(parameters=parameters)
        except ValidationError as e:
            return f"BŁĄD: Nie udało się dodać klasy: '{class_name}'.: {e}"

        self.classes[class_name] = new_class
        return (f"OK: Zdefiniowano klasę: {self.read_class(class_name)}. "
                f"Możesz ją od teraz przypisywać do node. "
                f"Każdy taki node dostanie automatycznie etykietę '{self.class_label(class_name)}'.")

    def add_class_parameters(self, class_name: str, parameters: dict[str, Any]) -> str:
        """
        Dodajemy parametr do klasy.
        Key to nazwa
        Value to wartość domyślna i typ

        :param class_name: nazwa klasy
        :param parameters: parametry, które chcemy dodać
        :return:
        """

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
        """
        Przed każdą próbą dodania klasy do noda sprawdzamy, czy obecne parametry
        zgadzają się z podawaną klasą

        :param class_name: nazwa klasy, względem której sprawdzamy parametry
        :param parameters: parametry, które będziemy sprwadzać
        :return:
        """

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
        """
        Czytamy wszystkie klasy, ich typy i wartości domyślne

        :return:
        """

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

    def merge(self, node_name: str, class_name: str, parameters: dict[str, Any]) -> str:
        """
        Tworzymy nowy node

        :param node_name: nazwa nowego node
        :param class_name: klasa noda
        :param parameters: parametry klasy noda
        :return:
        """

        if mess := self._validate_name(class_name):
            return mess

        error_messages: list[str] = []
        node_already_exists: bool = node_name in self.nodes.keys()

        if node_already_exists:
            error_messages.append(f"ERROR: Node '{node_name}' już istnieje! Aby sprawdzić wszystkie istniejące nody, użyj 'read_node_names'")

        parameters, message = self._validate_parameters(class_name=class_name, parameters=parameters)
        error_messages.append(message)

        if node_already_exists or parameters is None:
            return '\n'.join(error_messages)

        self.nodes[node_name] = GraphNode(c_name=class_name, c_parameters=parameters)

        return (f"OK: Pomyślnie utworzono node '{node_name}' "
                f"(etykiety: '{self.SHARED_LABEL}', '{self.class_label(class_name)}')."
                f"Aby zobaczyć wszystkie utworzone node użyj 'read_node_names'.\n"
                f"{'\n'.join(error_messages)}")

    def edit_node_parameters(self, node_name: str, parameters: dict[str, Any]) -> str:
        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        error_messages: list[str] = []
        class_keys: set[str] = set(self.classes[node_in_question.c_name].parameters.keys())
        given_parameters: set[str] = set(parameters.keys())

        # Sprawdzamy nadprogramowe parametry ale nie względem node, ponieważ jeżeli w takcie trwania programu
        # dodano nowe parametry do klasy, nie pojawią się one w nodzie, dlatego gdybyśmy sprawdzali względem node
        # otrzymalibyśmy błąd
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

        node_in_question.c_parameters = {**node_in_question.c_parameters, **parameters}
        return f"OK: Parametry node '{node_name}' zostały pomyślnie zaktualizowane."

    def read_node_parameters(self, node_name: str, internal: bool = False) -> str:
        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        node_class = self.classes.get(node_in_question.c_name)
        if node_class is None:
            return self.err_mess_class_doesnt_exist(node_in_question.c_name)

        merged_parameters = node_class.parameters | node_in_question.c_parameters
        node_info = (f"{node_name}: (klasa={node_in_question.c_name}), "
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
        """
        Wylicza systemową etykietę klasy w locie. NIE przechowujemy jej nigdzie osobno,
        żeby nie ryzykować rozjazdu (dwóch źródeł prawdy o tym samym). Zawsze wynika
        bezpośrednio z GraphNode.c_name.
        """

        return f"{self.CLASS_LABEL_PREFIX}{class_name}"

    # ------------------------------------------------------------------
    # RELACJE
    # ------------------------------------------------------------------

    def define_relation(self, relation: str, parameters: dict[str, Any] | None = None) -> str:
        """
        Dodajemy relację do dostępnych relacji, opcjonalnie z ustandaryzowanymi właściwościami.

        :param relation: relacja, którą chcemy dodać
        :param parameters: opcjonalne właściwości relacji {nazwa: wartość_domyślna}.
            Jeżeli pominięte -- ta relacja nie niesie żadnych właściwości.
        :return:
        """

        relation = relation.upper()

        if relation in self.relations:
            return (f"ERROR: Ta relacja: '{relation}' już istnieje. "
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
        """
        Dodajemy nowe ustandaryzowane właściwości do istniejącego typu relacji.
        Analogiczne do 'add_class_parameters', tylko dla relacji.

        :param relation: nazwa relacji (zostanie znormalizowana na wielkie litery)
        :param parameters: nowe właściwości do dodania {nazwa: wartość_domyślna}
        :return:
        """

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
        """
        Sprawdzamy, czy podane właściwości relacji zgadzają się z jej ustandaryzowanym schematem.
        Analogiczne do '_validate_parameters', tylko dla relacji.

        :param relation: znormalizowana (wielkimi literami) nazwa relacji
        :param parameters: właściwości, które będziemy sprawdzać
        :return:
        """

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
        """
        Łączy from_node z każdym z to_nodes relacją typu 'relation', opcjonalnie
        niosącą właściwości (muszą zgadzać się ze schematem zdefiniowanym w 'define_relation').

        :param from_node: node źródłowy
        :param to_nodes: lista nodów docelowych
        :param relation: typ relacji (zostanie znormalizowany na wielkie litery)
        :param parameters: właściwości TEJ relacji -- każdy cel w to_nodes dostanie te same właściwości
        :return:
        """

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
        """
        Wypisuje relacje danego noda.
        Jeżeli podamy relation, wypisuje tylko tą relacje i obiekty dla tego noda
        Jeżeli nie podamy relacji, wypisujęmy wszystkie relacje i obiekty dla tego noda

        :param node_name: nazwa, interesującego nas noda
        :param relation: relacja, którą chcemy sprawdzić
        :return:
        """

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
    # ETYKIETY (dodatkowe, opcjonalne tagi wybierane przez model)
    # ------------------------------------------------------------------

    def define_label(self, label: str) -> str:
        """
        Rejestrujemy nową, dozwoloną etykietę -- osobną od klasy noda.
        Etykiety NIE mają własnych właściwości (tylko nazwa/tag),
        w przeciwieństwie do klas i relacji.

        :param label: etykieta, którą chcemy zarejestrować
        :return:
        """

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
        """
        Przypisujemy zarejestrowaną etykietę do konkretnego node.

        :param node_name: node, do którego dodajemy etykietę
        :param label: etykieta (musi być wcześniej zarejestrowana przez 'define_label')
        :return:
        """

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
        """
        Zwraca WSZYSTKIE etykiety node -- zarówno automatyczną etykietę klasy (C_...),
        jak i dodatkowe etykiety ręcznie przypisane przez model.
        """

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
    # WALIDACJA WSPÓLNA (używana zarówno przez klasy, jak i relacje)
    # ------------------------------------------------------------------

    def _validate_name(self, name: str) -> str:
        if not self.IDENTIFIER_PATTERN.match(name):
            return (f"BŁĄD: Nieprawidłowa nazwa '{name}'!\n"
                    f"Wymagania:\n"
                    f" - Nazwa musi zaczynać się od litery (A-Z lub a-z)\n"
                    f" - Może zawierać tylko litery, cyfry oraz znak podkreślenia (_)\n"
                    f" - Długość może wynosić od 1 do 64 znaków włącznie\n"
                    f" - Polskie znaki (np. ą, ś, ż) nie są dozwolone!")

        # Sprawdzamy zarezerwowane nazwy niezależnie od wielkości liter --
        # dotyczy to nazw klas, relacji i etykiet (nie tylko parametrów)
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
        """
        Sprawdzamy, czy typy się zgadzają
        Tylko gdy inicjalizujemy jakieś wartości np. dodajemmy do klasy/relacji

        :param parameters:
        :return:
        """

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
            error_messages.append((f"BŁAD: Nazwy {reserved_used} są zarezerwowane systemowo "
                                   f"i nie mogą być nazwą parametru!"))

        if error_messages:
            error_messages.append((f"Dozwolone typy parametrów to: {', '.join(self.VALID_NAMES)}.\n"
                                  f"Sprawdź poprawność przekazanych parametrów i spróbuj ponownie."))
            return '\n'.join(error_messages)
        return ''

    def __validate_parameter_excessive_amount(self, entity_name: str, entity_keys: set[str], given_parameters: set[str]) -> str:
        """
        Wspólna walidacja nadmiarowych parametrów -- używana zarówno dla klas, jak i relacji
        (stąd 'entity_name'/'entity_keys', nie 'class_name'/'class_keys').
        """

        excessive_params = given_parameters - entity_keys
        if excessive_params:
            return (f"BŁĄD: Podano zbyt dużo parametrów dla: '{entity_name}'."
                    f"Nadmiarowe parametry to: {excessive_params}."
                    f"Aby dodać nowe parametry do istniejącej klasy użyj 'add_class_parameters', "
                    f"a dla relacji 'add_relation_parameters'")
        return ''

    def __validate_parameter_types(self, shared_parameters: set[str], entity_parameters: dict[str, Any], parameters: dict[str, Any]) -> str:
        """
        Sprawdzamy, czy typy podanych wartości są zgodne z przyjmowanymi.
        Wspólne dla klas i relacji.

        :param shared_parameters: parametry, które występują w obu grupach
        :param entity_parameters: parametry klasy/relacji (wzorzec)
        :param parameters: parametry, które porównujemy
        :return:
        """

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
    # SYNCHRONIZACJA Z NEO4J
    # ------------------------------------------------------------------

    def ensure_constraints(self, driver, database: str = "neo4j") -> None:
        """
        JEDEN constraint unikalności node_id, na wspólnej etykiecie ENTITY_LABEL --
        skoro KAŻDY node ją nosi, jeden constraint wystarczy dla całego grafu
        (nie musimy tworzyć osobnego per klasa).
        """

        driver.execute_query(
            f"CREATE CONSTRAINT unique_node_id_{self.SHARED_LABEL} IF NOT EXISTS "
            f"FOR (n:{self.SHARED_LABEL}) REQUIRE n.node_id IS UNIQUE",
            database_=database,
        )

    def _prepare_nodes(self) -> list[dict[str, Any]]:
        """
        Przygotowuje węzły do zapisu -- tu MATERIALIZUJEMY to, co wcześniej było
        tylko wyliczane w locie: pełny zestaw etykiet (wspólna + klasy + dodatkowe)
        i właściwość 'klasa' (dotąd tylko c_name w Pythonie).
        """

        rows: list[dict[str, Any]] = []

        for node_name, node in self.nodes.items():
            labels = [self.SHARED_LABEL, self.class_label(node.c_name), *sorted(node.n_labels)]
            properties = {**node.c_parameters, "node_id": node_name, "klasa": node.c_name}

            rows.append({"node_id": node_name, "labels": labels, "properties": properties})

        return rows

    def _relation_rows(self) -> list[dict[str, Any]]:
        """Spłaszcza n_relations (dict[str, list[RelationEdge]]) do płaskiej listy wierszy."""

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

    def sync(self, driver, database: str = "neo4j", batch_size: int = 500) -> dict[str, int]:
        """
        Zapisuje CAŁY graf (węzły + relacje) do Neo4j. Idempotentne -- bezpieczne
        do wielokrotnego wywołania na tym samym stanie grafu.

        :param driver: połączenie neo4j.GraphDatabase.driver(...)
        :param database: nazwa bazy
        :param batch_size: ile wierszy na jeden UNWIND -- duże grafy dzielimy na partie,
            żeby nie przeciążyć pojedynczej transakcji
        :return: {"nodes": ile zapisano, "relations": ile zapisano}
        """

        self.ensure_constraints(driver, database)

        node_rows = self._prepare_nodes()
        relation_rows = self._relation_rows()

        written_nodes, written_relations = 0, 0

        with driver.session(database=database) as session:
            # Węzły MUSZĄ trafić do bazy PRZED relacjami -- inaczej MATCH w zapisie
            # relacji nie znajdzie jeszcze nieistniejącego węzła i relacja zniknie po cichu.
            for i in range(0, len(node_rows), batch_size):
                chunk = node_rows[i:i + batch_size]
                written_nodes += session.execute_write(self.__write_node_batch, chunk)

            for i in range(0, len(relation_rows), batch_size):
                chunk = relation_rows[i:i + batch_size]
                written_relations += session.execute_write(self.__write_relation_batch, chunk, self.SHARED_LABEL)

        return {"nodes": written_nodes, "relations": written_relations}

    @staticmethod
    def __write_node_batch(tx, rows: list[dict[str, Any]]) -> int:
        """apoc.merge.node przyjmuje ETYKIETY jako parametr (lista) -- nie da się tego czystym Cypherem."""

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
        """
        apoc.merge.relationship przyjmuje TYP relacji jako parametr.
        Wyszukujemy węzły po SHARED_LABEL (wspólnej dla wszystkich) -- ta etykieta ma
        indeks z ensure_constraints(), więc MATCH jest szybki niezależnie od klasy węzła.
        """

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

@tool
def define_class(class_name: str, parameters: dict[str, Any] | str) -> str:
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
    :return: confirmation message, or an explanation of what went wrong
    """

    params, error = _llm_passed_invalid_parameters(parameters)

    if error:
        return error

    return knowledge_graph.define_class(class_name, params)

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
def merge(node_name: str, class_name: str, parameters: dict[str, Any] | str) -> str:
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
    :param parameters: Dict of {parameter_name: value} matching the class's schema.
        Check the class's expected parameters with 'read_classes' first if unsure.
    :return: confirmation message, or an explanation of what went wrong (e.g. missing
        required parameters, wrong value types, or a node with this name already exists)
    """

    params, error = _llm_passed_invalid_parameters(parameters)

    if error:
        return error

    return knowledge_graph.merge(node_name, class_name, params)

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

    :param relation: Name of the relation type, e.g. "WYMAGA", "DOTYCZY", "NALEZY_DO"
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
def relationship(from_node: str, to_nodes: list[str], relation: str,
                 parameters: dict[str, Any] | str | None = None) -> str:
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

KNOWLEDGE_GRAPH_TOOLS = [
    # Klasy
    define_class,
    add_class_parameters,
    read_classes,

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
    read_node_labels,
]

def build_graph_with_ollama(model: str, system: str, documents: str):
    knowledge_graph.clear()

    llm = ChatModel(model=model,
                    system=system,
                    tools=KNOWLEDGE_GRAPH_TOOLS)

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