# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class EvalHarnessConstants(BaseModel):
    """
    Constants the harness needs that no request or answer carries (the eval JWT, headers, the test host's token), each a literal: read by the harness, never sent
    """

    evalJwtIssuer: Literal["diletta-eval-harness"]
    evalJwtAudience: Literal["diletta-eval"]
    evalJwtMaxLifetimeSeconds: Literal[300]
    evalHostTokenHeader: Literal["X-Host-Token"]
    testHostAdminHeader: Literal["X-Test-Host-Admin"]
    testHostTokenMaxLifetimeSeconds: Literal[300]
