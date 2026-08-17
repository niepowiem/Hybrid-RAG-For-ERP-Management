import yaml
import sys
from pathlib import Path
from typing import Any

from neo4j import Driver
from pydantic import ValidationError

from app import graph
from app.core import EmbeddingModel, EmbeddingResponse, PROJECT_ROOT, EMBEDDING_MODEL
from app.graph import build_graph_with_llm, save_graph, GRAPHS_DIR
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

def ingest_steps(documents: list[KB_DATATYPE]) -> dict[str, Any]:
    """
    Dobudowuje warstwę proceduralną: węzły Krok i Stan oraz łączące je relacje.

    Uruchamiać PO 'build_graph_with_llm' (builder woła 'clear()' na starcie,
    więc schemat zarejestrowany wcześniej zostałby zmieciony) i PRZED 'sync()'.

    :param documents: dokumenty z 'load_knowledge' -- nie tylko procedury,
        funkcja sama odsiewa błędy i pojęcia
    :return: raport z licznikami; 'missing' niepuste oznacza, że LLM nie
        trzymał się konwencji nazw węzłów i część procedur nie ma kroków
    """

    from app.plan import (register_system_schema, attach_steps_from_documents,
                          attach_error_links)

    register_message = register_system_schema(graph.knowledge_graph)

    for message in register_message:
        if not message.startswith(("OK", "INFO")):
            print(f"UWAGA przy rejestracji schematu: {message}", file=sys.stderr)

    report = attach_steps_from_documents(graph.knowledge_graph, documents)

    print(f"kroki={report['steps']} współdzielone={report['reused']} "
          f"krawędzie={report['edges']} stany={report['states']} "
          f"procedury={report['procedures']}")

    if report["missing"]:
        print(f"UWAGA: {len(report['missing'])} procedur nie ma węzła o oczekiwanej "
              f"nazwie -- ich kroki NIE zostały dodane. Popraw konwencję nazw "
              f"w prompcie systemowym i powtórz ingest.", file=sys.stderr)

    # Powiązania błąd -> procedura naprawcza. Tworzone z 'solutions[].ref',
    # deterministycznie: to po nich autopilot szuka naprawy po napotkaniu błędu.
    links = attach_error_links(graph.knowledge_graph, documents)
    print(f"powiązania naprawcze: {links['links']} dla {links['errors']} błędów")

    report |= {f"error_{k}": v for k, v in links.items()}

    return report

def ingest_llm(driver: Driver, model:str, embed: EmbeddingModel, dim: int, validate: bool=True, provider: str | None = None) -> None:
    if validate:
        print(f"Ingest LLM: VALIDATING")
        _validate_embeddings(embed, dim=dim)

    print(f"Ingest LLM: LOADING KNOWLEDGE")
    documents: list[KB_DATATYPE] = load_knowledge()
    check_for_duplicates(documents)

    # Sklej reprezentacje tekstowe wszystkich dokumentów
    print(f"Ingest LLM: STRINGING KNOWLEDGE")
    document_string: str = "\n\n".join([document.__repr__() for document in documents])

    # Budujemy pre-ingest
    print(f"Ingest LLM: BUILDING")
    build_graph_with_llm(model, provider=provider, documents=document_string)

    # Ingestujemy kroki (warstwa deterministyczna, bez udziału modelu)
    print(f"Ingest LLM: STEPS")
    ingest_steps(documents)

    # Zapisujemy sporządzony graf
    print(f"Ingest LLM: SAVING")
    save_graph(model=model, directory=GRAPHS_DIR / "poststeps")

    # Synkujemy i tworzymy embeddingi
    print(f"Ingest LLM: SYNCING")
    graph.knowledge_graph.sync(
            driver=driver,
            embed_model=embed,
            # 'dim', nie EMBEDDING_DIM: tym samym wymiarem walidowaliśmy model
            # wyżej, a indeks wektorowy powstaje z 'IF NOT EXISTS' -- utworzony
            # raz o złym rozmiarze nigdy się sam nie poprawi.
            embed_dimensions=dim,
        )

    # Zapis PO sync: podajemy nazwę modelu embeddingów, co włącza zapis wektorów.
    # Dzięki temu kopia zapasowa nie wymaga ich przeliczania od nowa.
    print(f"Ingest LLM: SAVING")
    save_graph(model=model, directory=GRAPHS_DIR / "final", embed_model_name=EMBEDDING_MODEL)

    print("Ingest LLM: DONE! Możesz podglądać wyniki na: http://localhost:7474")