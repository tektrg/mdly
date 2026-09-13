// Extracted into a pure-Node package so `packages/sync` (and therefore the
// CLI and cloud sync) can reuse the same ignore-rule engine without pulling
// in the whole React kit. Re-exported here so this package's own
// `/file-discovery` entry point — and the desktop sidebar that imports it —
// stay byte-identical. See `packages/workspace-scan/src/file-discovery.ts`
// for the implementation.
export * from "@mdly/workspace-scan/file-discovery";
