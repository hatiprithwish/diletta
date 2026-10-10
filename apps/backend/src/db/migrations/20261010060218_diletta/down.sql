-- Down for 20261010060218_diletta: drops tool_definitions.schema_version (M3-1: which ZToolOpsV<n> parses the ops).
ALTER TABLE "tool_definitions" DROP COLUMN "schema_version";
