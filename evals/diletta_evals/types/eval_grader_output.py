# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, Field, RootModel


class Kind(StrEnum):
    forbidden_tool = "forbidden_tool"
    tool_call = "tool_call"
    readback = "readback"
    judge = "judge"
    rubric = "rubric"


class Detail(RootModel[str]):
    root: Annotated[str, Field(max_length=1000)]


class Check(BaseModel):
    kind: Kind
    hasPassed: bool
    label: Annotated[str, Field(max_length=200, min_length=1)]
    detail: Detail | None


class Error(RootModel[str]):
    root: Annotated[str, Field(max_length=1000, min_length=1)]


class EvalGraderOutput(BaseModel):
    """
    eval_results.grader_output at schemaVersion 1
    """

    schemaVersion: Literal[1]
    checks: Annotated[list[Check], Field(max_length=50)]
    error: Error | None
