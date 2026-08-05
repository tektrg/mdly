// @hubble.md/ui is now just the outer-window-layout component plus a thin
// re-export shim for the two primitives (Button, Modal) that mdly's
// non-moving screens (Settings, Notion dialogs, Welcome, HTML-apps callout,
// etc.) still consume. Everything else (editor, navigation, Input,
// Separator) moved to @mdly/workspace-kit — see
// docs/adr/0009-workspace-kit-package-boundary-and-theming-contract.md.
export { AppShellFrame } from "./components/AppShellFrame";
export { Button, buttonVariants, Modal } from "@mdly/workspace-kit";
