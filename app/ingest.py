import json
import yaml
from typing import Any
from pathlib import Path

knowledge_directory = Path("../knowledge")

# TBA !>-------------v
CATALOGS: dict[str, Any] = {
    "concepts": 0,
    "errors": 0,
    "procedures": 0
}

def process_all_catalogs_for_vector_search() -> None:
    # TBA !>---------v
    documents: list[Any] = []
    errors: int = 0

    for category in CATALOGS.keys():
        for file in sorted((knowledge_directory / category).rglob("*.y*ml")):
            data = yaml.safe_load(file.read_text(encoding="utf-8"))

            print(data)

if __name__ == "__main__":
    process()