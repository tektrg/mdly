import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Toaster } from "./components/Toaster";
import "./components/toast.css";
import "./index.css";
import { applyStoredAppearancePreferences } from "./lib/theme";
import { STORAGE_KEY } from "./store/storage";
import { setupWebmcpBridge } from "./webmcp";

applyStoredAppearancePreferences(STORAGE_KEY);

// WebMCP bridge (Slice 4): publish the agent comment tools and connect the
// local relay embed. Registers nothing when the user has agent access turned
// off, and is non-fatal if the polyfill is unavailable (e.g. a browser without
// WebMCP support); the app runs fine without it either way.
void setupWebmcpBridge();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<App />
		<Toaster />
	</React.StrictMode>,
);
