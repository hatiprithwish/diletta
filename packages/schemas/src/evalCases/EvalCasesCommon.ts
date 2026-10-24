import { z } from "zod";

// DEV_NOTE: eval_cases.input and eval_cases.expectations are jsonb with no schema_version column, so each body carries
// its own schemaVersion. v1 (M4-6) is what a quality issue turns into: a conversation rewritten without personal
// details and a rubric the reply is judged by. M5-1 adds readback asserts, tool calls and forbidden tools as v2 with
// an upgrader from v1; a stored v1 body is never rewritten.
export const EVAL_CASE_INPUT_SCHEMA_VERSION = 1;
export const EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION = 1;

// DEV_NOTE: Sizes of a v1 case: the name, every message, how many messages (the conversation up to the question the
// case asks) and the rubric
export const EVAL_CASE_NAME_MAX_CHARS = 200;
export const EVAL_CASE_MESSAGE_MAX_CHARS = 4000;
export const EVAL_CASE_MAX_MESSAGES = 20;
export const EVAL_CASE_RUBRIC_MAX_CHARS = 4000;

export enum EvalCaseMessageRoleEnum {
  User = "user",
  Assistant = "assistant",
}

export const ZEvalCaseMessage = z.object({
  role: z.enum(EvalCaseMessageRoleEnum),
  text: z.string().trim().min(1).max(EVAL_CASE_MESSAGE_MAX_CHARS),
});
export type EvalCaseMessage = z.infer<typeof ZEvalCaseMessage>;

// DEV_NOTE: A case's conversation, oldest first. It ends with the user's question: the chatbot under test answers it.
export const ZEvalCaseMessages = z
  .array(ZEvalCaseMessage)
  .min(1)
  .max(EVAL_CASE_MAX_MESSAGES)
  .refine((messages) => messages.at(-1)?.role === EvalCaseMessageRoleEnum.User, {
    message: "The last message must be the user's",
  });

export const ZEvalCaseName = z.string().trim().min(1).max(EVAL_CASE_NAME_MAX_CHARS);
export const ZEvalCaseRubric = z.string().trim().min(1).max(EVAL_CASE_RUBRIC_MAX_CHARS);

export const ZEvalCaseInputV1 = z.object({
  schemaVersion: z.literal(EVAL_CASE_INPUT_SCHEMA_VERSION),
  messages: ZEvalCaseMessages,
});
export type EvalCaseInputV1 = z.infer<typeof ZEvalCaseInputV1>;

export const ZEvalCaseExpectationsV1 = z.object({
  schemaVersion: z.literal(EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION),
  rubric: ZEvalCaseRubric,
});
export type EvalCaseExpectationsV1 = z.infer<typeof ZEvalCaseExpectationsV1>;

// Whole Eval Case Body — DB shape
// DEV_NOTE: id, companyId and chatbotId are internal bigint ids — used by DAL/Repo only, NEVER sent to a client.
// companyId and chatbotId are both null for a platform case (CHK_eval_cases_platform_chatbot_id); input and
// expectations are jsonb (read untyped): read them through ZEvalCaseInputV1 / ZEvalCaseExpectationsV1.
export const ZEvalCase = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string().nullable(),
  chatbotId: z.string().nullable(),
  name: z.string(),
  input: z.unknown(),
  expectations: z.unknown(),
  isSafety: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type EvalCase = z.infer<typeof ZEvalCase>;
