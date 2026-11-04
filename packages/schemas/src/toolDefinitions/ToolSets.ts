import { EREGISTER_TOOL_DEFINITIONS } from "../eregister/EregisterTools";
import type { ToolDefinitionSeed } from "./ToolDefinitionsCommon";

// DEV_NOTE: M7-8. A tool set is a host's whole bundle of tool definitions, written in code (eRegister's, M7-2). An
// operator loads one onto a company's connection from the Tools section (POST …/tool-definitions/tool-sets), which
// stores each tool the same way the eregister:tools script does: Active at its newest version, a new version only when
// the definition changed. The test host's tools stay with its own seed script (staging fixture, with its records).
export enum ToolSetEnum {
  Eregister = "eregister",
}

export enum ToolSetLabelEnum {
  Eregister = "eRegister",
}

export const TOOL_SET_LABEL_MAP: Record<ToolSetEnum, ToolSetLabelEnum> = {
  [ToolSetEnum.Eregister]: ToolSetLabelEnum.Eregister,
};

export const TOOL_SETS: Record<ToolSetEnum, ToolDefinitionSeed[]> = {
  [ToolSetEnum.Eregister]: EREGISTER_TOOL_DEFINITIONS,
};

// DEV_NOTE: What loading a tool set did to one tool:
//   Unchanged: its newest version is Active and the same as the set's.
//   Created: the company had no tool by that name; version 1, Active.
//   NewVersion: its newest version differs (definition or connection); a new Active version. Older Active versions
//     stay Active, so a bot version pinned to one keeps it.
//   Reactivated: its newest version is the same but Disabled; made Active again.
export enum ToolSetChangeEnum {
  Unchanged = "Unchanged",
  Created = "Created",
  NewVersion = "NewVersion",
  Reactivated = "Reactivated",
}
