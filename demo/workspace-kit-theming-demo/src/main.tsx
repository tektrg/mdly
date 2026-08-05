// Entry point bundled by esbuild (see ../build.mjs). Loads only the kit's
// already-built dist/index.js + dist/index.css (via package.json's
// "./style.css" export) plus React -- nothing is compiled from the kit's
// source at demo-open time, only at this demo's own one-time build step
// (R15). Zero Tailwind anywhere in this import graph (R14).
import "@mdly/workspace-kit/style.css";
import "./theme.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
	throw new Error("#root element not found");
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
