# Shadcn Documentation links

ShadCN is added as a skill in Claude Code. Use /Shadcn to invoke it.

Components live in `packages/ui` (`@app/ui`), style `radix-vega`, icons Phosphor. Add one with
`pnpm --filter @app/ui exec shadcn add <name>`. Components import `cn` from the `cn` package; apps
alias it to `packages/ui/src/lib/utils.ts` (see CLAUDE.md › UI).

- [Installation in TanStack start](https://ui.shadcn.com/docs/installation/tanstack)
- [Monorepo](https://ui.shadcn.com/docs/monorepo)
- [Theming](https://ui.shadcn.com/docs/theming)
- [CLI](https://ui.shadcn.com/docs/cli)
- [cn](https://github.com/shadcn-ui/cn) — class merging, `createCn` config for custom theme scales
