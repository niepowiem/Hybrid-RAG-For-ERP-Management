import yaml
import sys
from pathlib import Path

from neo4j import Driver
from pydantic import ValidationError

from app import graph
from app.core import EMBED_MODEL, EmbedModel, EMBED_MODEL_DIM, PROJECT_ROOT
from app.graph import initialize_knowledge_graph, build_graph_with_ollama, print_graph
from app.schema import Procedure, Error, Concept, KB_DATATYPE

CATEGORY: dict[str, type[KB_DATATYPE]] = {
    "procedures": Procedure,
    "errors": Error,
    "concepts": Concept
}
KNOWLEDGE_DIR = PROJECT_ROOT / "knowledge"

def load_knowledge(knowledge_directory: str | Path | None = None) -> list[KB_DATATYPE]:
    directory = Path(knowledge_directory) if knowledge_directory else KNOWLEDGE_DIR

    documents: list[KB_DATATYPE] = []
    errors: int = 0

    for category, model in CATEGORY.items():
        for file in sorted((directory / category).rglob("*.y*ml")):
            filedata = yaml.safe_load(file.read_text(encoding="utf-8"))
            if filedata is None:
                continue

            for entry in filedata if isinstance(filedata, list) else [filedata]:
                try:
                    documents.append(model.model_validate(entry))

                except ValidationError as err:
                    name = entry.get("id", "?") if isinstance(entry, dict) else "?"
                    print(f"\nErr. in {file.name}, doc. {name}:\n{err}", file=sys.stderr)
                    errors += 1
    if errors:
        raise SystemExit(f"{errors} error(s) in {directory}")

    return documents

def check_for_duplicates(documents: list[KB_DATATYPE]) -> None:
    duplicates: list[KB_DATATYPE] = []
    ids: set[str] = set()

    for document in documents:
        if document.id in ids:
            duplicates.append(document)

        else:
            ids.add(document.id)

    if duplicates:
        for document in duplicates:
            print(f"Duplikat id: {document.id} ({type(document).__name__})", file=sys.stderr)

        raise SystemExit(f"{len(duplicates)} zduplikowanych id w bazie wiedzy")

def ingest_llm(driver: Driver, model:str):
    print(1)
    initialize_knowledge_graph()

    print(2)
    # Pre-flight: sprawdzamy model embeddingów ZANIM zbudujemy graf. Inaczej błąd
    # wyjdzie dopiero przy sync(), po kilkunastu minutach pracy modelu
    embed = EmbedModel(EMBED_MODEL)
    test_vector = embed.encode("test")[0]

    print(3)
    if len(test_vector) != EMBED_MODEL_DIM:
        raise RuntimeError(f"EMBED_MODEL_DIM={EMBED_MODEL_DIM}, ale model '{EMBED_MODEL}' "
                           f"zwraca wektory o wymiarze {len(test_vector)}. Popraw .env.")

    print(4)
    documents = load_knowledge()
    check_for_duplicates(documents)

    document_string: str = '\n\n'.join(
        [document.__repr__() for document in documents]
    )

    print(5)
    print(document_string)

    build_graph_with_ollama(model=model, documents=document_string)

    from app.plan import register_system_schema, attach_steps_from_documents

    print(6)
    register_message = register_system_schema(graph.knowledge_graph)
    print("\n".join(register_message))

    print(7)
    report = attach_steps_from_documents(graph.knowledge_graph, documents)
    print(report['kroki'], report['wspoldzielone'], report['stany'])
    print('BRAKUJĄCE:', report['brakujace'])

    print(8)
    print_graph()
    saved_path = graph.save_graph(model=model, embed_model=EMBED_MODEL)
    print(f"\nGraf zapisany: {saved_path}")

    input("[ENTER], aby zsynchronizować do bazy danych...")

    print(9)
    result = graph.knowledge_graph.sync(driver=driver,
                                        embed_model=embed,
                                        embed_dimensions=EMBED_MODEL_DIM)

    print(result)
    print("\nGotowe!\nMożesz podglądać wyniki na: http://localhost:7474")
