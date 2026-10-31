# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, Field


class Role(StrEnum):
    user = "user"
    assistant = "assistant"


class Message(BaseModel):
    role: Role
    text: Annotated[str, Field(max_length=4000, min_length=1)]


class EvalCaseInput(BaseModel):
    """
    eval_cases.input at schemaVersion 1
    """

    schemaVersion: Literal[1]
    messages: Annotated[list[Message], Field(max_length=20, min_length=1)]
