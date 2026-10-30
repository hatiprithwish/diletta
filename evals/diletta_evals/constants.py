"""packages/schemas constants the harness needs, read from the generated types (evals/schemas/eval-constants.schema.json,
pnpm evals:types), never copied by hand: a change on the TypeScript side changes them here, and pnpm evals:check fails
until the types are regenerated.
"""

import typing

from diletta_evals.types.eval_constants import EvalHarnessConstants


def _literal(field: str) -> typing.Any:
    (value,) = typing.get_args(EvalHarnessConstants.model_fields[field].annotation)
    return value


EVAL_JWT_ISSUER: str = _literal("evalJwtIssuer")
EVAL_JWT_AUDIENCE: str = _literal("evalJwtAudience")
EVAL_JWT_MAX_LIFETIME_SECONDS: int = _literal("evalJwtMaxLifetimeSeconds")
EVAL_HOST_TOKEN_HEADER: str = _literal("evalHostTokenHeader")
TEST_HOST_ADMIN_HEADER: str = _literal("testHostAdminHeader")
TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS: int = _literal("testHostTokenMaxLifetimeSeconds")
