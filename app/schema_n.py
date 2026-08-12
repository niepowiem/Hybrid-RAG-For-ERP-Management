from pydantic import BaseModel, Field, field_validator, ConfigDict, model_validator
from typing import Any, Literal
import re

class NavigateAction(BaseModel):
    kind: Literal["navigate"]                       # Autopilot przechodzi pod wskazaną trasę
    route: str                                      # Ścieżka w aplikacji np.: /purchase-orders

class ClickAction(BaseModel):
    kind: Literal["click"]                          # Autopilot klika w element
    anchor: str | None = None                       # Anchor wskazuje na obiekt strony, który następnie podświetlimy lub wykonamy na nim akcję

class FillAction(BaseModel):
    kind: Literal["fill"]                           # Autopilot wpisuje USTALONĄ wartość
    anchor: str | None = None                       # Anchor wskazuje na obiekt strony, który następnie podświetlimy lub wykonamy na nim akcję
    value: str                                      # Wartość wpisywana dosłownie

class SelectAction(BaseModel):
    kind: Literal["select"]                         # Autopilot wybiera pozycję z listy
    anchor: str | None = None                       # Anchor wskazuje na obiekt strony, który następnie podświetlimy lub wykonamy na nim akcję
    label: str                                      # Etykieta opcji; front mapuje ją na wartość techniczną

class AskAction(BaseModel):
    """
    Autopilot ZATRZYMUJE SIĘ i pyta użytkownika o wartość, zamiast wpisywać
    ustaloną. Używaj wszędzie, gdzie wartość zależy od użytkownika (ilość, numer faktury, wybór kontrahenta)

    'fill' zostaw dla wartości wynikających z procedury (np. filtr, który ma być ustawiony konkretnie)
    """

    model_config = ConfigDict(populate_by_name=True)

    kind: Literal["ask"]                            # Autopilot zadaje pytanie
    anchor: str | None = None                       # Anchor wskazuje na obiekt strony, który następnie podświetlimy lub wykonamy na nim akcję
    input_type: Literal["text", "number", "date", "select"] = Field(alias="inputType")
    label: str                                      # Pytanie zadawane użytkownikowi, np.: "Ile sztuk zamawiasz?"
    hint: str | None = None                         # Wyjaśnienie, czym jest to pole i jak je wypełnić

# Pole action w kroku. Pydantic wybiera wartości po kind
# Warianty wymagające elementu na stronie. 'navigate' jako jedyny go nie potrzebuje
STEP_ACTION = NavigateAction | ClickAction | FillAction | SelectAction | AskAction
ACTIONS_REQUIRING_ANCHOR: tuple[str, ...] = ("click", "fill", "select", "ask")

class ProcedureStep(BaseModel):
    text: str = Field(min_length=3)                 # Text opisuje dany krok np.: 1. Przejdź do modułu "Zakupy"
    anchor: str | None = None                       # Anchor wskazuje na obiekt strony, który następnie podświetlimy lub wykonamy na nim akcję
    action: STEP_ACTION | None = Field(default=None, discriminator="kind")
    note: str | None = None                         # Note to uwaga poboczna dla użytkownika widziana pod Text
    optional: bool = False                          # Optional oznacza krok warunkowy ("jeśli..."): planer nie traktuje jego 'requires' jako wymagań całej procedury i nie użyje go do osiągnięcia celu
    requires: list[str] = []                        # Requires mówi modelowi, co potrzeba do wykonania kroku
    provides: list[str] = []                        # Provides mówi modelowi, co dany etap daje użytkownikowi
    why: str | None = None                          # Służy do wyjaśnienia, co robi dany krok w bańce pomocniczej użytkownika

    @model_validator(mode="after")
    def _check_anchor(self) -> "ProcedureStep":
        # Akcja bez elementu docelowego jest niewykonalna: autopilot nie ma w co kliknąć
        # Łapiemy to przy wczytywaniu korpusu, a nie w przeglądarce.
        if self.action is not None and self.action.kind in ACTIONS_REQUIRING_ANCHOR:
            if not (getattr(self.action, "anchor", None) or self.anchor):
                raise ValueError(f"Krok '{self.text[:40]}' ma akcję '{self.action.kind}' bez anchora!"
                                 f"Podaj 'anchor' w kroku albo w akcji")

        return self

class Procedure(BaseModel):
    id: str                                         # Z niego powstaje nazwa węzła np.:proc.magazyn.pz -> proc_magazyn_pz
    title: str                                      # Tytuł dla użytkownika, podawany modelowi przy wyborze procedury
    module: str                                     # Pole systemowe grafu. Po nim filtrowane jest wyszukiwanie
    summary: str = Field(min_length=16)             # Trafia do embedding-u, więc decyduje o trafności wyszukiwania
    query: list[str] = []                           # Sformułowania, jakimi użytkownik może zapytać (tylko wyszukiwanie)
    preconditions: list[str] = []                   # Warunki wstępne po ludzku. Wersja maszynowa to requires na krokach
    roles: list[str] = []                           # Dziś tylko wyszukiwanie. Twardy wymóg zapisuje się jako stan (rola.kierownik)
    steps: list[ProcedureStep] = Field(min_length=1)# Kroki do podążania dla autopilota
    verification: str | None = None                 # Po czym użytkownik pozna, że się udało
    common_errors: list[str] = []                   # Z nich powstają powiązania błąd -> procedura naprawcza
    goal: list[str] = []                            # Stany oznaczające, że procedura się udała. Planer musi osiągnąć wszystkie stany

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        if not re.fullmatch(r"proc\.[a-z0-9-]+\.[a-z0-9-]+", value):
            raise ValueError(f"Złe id procedury: {value} (wzorzec: proc.modul.nazwa)")

        return value

    @model_validator(mode="after")
    def _check_goal_reachable(self) -> "Procedure":
        # Cel, którego żaden krok nie wytwarza, jest nieosiągalny
        # Planer zgłosiłby to dopiero przy pierwszym zapytaniu użytkownika
        procedure = {stan for step in self.steps for stan in step.provides}

        if missing := set(self.goal) - procedure:
            raise ValueError(f"Procedura {self.id}: cel {sorted(missing)} nie jest "
                             f"wytwarzany przez żaden krok (sprawdź pola 'provides')")

        return self

    def __repr__(self):
        return str(self.model_dump(exclude_none=True))

class ErrorSolution(BaseModel):
    solution: list[str] = Field(min_length=1)       # Kroki rozwiązania opisane po ludzku
    ref: list[str] | None = None                    # Id procedur rozwiązujących problem (proc.modul.nazwa)

class Error(BaseModel):
    id: str                                         # Kod błędu w formacie ERR-xxxx; z niego powstaje nazwa węzła (ERR-1004 -> ERR_1004)
    module: str                                     # Moduł ERP, w którym błąd występuje
    query: str                                      # Komunikat o błędzie widziany przez użytkownika. Główny tekst do wyszukiwania
    causes: list[str] = Field(min_length=1)         # Możliwe przyczyny. To je asystent tłumaczy użytkownikowi
    solutions: list[ErrorSolution] = []             # Warianty rozwiązania. Każdy może wskazywać procedurę naprawczą

    @field_validator("id")
    @classmethod
    def _sprawdz_id(cls, value: str) -> str:
        if not re.fullmatch(r"ERR-\d{3,5}", value):
            raise ValueError(f"Złe id błędu: {value} (wzorzec: np. ERR-1004)")

        return value

    def __repr__(self):
        return str(self.model_dump(exclude_none=True))

class Concept(BaseModel):
    id: str                                         # Identyfikator w formacie concept.nazwa
    module: str                                     # Moduł ERP, którego pojęcie dotyczy
    title: str                                      # Nazwa pojęcia, np. "Indeks produktu (SKU)"
    aliases: list[str]                              # Synonimy i potoczne określenia, po których użytkownik faktycznie pyta
    body: str = Field(min_length=32)                # Wyjaśnienie pojęcia. To ono trafia do odpowiedzi, gdy pytanie nie dotyczy procedury

    @field_validator("id")
    @classmethod
    def _sprawdz_id(cls, value: str) -> str:
        if not re.fullmatch(r"concept\.[a-z0-9-]+", value):
            raise ValueError(f"Złe id koncepcji: {value} (wzorzec: concept.nazwa)")

        return value

    def __repr__(self):
        return str(self.model_dump(exclude_none=True))

# Typ dokumentu bazy wiedzy. Wszystkie trzy klasy trafiają do grafu i do
# wyszukiwania semantycznego, ale tylko Procedure ma kroki dla autopilota.
KB_DATATYPE = Procedure | Error | Concept

def prepare_for_vector_embedding(document: KB_DATATYPE) -> str:
    """
    Tekst, z którego liczony jest wektor. Celowo WĘŻSZY niż całość dokumentu:
    im więcej szumu, tym słabsze dopasowanie semantyczne.
    """

    output: list[str] = []

    if isinstance(document, Procedure):
        output = [
            document.title,
            document.summary,
            *document.query,
            *document.preconditions
        ]

    elif isinstance(document, Error):
        output = [
            document.id,
            document.query,
            *document.causes,
        ]

    elif isinstance(document, Concept):
        output = [
            document.title,
            *document.aliases,
            document.body
        ]

    else:
        raise ValueError(f"document type: ({type(document)}) is not of KB_DATATYPE")

    return '\n'.join(output)

def prepare_for_lexical_search(document: KB_DATATYPE) -> str:
    """
    Tekst do wyszukiwania po słowach kluczowych. Tu odwrotnie niż przy wektorze:
    bierzemy WSZYSTKO, bo dopasowanie dosłowne nie cierpi od nadmiaru.
    """

    output: list[str] = []

    if isinstance(document, Procedure):
        output = [
            document.id,
            document.title,
            document.module,
            document.summary,
            *document.query,
            *document.preconditions,
            *document.roles,
            *[step.text for step in document.steps],
            *[step.why for step in document.steps if step.why],
            *[step.note for step in document.steps if step.note],
            *document.common_errors,
        ]

        if document.verification:
            output.append(document.verification)

    elif isinstance(document, Error):
        output = [
            document.id,
            document.module,
            document.query,
            *document.causes,
            *[step for error_solution in document.solutions for step in error_solution.solution],
            *[ref for error_solution in document.solutions for ref in (error_solution.ref or [])],
        ]

    elif isinstance(document, Concept):
        output = [
            document.id,
            document.module,
            document.title,
            *document.aliases,
            document.body
        ]

    else:
        raise ValueError(f"document type: ({type(document)}) is not of KB_DATATYPE")

    return '\n'.join(output)

def prepare_for_prompt(document: KB_DATATYPE) -> str:
    """
    Czytelne przedstawienie dokumentu dla modelu językowego. Pomija pola czysto
    maszynowe (stany, anchory, akcje) -- model ich nie potrzebuje, a zajmują kontekst.
    """

    output: list[str] = []

    if isinstance(document, Procedure):
        output = [
            f'[{document.id}] ({document.title})',
            document.summary
        ]

        if document.roles:
            output.append(f'Role: ' + ', '.join(document.roles))

        if document.preconditions:
            output.append("Warunki wstępne:\n- " + "\n- ".join(document.preconditions))

        # Kroki
        output.append(f'Kroki:')
        for i, step in enumerate(document.steps, 1):
            lines = [f'{i}. {step.text}' + (" (krok opcjonalny)" if step.optional else "")]

            if step.why:
                lines.append(f'    Po co: {step.why}')

            if step.note:
                lines.append(f'    ({step.note})')

            output.append('\n'.join(lines))

        if document.verification:
            output.append(f"Weryfikacja: {document.verification}")

    elif isinstance(document, Error):
        output = [
            f'[{document.id}] ({document.query})',
            "Przyczyny:\n- " + "\n- ".join(document.causes),
        ]

        if document.solutions:
            for i, solution in enumerate(document.solutions, 1):
                output.append(f'Rozwiązanie #{i}:')

                output.append('\n'.join(solution.solution))

                if solution.ref:
                    output.append('\n'.join(solution.ref))

    elif isinstance(document, Concept):
        output = [
            f'[{document.id}] ({document.title})',
            document.body
        ]

    else:
        raise ValueError(f"document type: ({type(document)}) is not of KB_DATATYPE")

    return '\n'.join(output)