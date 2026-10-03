# Companion design handoff

Design handoff for Claude Code. Put this folder in the repo at `docs/design/`.

```text
docs/design/
  DESIGN.md            the spec: tokens, shell, components, page map, widget states, copy
  tokens/theme.css     shadcn theme (light + dark, lime), goes into packages/ui
  fonts/               Instrument Sans + JetBrains Mono (woff2, OFL)
  screenshots/light/   one PNG per page and widget state
  screenshots/dark/    same, dark theme
  pages/light/         standalone HTML reference per screen (open in a browser)
  pages/dark/
```

## Using it in Claude Code

Start each UI task with:

> Read CLAUDE.md, docs/design/DESIGN.md, and the screenshots for the screens this task touches
> (listed below). Build with shadcn components from packages/ui and Tailwind classes using the
> variables in docs/design/tokens/theme.css. Treat pages/\*.html as layout and copy references only;
> do not copy their inline styles. Then do task <ID>.

Which files go with which task:

| Task                                            | Read                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M0-4 (packages/ui)                              | DESIGN.md §2–3, tokens/theme.css, fonts/                                                  |
| M2-7 (widget UI)                                | DESIGN.md §7–8, screenshots `host-*`, `widget-*` (light + dark)                           |
| M3-5, M3-8 (approve, edit, bulk, token refresh) | `widget-Approval`, `widget-Editing`, `widget-Bulk`, `widget-Verified`, `widget-Mismatch*` |
| M4-1 (shell)                                    | DESIGN.md §4, `dashboard-Overview`, `dashboard-Overview-collapsed`                        |
| M4-3 … M4-10 (pages)                            | DESIGN.md §5–6 and the matching `dashboard-*` screenshot                                  |

The editable design canvas lives at https://claude.ai/artifact/KUVrZKQFi6TGdzRqt5TcDC.
When it changes, regenerate this bundle and commit it in the same PR as the UI change.
