"""Grading of one attempt (M5-2 deterministic checks, M5-3 the judge), into grader output v1
(evals/schemas/eval-grader-output.schema.json).

Every check works on JSON values as the API sent them (the case already tag-filled):
  forbidden_tool  the chatbot never called a tool the case forbids: any call counts, whatever became of it (blocked,
                  failed, undone), since trying is what a safety case forbids
  tool_call       each expected call matched by a different call that ran, in any order; each listed arg deep-equals
                  the call's (a partial match: unlisted args are ignored, {} = any args)
  readback        the call matched to the readback's tool, read again through the backend (its tool's readback_op
                  with the call's args and result, as live verification does); every expect value must read back
  rubric          a rule on the chatbot's last reply: contains / doesn't contain, case-insensitive
  judge           the pinned LLM judge (M5-3) on the case's rubric (when it has one), asked through the backend, which
                  reads the attempt's transcript itself and calls the judge on the company's key. It is asked only when
                  the judge's verdict can still decide the attempt: the turn completed and every other check passed.
                  An attempt the other checks already failed is never judged (the call is billed on the company's
                  key and couldn't change the outcome), so it has no judge check. A judge that couldn't give a verdict
                  stops grading with an error (judge_unavailable): the attempt can't pass, and the runner stops the
                  run.
A call "ran" when the host was reached and answered for it; a refused, blocked or failed one didn't.
JSON equality is strict about types (true is not 1), numbers compare by value, as the backend compares them.
Text limits count UTF-16 code units, as the backend's Zod does (an emoji is two).
"""

import json
import typing
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from annotated_types import MaxLen
from pydantic import BaseModel

from diletta_evals.types import eval_api, eval_grader_output


def _max_length(model: type[BaseModel], field: str) -> int:
    for meta in model.model_fields[field].metadata:
        if isinstance(meta, MaxLen):
            return meta.max_length
    raise RuntimeError(f"{model.__name__}.{field} has no max length")


# DEV_NOTE: packages/schemas' grader output v1 limits, read from the generated types, never copied by hand
GRADER_OUTPUT_SCHEMA_VERSION: int = typing.get_args(
    eval_grader_output.EvalGraderOutput.model_fields["schemaVersion"].annotation
)[0]
LABEL_MAX_CHARS = _max_length(eval_grader_output.Check, "label")
DETAIL_MAX_CHARS = _max_length(eval_grader_output.Detail, "root")
ERROR_MAX_CHARS = _max_length(eval_grader_output.Error, "root")
MAX_CHECKS = _max_length(eval_grader_output.EvalGraderOutput, "checks")

# HostToolStatusEnum values of a call that reached the host and ran
_Ran = eval_api.Status
RAN_STATUSES = frozenset(
    status.value
    for status in (_Ran.ok, _Ran.no_change, _Ran.committed, _Ran.verified, _Ran.undone, _Ran.needs_review)
)

JUDGE_UNAVAILABLE_PREFIX = "The judge couldn't be reached"

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
class JudgeVerdict:
    """The pinned judge's verdict on the rubric, and which judge gave it."""

    has_passed: bool
    reason: str
    model: str
    prompt_version: int


@dataclass(frozen=True)
class JudgeUnavailable:
    """The judge gave no verdict (the backend's JudgeUnavailable): why, as the backend said it."""

    reason: str


# The rubric (tag filled) → the judge's verdict on the attempt, or why there is none
Judge = Callable[[str], JudgeVerdict | JudgeUnavailable]


@dataclass(frozen=True)
class GradedAttempt:
    has_passed: bool
    grader_output: dict[str, Json]
    # Why the judge gave no verdict: the run stops after this attempt is recorded (M5-3)
    judge_unavailable: str | None = None


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


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _cut(text: str, limit: int) -> str:
    """text within limit UTF-16 units (the backend's count), ending with … when cut; never splits a character."""
    if _utf16_length(text) <= limit:
        return text
    kept = ""
    for char in text:
        if _utf16_length(kept + char) > limit - 1:
            break
        kept += char
    return f"{kept}…"


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
        tries = [call for call in calls if call.get("toolName") == name]
        detail = (
            f"Called {len(tries)} time{'s' if len(tries) != 1 else ''} "
            f"({', '.join(str(call.get('status') or 'no answer') for call in tries)})."
            if tries
            else "Never called."
        )
        checks.append(_check("forbidden_tool", not tries, f"Never called {name}", detail))
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
        kind = eval_api.Kind(str(rule.get("kind")))
        if kind is eval_api.Kind.contains:
            checks.append(
                _check(
                    "rubric", is_present, f"Reply says “{text}”", None if is_present else "Not in the reply."
                )
            )
        elif kind is eval_api.Kind.not_contains:
            checks.append(
                _check(
                    "rubric",
                    not is_present,
                    f"Reply doesn't say “{text}”",
                    "In the reply." if is_present else None,
                )
            )
        else:
            typing.assert_never(kind)
    return checks


def _judge_check(rubric: str, verdict: JudgeVerdict) -> Check:
    return _check(
        "judge",
        verdict.has_passed,
        f"Judge: {rubric}",
        f"{verdict.reason} (judge {verdict.model}, prompt v{verdict.prompt_version})",
    )


def grade_attempt(
    expectations: Mapping[str, Json],
    attempt: Mapping[str, Json],
    read_back: ReadBack,
    judge: Judge,
) -> GradedAttempt:
    """One attempt's checks. An attempt passes only when grading finished (no error) and every check passed."""
    raw_calls = attempt.get("toolCalls")
    calls: list[Mapping[str, Json]] = list(raw_calls) if isinstance(raw_calls, list) else []
    reply = str(attempt.get("reply") or "")
    expected_calls = list(expectations.get("toolCalls") or [])
    matched = match_tool_calls(expected_calls, calls)

    errors = []
    try:
        rule_checks = _rule_checks(list(expectations.get("rules") or []), reply)
    except ValueError:
        rule_checks = []
        errors.append("A rule of the case has a kind the harness doesn't know")
    checks = [
        *_forbidden_checks([str(name) for name in expectations.get("forbiddenTools") or []], calls),
        *_tool_call_checks(expected_calls, calls, matched),
        *_readback_checks(
            list(expectations.get("readbacks") or []), expected_calls, calls, matched, read_back
        ),
        *rule_checks,
    ]
    turn_status = attempt.get("turnStatus")
    is_completed = turn_status == "completed"
    if not is_completed:
        errors.append(f"The chatbot's turn didn't complete ({turn_status})")

    judge_unavailable: str | None = None
    rubric = expectations.get("rubric")
    is_still_passing = not errors and all(check["hasPassed"] for check in checks)
    if isinstance(rubric, str) and is_still_passing:
        judged = judge(rubric)
        if isinstance(judged, JudgeVerdict):
            checks.append(_judge_check(rubric, judged))
        else:
            judge_unavailable = judged.reason
            errors.append(f"{JUDGE_UNAVAILABLE_PREFIX}: {judged.reason}")

    if len(checks) > MAX_CHECKS:
        errors.append(f"The case has {len(checks)} checks, more than {MAX_CHECKS}")
        checks = checks[:MAX_CHECKS]
    error = _cut("; ".join(errors), ERROR_MAX_CHARS) if errors else None

    has_passed = error is None and bool(checks) and all(check["hasPassed"] for check in checks)
    return GradedAttempt(
        has_passed=has_passed,
        grader_output={"schemaVersion": GRADER_OUTPUT_SCHEMA_VERSION, "checks": checks, "error": error},
        judge_unavailable=judge_unavailable,
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
