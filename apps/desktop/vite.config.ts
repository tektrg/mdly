import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

const devPort = Number(process.env.PORT ?? 1420);

// https://vite.dev/config/
export default defineConfig(async () => ({
	plugins: [
		react(),
		icons({
			compiler: "jsx",
			jsx: "react",
		}),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			// Desktop Vitest can run before workspace packages have built dist files.
			// The "/engine" alias must precede the bare-package alias below —
			// string aliases match by prefix, so the more specific entry has to
			// come first or it would resolve through the bare entry instead.
			"@mdly/workspace-kit/engine": fileURLToPath(
				new URL(
					"../../packages/workspace-kit/src/engine/index.ts",
					import.meta.url,
				),
			),
			"@mdly/workspace-kit/search": fileURLToPath(
				new URL(
					"../../packages/workspace-kit/src/nav/searchScore.ts",
					import.meta.url,
				),
			),
			"@mdly/workspace-kit/file-discovery": fileURLToPath(
				new URL(
					"../../packages/workspace-kit/src/file-discovery.ts",
					import.meta.url,
				),
			),
			"@mdly/workspace-kit": fileURLToPath(
				new URL("../../packages/workspace-kit/src/index.ts", import.meta.url),
			),
		},
	},
	clearScreen: false,
	server: {
		port: devPort,
		strictPort: false,
	},
}));
