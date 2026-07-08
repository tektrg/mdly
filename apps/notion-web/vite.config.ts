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
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: 5174,
		strictPort: false,
		// During `pnpm dev`, proxy API/auth calls to a locally-running Worker
		// (`pnpm worker:dev`, default port 8787).
		proxy: {
			"/api": "http://localhost:8787",
			"/auth": "http://localhost:8787",
		},
	},
});
