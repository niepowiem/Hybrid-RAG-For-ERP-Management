"""
api.py -- serwer HTTP dla widgetu w aplikacji ERP.

Uruchomienie:  uvicorn app.api:app --reload --port 8000
Dokumentacja:  http://localhost:8000/docs

Ścieżki i kształt odpowiedzi są identyczne jak w poprzedniej wersji asystenta
(AssistantReply z packages/shared/src/assistant.ts), więc front nie wymaga
żadnych zmian -- podmieniona jest tylko warstwa wiedzy: zamiast wyszukiwania
po korpusie SQL, kroki pochodzą z trawersji grafu wiedzy w neo4j.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import graph
from app.assistant import answer


class AskRequest(BaseModel):
    question: str
    context: dict[str, Any] | None = None
    """Stan UI z sondy kontekstu: ekran, pola formularza, ostatni błąd."""


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Sterownik i model embeddingów tworzymy raz na proces -- inicjalizacja przy
    # każdym zapytaniu kosztowałaby handshake z neo4j i ładowanie modelu.
    graph.initialize_graph_driver()
    graph.initialize_embed_model()

    yield

    if graph.graph_driver is not None:
        graph.graph_driver.close()


app = FastAPI(title="Asystent magazynowy (graf wiedzy)", lifespan=lifespan)

# Na prototyp otwarte. Przed wystawieniem na sieć — zawęź do adresu aplikacji.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.post("/assistant/ask")
def ask(req: AskRequest) -> dict[str, Any]:
    odp = answer(req.question, req.context)

    # Ostatnia linia obrony: front nigdy nie ma dostać pustego dymka.
    if not odp["text"].strip():
        odp["text"] = (
            "Oto kroki:" if odp["steps"] else
            "Nie udało mi się sformułować odpowiedzi. Spróbuj zapytać inaczej."
        )

    return odp


@app.get("/assistant/health")
def health() -> dict[str, Any]:
    records, _, _ = graph.graph_driver.execute_query(
        f"MATCH (n:{graph.KnowledgeGraph.SHARED_LABEL}) "
        f"RETURN count(n) AS wezly, count(n.embeddings) AS z_embeddingami"
    )

    row = records[0]

    return {"ok": True, "wezly": row["wezly"], "z_embeddingami": row["z_embeddingami"]}