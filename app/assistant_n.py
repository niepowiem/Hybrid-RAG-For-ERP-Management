"""
assistant_n.py -- warstwa odpowiedzi asystenta. Produkuje strukturę zgodną
z AssistantReply z packages/shared/src/assistant.ts.

Podział odpowiedzialności, wynikający wprost z kontraktu ("tekst kroku dosłownie
z korpusu wiedzy, nie generowany przez model"):

    graf  -> steps[], sources[]     (deterministycznie, bit w bit)
    LLM   -> text, wybór procedur   (tylko zdanie wprowadzające i decyzja)

Model nigdy nie pisze treści kroków ani anchorów. Jeśli graf nie ma pasującej
procedury, zwracamy refused=True -- odmowa jest lepsza niż zmyślona procedura.

Trzy wejścia publiczne:
    answer()         -- pytanie użytkownika -> AssistantReply
    recovery_plan()  -- kod błędu z autopilota -> kroki naprawcze
    get_index()      -- bufor indeksu kroków (przeładuj po ingeście)
"""

from __future__ import annotations

import os
from typing import Any

from app import graph_n as graph
from app.core_n import AGENT_MODEL, ChatModel, GenerationOptions
from app.plan_n import (
    STEP_CLASS,
    full_plan,
    goal_states,
    load_step_index,
    parse_action,
    related_procedures,
    resolving_procedures,
)

# ======================================================================
# STROJENIE
# ======================================================================

# Poniżej progu podobieństwa uznajemy, że korpus nie zawiera odpowiedzi.
# Wartość DO STROJENIA na realnych zapytaniach: ustaw ją powyżej najlepszego
# trafienia dla pytań spoza korpusu i poniżej najgorszego dla sensownych.
MIN_SCORE: float = float(os.getenv("ASSISTANT_MIN_SCORE", "0.5"))

TOP_K: int = int(os.getenv("ASSISTANT_TOP_K", "5"))

# Nadmiarowe wyniki pobierane po to, by odsianie węzłów Krok nie zostawiło pustki.
EXTRA_K: int = int(os.getenv("ASSISTANT_EXTRA_K", "10"))

# Ile procedur maksymalnie łączymy w jeden plan. Powyżej tego zadanie przestaje
# być "zrób A i B", a zaczyna być listą życzeń, której użytkownik i tak nie
# wykona jednym kliknięciem.
MAX_PROCEDURES: int = int(os.getenv("ASSISTANT_MAX_PROCEDURES", "4"))

# Właściwości systemowe węzła -- nie pokazujemy ich modelowi ani użytkownikowi.
_SYSTEM_KEYS: frozenset[str] = frozenset({"node_id", "klasa", "modul", "embeddings"})

REFUSAL_TEXT: str = "Nie znalazłem tego w bazie wiedzy."
REFUSAL_HINT: str = " Mogę natomiast pomóc z tym: "

# Opcje generowania dla krótkich, deterministycznych odpowiedzi pomocniczych.
_SHORT_ANSWER = GenerationOptions(temperature=0.1, top_p=0.9, max_response_tokens=400)

# ======================================================================
# KONTEKST UI -> STANY GRAFU
# ======================================================================
# Sonda kontekstu (web/src/assistant/context.ts) przysyła: route, routeTitle,
# role, buildVersion, visibleActions[], form.fields[], lastError, strugglingWith.
# Nie przysyła statusów encji, stąd wnioskowanie pośrednie poniżej.

# Trasa -> stany pewne. Wzorce ':id' obsługuje 'normalize_route'.
ROUTE_STATES: dict[str, set[str]] = {
    "/": {"ekran.stany"},
    "/documents": {"ekran.dokumenty"},
    "/documents/new": {"ekran.dokumenty", "dokument.nowy"},
    "/documents/:id": {"ekran.dokumenty"},
    "/products": {"ekran.produkty"},
    "/counterparties": {"ekran.kontrahenci"},
    "/locations": {"ekran.lokalizacje"},
    "/stocktakes": {"ekran.inwentaryzacja"},
    "/stocktakes/:id": {"ekran.inwentaryzacja", "inw.arkusz-otwarty", "inw.arkusz-wybrany"},
    "/purchase-orders": {"ekran.zamowienia-zakupu"},
    "/purchase-orders/new": {"ekran.zamowienia-zakupu", "zz.nowe"},
    "/purchase-orders/:id": {"ekran.zamowienia-zakupu"},
    "/purchase-invoices": {"ekran.faktury-zakupu"},
    "/purchase-invoices/new": {"ekran.faktury-zakupu", "fz.nowa"},
    "/purchase-invoices/:id": {"ekran.faktury-zakupu"},
    "/sales-orders": {"ekran.zamowienia-sprzedazy"},
    "/sales-orders/new": {"ekran.zamowienia-sprzedazy", "zs.nowe"},
    "/sales-orders/:id": {"ekran.zamowienia-sprzedazy"},
}

# Trasa -> moduł. Używane WYŁĄCZNIE jako preferencja planera, nigdy jako filtr
# wyszukiwania: użytkownik stojący na /documents ma prawo zapytać o lokalizacje.
ROUTE_MODULE: dict[str, str] = {
    "/": "magazyn",
    "/documents": "magazyn",
    "/products": "magazyn",
    "/locations": "lokalizacje",
    "/stocktakes": "inwentaryzacja",
    "/purchase-orders": "zakupy",
    "/purchase-invoices": "zakupy",
    "/sales-orders": "sprzedaz",
    "/counterparties": "sprzedaz",
}

# Widoczny i aktywny przycisk zdradza status encji, którego kontekst nie przysyła.
# Przykład: 'btn.so-fulfil' pojawia się tylko na zamówieniu Potwierdzonym.
# ZAŁOŻENIE do weryfikacji na realnych logach: te przyciski są ukrywane albo
# blokowane w pozostałych statusach.
ACTION_STATES: dict[str, set[str]] = {
    "btn.document-confirm": {"dokument.nowy"},
    "btn.po-send": {"zz.zapisane"},
    "btn.po-receive": {"zz.wyslane"},
    "btn.po-show-document": {"zz.zrealizowane"},
    "btn.so-confirm": {"zs.zapisane"},
    "btn.so-fulfil": {"zs.potwierdzone"},
    "btn.so-show-document": {"zs.zrealizowane"},
    "btn.stocktake-close": {"inw.arkusz-otwarty"},
    "btn.pi-book": {"fz.zapisana"},
}

ROLE_STATES: dict[str, set[str]] = {
    "kierownik": {"rola.kierownik", "rola.magazynier"},
    "magazynier": {"rola.magazynier"},
}

# ======================================================================
# PROMPTY POMOCNICZE
# ======================================================================

_PICK_SYSTEM: str = (
    "Wybierasz dokumenty potrzebne do wykonania zadania użytkownika.\n\n"
    "NAJCZĘŚCIEJ WYSTARCZA JEDEN. Wypisz kilka tylko wtedy, gdy zadanie zawiera "
    "wyraźnie odrębne czynności połączone spójnikiem ('utwórz zamówienie I wystaw "
    "fakturę'). Wtedy podaj je po jednym w linii, W KOLEJNOŚCI WYKONANIA.\n\n"
    "NIE dopisuj procedur, które są tylko warunkiem wstępnym wybranej -- system "
    "dobierze je sam. Jeśli zadanie brzmi 'zrealizuj zamówienie', wybierz procedurę "
    "REALIZACJI, a nie utworzenia i potwierdzenia.\n\n"
    "Zwracaj uwagę na moduł: 'wysłać towar do KLIENTA' to sprzedaż, "
    "'zamówić towar U DOSTAWCY' to zakupy. Nie mieszaj modułów bez potrzeby.\n\n"
    "Odpowiadasz WYŁĄCZNIE identyfikatorami, dokładnie tak, jak podane, "
    "albo słowem BRAK, jeśli żaden nie pasuje. Bez wyjaśnień i formatowania."
)

_INTRO_SYSTEM: str = (
    "Piszesz JEDNO krótkie zdanie wprowadzające do instrukcji w systemie ERP. "
    "Nie wymieniaj kroków -- użytkownik zobaczy je pod spodem. "
    "Nie dodawaj powitań ani pytań. Maksymalnie 20 słów, po polsku."
)

_CONCEPT_SYSTEM: str = (
    "Odpowiadasz na pytanie o system ERP wyłącznie na podstawie podanego materiału. "
    "Nie dodawaj informacji spoza materiału. Jeśli materiał nie zawiera odpowiedzi, "
    "napisz dokładnie: BRAK. Odpowiadaj zwięźle, po polsku, maksymalnie 4 zdania."
)

# ======================================================================
# BUFOR INDEKSU
# ======================================================================
# Indeks kroków zmienia się TYLKO przy ingeście, a wczytanie kosztuje jedno
# zapytanie do bazy -- trzymamy go w pamięci procesu.

_INDEX_CACHE: dict[str, dict[str, Any]] | None = None
_ANCHOR_STATES_CACHE: dict[str, set[str]] | None = None


def get_index(reload: bool = False) -> dict[str, dict[str, Any]]:
    """
    Zwraca (i buforuje) indeks kroków.

    :param reload: wymusza ponowne wczytanie. Wołaj po każdym ingeście, inaczej
        działający serwer pokazuje kroki sprzed przebudowy grafu.
    """

    global _INDEX_CACHE, _ANCHOR_STATES_CACHE

    if _INDEX_CACHE is None or reload:
        _INDEX_CACHE = load_step_index(graph.graph_driver)
        _ANCHOR_STATES_CACHE = None

    return _INDEX_CACHE


def anchor_states(index: dict[str, dict[str, Any]] | None = None) -> dict[str, set[str]]:
    """
    Mapa anchor -> stany, WYPROWADZONA Z KORPUSU. Nie piszemy jej ręcznie:
    'form.fields[].id' z sondy kontekstu to dokładnie te same 'data-assistant-id',
    które stoją przy krokach w YAML-u.

    Anchory niejednoznaczne są POMIJANE. Przykład: 'field.document-type' daje
    'dokument.typ-pz' w jednej procedurze i 'dokument.typ-wz' w innej -- samo
    "pole jest wypełnione" nie mówi, którą wartość wybrano.
    """

    global _ANCHOR_STATES_CACHE

    if _ANCHOR_STATES_CACHE is not None and index is None:
        return _ANCHOR_STATES_CACHE

    index = index if index is not None else get_index()
    candidates: dict[str, list[frozenset[str]]] = {}

    for step in index.values():
        anchor = step.get("anchor")

        if anchor and step.get("provides"):
            candidates.setdefault(anchor, []).append(frozenset(step["provides"]))

    result = {anchor: set(variants[0]) for anchor, variants in candidates.items()
              if len(set(variants)) == 1}

    if index is get_index():
        _ANCHOR_STATES_CACHE = result

    return result


# ======================================================================
# ODCZYT KONTEKSTU
# ======================================================================

def normalize_route(route: str | None) -> str:
    """'/documents/d-7' -> '/documents/:id'. Zapytania i końcowy ukośnik odpadają."""

    if not route:
        return ""

    path = route.split("?")[0].split("#")[0].rstrip("/") or "/"

    if path in ROUTE_STATES:
        return path

    parts = path.split("/")

    if len(parts) > 2:
        pattern = f"/{parts[1]}/:id"

        if pattern in ROUTE_STATES:
            return pattern

    return path


def context_module(context: dict[str, Any]) -> str | None:
    """Moduł wywnioskowany z trasy -- preferencja planera, nie filtr wyszukiwania."""

    if explicit := (context.get("module") or context.get("modul")):
        return str(explicit)

    parts = normalize_route(context.get("route")).split("/")

    return ROUTE_MODULE.get(f"/{parts[1] if len(parts) > 1 else ''}")


def initial_state(context: dict[str, Any],
                  index: dict[str, dict[str, Any]] | None = None) -> set[str]:
    """
    Składa stan początkowy z czterech niezależnych źródeł w kontekście UI.
    Im więcej uda się ustalić, tym krótszy plan zobaczy użytkownik.
    """

    state: set[str] = set()

    state |= ROUTE_STATES.get(normalize_route(context.get("route")), set())

    if isinstance(role := context.get("role"), str):
        state |= ROLE_STATES.get(role, set())

    for action in context.get("visibleActions") or []:
        if isinstance(action, dict) and not action.get("disabled"):
            state |= ACTION_STATES.get(action.get("id", ""), set())

    form = context.get("form") or {}
    mapping = anchor_states(index)

    for field in form.get("fields") or []:
        if isinstance(field, dict) and field.get("filled") and not field.get("invalid"):
            state |= mapping.get(field.get("id", ""), set())

    return state


# ======================================================================
# WYSZUKIWANIE I WYBÓR
# ======================================================================

def _search(question: str, module: str | None = None) -> list[dict[str, Any]]:
    """
    Adapter na wyszukiwanie semantyczne z builder_n.

    'search_semantic' przyjmuje GOTOWY wektor, nie tekst -- pytanie embedujemy
    tutaj. Węzły klasy Krok odsiewamy: mają własne embeddingi, więc trafiają do
    wyników, ale pojedynczy krok nie jest odpowiedzią -- odpowiedzią jest procedura.
    """

    query_embedding = graph.embedding_model.embed(question).embeddings[0]

    results = graph.KnowledgeGraph.search_semantic(
        graph.graph_driver,
        query_embedding,
        top_k=TOP_K + EXTRA_K,
        module=module,
    )

    return [r for r in results if r.get("klasa") != STEP_CLASS][:TOP_K]


def _describe(properties: dict[str, Any], limit: int = 220) -> str:
    """
    Krótki opis węzła dla modelu. Nazwy parametrów wymyśla LLM przy ingeście,
    więc nie zgadujemy konkretnych kluczy -- sklejamy wszystkie tekstowe.
    """

    parts = [str(value) for key, value in properties.items()
             if isinstance(value, str) and key not in _SYSTEM_KEYS and value.strip()]

    description = " | ".join(parts)

    return description[:limit] + ("..." if len(description) > limit else "")


def _title(properties: dict[str, Any], fallback: str) -> str:
    """Pierwsza tekstowa właściwość węzła jako tytuł. Patrz komentarz w '_describe'."""

    for key, value in properties.items():
        if isinstance(value, str) and value.strip() and key not in _SYSTEM_KEYS:
            return value

    return fallback


def _pick_candidates(question: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Zwraca procedury potrzebne do wykonania zadania, W KOLEJNOŚCI WYKONANIA.

    Lista, nie pojedynczy wybór: zadanie "utwórz zamówienie i wystaw fakturę"
    wymaga dwóch procedur, a wcześniejsza wersja robiła tylko pierwszą z nich.

    Kolejność bierzemy z odpowiedzi modelu, nie z rankingu wyszukiwania -- przy
    zadaniu złożonym to ona niesie sens ("najpierw zamówienie, potem faktura").
    """

    if not candidates:
        return []

    # Moduł podajemy jawnie: bez niego model mylił "wyślij do dostawcy" (zakupy)
    # z "wyślij towar do klienta" (sprzedaż) -- oba brzmią jak wysyłka.
    lines = [f"{c['node_id']} | moduł={c.get('properties', {}).get('modul', '?')} | "
             f"{_describe(c.get('properties', {}))}"
             for c in candidates]

    chat = ChatModel(model=AGENT_MODEL, system=_PICK_SYSTEM, memory=False)

    try:
        answer_text = chat.ask(f"Zadanie: {question}\n\nKandydaci:\n" + "\n".join(lines),
                               think=False, options=_SHORT_ANSWER)
    finally:
        chat.close()

    if not answer_text.strip() or answer_text.strip().upper().startswith("BRAK"):
        return []

    chosen: list[dict[str, Any]] = []

    for line in answer_text.splitlines():
        for candidate in candidates:
            if candidate["node_id"] in line and candidate not in chosen:
                chosen.append(candidate)

    return chosen[:MAX_PROCEDURES]


def _intro_text(question: str, titles: list[str]) -> str:
    """Zdanie wprowadzające. Przy kilku procedurach model dostaje wszystkie tytuły."""

    chat = ChatModel(model=AGENT_MODEL, system=_INTRO_SYSTEM, memory=False)

    try:
        text = chat.ask(f"Pytanie użytkownika: {question}\nProcedury: " + "; ".join(titles),
                        think=False, options=_SHORT_ANSWER).strip()
    finally:
        chat.close()

    return text or ("Oto kroki: " + "; ".join(titles))


def _concept_text(question: str, body: str) -> str:
    """Odpowiedź na pytanie o pojęcie. Pusty wynik = model uznał materiał za nieadekwatny."""

    chat = ChatModel(model=AGENT_MODEL, system=_CONCEPT_SYSTEM, memory=False)

    try:
        text = chat.ask(f"Pytanie: {question}\n\nMateriał:\n{body}",
                        think=False, options=_SHORT_ANSWER).strip()
    finally:
        chat.close()

    return "" if text.upper().startswith("BRAK") else text


# ======================================================================
# BUDOWA KROKÓW
# ======================================================================

def _to_assistant_step(row: dict[str, Any]) -> dict[str, Any] | None:
    """
    Wiersz planu -> AssistantStep z kontraktu. Pola puste są POMIJANE, nie
    wysyłane jako "": front rozróżnia brak anchora od pustego napisu.
    """

    text = row.get("text") or ""

    if not text:
        return None

    step: dict[str, Any] = {"text": text}

    if row.get("anchor"):
        step["anchor"] = row["anchor"]

    if action := parse_action(row.get("action"), row.get("anchor")):
        step["action"] = action

    if row.get("note"):
        step["note"] = row["note"]

    if row.get("why"):
        step["why"] = row["why"]

    return step


def _steps_for(node_ids: list[str], context: dict[str, Any]) -> tuple[list[dict], list[str]]:
    """
    Buduje listę kroków i listę procedur źródłowych.

    Każda procedura idzie przez 'full_plan', czyli w kolejności redakcyjnej
    z YAML-a, a stan przenosi się na kolejną. Dzięki temu druga procedura nie
    powtarza kroków wykonanych przez pierwszą (np. nawigacji), a kolejność
    pozostaje taka, jaką ktoś przemyślał pisząc korpus.
    """

    index = get_index()
    state = initial_state(context, index)
    module = context_module(context)

    # Procedury składamy PO KOLEI, każdą przez 'full_plan', przenosząc stan
    # z poprzedniej. Wcześniej szedł tu 'plan_for_goal' z sumą celów -- i to on
    # mieszał kolejność: cele przetwarzane są sekwencyjnie, więc kroki drugiego
    # doklejały się na końcu. Dawało to plany w rodzaju "zapisz fakturę,
    # zaksięguj, a POTEM dodaj pozycje".
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    stan_biezacy = set(state)

    for node_id in node_ids:
        for row in full_plan(graph.graph_driver, node_id, initial_state=stan_biezacy,
                             preferred_module=module, index=index):
            if row["step_id"] in seen:
                continue

            seen.add(row["step_id"])
            rows.append(row)

            # Stan przenosi się na kolejną procedurę: dzięki temu druga nie
            # powtarza kroków, które pierwsza już wykonała (np. nawigacji).
            stan_biezacy |= index.get(row["step_id"], {}).get("provides", set())

    steps: list[dict[str, Any]] = []
    sources: list[str] = []

    for row in rows:
        if (step := _to_assistant_step(row)) is None:
            continue

        steps.append(step)

        procedure = row.get("procedure")
        if procedure and procedure.startswith("proc") and procedure not in sources:
            sources.append(procedure)

    return steps, sources


def _enrich_question(question: str, context: dict[str, Any]) -> str:
    """
    Wzbogaca zapytanie o sygnały z UI: kod ostatniego błędu i pole, na którym
    użytkownik utyka. Oba realnie podnoszą trafność wyszukiwania semantycznego.
    """

    error_code = (context.get("lastError") or {}).get("code")

    if error_code and error_code not in question:
        question = f"{question} ({error_code})"

    if field_id := context.get("strugglingWith"):
        label = next((f.get("label") for f in (context.get("form") or {}).get("fields") or []
                      if isinstance(f, dict) and f.get("id") == field_id and f.get("label")), None)

        if label and label.lower() not in question.lower():
            question = f"{question} (problem z polem: {label})"

    return question


def _refusal(near_misses: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """
    Odmowa z podpowiedzią. Zamiast ślepego zaułka pokazujemy trzy najbliższe
    tematy z korpusu -- użytkownik od razu widzi, co asystent w ogóle umie.
    """

    text = REFUSAL_TEXT

    if near_misses:
        titles = [_title(c.get("properties", {}), c["node_id"]) for c in near_misses[:3]]
        titles = [t for t in titles if t]

        if titles:
            text += REFUSAL_HINT + "; ".join(titles) + "."

    return {"text": text, "steps": [], "sources": [], "refused": True}


def _require_initialized() -> None:
    if graph.graph_driver is None or graph.embedding_model is None:
        raise RuntimeError("Brak inicjalizacji -- wywołaj 'initialize_graph_driver()' "
                           "i 'initialize_embed_model()' przy starcie aplikacji.")


# ======================================================================
# WEJŚCIA PUBLICZNE
# ======================================================================

def answer(question: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Główne wejście: pytanie + kontekst UI -> AssistantReply.

    :param question: pytanie użytkownika
    :param context: obiekt AssistantContext z sondy na froncie
    :return: słownik zgodny z AssistantReply {text, steps, sources, refused}
    """

    context = context or {}
    _require_initialized()

    if not question.strip():
        return _refusal()

    question = _enrich_question(question, context)

    # Modułem NIE filtrujemy wyszukiwania: użytkownik stojący na /documents ma
    # prawo zapytać o inwentaryzację. Moduł służy wyłącznie planerowi.
    all_hits = _search(question, module=context.get("module") or context.get("modul"))
    candidates = [c for c in all_hits if c.get("score", 0.0) >= MIN_SCORE]

    chosen = _pick_candidates(question, candidates)

    if not chosen:
        return _refusal(all_hits)

    node_ids = [c["node_id"] for c in chosen]
    steps, sources = _steps_for(node_ids, context)

    if steps:
        for node_id in node_ids:
            if node_id not in sources:
                sources.append(node_id)

        titles = [_title(c.get("properties", {}), c["node_id"]) for c in chosen]

        return {
            "text": _intro_text(question, titles),
            "steps": steps,
            "sources": sources,
            "refused": False,
        }

    # Brak kroków -> to pojęcie albo opis błędu. Odpowiadamy tekstem osadzonym
    # w treści węzła; pusty wynik traktujemy jako odmowę.
    properties = chosen[0].get("properties", {})

    body = "\n".join(f"{key}: {value}" for key, value in properties.items()
                     if isinstance(value, str) and key not in _SYSTEM_KEYS)

    text = _concept_text(question, body)

    if not text:
        return _refusal(all_hits)

    return {"text": text, "steps": [], "sources": [node_ids[0]], "refused": False}


def recovery_plan(error_code: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Kroki naprawcze dla kodu błędu, który wyskoczył w trakcie pracy autopilota.

    Węzeł błędu sam nie ma kroków, ale graf wie, które procedury go rozwiązują --
    to relacje utworzone przy ingeście z pola 'common_errors' procedur oraz
    z 'resolutionRefs' rejestru błędów. Dzięki temu "oto opis błędu" zamienia się
    w "oto naprawa", którą autopilot może od razu wykonać.

    :param error_code: kod w formacie ERR-xxxx, odczytany z bannera przez driver.ts
    :param context: kontekst UI w momencie błędu (skraca plan naprawczy)
    """

    context = context or {}
    _require_initialized()

    node_id = error_code.strip().replace("-", "_")

    # WYŁĄCZNIE relacja RESOLVED_BY, w kolejności z korpusu. Wcześniej szukaliśmy
    # przez dowolne sąsiedztwo w grafie i asystent proponował naprawę z zupełnie
    # innego obszaru -- np. na duplikat numeru faktury odsyłał do kartoteki produktów.
    for candidate in resolving_procedures(graph.graph_driver, node_id):
        steps, sources = _steps_for([candidate], context)

        if steps:
            return {
                "text": f"Napotkałem błąd {error_code}. Naprawiam:",
                "steps": steps,
                "sources": sources,
                "refused": False,
            }

    # Brak procedury naprawczej to poprawny wynik: część błędów wymaga decyzji
    # człowieka (np. "poproś kierownika o zatwierdzenie").
    return {
        "text": f"Napotkałem błąd {error_code} i nie mam procedury, która go naprawia. "
                f"Przerywam, żeby nie pogłębić problemu.",
        "steps": [],
        "sources": [],
        "refused": True,
    }