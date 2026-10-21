import { Moon, Sun } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import * as Schemas from "@app/schemas";
import Launcher from "@/components/Launcher";
import Panel from "@/components/Panel";
import ShadowHost from "@/shadow/ShadowHost";
import { useDevTheme } from "@/dev/useDevTheme";
import { toChangeCard } from "@/lib/changeRequestView";
import { EMPTY_REVIEW } from "@/store/widgetStore";

// DEV_NOTE: Development only (?gallery): the widget states from DESIGN.md §7 (M2-7, and the review cards of M3-5),
// drawn by the real components from sample data (the design canvas's), each in its own shadow root, to compare with
// docs/design/screenshots. The cards go through the same view builder the chat uses (toChangeCard).
const noop = () => undefined;
const actions: Schemas.WidgetPanelActions = {
  onSend: noop,
  onStop: noop,
  onRetry: noop,
  onNewChat: noop,
  onClose: noop,
  onRate: noop,
  onDraftChange: noop,
  onApprove: noop,
  onReject: noop,
  onEdit: noop,
  onCancelEdit: noop,
  onSaveEdits: noop,
  onEditValue: noop,
  onToggleRecord: noop,
  onShowMore: noop,
};

const value = (raw: string | null): Schemas.ChangeRequestValue =>
  raw === null ? { isFound: false } : { isFound: true, value: raw };

const EDITABLE_DATE: Schemas.ChangeRequestEditableField = {
  field: "completedOn",
  type: Schemas.ChangeRequestFieldTypeEnum.String,
  enumValues: null,
  format: "date",
  isRequired: false,
};
const EDITABLE_STATUS: Schemas.ChangeRequestEditableField = {
  field: "status",
  type: Schemas.ChangeRequestFieldTypeEnum.String,
  enumValues: ["Open", "Closed"],
  format: null,
  isRequired: false,
};

// DEV_NOTE: One sample change request: the record id that picks it, then its changed fields
function sample(
  publicId: string,
  recordId: string,
  changes: [field: string, before: string | null, after: string][],
  options: {
    status?: Schemas.ChangeRequestStatusIntEnum;
    editableFields?: Schemas.ChangeRequestEditableField[];
  } = {},
): Schemas.WidgetChangeRequest {
  const status = options.status ?? Schemas.ChangeRequestStatusIntEnum.Proposed;
  return {
    publicId,
    toolName: "update_inspection",
    toolCallId: null,
    kind: Schemas.ChangeRequestKindEnum.Update,
    changeRequestStatus: status,
    changeRequestStatusLabel: Schemas.CHANGE_REQUEST_STATUS_LABEL_MAP[status],
    summary: "update_inspection: fields changed",
    changes: [
      ...changes.map(([field, before, after]) => ({
        field,
        before: value(before),
        after: value(after),
        isChanged: true,
      })),
      { field: "inspectionId", before: value(recordId), after: value(recordId), isChanged: false },
    ],
    changeCount: changes.length,
    expiresAt: status === Schemas.ChangeRequestStatusIntEnum.Proposed ? Date.now() + 900_000 : null,
    isUndoable: true,
    wasEdited: false,
    editableFields: options.editableFields ?? [],
  };
}

const CLOSE_CHANGES: [string, string | null, string][] = [
  ["status", "Open", "Closed"],
  ["completedOn", null, "2026-09-22"],
];
const closeThree = (status?: Schemas.ChangeRequestStatusIntEnum) =>
  ["EXT-B-014", "EXT-B-017", "EXT-B-019"].map((recordId, index) =>
    sample(`cr${index}`, recordId, CLOSE_CHANGES, {
      status,
      editableFields: [EDITABLE_STATUS, EDITABLE_DATE],
    }),
  );

const reviewOf = (members: Schemas.WidgetChangeRequest[]): Schemas.WidgetChangeReviewState => ({
  ...EMPTY_REVIEW,
  changeRequests: Object.fromEntries(members.map((member) => [member.publicId, member])),
});

const card = (
  members: Schemas.WidgetChangeRequest[],
  review: Partial<Schemas.WidgetChangeReviewState> = {},
) =>
  toChangeCard(
    { messageId: "a1", cardId: "a1:update_inspection:update", members },
    { ...reviewOf(members), ...review },
  );

const BULK_RECORDS = Array.from({ length: 18 }, (_, index) =>
  sample(`bulk${index}`, `EXT-${"ACD"[index % 3]}-${String(index + 1).padStart(3, "0")}`, [
    ["dueOn", "2026-09-30", "2026-10-15"],
  ]),
);

const reply = (
  text: string,
  changeCards: Schemas.WidgetChangeCardView[],
): Schemas.WidgetAssistantMessageView => ({
  role: "assistant",
  id: "a1",
  text,
  steps: [
    {
      id: "s1",
      label: "Waiting for your approval",
      detail: null,
      state: Schemas.WidgetToolStepStateEnum.Done,
    },
  ],
  citations: [],
  isStreaming: false,
  canRate: false,
  rating: null,
  changeCards,
});

const CLOSE_ASK: Schemas.WidgetUserMessageView = {
  role: "user",
  id: "u1",
  text: "Close the three Building B inspections Priya finished on Tuesday.",
};
const CLOSE_REPLY =
  "I found 3 open inspections in Building B marked done on 22 Sep. Nothing is saved until you approve.";

const base: Schemas.WidgetPanelView = {
  chatbotName: "Registers Assistant",
  status: Schemas.WidgetStatusEnum.Online,
  welcome: null,
  messages: [],
  isUnavailable: false,
  isBusy: false,
  canStop: false,
  notice: null,
  draft: "",
};

const STATES: Schemas.WidgetGalleryState[] = [
  {
    name: "Welcome",
    view: {
      ...base,
      welcome: {
        greeting:
          "Hi Priya, what do you need?\nI can answer questions about your registers and update your records. I always show you a change before saving it.",
        suggestions: [
          "Which inspections are overdue?",
          "Close inspections finished this week",
          "How do I add a custom field?",
        ],
      },
    },
  },
  {
    name: "Streaming",
    view: {
      ...base,
      status: Schemas.WidgetStatusEnum.Working,
      isBusy: true,
      canStop: true,
      messages: [
        { role: "user", id: "u1", text: "Which Building B inspections are still open?" },
        {
          role: "assistant",
          id: "a1",
          text: "Building B has 3 open inspections, all due on 22 Sep. The first is EXT-B-014 on the level 2 east stair",
          steps: [
            {
              id: "s1",
              label: "Searched the help docs",
              detail: "3 results",
              state: Schemas.WidgetToolStepStateEnum.Done,
            },
            {
              id: "s2",
              label: "Searching the help docs",
              detail: null,
              state: Schemas.WidgetToolStepStateEnum.Running,
            },
          ],
          citations: [],
          isStreaming: true,
          canRate: false,
          rating: null,
          changeCards: [],
        },
      ],
    },
  },
  {
    name: "Answer with citations",
    view: {
      ...base,
      messages: [
        {
          role: "user",
          id: "u1",
          text: "How do I add a custom field to the Fire safety register?",
        },
        {
          role: "assistant",
          id: "a1",
          text: "You can add it from the register's settings. You need the Register admin role.\n\n1. Open the register, then **Settings → Fields**. [1]\n2. Choose **Add field**, pick a type such as Date or Dropdown, and name it. [1]\n3. Turn on **Required** if every record needs a value. Existing records stay valid until they're next edited. [2]",
          steps: [],
          citations: [
            {
              n: 1,
              documentPublicId: "d1",
              title: "Add and manage custom fields",
              sourceUrl: "https://help.example.com/custom-fields",
            },
            {
              n: 2,
              documentPublicId: "d2",
              title: "Required fields on existing records",
              sourceUrl: "https://help.example.com/required-fields",
            },
          ],
          isStreaming: false,
          canRate: true,
          rating: null,
          changeCards: [],
        },
      ],
    },
  },
  {
    name: "Approval",
    view: { ...base, messages: [CLOSE_ASK, reply(CLOSE_REPLY, [card(closeThree())])] },
  },
  {
    name: "Editing",
    view: {
      ...base,
      messages: [
        CLOSE_ASK,
        reply(CLOSE_REPLY, [
          card(closeThree(), {
            editing: { "a1:update_inspection:update": { cr1: { completedOn: "2026-09-23" } } },
          }),
        ]),
      ],
    },
  },
  {
    name: "Bulk review",
    view: {
      ...base,
      messages: [
        { role: "user", id: "u1", text: "Move every overdue Q3 inspection to 15 Oct." },
        reply("18 inspections are overdue from Q3. Untick any you want to keep as they are.", [
          card(BULK_RECORDS, { excluded: { bulk3: true } }),
        ]),
      ],
    },
  },
  {
    name: "Decided",
    view: {
      ...base,
      messages: [
        CLOSE_ASK,
        reply(CLOSE_REPLY, [
          card([
            ...closeThree(Schemas.ChangeRequestStatusIntEnum.Committed).slice(0, 2),
            sample("cr9", "EXT-B-019", CLOSE_CHANGES, {
              status: Schemas.ChangeRequestStatusIntEnum.Rejected,
            }),
          ]),
        ]),
      ],
    },
  },
  {
    name: "Temporarily unavailable",
    view: {
      ...base,
      status: Schemas.WidgetStatusEnum.Unavailable,
      isUnavailable: true,
      messages: [{ role: "user", id: "u1", text: "How many inspections are due next week?" }],
    },
  },
];

export default function StatesGallery() {
  const { theme, toggle } = useDevTheme();
  return (
    <div className="min-h-screen bg-muted p-8 text-foreground">
      <div className="mb-6 flex items-center gap-4">
        <h1 className="text-page-title">Widget states</h1>
        <Button variant="outline" size="sm" onClick={toggle}>
          {theme === Schemas.WidgetThemeEnum.Dark ? <Sun /> : <Moon />}
          {theme === Schemas.WidgetThemeEnum.Dark ? "Light" : "Dark"}
        </Button>
      </div>
      <div className="flex flex-wrap items-start gap-8">
        <figure className="flex flex-col gap-3">
          <figcaption className="text-caption text-muted-foreground">Closed</figcaption>
          <ShadowHost theme={theme}>
            <Launcher
              label="Ask about your registers"
              chatbotName={base.chatbotName}
              autoFocus={false}
              onOpen={noop}
            />
          </ShadowHost>
        </figure>
        {STATES.map((state) => (
          <figure key={state.name} className="flex flex-col gap-3" data-state={state.name}>
            <figcaption className="text-caption text-muted-foreground">{state.name}</figcaption>
            <ShadowHost theme={theme}>
              <Panel view={state.view} {...actions} />
            </ShadowHost>
          </figure>
        ))}
      </div>
    </div>
  );
}
