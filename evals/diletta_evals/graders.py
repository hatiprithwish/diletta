"""Deterministic grading of one attempt (M5-2), into grader output v1 (evals/schemas/eval-grader-output.schema.json).

Every check works on JSON values as the API sent them (the case already tag-filled):
  forbidden_tool  a tool the case forbids never ran in the attempt
  tool_call       each expected call matched by a different call that ran, in any order; each listed arg deep-equals
                  the call's (a partial match: unlisted args are ignored, {} = any args)
  readback        the call matched to the readback's tool, read again through the backend (its tool's readback_op
                  with the call's args and result, as live verification does); every expect value must read back
  rubric          a rule on the chatbot's last reply: contains / doesn't contain, case-insensitive
The judge (rubric text, check kind judge) is M5-3: until then a case with a rubric stops grading with an error, so it
never passes. A call "ran" when the host was reached and answered for it; a refused, blocked or failed one didn't.
JSON equality is strict about types (true is not 1), numbers compare by value, as the backend compares them.
"""

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

# packages/schemas EVAL_GRADER_OUTPUT_SCHEMA_VERSION, EVAL_CHECK_LABEL_MAX_CHARS, EVAL_CHECK_DETAIL_MAX_CHARS,
# EVAL_GRADER_ERROR_MAX_CHARS (the generated types hold the same limits)
GRADER_OUTPUT_SCHEMA_VERSION = 1
LABEL_MAX_CHARS = 200
DETAIL_MAX_CHARS = 1000
ERROR_MAX_CHARS = 1000

# HostToolStatusEnum values of a call that reached the host and ran
RAN_STATUSES = frozenset({"ok", "no_change", "committed", "verified", "undone", "needs_review"})

JUDGE_NOT_AVAILABLE = "The judge isn't available yet (M5-3), so a case with a rubric can't pass"

Json = object
Check = dict[str, Json]


@dataclass(frozen=True)
class ReadbackOutcome:
    """What the backend's readback answered: verdict matches / differs / unknown, each field, why unknown."""

    verdict: str
    fields: list[Mapping[str, Json]]
    reason: str | None


# The call a readback re-reads (as the attempt answered it) and the readback (tag filled) → the backend's verdict
ReadBack = Callable[[Mapping[str, Json], Mapping[str, Json]], ReadbackOutcome]


@dataclass(frozen=True)
class GradedAttempt:
    has_passed: bool
    grader_output: dict[str, Json]


def json_equal(left: Json, right: Json) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(json_equal(left[key], right[key]) for key in left)
    return type(left) is type(right) and left == right


def show(value: Json) -> str:
    """A value as an admin reads it in a check's detail (an integral float without its .0)."""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _check(kind: str, has_passed: bool, label: str, detail: str | None) -> Check:
    return {
        "kind": kind,
        "hasPassed": has_passed,
        "label": _cut(label, LABEL_MAX_CHARS),
        "detail": _cut(detail, DETAIL_MAX_CHARS) if detail else None,
    }


def ran(call: Mapping[str, Json]) -> bool:
    return call.get("status") in RAN_STATUSES


def args_match(expected: Mapping[str, Json], call: Mapping[str, Json]) -> bool:
    args = call.get("args")
    if not isinstance(args, dict):
        return not expected
    return all(name in args and json_equal(value, args[name]) for name, value in expected.items())


def match_tool_calls(
    expected: Sequence[Mapping[str, Json]], calls: Sequence[Mapping[str, Json]]
) -> list[int | None]:
    """For each expected call, the index of the call that ran and matched it (each call used once), else None.

    Maximum bipartite matching (augmenting paths): an early expected call never takes the only call a later one fits.
    """
    fits = [
        [
            j
            for j, call in enumerate(calls)
            if ran(call)
            and call.get("toolName") == entry.get("toolName")
            and args_match(entry.get("args") or {}, call)
        ]
        for entry in expected
    ]
    owner: dict[int, int] = {}

    def assign(i: int, seen: set[int]) -> bool:
        for j in fits[i]:
            if j in seen:
                continue
            seen.add(j)
            if j not in owner or assign(owner[j], seen):
                owner[j] = i
                return True
        return False

    for i in range(len(expected)):
        assign(i, set())
    matched: list[int | None] = [None] * len(expected)
    for j, i in owner.items():
        matched[i] = j
    return matched


def _forbidden_checks(forbidden: Sequence[str], calls: Sequence[Mapping[str, Json]]) -> list[Check]:
    checks = []
    for name in forbidden:
        runs = [call for call in calls if call.get("toolName") == name and ran(call)]
        detail = f"Ran {len(runs)} time{'s' if len(runs) != 1 else ''}." if runs else "Never ran."
        checks.append(_check("forbidden_tool", not runs, f"Never called {name}", detail))
    return checks


def _tool_call_checks(
    expected: Sequence[Mapping[str, Json]],
    calls: Sequence[Mapping[str, Json]],
    matched: Sequence[int | None],
) -> list[Check]:
    checks = []
    for entry, index in zip(expected, matched):
        name = str(entry.get("toolName"))
        args = entry.get("args") or {}
        label = f"Called {name}" + (
            f" with {', '.join(f'{key} = {show(value)}' for key, value in args.items())}"
            if isinstance(args, dict) and args
            else ""
        )
        if index is not None:
            checks.append(_check("tool_call", True, label, None))
            continue
        same_name = [call for call in calls if call.get("toolName") == name]
        detail = (
            f"{name} was called {len(same_name)} time{'s' if len(same_name) != 1 else ''}, but no call "
            "that ran had these args."
            if same_name
            else f"{name} was never called."
        )
        checks.append(_check("tool_call", False, label, detail))
    return checks


def _readback_checks(
    readbacks: Sequence[Mapping[str, Json]],
    expected: Sequence[Mapping[str, Json]],
    calls: Sequence[Mapping[str, Json]],
    matched: Sequence[int | None],
    read_back: ReadBack,
) -> list[Check]:
    checks = []
    for readback in readbacks:
        name = str(readback.get("toolName"))
        label = f"{name} reads back as expected"
        entry = next((i for i, item in enumerate(expected) if item.get("toolName") == name), None)
        index = matched[entry] if entry is not None else None
        call = calls[index] if index is not None else None
        if call is None:
            checks.append(_check("readback", False, label, f"No call of {name} to read back."))
            continue
        if not call.get("changeRequestId"):
            checks.append(_check("readback", False, label, f"The {name} call made no change to read back."))
            continue
        outcome = read_back(call, readback)
        if outcome.verdict == "matches":
            found = "; ".join(f"{field.get('name')} {show(field.get('found'))}" for field in outcome.fields)
            checks.append(_check("readback", True, label, f"Read back: {found}."))
        elif outcome.verdict == "differs":
            differs = "; ".join(
                f"{field.get('name')}: expected {show(field.get('expected'))}, found "
                + (show(field.get("found")) if field.get("isFound") else "nothing")
                for field in outcome.fields
                if not field.get("isMatch")
            )
            checks.append(_check("readback", False, label, f"Read back: {differs}."))
        else:
            checks.append(
                _check("readback", False, label, outcome.reason or "The record couldn't be read back.")
            )
    return checks


def _rule_checks(rules: Sequence[Mapping[str, Json]], reply: str) -> list[Check]:
    checks = []
    folded = reply.casefold()
    for rule in rules:
        text = str(rule.get("text"))
        is_present = text.casefold() in folded
        if rule.get("kind") == "contains":
            checks.append(
                _check(
                    "rubric", is_present, f"Reply says “{text}”", None if is_present else "Not in the reply."
                )
            )
        else:
            checks.append(
                _check(
                    "rubric",
                    not is_present,
                    f"Reply doesn't say “{text}”",
                    "In the reply." if is_present else None,
                )
            )
    return checks


def grade_attempt(
    expectations: Mapping[str, Json],
    attempt: Mapping[str, Json],
    read_back: ReadBack,
) -> GradedAttempt:
    """One attempt's checks. An attempt passes only when grading finished (no error) and every check passed."""
    raw_calls = attempt.get("toolCalls")
    calls: list[Mapping[str, Json]] = list(raw_calls) if isinstance(raw_calls, list) else []
    reply = str(attempt.get("reply") or "")
    expected_calls = list(expectations.get("toolCalls") or [])
    matched = match_tool_calls(expected_calls, calls)

    checks = [
        *_forbidden_checks([str(name) for name in expectations.get("forbiddenTools") or []], calls),
        *_tool_call_checks(expected_calls, calls, matched),
        *_readback_checks(
            list(expectations.get("readbacks") or []), expected_calls, calls, matched, read_back
        ),
        *_rule_checks(list(expectations.get("rules") or []), reply),
    ]

    errors = []
    turn_status = attempt.get("turnStatus")
    if turn_status != "completed":
        errors.append(f"The chatbot's turn didn't complete ({turn_status})")
    if expectations.get("rubric") is not None:
        errors.append(JUDGE_NOT_AVAILABLE)
    error = _cut("; ".join(errors), ERROR_MAX_CHARS) if errors else None

    has_passed = error is None and bool(checks) and all(check["hasPassed"] for check in checks)
    return GradedAttempt(
        has_passed=has_passed,
        grader_output={"schemaVersion": GRADER_OUTPUT_SCHEMA_VERSION, "checks": checks, "error": error},
    )


def failed_attempt(reason: str) -> GradedAttempt:
    """An attempt that never ran (the backend refused it): no checks, the reason as the grading error."""
    return GradedAttempt(
        has_passed=False,
        grader_output={
            "schemaVersion": GRADER_OUTPUT_SCHEMA_VERSION,
            "checks": [],
            "error": _cut(reason, ERROR_MAX_CHARS),
        },
    )
