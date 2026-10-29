"""Generate the Pydantic types in diletta_evals/types/ from evals/schemas/*.schema.json (M5-1).

The JSON Schema files are generated from packages/schemas (`pnpm --filter @app/schemas schema:export`), so the
Python types follow the Zod schemas: one module per file, named after it (eval-case-input.schema.json →
eval_case_input.py). Never edit a generated module by hand.

    uv run python scripts/generate_types.py           # rewrite diletta_evals/types/
    uv run python scripts/generate_types.py --check   # exit 1 when a module is stale, missing or extra
"""

import argparse
import subprocess
import sys
from pathlib import Path

EVALS_DIR = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = EVALS_DIR / "schemas"
TYPES_DIR = EVALS_DIR / "diletta_evals" / "types"
SCHEMA_SUFFIX = ".schema.json"
HEADER = "Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit."

# The flags are part of the contract: changing one regenerates every module
CODEGEN_FLAGS = [
    "--input-file-type",
    "jsonschema",
    "--output-model-type",
    "pydantic_v2.BaseModel",
    "--target-python-version",
    "3.12",
    "--use-title-as-name",
    "--use-annotated",
    "--field-constraints",
    "--use-standard-collections",
    "--use-union-operator",
    "--use-double-quotes",
    "--use-schema-description",
    "--disable-timestamp",
    "--formatters",
    "black",
    "isort",
    "--custom-file-header",
    f"# {HEADER}",
]

INIT_MODULE = f'"""{HEADER}"""\n'


def module_name(schema_file: Path) -> str:
    return schema_file.name.removesuffix(SCHEMA_SUFFIX).replace("-", "_")


def codegen(schema_file: Path, output: Path, check: bool) -> bool:
    command = [
        "datamodel-codegen",
        "--input",
        str(schema_file),
        "--output",
        str(output),
        *CODEGEN_FLAGS,
    ]
    if check:
        command.append("--check")
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify only, write nothing")
    args = parser.parse_args()

    schema_files = sorted(SCHEMAS_DIR.glob(f"*{SCHEMA_SUFFIX}"))
    expected = {f"{module_name(path)}.py" for path in schema_files} | {"__init__.py"}
    is_ok = True

    if args.check:
        present = {path.name for path in TYPES_DIR.glob("*.py")}
        for name in sorted(expected - present):
            sys.stderr.write(f"Missing diletta_evals/types/{name}\n")
            is_ok = False
        for name in sorted(present - expected):
            sys.stderr.write(f"No schema for diletta_evals/types/{name}\n")
            is_ok = False
        init = TYPES_DIR / "__init__.py"
        if init.exists() and init.read_text() != INIT_MODULE:
            sys.stderr.write("Stale diletta_evals/types/__init__.py\n")
            is_ok = False
    else:
        TYPES_DIR.mkdir(parents=True, exist_ok=True)
        for path in TYPES_DIR.glob("*.py"):
            if path.name not in expected:
                path.unlink()
        (TYPES_DIR / "__init__.py").write_text(INIT_MODULE)

    for schema_file in schema_files:
        output = TYPES_DIR / f"{module_name(schema_file)}.py"
        if args.check and not output.exists():
            continue
        if not codegen(schema_file, output, args.check):
            sys.stderr.write(f"{'Stale' if args.check else 'Failed'}: diletta_evals/types/{output.name}\n")
            is_ok = False
        elif not args.check:
            sys.stdout.write(f"Wrote diletta_evals/types/{output.name}\n")

    if args.check and not is_ok:
        sys.stderr.write("Python types don't match evals/schemas/: run `pnpm evals:types` and commit them\n")
    return 0 if is_ok else 1


if __name__ == "__main__":
    sys.exit(main())
