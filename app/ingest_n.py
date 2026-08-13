import yaml
import sys
from pathlib import Path

from neo4j import Driver
from pydantic import ValidationError

from app import graph
from app.core import EMBED_MODEL, EmbedModel, EMBED_MODEL_DIM, PROJECT_ROOT
from app.core_n import EmbeddingModel, ChatModel, EmbeddingResponse
from app.graph import initialize_knowledge_graph, build_graph_with_ollama, print_graph
from app.schema import Procedure, Error, Concept, KB_DATATYPE

KNOWLEDGE_DIR = PROJECT_ROOT / "knowledge"
CATEGORY: dict[str, type[KB_DATATYPE]] = {
    "procedures": Procedure,
    "errors": Error,
    "concepts": Concept
}

def load_knowledge(knowledge_directory: str | Path | None = None) -> list[KB_DATATYPE]:
    """
    Ładuje wszystkie dokumenty wiedzy z plików YAML znajdujących się
    w podkatalogach `procedures/`, `errors/` oraz `concepts/`.

    :param knowledge_directory: Ścieżka do katalogu wiedzy; domyślnie KNOWLEDGE_DIR.
    :return:
    """

    # Użyj podanej ścieżki lub domyślnej
    directory = Path(knowledge_directory) if knowledge_directory else KNOWLEDGE_DIR

    documents: list[KB_DATATYPE] = []   # Akumulator poprawnych dokumentów
    errors: int = 0                     # Licznik błędów walidacji

    # Iterujemy po kategoriach i ich modelach
    for category, model in CATEGORY.items():

        # Znajdź wszystkie pliki .yaml / .yml w podkatalogu kategorii
        # Wczytaj dane YAML z pliku
        for file in sorted((directory / category).rglob("*.y*ml")):
            filedata = yaml.safe_load(file.read_text(encoding="utf-8"))
            if filedata is None:
                continue

            # Ujednolicamy: jeśli plik zawiera pojedynczy obiekt,
            # opakowujemy go w listę, by dalej iterować jednolicie
            # Walidacja i parsowanie pojedynczego wpisu za pomocą modelu Pydantic
            for entry in filedata if isinstance(filedata, list) else [filedata]:
                try:
                    documents.append(model.model_validate(entry))

                except ValidationError as err:
                    name = entry.get("id", "?") if isinstance(entry, dict) else "?"
                    print(f"\nErr. in {file.name}, doc. {name}:\n{err}", file=sys.stderr)
                    errors += 1

    # Jeśli wystąpiły jakiekolwiek błędy, przerwij działanie
    if errors:
        raise SystemExit(f"{errors} error(s) in {directory}")

    return documents

def check_for_duplicates(documents: list[KB_DATATYPE]) -> None:
    """
    Sprawdza, czy na liście dokumentów nie występują powtórzone identyfikatory.

    :param documents: Lista dokumentów wiedzy (po walidacji).
    :return:
    """

    duplicates: list[KB_DATATYPE] = []  # Lista wykrytych duplikatów
    ids: set[str] = set()               # Zbiór dotychczas napotkanych id

    # Przeszukujemy wszystkie dokumenty
    for document in documents:
        if document.id in ids:

            # To id już widzieliśmy, czyli to duplikat
            duplicates.append(document)

        else:
            ids.add(document.id)

    # Jeśli są duplikaty, wypisz je i zakończ program
    if duplicates:
        for document in duplicates:
            print(f"Duplikat id: {document.id} ({type(document).__name__})", file=sys.stderr)

        raise SystemExit(f"{len(duplicates)} zduplikowanych id w bazie wiedzy")

def _validate_embeddings(embed: EmbeddingModel, dim:int) -> bool:
    embed_resp: EmbeddingResponse = embed.embed("TEST")

    # Walidacja wymiaru wektora
    if len(embed_resp.embeddings[0]) != dim:
        raise RuntimeError(
            f"EMBED_MODEL_DIM={dim}, ale model '{embed_resp.model}' "
            f"zwraca wektory o wymiarze {len(embed_resp.embeddings[0])}. Popraw .env."
        )

    return True

def ingest_procedural(driver: Driver, embed: EmbeddingModel, dim: int, validate: bool=True) -> None:
    raise NotImplementedError("Not implemented Yet!")

def ingest_llm(driver: Driver, chat: ChatModel, embed: EmbeddingModel, dim: int, validate: bool=True) -> None:
    if validate:
        _validate_embeddings(embed, dim=dim)

    documents: list[KB_DATATYPE] = load_knowledge()
    check_for_duplicates(documents)

    # Sklej reprezentacje tekstowe wszystkich dokumentów
    document_string: str = "\n\n".join(
        [document.__repr__() for document in documents]
    )

    # TODO
    # build_graph_with_ollama(model=model, documents=document_string)

    # TODO

# TODO: Trzeba najpierw zrobić graph_n.py
# def ingest_llm(driver: Driver, model: str, validate:bool=True) -> None:
#     """
#     Pełny potok przetwarzania wiedzy:
#     1. Inicjalizuje pusty graf.
#     2. Testuje model embeddingów (pre-flight check).
#     3. Ładuje dokumenty z plików YAML.
#     4. Buduje graf wiedzy przy użyciu LLM (Ollama).
#     5. Rejestruje schemat systemowy i dołącza kroki.
#     6. Zapisuje graf lokalnie i synchronizuje go do Neo4j.
#
#     Args:
#         driver: Aktywne połączenie do bazy Neo4j.
#         model: Nazwa modelu Ollama do budowy grafu (np. 'llama3').
#     """
#     # Inicjalizacja pustego grafu wiedzy
#     initialize_knowledge_graph()
#
#     # Sprawdzamy model ZANIM zbudujemy graf
#     # Inaczej błąd wyszedłby dopiero przy sync(), po kilkunastu minutach pracy LLM-a
#     if validate:
#         embed = EmbedModel(EMBED_MODEL)         # Załaduj model embedding-ów
#         test_vector = embed.encode("TEST")[0]   # Wygeneruj wektor testowy
#
#         # Walidacja wymiaru wektora
#         if len(test_vector) != EMBED_MODEL_DIM:
#             raise RuntimeError(
#                 f"EMBED_MODEL_DIM={EMBED_MODEL_DIM}, ale model '{EMBED_MODEL}' "
#                 f"zwraca wektory o wymiarze {len(test_vector)}. Popraw .env."
#             )
#
#     # Załaduj dokumenty i sprawdź duplikaty
#     documents = load_knowledge()
#     check_for_duplicates(documents)
#
#     # Sklej reprezentacje tekstowe wszystkich dokumentów
#     document_string: str = "\n\n".join(
#         [document.__repr__() for document in documents]
#     )
#
#     # --- Krok 5: Wyświetl dokumenty i buduj graf przez LLM ---
#     print(5)
#     print(document_string)
#     build_graph_with_ollama(model=model, documents=document_string)
#
#     # (Import lokalny – unikamy cyklicznych zależności przy starcie modułu)
#     from app.plan import register_system_schema, attach_steps_from_documents
#
#     # --- Krok 6: Rejestracja schematu systemowego w grafie ---
#     print(6)
#     register_message = register_system_schema(graph.knowledge_graph)
#     print("\n".join(register_message))
#
#     # --- Krok 7: Dołączenie kroków z dokumentów ---
#     print(7)
#     report = attach_steps_from_documents(graph.knowledge_graph, documents)
#     print(report["kroki"], report["wspoldzielone"], report["stany"])
#     print("BRAKUJĄCE:", report["brakujace"])
#
#     # --- Krok 8: Lokalny zapis grafu ---
#     print(8)
#     print_graph()
#     saved_path = graph.save_graph(model=model, embed_model=EMBED_MODEL)
#     print(f"\nGraf zapisany: {saved_path}")
#
#     # Pauza przed synchronizacją – użytkownik może zweryfikować dane
#     input("[ENTER], aby zsynchronizować do bazy danych...")
#
#     # --- Krok 9: Synchronizacja grafu do Neo4j ---
#     print(9)
#     result = graph.knowledge_graph.sync(
#         driver=driver,
#         embed_model=embed,
#         embed_dimensions=EMBED_MODEL_DIM,
#     )
#
#     print(result)
#     print("\nGotowe!\nMożesz podglądać wyniki na: http://localhost:7474")