"""The {case.tag} filler (diletta_evals.tags)."""

from diletta_evals.tags import CASE_TAG_PLACEHOLDER, fill_case_tag, new_case_tag


def test_fills_every_string_at_any_depth_and_leaves_keys_and_other_values() -> None:
    value = {
        "text": f"Drill {CASE_TAG_PLACEHOLDER}",
        CASE_TAG_PLACEHOLDER: [f"{CASE_TAG_PLACEHOLDER}-{CASE_TAG_PLACEHOLDER}", 1, None, True],
    }
    assert fill_case_tag(value, "t1") == {
        "text": "Drill t1",
        CASE_TAG_PLACEHOLDER: ["t1-t1", 1, None, True],
    }


def test_each_attempt_gets_its_own_tag() -> None:
    assert len({new_case_tag() for _ in range(50)}) == 50


def test_a_tag_is_as_long_as_the_placeholder_so_a_filled_text_never_grows() -> None:
    for _ in range(50):
        assert len(new_case_tag()) == len(CASE_TAG_PLACEHOLDER)
    text = "x" * 3990 + CASE_TAG_PLACEHOLDER
    assert len(str(fill_case_tag(text, new_case_tag()))) == len(text)
