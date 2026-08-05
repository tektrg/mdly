// Sample markdown seeded into the demo's populated file. Deliberately exercises
// more than plain background/text colors (charter R29 / test-plan QA5-b): a
// code block (syntax-highlight tokens), a GFM task list (the checkbox icon
// mask + checked/unchecked colors), a link (the syntax-link / link-mark
// color), and a mermaid diagram (the shared fullscreen Modal, QA7 -- the only
// place that component is reachable at all, since no app imports it directly).
export const GETTING_STARTED_MARKDOWN = `# Getting started with @mdly/workspace-kit

This page is rendered entirely by the kit's already-built \`dist/index.js\` +
\`dist/index.css\` -- this demo's own build has **zero Tailwind** anywhere in its
toolchain. Every color, radius, and shadow you see comes from CSS custom
properties set on the wrapping element around the whole app, not from a
compiled utility stylesheet. Toggle the palette button in the toolbar above to
re-skin everything -- including the popups -- purely by changing those
variables.

See the [theming contract ADR](https://example.com/adr-workspace-kit) for the
full property list this page is proving.

## Try these

- [x] Toggle the palette while this popup helper text is visible
- [ ] Right-click a sidebar row to open its actions menu
- [ ] Open the sort dropdown (top of the sidebar) and the workspace switcher (top-left)
- [ ] Click the diagram below to open its edit dialog (the shared \`Modal\`)

## A code block

\`\`\`js
function describeContract(tokenCount) {
  // Re-themed by overriding CSS custom properties only -- no class edits.
  return \`\${tokenCount} tokens, zero Tailwind, one wrapping element\`;
}
\`\`\`

## A diagram

\`\`\`mermaid
graph TD
  A[Host renders a themed wrapper] --> B[Kit reads CSS custom properties]
  B --> C[Editor + Sidebar + Toolbar re-themed]
  C --> D[Popups portal inside the wrapper too]
\`\`\`

Renaming this file to \`Notes.md\` (the other file in the sidebar) will trigger
the rename-conflict tooltip -- watch it pick up the active palette's
\`--destructive-surface\` colors instead of the old hardcoded literal.
`;

export const NOTES_MARKDOWN = `# Notes

A second file, so the sidebar has more than one row (and so renaming
"Getting started" into this name demonstrates the rename-conflict tooltip).
`;
