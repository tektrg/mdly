import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Toaster } from "./components/Toaster";
import "./components/toast.css";
import "./index.css";
import { applyStoredAppearancePreferences } from "./lib/theme";
import { STORAGE_KEY } from "./store/storage";
import { setupWebmcpSpikeProbe } from "./webmcp";

applyStoredAppearancePreferences(STORAGE_KEY);

// WebMCP spike: register the origin-probe tool and connect the local relay
// embed. Non-fatal if the polyfill is unavailable (e.g. a browser without
// WebMCP support); the app runs fine without it.
void setupWebmcpSpikeProbe();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<App />
		<Toaster />
	</React.StrictMode>,
);
