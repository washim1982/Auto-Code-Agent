# Design assets

## UI design

**[`ui-design.html`](ui-design.html)** — the interactive mockup. Open it in any browser; it is
self-contained with no external requests, and it follows your system light/dark preference.

**Hosted copy:** https://claude.ai/code/artifact/e43b4931-edc2-4832-b265-b63e36fa7f6b

The local file is the source of truth — the hosted version was published from it. If you edit the
HTML, re-publish rather than editing the hosted copy, or the two will drift.

### What it contains

| Section | |
|---|---|
| **Foundations** | The heat ramp, type scale, density rules, and the four rules both surfaces obey |
| **Desktop** | 8 views — Launcher, Chat, Run graph, Files, Models, Diff review, Timeline, Settings — at 1240 × 812 |
| **Interactive CLI** | 6 terminal states — chat, workspace picker, running, approval, node focus, headless |

The mockups are live HTML rather than images, so they re-theme with the page and the tokens in them
are the same values the implementation uses.

## Screens

Captured from the running Electron app against a live daemon, not mocked:

- [`screens/desktop-launcher.png`](screens/desktop-launcher.png) — workspace picker with index state
- [`screens/desktop-session.png`](screens/desktop-session.png) — session view, file tree, status strip

## Where the spec lives

[`../docs/06-ui-design.md`](../docs/06-ui-design.md) is the buildable specification: tokens,
dimensions, layout rules, keymap, accessibility. The mockup is the reference render of that spec.

The implementation restates the tokens in three places, because the three runtimes cannot share a
stylesheet:

| Surface | File |
|---|---|
| CLI (ANSI) | [`../packages/cli/src/theme.ts`](../packages/cli/src/theme.ts) |
| TUI (Ink) | [`../packages/cli/src/tui/components.tsx`](../packages/cli/src/tui/components.tsx) |
| Desktop (CSS) | [`../packages/desktop/src/renderer/theme.css`](../packages/desktop/src/renderer/theme.css) |

If you change a ramp colour, change all four — the spec and the three implementations.
