# Companion design spec

Source of truth for the look of the dashboard (`apps/web`) and the chat widget (`apps/widget`).
Pair every UI task with the screenshot of the page it touches. The HTML files in `pages/` are
references for layout, spacing and copy only: build with shadcn components from `packages/ui`
and Tailwind classes, never by copying their inline styles.

Design canvas (editable): https://claude.ai/artifact/KUVrZKQFi6TGdzRqt5TcDC

## 1. Principles

- Minimal and calm: white space instead of boxes, 1px borders, no shadows except the floating widget.
- One accent: lime. It is a fill (buttons, toggles, bars, launcher) with near-black text on it.
  As text or a link, use `brand-text` (deep lime in light mode, bright lime in dark).
  The one exception is the chat widget on a host page: the host may pass its own brand colour (§7).
- Mono (`font-mono`) only for machine values: record IDs, tool names, model names, config versions, keys.
- Light and dark are equal citizens. Every screen ships in both.
- Plain words in the UI. Never show internal names (`turn_id`, `change_requests`, `needs_human`) to users.

## 2. Tokens

All colours are CSS variables in `tokens/theme.css` (shadcn names + Companion extras).
Use Tailwind classes that read them (`bg-primary`, `text-muted-foreground`, `bg-diff-new`).

| Role                                                     | Variable                               | Light             | Dark              |
| -------------------------------------------------------- | -------------------------------------- | ----------------- | ----------------- |
| Page background                                          | `--background`                         | #ffffff           | #0c0d0c           |
| Text                                                     | `--foreground`                         | #171717           | #ededed           |
| Strong secondary text, inactive nav, icon buttons        | `--subtle-foreground`                  | #4f4f4f           | #b6b6b6           |
| Muted text (captions, labels, timestamps, table headers) | `--muted-foreground`                   | #6e6e6e           | #909090           |
| Borders                                                  | `--border`                             | #ebebeb           | #272a27           |
| Neutral fill (hover, selected, chips)                    | `--accent` / `--muted`                 | #f3f3f3           | #1d201d           |
| Brand fill                                               | `--primary`                            | #a3e635           | #a3e635           |
| Text on brand fill                                       | `--primary-foreground`                 | #1a2e05           | #142305           |
| Brand as text / focus ring                               | `--brand-text` / `--ring`              | #4d7c0f           | #b8ef5c           |
| Brand-tinted surface                                     | `--brand-soft`                         | #f3fbe6           | #1a2410           |
| Success                                                  | `--success`                            | #4d7c0f           | #b8ef5c           |
| Warning                                                  | `--warning` / `--warning-soft`         | #995100 / #fff5e6 | #f2a541 / #2a1f0e |
| Error                                                    | `--destructive` / `--destructive-soft` | #bf2a1d / #fdedeb | #ff7b6f / #2e1714 |
| New value in a diff                                      | `--diff-new`                           | #e4f7c2           | #2b3b12           |
| Sidebar background                                       | `--sidebar`                            | #fafafa           | #111311           |

Which text grey:

- `foreground`: content and anything active or selected.
- `subtle-foreground`: supporting content you still read (descriptions, secondary cell values,
  quoted user text), inactive sidebar items, icon-only buttons, avatar initials.
- `muted-foreground`: metadata you scan past (captions, timestamps, column headers, placeholders).

All three pass WCAG AA on their backgrounds (`subtle-foreground` is about 8:1 light, 10:1 dark).

Type: Instrument Sans (UI), JetBrains Mono (machine values). Files in `fonts/`, or load from Google Fonts.

| Use                        | Size / weight     | Tracking |
| -------------------------- | ----------------- | -------- |
| Page title (h1)            | 26 / 600          | -0.025em |
| Metric value               | 28 / 600          | -0.03em  |
| Section title (h2)         | 15 / 600          | -0.01em  |
| Body, table cells, nav     | 13.5–14 / 400     | 0        |
| Secondary, captions, chips | 12–12.5 / 400–500 | 0        |
| Mono values                | 12 / 400          | -0.01em  |

Spacing and shape:

| Thing                     | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| Main content max width    | 1180px, padding 36px top, 32px sides                           |
| Gap between page sections | 36–40px                                                        |
| Card / box padding        | 20px × 22px                                                    |
| Table cell padding        | 13px × 16px, row divider only                                  |
| Radius                    | 8px controls, 10–12px boxes, 18px widget panel, full for chips |
| Control height            | 36px buttons and inputs, 32px sidebar items                    |
| Focus                     | 2px ring in `--ring`, 2px offset                               |

## 3. Icons

The scaffold uses `@phosphor-icons/react`. This table is authoritative: icons in the screenshots and
HTML pages are hand-drawn approximations, so when they disagree, use the Phosphor name below.

| Mockup                 | Phosphor         | Mockup                 | Phosphor                  |
| ---------------------- | ---------------- | ---------------------- | ------------------------- |
| Overview               | `SquaresFour`    | Approve / verified     | `Check`                   |
| Conversations / widget | `ChatCircle`     | Close / reject         | `X`                       |
| Changes                | `GitDiff`        | Undo                   | `ArrowCounterClockwise`   |
| Quality / flag         | `Flag`           | Send                   | `ArrowUp`                 |
| Tests                  | `Flask`          | Helpful / not helpful  | `ThumbsUp` / `ThumbsDown` |
| Knowledge              | `BookOpen`       | Needs a person / alert | `Warning`                 |
| Impact / undo window   | `Clock`          | Unavailable / stop     | `Pause`                   |
| Usage                  | `ChartBar`       | Edit                   | `PencilSimple`            |
| Security               | `ShieldCheck`    | Add                    | `Plus`                    |
| Settings               | `Gear`           | Search / tool step     | `MagnifyingGlass`         |
| Sidebar toggle         | `SidebarSimple`  | Remove                 | `Trash`                   |
| Switchers              | `CaretUpDown`    | Model key              | `Key`                     |
| Theme                  | `Moon` / `Sun`   | Row menu               | `DotsThree`               |
| Open in host           | `ArrowSquareOut` | Retry / rotate         | `ArrowsClockwise`         |
| Welcome                | `Sparkle`        | Source / doc           | `FileText`                |

## 4. Dashboard shell

Screenshots: `screenshots/*/dashboard-Overview.png` (expanded), `dashboard-Overview-collapsed.png`.

- shadcn `Sidebar` with `collapsible="icon"`: 16rem expanded, 3rem icon rail. Keyboard shortcut and
  mobile `Sheet` come from the component; keep them.
- `SidebarHeader`: the company, not a bot. Square lime tile + "Companion" + company name
  (e.g. eRegister). No dropdown: there is no bot switcher (see §6).
- `SidebarContent`, four `SidebarGroup`s with labels:
  - Monitor: Overview, Conversations, Changes, Quality
  - Improve: Tests, Knowledge
  - Insights: Impact, Usage
  - Admin: Security, Settings

  Inactive items use `text-subtle-foreground`; the active item uses `foreground` on `sidebar-accent`.

- Settings is a `Collapsible` with `SidebarMenuSub`: Bots, Model keys, Connections, Team, Budget.
  Open when a settings page is active.
- Counts on Changes (needs a person, destructive) and Quality (open issues, warning) use
  `SidebarMenuBadge`; in the icon rail they become a 6px dot.
- `SidebarFooter`: account menu (`DropdownMenu`) with avatar, name, email.
- Top bar (56px): `SidebarTrigger`, separator, `Breadcrumb` (Settings › Bots on settings pages),
  then right-aligned environment `Badge` ("Production", brand-soft) and a theme toggle button.
  Icon buttons (sidebar trigger, theme toggle) use `text-subtle-foreground`.
- Page header: h1 + one-line description, actions right-aligned.

## 5. Component inventory

Form controls in the mockups are native HTML stand-ins. Always use the shadcn equivalent:
`<select>` → `Select`, `<input type="checkbox">` → `Checkbox`, text inputs → `Input`, the toggle → `Switch`.

| Pattern in the mockups                       | shadcn                                        | Notes                                                                                        |
| -------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Primary action                               | `Button` default                              | Lime fill, `primary-foreground` text                                                         |
| Secondary action                             | `Button` outline                              |                                                                                              |
| Quiet action                                 | `Button` ghost                                | Reject, Dismiss, row menus; `text-subtle-foreground`                                         |
| Status chip with dot                         | `Badge`                                       | Variants: neutral, success, warning, destructive, brand. Dot = 6px circle in the text colour |
| Metric strip                                 | `Card` grid with dividers                     | 4 cells, label / value / delta                                                               |
| Data tables                                  | `Table`                                       | Header row muted 12.5px, row dividers only, selected row `surface-subtle`                    |
| Segmented filters                            | `ToggleGroup` (or `Tabs` list)                | Count in muted text after the label                                                          |
| Dropdown filters                             | `Select` or `DropdownMenu`                    | Label in muted text, value in foreground                                                     |
| Detail panel next to a list                  | `Card`                                        | Right column at ≥1100px, stacks below on narrow screens                                      |
| Banners (sync failed, safety blocks publish) | `Alert`                                       | Destructive-soft or brand-soft background, no border                                         |
| Budget bar                                   | `Progress`                                    | Lime fill, 1px ticks at 50% and 80%                                                          |
| Bar charts                                   | shadcn `Chart` (Recharts)                     | Recharts is a new package: ask before adding (scaffold rule)                                 |
| Toggle (read-only mode)                      | `Switch`                                      |                                                                                              |
| Avatar initials                              | `Avatar` + `AvatarFallback`                   | `text-subtle-foreground` on `accent`                                                         |
| Forms                                        | `Input`, `Label`, `Select` (scaffold `field`) |                                                                                              |
| Toasts                                       | `Sonner`                                      | Every mutation's `onError` (scaffold rule)                                                   |
| Timeline (change detail)                     | custom list                                   | 8px dots, 1px connector                                                                      |

## 6. Dashboard pages

Everything is company-level. Decided:

- Routes are flat, with no bot in the path: `/` redirects to `/overview`.
- No bot switcher and no bot filter in the UI for now. Pages show data for all of the company's bots.
- List and read endpoints take an optional `botId` query param (bot public id); absent = all bots.
  Example: `GET /api/conversations?botId=bot_x8f2`. Validate it with the route's Zod schema.
- Bots are listed and managed at Settings › Bots (create, versions, publish, read-only switch).
- The screenshots still show a bot switcher in the sidebar header and bot names in page
  descriptions. Follow this section, not the screenshots, for those two details.

| Page                   | Screenshot / page file    | Route (`apps/web/src/routes/_authenticated/…`) | Main data                                                             |
| ---------------------- | ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| Overview               | `dashboard-Overview`      | `overview/`                                    | activity_rollups, change_requests, quality_issues, chatbot_configs    |
| Conversations          | `dashboard-Conversations` | `conversations/`, `conversations/$id/`         | conversations, messages, tool_calls, model_calls by turn_id           |
| Changes                | `dashboard-Changes`       | `changes/`, `changes/$id/`                     | change_requests, activity_log                                         |
| Quality                | `dashboard-Quality`       | `quality/`                                     | quality_issues, feedback                                              |
| Tests                  | `dashboard-Tests`         | `tests/`                                       | eval_runs, eval_results, eval_cases                                   |
| Knowledge              | `dashboard-Knowledge`     | `knowledge/`                                   | knowledge_sources, knowledge_documents, doc_gap_clusters              |
| Impact                 | `dashboard-Impact`        | `impact/`                                      | roi_assumptions, activity_rollups                                     |
| Usage                  | `dashboard-Usage`         | `usage/`                                       | model_calls, activity_rollups                                         |
| Security               | `dashboard-Security`      | `security/`                                    | company_connections, company_encryption_keys, companies, activity_log |
| Settings › Bots        | `dashboard-Bots`          | `settings/bots/`                               | chatbots, chatbot_configs, companies.is_read_only                     |
| Settings › Model keys  | `dashboard-ModelKeys`     | `settings/model-keys/`                         | company_secrets                                                       |
| Settings › Connections | `dashboard-Connections`   | `settings/connections/`                        | company_connections, company_secrets                                  |
| Settings › Team        | `dashboard-Team`          | `settings/team/`                               | admins (Clerk invites)                                                |
| Settings › Budget      | `dashboard-Budget`        | `settings/budget/`                             | companies.spending_budget, model_calls                                |

Quality page, issue detail: "Issue type" is a `Select` with placeholder "Choose a type" and options
Knowledge gap, Missing tool, Tool bug, Model error, Prompt injection. It stays empty for user flags
until an admin triages them (`quality_issues.issue_type` is null until then).

List + detail pages (Conversations, Changes, Quality, Tests) put the list in a 2-column span and the
detail card in the third column; below ~1100px the detail stacks under the list.

Tests (M7-9, ADR 0007): the header has New case (outline) and **Run tests** (primary, `Play`), as in the page file;
a run's page has **Run again** (outline, `ArrowClockwise`) next to All runs. Both open a confirm `Dialog` that names
the version and what it costs: "Run the publish check for v13?" for a version in testing ("Each of the 46 cases runs 3
times (138 conversations) … If they pass, v13 is ready to publish. If not, it goes back to draft.", primary "Run
publish check"), else "Run the tests of v13?" (once per case, "Nothing about v13 changes."). The button reads
"Tests running" and is off while a run of that version is Queued or Running (the page refreshes every 10 s until it
ends), and off without a test sign-in: the strip's Runs on cell then says "No test sign-in yet: ask Diletta to set one
up" in negative text.

### Operator pages (M7-8)

Design canvas: https://claude.ai/artifact/ANtyzU7D69o14TvrGTmw4r (built from these tokens and the dashboard
screenshots; it isn't part of the canvas above, so it has no files in `pages/` or `screenshots/`).

- Same shell, own sidebar: header "Companion" + "Diletta operator", one group **Operator** with Companies
  (`Buildings`). No badges. Breadcrumb: Companies › <company>.
- **Companies** (`operator/companies/`): page header + New company (primary), status `ToggleGroup` (All, Active,
  Paused, Churned, with counts), table (Company, Status chip, Connections, Created, Open dashboard outline button),
  `Pager`. New company is a `Dialog` with a name only.
- **Company** (`operator/companies/$id/`): h1 + status chip, "Created … · <public id in mono>", Open dashboard
  (primary, `ArrowSquareOut`; off for a churned company), then a `ToggleGroup` of its sections in the URL.
  Connections (default): one bordered card per connection (environment chip, Edit outline button, label / value rows
  like Settings › Connections), Add connection (primary). The add / edit page is a form at 860px: on edit a "Set when
  created" box with the fixed settings read-only; Address and sign-in, Allowed origins (one per line), Clean-up after
  tests (staging only: switch + JSON call), Active switch (edit only), Cancel / Save at the foot. JSON and URLs in mono.
  A staging connection's card has a Test sign-in row ("eRegister as <uid in mono>", or "None. Admins can't run
  tests yet."), and its edit page a bordered Test sign-in box under the form (M7-9): the current one with Remove
  (outline), a Host select (eRegister / Test host) and its fields (password, API key and admin secret as password
  inputs, cleared after a save: they're never read back), and Save / Replace test sign-in.
  Tools: status `ToggleGroup` (Active default, Draft, Disabled, All, with counts), table (tool name in mono,
  version, status, risk chip — Read neutral, Write warning, Destructive destructive — approval, connection,
  updated), `Pager`, Load tool set (outline) and New tool (primary). Load tool set is a dialog: tool set and
  connection selects (active connections only), then what changed ("47 tools: 47 new") and the pins as read-only
  mono JSON with Copy pins. A version's page: name in mono as the title with its status chip and
  version, actions right (draft: Delete draft ghost destructive, Save draft, Make active; active: Disable, New
  version; disabled: Make active, New version), a destructive-soft banner with the first reason the API would
  refuse it, Details and Calls (mono JSON text areas on `surface-subtle`, read-only unless a draft), and a
  Versions panel on the right that stacks below on narrow screens.
  Maintenance: Rebuild insights (two date inputs, outline button "Rebuild N days", rules under it) and Company
  status (bordered rows, each move with its effect; Churn in destructive text, confirmed by typing the name).
- Status chips: Active success, Paused warning, Churned destructive.
- While acting in a company the top bar shows a warning chip "Acting as <company>" and a ghost **Back to
  operator** (`ArrowBendUpLeft`).

## 7. Chat widget

Anatomy (`widget-Welcome` … `widget-Unavailable`):

- Floating panel 380 × 680, radius 18, `shadow-float`, no border. Renders in Shadow DOM so host CSS
  can't leak in or out. Theme follows the host (light / dark prop).
- Host accent (optional, `accent` option): the host's brand colour replaces lime in the widget's
  brand fills (launcher, send, Approve, welcome icon, checkboxes), with the host's text colour on
  them, its brand-as-text colour for links and the focus ring, and a brand tint mixed from the fill.
  Diffs and success keep their green. Without it the widget is lime. The host passes the values for
  its current mode and updates them when the mode or the brand colour changes.
- Header: bot name (14/600), status dot + word (Online, Working, Unavailable), Your chats, Full
  screen (from `sm` up), New chat, Close (icon buttons in `text-subtle-foreground`).
- Full screen (the visitor's choice, remembered; from `sm` up only): the panel fills the window, no
  radius or shadow, as a modal dialog. One header with a line under it (Exit full screen, Close), Your
  chats as a 280px `bg-sidebar` column on the left, and the chat or the past chat in a centred 760px
  column beside it. Escape still closes the widget.
- Your chats and a past chat use a sub-header instead: Back, title (and its line under it), Close.
- Messages: user = right-aligned `bubble` pill; assistant = plain text, no bubble.
- Cards (approval, verified, mismatch): 1px border, radius 12; header with icon + title + one line;
  record rows with mono ID; footer actions.
- Diff line: field (muted) · old value struck through · arrow · new value on `diff-new`.
- Composer: rounded input with lime send button; AI notice under it (11.5px muted):
  "AI assistant. Changes to your data need your approval."
- Launcher (`host-Launcher`): 52px lime circle + optional label pill, bottom-right, 28px inset.

States:

| State                     | File                               | Shown when                   | Key UI                                                                                |
| ------------------------- | ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| Closed                    | `host-Launcher`                    | widget not open              | launcher only                                                                         |
| Welcome                   | `widget-Welcome`                   | new chat                     | greeting, 3 suggestion buttons                                                        |
| Streaming                 | `widget-Streaming`                 | turn running                 | tool steps (done ✓ / running spinner), text with caret, Stop                          |
| Answer with citations     | `host-Main`                        | answer used knowledge        | numbered markers, Sources list, thumbs                                                |
| Approval                  | `widget-Approval`                  | change request `proposed`    | diff per record, Approve N changes / Edit / Reject, expiry note                       |
| Editing                   | `widget-Editing`                   | user chose Edit              | inputs per field, remove record, Save edits / Cancel, "checked again" note            |
| Bulk review               | `widget-Bulk`                      | many records                 | table with checkboxes, "N of M", Approve N                                            |
| Verified                  | `widget-Verified`                  | `verified`                   | per-record ✓, Undo + "available until"                                                |
| Changes undone            | `widget-MismatchAutoUndone`        | `mismatch` → auto-undo done  | expected vs found, Try again, Open record                                             |
| Needs a person            | `widget-MismatchNeedsHuman`        | `needs_human`                | which records saved, which is flagged, Open record                                    |
| Temporarily unavailable   | `widget-Unavailable`               | model key / provider failure | status card, Try again, composer disabled                                             |
| Your chats                | `?gallery` › Your chats            | user opened Your chats       | New chat, rows grouped Today / Yesterday / Earlier, brand dot on open ones, Show more |
| Your chats: empty / error | `?gallery` › Your chats: …         | no chats yet / read failed   | "No past chats yet" + Back to chat; "Your chats didn't load" + Try again              |
| A chat that has ended     | `?gallery` › A chat that has ended | user picked an ended chat    | messages + sources read-only, no composer, Start a new chat                           |
| Full screen               | dev host page (`pnpm dev:widget`)  | visitor chose Full screen    | sidebar of chats, centred chat column, Exit full screen                               |

Silent token refresh has no UI by design.

## 8. Copy

- Sentence case everywhere. Short, plain sentences.
- Say "change", "approve", "undo", "needs a person", "temporarily unavailable".
- Tell users what did NOT happen when something fails ("Nothing changed", "Your data hasn't changed").
- Numbers: "Approve 3 changes", "Reschedule 17 of 18 records".

## 9. Not final

- All names, records, numbers and dates are sample data.
- Gemini model names are placeholders for whatever the customer's key uses.
- Approval expiry and undo times are illustrative until the platform defaults are set.
- Dashboard buttons are 36px tall; revisit if touch targets of 44px are required.
