from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field


class GraphClassSchema(BaseModel):
    parameters: dict[str, Any] = Field(min_length=1)
    parameters_to_embed: list[str] = []

    def describe(self) -> str:
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

class RelationSchema(BaseModel):
    parameters: dict[str, Any] = Field(default_factory=dict)

    def describe(self) -> str:
        if not self.parameters:
            return "(brak właściwości)"
        return ', '.join([f"'{k}': {type(v).__name__} (default={v})" for k, v in self.parameters.items()])

@dataclass
class RelationEdge:
    target: str
    r_parameters: dict[str, Any] = field(default_factory=dict)

@dataclass
class GraphNode:
    c_name: str
    c_parameters: dict[str, Any] = field(default_factory=dict)
    n_relations: dict[str, list[RelationEdge]] = field(default_factory=dict)
    n_labels: set[str] = field(default_factory=set)
    embeddings: list[float] | None = None
    module: str = ""