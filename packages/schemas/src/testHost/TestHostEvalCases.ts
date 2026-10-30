import {
  EVAL_CASE_TAG_PLACEHOLDER,
  EvalCaseMessageRoleEnum,
  EvalCaseRuleKindEnum,
  type EvalCaseBody,
} from "../evalCases/EvalCasesCommon";

// DEV_NOTE: Our test company's own eval cases on the test host's tools (M5-5): the part of the nightly suite that drives
// the action engine (a write approved, committed and read back from the host) besides the platform cases every chatbot
// runs. They name the test host's tools and seed records (TEST_HOST_TOOL_DEFINITIONS, TEST_HOST_SEED_RECORDS), so they
// belong to the test company's default chatbot only, never to the platform. `pnpm --filter test-host seed` writes them,
// matched by name within that chatbot: a changed case is rewritten and turned on, an admin's other cases are left alone.
// A new record is named with {case.tag}, so attempts never see each other's; the update sets a fixed value, the same
// on every attempt, and the run's reset puts the seed records back.
export interface TestHostEvalCaseDefinition {
  name: string;
  body: EvalCaseBody;
}

const TAG = EVAL_CASE_TAG_PLACEHOLDER;

export const TEST_HOST_EVAL_CASES: TestHostEvalCaseDefinition[] = [
  {
    name: "Creates a record that reads back as asked",
    body: {
      messages: [
        {
          role: EvalCaseMessageRoleEnum.User,
          text: `Please add a new record named "Nightly ${TAG}" with the email nightly-${TAG}@example.com and an amount of 75.`,
        },
      ],
      rubric: null,
      checks: {
        rules: [],
        toolCalls: [{ toolName: "create_record", args: { name: `Nightly ${TAG}`, amount: 75 } }],
        forbiddenTools: ["delete_record"],
        readbacks: [
          {
            toolName: "create_record",
            expect: { name: `Nightly ${TAG}`, email: `nightly-${TAG}@example.com`, amount: 75 },
          },
        ],
      },
    },
  },
  {
    name: "Updates a record's amount and it reads back",
    body: {
      messages: [
        {
          role: EvalCaseMessageRoleEnum.User,
          text: "Set the amount on record rec_bravo to 88, please.",
        },
      ],
      rubric: null,
      checks: {
        rules: [],
        toolCalls: [{ toolName: "update_record", args: { recordId: "rec_bravo", amount: 88 } }],
        forbiddenTools: ["delete_record", "create_record"],
        readbacks: [{ toolName: "update_record", expect: { amount: 88 } }],
      },
    },
  },
  {
    name: "Looks a record up without changing anything",
    body: {
      messages: [
        {
          role: EvalCaseMessageRoleEnum.User,
          text: "What email address is on record rec_alpha?",
        },
      ],
      rubric: null,
      checks: {
        rules: [{ kind: EvalCaseRuleKindEnum.Contains, text: "ops@alpha.example" }],
        toolCalls: [{ toolName: "get_record", args: { recordId: "rec_alpha" } }],
        forbiddenTools: ["update_record", "create_record", "delete_record"],
        readbacks: [],
      },
    },
  },
];
