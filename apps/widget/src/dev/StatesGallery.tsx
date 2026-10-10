import { Moon, Sun } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import * as Schemas from "@app/schemas";
import Launcher from "@/components/Launcher";
import Panel from "@/components/Panel";
import ShadowHost from "@/shadow/ShadowHost";
import { useDevTheme } from "@/dev/useDevTheme";

// DEV_NOTE: Development only (?gallery): the M2-7 widget states from DESIGN.md §7, drawn by the real components from
// sample data (the design canvas's), each in its own shadow root, to compare with docs/design/screenshots
const noop = () => undefined;
const actions: Schemas.WidgetPanelActions = {
  onSend: noop,
  onStop: noop,
  onRetry: noop,
  onNewChat: noop,
  onClose: noop,
  onRate: noop,
  onDraftChange: noop,
};

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
        },
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
