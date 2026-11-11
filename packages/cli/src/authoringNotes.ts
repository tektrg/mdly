// Printed by `hubble syntax`. Copy of the kit's MDLY_AUTHORING_NOTES (the CLI
// doesn't depend on the kit); `authoringNotes.test.ts` fails if they drift.
export const MDLY_AUTHORING_NOTES = `mdly Markdown extras (plain CommonMark/GFM otherwise):
- Image size: ![alt|400](path) sets width; ![alt|400x300](path) sets width x height.
- Image paths: relative to the .md file (e.g. images/chart.png); avoid absolute paths.
- Columns: "::: columns" (optional ratio, e.g. "::: columns 2:1") then each column's blocks, "+++" between columns, ":::" to close. Columns cannot nest.
- Embeds: an <iframe src="https://..."></iframe> on its own line (blank lines around) becomes a live embed; all attributes are kept as written. Only https:// or a relative local .html src; http/javascript/data/file stay plain text. A bare URL stays a link.
- Diagrams: a \`\`\`mermaid fenced code block renders as a Mermaid diagram.`;
