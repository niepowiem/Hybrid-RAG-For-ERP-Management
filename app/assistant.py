"""
assistant.py -- warstwa odpowiedzi asystenta. Produkuje strukturę zgodną
z AssistantReply z packages/shared/src/assistant.ts.

Podział odpowiedzialności, wynikający wprost z kontraktu ("tekst kroku dosłownie
z korpusu wiedzy, nie generowany przez model"):

    graf  -> steps[], sources[]     (deterministycznie, bit w bit)
    LLM   -> text, wybór kandydata  (tylko zdanie wprowadzające i decyzja)

Model nigdy nie pisze treści kroków ani anchorów. Jeśli graf nie ma pasującej
procedury, zwracamy refused=True -- odmowa jest lepsza niż zmyślona procedura.
"""

from __future__ import annotations

import os
from typing import Any

from app import graph
from app.core import ChatModel, LLM_MODEL
from app.plan import STEP_CLASS, full_plan, load_step_index, parse_action, related_procedures

# Poniżej progu podobieństwa uznajemy, że korpus nie zawiera odpowiedzi.
# Wartość DO STROJENIA na realnych zapytaniach -- zacznij od logowania score'ów.
MIN_SCORE: float = float(os.getenv("ASSISTANT_MIN_SCORE", "0.5"))

TOP_K: int = int(os.getenv("ASSISTANT_TOP_K", "5"))

# Nadmiarowe wyniki pobierane po to, by odsianie węzłów Krok nie zostawiło pustki.
EXTRA_K: int = int(os.getenv("ASSISTANT_EXTRA_K", "10"))

_SYSTEM_KEYS: frozenset[str] = frozenset({"node_id", "klasa", "modul", "embeddings"})

REFUSAL_TEXT: str = "Nie znalazłem tego w bazie wiedzy."

REFUSAL_HINT: str = " Mogę natomiast pomóc z tym: "

# ---------------------------------------------------------------------------
# Kontekst UI -> stany grafu
#
# Sonda kontekstu (web/src/assistant/context.ts) przysyła: route, routeTitle,
# role, buildVersion, visibleActions[], form.fields[], lastError, strugglingWith.
# Nie przysyła statusów encji -- stąd wnioskowanie pośrednie poniżej.
# ---------------------------------------------------------------------------

# Trasa -> stany pewne. Wzorce ':id' obsługuje 'normalize_route'.
ROUTE_STATES: dict[str, set[str]] = {
    "/": {"ekran.stany"},
    "/documents": {"ekran.dokumenty"},
    "/documents/new": {"ekran.dokumenty", "dokument.nowy"},
    "/documents/:id": {"ekran.dokumenty"},
    "/products": set(),
    "/counterparties": set(),
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
# ZAŁOŻENIE do zweryfikowania na realnych logach: te przyciski są ukrywane albo
# blokowane w innych statusach.
ACTION_STATES: dict[str, set[str]] = {
    "btn.document-confirm": {"dokument.nowy"},
    "btn.po-send": {"zz.zapisane"},
    "btn.po-receive": {"zz.wyslane"},
    "btn.so-confirm": {"zs.zapisane"},
    "btn.so-fulfil": {"zs.potwierdzone"},
    "btn.stocktake-close": {"inw.arkusz-otwarty"},
}

ROLE_STATES: dict[str, set[str]] = {
    "kierownik": {"rola.kierownik", "rola.magazynier"},
    "magazynier": {"rola.magazynier"},
}

_PICK_SYSTEM: str = (
    "Wybierasz najlepiej pasujący dokument z listy kandydatów. "
    "Odpowiadasz WYŁĄCZNIE identyfikatorem wybranego kandydata (dokładnie tak, jak podany) "
    "albo słowem BRAK, jeśli żaden nie odpowiada na pytanie. "
    "Bez wyjaśnień, bez zdań, bez formatowania."
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

# Indeks kroków zmienia się tylko przy ingeście -- trzymamy go w pamięci procesu.
_INDEX_CACHE: dict[str, dict[str, Any]] | None = None
_ANCHOR_STATES_CACHE: dict[str, set[str]] | None = None


def get_index(reload: bool = False) -> dict[str, dict[str, Any]]:
    """Zwraca (i buforuje) indeks kroków. Po ponownym ingeście wołaj z reload=True."""

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
    kandydaci: dict[str, list[frozenset[str]]] = {}

    for krok in index.values():
        anchor = krok.get("anchor")

        if anchor and krok.get("daje"):
            kandydaci.setdefault(anchor, []).append(frozenset(krok["daje"]))

    wynik = {anchor: set(warianty[0]) for anchor, warianty in kandydaci.items()
             if len(set(warianty)) == 1}

    if index is get_index():
        _ANCHOR_STATES_CACHE = wynik

    return wynik


def normalize_route(route: str | None) -> str:
    """'/documents/d-7' -> '/documents/:id'. Zapytania i końcowy ukośnik odpadają."""

    if not route:
        return ""

    sciezka = route.split("?")[0].split("#")[0].rstrip("/") or "/"

    if sciezka in ROUTE_STATES:
        return sciezka

    czesci = sciezka.split("/")

    if len(czesci) > 2:
        wzor = f"/{czesci[1]}/:id"

        if wzor in ROUTE_STATES:
            return wzor

    return sciezka


def context_module(context: dict[str, Any]) -> str | None:
    """Moduł wywnioskowany z trasy -- preferencja planera, nie filtr wyszukiwania."""

    if jawny := (context.get("module") or context.get("modul")):
        return str(jawny)

    czesci = normalize_route(context.get("route")).split("/")

    return ROUTE_MODULE.get(f"/{czesci[1] if len(czesci) > 1 else ''}")


def initial_state(context: dict[str, Any],
                  index: dict[str, dict[str, Any]] | None = None) -> set[str]:
    """
    Składa stan początkowy z trzech niezależnych źródeł w kontekście UI.
    Im więcej uda się ustalić, tym krótszy plan zobaczy użytkownik.
    """

    stan: set[str] = set()

    stan |= ROUTE_STATES.get(normalize_route(context.get("route")), set())

    if isinstance(rola := context.get("role"), str):
        stan |= ROLE_STATES.get(rola, set())

    for akcja in context.get("visibleActions") or []:
        if isinstance(akcja, dict) and not akcja.get("disabled"):
            stan |= ACTION_STATES.get(akcja.get("id", ""), set())

    formularz = context.get("form") or {}
    mapa = anchor_states(index)

    for pole in formularz.get("fields") or []:
        if isinstance(pole, dict) and pole.get("filled") and not pole.get("invalid"):
            stan |= mapa.get(pole.get("id", ""), set())

    return stan


def _search(question: str, module: str | None = None) -> list[dict[str, Any]]:
    """
    Adapter na wyszukiwanie semantyczne z graph.py.

    'search_semantic' przyjmuje GOTOWY wektor, nie tekst -- pytanie embedujemy tutaj.
    Węzły klasy Krok odsiewamy: mają własne embeddingi, więc trafiają do wyników,
    ale pojedynczy krok nie jest odpowiedzią -- odpowiedzią jest procedura.
    """

    query_embedding = graph.embed_model.encode(question)[0]

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

    opis = " | ".join(parts)

    return opis[:limit] + ("..." if len(opis) > limit else "")


def _title(properties: dict[str, Any], fallback: str) -> str:
    for key, value in properties.items():
        if isinstance(value, str) and value.strip() and key not in _SYSTEM_KEYS:
            return value

    return fallback


def _pick_candidate(question: str, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """
    Pyta model, który z kandydatów odpowiada na pytanie. Model może odpowiedzieć
    BRAK -- i to jest poprawny wynik, nie awaria.
    """

    if not candidates:
        return None

    lines = [f"{c['node_id']} | klasa={c.get('klasa')} | {_describe(c.get('properties', {}))}"
             for c in candidates]

    chat = ChatModel(model=LLM_MODEL, system=_PICK_SYSTEM, memory=False)

    answer_text = chat.ask(f"Pytanie: {question}\n\nKandydaci:\n" + "\n".join(lines),
                           think=False).strip()

    if not answer_text or answer_text.upper().startswith("BRAK"):
        return None

    # Model bywa gadatliwy mimo instrukcji -- szukamy node_id w treści zamiast
    # wymagać dokładnego dopasowania całej odpowiedzi.
    for candidate in candidates:
        if candidate["node_id"] in answer_text:
            return candidate

    return None


def _intro_text(question: str, title: str) -> str:
    chat = ChatModel(model=LLM_MODEL, system=_INTRO_SYSTEM, memory=False)

    text = chat.ask(f"Pytanie użytkownika: {question}\nProcedura: {title}", think=False).strip()

    return text or f"Oto kroki: {title}"


def _concept_text(question: str, body: str) -> str:
    chat = ChatModel(model=LLM_MODEL, system=_CONCEPT_SYSTEM, memory=False)

    text = chat.ask(f"Pytanie: {question}\n\nMateriał:\n{body}", think=False).strip()

    return "" if text.upper().startswith("BRAK") else text


def _steps_for(node_id: str, context: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """Buduje listę kroków w kształcie AssistantStep oraz listę procedur źródłowych."""

    index = get_index()

    stan = initial_state(context, index)
    modul = context_module(context)

    rows = full_plan(graph.graph_driver, node_id, stan_poczatkowy=stan,
                     preferowany_modul=modul, index=index)

    # Trafiony węzeł nie ma własnych kroków (błąd, pojęcie), ale graf może wiedzieć,
    # którą procedurą się go rozwiązuje. To zamienia "oto opis błędu" w "oto naprawa".
    if not rows:
        for kandydat in related_procedures(graph.graph_driver, node_id):
            rows = full_plan(graph.graph_driver, kandydat, stan_poczatkowy=stan,
                             preferowany_modul=modul, index=index)

            if rows:
                break

    steps: list[dict[str, Any]] = []
    sources: list[str] = []

    for row in rows:
        tekst = row.get("tekst") or ""

        if not tekst:
            continue

        step: dict[str, Any] = {"text": tekst}

        if row.get("anchor"):
            step["anchor"] = row["anchor"]

        if action := parse_action(row.get("akcja"), row.get("anchor")):
            step["action"] = action

        if row.get("uwaga"):
            step["note"] = row["uwaga"]

        steps.append(step)

        procedura = row.get("procedura")
        if procedura and procedura.startswith("proc") and procedura not in sources:
            sources.append(procedura)

    return steps, sources


def _enrich_question(question: str, context: dict[str, Any]) -> str:
    """
    Wzbogaca zapytanie o sygnały z UI: kod ostatniego błędu i pole, na którym
    użytkownik utyka. Oba realnie podnoszą trafność wyszukiwania semantycznego.
    """

    error_code = (context.get("lastError") or {}).get("code")

    if error_code and error_code not in question:
        question = f"{question} ({error_code})"

    if pole := context.get("strugglingWith"):
        etykieta = next((f.get("label") for f in (context.get("form") or {}).get("fields") or []
                         if isinstance(f, dict) and f.get("id") == pole and f.get("label")), None)

        if etykieta and etykieta.lower() not in question.lower():
            question = f"{question} (problem z polem: {etykieta})"

    return question


def _refusal(bliskie: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """
    Odmowa z podpowiedzią. Zamiast ślepego zaułka pokazujemy trzy najbliższe
    tematy z korpusu -- użytkownik od razu widzi, co asystent w ogóle umie.
    """

    text = REFUSAL_TEXT

    if bliskie:
        tytuly = [_title(c.get("properties", {}), c["node_id"]) for c in bliskie[:3]]
        tytuly = [t for t in tytuly if t]

        if tytuly:
            text += REFUSAL_HINT + "; ".join(tytuly) + "."

    return {"text": text, "steps": [], "sources": [], "refused": True}


def answer(question: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Główne wejście: pytanie + kontekst UI -> AssistantReply.

    :param question: pytanie użytkownika
    :param context: obiekt AssistantContext z sondy na froncie
    :return: słownik zgodny z AssistantReply
    """

    context = context or {}

    if graph.graph_driver is None or graph.embed_model is None:
        raise RuntimeError("Brak inicjalizacji -- wywołaj 'initialize_graph_driver()' "
                           "i 'initialize_embed_model()' przy starcie aplikacji.")

    if not question.strip():
        return _refusal()

    question = _enrich_question(question, context)

    # Modułem NIE filtrujemy wyszukiwania -- użytkownik stojący na /documents
    # ma prawo zapytać o inwentaryzację. Moduł służy tylko planerowi.
    wszystkie = _search(question, module=context.get("module") or context.get("modul"))
    candidates = [c for c in wszystkie if c.get("score", 0.0) >= MIN_SCORE]

    chosen = _pick_candidate(question, candidates)

    if chosen is None:
        return _refusal(wszystkie)

    node_id = chosen["node_id"]
    properties = chosen.get("properties", {})

    steps, sources = _steps_for(node_id, context)

    if steps:
        if node_id not in sources:
            sources.append(node_id)

        return {
            "text": _intro_text(question, _title(properties, node_id)),
            "steps": steps,
            "sources": sources,
            "refused": False,
        }

    # Brak kroków -> to pojęcie albo opis błędu. Odpowiadamy tekstem osadzonym
    # w treści węzła; pusty wynik traktujemy jako odmowę.
    body = "\n".join(f"{key}: {value}" for key, value in properties.items()
                     if isinstance(value, str) and key not in _SYSTEM_KEYS)

    text = _concept_text(question, body)

    if not text:
        return _refusal(wszystkie)

    return {"text": text, "steps": [], "sources": [node_id], "refused": False}