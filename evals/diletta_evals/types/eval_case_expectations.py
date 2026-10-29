# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, RootModel, StringConstraints


class Rubric(RootModel[str]):
    root: Annotated[str, Field(max_length=4000, min_length=1)]


class Kind(StrEnum):
    contains = "contains"
    not_contains = "not_contains"


class Rule(BaseModel):
    kind: Kind
    text: Annotated[str, Field(max_length=500, min_length=1)]


class ForbiddenTool(RootModel[str]):
    root: Annotated[str, Field(pattern="^[A-Za-z][A-Za-z0-9_-]{0,63}$")]


class EvalCaseJsonValue(
    RootModel[
        Optional[
            Union[
                str,
                float,
                bool,
                list[Optional["EvalCaseJsonValue"]],
                dict[str, Optional["EvalCaseJsonValue"]],
            ]
        ]
    ]
):
    root: Optional[
        Union[
            str,
            float,
            bool,
            list[Optional["EvalCaseJsonValue"]],
            dict[str, Optional["EvalCaseJsonValue"]],
        ]
    ]


class ToolCall(BaseModel):
    toolName: Annotated[str, Field(pattern="^[A-Za-z][A-Za-z0-9_-]{0,63}$")]
    args: dict[
        Annotated[str, StringConstraints(min_length=1)], EvalCaseJsonValue | None
    ]


class Readback(BaseModel):
    toolName: Annotated[str, Field(pattern="^[A-Za-z][A-Za-z0-9_-]{0,63}$")]
    expect: dict[
        Annotated[str, StringConstraints(min_length=1)], EvalCaseJsonValue | None
    ]


class EvalCaseExpectations(BaseModel):
    """
    eval_cases.expectations at schemaVersion 2 (older bodies upgraded by loadEvalCaseExpectations)
    """

    schemaVersion: Literal[2]
    rubric: Rubric | None
    rules: Annotated[list[Rule], Field(max_length=20)]
    toolCalls: Annotated[list[ToolCall], Field(max_length=10)]
    forbiddenTools: Annotated[list[ForbiddenTool], Field(max_length=20)]
    readbacks: Annotated[list[Readback], Field(max_length=10)]


EvalCaseJsonValue.model_rebuild()
