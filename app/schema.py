from pydantic import BaseModel, Field, field_validator
from typing import Any
import re

class ProcedureStep(BaseModel):
    text: str = Field(min_length=3)
    anchor: str | None = None
    action: dict[str, Any] | None = None
    note: str | None = None

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

def prepare_for_embedding():
    pass

def prepare_for_lexical_search():
    pass

def prepare_for_prompt():
    pass