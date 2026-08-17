"""
api.py -- serwer HTTP dla widgetu asystenta w aplikacji ERP.

Uruchomienie:  uvicorn app.api_n:app --reload --port 8000
Dokumentacja:  http://localhost:8000/docs

Ścieżka /assistant/ask i kształt odpowiedzi są identyczne jak w pierwszej wersji
asystenta (AssistantReply z packages/shared/src/assistant.ts), więc front nie
wymaga zmian -- podmieniona jest tylko warstwa wiedzy: zamiast wyszukiwania po
korpusie SQL, kroki pochodzą z trawersji grafu wiedzy w Neo4j.

Endpointy:
    POST /assistant/ask       pytanie -> AssistantReply
    POST /assistant/recover   kod błędu z autopilota -> kroki naprawcze
    POST /assistant/reload    przeładowanie bufora indeksu po ingeście
    GET  /assistant/health    stan grafu i modeli
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app import graph as graph
from app.assistant import answer, get_index, recovery_plan

logger = logging.getLogger("assistant")

# Adresy dopuszczone przez CORS. Domyślnie otwarte na czas prototypu; przed
# wystawieniem na sieć ustaw ASSISTANT_CORS_ORIGINS na adres aplikacji.
CORS_ORIGINS: list[str] = [
    o.strip() for o in os.getenv("ASSISTANT_CORS_ORIGINS", "*").split(",") if o.strip()
]

# Ile razy autopilot może poprosić o naprawę TEGO SAMEGO błędu, zanim uznamy,
# że naprawa go wywołuje ponownie. Bez tego limitu pętla naprawcza jest wieczna.
MAX_RECOVERIES_PER_CODE: int = int(os.getenv("ASSISTANT_MAX_RECOVERIES", "2"))

class AskRequest(BaseModel):
    question: str

    context: dict[str, Any] | None = None
    """Stan UI z sondy kontekstu: trasa, rola, widoczne akcje, pola, ostatni błąd."""

    history: list[dict[str, Any]] | None = None
    """
    Poprzednie tury rozmowy, od najstarszej. Trzyma je FRONT, nie serwer:
    dzięki temu backend pozostaje bezstanowy i skaluje się na wiele procesów,
    a odświeżenie strony po prostu zaczyna rozmowę od nowa.
    """


class RecoverRequest(BaseModel):
    code: str = Field(min_length=3)
    """Kod błędu odczytany z bannera przez driver.ts, np. 'ERR-4001'."""

    context: dict[str, Any] | None = None

    attempt: int = 1
    """Która to próba naprawy tego kodu w bieżącym przebiegu autopilota."""


@asynccontextmanager
async def lifespan(_: FastAPI):
    """
    Sterownik, model embeddingów i indeks kroków tworzymy RAZ na proces.
    Inicjalizacja przy każdym zapytaniu kosztowałaby handshake z Neo4j
    i wczytanie kilkuset węzłów -- przy zdalnym modelu to sekundy na żądanie.
    """

    graph.initialize_graph_driver()
    graph.initialize_embed_model()

    steps = len(get_index(reload=True))
    logger.info("Asystent gotowy: %s kroków w indeksie", steps)

    yield

    if graph.graph_driver is not None:
        graph.graph_driver.close()

    if graph.embedding_model is not None:
        graph.embedding_model.close_client()


app = FastAPI(title="Asystent ERP (graf wiedzy)", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _never_empty(reply: dict[str, Any]) -> dict[str, Any]:
    """
    Ostatnia linia obrony: front nigdy nie ma dostać pustego dymka.
    Model bywa milczący, a pusty tekst wygląda w widgecie jak awaria.
    """

    if not reply["text"].strip():
        reply["text"] = (
            "Oto kroki:" if reply["steps"] else
            "Nie udało mi się sformułować odpowiedzi. Spróbuj zapytać inaczej."
        )

    return reply


@app.post("/assistant/ask")
def ask(req: AskRequest) -> dict[str, Any]:
    """Pytanie użytkownika -> AssistantReply."""

    # Kontekst logujemy na DEBUG, bo to jedyne źródło wiedzy o tym, co front
    # faktycznie przysyła -- przydaje się przy strojeniu ROUTE_STATES.
    logger.debug("ask: %r historia=%s tur", req.question, len(req.history or []))

    return _never_empty(answer(req.question, req.context, req.history))


@app.post("/assistant/recover")
def recover(req: RecoverRequest) -> dict[str, Any]:
    """
    Kroki naprawcze dla błędu napotkanego przez autopilota.

    Licznik prób jest po stronie serwera celowo: front mógłby go zgubić przy
    przeładowaniu, a pętla "naprawa wywołuje ten sam błąd" jest wtedy nieskończona.
    """

    if req.attempt > MAX_RECOVERIES_PER_CODE:
        return {
            "text": f"Błąd {req.code} powtórzył się mimo naprawy. Przerywam -- "
                    f"dalsze próby mogłyby pogłębić problem.",
            "steps": [],
            "sources": [],
            "refused": True,
        }

    logger.info("recover: %s (próba %s)", req.code, req.attempt)

    return _never_empty(recovery_plan(req.code, req.context))


@app.post("/assistant/reload")
def reload_index() -> dict[str, Any]:
    """
    Przeładowuje bufor indeksu kroków. Wołaj po każdym ingeście -- bez tego
    działający serwer odpowiada krokami sprzed przebudowy grafu.
    """

    steps = len(get_index(reload=True))

    return {"ok": True, "steps": steps}


@app.get("/assistant/health")
def health() -> dict[str, Any]:
    """
    Stan gotowości. 'with_embeddings' mniejsze od 'nodes' oznacza, że część
    węzłów nie trafi do wyszukiwania semantycznego -- najczęściej dlatego,
    że ich klasa nie ma oznaczonych parametrów embedowanych.
    """

    records, _, _ = graph.graph_driver.execute_query(
        f"MATCH (n:{graph.KnowledgeGraph.SHARED_LABEL}) "
        f"RETURN count(n) AS nodes, count(n.embeddings) AS with_embeddings"
    )

    row = records[0]

    return {
        "ok": True,
        "nodes": row["nodes"],
        "with_embeddings": row["with_embeddings"],
        "steps_indexed": len(get_index()),
    }