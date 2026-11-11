/**
 * Short Markdown authoring notes for agents writing files mdly renders
 * (MCP server `instructions`, CLI `hubble syntax`). Every example is checked
 * against the parser in `authoringNotes.test.ts`; the CLI keeps a copy in
 * `packages/cli/src/authoringNotes.ts` (it does not depend on the kit).
 */
export const MDLY_AUTHORING_NOTES = `mdly Markdown extras (plain CommonMark/GFM otherwise):
- Image size: ![alt|400](path) sets width; ![alt|400x300](path) sets width x height.
- Image paths: relative to the .md file (e.g. images/chart.png); avoid absolute paths.
- Columns: "::: columns" (optional ratio, e.g. "::: columns 2:1") then each column's blocks, "+++" between columns, ":::" to close. Columns cannot nest.
- Embeds: an <iframe src="https://..."></iframe> on its own line (blank lines around) becomes a live embed; all attributes are kept as written. Only https:// or a relative local .html src; http/javascript/data/file stay plain text. A bare URL stays a link.
- Diagrams: a \`\`\`mermaid fenced code block renders as a Mermaid diagram.`;
