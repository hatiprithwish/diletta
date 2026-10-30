"""Deterministic grading (diletta_evals.graders): every check kind, the matching, and when an attempt passes."""

from diletta_evals.graders import (
    JUDGE_NOT_AVAILABLE,
    LABEL_MAX_CHARS,
    MAX_CHECKS,
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
    )
    assert not differs.has_passed
    checks = differs.grader_output["checks"]
    assert isinstance(checks, list)
    assert checks[1]["detail"] == 'Read back: status: expected "closed", found "open".'
    unknown = grade_attempt(
        case, run, lambda c, r: ReadbackOutcome(verdict="unknown", fields=[], reason="HTTP 404")
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
    )
    checks = graded.grader_output["checks"]
    assert isinstance(checks, list)
    assert checks[1]["detail"] == "The update_record call made no change to read back."


def test_a_rubric_or_an_unfinished_turn_stops_grading_with_an_error() -> None:
    judged = grade_attempt(
        expectations(rubric="Says drills are quarterly.", rules=[{"kind": "contains", "text": "quarterly"}]),
        attempt(reply="Quarterly."),
        no_readback,
    )
    assert not judged.has_passed
    assert judged.grader_output["error"] == JUDGE_NOT_AVAILABLE
    cut = grade_attempt(
        expectations(rules=[{"kind": "contains", "text": "x"}]), attempt(reply="x", turn="error"), no_readback
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
        )
        assert not graded.has_passed
        [forbidden] = [check for check in graded.grader_output["checks"] if check["kind"] == "forbidden_tool"]
        assert not forbidden["hasPassed"]


def test_an_unknown_rule_kind_stops_grading_instead_of_reading_as_doesnt_contain() -> None:
    graded = grade_attempt(
        expectations(rules=[{"kind": "starts_with", "text": "Done"}]), attempt(), no_readback
    )
    assert not graded.has_passed
    assert "kind" in str(graded.grader_output["error"])


def test_cuts_text_by_utf16_units_as_the_backend_counts() -> None:
    label = "😀" * 150
    graded = grade_attempt(expectations(rules=[{"kind": "contains", "text": label}]), attempt(), no_readback)
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
    )
    assert len(graded.grader_output["checks"]) == 60 <= MAX_CHECKS
    EvalGraderOutput.model_validate(graded.grader_output)
