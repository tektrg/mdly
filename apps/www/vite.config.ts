import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		react(),
		icons({
			compiler: "jsx",
			jsx: "react",
		}),
		tailwindcss(),
	],
	server: {
		port: 5173,
		strictPort: false,
		// During `pnpm dev`, proxy API/auth calls to a locally-running Worker
		// (`pnpm worker:dev`, default port 8787) — mirrors apps/notion-web, and
		// is what makes WORKER_BASE_URL (window.location.origin) resolve
		// correctly in dev too, not just in the same-origin production deploy.
		// `ws: true` is explicit (rather than relying on shorthand
		// auto-detection) because apps/www, unlike notion-web, opens a real
		// WebSocket through this path (the workspace change subscription).
		proxy: {
			"/api": { target: "http://localhost:8787", ws: true },
		},
	},
});
