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
Therefore SpeechToDo must declare **all 68 properties explicitly on the element
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

Full property list (72 total):

**Color — semantic surface/foreground**
`--background`, `--foreground`, `--muted`, `--muted-foreground`, `--popover`,
`--popover-foreground`, `--card`, `--input`, `--primary`, `--secondary`,
`--accent`, `--selected`, `--primary-foreground`, `--destructive`, `--brand`,
`--brand-accent`, `--destructive-surface`, `--destructive-surface-foreground`
(added Phase 2 — the sidebar's rename-conflict-error tooltip, previously a
hardcoded `oklch()` literal; deliberately not reusing `--destructive-foreground`,
which is a different value and a different semantic role — shadcn button text).
`--diff-added`, `--diff-added-foreground`, `--diff-removed`,
`--diff-removed-foreground` (added Slice 3 —
`packages/workspace-kit/src/history/DiffReviewPanel.tsx` and
`RevisionTimeline.tsx`'s per-region diff highlighting; no existing semantic
color already meant "incoming (disk) text" vs. "pre-edit text" specifically).
`--card` and `--input` were already named as kit-read properties in Decision 2's
collision table above; `--primary` and `--secondary` are genuinely read via the
kit's own Tailwind `@theme` mapping (`bg-primary`/`bg-secondary`, used in
`Button`, `Toolbar`, `Sidebar`, `LinkPopover`) — all four were previously missing
from this enumeration despite being live, host-overridable properties
(validate-pass finding, closed same day as R30/R31 below). Several other
mapped-but-currently-unread properties (`--card-foreground`, `--secondary-foreground`,
`--accent-foreground`, `--brand-accent-foreground`, `--selected-foreground`,
`--chrome-inset-shadow`/`--panel-shadow`) are deliberately NOT listed here: they
exist in the kit's Tailwind theme mapping for future use but no shipped kit
component actually reads them today, so they are not yet part of the live
contract — add them here only once a real component starts using them.

**Color — syntax highlighting**
`--syntax-foreground`, `--syntax-muted`, `--syntax-comment`, `--syntax-keyword`,
`--syntax-variable`, `--syntax-string`, `--syntax-link`, `--syntax-number`,
`--syntax-meta`, `--syntax-type`, `--syntax-attr`, `--syntax-selector`

**Borders / focus ring**
`--border`, `--ring`

**Radius**
`--radius-md`, `--radius-sm`, `--radius-inner`, `--radius-popover`

**Shadow**
`--shadow-lg`, `--shadow-overlay`, `--shadow-chip` (added Phase 2 — the
formatting status bar's floating word-count chip, previously a hardcoded
arbitrary Tailwind shadow literal), `--shadow-chrome-bar`, `--shadow-chrome-sidebar`,
`--shadow-chrome-section`, `--shadow-chrome-section-reverse` (the app-shell
"chrome" shadow family — title bar, sidebar edge, section dividers — read by
`Toolbar`/`Sidebar`; previously missing from this enumeration despite being
live and host-overridable, closed same day as the four Color additions above)

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

**Sidebar-only**
`--sidebar`, `--sidebar-foreground`, `--sidebar-border`, `--sidebar-accent`,
`--sidebar-accent-foreground` (added Phase 2, R30 — the sidebar's own
color family: container background, active/hovered-row highlight, and the
drag-preview chip; previously compiled to nothing in the kit's shipped CSS).
`--radius-row`, `--font-size-sidebar`, `--row-pad-block` (added Phase 2, R31 —
row corner radius, row label size, row padding; the same class of Tailwind-
default-fallback gap as `--radius-sm`/`--radius-md`/`--shadow-lg` above, but
sidebar-only and not named in the ADR's original list)

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

## Decision 5 — Tags become a kit navigation view; the pager is N-page (2026-08-08 revision)
User decision: rather than each product building its own tag rail, the kit
carries a **Tags view** as a peer of the two nav pages it already had (file tree,
recent files), and both products consume it.

**Pager generalized.** The sidebar's page switcher was hardcoded to exactly two
pages (`SIDEBAR_PAGE_COUNT = 2`, a `0 | 1` state, a 200%-wide track, and a
two-item dot row). It is now driven by a single ordered page list in
`nav/Sidebar.tsx`, with the pane width, translate step, focus target and
indicator all derived from it. The pager itself moved out to
`nav/SidebarPager.tsx`. `useSidebarSwipeNav` was already page-count-generic and
is unchanged. (Decision 6 revised the shape of that list again once a *second*
optional page existed.)

**Indicator is now icons, not dots.** The pager renders one small icon per page
(folder / history / tag) instead of the previous dots. This is a deliberate
visual change in **both** products, not a per-host option — one switcher, one
implementation.

**Tags are opt-in via capability detection**, matching the kit's existing
convention that an optional handler enables a feature: the Tags page appears only
when the host passes `onSelectTag`. Hosts that don't (e.g. `apps/www`) keep two
pages and gain no dead tab.

### Where the tag line sits — what the kit does and does not own
The kit owns the **presentation and aggregation**: the row list, counts, keyboard
nav, virtualization, empty state, active-row highlight, and `buildTagCounts`,
which tallies the `tags` already attached to each `SidebarFile`.

The kit deliberately does **not** own tag *semantics*, because the two products
disagree on every part of it:

| Concern | Why it stays host-side |
|---|---|
| **Where tags come from** | SpeechToDo's tags are canonical on its item registry (`.speechtodo/items/*.json`); its markdown front matter is a one-way projection and explicitly not authoritative. mdly's only source *is* front matter. The kit never parses a file for tags — hosts populate `SidebarFile.tags`. |
| **Colour** | SpeechToDo hashes name → hue with namespace-based shading across ~30 `--tag-*` properties that are not in the Decision 2 contract. Supplied via the `renderTagIcon` render-prop. |
| **Normalization** | SpeechToDo applies Obsidian-style rules (lowercase, kebab, `/` = hierarchy). mdly tags are arbitrary strings with spaces and capitals. Applying either product's rules to the other's data would silently corrupt it, so `buildTagCounts` treats names verbatim. |
| **Label form** | SpeechToDo's `#` prefix is a display convention, supplied via `formatTagLabel`. |
| **What selection does** | SpeechToDo additionally routes its main view to Inbox and clears its status filter. Pure host routing; the kit only reports `onSelectTag(name)`. |

**Selecting a tag filters the file-showing pages inside the kit**, while counts
continue to be computed from the *full* file list. This split is load-bearing: if
a host filtered the array it passed in, every other tag would vanish from the
list and there would be no way to switch between tags.

**New prop: `onPageChange(pageId)`.** Page state lives inside the kit, so this is
the only way a host can lazily load data a page needs. mdly uses it to defer its
front-matter tag scan until the Tags page is actually opened — its workspace
discovery deliberately never opens files (ADR-0008), so an eager scan would
regress exactly the large-repo responsiveness that ADR protects.

### Distribution: drift is now detectable
The kit is unpublished and SpeechToDo consumes a hand-copied tarball, so the two
repos could silently disagree about what "the kit" is. SpeechToDo now ships
`apps/desktop/scripts/sync-workspace-kit.mjs` (`npm run kit:sync` /
`npm run kit:check`): it builds and packs the kit from the mdly checkout, copies
it into `vendor/`, repoints the pinned dependency, and — in `--check` mode —
fails when the vendored build output no longer matches the mdly source. It
compares extracted build output rather than tarball hashes, because `npm pack`
embeds timestamps and is not byte-stable across runs.

## Decision 6 — Search becomes a kit navigation view; ranking is kit-owned (2026-08-08)
User decision: SpeechToDo's always-visible sidebar search box becomes a **fourth
kit page** (Files / Recents / Tags / Search), and both products get it. The
bespoke box, its CSS and its DOM-id coupling to the ⌘K handler are deleted.

**One page list, not three parallel arrays.** Decision 5 left page identity,
focus refs and page bodies in three arrays that had to line up by position, with
"which pages exist" expressed as `slice(0, -1)` — all of them except the last.
That works for exactly one optional page. With two (Tags, Search) it breaks, and
it breaks silently: the right tab strip pointing at the wrong content. They are
now **one array of page objects** (`id / label / icon / navRef / content`), built
where the bodies are.

That refactor also fixed a latent bug: `switchPage` reported the page id by
indexing the *full* table of possible pages rather than the *enabled* list. Live
the moment a host enables Search without Tags — clicking Search would report
`"tags"`, and mdly keys its lazy front-matter scan off exactly that string.

**Search is opt-in via `onSearchChange`**, matching the Tags convention.
`apps/www` passes neither and keeps two pages.

**The query is host-owned** (`searchQuery` + `onSearchChange`), unlike page state.
In every host that wants this page the same string already drives something else
on screen — SpeechToDo filters its centre Inbox list with it — and two copies of
one query is a desync waiting to happen.

**Ranking moved into the kit, and mdly's command palette now imports it back.**
mdly already had a proven scorer behind ⌘P (`apps/desktop/src/lib/fileSearch.ts`:
tiered exact / prefix / substring / scattered-letter matching over
separator-stripped text). Rather than write a second one, the heuristics live in
`nav/searchScore.ts` and `fileSearch.ts` imports them — one implementation, so
the palette and the sidebar can never start feeling different. Its existing test
suite passes unchanged, which is the proof the palette's ranking did not move.

One of the original four tiers (`startsWithPathWord`) was **unreachable** and is
not ported: every caller normalizes the haystack first, and normalization strips
`/`, so the tier could only repeat the prefix check above it. Verified by brute
force over ~6M normalized haystack/needle pairs — it decided the score zero
times. `searchScore.test.ts` pins the behaviour so the omission stays deliberate.

Reaching the scorer needs a UI-free entry point, `@mdly/workspace-kit/search`
(same rationale as the existing `/engine` split): mdly imports it from a plain
unit test, and the main barrel would drag Tiptap, mermaid and the kit's Tailwind
CSS in behind it. Every bundled entry must also be listed in the sync script's
compared-files set, or drift in that entry goes unnoticed.

### What the kit does and does not own for search
The kit owns the query box, the ranking, the rows, keyboard nav and
virtualization. It owns no search *semantics*: what a match means to the rest of
the app is the host's, and so are the placeholder text (the kit is English-only,
SpeechToDo ships EN/VI), the empty-state copy, the trailing hint slot, and the
keyboard shortcut.

**Scored fields, strongest first:** visible label → label without extension →
full display path → absolute path on disk. Scoring `getDisplayPath(path)` rather
than only the path is what makes each host's *visible* names searchable — in
mdly the workspace-relative path, in SpeechToDo the recording's registry title.
`SidebarFile` still carries no title field; the kit never learns what a title is.

**Query scope, decided deliberately:** a query narrows only the Search page.
Results are drawn from the tag-narrowed list so a tag and a query compose, but
Files and Recents keep showing everything — they have no query box on them, so a
shortened list there reads as a bug rather than a filter. This is the one place
search and tags behave differently, and it is intentional.

**Known asymmetry, accepted by the user:** SpeechToDo's centre Inbox list keeps
its own matcher (literal substring over filename and relative path). So the
Search page and the Inbox can disagree about the same query — the page is
title-aware and separator-insensitive, the Inbox is neither. Routing the Inbox
filter through `buildSearchResults` is the fix if that ever grates.

**New prop: an imperative `SidebarHandle.showPage(pageId)`.** Page state
deliberately lives in the kit, so a host cannot set it. Rejected: a controlled
`activePage` prop (forces every host to re-implement reset-on-workspace-change
and fights tab clicks and swipes) and the kit binding ⌘K itself (mdly already
uses ⌘K for its palette; a package installing global shortcuts is invisible and
hard to opt out of). The handle focuses the target page for free, and for Search
that target is the query box.

**One narrow relaxation of the keyboard guard.** `useSidebarKeyboardNav` ignores
every keystroke from an editable target — load-bearing, because the tree's inline
rename box sits inside the same handler. The Search page's box *is* its list's
focus target, so it opts exactly three keys back in (`editableKeys`:
ArrowDown/ArrowUp/Enter). Space and the horizontal arrows must never be listed:
inside an input they belong to the caret. A regression test asserts the rename
box still keeps Space.

## Decision 8 — A row may stand for several files: `stackCount` (2026-08-17)

SpeechToDo groups a plain document with the files generated from it
(`notes.md` + `notes.summary.md`), shows them as tabs, and hides the generated
ones from the tree. The remaining row then silently under-reports what it
opens, and the kit had no per-file-row affordance of any kind — no badge, no
trailing slot, no subtitle. Decision 7's rule applies verbatim, so this is a
kit prop:

```ts
SidebarFile.stackCount?: number   // ADDITIONAL files this row stands for
```

Above 0, the kit draws a small "stacked pages" glyph in the row's actions
corner — present at rest, yielding to the real hover actions the moment they
appear. Tried two chrome-only treatments first (a hairline rule below the row,
then soft-shadow slivers off its right edge) and dropped both: at sidebar-row
scale a decoration that isn't a recognizable glyph reads as a rendering
artifact, not a signal. A glyph is the count — the same icon whether the row
stands for two files or twenty; `stackCount`'s only job is presence, not a
number to display.

**Semantic-free on purpose, exactly as `tags` is.** The kit never decides what
makes files belong together; a host may group by frontmatter, a naming
convention, a registry or a database. The kit owns only how a grouped row
looks. This is why the field is a plain count and not, say, `derivedFiles`.

**Why a count rather than a render-prop.** A host-rendered node cannot express
this: the stacking is a treatment of the row element itself, and Decision 2
forbids host CSS reaching into kit markup. `renderTagIcon`'s render-prop shape
is right for *content* a host supplies, wrong for *chrome* the kit draws.

Additive, default-absent ⇒ **minor bump (0.4.0 → 0.5.0)**. mdly passes no
`stackCount` and is unchanged, with a guard test asserting a row without it
renders no stack icon.

### Agreed but NOT built: per-row metadata (`renderFileAccessory`)
Both products want frontmatter/file properties shown under a row's name. The
seam is agreed here so it is not re-litigated: a `renderFileAccessory?: (file:
SidebarFile) => ReactNode` render-prop, rendered under the label and allowed to
wrap — the `renderTagIcon` shape, correct this time because the accessory is
host-supplied *content*.

It is unbuilt because of a **host-side** cost, not a kit one: SpeechToDo's
workspace scan is `stat()`-only and never opens files, so listing frontmatter
means a new read pass over every `.md`. Whoever builds it should reuse the
kit's existing `parseMarkdownFrontMatter` / `FileProperty` (already exported,
currently unused by SpeechToDo, which instead carries four partial
re-implementations of the same regex) and follow mdly's precedent of deferring
the scan until the view that needs it is opened.

## Decision 9 — `stackCount`'s row treatment moves from idle glyph to hover-only animation (2026-08-23)

Decision 8's glyph is always visible at rest and fades away on hover so the row's
real actions can use that corner. SpeechToDo's product call: a grouped row should
look identical to any other row at rest — no icon, no idle hint at all — and only
reveal that it stands for more than one file on hover, as two thin card-edge
slivers fanning out below the row (a "peeking card stack" look), with a subtle
180ms transition. This is a deliberate reversal of Decision 8's own premise, not
an oversight: Decision 8 explicitly rejected always-visible chrome-only
treatments (a hairline rule; soft-shadow slivers) as unrecognizable at rest and
landed on a literal icon *because of* that idle-visibility requirement. Moving
the same shape of visual (a shadow/edge treatment) behind a hover reveal makes it
legible again — motion draws the eye where a static sliver at this scale could
not — while trading away at-rest discoverability. That trade-off is the point:
a clean idle sidebar mattered more than always-on scannability of grouping.

`stackCount`'s contract is unchanged — still a plain presence count, semantic-free,
kit-owned rendering (Decision 8's framing holds). Only the kit's internal
treatment of an already-shipped prop changed, so this is a **patch, not minor,
bump (0.5.0 → 0.5.1)** — contrast with Decisions 7/8, which bumped minor because
they added a new prop to the public contract; nothing here does.

Renders as two `<span>` layers (`data-sidebar-stack-effect`, renamed from
Decision 8's `data-sidebar-stack-icon` — it's no longer an icon), retracted and
transparent at rest, translating out below the row's own bottom edge on
`group-hover/sidebar-row`. Fixed at exactly 2 layers regardless of the real
count, same "presence not a number" principle as the glyph it replaces. The row
itself gains `hover:z-10` so the peeking layers paint above the next row instead
of underneath it — rows sit with zero gap in the list, so without this the
lower layer would be invisible, hidden by the next row's own background.

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
- Adding a sidebar view means **one entry** in the `pages` array in
  `nav/Sidebar.tsx`, carrying its id, label, icon, focus ref and body together.
  Page count, swipe range, focus order and the icon tab strip all follow. No
  other constant encodes "how many pages there are," and nothing has to stay
  positionally aligned with anything else.
- An optional page no longer has to be the *last* one, and there can be more than
  one. Report the page id from the enabled list, never from a table of every page
  that could exist — hosts key lazy loading off that string.
- Every entry point the kit bundles (`index`, `engine`, `search`) must be listed
  in `sync-workspace-kit.mjs`'s compared-files set. A file absent from both sides
  compares equal, so an omission makes the drift check quietly stop covering it.
- The ranking heuristics have exactly one home (`nav/searchScore.ts`). mdly's
  command palette imports them; its unchanged test suite is the guard that the
  palette's behaviour tracks the kit's.
- `SidebarFile.tags` is optional and `readonly`. The `readonly` matters:
  SpeechToDo hands back a shared frozen empty array for untagged items and its
  row memoization depends on that reference staying stable, so the kit must not
  copy or default it.
- A host that wants tags must populate `SidebarFile.tags` itself. mdly pays a
  bounded, on-demand front-matter scan for this; SpeechToDo reads it straight off
  its item registry at no extra cost.
- Re-vendoring the kit into SpeechToDo is now `npm run kit:sync`, and
  `npm run kit:check` fails on drift. Bumping the kit version changes the
  vendored filename, so the pinned path in `apps/desktop/package.json` is
  rewritten by the script rather than by hand.
