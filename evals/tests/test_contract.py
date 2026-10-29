"""The generated types agree with packages/schemas on the contract samples (M5-1).

evals/fixtures/contract-samples.json is written by `pnpm --filter @app/schemas schema:export` from
packages/schemas/src/jsonSchemaContractSamples.ts, whose test holds the same bodies to the Zod schemas. Bodies are
read as JSON in strict mode, the way the harness reads them: a "2" is never an int.

Only the shape is shared: types, enums, required fields, sizes, patterns and counts. Zod's refinements have no JSON
Schema form, so a body that only a refinement refuses passes here (see jsonSchemaExports.ts for the list); cases are
only written through packages/schemas.
"""

import importlib
import json
from pathlib import Path

import pytest
from pydantic import BaseModel, RootModel, ValidationError

EVALS_DIR = Path(__file__).resolve().parent.parent
SAMPLES = json.loads((EVALS_DIR / "fixtures" / "contract-samples.json").read_text())
SCHEMA_SUFFIX = ".schema.json"


def model_for(file_name: str) -> type[BaseModel | RootModel]:
    schema = json.loads((EVALS_DIR / "schemas" / file_name).read_text())
    module = importlib.import_module(
        f"diletta_evals.types.{file_name.removesuffix(SCHEMA_SUFFIX).replace('-', '_')}"
    )
    return getattr(module, schema["title"])


def cases(kind: str) -> list[tuple[str, int, object]]:
    return [
        (file_name, index, sample)
        for file_name, samples in sorted(SAMPLES.items())
        for index, sample in enumerate(samples[kind])
    ]


def test_every_schema_has_samples() -> None:
    schema_files = sorted(path.name for path in (EVALS_DIR / "schemas").glob(f"*{SCHEMA_SUFFIX}"))
    assert sorted(SAMPLES) == schema_files
    for samples in SAMPLES.values():
        assert samples["valid"] and samples["invalid"]


@pytest.mark.parametrize(("file_name", "index", "sample"), cases("valid"))
def test_accepts_valid_sample(file_name: str, index: int, sample: object) -> None:
    model_for(file_name).model_validate_json(json.dumps(sample), strict=True)


@pytest.mark.parametrize(("file_name", "index", "sample"), cases("invalid"))
def test_refuses_invalid_sample(file_name: str, index: int, sample: object) -> None:
    with pytest.raises(ValidationError):
        model_for(file_name).model_validate_json(json.dumps(sample), strict=True)
