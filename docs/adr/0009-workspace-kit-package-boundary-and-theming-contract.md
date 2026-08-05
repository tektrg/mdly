# ADR: Workspace Kit — Package Boundary, Theming Contract, Extension Slot

## Status
Accepted — 2026-08-05 (Phase 0 of [[docs/architecture/shared-markdown-editor-kit-plan.md]]).
**Revised same day:** scope widened from editor-only to editor + navigation, and
package renamed `@mdly/workspace-kit` → `@mdly/workspace-kit`. See Decision 4.

## Context
mdly's inline Markdown editor (`packages/editor` + `packages/ui/src/editor/*`,
~3.6k LOC engine, ~9k LOC interaction chrome) **and its file-navigation surface**
(Sidebar, Toolbar, WorkspaceSwitcher, RecentFilesList) are being extracted into a
versioned package, **`@mdly/workspace-kit`**, published to npm from the mdly repo
and consumed by SpeechToDo as a pinned dependency. Two products, one editor +
navigation layer, no code merge.

This ADR freezes three things before any extraction code is written:
1. What ships in the package (scope).
2. The exact theming surface a host must supply (theming contract).
3. The exact mechanism a host uses to add its own node types (extension slot).

Both repos carry this same file so neither side can silently drift from what was agreed.

## Decision 1 — Scope: full chrome ships
The kit ships the complete editing experience — slash menu, format menu,
find/replace, table of contents, file-properties panel, autosave, virtual cursor —
not just the bare engine. This matches the Package boundary table in the plan.

**Accepted trade-off:** shipping this MIT on public npm hands any competitor the same
editing feel mdly is known for. Chosen anyway because engine-only would force
SpeechToDo to rebuild ~9k LOC of interaction UI mdly has already refined, and mdly
has decided to keep this open regardless of who consumes it.

**Correction to the original plan:** the plan claimed only two files depend on a
UI library beyond plain CSS/React (`@base-ui/react`'s `Select`, in the code-block
language picker and file-properties panel). Verified against the actual source —
that's incomplete. The kit's real external dependency surface is:

| Dependency | Where | Purpose |
|---|---|---|
| `@base-ui/react` (`Select`) | `CodeBlockExtension.tsx`, `FilePropertiesPanel.tsx` | dropdowns |
| `mermaid` | `MermaidBlockView.tsx` | diagram rendering (lazy-loaded) |
| `lowlight` + `highlight.js` language packs | `CodeBlockExtension.tsx` | code-block syntax highlighting |
| `cmdk` | `SlashCommandMenu.tsx`, `FormatCommandMenu.tsx` | command-palette primitive |
| `~icons/mingcute/*` (Iconify/unplugin-icons) | multiple menu/toolbar components | icon set |
| `keymatch` | keyboard shortcut matching | not UI, but a real external dep |

None of these require a Tailwind toolchain in the consuming app — the kit still
ships prebuilt JS + CSS — but SpeechToDo's build must bundle these five extra
dependencies, not just `@base-ui/react`.

## Decision 2 — Theming contract
The kit's CSS custom properties are the only theming surface. SpeechToDo overrides
values, never rules. No custom property in this list may be renamed or removed
without a major version bump; new ones may be added additively.

**Tokens must be set on the kit's own container, never at `:root`** (decided
2026-08-05). The two products' token vocabularies are independent and one name
collides *semantically inverted*:

| | mdly / kit (shadcn convention) | SpeechToDo (`--std-*` / `--c-*` system) |
|---|---|---|
| `--accent` | muted hover-surface background | `#CBB063` — the butter-gold **brand/action** color |
| `--border` | border color | `var(--c-shadow)` — coincidentally compatible |
| `--background`, `--foreground`, `--muted`, `--muted-foreground`, `--popover`, `--ring`, `--radius-md`, `--radius-sm`, `--primary-foreground`, `--destructive`, `--card`, `--input` | read by the kit | **not defined at all** |

If the kit's CSS is allowed to inherit from SpeechToDo's `:root`, it picks up gold
for every hover surface and falls back to unstyled defaults for the other twelve.
Therefore SpeechToDo must declare **all 56 properties explicitly on the element
wrapping the kit** — a scoped `--std-*` → kit-name translation layer. This is a
Phase 3 exit requirement, and it is also what keeps the two design languages from
leaking into each other in either direction.

**Source of truth today is split across two files, not one** — this list is the
union, hand-assembled because no single canonical file currently defines it:
- `packages/ui/src/theme.css` defines the semantic design tokens.
- Editor-local tokens (`--editor-*`, `--pm-task-check-mask`, `--toc-level`,
  `--link-popover-preview-inline-size-end`) are defined inline in the editor CSS
  files themselves and are **not** in `theme.css`.

**Gap found (must close before Phase 2):** `--radius-sm` / `--radius-md` are read
by `EditorView.css` but only defined in `packages/runtime/html-app-theme.css` /
`apps/desktop/src/index.css` — not in `theme.css`. `--shadow-lg` is read but not
defined anywhere in this repo; it's currently supplied implicitly by Tailwind v4's
default theme. **The kit must define a fallback value for both, or the property
list is incomplete for a host with no Tailwind present** — SpeechToDo's renderer
has no Tailwind toolchain by design (see plan). This is a Phase 2 exit blocker.

Full property list (56 total):

**Color — semantic surface/foreground**
`--background`, `--foreground`, `--muted`, `--muted-foreground`, `--popover`,
`--popover-foreground`, `--accent`, `--selected`, `--primary-foreground`,
`--destructive`, `--brand`, `--brand-accent`

**Color — syntax highlighting**
`--syntax-foreground`, `--syntax-muted`, `--syntax-comment`, `--syntax-keyword`,
`--syntax-variable`, `--syntax-string`, `--syntax-link`, `--syntax-number`,
`--syntax-meta`, `--syntax-type`, `--syntax-attr`, `--syntax-selector`

**Borders / focus ring**
`--border`, `--ring`

**Radius**
`--radius-md`, `--radius-sm`, `--radius-inner`, `--radius-popover`

**Shadow**
`--shadow-lg`, `--shadow-overlay`

**Typography**
`--editor-font-family`, `--font-mono`, `--font-size-content`

**Spacing / layout (editor-local)**
`--editor-content-max-inline-size`, `--editor-content-padding-inline`,
`--editor-floating-chip-clearance`, `--editor-gap`, `--editor-heading-gap`,
`--editor-list-gap`, `--editor-section-gap`,
`--link-popover-preview-inline-size-end`, `--toc-level`

**Motion**
`--default-transition-duration`, `--ease-snappy`, `--cursor-motion-duration`,
`--cursor-motion-easing`

**Icon mask**
`--pm-task-check-mask` (data-URI SVG for the task-checkbox check icon — a host
overriding this changes the checkbox glyph, not just its color)

## Decision 3 — Extension slot
mdly's editor is built on **Tiptap 3.x** (wraps ProseMirror directly). The kit
already exposes the mechanism SpeechToDo needs — no new API required:

- `EditorView` (`packages/ui/src/editor/EditorView.tsx`) takes an
  `extensions?: EditorOptions["extensions"]` prop (default `[]`), spread into the
  internal Tiptap extensions array. A host passes its own Tiptap `Node` /
  `Extension` objects through this prop.
- `onEditorReady?: (editor: Editor | null) => void` gives imperative post-mount
  access to the Tiptap `Editor` instance for anything the declarative prop can't
  express (e.g. triggering playback from outside the editor).

**Contract:** the kit guarantees `extensions` and `onEditorReady` stay stable,
public props of `EditorView` across minor versions. SpeechToDo's Phase 5 audio
node (`audioSegment` or similar) is added purely through this prop — no fork of
`packages/ui/src/editor` is needed or permitted (see Phase 6 steady-state rule).

**Reserved names — do not collide:** the kit internally defines these node/mark
names. A host extension must pick a name outside this set, and outside standard
Tiptap StarterKit names (`paragraph`, `heading`, `text`, `bulletList`,
`orderedList`, `listItem`, `codeBlock`, `blockquote`, `horizontalRule`,
`hardBreak`, `bold`, `italic`, `code`, `link`, etc.):

`HeadingExtension`, `ListAutoJoinExtension`, `ListToggleExtension`,
`fakeSelection`, `findReplace`, `link`, `linkClick`, `linkCreationGhost`,
`markdownRollover`, `mermaidBlock`, `notionCallout`, `notionEmptyBlock`,
`notionHtmlBlock`, `smartLinkToggle`, `storedMarksDecoration`,
`strikethroughShortcut`, `table`, `tableCell`, `tableHeader`, `tableRow`

Example shape of an existing custom node, for reference
(`packages/editor/src/MermaidBlock.ts`):

```ts
export const MermaidBlockExtension = Node.create({
  name: "mermaidBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() { return { raw: { default: "", parseHTML: ..., renderHTML: ... } }; },
  parseHTML() { return [{ tag: "div[data-mermaid-block]" }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(...)]; },
});
```
A React view (needed for SpeechToDo's segment-click-to-play UI) attaches the same
way mdly attaches its own: `MermaidBlockExtension.extend({ addNodeView: () =>
ReactNodeViewRenderer(...) })` — no engine change required.

## Decision 4 — Scope widened to navigation (2026-08-05 revision)
User decision: the kit also carries mdly's file-navigation surface — Sidebar
(file tree, workspace/exploration nav), Toolbar (nav bar), WorkspaceSwitcher,
RecentFilesList, and their supporting hooks (`useSidebarKeyboardNav`,
`useSidebarSwipeNav`, `useVirtualSidebarRows`, `useSidebarTree`,
`buildRecentFilesList`). `AppShellFrame` (outer window layout) stays mdly-only —
it has zero real dependencies, so there is nothing to gain by sharing it.
Content-integration glue (HTML app embeds, image paste, Notion sync, Convex
cloud sync) also stays mdly-only, as originally scoped.

**Git/symlink status indicators are explicitly deferred.** mdly's sidebar shows
live git file-state per row; SpeechToDo's storage model (local-first + optional
Google Drive/iCloud/R2) has no git equivalent. The moved Sidebar ships without
these indicators for now — not abstracted, just removed — revisit later
(tracked as an unresolved question in the plan).

### New dependency surface from navigation
| Dependency | Where | Purpose |
|---|---|---|
| `@base-ui/react` (`Menu`, additional `Select` use) | `Sidebar.tsx`, `WorkspaceSwitcherMenu.tsx` | menus |
| `@dnd-kit/core` | `Sidebar.tsx` | drag-to-reorder in the file tree |
| `keymatch` (already listed in Decision 1) | `Toolbar.tsx` | platform-aware shortcut display |
| `~icons/mingcute/*` (already listed) | `Sidebar.tsx`, `Toolbar.tsx`, `WorkspaceSwitcherMenu.tsx` | icon set |

### The Tailwind gap (new finding, corrects an implicit assumption)
Decision 1 verified the editor surface ships prebuilt, custom-property-driven
CSS — true. It does **not** hold for navigation: Sidebar/Toolbar/WorkspaceSwitcher
have **no CSS files of their own** and are styled entirely with Tailwind utility
classes. Today, only `apps/desktop`'s own Tailwind build compiles those classes
(scanning the package's source at the *consumer's* build time via a `@source`
directive in `packages/ui/src/tailwind.css`) — `packages/ui`'s own build has no
Tailwind plugin wired in, so its prebuilt `dist/style.css` does not actually
contain compiled navigation styles today.

**Requirement:** the kit's own build must compile its own Tailwind usage into a
static stylesheet at *kit* build time (wire a Tailwind compiler into the kit's
own vite config, scanning only the kit's own source) — otherwise SpeechToDo would
need to run a live Tailwind build over the kit's source just to render
Sidebar/Toolbar correctly, breaking the "no Tailwind toolchain in SpeechToDo"
guarantee. Scoped into Phase 2, alongside the existing `--radius-sm`/`--radius-md`/
`--shadow-lg` fallback-value gap from Decision 2.

### Rejected alternative: SpeechToDo adopts Tailwind (asked and settled 2026-08-05)
The obvious-looking alternative — have SpeechToDo adopt Tailwind so the kit's
utility classes "just work" — is rejected. It does not actually solve the problem:

- Tailwind classes are inert without the **config that generated them** (mdly's
  color/spacing scales and v4 theme defaults). SpeechToDo's Tailwind would have to
  scan the kit's source inside `node_modules` *and* replicate mdly's theme config,
  then stay in sync with it permanently. That is **tighter** coupling than the
  shared package exists to create, and a silent-breakage class on every mdly
  config change. Kit-side self-compilation is strictly looser coupling — and the
  kit needs it regardless to be publishable to any consumer.
- Cost on SpeechToDo's own merits is high: the renderer has **no CSS build step at
  all** today (esbuild bundles JS; CSS is copied verbatim), so this means the first
  CSS pipeline. The real migration cost is **~695 inline `style={{…}}` sites**
  across 55 components / ~23k LOC — not the ~2k lines of CSS. A partial migration
  leaves two competing styling systems, which the style guide forbids.
- [[docs/product/ui-style-guide.md]] lists *"Tailwind migration as a side effect of
  one component"* under **Avoid for now**, while permitting an *intentional*
  Tailwind/shadcn setup later. Adopting here would be precisely the former.
- mdly is Tailwind **v4**; `src/apps/marketing` is Tailwind **v3** — adopting for
  the kit's sake puts two Tailwind majors in one repo.

Tailwind for the SpeechToDo renderer remains a legitimate future choice, but it
must be its own decision justified by the renderer's own needs — not a
consequence of this integration.

### Primitives closure resolved
`Button`, `Input`, `Modal`, `Separator`, `lib/utils` (`cn`), `lib/filePath`, and
`lib/scrollOverflow` are used by **both** the editor surface and navigation.
Because both now move into the same package, these primitives move with them —
no duplication, no 3rd shared package, and the kit never depends on mdly's
remaining UI package. `@hubble.md/ui` (mdly-only) keeps a thin re-export shim for
`Button`/`Modal` so `apps/desktop`'s Notion/HTML-app/settings screens — which
aren't moving — don't need import-path changes in Phase 1.

## Consequences
- SpeechToDo's build must vendor the five extra editor-surface dependencies
  listed in Decision 1, plus `@dnd-kit/core` from Decision 4, not just `@base-ui/react`.
- Phase 2 ("token-driven theming") is not done until `--radius-sm`, `--radius-md`,
  and `--shadow-lg` have kit-owned fallback values, **and** the kit self-compiles
  its own Tailwind usage into static CSS — SpeechToDo has no Tailwind to fall
  back on for either gap.
- Phase 5's audio extension is scoped to the existing `extensions` /
  `onEditorReady` props; if either turns out insufficient, that's a kit API gap to
  raise in Phase 5, not a reason to fork.
- Renaming or removing any property in the Decision 2 list, or breaking the
  `extensions`/`onEditorReady` props, is a breaking change to `@mdly/workspace-kit`
  and requires a major version bump on both sides.
- `@hubble.md/ui` shrinks to `AppShellFrame` + a re-export shim after Phase 1 —
  whether it's worth keeping as its own package is an open question for later
  (tracked in the plan's unresolved questions), not decided now.
