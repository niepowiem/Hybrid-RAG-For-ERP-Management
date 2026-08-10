from pydantic import BaseModel, Field, field_validator
from typing import Any
import re

class ProcedureStep(BaseModel):
    text: str = Field(min_length=3)
    anchor: str | None = None
    action: dict[str, Any] | None = None
    note: str | None = None
    optional: bool = False
    requires: list[str] = []
    provides: list[str] = []

class Procedure(BaseModel):
    id: str
    title: str
    module: str
    summary: str = Field(min_length=16)
    query: list[str] = []
    preconditions: list[str] = []
    roles: list[str] = []
    steps: list[ProcedureStep] = Field(min_length=1)
    verification: str | None = None
    common_errors: list[str] = []
    goal: list[str] = []

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        if not re.fullmatch(r"proc\.[a-z0-9-]+\.[a-z0-9-]+", value):
            raise ValueError(f"Złe id procedury: {value} (wzorzec: proc.modul.nazwa)")

        return value

    def __repr__(self):
        return str(self.model_dump(exclude_none=True))

class ErrorSolution(BaseModel):
    solution: list[str] = Field(min_length=1)
    ref: list[str] | None = None

class Error(BaseModel):
    id: str
    module: str
    query: str
    causes: list[str] = Field(min_length=1)
    solutions: list[ErrorSolution] = []

    @field_validator("id")
    @classmethod
    def _sprawdz_id(cls, value: str) -> str:
        if not re.fullmatch(r"ERR-\d{3,5}", value):
            raise ValueError(f"Złe id błędu: {value} (wzorzec: np. ERR-1004)")

        return value

    def __repr__(self):
        return str(self.model_dump(exclude_none=True))

class Concept(BaseModel):
    id: str
    module: str
    title: str
    aliases: list[str] # Synonimy lub inne potoczne określenia
    body: str = Field(min_length=32)

    @field_validator("id")
    @classmethod
    def _sprawdz_id(cls, value: str) -> str:
        if not re.fullmatch(r"concept\.[a-z0-9-]+", value):
            raise ValueError(f"Złe id koncepcji: {value} (wzorzec: concept.nazwa)")

        return value

    def __repr__(self):
        return str(self.model_dump(exclude_none=True))

KB_DATATYPE = Procedure | Error | Concept

def prepare_for_vector_embedding(document: KB_DATATYPE) -> str:
    output: list[str] = []

    if isinstance(document, Procedure):
        output = [
            document.title,
            document.summary,
            *document.query,
            *document.preconditions
        ]

    elif isinstance(document, Error):
        output = [
            document.id,
            document.query,
            *document.causes,
        ]

    elif isinstance(document, Concept):
        output = [
            document.title,
            *document.aliases,
            document.body
        ]

    else:
        raise ValueError(f"document type: ({type(document)}) is not of KB_DATATYPE")

    return '\n'.join(output)

def prepare_for_lexical_search(document: KB_DATATYPE) -> str:
    output: list[str] = []

    if isinstance(document, Procedure):
        output = [
            document.id,
            document.title,
            document.module,
            document.summary,
            *document.query,
            *document.preconditions,
            *document.roles,
            *[step.text for step in document.steps],
            *document.common_errors,
        ]

        if document.verification:
            output.append(document.verification)

    elif isinstance(document, Error):
        output = [
            document.id,
            document.module,
            document.query,
            *document.causes,
            *[step for error_solution in document.solutions for step in error_solution.solution],
            *[ref for error_solution in document.solutions for ref in (error_solution.ref or [])],
        ]

    elif isinstance(document, Concept):
        output = [
            document.id,
            document.module,
            document.title,
            *document.aliases,
            document.body
        ]

    else:
        raise ValueError(f"document type: ({type(document)}) is not of KB_DATATYPE")

    return '\n'.join(output)

def prepare_for_prompt(document: KB_DATATYPE) -> str:
    output: list[str] = []

    if isinstance(document, Procedure):
        output = [
            f'[{document.id}] ({document.title})',
            document.summary
        ]

        if document.roles:
            output.append(f'Role: ' + ', '.join(document.roles))

        if document.preconditions:
            output.append("Warunki wstępne:\n- " + "\n- ".join(document.preconditions))

        # Kroki
        output.append(f'Kroki:')
        for i, step in enumerate(document.steps, 1):
            lines = [f'{i}. {step.text}']
            if step.note:
                lines.append(f'    ({step.note})')

            output.append('\n'.join(lines))

        if document.verification:
            output.append(f"Weryfikacja: {document.verification}")

    elif isinstance(document, Error):
        output = [
            f'[{document.id}] ({document.query})',
            "Przyczyny:\n- " + "\n- ".join(document.causes),
        ]

        if document.solutions:
            for i, solution in enumerate(document.solutions, 1):
                output.append(f'Rozwiązanie #{i}:')

                output.append('\n'.join(solution.solution))

                if solution.ref:
                    output.append('\n'.join(solution.ref))

    elif isinstance(document, Concept):
        output = [
            f'[{document.id}] ({document.title})',
            document.body
        ]

    else:
        raise ValueError(f"document type: ({type(document)}) is not of KB_DATATYPE")

    return '\n'.join(output)