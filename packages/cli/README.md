# mdly CLI

`mdly watch` streams a document's agent events (comments, "send edits to agent",
suggestion accept/reject) as JSON lines; `mdly mcp` is a stdio MCP server that
relays to the running app. Both use only stdin/stdout, so they work over plain `ssh`.

## Bundled in the app (no node needed)

Every packaged `mdly.app` ships the CLI at `Contents/Resources/cli/`: `mdly.js`
(a self-contained bundle, built by `apps/desktop/scripts/bundle-cli.mjs`) and a
`mdly` launcher that runs it with the app's own Electron as node.

```bash
L=/Applications/mdly.app/Contents/Resources/cli/mdly

# From another Mac, watch a note on the Mac running mdly:
ssh mbp-m4 "$L" watch ~/notes/plan.md     # or --open | --workspace <folder>

# Register the app's MCP tools with Claude Code over ssh:
claude mcp add mdly -- ssh mbp-m4 /Applications/mdly.app/Contents/Resources/cli/mdly mcp
```

Optional: `ln -s "$L" /usr/local/bin/mdly` on that Mac (the launcher follows symlinks).

## From source

`pnpm --filter @hubble.md/cli build`, then `node packages/cli/dist/mdly.js <command>`.
The entry runs under any file name (it compares real paths, not the name).
