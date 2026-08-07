import yaml
import sys
from pathlib import Path

from neo4j import Driver
from pydantic import ValidationError

from app.core import EMBED_MODEL, EmbedModel, EMBED_MODEL_DIM
from app.graph import initialize_knowledge_graph, build_graph_with_ollama, print_graph, knowledge_graph
from app.schema import Procedure, Error, Concept, KB_DATATYPE

CATEGORY: dict[str, type[KB_DATATYPE]] = {
    "procedures": Procedure,
    "errors": Error,
    "concepts": Concept
}

def load_knowledge(knowledge_directory: str | None = None) -> list[KB_DATATYPE]:
    if knowledge_directory is None:
        knowledge_directory = Path("../knowledge")

    else:
        knowledge_directory = Path(knowledge_directory)

    documents: list[KB_DATATYPE] = []
    errors: int = 0

    for category, model in CATEGORY.items():
        for file in sorted((knowledge_directory / category).rglob("*.y*ml")):
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
        raise SystemExit(f"{errors} error(s) in {knowledge_directory}")

    return documents

def check_for_duplicates(documents: list[KB_DATATYPE]):
    duplicates: list[KB_DATATYPE] = []
    ids: list[str] = []

    for document in documents:
        if document.id in ids:
            duplicates.append(document)

        else:
            ids.append(document.id)

    if duplicates:
        for document in duplicates:
            print(f"Duplicate id: {document.id}, {type(document)}")

def ingest_llm(driver: Driver, model:str):
    initialize_knowledge_graph()

    documents = load_knowledge("./knowledge")
    check_for_duplicates(documents)

    document_string: str = '\n\n'.join(
        [document.__repr__() for document in documents]
    )

    print(document_string)

    build_graph_with_ollama(model=model, documents=document_string)

    print_graph()

    input("[ENTER], aby zsynchronizować do bazy danych...")

    result = knowledge_graph.sync(driver=driver,
                                  embed_model=EmbedModel(EMBED_MODEL),
                                  embed_dimensions=EMBED_MODEL_DIM)

    print(result)
    print("\nGotowe!\nMożesz podglądać wyniki na: http://localhost:7474")

if __name__ == "__main__":
    data_documents = load_knowledge()
    check_for_duplicates(data_documents)