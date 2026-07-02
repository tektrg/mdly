import { isAbsolute } from "node:path";
import { fileURLToPath, URL } from "node:url";
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
	],
	build: {
		cssCodeSplit: true,
		emptyOutDir: false,
		lib: {
			entry: {
				index: resolve("./src/index.ts"),
				tailwind: resolve("./src/tailwind.css"),
				theme: resolve("./src/theme.css"),
				fonts: resolve("./src/fonts.css"),
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
