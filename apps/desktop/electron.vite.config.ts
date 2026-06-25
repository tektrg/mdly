import { writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import icons from "unplugin-icons/vite";

const devPort = Number(process.env.PORT ?? 1420);

// On macOS 26+ (Darwin 25+), Electron 42 must be launched via
// 'open -n -a Bundle.app' (see scripts/electron-launcher-mac.sh).
// When launched this way, the main process runs as CJS (not ESM):
//   - package.json "type":"module" causes ESM static analysis to fail for
//     named imports from "electron" in Node v24
//   - Building as CJS avoids this; the type marker in the output dir ensures
//     Node treats the .js files as CommonJS regardless of the parent type field
function cjsOutputTypeMarker(dir: string) {
	return {
		name: `cjs-type-marker-${dir}`,
		closeBundle() {
			writeFileSync(`${dir}/package.json`, '{"type":"commonjs"}\n');
		},
	};
}

export default defineConfig({
	main: {
		plugins: [
			externalizeDepsPlugin({
				exclude: ["@hubble.md/runtime", "@tailwindcss/browser", "alpinejs"],
			}),
			cjsOutputTypeMarker("out/main"),
		],
		build: {
			lib: {
				entry: "electron/main.ts",
			},
			rollupOptions: {
				output: {
					format: "cjs",
					entryFileNames: "[name].js",
				},
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin(), cjsOutputTypeMarker("out/preload")],
		build: {
			lib: {
				entry: "electron/preload.ts",
			},
			rollupOptions: {
				output: {
					format: "cjs",
					entryFileNames: "[name].js",
				},
			},
		},
	},
	renderer: {
		root: ".",
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
			},
		},
		server: {
			port: devPort,
			strictPort: false,
		},
		build: {
			rollupOptions: {
				input: "index.html",
			},
		},
	},
});
