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

// DEV_NOTE: A case as an admin writes it (New case, Edit, and Create test on the Quality page): the conversation and the
// rubric of a v1 case, with its name
export const ZEvalCaseDraft = z.object({
  name: ZEvalCaseName,
  messages: ZEvalCaseMessages,
  rubric: ZEvalCaseRubric,
});
export type EvalCaseDraft = z.infer<typeof ZEvalCaseDraft>;

// DEV_NOTE: A case's conversation and rubric, the part of a draft its input and expectations hold
export type EvalCaseBody = Pick<EvalCaseDraft, "messages" | "rubric">;

// DEV_NOTE: The one way a stored case's input and expectations are read for the dashboard. null = a shape this page
// can't show or edit (M5-1's v2 adds its upgrader here).
export function readEvalCaseBody(input: unknown, expectations: unknown): EvalCaseBody | null {
  const parsedInput = ZEvalCaseInputV1.safeParse(input);
  const parsedExpectations = ZEvalCaseExpectationsV1.safeParse(expectations);
  if (!parsedInput.success || !parsedExpectations.success) return null;
  return { messages: parsedInput.data.messages, rubric: parsedExpectations.data.rubric };
}

// DEV_NOTE: The v1 input and expectations of a body, as they are stored
export function toEvalCaseV1(body: EvalCaseBody): {
  input: EvalCaseInputV1;
  expectations: EvalCaseExpectationsV1;
} {
  return {
    input: { schemaVersion: EVAL_CASE_INPUT_SCHEMA_VERSION, messages: body.messages },
    expectations: { schemaVersion: EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION, rubric: body.rubric },
  };
}

export enum EvalCaseSortColumn {
  CreatedAt = "createdAt",
  Name = "name",
}

export const ZEvalCaseSortColumn = z.enum(EvalCaseSortColumn);

// DEV_NOTE: The Cases tab's rows per page
export const EVAL_CASES_PAGE_SIZE = 25;

// DEV_NOTE: Why an edit changed nothing (409): the stored conversation or rubric is a shape this page can't rewrite
// (readEvalCaseBody null). Turning the case on or off still works.
export enum EvalCaseUpdateFailureEnum {
  NotEditable = "NotEditable",
}
