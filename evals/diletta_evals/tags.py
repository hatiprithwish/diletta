"""The {case.tag} placeholder (M5-1): one unique token per attempt, filled into a case's message text, rule text and
every string value of its expected calls and readbacks before the attempt runs. Attempts never see each other's
records, and a readback asserts only on its own.
"""

import secrets

# packages/schemas EVAL_CASE_TAG_PLACEHOLDER (evals/schemas/eval-case-tag.schema.json)
CASE_TAG_PLACEHOLDER = "{case.tag}"


def new_case_tag() -> str:
    return f"t{secrets.token_hex(5)}"


def fill_case_tag(value: object, tag: str) -> object:
    """A JSON value with every string (at any depth; dict keys stay as they are) carrying the tag."""
    if isinstance(value, str):
        return value.replace(CASE_TAG_PLACEHOLDER, tag)
    if isinstance(value, list):
        return [fill_case_tag(item, tag) for item in value]
    if isinstance(value, dict):
        return {key: fill_case_tag(item, tag) for key, item in value.items()}
    return value
