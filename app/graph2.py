from dataclasses import dataclass, field
from typing import Any

from neo4j import Driver, GraphDatabase
from neo4j.exceptions import ServiceUnavailable, AuthError
from pydantic import BaseModel, Field, ValidationError
import re

from app.core import GRAPH_DB_URL, GRAPH_DB_PASSWORD, ChatModel

graph_driver: Driver | None = None
knowledge_graph: KnowledgeGraph | None = None

class GraphClassSchema(BaseModel):
    # Key to nazwa parametru, a value to defaultowy parametr
    # w wypadku gdyby model go nie podał

    parameters: dict[str, Any] = Field(min_length=1)

    def describe(self) -> str:
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

@dataclass
class GraphNode:
    c_name: str
    c_parameters: dict[str, Any] = field(default_factory=dict)
    n_relations: dict[str, list[str]] = field(default_factory=dict)

class KnowledgeGraph:
    __slots__ = ("nodes", "relations", "classes")
    IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
    VALID_TYPES = (str, int, float, bool)
    VALID_NAMES = ('str', 'int', 'float', 'bool',
                   'list[str]', 'list[int]', 'list[float]', 'list[bool]')

    def __init__(self):
        self.nodes: dict[str, GraphNode] = { }
        self.classes: dict[str, GraphClassSchema] = { }
        self.relations: list[str] = []

    def define_relation(self, relation: str) -> str:
        """
        Dodajemy relację do dostępnych relacji

        :param relation: relacja, którą chcemy dodać
        :return:
        """

        relation = relation.upper()

        if relation in self.relations:
            return (f"ERROR: Ta relacja: '{relation}' już istnieje. "
                    f"Nie można jej dodać drugi raz."
                    f"Aby sprawdzić wszystkie dostępne relacje użyj 'read_relationships'")

        # Sprawdzamy czy nazwa może być
        if mess := self._validate_name(relation):
            return mess

        self.relations.append(relation)
        return (f"INFO: Zamieniono znaki relacji na wielkie.\n"
                f"OK: Dodano relację '{relation}' do zbioru dostępnych relacji."
                f"Aby sprawdzić wszystkie dostępne relacje użyj 'read_relationships'")

    def define_class(self, class_name: str, parameters: dict[str, Any]) -> str:
        """
        Definiujemy klasy, tak, żeby każdy node miał tą samą klase z tymi samymi parametrami

        :param class_name:
        :param parameters:
        :return:
        """

        # Sprawdzamy, czy klasa już istnieje
        if class_name in self.classes:
            return (f"BŁĄD: Klasa '{class_name}' już istnieje: {self.read_class(class_name)}."
                    f"Aby sprawdzić wszystkie dostępne klasy użyj komendy: 'read_classes'")

        # Sprawdzamy czy nazwa może być
        if mess := self._validate_name(class_name):
            return mess

        # Sprawdzamy czy typ się zgadza
        if mess := self._validate_initialize_parameters_type(parameters):
            return mess

        try:
            new_class = GraphClassSchema(parameters=parameters)

        except ValidationError as e:
            return f"BŁĄD: Nie udało się dodać klasy: '{class_name}'.: {e}"

        # Zapisujemy klase i informujemy o powodzeniu
        self.classes[class_name] = new_class
        return f"OK: Zdefiniowano klasę: {self.read_class(class_name)}. Możesz ją od teraz przypisywać do node"

    def _validate_parameters(self, class_name: str, parameters: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        """
        Przed każdą próbą dodania klasy do noda sprawdzamy, czy obecne parametry
        zgadzają się z podawaną klasą

        :param class_name: nazwa klasy, względem której sprawdzamy parametry
        :param parameters: parametry, które będziemy sprwadzać
        :return:
        """

        class_in_question = self.classes.get(class_name, None)

        # Sprawdzamy, czy klasa została zdefiniowana
        if class_in_question is None:
            return None, self.err_mess_class_doesnt_exist(class_name)

        error: bool = False
        error_messages: list[str] = []
        class_keys = set(class_in_question.parameters.keys())
        given_params = set(parameters.keys())

        # Sprawdzamy, czy jakichś parametrów brakuje
        missing_params = class_keys - given_params

        if missing_params:
            error_messages.append((f"INFO: Nie podano wartości dla parametrów: {missing_params}."
                                   f"W ich miejsce wstawiam defaultowe wartości dla klasy: {self.read_class(class_name)}."
                                   f"Jeżeli chcesz zmienić parametry instancji klasy dla node użyj 'edit_node_parameters'"))

            # Dodajemy brakujące parametry
            parameters = {**class_in_question.parameters, **parameters}

        # Sprawdzamy nadprogramowe parametry
        exc_mess = self.__validate_parameter_excessive_amount(class_name=class_name,
                                                              class_keys=class_keys,
                                                              given_parameters=given_params)
        if exc_mess:
            error_messages.append(exc_mess)
            error = True

        # Sprawdzamy, czy użyto tych samych typów parametrów
        type_mess = self.__validate_parameter_class_types(shared_parameters=class_keys & given_params,
                                                          class_parameters=class_in_question.parameters,
                                                          parameters=parameters)
        if type_mess:
            error_messages.append(type_mess)
            error = True

        return None if error else parameters, '\n'.join(error_messages)

    def __validate_parameter_excessive_amount(self, class_name: str, class_keys:set[str], given_parameters: set[str]) -> str:
        excessive_params = given_parameters - class_keys

        if excessive_params:
            return (f"BŁĄD: Podano zbyt dużo parametrów dla klasy: '{class_keys}'."
                    f"Nadmiarowe parametry to: {excessive_params}."
                    f"Aktualnie parametry klasy to: {self.read_class(class_name)}."
                    f"Aby dodać nowe parametry do istniejącej klasy użyj 'add_class_parameters'")

        return ''

    def __validate_parameter_class_types(self, shared_parameters: set[str], class_parameters: dict[str, Any], parameters: dict[str, Any]) -> str:
        """
        Sprawdzamy, czy typy podanych wartości są zgodne z przyjmowanymi

        :param shared_parameters: parametry, które występują w obu grupach
        :param class_parameters: parametry klasy
        :param parameters: parametry, które porównujemy
        :return:
        """

        different_parameter_type: dict[str, tuple[str, str]] = { }

        for key in shared_parameters:
            should_be_parameter_type = self.__deep_type(class_parameters[key])
            new_parameter_type = self.__deep_type(parameters[key])

            if should_be_parameter_type != new_parameter_type:
                different_parameter_type[key] = (should_be_parameter_type, new_parameter_type)

        if different_parameter_type:
            return (f"BŁĄD: Typu parametrów różnią się od typów klasy: "
                    f"{[f"'{k}': oczekiwany: {v[0]}, otrzymany: {v[1]}" for k, v in different_parameter_type.items()]}")

        return ''

    def edit_node_parameters(self, node_name:str, parameters: dict[str, Any]) -> str:
        node_in_question = self.nodes.get(node_name, None)

        # Sprawdzamy, czy klasa została zdefiniowana
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        error_messages: list[str] = []
        class_keys: set[str] = set(self.classes[node_in_question.c_name].parameters.keys())
        given_parameters: set[str] = set(parameters.keys())

        # Sprawdzamy nadprogramowe parametry ale nie względem node, ponieważ jeżeli w takcie trwania programu
        # dodano nowe parametry do klasy, nie pojawią się one w nodzie, dlatego gdybyśmy sprawdzali względem node
        # otrzymalibyśmy błąd
        if exc_mess := self.__validate_parameter_excessive_amount(class_name=node_in_question.c_name,
                                                                  class_keys=class_keys,
                                                                  given_parameters=given_parameters):
            error_messages.append(exc_mess)

        # Sprawdzamy, czy nie podajemy złych typów
        if type_mess := self.__validate_parameter_class_types(shared_parameters=class_keys & given_parameters,
                                                              class_parameters=self.classes[node_in_question.c_name].parameters,
                                                              parameters=parameters):
            error_messages.append(type_mess)

        if error_messages:
            return (f"BŁĄD: Nie udało się edytować parametrów node '{node_name}'."
                    f"Wyeliminuj poniższe błędy i spróbuj ponownie:\n{'\n'.join(error_messages)}")

        node_in_question.c_parameters = {**node_in_question.c_parameters, **parameters}

        return f"OK: Parametry node '{node_name}' zostały pomyślnie zaktualizowane."

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

        # Sprawdzamy, czy klasa została zdefiniowana
        if class_in_question is None:
            return self.err_mess_class_doesnt_exist(class_name)

        class_keys: set[str] = set(class_in_question.parameters.keys())
        given_parameters: set[str] = set(parameters.keys())

        # Sprawdzamy czy nie ma duplikatów, ponieważ nie chcemy dodać duplikatów parametrów
        shared_parameters: set[str] = class_keys & given_parameters

        info_message: str = ''
        if shared_parameters:
            info_message = (f"INFO: Klasa '{class_name}' już posiada parametry: {', '.join(shared_parameters)}.\n"
                            f"Pominięto dodanie zduplikowanych parametrów.")

        # Dodajemy parametry do klasy
        new_parameters = {k: v for k, v in parameters.items() if k not in shared_parameters}

        # Walidujemy nazwy i typy parametrów
        if mess_type := self._validate_initialize_parameters_type(new_parameters):
            return mess_type

        class_in_question.parameters |= new_parameters

        return f"{info_message}\nOK: Dodano parametry do klasy '{class_name}'. Aktualne parametry to: {self.read_class(class_name)}"

    def merge(self, node_name: str, class_name: str, parameters: dict[str, Any]) -> str:
        """
        Tworzymy nowy node

        :param node_name: nazwa nowego node
        :param class_name: klasa noda
        :param parameters: parametry klasy noda
        :return:
        """

        # Sprawdzamy, czy nazwa może być
        if mess := self._validate_name(class_name):
            return mess

        error_messages: list[str] = []
        node_already_exists: bool = node_name in self.nodes.keys()

        # Sprawdzamy, czy node istnieje, jeżeli tak, to błąd
        if node_already_exists:
            error_messages.append(f"ERROR: Node '{node_name}' już istnieje! Aby sprawdzić wszystkie istniejące nody, użyj 'read_node_names'")

        # Walidujemy klasę czy wszystko się zgadza
        parameters, message = self._validate_parameters(class_name=class_name, parameters=parameters)
        error_messages.append(message)

        # Jeżeli otrzymaliśmy błąd z validate to parameters jest None,
        # jeżeli jest none i mamy error messages to zwracamy
        if node_already_exists or parameters is None:
            return '\n'.join(error_messages)

        self.nodes[node_name] = GraphNode(c_name=class_name, c_parameters=parameters)

        return (f"OK: Pomyślnie utworzono node '{node_name}'."
                f"Aby zobaczyć wszystkie utworzone node użyj 'read_node_names'.\n"
                f"{'\n'.join(error_messages)}")

    def relationship(self, from_node: str, to_nodes: list[str], relation: str) -> str:
        relation = relation.upper()

        set_to_nodes: set[str] = set(to_nodes)

        error_messages: list[str] = []
        n_error: bool=False

        # Sprawdzamy, czy taka relacja w ogóle istnieje
        if relation not in self.relations:
            error_messages.append(self.err_mess_relation_doesnt_exist(relation))

        node_in_question = self.nodes.get(from_node, None)
        # Sprawdzamy, czy nody istnieją
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

        current_related_nodes: set[str] = set()
        if relation not in node_in_question.n_relations:
            node_in_question.n_relations[relation] = []

        else:
            current_related_nodes = set(node_in_question.n_relations[relation])

        for node in set_to_nodes:
            if node in current_related_nodes:
                error_messages.append(f"INFO: node '{from_node}' już był połączony z '{node}' relacją '{relation}'. ({from_node}-[{relation}]->{node})")
                continue

            node_in_question.n_relations[relation].append(node)
            error_messages.append(f"OK: node '{from_node}' został połączony z '{node}' relacją '{relation}'. ({from_node}-[{relation}]->{node})")

        return '\n'.join(error_messages) + "\nAby zobaczyć wszystkie połaczenia z danego node użyj 'read_node_relations'"

    def read_relationships(self, internal:bool=False) -> str:
        if self.relations:
            relations = '\n'.join([f" - {relation}" for relation in self.relations])

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
                    f"Aby dodać relację użyj 'relationships'")

        # Jeżeli nie podano relacji wypisujem wszystkie relacje
        if relation is None:
            relations = [f" - '{k}' -> ({', '.join(v)})" for k,v in node_in_question.n_relations.items()]
            return f"OK: Aktualnie, wszystkie relacje node '{node_name}' to:\n{'\n'.join(relations)}"

        # Jeżeli podano wypisujemy tylko jedną (wcześniej ją normalizując)
        relation = relation.upper()
        if node_in_question.n_relations.get(relation, None) is None:
            return (f"BŁĄD: Node '{node_name}' nie posiada relacji '{relation}'."
                    f"Upewnij się, czy na pewno wpisałeś poprawnie lub użyj"
                    f"'read_node_relation' nie podając parametru relation, aby zobaczyć"
                    f"wszystkie relacje danego node")

        return f"OK: Relacja '{relation}' dla node '{node_name}' to:\n - {relation} -> ({', '.join(node_in_question.n_relations[relation])})"

    def read_class(self, name) -> str:
        return f"{name}: {{ {self.classes[name].describe()} }}"

    def read_classes(self, internal:bool=False) -> str:
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

    def read_node_parameters(self, node_name:str, internal:bool=False) -> str:
        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        # Pobieramy klasę do której należy node
        node_class = self.classes.get(node_in_question.c_name)
        if node_class is None:
            return self.err_mess_class_doesnt_exist(node_in_question.c_name)

        # 2. Łączymy domyślne parametry klasy z parametrami węzła
        merged_parameters = node_class.parameters | node_in_question.c_parameters

        node_info = f"{node_name}: (klasa={node_in_question.c_name}), {{ {', '.join([f"'{k}': {type(v).__name__} = {v}" for k, v in merged_parameters.items()])} }}"

        if internal:
            return node_info

        return f"INFO: Parametry node {node_info}"

    def read_node_names(self, internal:bool=False) -> str:
        if self.nodes:
            nodes = '\n'.join([f" - {node_name}" for node_name in self.nodes.keys()])

            if internal:
                return nodes

            return f"INFO: Dostępne nody:\n{nodes}"
        return "BŁĄD: Nie dodano jeszcze żadnego noda! Aby dodać node skożystaj z 'merge'"

    def err_mess_class_doesnt_exist(self, class_name: str, helper: bool=True) -> str:
        mess: str = f"BŁĄD: Klasa '{class_name}' nie jest zdefiniowana."

        if helper:
            return mess + (f"\nDostępne klasy:\n{self.read_classes(internal=True)}\n"
                           f"Aby zdefiniować klasę użyj: 'define_class'")
        return mess

    def err_mess_node_doesnt_exist(self, node_name: str, helper:bool=True) -> str:
        mess: str = f"BŁĄD: Node '{node_name}' nie istnieje."

        if helper:
            return mess + (f"\nDostępne nody:\n{self.read_node_names(internal=True)}\n"
                           f"Aby stworzyć node użyj: 'merge'")
        return mess

    def err_mess_relation_doesnt_exist(self, relation_name: str, helper:bool=True) -> str:
        mess: str = f"BŁĄD: Relacja '{relation_name}' nie istnieje."

        if helper:
            return mess + (f"\nDostępne relacje:\n{self.read_relationships(internal=True)}\n"
                           f"Aby stworzyć relację użyj: 'define_relation'")
        return mess

    def _validate_name(self, name: str) -> str:
        if not self.IDENTIFIER_PATTERN.match(name):
            return (f"BŁĄD: Nieprawidłowa nazwa '{name}'!\n"
                    f"Wymagania:\n"
                    f" - Nazwa musi zaczynać się od litery (A-Z lub a-z)\n"
                    f" - Może zawierać tylko litery, cyfry oraz znak podkreślenia (_)\n"
                    f" - Długość może wynosić od 1 do 64 znaków włącznie\n"
                    f" - Polskie znaki (np. ą, ś, ż) nie są dozwolone!")

        return ''

    @staticmethod
    def __deep_type(parameter: Any) -> str:
        """
        Sprawdzamy typ, nawet zagnieżdzonych struktur

        :param parameter:
        :return:
        """

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
        Tylko gdy inicjalizujemy jakieś wartości np. dodajemmy do klasy

        :param parameters:
        :return:
        """

        error_messages: list[str] = []

        for name, value in parameters.items():
            if isinstance(value, self.VALID_TYPES):
               continue

            if isinstance(value, list):

                # Pusta lista nie jest ok
                if len(value) > 0:

                    # Wszystkie parametry muszą być tego samego typu
                    base_type = type(value[0])
                    if all(type(item) is base_type and isinstance(item, self.VALID_TYPES) for item in value):
                        continue

            error_messages.append(f"BŁĄD: Parametr '{name}' używa niedozwolonego typu wartości: {self.__deep_type(value)}!")

        if 'node_id' in parameters.keys():
            error_messages.append((f"BŁAD: Nieprawidłowa nazwa 'node_id'!\n"
                                   f"Nazwa 'node_id' jest zarezerwowaną nazwą systemową "
                                   f"i nie może być nazwą noda, klasy, relacji lub parametru!"))

        if error_messages:
            error_messages.append((f"Dozwolone typy parametrów to: {', '.join(self.VALID_NAMES)}.\n"
                                  f"Sprawdź poprawność przekazanych parametrów i spróbuj ponownie."))

            return '\n'.join(error_messages)
        return ''

    def clear(self):
        self.nodes.clear()
        self.classes.clear()
        self.relations.clear()

    # TODO
    def sync(self, driver: Driver) -> None:
        pass

llm_tools: tuple

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