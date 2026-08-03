import yaml
import sys
from pathlib import Path
from pydantic import ValidationError
from schema import Procedure, Error, Concept, KB_DATATYPE

knowledge_directory = Path("../knowledge")

CATEGORY: dict[str, type[KB_DATATYPE]] = {
    "procedures": Procedure,
    "errors": Error,
    "concepts": Concept
}

def load_knowledge() -> list[KB_DATATYPE]:
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
                    name= entry.get("id", "?") if isinstance(entry, dict) else "?"
                    print(f"\nErr. in {file.name}, doc. {name}:\n{err}", file=sys.stderr)
                    errors += 1
    if errors:
        raise SystemExit(f"{errors} error(s) in {knowledge_directory}")

    return documents

def check_for_duplicates():
    pass

if __name__ == "__main__":
    pass