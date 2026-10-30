"""Grading (diletta_evals.graders): every check kind (the judge's too), the matching, and when an attempt passes."""

import json

from diletta_evals.graders import (
    JUDGE_UNAVAILABLE_PREFIX,
    LABEL_MAX_CHARS,
    MAX_CHECKS,
    JudgeUnavailable,
    JudgeVerdict,
    ReadbackOutcome,
    failed_attempt,
    grade_attempt,
    json_equal,
    match_tool_calls,
)
from diletta_evals.types.eval_grader_output import EvalGraderOutput


def expectations(**overrides: object) -> dict[str, object]:
    return {
        "schemaVersion": 2,
        "rubric": None,
        "rules": [],
        "toolCalls": [],
        "forbiddenTools": [],
        "readbacks": [],
        **overrides,
    }


def call(name: str, args: dict[str, object] | None, status: str | None = "ok", cr: str | None = None):
    return {
        "toolCallId": f"t_{name}",
        "toolName": name,
        "args": args,
        "status": status,
        "changeRequestId": cr,
    }


def attempt(*calls: dict[str, object], reply: str = "Done.", turn: str = "completed") -> dict[str, object]:
    return {"turnStatus": turn, "reply": reply, "toolCalls": list(calls), "conversationId": "conv_1"}


def no_readback(_call: object, _readback: object) -> ReadbackOutcome:
    raise AssertionError("no readback expected")


def no_judge(_rubric: str) -> JudgeVerdict | JudgeUnavailable:
    raise AssertionError("no judge expected")


def test_json_equal_is_strict_about_types() -> None:
    assert json_equal(300, 300.0)
    assert not json_equal(True, 1)
    assert not json_equal("300", 300)
    assert json_equal({"a": [1, {"b": None}]}, {"a": [1.0, {"b": None}]})
    assert not json_equal({"a": 1}, {"a": 1, "b": 2})


def test_matching_gives_each_expected_call_a_different_call() -> None:
    expected = [
        {"toolName": "create_record", "args": {}},
        {"toolName": "create_record", "args": {"name": "Drill"}},
    ]
    calls = [call("create_record", {"name": "Drill"}), call("create_record", {"name": "Other"})]
    # DEV_NOTE: The first expected call fits both; it must leave the Drill call to the second
    assert match_tool_calls(expected, calls) == [1, 0]
    assert match_tool_calls(expected, calls[:1]) in ([0, None], [None, 0])


def test_a_call_that_didnt_run_never_matches() -> None:
    expected = [{"toolName": "update_record", "args": {}}]
    assert match_tool_calls(expected, [call("update_record", {}, status="blocked")]) == [None]
    assert match_tool_calls(expected, [call("update_record", {}, status=None)]) == [None]


def test_passes_when_every_check_passes_and_the_output_fits_the_schema() -> None:
    graded = grade_attempt(
        expectations(
            rules=[{"kind": "contains", "text": "ALPHA"}, {"kind": "not_contains", "text": "error"}],
            toolCalls=[{"toolName": "update_record", "args": {"recordId": "rec_alpha", "amount": 300}}],
            forbiddenTools=["delete_record"],
            readbacks=[{"toolName": "update_record", "expect": {"amount": 300}}],
        ),
        attempt(
            call("update_record", {"recordId": "rec_alpha", "amount": 300}, "verified", "cr_1"),
            reply="Alpha now holds 300.",
        ),
        lambda c, r: ReadbackOutcome(
            verdict="matches",
            fields=[{"name": "amount", "isMatch": True, "expected": 300, "found": 300, "isFound": True}],
            reason=None,
        ),
        no_judge,
    )
    assert graded.has_passed
    output = EvalGraderOutput.model_validate(graded.grader_output)
    assert [check.kind.value for check in output.checks] == [
        "forbidden_tool",
        "tool_call",
        "readback",
        "rubric",
        "rubric",
    ]
    assert output.checks[2].detail is not None and output.checks[2].detail.root == "Read back: amount 300."


def test_fails_on_a_forbidden_call_a_missing_call_and_a_rule() -> None:
    graded = grade_attempt(
        expectations(
            rules=[{"kind": "not_contains", "text": "deleted"}],
            toolCalls=[{"toolName": "update_record", "args": {"amount": 300}}],
            forbiddenTools=["delete_record"],
        ),
        attempt(
            call("delete_record", {"recordId": "rec_alpha"}, "verified", "cr_2"),
            call("update_record", {"amount": 301}, "verified", "cr_3"),
            reply="I deleted it.",
        ),
        no_readback,
        no_judge,
    )
    assert not graded.has_passed
    checks = graded.grader_output["checks"]
    assert isinstance(checks, list)
    assert [check["hasPassed"] for check in checks] == [False, False, False]
    assert checks[1]["detail"] == "update_record was called 1 time, but no call that ran had these args."


def test_a_readback_that_differs_or_is_unknown_fails_with_what_it_found() -> None:
    case = expectations(
        toolCalls=[{"toolName": "update_record", "args": {}}],
        readbacks=[{"toolName": "update_record", "expect": {"status": "closed"}}],
    )
    run = attempt(call("update_record", {"status": "closed"}, "verified", "cr_1"))
    differs = grade_attempt(
        case,
        run,
        lambda c, r: ReadbackOutcome(
            verdict="differs",
            fields=[
                {"name": "status", "isMatch": False, "expected": "closed", "found": "open", "isFound": True}
            ],
            reason=None,
        ),
        no_judge,
    )
    assert not differs.has_passed
    checks = differs.grader_output["checks"]
    assert isinstance(checks, list)
    assert checks[1]["detail"] == 'Read back: status: expected "closed", found "open".'
    unknown = grade_attempt(
        case, run, lambda c, r: ReadbackOutcome(verdict="unknown", fields=[], reason="HTTP 404"), no_judge
    )
    assert not unknown.has_passed


def test_a_readback_without_a_matched_change_fails_without_calling_the_backend() -> None:
    graded = grade_attempt(
        expectations(
            toolCalls=[{"toolName": "update_record", "args": {}}],
            readbacks=[{"toolName": "update_record", "expect": {"amount": 1}}],
        ),
        attempt(call("update_record", {"amount": 1}, "no_change", None)),
        no_readback,
        no_judge,
    )
    checks = graded.grader_output["checks"]
    assert isinstance(checks, list)
    assert checks[1]["detail"] == "The update_record call made no change to read back."


def test_the_judge_grades_the_rubric_next_to_the_rules_and_names_itself() -> None:
    asked: list[str] = []

    def judge(rubric: str) -> JudgeVerdict:
        asked.append(rubric)
        return JudgeVerdict(
            has_passed=True, reason="Says drills are quarterly.", model="claude-sonnet-5-5", prompt_version=1
        )

    graded = grade_attempt(
        expectations(rubric="Says drills are quarterly.", rules=[{"kind": "contains", "text": "quarterly"}]),
        attempt(reply="Quarterly."),
        no_readback,
        judge,
    )
    assert asked == ["Says drills are quarterly."]
    assert graded.has_passed
    assert graded.judge_unavailable is None
    EvalGraderOutput.model_validate_json(json.dumps(graded.grader_output), strict=True)
    checks = graded.grader_output["checks"]
    assert isinstance(checks, list)
    assert checks[-1] == {
        "kind": "judge",
        "hasPassed": True,
        "label": "Judge: Says drills are quarterly.",
        "detail": "Says drills are quarterly. (judge claude-sonnet-5-5, prompt v1)",
    }

    failed = grade_attempt(
        expectations(rubric="Says drills are monthly."),
        attempt(reply="Quarterly."),
        no_readback,
        lambda _rubric: JudgeVerdict(
            has_passed=False, reason="Says quarterly, not monthly.", model="gpt-6.1-sol", prompt_version=1
        ),
    )
    assert not failed.has_passed
    assert failed.grader_output["error"] is None


def test_an_unreachable_judge_stops_grading_with_why_and_keeps_the_other_checks() -> None:
    graded = grade_attempt(
        expectations(rubric="Says drills are quarterly.", rules=[{"kind": "contains", "text": "quarterly"}]),
        attempt(reply="Quarterly."),
        no_readback,
        lambda _rubric: JudgeUnavailable(reason="HTTP 503: The judge model couldn't be reached (JudgeUnavailable)"),
    )
    assert not graded.has_passed
    assert graded.judge_unavailable == "HTTP 503: The judge model couldn't be reached (JudgeUnavailable)"
    assert graded.grader_output["error"] == (
        f"{JUDGE_UNAVAILABLE_PREFIX}: HTTP 503: The judge model couldn't be reached (JudgeUnavailable)"
    )
    checks = graded.grader_output["checks"]
    assert isinstance(checks, list)
    assert [check["kind"] for check in checks] == ["rubric"]


def test_an_unfinished_turn_stops_grading_with_an_error_and_is_never_judged() -> None:
    cut = grade_attempt(
        expectations(rubric="Says x.", rules=[{"kind": "contains", "text": "x"}]),
        attempt(reply="x", turn="error"),
        no_readback,
        no_judge,
    )
    assert not cut.has_passed
    assert cut.grader_output["error"] == "The chatbot's turn didn't complete (error)"


def test_an_attempt_that_never_ran_fails_with_its_reason() -> None:
    graded = failed_attempt("The attempt didn't run: HTTP 503: The chatbot can't answer")
    assert not graded.has_passed
    EvalGraderOutput.model_validate(graded.grader_output)


def test_a_forbidden_tool_fails_whatever_became_of_the_call() -> None:
    for status in ("error", "blocked", "undone", None):
        graded = grade_attempt(
            expectations(forbiddenTools=["delete_record"], rules=[{"kind": "contains", "text": "Done"}]),
            attempt(call("delete_record", {"recordId": "r1"}, status=status)),
            no_readback,
        no_judge,
        )
        assert not graded.has_passed
        [forbidden] = [check for check in graded.grader_output["checks"] if check["kind"] == "forbidden_tool"]
        assert not forbidden["hasPassed"]


def test_an_unknown_rule_kind_stops_grading_instead_of_reading_as_doesnt_contain() -> None:
    graded = grade_attempt(
        expectations(rules=[{"kind": "starts_with", "text": "Done"}]), attempt(), no_readback, no_judge
    )
    assert not graded.has_passed
    assert "kind" in str(graded.grader_output["error"])


def test_cuts_text_by_utf16_units_as_the_backend_counts() -> None:
    label = "😀" * 150
    graded = grade_attempt(expectations(rules=[{"kind": "contains", "text": label}]), attempt(), no_readback, no_judge)
    EvalGraderOutput.model_validate(graded.grader_output)
    [check] = graded.grader_output["checks"]
    assert len(str(check["label"]).encode("utf-16-le")) // 2 <= LABEL_MAX_CHARS
    assert str(check["label"]).endswith("…")


def test_the_most_checks_a_valid_case_can_have_still_fit_the_grader_output() -> None:
    graded = grade_attempt(
        expectations(
            rules=[{"kind": "contains", "text": f"r{i}"} for i in range(20)],
            toolCalls=[{"toolName": f"tool_{i}", "args": {}} for i in range(10)],
            forbiddenTools=[f"never_{i}" for i in range(20)],
            readbacks=[{"toolName": f"tool_{i}", "expect": {"a": 1}} for i in range(10)],
        ),
        attempt(),
        no_readback,
        no_judge,
    )
    assert len(graded.grader_output["checks"]) == 60 <= MAX_CHECKS
    EvalGraderOutput.model_validate(graded.grader_output)
