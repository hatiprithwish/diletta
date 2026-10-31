# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, RootModel


class EvalCaseTag(RootModel[Literal["{case.tag}"]]):
    root: Annotated[
        Literal["{case.tag}"],
        Field(
            description="The placeholder an eval case's messages, rules and expected values carry; the harness fills it with one unique token per attempt",
            title="EvalCaseTag",
        ),
    ]
