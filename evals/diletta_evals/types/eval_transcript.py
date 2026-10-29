# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from enum import Enum, StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, Field, RootModel


class Role(StrEnum):
    user = "user"
    assistant = "assistant"


class Entries(BaseModel):
    kind: Literal["message"]
    role: Role
    text: Annotated[str, Field(max_length=20000)]


class Status(Enum):
    number_1 = 1
    number_2 = 2
    number_3 = 3


class Summary(RootModel[str]):
    root: Annotated[str, Field(max_length=500)]


class Entries1(BaseModel):
    kind: Literal["tool_call"]
    toolName: Annotated[str, Field(max_length=200, min_length=1)]
    toolVersion: Annotated[int, Field(ge=1, le=9007199254740991)]
    status: Status
    summary: Summary | None


class EvalTranscript(BaseModel):
    """
    An eval attempt's transcript file in R2 (files.owner_type eval_result) at schemaVersion 1
    """

    schemaVersion: Literal[1]
    entries: Annotated[list[Entries | Entries1], Field(max_length=500)]
