"""The {case.tag} placeholder (M5-1): one unique token per attempt, filled into a case's message text, rule text and
every string value of its expected calls and readbacks before the attempt runs. Attempts never see each other's
records, and a readback asserts only on its own.
"""

import secrets
import typing

from diletta_evals.types.eval_case_tag import EvalCaseTag

# packages/schemas EVAL_CASE_TAG_PLACEHOLDER, read from the generated type (evals/schemas/eval-case-tag.schema.json)
CASE_TAG_PLACEHOLDER: str = typing.get_args(EvalCaseTag.model_fields["root"].annotation)[0]
# DEV_NOTE: A tag is exactly as long as the placeholder, so filling it in never makes a text longer than the case's
# own (a message at the length limit stays valid): "t" and 9 hex digits (36 random bits)
CASE_TAG_LENGTH = len(CASE_TAG_PLACEHOLDER)


def new_case_tag() -> str:
    return f"t{secrets.token_hex(CASE_TAG_LENGTH)[: CASE_TAG_LENGTH - 1]}"


def fill_case_tag(value: object, tag: str) -> object:
    """A JSON value with every string (at any depth; dict keys stay as they are) carrying the tag."""
    if isinstance(value, str):
        return value.replace(CASE_TAG_PLACEHOLDER, tag)
    if isinstance(value, list):
        return [fill_case_tag(item, tag) for item in value]
    if isinstance(value, dict):
        return {key: fill_case_tag(item, tag) for key, item in value.items()}
    return value
