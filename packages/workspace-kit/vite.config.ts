import { isAbsolute } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const isExternal = (id: string) =>
	!id.startsWith(".") &&
	!id.startsWith("\0") &&
	!id.startsWith("~icons/") &&
	!isAbsolute(id);

export default defineConfig({
	plugins: [
		icons({
			compiler: "jsx",
			jsx: "react",
		}),
		// Compiles this package's own Tailwind utility-class usage (navigation
		// has no CSS files of its own) into static CSS at *this package's* build
		// time, scanning only its own src/ — never the consuming app's source.
		tailwindcss(),
	],
	build: {
		cssCodeSplit: true,
		emptyOutDir: false,
		lib: {
			entry: {
				index: resolve("./src/index.ts"),
				// Engine-only entry point (zero UI-library deps: no mermaid,
				// @dnd-kit, @base-ui/react, or cmdk). Consumers that only need pure
				// Markdown-parsing functions — e.g. an Electron main process — import
				// "@mdly/workspace-kit/engine" instead of the main barrel, so a
				// downstream bundler doesn't have to (and, per R8, currently can't)
				// tree-shake the navigation/editor-surface UI out of a single
				// pre-bundled dist file.
				engine: resolve("./src/engine/index.ts"),
			},
			formats: ["es"],
			fileName: (_format, entryName) => `${entryName}.js`,
			cssFileName: "style",
		},
		rollupOptions: {
			external: isExternal,
		},
		sourcemap: true,
	},
});
