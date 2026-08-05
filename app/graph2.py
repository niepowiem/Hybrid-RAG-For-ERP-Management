from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field, ValidationError

class GraphClassSchema(BaseModel):
    # Key to nazwa parametru, a value to defaultowy parametr
    # w wypadku gdyby model go nie podał

    parameters: dict[str, Any] = Field(min_length=1)

    def add(self, parameter: str, default: Any) -> bool:
        """
        Dodaje parametr do schematu wraz z jego wartością domyślną.
        Zwraca False, jeśli parametr już istnieje (nic nie zmienia)

        :param parameter:
        :param default:
        :return:
        """

        if parameter in self.parameters:
            return False

        self.parameters[parameter] = default
        return True

    def describe(self) -> str:
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

@dataclass
class GraphNode:
    c_name: str
    c_parameters: dict[str, Any] = field(default_factory=dict)
    n_relations: dict[str, list[str]] = field(default_factory=dict)

class KnowledgeGraph:
    __slots__ = ("nodes", "relations", "classes")

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

        try:
            new_class = GraphClassSchema(parameters=parameters)

        except ValidationError as e:
            return f"BŁĄD: Nie udało się dodać klasy: '{class_name}'.: {e}"

        # Zapisujemy klase i informujemy o powodzeniu
        self.classes[class_name] = new_class
        return f"OK: Zdefiniowano klasę: {self.read_class(class_name)}. Możesz ją od teraz przypisywać do node"

    def _validate_properties(self, class_name: str, parameters: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
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
        type_mess = self.__validate_parameter_types(shared_parameters=class_keys & given_params,
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

    @staticmethod
    def __validate_parameter_types(shared_parameters: set[str], class_parameters: dict[str, Any], parameters: dict[str, Any]) -> str:
        """
        Sprawdzamy, czy typy podanych wartości są zgodne z przyjmowanymi

        :param shared_parameters: parametry, które występują w obu grupach
        :param class_parameters: parametry klasy
        :param parameters: parametry, które porównujemy
        :return:
        """

        different_parameter_type = {
            k: (type(class_parameters[k]).__name__, type(parameters[k]).__name__)
            for k in shared_parameters
            if type(class_parameters[k]) != type(parameters[k])
        }

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
        exc_mess = self.__validate_parameter_excessive_amount(class_name=node_in_question.c_name,
                                                              class_keys=class_keys,
                                                              given_parameters=given_parameters)
        if exc_mess:
            error_messages.append(exc_mess)

        # Sprawdzamy, czy nie podajemy złych typów
        type_mess = self.__validate_parameter_types(shared_parameters=class_keys & given_parameters,
                                                    class_parameters=node_in_question.c_parameters,
                                                    parameters=parameters)
        if type_mess:
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
        class_in_question.parameters |= new_parameters

        return f"{info_message}\nOK: Dodano parametry do klasy '{class_name}'. Aktualne parametry to: {self.read_class(class_name)}"

    # TODO
    def merge(self):
        pass

    def relationship(self, from_node: str, to_nodes: list[str], relation: str) -> str:
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

    # TODO
    def read_node_relations(self, node_name: str, relation: str) -> str:
        pass

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