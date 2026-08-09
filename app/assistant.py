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
from app.plan import STEP_CLASS, build_plan, parse_action

# Poniżej progu podobieństwa uznajemy, że korpus nie zawiera odpowiedzi.
# Wartość DO STROJENIA na realnych zapytaniach -- zacznij od logowania score'ów.
MIN_SCORE: float = float(os.getenv("ASSISTANT_MIN_SCORE", "0.5"))

TOP_K: int = int(os.getenv("ASSISTANT_TOP_K", "5"))

# Nadmiarowe wyniki pobierane po to, by odsianie węzłów Krok nie zostawiło pustki.
EXTRA_K: int = int(os.getenv("ASSISTANT_EXTRA_K", "10"))

_SYSTEM_KEYS: frozenset[str] = frozenset({"node_id", "klasa", "modul", "embeddings"})

REFUSAL_TEXT: str = ("Nie znalazłem tego w bazie wiedzy. Spróbuj zapytać inaczej "
                     "albo skontaktuj się z administratorem systemu.")

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


def _search(question: str, module: str | None) -> list[dict[str, Any]]:
    """
    Adapter na wyszukiwanie semantyczne z graph.py.

    'search_semantic' przyjmuje GOTOWY wektor, nie tekst -- pytanie embedujemy tutaj.
    Węzły klasy Krok odsiewamy: mają własne embeddingi (parameters_to_embed=["tekst"]),
    więc trafiają do wyników, ale pojedynczy krok nie jest odpowiedzią na pytanie --
    odpowiedzią jest procedura, do której należy.
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

    lines: list[str] = []
    for candidate in candidates:
        lines.append(f"{candidate['node_id']} | klasa={candidate.get('klasa')} | "
                     f"{_describe(candidate.get('properties', {}))}")

    chat = ChatModel(model=LLM_MODEL, system=_PICK_SYSTEM, memory=False)

    answer = chat.ask(
        f"Pytanie: {question}\n\nKandydaci:\n" + "\n".join(lines),
        think=False,
    ).strip()

    if not answer or answer.upper().startswith("BRAK"):
        return None

    # Model bywa gadatliwy mimo instrukcji -- szukamy node_id w treści zamiast
    # wymagać dokładnego dopasowania całej odpowiedzi.
    for candidate in candidates:
        if candidate["node_id"] in answer:
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


def _steps_for(node_id: str) -> tuple[list[dict[str, Any]], list[str]]:
    """
    Buduje listę kroków w kształcie AssistantStep oraz listę procedur,
    z których pochodzą (trafiają do 'sources').
    """

    rows = build_plan(graph.graph_driver, node_id)

    steps: list[dict[str, Any]] = []
    sources: list[str] = []

    for row in rows:
        step: dict[str, Any] = {"text": row.get("tekst") or ""}

        if not step["text"]:
            continue

        if row.get("anchor"):
            step["anchor"] = row["anchor"]

        if action := parse_action(row.get("akcja"), row.get("anchor")):
            step["action"] = action

        if row.get("uwaga"):
            step["note"] = row["uwaga"]

        steps.append(step)

        if row.get("procedura") and row["procedura"] not in sources:
            sources.append(row["procedura"])

    return steps, sources


def _refusal() -> dict[str, Any]:
    return {"text": REFUSAL_TEXT, "steps": [], "sources": [], "refused": True}


def answer(question: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Główne wejście: pytanie + kontekst UI -> AssistantReply.

    :param question: pytanie użytkownika
    :param context: stan UI z frontu (moduł/ekran, ostatni błąd)
    :return: słownik zgodny z AssistantReply
    """

    context = context or {}

    if graph.graph_driver is None or graph.embed_model is None:
        raise RuntimeError("Brak inicjalizacji -- wywołaj 'initialize_graph_driver()' "
                           "i 'initialize_embed_model()' przy starcie aplikacji.")

    if not question.strip():
        return _refusal()

    # Kod błędu z UI dopisujemy do pytania -- podnosi trafność wyszukiwania
    # dla węzłów błędów, których treść zawiera identyfikator.
    error_code = (context.get("lastError") or {}).get("code")
    if error_code and error_code not in question:
        question = f"{question} ({error_code})"

    candidates = _search(question, module=context.get("module") or context.get("modul"))
    candidates = [c for c in candidates if c.get("score", 0.0) >= MIN_SCORE]

    chosen = _pick_candidate(question, candidates)
    if chosen is None:
        return _refusal()

    node_id = chosen["node_id"]
    properties = chosen.get("properties", {})

    steps, sources = _steps_for(node_id)

    if steps:
        title = _title(properties, node_id)

        if node_id not in sources:
            sources.append(node_id)

        return {
            "text": _intro_text(question, title),
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
        return _refusal()

    return {"text": text, "steps": [], "sources": [node_id], "refused": False}