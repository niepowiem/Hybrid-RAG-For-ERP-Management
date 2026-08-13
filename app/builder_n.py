import re
from dataclasses import dataclass, field
from typing import Any

from neo4j import Driver
from pydantic import BaseModel, Field, ValidationError
from tqdm import tqdm

# TODO
# EmbedModel jest używany w adnotacjach '_compute_embeddings', '__make_embeddings'
# i 'sync'. Bez tego importu adnotacje nie mają się do czego odwołać i moduł
# rzuca NameError już przy imporcie -- Python wylicza adnotacje w czasie
# definiowania klasy, więc nie jest to problem widoczny dopiero przy wywołaniu.
from app.core_n import EmbeddingModel

class GraphClassSchema(BaseModel):
    """
    Definicja klasy węzła: jakie parametry może mieć węzeł tej klasy i jaka jest
    ich wartość domyślna.

    Odpowiednik etykiety w Neo4j plus kontrakt na właściwości. Klasy definiuje LLM
    podczas ingestu, stąd walidacja jest tak restrykcyjna: model potrafi wymyślić
    parametr o nazwie kolidującej z polem systemowym albo wskazać do embeddingu
    pole, którego nie zadeklarował.

    :param parameters: dict { nazwa parametru: wartość domyślna }
        Typ jest wyprowadzany z typu wartości domyślnej (patrz describe())
        Wymagany co najmniej jeden parametr

    :param parameters_to_embed: Podzbiór nazw z 'parameters', których wartości
        zostaną sklejone w tekst do embeddingu. Puste = węzły tej klasy nie
        trafiają do indeksu wektorowego (tak jest np. dla klasy Krok, której
        search_semantic ma nie zwracać).
    """

    parameters: dict[str, Any] = Field(min_length=1)
    parameters_to_embed: list[str] = []

    def describe(self) -> str:
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

class RelationSchema(BaseModel):
    """
    Definicja typu relacji: jakie właściwości może nieść krawędź

    W odróżnieniu od GraphClassSchema parametry są OPCJONALNE. Niektóre relacje
    w tym grafie mogą być połączeniami bez właściwości, które jedynie wskazują na relacje pomiędzy dwoma nodami

    :param parameters: mapa { nazwa właściwości: wartość domyślna }, może być pusta
    """

    parameters: dict[str, Any] = Field(default_factory=dict)

    def describe(self) -> str:
        if not self.parameters:
            return "(brak właściwości)"
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

@dataclass
class RelationEdge:
    """
    Pojedyncza krawędź wychodząca: dokąd prowadzi i z jakimi właściwościami

    Typ relacji NIE jest tu przechowywany wynika z klucza w GraphNode.n_relations,
    pod którym leży lista krawędzi. Trzymanie go również tutaj oznaczałoby dwa
    źródła prawdy, które mogą się rozjechać.

    :param target: node_id węzła docelowego (sam identyfikator, nie obiekt --
        graf jest serializowany do JSON w save_graph, a referencje na obiekty
        dałyby cykle nie do zapisania)

    :param r_parameters: właściwości TEJ krawędzi; prefiks 'r_' odróżnia je od
        parametrów węzła ('c_') przy przekazywaniu obu do jednego wywołania
    """

    target: str
    r_parameters: dict[str, Any] = field(default_factory=dict)

@dataclass
class GraphNode:
    """
    Pojedynczy węzeł grafu w pamięci, przed synchronizacją do Neo4j.

    Klucz węzła (node_id) NIE jest polem, węzły żyją w słowniku
    KnowledgeGraph.nodes pod tym kluczem, więc przechowywanie go także w obiekcie
    dawałoby drugie źródło prawdy.

    :param c_name: nazwa klasy z KnowledgeGraph.classes; prefiks 'c_' = "class"
    :param c_parameters: wartości parametrów zadeklarowanych przez tę klasę
    :param n_relations: krawędzie wychodzące, {typ relacji: [krawędzie]}.
        Lista, nie pojedyncza krawędź, bo jedna procedura ma wiele MA_KROK.
        Relacje trzymane są tylko po stronie źródła. Kierunek odczytuje się
        przeglądając graf, co przy ~312 węzłach jest tańsze niż utrzymywanie
        spójności dwóch kopii każdej krawędzi.
    :param n_labels: dodatkowe etykiety poza etykietą klasy (np. SHARED dla kroku
        współdzielonego przez kilka procedur) (Potrzebne do wyszukiwania po etykietach lub wektorowego)
    :param embeddings: wektor policzony z parameters_to_embed klasy; None oznacza
        "jeszcze nie policzono", pusta lista oznaczałaby "policzono i wyszło pusto"
    :param module: pole SYSTEMOWE, nie parametr klasy (patrz RESERVED_PARAMETER_NAMES).
        Nie filtruje wyszukiwania, jest wyłącznie preferencją planera.
    """

    c_name: str
    c_parameters: dict[str, Any] = field(default_factory=dict)
    n_relations: dict[str, list[RelationEdge]] = field(default_factory=dict)
    n_labels: set[str] = field(default_factory=set)
    embeddings: list[float] | None = None
    module: str = ""

class KnowledgeGraph:
    """
    Graf wiedzy w pamięci procesu: klasy, typy relacji, węzły i etykiety.

    Warstwa pośrednia między korpusem YAML a Neo4j. Istnieje osobno, bo buduje ją
    LLM przez narzędzia @tool, a model musi dostawać na każdą operację czytelną
    odpowiedź tekstową i mieć szansę poprawić błąd, zamiast wywalać cały ingest
    wyjątkiem.
    """

    __slots__ = ("nodes", "relations", "classes", "labels")

    # Nazwy bezpieczne do wstawienia wprost w zapytanie Cypher: litera na początku,
    # dalej [A-Za-z0-9_], maksymalnie 64 znaki. Neo4j nie parametryzuje nazw etykiet
    # ani typów relacji -- trafiają do zapytania przez interpolację, więc walidacja
    # wzorcem jest tu zabezpieczeniem przed wstrzyknięciem, nie kosmetyką.
    # Zweryfikowane: 'proc_magazyn_przyjecie_pz' przechodzi,
    # 'proc.magazyn.przyjecie-pz' NIE -- stąd zamiana kropek i myślników na
    # podkreślniki przed dodaniem węzła. Polskie znaki też odpadają ('Błąd').
    IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")

    # Typy, które Neo4j przyjmuje jako właściwość skalarną. Świadomie BEZ None:
    # parametr bez wartości domyślnej nie pozwoliłby wyprowadzić typu w describe().
    VALID_TYPES = (str, int, float, bool)

    # Te same typy plus jednorodne listy, w formie nazw -- do komunikatów
    # kierowanych do modelu. Neo4j nie przechowuje list mieszanych ani zagnieżdżonych.
    VALID_NAMES = ('str', 'int', 'float', 'bool',
                   'list[str]', 'list[int]', 'list[float]', 'list[bool]')

    # Nazwy zarezerwowane dla pól systemowych. LLM nie może ich użyć jako parametru
    # klasy: 'modul' przyjmuje merge() osobnym argumentem, a parametr o tej nazwie
    # po cichu przykryłby wartość systemową.
    # Oba warianty językowe do zarezerwowanych nazw parametrów, bo LLM pisze raz po polsku, raz po angielsku.
    MODULE_NAMES = ('module', 'modul')
    RESERVED_PARAMETER_NAMES = ('node_id', 'klasa', 'embeddings', *MODULE_NAMES)

    # Prefiks etykiety wyprowadzanej z nazwy klasy (Procedura -> C_Procedura).
    # Oddziela etykiety generowane automatycznie od nadawanych ręcznie, dzięki czemu
    # kasowanie klasy nie zabiera przy okazji cudzych etykiet.
    CLASS_LABEL_PREFIX = "C_"

    # Etykieta nakładana na wszystkie węzły dla globalnego wyszukiwania wektorowego
    SHARED_LABEL = "SHARED"

    def __init__(self):
        # Cztery niezależne rejestry. Węzeł trzyma tylko NAZWĘ klasy, nie jej
        # definicję, inaczej zmiana klasy wymagałaby przejścia po wszystkich węzłach.
        self.nodes: dict[str, GraphNode] = {}
        self.classes: dict[str, GraphClassSchema] = {}
        self.relations: dict[str, RelationSchema] = {}

        # Zbiorczy rejestr etykiet: pozwala odpowiedzieć modelowi, jakie etykiety
        # zostały zainicjalizowane, bez skanowania wszystkich węzłów.
        self.labels: set[str] = set()

    # ------------------------------------------------------------------
    # KLASY
    # ------------------------------------------------------------------

    def define_class(self, class_name: str, parameters: dict[str, Any], parameters_to_embed: list[str] | None = None) -> str:
        """
        Rejestruje nową klasę węzłów.

        Kolejność walidacji jest istotna: najpierw sprawdzamy, czy klasa już
        istnieje, potem nazwę, potem typy, a na końcu spójność listy do embeddingu.
        Dzięki temu model dostaje NAJBARDZIEJ podstawowy błąd jako pierwszy --
        wytykanie mu literówki w parametrze, gdy naprawdę zdublował całą klasę,
        wysyłało go w błędnym kierunku.

        Operacja jest atomowa: przy dowolnym błędzie self.classes pozostaje
        nietknięte, więc nieudane wywołanie nie zostawia klasy w połowie zdefiniowanej.

        :param class_name: nazwa klasy, musi pasować do IDENTIFIER_PATTERN
        :param parameters: {nazwa parametru: wartość domyślna}, co najmniej jeden
        :param parameters_to_embed: nazwy parametrów wchodzących do embeddingu;
            None i [] znaczą to samo, węzły tej klasy nie trafią do indeksu wektorowego
        :return: komunikat z prefiksem 'OK:' albo 'BŁĄD:'
        """

        # Nie nadpisujemy istniejącej klasy: przy powtórzonym ingeście oznaczałoby
        # to ciche przedefiniowanie kontraktu pod węzłami, które już go używają.
        # Zwracamy pełną definicję, żeby model sam ocenił, czy to duplikat, czy
        # naprawdę chciał czegoś innego.
        if class_name in self.classes:
            return (f"BŁĄD: Klasa '{class_name}' już istnieje: {self.read_class(class_name)}."
                    f"Aby sprawdzić wszystkie dostępne klasy użyj komendy: 'read_classes'")

        # Walidacja nazwy pod kątem wstawienia jej wprost do Cyphera (patrz IDENTIFIER_PATTERN).
        if mess := self._validate_name(class_name):
            return mess

        # Typy wartości domyślnych muszą mieścić się w VALID_TYPES -- Neo4j nie
        # zapisze właściwości spoza tego zbioru, a błąd wyszedłby dopiero w sync(),
        # setki wywołań później.
        if mess := self._validate_initialize_parameters_type(parameters):
            return mess

        # Sprawdzamy, czy parametry wskazane do embeddingu należą do parametrów klasy.
        # Bez tego literówka dawałaby klasę z pustym tekstem do embeddingu i węzły,
        # których search_semantic nigdy by nie znalazł -- bez żadnego sygnału błędu.
        parameters_to_embed = parameters_to_embed or []
        if invalid_keys := set(parameters_to_embed) - set(parameters.keys()):
            return (f"BŁĄD: Parametry {sorted(invalid_keys)} wskazane do embeddingu nie istnieją "
                    f"w definicji klasy '{class_name}'. Dostępne parametry: {', '.join(parameters.keys())}. "
                    f"Popraw i wywołaj 'define_class' ponownie.")

        # Ostatnia linia obrony: reguły pydantic (m.in. min_length na parameters).
        # Wyjątek zamieniamy na tekst, bo wywołanie idzie z narzędzia @tool --
        # rzucony ValidationError zerwałby pętlę tool-callingu zamiast dać modelowi
        # szansę na poprawkę.
        try:
            new_class = GraphClassSchema(parameters=parameters, parameters_to_embed=parameters_to_embed)

        except ValidationError as e:
            return f"BŁĄD: Nie udało się dodać klasy: '{class_name}'.: {e}"

        # Odpowiedź mówi modelowi nie tylko, że się udało, ale też co z tego wynika
        # (automatyczna etykieta) -- inaczej próbuje nadawać ją sobie ręcznie.
        self.classes[class_name] = new_class
        return (f"OK: Zdefiniowano klasę: {self.read_class(class_name)}. "
                f"Możesz ją od teraz przypisywać do node. "
                f"Każdy taki node dostanie automatycznie etykietę '{self.class_label(class_name)}'.")

    def add_class_parameters(self, class_name: str, parameters: dict[str, Any]) -> str:
        """
        Dopisuje nowe parametry do już istniejącej klasy.

        Potrzebne, bo LLM buduje graf przyrostowo: definiuje klasę, tworzy kilka
        węzłów, a dopiero potem orientuje się, że brakuje pola. Alternatywą byłoby
        kasowanie i redefiniowanie klasy, co unieważniłoby istniejące węzły.

        Parametry już istniejące są POMIJANE, nie nadpisywane -- zmiana wartości
        domyślnej pod węzłami, które już z niej skorzystały, rozjechałaby graf
        po cichu. Do zmiany wartości służy edycja węzła, nie klasy.

        Duplikat nie jest błędem, tylko sytuacją nieblokującą: model, który powtórzy
        wywołanie, ma dostać 'INFO:' i móc iść dalej, a nie 'BŁĄD:' i próbować
        naprawiać coś, co jest w porządku.

        UWAGA: istniejące węzły tej klasy NIE dostają nowego parametru wstecz.
        Braki uzupełni dopiero _validate_parameters przy kolejnym zapisie węzła.

        :param class_name: nazwa istniejącej klasy
        :param parameters: {nazwa: wartość domyślna} do dopisania
        :return: komunikat z prefiksem 'OK:' (ewentualnie poprzedzony 'INFO:')
            albo 'BŁĄD:', gdy klasa nie istnieje lub typy są nieobsługiwane
        """

        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return self.err_mess_class_doesnt_exist(class_name)

        class_keys: set[str] = set(class_in_question.parameters.keys())
        given_parameters: set[str] = set(parameters.keys())
        shared_parameters: set[str] = class_keys & given_parameters

        # Duplikaty raportujemy, ale nie przerywamy: model często dorzuca całą listę
        # parametrów naraz, w tym te już zdefiniowane. Odrzucenie całego wywołania
        # z tego powodu zmuszałoby go do zgadywania, które akurat są nowe.
        err_info_messages: list[str] = []
        if shared_parameters:
            err_info_messages.append(f"INFO: Klasa '{class_name}' już posiada parametry: "
                                     f"{', '.join(sorted(shared_parameters))}.\n"
                                     f"Pominięto dodanie zduplikowanych parametrów.")

        new_parameters = {k: v for k, v in parameters.items() if k not in shared_parameters}

        # Typy sprawdzamy TYLKO dla nowych parametrów -- istniejące przeszły
        # walidację przy definiowaniu klasy, a powtórne sprawdzanie ich tutaj
        # potrafiłoby zablokować wywołanie z powodu czegoś, czego to wywołanie
        # w ogóle nie dotyczy.
        if mess_type := self._validate_initialize_parameters_type(new_parameters):
            return mess_type

        if not new_parameters:
            err_info_messages.append(f"INFO: Nie dodano żadnego nowego parametru do klasy '{class_name}'. "
                                     f"Aktualne parametry to: {self.read_class(class_name)}")

            return '\n'.join(err_info_messages)

        # |= mutuje słownik w miejscu, więc zmiana jest natychmiast widoczna dla
        # wszystkich, którzy trzymają referencję do tej klasy.
        class_in_question.parameters |= new_parameters
        err_info_messages.append(f"OK: Dodano parametry {sorted(new_parameters)} do klasy '{class_name}'. "
                                 f"Aktualne parametry to: {self.read_class(class_name)}")

        return '\n'.join(err_info_messages)

    def _validate_parameters(self, class_name: str, parameters: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        """
        Sprawdza parametry PRZED utworzeniem węzła i uzupełnia braki wartościami
        domyślnymi klasy.

        Zwraca krotkę, a nie sam komunikat, bo trzeba rozróżnić dwie rzeczy, których
        prefiks tekstu nie oddaje: czy operacja może iść dalej ORAZ co powiedzieć
        modelowi. Komunikat bywa niepusty także przy powodzeniu (uzupełnione
        wartości domyślne to 'INFO:', czyli sukces).

        WAŻNE DLA WOŁAJĄCEGO: o powodzeniu decyduje PIERWSZY element krotki
        (None = porażka), nie treść komunikatu. Komunikat może zaczynać się od
        'INFO:' i mimo to towarzyszyć porażce, jeśli dalej doszedł błąd typów.

        Kolejność sprawdzeń jest istotna:
          1. uzupełnienie braków -- żeby walidacja typów widziała komplet parametrów
          2. nadmiarowe parametry -- błąd, bo klasa ich nie przewiduje
          3. typy -- tylko dla parametrów podanych JAWNIE; wartości domyślne
             przeszły już walidację przy definiowaniu klasy

        Wejściowy słownik nie jest modyfikowany: przypisanie tworzy nowy obiekt,
        więc wołający zachowuje swoją kopię nietkniętą.

        :param class_name: klasa, względem której walidujemy
        :param parameters: parametry podane przez model
        :return: (komplet parametrów, komunikat) przy powodzeniu,
                 (None, komunikat) przy błędzie
        """

        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return None, self.err_mess_class_doesnt_exist(class_name)

        # Osobna flaga zamiast sprawdzania, czy lista komunikatów jest pusta --
        # lista zbiera także 'INFO:', które NIE jest błędem.
        error: bool = False
        error_messages: list[str] = []
        class_keys = set(class_in_question.parameters.keys())
        given_params = set(parameters.keys())

        # Brak parametru to sytuacja normalna, nie awaria: po to klasa deklaruje
        # wartości domyślne. Model dostaje 'INFO:' i wskazówkę, jak je nadpisać,
        # gdyby domyślne mu nie pasowały.
        missing_params = class_keys - given_params
        if missing_params:
            error_messages.append((f"INFO: Nie podano wartości dla parametrów: {sorted(missing_params)}."
                                   f"W ich miejsce wstawiam defaultowe wartości dla klasy: {self.read_class(class_name)}."
                                   f"Jeżeli chcesz zmienić parametry instancji klasy dla node użyj 'edit_node_parameters'"))

            # Kolejność rozpakowania jest istotna: wartości podane jawnie przykrywają
            # domyślne, nigdy odwrotnie.
            parameters = {**class_in_question.parameters, **parameters}

        # Parametr spoza definicji klasy to błąd twardy -- Neo4j zapisałby go bez
        # protestu, a węzeł miałby właściwość, o której klasa nic nie wie.
        exc_mess = self.__validate_parameter_excessive_amount(entity_name=class_name,
                                                              entity_keys=class_keys,
                                                              given_parameters=given_params)
        if exc_mess:
            error_messages.append(exc_mess)
            error = True

        # 'shared_parameters' zawęża sprawdzanie do parametrów podanych JAWNIE.
        # Wartości domyślne dokleiliśmy wyżej i są z definicji poprawne typowo --
        # sprawdzanie ich tutaj byłoby pracą na darmo.
        type_mess = self.__validate_parameter_types(shared_parameters=class_keys & given_params,
                                                    entity_parameters=class_in_question.parameters,
                                                    parameters=parameters)
        if type_mess:
            error_messages.append(type_mess)
            error = True

        return None if error else parameters, '\n'.join(error_messages)

    def read_class(self, name) -> str:
        """
        Opis pojedynczej klasy w formacie 'Nazwa: { param: typ (default=...) }'.

        UWAGA: indeksowanie wprost, bez .get() -- wywołanie dla nieistniejącej klasy
        rzuci KeyError, a nie zwróci komunikatu 'BŁĄD:'. Każdy wołający musi
        wcześniej sprawdzić istnienie klasy (patrz err_mess_class_doesnt_exist).

        :param name: nazwa istniejącej klasy
        :return: jednolinijkowy opis klasy
        """

        class_in_question = self.classes.get(name)
        if class_in_question is None:
            return f"BŁĄD: klasa '{name}' nie istnieje! Aby ją stworzyć użyj 'define_class'"

        return f"{name}: {{ {class_in_question.describe()} }}"

    def read_classes(self, internal: bool = False) -> str:
        """
        Opis wszystkich zdefiniowanych klas.

        Flaga 'internal' rozstrzyga, czy wynik jest samodzielną odpowiedzią dla
        modelu, czy fragmentem doklejanym do innego komunikatu. Prefiks 'INFO:'
        w środku cudzego tekstu mylił model co do tego, gdzie kończy się jedna
        informacja, a zaczyna druga.

        :param internal: True = sama lista, bez prefiksu, do wklejenia w inny komunikat
        :return: lista klas albo komunikat o pustym grafie
        """

        if self.classes:
            classes = '\n'.join([f' - {self.read_class(class_name)}' for class_name in self.classes.keys()])

            if internal:
                return classes

            return f"INFO: Dostępne klasy:\n{classes}"

        # Flaga 'internal' musi być honorowana TAKŻE tutaj: wynik jest wtedy
        # wklejany w środek cudzego komunikatu, więc własny prefiks dałby
        # 'BŁĄD:' zagnieżdżony w 'BŁĄD:' i dwie sprzeczne instrukcje.
        return "(brak)" if internal else "BŁĄD: Nie dodano jeszcze żadnej klasy! Aby dodać klasę skorzystaj z 'define_class'"

    def err_mess_class_doesnt_exist(self, class_name: str, helper: bool = True) -> str:
        """
        Jednolity komunikat o nieistniejącej klasie.

        Wydzielony, bo pojawia się w kilkunastu narzędziach i rozjeżdżał się między
        nimi. Domyślnie dokleja listę dostępnych klas: model, który pomylił nazwę,
        bez tego próbuje w kółko tej samej -- widząc listę, poprawia się za pierwszym
        razem.

        :param class_name: nazwa, której nie znaleziono
        :param helper: False, gdy wołający sam dokleja kontekst albo gdy lista klas
            byłaby w danym miejscu szumem
        :return: komunikat z prefiksem 'BŁĄD:'
        """

        mess: str = f"BŁĄD: Klasa '{class_name}' nie jest zdefiniowana."

        if helper:
            return mess + (f"\nDostępne klasy:\n{self.read_classes(internal=True)}\n"
                           f"Aby zdefiniować klasę użyj: 'define_class'")

        return mess

    # ------------------------------------------------------------------
    # WĘZŁY (NODE)
    # ------------------------------------------------------------------

    def merge(self, node_name: str, class_name: str, module: str, parameters: dict[str, Any]) -> str:
        """
        Tworzy nowy węzeł grafu.

        Nazwa 'merge' pochodzi od odpowiadającej operacji Cypher, ale ta metoda
        celowo NIE zachowuje się jak MERGE: istniejący węzeł jest błędem, nie
        cichą aktualizacją. LLM buduje graf w wielu turach i potrafi wrócić do
        tej samej procedury -- nadpisanie węzła zabrałoby relacje dopięte
        w międzyczasie. Do zmiany istniejącego węzła służy 'edit_node_parameters'.

        'module' jest osobnym argumentem, a nie kluczem w 'parameters', bo to pole
        SYSTEMOWE -- na równi z node_id i klasą. Nazwy 'module'/'modul' są
        zablokowane w RESERVED_PARAMETER_NAMES właśnie po to, żeby model nie mógł
        przemycić go bokiem jako zwykłego parametru.

        Wszystkie sprawdzenia wykonywane są PRZED jakąkolwiek modyfikacją stanu,
        a ich komunikaty zbierane do jednej listy. Model, który pomylił się na trzy
        sposoby naraz, dostaje komplet uwag w jednej odpowiedzi zamiast trzech tur
        poprawiania po jednym błędzie.

        :param node_name: klucz w self.nodes; po konwencji z korpusu kropki
            i myślniki są już zamienione na podkreślniki (proc.magazyn.przyjecie-pz
            -> proc_magazyn_przyjecie_pz), inaczej attach_steps_from_documents
            nie odnajdzie węzła procedury
        :param class_name: nazwa zdefiniowanej wcześniej klasy
        :param module: moduł ERP, do którego należy węzeł; nie może być pusty
        :param parameters: wartości parametrów; braki uzupełni _validate_parameters
        :return: komunikat z prefiksem 'OK:' albo 'BŁĄD:'
        """

        # Sprawdzamy, czy nazwa noda i klasy są poprawne i jeżeli chociaż jeden błąd wynikł, zwracamy błędy
        mess: str = ''
        if node_name_mess := self._validate_name(node_name):
            mess += node_name_mess
        if class_name_mess := self._validate_name(class_name):
            mess += '\n' + class_name_mess
        if mess:
            return mess

        error_messages: list[str] = []
        node_already_exists: bool = node_name in self.nodes.keys()

        # .strip() w warunku, bo model potrafi wysłać ' ' zamiast pominąć pole --
        # samo `not module` przepuściłoby spację i dałoby węzeł w module "niczyim".
        module_missing: bool = not module or not module.strip()

        if node_already_exists:
            error_messages.append(
                f"BŁĄD: Node '{node_name}' już istnieje! Aby sprawdzić wszystkie istniejące nody, użyj 'read_node_names'")

        if module_missing:
            error_messages.append(("BŁĄD: Nie podano modułu dla node. Każdy node musi należeć do modułu ERP "
                                   "(np. 'Magazyn', 'Sprzedaz', 'Ksiegowosc')." # To po nim filtrowane jest wyszukiwanie."
                                   "Podaj moduł i spróbuj jeszcze raz."))

        # Walidacja parametrów leci NIEZALEŻNIE od poprzednich błędów, żeby model
        # zobaczył wszystkie uwagi naraz. Zwrócony słownik to komplet: podane
        # wartości plus wartości domyślne klasy dla parametrów pominiętych.
        # None w pierwszym elemencie oznacza błąd -- prefiks komunikatu tego nie
        # rozstrzyga, bo bywa nim 'INFO:' (uzupełnione wartości domyślne).
        parameters, message = self._validate_parameters(class_name=class_name, parameters=parameters)
        if message:
            error_messages.append(message)

        if node_already_exists or module_missing or parameters is None:
            return '\n'.join(error_messages)

        # n_labels zostaje puste: etykieta klasy wyprowadzana jest z c_name przy
        # synchronizacji, a SHARED nadaje dopiero attach_steps_from_documents,
        # gdy okaże się, że ten sam krok występuje w kilku procedurach.
        self.nodes[node_name] = GraphNode(c_name=class_name, c_parameters=parameters, module=module)

        # Komunikaty z walidacji doklejane są PO 'OK:', bo mogą zawierać 'INFO:'
        # o uzupełnionych wartościach domyślnych -- to informacja, nie awaria.
        return (f"OK: Pomyślnie utworzono node '{node_name}' "
                f"(etykiety: '{self.SHARED_LABEL}', '{self.class_label(class_name)}')."
                f"Aby zobaczyć wszystkie utworzone node użyj 'read_node_names'.\n"
                f"{'\n'.join(error_messages)}")

    def edit_node_parameters(self, node_name: str, parameters: dict[str, Any], module: str | None = None) -> str:
        """
        Aktualizuje parametry istniejącego węzła; opcjonalnie także jego moduł.

        Aktualizacja jest CZĘŚCIOWA: podajesz tylko to, co zmieniasz, reszta
        zostaje. W odróżnieniu od 'merge' braki NIE są uzupełniane wartościami
        domyślnymi -- wywołanie z jednym parametrem oznaczałoby wtedy skasowanie
        wszystkich pozostałych.

        Odwrotnie niż w 'merge', tutaj dowolny błąd blokuje CAŁĄ operację. Węzeł
        już istnieje i jest prawdopodobnie wpięty w relacje; częściowy zapis
        zostawiłby go w stanie pośrednim, którego model nie potrafi cofnąć.

        :param node_name: nazwa istniejącego węzła
        :param parameters: parametry do zmiany; wystarczy podzbiór
        :param module: nowy moduł; None albo pusty tekst = nie zmieniaj
        :return: komunikat z prefiksem 'OK:' albo 'BŁĄD:'
        """

        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        error_messages: list[str] = []
        # Sprawdzenie jest NADMIAROWE dla węzłów utworzonych przez 'merge' -- ta
        # funkcja nie dopuści węzła z nieistniejącą klasą, a w module nie ma
        # narzędzia kasującego klasę. Zostaje, bo 'merge' nie jest jedynym wejściem:
        # węzły wchodzą też przez wczytanie grafu z JSON, które omija tę walidację.
        # Koszt jest asymetryczny -- KeyError w narzędziu @tool zrywa pętlę
        # tool-callingu, a komunikat kosztuje dwie linie.
        node_class = self.classes.get(node_in_question.c_name)
        if node_class is None:
            return self.err_mess_class_doesnt_exist(node_in_question.c_name)

        class_keys: set[str] = set(node_class.parameters.keys())
        given_parameters: set[str] = set(parameters.keys())

        # Parametr spoza definicji klasy: Neo4j zapisałby go bez protestu, a węzeł
        # miałby właściwość, o której jego klasa nic nie wie.
        if exc_mess := self.__validate_parameter_excessive_amount(entity_name=node_in_question.c_name,
                                                                  entity_keys=class_keys,
                                                                  given_parameters=given_parameters):
            error_messages.append(exc_mess)

        # Sprawdzamy tylko część wspólną: parametry, których nie podano, nie zmieniają
        # się w tym wywołaniu, więc nie ma czego walidować.
        if type_mess := self.__validate_parameter_types(shared_parameters=class_keys & given_parameters,
                                                        entity_parameters=node_class.parameters,
                                                        parameters=parameters):
            error_messages.append(type_mess)

        if error_messages:
            return (f"BŁĄD: Nie udało się edytować parametrów node '{node_name}'."
                    f"Wyeliminuj poniższe błędy i spróbuj ponownie:\n{'\n'.join(error_messages)}")

        # Moduł zmieniamy tylko wtedy, gdy podano go świadomie. None i pusty tekst
        # znaczą "nie ruszaj" -- węzeł bez modułu nie może powstać (patrz 'merge'),
        # więc skasowanie modułu tą drogą byłoby obejściem tamtej reguły.
        module_message: str = ''
        if module is not None and module.strip():
            module_message: str = f"\nOK: Module node '{node_name}' został pomyślnie zmieniony"
            node_in_question.module = module.strip()

        # Nowy słownik zamiast |= : stary obiekt zostaje nietknięty, więc jeśli ktoś
        # trzyma do niego referencję (np. zrzut sprzed edycji), nie zmieni mu się pod ręką.
        node_in_question.c_parameters = {**node_in_question.c_parameters, **parameters}

        return f"OK: Parametry node '{node_name}' zostały pomyślnie zaktualizowane." + module_message

    def read_node_parameters(self, node_name: str, internal: bool = False) -> str:
        """
        Opis węzła: klasa, moduł i komplet parametrów z typami.

        Parametry klasy i węzła są nakładane, bo węzeł przechowuje tylko to, co
        dla niego ustalono. Gdy klasa dostanie nowy parametr przez
        'add_class_parameters', istniejące węzły go nie mają -- nałożenie sprawia,
        że model widzi wartość domyślną zamiast luki i nie próbuje "naprawiać"
        węzła, z którym wszystko jest w porządku.

        :param node_name: nazwa istniejącego węzła
        :param internal: True = sam opis, bez prefiksu, do wklejenia w inny komunikat
        :return: opis węzła albo komunikat 'BŁĄD:'
        """

        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        # Klasa może zniknąć, choć węzeł jej klasy został -- .get() zamiast
        # indeksowania zamienia to na czytelny komunikat zamiast KeyError,
        # który zerwałby pętlę tool-callingu.
        node_class = self.classes.get(node_in_question.c_name)
        if node_class is None:
            return self.err_mess_class_doesnt_exist(node_in_question.c_name)

        # Kolejność w | jest istotna: wartości węzła przykrywają domyślne z klasy.
        merged_parameters = node_class.parameters | node_in_question.c_parameters

        # Zagnieżdżone cudzysłowy w f-stringu wymagają Pythona >= 3.12 (PEP 701).
        node_info = (f"{node_name}: (klasa={node_in_question.c_name}, modul={node_in_question.module}), "
                     f"{{ {', '.join([f"'{k}': {type(v).__name__} = {v}" for k, v in merged_parameters.items()])} }}")

        if internal:
            return node_info

        return f"INFO: Parametry node {node_info}"

    def read_node_names(self, internal: bool = False) -> str:
        """
        Lista nazw wszystkich węzłów.

        Same nazwy, bez parametrów: to jest odpowiedź na pytanie "co już mam",
        zadawane przez model najczęściej po to, żeby nie zdublować węzła.
        Pełne opisy są w 'read_node_parameters'.

        :param internal: True = sama lista, bez prefiksu, do wklejenia w inny komunikat
        :return: lista nazw albo komunikat o pustym grafie
        """

        if self.nodes:
            nodes = '\n'.join([f" - {node_name}" for node_name in self.nodes.keys()])

            if internal:
                return nodes

            return f"INFO: Dostępne nody:\n{nodes}"

        # Flaga 'internal' musi być honorowana TAKŻE tutaj: wynik jest wtedy
        # wklejany w środek cudzego komunikatu, więc własny prefiks dałby
        # 'BŁĄD:' zagnieżdżony w 'BŁĄD:' i dwie sprzeczne instrukcje.
        return "(brak)" if internal else "BŁĄD: Nie dodano jeszcze żadnego noda! Aby dodać node skorzystaj z 'merge'"

    def err_mess_node_doesnt_exist(self, node_name: str, helper: bool = True) -> str:
        """
        Jednolity komunikat o nieistniejącym węźle.

        Wydzielony, bo powtarza się w kilkunastu narzędziach i rozjeżdżał się
        między nimi. Domyślnie dokleja listę istniejących węzłów: model, który
        pomylił nazwę, bez niej próbuje w kółko tej samej.

        :param node_name: nazwa, której nie znaleziono
        :param helper: False, gdy wołający sam dokleja kontekst albo gdy lista
            węzłów byłaby w danym miejscu szumem
        :return: komunikat z prefiksem 'BŁĄD:'
        """

        mess: str = f"BŁĄD: Node '{node_name}' nie istnieje."

        if helper:
            return mess + (f"\nDostępne nody:\n{self.read_node_names(internal=True)}\n"
                           f"Aby stworzyć node użyj: 'merge'")

        return mess

    def class_label(self, class_name: str) -> str:
        """
        Etykieta Neo4j wyprowadzona z nazwy klasy (Procedura -> C_Procedura).

        Prefiks oddziela etykiety generowane automatycznie od nadawanych ręcznie
        (np. SHARED), dzięki czemu operacje na klasie nie ruszają cudzych etykiet.
        Jedno miejsce wyliczania tej nazwy -- rozsypana po kodzie konkatenacja
        rozjechałaby się przy zmianie prefiksu.
        """

        return f"{self.CLASS_LABEL_PREFIX}{class_name}"

    # ------------------------------------------------------------------
    # RELACJE
    # ------------------------------------------------------------------

    def define_relation(self, relation: str, parameters: dict[str, Any] | None = None) -> str:
        """
        Rejestruje nowy typ relacji (krawędzi).

        Nazwa jest normalizowana do wielkich liter, bo taka jest konwencja typów
        relacji w Neo4j (MA_KROK, WYMAGA_STANU), a LLM pisze je raz tak, raz inaczej.
        Bez normalizacji 'ma_krok' i 'MA_KROK' byłyby dwoma różnymi typami
        i połowa krawędzi trafiłaby nie tam, gdzie trzeba.

        W odróżnieniu od klasy, relacja NIE musi mieć żadnej właściwości --
        MA_KROK, WYMAGA czy DAJE_STAN to czyste połączenia. Wymuszanie choćby
        jednego parametru zmuszałoby model do wymyślania atrap.

        :param relation: nazwa typu relacji; zostanie zamieniona na wielkie litery
        :param parameters: {nazwa właściwości: wartość domyślna}, opcjonalne
        :return: komunikat z prefiksem 'OK:' albo 'BŁĄD:'
        """

        init_name = relation
        relation = relation.upper()

        # Sprawdzenie istnienia PRZED walidacją nazwy: gdy model powtórzy definicję,
        # ma usłyszeć, że relacja już jest, a nie dostać uwagi do jej nazwy.
        if relation in self.relations:
            return (f"BŁĄD: Ta relacja: '{relation}' już istnieje. "
                    f"Nie można jej dodać drugi raz."
                    f"Aby sprawdzić wszystkie dostępne relacje użyj 'read_relationships'")

        # Nazwa typu relacji trafia do zapytania Cypher przez interpolację
        # (Neo4j nie parametryzuje typów), więc wzorzec jest tu zabezpieczeniem
        # przed wstrzyknięciem, nie kosmetyką.
        if mess := self._validate_name(relation):
            return mess

        parameters = parameters or {}
        if parameters and (mess := self._validate_initialize_parameters_type(parameters)):
            return mess

        self.relations[relation] = RelationSchema(parameters=parameters)

        # Zdanie o zamianie liter NIE może siedzieć w komunikacie bazowym: szłoby
        # wtedy zawsze, także gdy model podał już poprawną nazwę (czyli w większości
        # wywołań -- korpus używa wielkich liter). Uczyło go, że zrobił coś źle,
        # choć zrobił dobrze, a przy faktycznej zamianie pojawiało się dwa razy.
        ok_mess: str = (f"OK: Dodano relację '{relation}' do zbioru dostępnych relacji: "
                        f"{self.read_relation(relation)}. "
                        f"Aby sprawdzić wszystkie dostępne relacje użyj 'read_relationships'")

        if init_name == relation:
            return ok_mess

        return f"INFO: Nazwę relacji '{init_name}' zamieniono na wielkie litery.\n" + ok_mess

    def add_relation_parameters(self, relation: str, parameters: dict[str, Any]) -> str:
        """
        Dopisuje właściwości do już zdefiniowanego typu relacji.

        Bliźniacza do 'add_class_parameters' i z tego samego powodu: LLM buduje
        graf przyrostowo i orientuje się w brakach dopiero po utworzeniu krawędzi.
        Redefinicja typu unieważniłaby krawędzie już wpięte w graf.

        Istniejące właściwości są POMIJANE, nie nadpisywane -- zmiana wartości
        domyślnej pod krawędziami, które już z niej skorzystały, rozjechałaby graf
        po cichu. Duplikat to sytuacja nieblokująca ('INFO:'), nie awaria.

        :param relation: nazwa istniejącego typu relacji; wielkość liter bez znaczenia
        :param parameters: {nazwa: wartość domyślna} do dopisania
        :return: komunikat z prefiksem 'OK:' albo 'BŁĄD:'
        """

        relation = relation.upper()

        relation_in_question = self.relations.get(relation, None)
        if relation_in_question is None:
            return self.err_mess_relation_doesnt_exist(relation)

        relation_keys: set[str] = set(relation_in_question.parameters.keys())
        given_parameters: set[str] = set(parameters.keys())
        shared_parameters: set[str] = relation_keys & given_parameters

        # Duplikaty raportujemy, ale nie przerywamy: model często dorzuca całą listę
        # naraz, w tym pozycje już zdefiniowane. Odrzucenie całego wywołania
        # zmuszałoby go do zgadywania, które akurat są nowe.
        info_messages: list[str] = []
        if shared_parameters:
            info_messages.append((f"INFO: Relacja '{relation}' już posiada właściwości: {', '.join(shared_parameters)}.\n"
                                 f"Pominięto dodanie zduplikowanych właściwości."))

        new_parameters = {k: v for k, v in parameters.items() if k not in shared_parameters}

        # Typy sprawdzamy tylko dla NOWYCH właściwości -- istniejące przeszły
        # walidację przy definiowaniu relacji.
        if mess_type := self._validate_initialize_parameters_type(new_parameters):
            return mess_type

        if not new_parameters:
            info_messages.append(f"INFO: Nie dodano żadnej nowej właściwości do relacji '{relation}'. "
                                 f"Aktualne właściwości to: {self.read_relation(relation)}")

            return '\n'.join(info_messages)


        relation_in_question.parameters |= new_parameters
        info_messages.append(f"OK: Dodano właściwości do relacji '{relation}'. Aktualne właściwości to: {self.read_relation(relation)}")

        return '\n'.join(info_messages)

    def _validate_relation_parameters(self, relation: str, parameters: dict[str, Any]) -> tuple[
        dict[str, Any] | None, str]:
        """
        Sprawdza właściwości krawędzi PRZED jej utworzeniem i uzupełnia braki
        wartościami domyślnymi typu relacji.

        Odpowiednik '_validate_parameters' dla krawędzi. Zwraca krotkę, bo trzeba
        rozróżnić dwie rzeczy, których prefiks komunikatu nie oddaje: czy operacja
        może iść dalej ORAZ co powiedzieć modelowi.

        WAŻNE DLA WOŁAJĄCEGO: o powodzeniu decyduje PIERWSZY element krotki
        (None = porażka), nie treść komunikatu. Komunikat bywa niepusty przy
        powodzeniu (uzupełnione wartości domyślne to 'INFO:').

        Metoda NIE normalizuje nazwy relacji do wielkich liter -- zakłada, że
        wołający już to zrobił (patrz 'relationship').

        :param relation: nazwa typu relacji, już zapisana wielkimi literami
        :param parameters: właściwości podane przez model
        :return: (komplet właściwości, komunikat) albo (None, komunikat) przy błędzie
        """

        relation_in_question = self.relations.get(relation, None)
        if relation_in_question is None:
            return None, self.err_mess_relation_doesnt_exist(relation)

        # Osobna flaga zamiast sprawdzania, czy lista komunikatów jest pusta --
        # lista zbiera także 'INFO:', które NIE jest błędem.
        error: bool = False
        error_messages: list[str] = []
        relation_keys = set(relation_in_question.parameters.keys())
        given_params = set(parameters.keys())

        # Brak właściwości to sytuacja normalna, nie awaria -- po to typ relacji
        # deklaruje wartości domyślne.
        missing_params = relation_keys - given_params
        if missing_params:
            error_messages.append((f"INFO: Nie podano wartości dla właściwości: {missing_params}."
                                   f"W ich miejsce wstawiam defaultowe wartości dla relacji: {self.read_relation(relation)}."))

            # Kolejność rozpakowania jest istotna: wartości podane jawnie przykrywają
            # domyślne, nigdy odwrotnie.
            parameters = {**relation_in_question.parameters, **parameters}

        # Właściwość spoza definicji typu to błąd twardy: Neo4j zapisałby ją bez
        # protestu, a krawędź miałaby pole, o którym jej typ nic nie wie.
        exc_mess = self.__validate_parameter_excessive_amount(entity_name=relation, entity_keys=relation_keys,
                                                              given_parameters=given_params)
        if exc_mess:
            error_messages.append(exc_mess)
            error = True

        # Typy sprawdzamy tylko dla części wspólnej: wartości domyślne dokleiliśmy
        # wyżej i są z definicji poprawne typowo.
        type_mess = self.__validate_parameter_types(shared_parameters=relation_keys & given_params,
                                                    entity_parameters=relation_in_question.parameters,
                                                    parameters=parameters)
        if type_mess:
            error_messages.append(type_mess)
            error = True

        return None if error else parameters, '\n'.join(error_messages)

    def relationship(self, from_node: str, to_nodes: list[str], relation: str,
                     parameters: dict[str, Any] | None = None) -> str:
        """
        Łączy jeden węzeł źródłowy z wieloma docelowymi krawędziami tego samego typu.

        Wiele celów naraz, bo tak wygląda typowa operacja w tym grafie: procedura
        ma kilkanaście kroków (MA_KROK), krok wymaga kilku stanów (WYMAGA_STANU).
        Rozbicie tego na osobne wywołania to kilkanaście tur modelu zamiast jednej.

        Wszystkie sprawdzenia wykonywane są PRZED jakąkolwiek modyfikacją grafu:
        albo wpinamy komplet krawędzi, albo żadnej. Częściowy zapis zostawiłby
        graf w stanie, którego model nie potrafi cofnąć.

        Krawędź już istniejąca to 'INFO:', nie błąd -- powtórzony przebieg ingestu
        ma przechodzić bez awarii.

        :param from_node: węzeł źródłowy; relacje trzymane są tylko po stronie źródła
        :param to_nodes: węzły docelowe; duplikaty w liście są usuwane
        :param relation: typ relacji; wielkość liter bez znaczenia
        :param parameters: właściwości krawędzi, wspólne dla wszystkich tworzonych
        :return: komunikat z prefiksem 'OK:', 'INFO:' albo 'BŁĄD:'
        """

        relation = relation.upper()
        parameters = parameters or {}

        # set() usuwa duplikaty: model potrafi wymienić ten sam węzeł dwa razy,
        # a to dałoby dwie identyczne krawędzie.
        set_to_nodes: set[str] = set(to_nodes)

        error_messages: list[str] = []
        n_error: bool = False

        if relation not in self.relations:
            error_messages.append(self.err_mess_relation_doesnt_exist(relation))

        node_in_question = self.nodes.get(from_node, None)
        if node_in_question is None:
            error_messages.append(self.err_mess_node_doesnt_exist(from_node, helper=False))
            n_error = True

        if not set_to_nodes:
            error_messages.append(f"BŁĄD: Nie podano żadnego node docelowego dla relacji '{relation}' z '{from_node}'")
            return 'BŁĄD: Nie udało się wykonać połączeń. Najpierw napraw błędy i spróbuj ponownie:\n' + '\n'.join(error_messages)

        # helper=False przy każdym węźle z osobna, a pełna lista dostępnych nazw
        # doklejana RAZ na końcu: przy kilkunastu celach powtarzanie listy setek
        # węzłów przy każdym z nich zalałoby kontekst modelu.
        for node in set_to_nodes:
            if node not in self.nodes.keys():
                error_messages.append(self.err_mess_node_doesnt_exist(node, helper=False))
                n_error = True

        # if from_node in set_to_nodes:
        #     error_messages.append(f"BŁĄD: Node '{from_node}' nie może być połączony sam ze sobą.")

        if error_messages:
            if n_error:
                error_messages.append((f"\nDostępne nody:\n{self.read_node_names(internal=True)}\n"
                                       f"Aby stworzyć node użyj: 'merge'\n"))

            return 'BŁĄD: Nie udało się wykonać połączeń. Najpierw napraw błędy i spróbuj ponownie:\n' + '\n'.join(error_messages)

        validated_parameters, mess = self._validate_relation_parameters(relation, parameters)
        if validated_parameters is None:
            return f"BŁĄD: Nie udało się utworzyć relacji '{relation}':\n{mess}"

        # Zbiór dotychczasowych celów liczony RAZ, przed pętlą: sprawdzanie po liście
        # krawędzi przy każdym celu dałoby złożoność kwadratową, a procedury mają
        # po kilkanaście kroków.
        current_related_nodes: set[str] = {edge.target for edge in node_in_question.n_relations.get(relation, [])}
        if relation not in node_in_question.n_relations:
            node_in_question.n_relations[relation] = []

        # Komunikat z walidacji (może być 'INFO:' o wartościach domyślnych) trafia
        # na początek wyniku, przed raportem z poszczególnych połączeń.
        result_messages: list[str] = [mess] if mess else []

        for node in set_to_nodes:
            # Istniejąca krawędź nie jest błędem: powtórzony ingest ma być
            # idempotentny. Notacja (A-[REL]->B) w komunikacie daje modelowi
            # jednoznaczny obraz kierunku.
            if node in current_related_nodes:
                result_messages.append(f"INFO: node '{from_node}' już był połączony z '{node}' relacją '{relation}'. ({from_node}-[{relation}]->{node})")
                continue

            node_in_question.n_relations[relation].append(RelationEdge(target=node, r_parameters=dict(validated_parameters)))
            result_messages.append(f"OK: node '{from_node}' został połączony z '{node}' relacją '{relation}' {validated_parameters}. ({from_node}-[{relation}]->{node})")

        return '\n'.join(result_messages) + "\nAby zobaczyć wszystkie połaczenia z danego node użyj 'read_node_relations'"

    def read_relation(self, name) -> str:
        """
        Opis pojedynczego typu relacji w formacie 'NAZWA: { właściwość: typ (default=...) }'.

        UWAGA: indeksowanie wprost, bez .get() -- wywołanie dla nieistniejącego typu
        rzuci KeyError zamiast zwrócić 'BŁĄD:'. Każdy wołający musi wcześniej
        sprawdzić istnienie relacji (patrz err_mess_relation_doesnt_exist).

        :param name: nazwa istniejącego typu relacji, zapisana wielkimi literami
        """

        if not self.relations:
            return "BŁĄD: Nie dodano jeszcze żadnej relacji! Aby dodać relację skorzystaj z 'define_relation'"

        return f"{name}: {{ {self.relations[name].describe()} }}"

    def read_relationships(self, internal: bool = False) -> str:
        """
        Opis wszystkich zdefiniowanych typów relacji.

        Flaga 'internal' rozstrzyga, czy wynik jest samodzielną odpowiedzią dla
        modelu, czy fragmentem doklejanym do innego komunikatu -- prefiks 'INFO:'
        w środku cudzego tekstu mylił model co do tego, gdzie kończy się jedna
        informacja, a zaczyna druga.

        :param internal: True = sama lista, bez prefiksu
        """

        if self.relations:
            relations = '\n'.join([f" - {self.read_relation(name)}" for name in self.relations.keys()])

            if internal:
                return relations

            return f"INFO: Dostępne relacje:\n{relations}"

        # Flaga 'internal' musi być honorowana TAKŻE tutaj: wynik jest wtedy
        # wklejany w środek cudzego komunikatu, więc własny prefiks dałby
        # 'BŁĄD:' zagnieżdżony w 'BŁĄD:' i dwie sprzeczne instrukcje.
        return "(brak)" if internal else "BŁĄD: Nie dodano jeszcze żadnej relacji! Aby dodać relację skorzystaj z 'define_relation'"

    def read_node_relations(self, node_name: str, relation: str | None = None) -> str:
        """
        Wypisuje krawędzie wychodzące z węzła -- wszystkie albo jednego typu.

        Zwraca tylko krawędzie WYCHODZĄCE, bo tylko takie węzeł przechowuje.
        Odpowiedź na pytanie "co wskazuje na ten węzeł" wymaga przejścia całego
        grafu i nie jest tu dostępna.

        Węzeł bez relacji to 'INFO:', nie błąd -- świeżo utworzony węzeł jeszcze
        żadnej nie ma i to jest stan normalny. Natomiast pytanie o KONKRETNY typ,
        którego węzeł nie posiada, jest błędem: model albo pomylił nazwę, albo
        pomylił węzeł, i w obu przypadkach powinien to poprawić.

        :param node_name: nazwa istniejącego węzła
        :param relation: typ relacji do pokazania; None = wszystkie
        """

        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        # POPRAWKA: warunek sprawdzał tylko, czy słownik jest pusty. Typ relacji
        # z pustą listą krawędzi (pozostałość po wywołaniu bez celów) przechodził
        # dalej i był raportowany jako istniejąca relacja.
        active_relations = {k: edges for k, edges in node_in_question.n_relations.items() if edges}

        if not active_relations:
            return (f"INFO: Node '{node_name}' nie posiada jeszcze żadnej relacji. "
                    f"Aby dodać relację użyj 'relationship'")

        # Właściwości krawędzi pokazywane tylko wtedy, gdy istnieją -- '{}' przy
        # każdym celu to sam szum w kontekście modelu.
        # Zagnieżdżone cudzysłowy w f-stringu wymagają Pythona >= 3.12 (PEP 701).
        if relation is None:
            relations = [
                f" - '{k}' -> ({', '.join(f'{edge.target} {edge.r_parameters}' if edge.r_parameters else edge.target for edge in edges)})"
                for k, edges in node_in_question.n_relations.items()
            ]

            return f"OK: Aktualnie, wszystkie relacje node '{node_name}' to:\n{'\n'.join(relations)}"

        # .upper() dopiero tutaj -- wcześniej 'relation' mogło być None i .upper()
        # rzuciłoby AttributeError.
        relation = relation.upper()

        edges = active_relations.get(relation, None)
        if edges is None:
            return (f"BŁĄD: Node '{node_name}' nie posiada relacji '{relation}'."
                    f"Upewnij się, czy na pewno wpisałeś poprawnie lub użyj"
                    f"'read_node_relations' nie podając parametru relation, aby zobaczyć"
                    f"wszystkie relacje danego node")

        targets = ', '.join(
            f'{edge.target} {edge.r_parameters}' if edge.r_parameters else edge.target for edge in edges)

        return f"OK: Relacja '{relation}' dla node '{node_name}' to:\n - {relation} -> ({targets})"

    def err_mess_relation_doesnt_exist(self, relation_name: str, helper: bool = True) -> str:
        """
        Jednolity komunikat o nieistniejącym typie relacji.

        Wydzielony, bo powtarza się w kilku narzędziach i rozjeżdżał się między
        nimi. Domyślnie dokleja listę dostępnych typów: model, który pomylił nazwę,
        bez niej próbuje w kółko tej samej. Typów relacji jest kilka, więc lista
        jest tania -- inaczej niż przy węzłach (patrz 'relationship', helper=False).

        :param relation_name: nazwa, której nie znaleziono
        :param helper: False, gdy wołający sam dokleja kontekst
        """

        mess: str = f"BŁĄD: Relacja '{relation_name}' nie istnieje."

        if helper:
            return mess + (f"\nDostępne relacje:\n{self.read_relationships(internal=True)}\n"
                           f"Aby stworzyć relację użyj: 'define_relation'")

        return mess

    # ------------------------------------------------------------------
    # ETYKIETY
    # ------------------------------------------------------------------

    def define_label(self, label: str) -> str:
        """
        Rejestruje etykietę w zbiorze etykiet dozwolonych do ręcznego nadawania.

        Rejestracja jest krokiem osobnym od nadania (patrz 'add_node_label') celowo.
        Gdyby 'add_node_label' tworzyło etykietę w locie, każda literówka modelu
        stawałaby się nową, poprawną etykietą -- graf zbierałby 'Pilne', 'pilne'
        i 'Pilnie' obok siebie, bez żadnego sygnału, że coś jest nie tak.
        Dwa kroki oznaczają, że literówka przy nadawaniu daje błąd z listą
        prawidłowych nazw.

        W grafie działają trzy rozłączne rodzaje etykiet:
          - SHARED           -- systemowa, nadawana automatycznie każdemu węzłowi
          - C_<NazwaKlasy>   -- wyprowadzana z klasy węzła (patrz 'class_label')
          - pozostałe        -- rejestrowane tutaj i nadawane ręcznie
        Dwie pierwsze grupy są zablokowane, bo nadanie ich ręcznie oznaczałoby
        dwa źródła prawdy: raz etykieta wynikałaby z klasy węzła, raz z decyzji
        modelu, i przy zmianie klasy zostałaby ta druga.

        :param label: nazwa etykiety; musi pasować do IDENTIFIER_PATTERN
        :return: komunikat z prefiksem 'OK:' albo 'BŁĄD:'
        """

        # Nazwa etykiety trafia do zapytania Cypher przez interpolację (Neo4j nie
        # parametryzuje etykiet), więc wzorzec jest zabezpieczeniem, nie kosmetyką.
        if mess := self._validate_name(label):
            return mess

        # Prefiks CLASS_LABEL_PREFIX sprawdza już '_validate_name' -- obowiązuje
        # tam wszystkie rodzaje nazw, więc powtarzanie go tutaj byłoby martwym kodem.

        # SHARED dostaje każdy węzeł automatycznie -- ręczne nadawanie byłoby
        # w najlepszym razie bez skutku, a w najgorszym sugerowałoby modelowi,
        # że etykieta coś rozróżnia.
        if label.casefold() == self.SHARED_LABEL.casefold():
            return (f"BŁĄD: Etykieta '{label}' jest zarezerwowana systemowo - jest już automatycznie "
                    f"nadawana KAŻDEMU node. Nie możesz jej zarejestrować ani nadać ręcznie.")

        # Ponowna rejestracja tej samej etykiety niczego by nie zmieniła (zbiór),
        # ale cichy sukces utwierdzałby model w przekonaniu, że robi coś nowego.
        # Kolizja po znormalizowanej formie, a nie po dokładnym zapisie: 'Pilne'
        # i 'PILNE' to dla modelu ta sama etykieta, a dla Neo4j dwie różne.
        existing_label = next((l for l in self.labels if l.casefold() == label.casefold()), None)
        if existing_label is not None:
            return (f"BŁĄD: Etykieta '{existing_label}' już jest zarejestrowana"
                    f"{f" (podano '{label}' -- różni się tylko wielkością liter)" if existing_label != label else ''}. "
                    f"Aby sprawdzić wszystkie dostępne etykiety użyj 'read_labels'")

        self.labels.add(label)

        return f"OK: Zarejestrowano etykietę '{label}'. Możesz ją teraz przypisywać do node przez 'add_node_label'"

    def add_node_label(self, node_name: str, label: str) -> str:
        """
        Nadaje węzłowi wcześniej zarejestrowaną etykietę.

        Wymóg wcześniejszej rejestracji jest jedynym zabezpieczeniem przed
        nadaniem etykiety systemowej: 'define_label' nie wpuszcza do self.labels
        ani SHARED, ani niczego z prefiksem klasowym, więc metoda nie musi
        powtarzać tamtych sprawdzeń. Jeśli kiedykolwiek pojawi się druga droga
        dopisywania do self.labels, ta ochrona przestanie działać.

        Etykieta już nadana to 'INFO:', nie błąd -- powtórzony przebieg ingestu
        ma przechodzić bez awarii, a zbiór i tak jest idempotentny.

        :param node_name: nazwa istniejącego węzła
        :param label: etykieta zarejestrowana wcześniej przez 'define_label'
        :return: komunikat z prefiksem 'OK:', 'INFO:' albo 'BŁĄD:'
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
        """
        Lista etykiet zarejestrowanych do ręcznego nadawania.

        NIE zawiera etykiet systemowych (SHARED, C_<Klasa>) -- to nie jest lista
        wszystkiego, co węzeł może mieć, tylko lista tego, co model może nadać.
        Etykiety konkretnego węzła pokazuje 'read_node_labels'.

        sorted() zamiast kolejności zbioru: bez tego ta sama zawartość grafu
        dawałaby przy każdym uruchomieniu inaczej ułożoną listę, co utrudnia
        porównywanie logów między przebiegami.

        :param internal: True = sama lista, bez prefiksu, do wklejenia w inny komunikat
        """

        if self.labels:
            labels = '\n'.join([f" - {label}" for label in sorted(self.labels)])

            if internal:
                return labels

            return f"INFO: Dostępne etykiety:\n{labels}"

        # Flaga 'internal' musi być honorowana TAKŻE tutaj: wynik jest wtedy
        # wklejany w środek cudzego komunikatu, więc własny prefiks dałby
        # 'BŁĄD:' zagnieżdżony w 'BŁĄD:' i dwie sprzeczne instrukcje.
        return "(brak)" if internal else "BŁĄD: Nie zarejestrowano jeszcze żadnej etykiety! Aby dodać etykietę skorzystaj z 'define_label'"

    def read_node_labels(self, node_name: str, internal: bool = False) -> str:
        """
        Komplet etykiet konkretnego węzła, z podziałem na trzy źródła.

        Podział jest istotny dla modelu: tylko trzecia grupa ('dodatkowe') jest
        czymś, na co ma wpływ. Wyliczenie wszystkich etykiet jednym ciągiem
        prowokowało próby "poprawiania" etykiety klasowej przez 'add_node_label'.

        Etykieta klasowa wyliczana jest w locie z c_name, a nie odczytywana
        z węzła -- węzeł jej nie przechowuje, bo wynika z klasy i musiałaby być
        aktualizowana przy każdej zmianie c_name.

        :param node_name: nazwa istniejącego węzła
        :param internal: True = sam opis, bez prefiksu
        """

        node_in_question = self.nodes.get(node_name, None)
        if node_in_question is None:
            return self.err_mess_node_doesnt_exist(node_name)

        auto_label = self.class_label(node_in_question.c_name)

        # "(brak)" zamiast pustego miejsca: pusty ciąg wyglądałby dla modelu jak
        # urwany komunikat, a nie jak informacja, że etykiet dodatkowych nie ma.
        manual_labels = ', '.join(sorted(node_in_question.n_labels)) if node_in_question.n_labels else "(brak)"

        info = f"wspólna: {self.SHARED_LABEL}; klasy: {auto_label}; dodatkowe: {manual_labels}"

        return info if internal else f"INFO: Etykiety node '{node_name}' -- {info}"

    def err_mess_label_doesnt_exist(self, label: str, helper: bool = True) -> str:
        """
        Jednolity komunikat o niezarejestrowanej etykiecie.

        Domyślnie dokleja listę dostępnych etykiet: model, który pomylił nazwę,
        bez niej próbuje w kółko tej samej. Etykiet jest niewiele, więc lista jest
        tania -- inaczej niż przy węzłach, gdzie doklejanie pełnego spisu przy
        każdym błędzie zalewa kontekst.

        :param label: nazwa, której nie znaleziono
        :param helper: False, gdy wołający sam dokleja kontekst
        """

        mess: str = f"BŁĄD: Etykieta '{label}' nie jest zarejestrowana."

        if helper:
            return mess + (f"\nDostępne etykiety:\n{self.read_labels(internal=True)}\n"
                           f"Aby zarejestrować etykietę użyj: 'define_label'")

        return mess

    # ------------------------------------------------------------------
    # WALIDACJA WSPÓLNA
    # ------------------------------------------------------------------

    def _validate_name(self, name: str) -> str:
        """
        Wspólna walidacja nazw klas, relacji, etykiet i węzłów.

        Jedno miejsce dla wszystkich rodzajów nazw, bo wszystkie trafiają w Neo4j
        w to samo miejsce: nazwy etykiet i typów relacji nie dają się przekazać
        jako parametry zapytania, więc wchodzą do Cyphera przez interpolację.
        Wzorzec jest tu więc zabezpieczeniem przed wstrzyknięciem, nie kosmetyką.

        Komunikat wymienia wszystkie wymagania naraz, także te, których akurat
        nie złamano. Model dostający samo "nieprawidłowa nazwa" poprawiał losowy
        aspekt i wracał z kolejnym błędem; pełna lista domyka to w jednej turze.

        Osobno wspomniane polskie znaki, bo to najczęstsza przyczyna odrzucenia
        przy korpusie pisanym po polsku ('Błąd', 'Zamówienie').

        Nazwy zarezerwowane sprawdzane są BEZ względu na wielkość liter --
        'MODUL' i 'modul' odnoszą się do tego samego pola systemowego.

        :param name: nazwa do sprawdzenia
        :return: pusty ciąg przy powodzeniu, komunikat 'BŁĄD:' przy odrzuceniu
        """

        if not self.IDENTIFIER_PATTERN.match(name):
            return (f"BŁĄD: Nieprawidłowa nazwa '{name}'!\n"
                    f"Wymagania:\n"
                    f" - Nazwa musi zaczynać się od litery (A-Z lub a-z)\n"
                    f" - Może zawierać tylko litery, cyfry oraz znak podkreślenia (_)\n"
                    f" - Długość może wynosić od 1 do 64 znaków włącznie\n"
                    f" - Polskie znaki (np. ą, ś, ż) nie są dozwolone!")

        # Przestrzeń etykiet automatycznych. Sprawdzenie jest tutaj, a NIE
        # w IDENTIFIER_PATTERN, bo regex zwraca jeden bit: pasuje albo nie.
        # Model dostający za 'C_Cos' ogólne "nieprawidłowa nazwa" plus listę
        # wymagań składniowych zaczyna zgadywać. Osobne sprawdzenie daje osobny,
        # konkretny komunikat. Drugi powód: prefiks jest STAŁĄ klasy -- wpisany
        # w regex byłby zdublowany i rozjechałby się przy zmianie stałej.
        if name.upper().startswith(self.CLASS_LABEL_PREFIX.upper()):
            return (f"BŁĄD: Nazwa '{name}' nie może zaczynać się od '{self.CLASS_LABEL_PREFIX}' -- ten prefiks "
                    f"jest zarezerwowany dla etykiet nadawanych automatycznie z nazwy klasy "
                    f"(patrz 'define_class'). Wybierz nazwę bez tego prefiksu.")

        if name.upper() in {reserved.upper() for reserved in self.RESERVED_PARAMETER_NAMES}:
            return (f"BŁĄD: Nazwa '{name}' jest zarezerwowana systemowo i nie może być "
                    f"nazwą klasy, relacji, etykiety ani parametru!")

        return ''

    @staticmethod
    def __deep_type(parameter: Any) -> str:
        """
        Nazwa typu wartości, z zajrzeniem do środka listy.

        Samo type(x).__name__ dałoby dla listy tylko 'list', a model potrzebuje
        wiedzieć, CO jest w środku -- inaczej po odrzuceniu ['a', 1] nie ma jak
        zgadnąć, który element jest nie taki.

        Lista mieszana opisywana jest przez wyliczenie wszystkich napotkanych
        typów ('list[int, str]'), a nie przez pierwszy z brzegu -- taki opis
        pokazuje modelowi dokładnie to, co ma naprawić.

        Pusta lista dostaje własną nazwę 'list[EMPTY]', bo nie da się z niej
        wyprowadzić typu elementu. To nie jest błąd zapisu, tylko sygnał dla
        _validate_initialize_parameters_type, że taka wartość domyślna
        nie niesie informacji o typie.

        Metoda jest prywatna z podwójnym podkreśleniem (name mangling): służy
        wyłącznie budowaniu komunikatów wewnątrz tej klasy i nie ma być
        nadpisywana w podklasach.

        :param parameter: dowolna wartość
        :return: czytelna nazwa typu, np. 'str', 'list[int]', 'list[EMPTY]'
        """

        if isinstance(parameter, list):
            if len(parameter) == 0:
                return "list[EMPTY]"

            different_types: list[str] = []

            for param in parameter:
                type_name = type(param).__name__
                if type_name not in different_types:
                    different_types.append(type_name)

            return f"list[{', '.join(different_types)}]"

        return type(parameter).__name__

    def _validate_initialize_parameters_type(self, parameters: dict[str, Any]) -> str:
        """
        Sprawdza wartości domyślne PRZY DEFINIOWANIU klasy albo typu relacji.

        Neo4j przechowuje jako właściwość tylko skalary z VALID_TYPES oraz listy
        jednorodne złożone z tych skalarów. Sprawdzenie musi paść tutaj, bo błąd
        wykryty dopiero w sync() wychodziłby setki wywołań później, po zbudowaniu
        całego grafu, i nie dałoby się go przypisać do konkretnej definicji.

        Wszystkie błędy zbierane są do jednej listy zamiast zwracania pierwszego:
        model, który pomylił się w trzech parametrach, ma dostać komplet uwag
        w jednej odpowiedzi, a nie poprawiać po jednym przez trzy tury.

        Dwa sprawdzenia są niezależne i mogą wystąpić razem: typ wartości
        oraz nazwa zarezerwowana.

        :param parameters: {nazwa: wartość domyślna}
        :return: pusty ciąg przy powodzeniu, zbiorczy komunikat przy błędach
        """

        error_messages: list[str] = []

        for name, value in parameters.items():
            if isinstance(value, self.VALID_TYPES):
                continue

            if isinstance(value, list):
                if len(value) > 0:
                    # `type(item) is base_type`, nie isinstance: pod isinstance
                    # bool przechodzi jako int (bool dziedziczy po int), więc
                    # [1, True] zostałoby uznane za jednorodną listę int.
                    # Neo4j zapisze taką listę, ale odczyt wróci z niespójnymi typami.
                    base_type = type(value[0])
                    if all(type(item) is base_type and isinstance(item, self.VALID_TYPES) for item in value):
                        continue

            error_messages.append(
                f"BŁĄD: Parametr '{name}' używa niedozwolonego typu wartości: {self.__deep_type(value)}!")

        # Sprawdzenie nazw ODDZIELNE od _validate_name: tam walidowana jest nazwa
        # samej klasy czy relacji, tutaj nazwy jej parametrów. Bez tego 'modul'
        # przeszedłby jako zwykły parametr i przykrył pole systemowe węzła.
        # POPRAWKA: porównanie było wrażliwe na wielkość liter, więc 'Modul',
        # 'MODULE', 'Node_Id' i 'KLASA' przechodziły jako zwykłe parametry
        # i trafiały do Neo4j obok prawdziwych pól systemowych.
        # _validate_name porównuje po .upper() -- teraz obie ścieżki są spójne.
        reserved_upper = {reserved.upper() for reserved in self.RESERVED_PARAMETER_NAMES}
        reserved_used = sorted(name for name in parameters if name.upper() in reserved_upper)
        if reserved_used:
            reserved_message: str = f"BŁĄD: Nazwy {reserved_used} są zarezerwowane systemowo i nie mogą być nazwą parametru!"

            # Moduł dostaje dodatkowe wyjaśnienie, bo jest jedynym polem systemowym,
            # które model NAPRAWDĘ ma ustawiać -- tylko innym kanałem. Bez tej
            # wskazówki po odrzuceniu próbuje go po prostu pominąć.
            if any(name.upper() in {m.upper() for m in self.MODULE_NAMES} for name in reserved_used):
                reserved_message += f" Moduł należy podać osobnym argumentem 'module' przy tworzeniu node ('merge'), a nie jako parametr klasy."

            error_messages.append(reserved_message)

        if error_messages:
            # Lista dozwolonych typów doklejana RAZ na końcu, nie przy każdym
            # błędnym parametrze -- przy kilku błędach powtarzałaby się kilka razy.
            error_messages.append((f"Dozwolone typy parametrów to: {', '.join(self.VALID_NAMES)}.\n"
                                   f"Sprawdź poprawność przekazanych parametrów i spróbuj ponownie."))

            return '\n'.join(error_messages)

        return ''

    def __validate_parameter_excessive_amount(self, entity_name: str, entity_keys: set[str],
                                              given_parameters: set[str]) -> str:
        """
        Wykrywa parametry spoza definicji klasy albo typu relacji.

        Nadmiarowy parametr jest błędem twardym, bo Neo4j zapisałby go bez
        protestu -- powstałby węzeł z właściwością, o której jego klasa nic nie
        wie, niewidoczną dla niczego, co czyta graf przez definicje klas.

        Komunikat wskazuje obie drogi naprawy (dla klas i dla relacji), bo ta sama
        funkcja obsługuje jedne i drugie i nie wie, z czym ma do czynienia.

        Brakujące parametry NIE są tu sprawdzane -- to sytuacja normalna,
        uzupełniana wartościami domyślnymi przez wołającego.

        :param entity_name: nazwa klasy albo relacji, do komunikatu
        :param entity_keys: parametry zadeklarowane w definicji
        :param given_parameters: parametry podane przez model
        :return: pusty ciąg przy powodzeniu, komunikat 'BŁĄD:' przy nadmiarze
        """

        excessive_params = given_parameters - entity_keys
        if excessive_params:
            return (f"BŁĄD: Podano zbyt dużo parametrów dla: '{entity_name}'."
                    f"Nadmiarowe parametry to: {sorted(excessive_params)}."
                    f"Aby dodać nowe parametry do istniejącej klasy użyj 'add_class_parameters', "
                    f"a dla relacji 'add_relation_parameters'")

        return ''

    def __validate_parameter_types(self, shared_parameters: set[str], entity_parameters: dict[str, Any],
                                   parameters: dict[str, Any]) -> str:
        """
        Porównuje typy podanych wartości z typami wartości domyślnych.

        Typ parametru nie jest nigdzie zadeklarowany wprost -- wynika z typu
        wartości domyślnej podanej przy definiowaniu klasy. Wartość domyślna jest
        więc jednocześnie kontraktem typu i to z nią porównujemy.

        'shared_parameters' zawęża sprawdzanie do części wspólnej, bo tylko dla
        niej istnieją obie strony porównania: parametry pominięte przez model
        dostaną wartość domyślną (poprawną z definicji), a nadmiarowe łapie
        __validate_parameter_excessive_amount.

        Porównanie idzie po NAZWACH typów z __deep_type, nie po samych typach:
        dzięki temu 'list[int]' i 'list[str]' są rozróżnialne, choć oba to 'list'.

        Komunikat podaje dla każdego parametru typ oczekiwany i otrzymany --
        sama informacja "zły typ" zmuszała model do zgadywania, co ma wstawić.

        Zagnieżdżone cudzysłowy w f-stringu wymagają Pythona >= 3.12 (PEP 701).

        :param shared_parameters: nazwy obecne i w definicji, i w wywołaniu
        :param entity_parameters: definicja (wartości domyślne) klasy albo relacji
        :param parameters: wartości podane przez model
        :return: pusty ciąg przy powodzeniu, komunikat 'BŁĄD:' przy niezgodności
        """

        different_parameter_type: dict[str, tuple[str, str]] = {}

        for key in sorted(shared_parameters):
            should_be_parameter_type = self.__deep_type(entity_parameters[key])
            new_parameter_type = self.__deep_type(parameters[key])

            if should_be_parameter_type != new_parameter_type:
                different_parameter_type[key] = (should_be_parameter_type, new_parameter_type)

        if different_parameter_type:
            # POPRAWKA: było "Typu parametrów różnią się od typów" oraz surowe
            # repr listy f-stringów. Teraz jedna pozycja na linię.
            details = '\n'.join(f" - '{k}': oczekiwany {v[0]}, otrzymany {v[1]}"
                                  for k, v in different_parameter_type.items())

            return f"BŁĄD: Typy parametrów różnią się od oczekiwanych:\n{details}"

        return ''

    # ------------------------------------------------------------------
    # synchronizacja Z NEO4J
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # EMBEDDINGI
    # ------------------------------------------------------------------
    # Klasa deklaruje, KTÓRE jej parametry wchodzą do embeddingu
    # ('parameters_to_embed'). Klasa z pustą listą jest w całości wykluczona
    # z wyszukiwania semantycznego -- tak działa klasa Krok: search_semantic
    # ma zwracać procedury i błędy, nie pojedyncze kroki.
    #
    # KOLEJNOŚĆ TEJ LISTY JEST ZNACZĄCA. Tekst do embeddingu składany jest
    # w kolejności 'parameters_to_embed', więc ta sama treść ułożona inaczej
    # daje inny wektor. Dlatego wszystkie operacje na tej liście muszą być
    # deterministyczne (patrz 'add_embedding_parameters').
    # ------------------------------------------------------------------

    @staticmethod
    def __make_embeddings(node_in_question: GraphNode, class_in_question: GraphClassSchema,
                          embed_model: EmbeddingModel) -> bool:
        """
        Liczy wektor dla jednego węzła z parametrów wskazanych przez jego klasę.
        Wywoływane z '_compute_embeddings', czyli z 'sync()' przed zapisem do Neo4j.

        Metoda jest statyczna, bo nie potrzebuje stanu grafu -- dostaje wszystko
        argumentami. Dzięki temu daje się przetestować bez budowania grafu.

        Zwraca bool, a nie wektor: wołający tylko zlicza, ile węzłów udało się
        obsłużyć, a sam wektor i tak trafia do 'node_in_question.embeddings'.
        False oznacza "nie było czego liczyć" (klasa nic nie deklaruje albo węzeł
        nie ma żadnego z zadeklarowanych parametrów) -- to sytuacja normalna,
        nie awaria, więc nie rzucamy wyjątkiem.

        :param node_in_question: węzeł, któremu zostanie ustawione pole 'embeddings'
        :param class_in_question: schemat klasy tego węzła
        :param embed_model: model liczący wektor
        :return: True, jeśli wektor został policzony i przypisany
        """

        if not class_in_question.parameters_to_embed:
            return False

        def prepare_for_vector(parameters: dict[str, Any]) -> str:
            """
            Skleja parametry w tekst do embeddingu.

            Listy rozwijane są w miejscu zamiast repr() całej listy -- '['a', 'b']'
            wniosłoby do wektora nawiasy i cudzysłowy zamiast treści. Elementy
            nietekstowe idą przez repr(), bo str(True) da 'True', a to i tak
            jest tekst, którego model embedujący nie zrozumie lepiej.
            """

            output: list[str] = []

            for k, v in parameters.items():
                if isinstance(v, list):
                    items = [item if isinstance(item, str) else repr(item) for item in v]
                    output.append(f"'{k}': [{', '.join(items)}]")
                else:
                    output.append(f"'{k}': {v}")

            return '\n'.join(output)

        # POPRAWKA: wcześniej brane były wyłącznie 'node.c_parameters'. Parametr
        # dodany do klasy PO utworzeniu węzła (przez 'add_class_parameters')
        # nie istnieje w starych węzłach, więc po cichu wypadał z embeddingu --
        # węzeł miał wektor policzony z niepełnej treści i nikt się o tym nie
        # dowiadywał. Nakładamy domyślne z klasy, tak samo jak robi to
        # '_prepare_nodes' i 'read_node_parameters'.
        #
        # Iterujemy po 'parameters_to_embed', a nie po parametrach węzła --
        # kolejność w tekście musi wynikać z deklaracji klasy, żeby ten sam
        # węzeł zawsze dawał ten sam wektor.
        merged = {**class_in_question.parameters, **node_in_question.c_parameters}

        parameters: dict[str, Any] = {
            k: merged[k]
            for k in class_in_question.parameters_to_embed
            if k in merged
        }

        if not parameters:
            return False

        prepared_text_for_vector_embedding: str = prepare_for_vector(parameters)

        # UWAGA: zakładamy, że embed_model.encode() zwraca LISTĘ wektorów
        # (struktura [[...]]) i bierzemy pierwszy, bo embedujemy jeden tekst.
        # Jeśli Twój EmbedModel zwraca płaski wektor [0.1, 0.2, ...], to
        # embeddings[0] będzie POJEDYNCZĄ LICZBĄ, a błąd wyjdzie dopiero
        # w Neo4j przy zapisie albo -- gorzej -- przy pierwszym wyszukiwaniu.
        # Asercja zamienia to na czytelny błąd w miejscu powstania.
        if embeddings := embed_model.encode(prepared_text_for_vector_embedding):
            first = embeddings[0]

            if not isinstance(first, (list, tuple)):
                raise TypeError(
                    f"embed_model.encode() zwrócił płaską strukturę (pierwszy element to "
                    f"{type(first).__name__}, nie wektor). Ten kod zakłada listę wektorów [[...]]. "
                    f"Sprawdź EmbedModel.encode() -- albo popraw tutaj na 'node.embeddings = embeddings'."
                )

            node_in_question.embeddings = list(first)

            return True

        return False

    def add_embedding_parameters(self, class_name: str, parameters_to_embed: list[str]) -> str:
        """
        Dopisuje parametry klasy do listy tych, z których liczony jest embedding.

        Osobne narzędzie od 'define_class', bo LLM buduje graf przyrostowo:
        definiuje klasę, tworzy węzły, a dopiero potem orientuje się, że do
        wyszukiwania powinno wchodzić jeszcze jedno pole.

        UWAGA: istniejące węzły NIE dostają przeliczonego wektora. Nowa lista
        zadziała dopiero przy następnym 'sync(embed_model=...)'.

        :param class_name: nazwa istniejącej klasy
        :param parameters_to_embed: nazwy parametrów tej klasy do dopisania
        :return: komunikat z prefiksem 'OK:', 'INFO:' albo 'BŁĄD:'
        """

        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return self.err_mess_class_doesnt_exist(class_name)

        class_keys: set[str] = set(class_in_question.parameters.keys())
        class_embed_keys: set[str] = set(class_in_question.parameters_to_embed)
        given_parameters: set[str] = set(parameters_to_embed)

        # Parametr spoza definicji klasy: bez tego sprawdzenia literówka dawałaby
        # klasę, której embedding liczy się z niepełnej treści, bez żadnego sygnału.
        if invalid_keys := given_parameters - class_keys:
            return (f"BŁĄD: Parametry: {', '.join(sorted(invalid_keys))} nie istnieją w klasie '{class_name}'. "
                    f"Przejrzyj dostępne parametry: {', '.join(sorted(class_keys))} i spróbuj ponownie")

        shared_parameters = class_embed_keys & given_parameters

        czesci: list[str] = []
        if shared_parameters:
            czesci.append(f"INFO: Klasa '{class_name}' już posiada parametry przeznaczone do embeddingu: "
                          f"{', '.join(sorted(shared_parameters))}.\n"
                          f"Pominięto dodanie zduplikowanych parametrów embeddingowych.")

        # POPRAWKA: było 'list(given_parameters - shared_parameters)', czyli lista
        # ze ZBIORU. Kolejność zbioru napisów zmienia się MIĘDZY URUCHOMIENIAMI
        # procesu (losowanie hasha), więc ta sama definicja klasy dawała za każdym
        # ingestem inną kolejność 'parameters_to_embed', inny tekst do embeddingu
        # i inne wektory. Score'y wyszukiwania przesuwały się bez zmiany korpusu,
        # co czyni strojenie MIN_SCORE bezcelowym.
        # Zachowujemy kolejność podaną przez wołającego, z pominięciem duplikatów.
        parameters_to_add: list[str] = []
        for name in parameters_to_embed:
            if name not in shared_parameters and name not in parameters_to_add:
                parameters_to_add.append(name)

        # POPRAWKA: wywołanie, które niczego nie dodało, zwracało 'OK: Dodano'.
        # Model dostawał potwierdzenie operacji, która się nie odbyła.
        if not parameters_to_add:
            czesci.append(f"INFO: Nie dodano żadnego nowego parametru embeddingowego do klasy '{class_name}'. "
                          f"Aktualne parametry embeddingowe to: "
                          f"{', '.join(class_in_question.parameters_to_embed)}")

            return '\n'.join(czesci)

        class_in_question.parameters_to_embed += parameters_to_add

        czesci.append(f"OK: Dodano parametry embeddingowe {parameters_to_add} do klasy '{class_name}'. "
                      f"Aktualne parametry embeddingowe to: "
                      f"{', '.join(class_in_question.parameters_to_embed)}")

        # POPRAWKA: sklejenie przez listę zamiast f"{info_message}\nOK:...".
        # Przy pustym 'info_message' poprzednia wersja zwracała komunikat
        # zaczynający się od '\n', przez co sprawdzenie prefiksu nie działało.
        return '\n'.join(czesci)

    def remove_embedding_parameters(self, class_name: str, parameters_to_embed: list[str]) -> str:
        """
        Usuwa parametry z listy embedowanych dla danej klasy.

        Sam parametr w schemacie klasy ('class.parameters') NIE jest usuwany --
        przestaje tylko być brany pod uwagę przy liczeniu wektora. To dwie różne
        operacje: parametr może być dalej potrzebny jako właściwość węzła,
        a jedynie zaśmiecać wyszukiwanie.

        UWAGA: wektory policzone wcześniej NIE są kasowane. Węzły zachowują stary
        embedding do najbliższego 'sync(embed_model=...)', a w Neo4j zostaje on
        nawet po nim, bo apoc.merge niczego nie usuwa.

        POPRAWKA NAZWY: metoda nazywała się 'remove_embeddings_parameters', przy
        'add_embedding_parameters' i 'read_embedding_parameters' w liczbie
        pojedynczej. Nazwa narzędzia trafia wprost do promptu -- niekonsekwencja
        w tym miejscu to realne źródło pomyłek modelu.

        :param class_name: Nazwa klasy
        :param parameters_to_embed: lista nazw parametrów do usunięcia z listy embedowanych
        :return: komunikat z prefiksem 'OK:' albo 'BŁĄD:'
        """

        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            return self.err_mess_class_doesnt_exist(class_name)

        class_embed_keys: set[str] = set(class_in_question.parameters_to_embed)
        given_parameters: set[str] = set(parameters_to_embed)

        # Próba usunięcia czegoś, czego nie ma na liście, to błąd, a nie operacja
        # pusta: model albo pomylił nazwę, albo pomylił klasę, i w obu przypadkach
        # ciche powodzenie utwierdziłoby go w błędzie.
        if not_embedded := given_parameters - class_embed_keys:
            current = ', '.join(class_in_question.parameters_to_embed) or '(brak)'
            return (f"BŁĄD: Parametry {sorted(not_embedded)} nie są aktualnie oznaczone do "
                    f"embeddingu dla klasy '{class_name}'. Aktualnie embedowane: {current}")

        # Filtrowanie listy zamiast odejmowania zbiorów -- zachowuje kolejność
        # pozostałych parametrów, od której zależy treść tekstu do embeddingu.
        class_in_question.parameters_to_embed = [
            p for p in class_in_question.parameters_to_embed if p not in given_parameters
        ]

        remaining = ', '.join(class_in_question.parameters_to_embed) or '(brak)'

        return (f"OK: Usunięto parametry {sorted(given_parameters)} z listy embedowanych dla klasy "
                f"'{class_name}'. Aktualne parametry embeddingowe to: {remaining}")

    def read_embedding_parameters(self, class_name: str, internal: bool = False) -> str:
        """
        Pokazuje, z których parametrów liczony jest embedding danej klasy.

        Pusta lista jest odpowiedzią poprawną, nie błędem -- oznacza klasę
        świadomie wykluczoną z wyszukiwania semantycznego (np. Krok).

        :param class_name: nazwa istniejącej klasy
        :param internal: True = sam opis, bez prefiksu, do wklejenia w inny komunikat
        :return: opis albo komunikat 'BŁĄD:', gdy klasa nie istnieje
        """

        class_in_question = self.classes.get(class_name, None)
        if class_in_question is None:
            # Świadomie z prefiksem także przy internal=True: brak klasy to błąd
            # wołającego, a nie pusty rejestr do wklejenia w cudzy komunikat.
            return self.err_mess_class_doesnt_exist(class_name)

        if not class_in_question.parameters_to_embed:
            info = f"{class_name}: (brak parametrów oznaczonych do embeddingu)"
        else:
            info = f"{class_name}: {', '.join(class_in_question.parameters_to_embed)}"

        return info if internal else f"INFO: {info}"

    def ensure_constraints(self, driver: Driver, database: str = "neo4j") -> None:
        """
        Zakłada ograniczenie unikalności 'node_id' na wspólnej etykiecie SHARED_LABEL.

        To ono sprawia, że apoc.merge.node z kluczem {node_id} działa jak MERGE,
        a nie tworzy duplikatów: bez ograniczenia dwa równoległe zapisy tego samego
        node_id dałyby dwa węzły. Przy okazji Neo4j zakłada indeks, dzięki któremu
        MATCH po node_id w __write_relation_batch nie skanuje całej bazy.

        Zakładane osobno i PRZED zapisem, bo ograniczenie musi istnieć, zanim
        pojawią się dane -- na istniejących duplikatach założenie by się nie powiodło.

        IF NOT EXISTS czyni wywołanie idempotentnym; sync() woła je za każdym razem.

        :param driver: połączenie neo4j
        :param database: nazwa bazy
        """

        driver.execute_query(
            f"CREATE CONSTRAINT unique_node_id_{self.SHARED_LABEL} IF NOT EXISTS "
            f"FOR (n:{self.SHARED_LABEL}) REQUIRE n.node_id IS UNIQUE",
            database_=database,
        )

    def ensure_vector_index(self, driver: Driver, dimensions: int, database: str = "neo4j",
                            index_name: str = "entity_embeddings", similarity: str = "cosine") -> None:
        """
        Jeden indeks wektorowy na wspólnej etykiecie SHARED_LABEL -- obejmuje wszystkie
        klasy naraz, niezależnie od tego, ile ich model kiedykolwiek zdefiniuje.

        To jest właściwy powód istnienia SHARED_LABEL: indeks wektorowy w Neo4j
        zakłada się na JEDNEJ etykiecie. Bez wspólnej etykiety trzeba by zakładać
        osobny indeks na każdą klasę i przeszukiwać je po kolei, scalając wyniki --
        a klasy tworzy LLM, więc ich lista nie jest znana z góry.

        'dimensions' musi zgadzać się z modelem embedding co do jednego wymiaru;
        przy niezgodności Neo4j odrzuci wektor dopiero przy zapisie węzła.
        toInteger() jest konieczne, bo parametr zapytania trafia tu jako liczba
        ogólna, a konfiguracja indeksu wymaga wartości całkowitej.

        :param driver: Połączenie neo4j
        :param dimensions: wymiar wektora (musi zgadzać się z modelem embedding, np. EMBED_MODEL_DIM)
        :param database: nazwa bazy
        :param index_name: nazwa indeksu
        :param similarity: funkcja podobieństwa ('cosine' albo 'euclidean')
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

    def _compute_embeddings(self, embed_model: EmbeddingModel) -> int:
        """
        Liczy embeddingi dla wszystkich węzłów, których klasa ma zdefiniowane
        'parameters_to_embed'. Wywoływane z sync(), PRZED zapisem do bazy.

        Węzły klas bez 'parameters_to_embed' są pomijane celowo -- to mechanizm
        wykluczania całych klas z wyszukiwania semantycznego. Tak działa klasa Krok:
        search_semantic ma zwracać procedury i błędy, nie pojedyncze kroki.

        Liczone lokalnie, przed wysłaniem czegokolwiek do bazy, bo to najwolniejszy
        etap synchronizacji -- błąd modelu embedding ma się objawić zanim
        zaczniemy modyfikować graf.

        :param embed_model: Instancja modelu embedding
        :return: liczba węzłów, dla których policzono embedding
        """

        computed = 0

        for node in tqdm(self.nodes.values(), desc="Liczenie embeddingów"):
            class_schema = self.classes.get(node.c_name)

            # Klasa może nie istnieć (np. po wczytaniu niespójnego grafu) --
            # pomijamy zamiast rzucać, żeby jedna sierota nie blokowała całego sync().
            if class_schema is None or not class_schema.parameters_to_embed:
                continue

            if self.__make_embeddings(node, class_schema, embed_model):
                computed += 1

        return computed

    # Jeżeli chcemy dodać klasę systemową na koniec w sync to robimy to tutaj!
    def _prepare_nodes(self) -> list[dict[str, Any]]:
        """
        Spłaszcza węzły do wierszy gotowych pod UNWIND.

        Kolejność rozpakowania w 'properties' jest ZABEZPIECZENIEM: pola systemowe
        (node_id, klasa, modul) idą PO parametrach użytkownika, więc je przykrywają.
        To druga linia obrony po RESERVED_PARAMETER_NAMES -- gdyby jakimś kanałem
        parametr o nazwie 'modul' przedostał się do węzła, i tak nie nadpisze
        prawdziwego modułu w bazie.

        Etykiety: SHARED_LABEL dla każdego węzła (nośnik indeksu wektorowego),
        etykieta klasy wyliczana w locie z c_name, a na końcu etykiety ręczne.
        sorted() na ręcznych, żeby ten sam graf dawał identyczne wiersze między
        przebiegami -- inaczej porównywanie zrzutów jest bezużyteczne.

        :return: wiersze {"node_id", "labels", "properties"}
        """

        rows: list[dict[str, Any]] = []

        for node_name, node in self.nodes.items():
            labels = [self.SHARED_LABEL, self.class_label(node.c_name), *sorted(node.n_labels)]

            node_class = self.classes.get(node.c_name)
            class_defaults = node_class.parameters if node_class is not None else {}

            properties: dict[str, Any] = {
                **class_defaults,
                **node.c_parameters,
                "node_id": node_name,
                "klasa": node.c_name,
                "modul": node.module,
            }

            # Neo4j nie przyjmuje None jako wartości właściwości -- dopisujemy
            # 'embeddings' TYLKO jeśli faktycznie zostało policzone.
            if node.embeddings is not None:
                properties["embeddings"] = node.embeddings

            rows.append({"node_id": node_name, "labels": labels, "properties": properties})

        return rows

    def _relation_rows(self) -> list[dict[str, Any]]:
        """
        Spłaszcza trójpoziomową strukturę relacji (węzeł -> typ -> krawędzie)
        do płaskiej listy wierszy pod UNWIND.

        Relacje są w pamięci trzymane tylko po stronie źródła, więc jedno przejście
        po wszystkich węzłach wystarcza, żeby zebrać każdą krawędź dokładnie raz.

        :return: wiersze {"from", "to", "type", "properties"}
        """

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

    def sync(self, driver:Driver, database: str = "neo4j", batch_size: int = 500,
             embed_model: EmbeddingModel | None = None, embed_dimensions: int | None = None) -> dict[str, int]:
        """
        Zapisuje CAŁY graf (węzły + relacje) do Neo4j. Idempotentne — bezpieczne
        do wielokrotnego wywołania na tym samym stanie grafu.

        Kolejność etapów nie jest przypadkowa:
          1. ograniczenia -- muszą istnieć, zanim pojawią się dane
          2. embeddingi   -- najdroższy etap, ma paść przed modyfikacją grafu
          3. indeks wektorowy
          4. węzły        -- muszą istnieć, zanim relacje spróbują je dopasować
          5. relacje

        Zapis idzie partiami przez UNWIND, a nie wiersz po wierszu: 312 osobnych
        zapytań to 312 rund do bazy, jedno UNWIND na 500 wierszy to jedna.

        UWAGA: apoc.merge.node USTAWIA właściwości, ale nie kasuje tych, których
        już nie ma w grafie w pamięci. Usunięcie parametru z klasy nie usunie go
        z węzłów zapisanych wcześniej -- na to potrzeba wyczyszczenia bazy.

        :param driver: Połączenie neo4j.graphdatabase.driver (...)
        :param database: nazwa bazy
        :param batch_size: ile wierszy na jeden UNWIND
        :param embed_model: opcjonalna instancja modelu embedding — jeśli podana,
            przed zapisem policzone zostaną embeddingi dla węzłów klas, które je mają
            skonfigurowane, i utworzony indeks wektorowy.
            Jeśli pominięta — embeddingi NIE są liczone.
        :param embed_dimensions: Wymiar wektora, wymagany, jeśli podano embed_model
        :return: {"nodes": ile przetworzono, "relations": ile przetworzono,
            "embeddings": ile policzono}
        """

        self.ensure_constraints(driver, database)

        embeddings_computed = 0
        if embed_model is not None:
            # Wyjątek, nie cichy default: zgadnięty wymiar wektora dałby indeks,
            # do którego nie da się nic zapisać, a błąd wyszedłby dopiero
            # przy pierwszym wyszukiwaniu.
            if embed_dimensions is None:
                raise ValueError(
                    "Podano 'embed_model', ale nie podano 'embed_dimensions' -- wymagane do utworzenia indeksu wektorowego.")

            embeddings_computed = self._compute_embeddings(embed_model)
            self.ensure_vector_index(driver, dimensions=embed_dimensions, database=database)

        node_rows = self._prepare_nodes()
        relation_rows = self._relation_rows()

        written_nodes, written_relations = 0, 0

        # Jedna sesja na całą synchronizację; execute_write daje transakcję
        # na partię, więc błąd w środku wycofuje tylko tę partię, nie cały zapis.
        with driver.session(database=database) as session:
            with tqdm(total=len(node_rows), desc="Zapisywanie węzłów") as pbar:
                for i in range(0, len(node_rows), batch_size):
                    chunk = node_rows[i: i + batch_size]
                    written_nodes += session.execute_write(self.__write_node_batch, chunk)
                    pbar.update(len(chunk))

            # Relacje DOPIERO po węzłach: MATCH po obu końcach musi mieć co dopasować.
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
        """
        Zapisuje partię węzłów przez apoc.merge.node.

        APOC zamiast czystego MERGE, bo etykiety w Cypherze nie dają się
        parametryzować -- każdy zestaw etykiet wymagałby osobnego zapytania
        sklejanego ze stringów, a klasy tworzy LLM, więc lista nie jest znana z góry.

        Argumenty: (etykiety, klucz identyfikujący, właściwości onCreate, onMatch).
        Te same właściwości w obu rolach = zapis idempotentny, gdzie ponowny sync()
        aktualizuje węzeł do stanu z pamięci, niezależnie od tego, czy już istniał.

        :return: liczba PRZETWORZONYCH wierszy (nie: nowo utworzonych węzłów)
        """

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
        Zapisuje partię relacji przez apoc.merge.relationship.

        Typ relacji jest w Cypherze tak samo nieparametryzowalny jak etykieta --
        stąd znowu APOC, który przyjmuje go jako zwykłą wartość.

        Pusty słownik jako klucz identyfikujący oznacza, że krawędź jest
        rozpoznawana po samej trójce (źródło, typ, cel). Między dwoma węzłami
        istnieje więc najwyżej jedna krawędź danego typu -- zgodnie z tym, co
        wymusza już 'relationship' po stronie pamięci.

        MATCH po obu końcach: wiersz wskazujący na nieistniejący węzeł zostaje
        POMINIĘTY BEZ BŁĘDU. Rozjazd między len(relation_rows) a zwróconą liczbą
        jest jedynym sygnałem, że coś nie doszło -- warto go sprawdzać po sync().

        :param shared_label: etykieta przekazana argumentem, nie odczytana z klasy,
            bo metoda jest statyczna (wymóg execute_write)
        :return: liczba zapisanych krawędzi
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

    # ------------------------------------------------------------------
    # SEARCH
    # ------------------------------------------------------------------
    # Metody wyszukiwania są @classmethod, bo potrzebują wyłącznie SHARED_LABEL,
    # a nie stanu grafu w pamięci. Dzięki temu API może odpytywać Neo4j bez
    # trzymania całego grafu po stronie Pythona.

    @classmethod
    def search_semantic(cls, driver: Driver, query_embedding: list[float], top_k: int = 5,
                        module: str | None = None, database: str = "neo4j",
                        index_name: str = "entity_embeddings") -> list[dict[str, Any]]:
        """
        Wyszukiwanie semantyczne po CAŁYM grafie (indeks na SHARED_LABEL, więc
        niezależnie od klasy).

        Przyjmuje GOTOWY WEKTOR, nie tekst -- policzenie embeddingu należy do
        wołającego. Mieszanie tych dwóch odpowiedzialności kosztowało już TypeError
        przy pierwszym /assistant/ask.

        Jeśli podano 'module', wyniki są filtrowane po właściwości 'modul' PO
        STRONIE PYTHONA -- pobieramy pięciokrotnie więcej surowych wyników niż
        top_k (over-fetch), żeby filtr nie obcinał trafnych wyników zbyt wcześnie.
        Filtrowanie po stronie Pythona jest bezpieczne niezależnie od wersji Neo4j:
        nie polega na natywnym filtrowanym wyszukiwaniu wektorowym, dostępnym
        dopiero w najnowszych wydaniach.

        UWAGA: 'module' NIE jest domyślnym trybem pracy asystenta. Moduł jest
        preferencją planera, a nie filtrem wyszukiwania -- użytkownik stojący na
        jednym ekranie ma prawo zapytać o cokolwiek. Ten parametr istnieje dla
        wywołań, które świadomie chcą zawęzić zakres.

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

            # casefold(), nie lower(): poprawnie obsługuje znaki spoza ASCII,
            # a moduły bywają pisane po polsku.
            # (props.get(...) or "") zamiast props.get(..., ""): domyślna wartość
            # broni tylko przed BRAKIEM klucza. Węzeł ze starego formatu grafu ma
            # klucz 'modul' o wartości None, a None.casefold() to AttributeError
            # w środku /assistant/ask.
            if module is not None and (props.get("modul") or "").casefold() != module.casefold():
                continue

            results.append({
                "node_id": r["node_id"],
                "klasa": r["klasa"],
                "score": r["score"],
                "properties": props,
            })

            # Przerywamy po zebraniu top_k -- reszta over-fetchu jest już niepotrzebna.
            if len(results) >= top_k:
                break

        return results

    @classmethod
    def explore_neighbors(cls, driver: Driver, node_id: str, hops: int = 2,
                          relation_types: list[str] | None = None,
                          limit: int = 50, database: str = "neo4j") -> dict[str, Any]:
        """
        Multi-hop: eksploruje sąsiedztwo danego węzła do 'hops' kroków w głąb.

        apoc.path.subgraphAll zamiast surowego Cyphera, bo granic ścieżki zmiennej
        długości nie da się przekazać parametrem -- w czystym Cypherze trzeba by
        wkleić je do zapytania jako tekst. APOC przyjmuje całą konfigurację
        (głębokość, limit, filtr typów) jako zwykły parametr mapy.

        'limit' jest zabezpieczeniem przed eksplozją: kroki współdzielone przez
        wiele procedur są węzłami o wysokim stopniu, więc dwa przeskoki od takiego
        węzła potrafią objąć znaczną część grafu.

        Sąsiedztwo jest NIESKIEROWANE -- wynik obejmuje też węzły wskazujące na
        podany, nie tylko te, na które on wskazuje.

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
            # Składnia filtru APOC: typy rozdzielone '|'.
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

        # Brak rekordów oznacza, że nie znaleziono węzła startowego. Pusty wynik
        # zamiast wyjątku, bo to wywołanie idzie z narzędzia @tool -- model ma
        # zobaczyć "nic nie znaleziono", a nie zerwaną pętlę.
        if not records:
            return {"nodes": [], "relationships": []}

        record = records[0]

        nodes_out = []
        for n in record["nodes"]:
            props = dict(n)
            props.pop("embeddings", None)  # wektor nigdy nie trafia do kontekstu modelu
            nodes_out.append({"node_id": props.get("node_id"), "klasa": props.get("klasa"), "properties": props})

        relationships_out = []
        for r in record["relationships"]:
            # start_node/end_node dają kierunek krawędzi, którego sama lista
            # węzłów nie niesie -- bez tego nie da się odtworzyć struktury.
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
        Najkrótsza ścieżka między dwoma ZNANYMI węzłami — natywna funkcja Cyphera
        shortestPath(), bez potrzeby APOC.

        Górna granica długości ścieżki jest jedyną wartością wklejaną do zapytania
        jako tekst -- Cypher nie parametryzuje granic ścieżki zmiennej długości.
        int() jest tu zabezpieczeniem przed wstrzyknięciem: wartość, której nie da
        się zamienić na liczbę, rzuca ValueError zamiast trafić do zapytania.

        Ścieżka jest NIESKIEROWANA -- '-[*..n]-' przechodzi krawędzie w obie strony.
        Przy krokach współdzielonych przez kilka procedur oznacza to, że najkrótsza
        ścieżka potrafi przejść "w górę" do jednej procedury i "w dół" do innej.
        Wynik jest poprawny jako połączenie w grafie, ale niekoniecznie sensowny
        jako sekwencja działań użytkownika -- do planowania służy plan.py.

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

        # None, nie pusta lista: brak połączenia to inna informacja niż ścieżka
        # o zerowej długości i wołający musi móc je rozróżnić.
        if not records:
            return None

        record = records[0]
        path_nodes = record["path_nodes"]
        path_rels = record["path_rels"]

        # Ścieżka jako naprzemienna sekwencja węzeł-relacja-węzeł: relacji jest
        # zawsze o jedną mniej niż węzłów, stąd warunek na ostatnim elemencie.
        steps: list[dict[str, Any]] = []
        for i, node in enumerate(path_nodes):
            props = dict(node)
            props.pop("embeddings", None)
            steps.append({"type": "node", "node_id": props.get("node_id"), "klasa": props.get("klasa")})

            if i < len(path_rels):
                steps.append({"type": "relationship", "relation": path_rels[i].type})

        return steps

    def clear(self) -> None:
        """
        Czyści graf W PAMIĘCI. Nie dotyka Neo4j -- po clear() i ponownym sync()
        w bazie zostaną węzły z poprzedniego przebiegu, bo apoc.merge niczego
        nie kasuje. Do wyczyszczenia bazy potrzebne jest osobne zapytanie.
        """

        self.nodes.clear()
        self.relations.clear()
        self.classes.clear()
        self.labels.clear()