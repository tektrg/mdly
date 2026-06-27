import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Toaster } from "./components/Toaster";
import "./components/toast.css";
import "./index.css";
import { applyStoredAppearancePreferences } from "./lib/theme";
import { STORAGE_KEY } from "./store/storage";

applyStoredAppearancePreferences(STORAGE_KEY);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<App />
		<Toaster />
	</React.StrictMode>,
);
