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
				// The packaged app ships ONLY out/** (see package.json build.files) —
				// no node_modules. So every pure-JS dependency the main process uses
				// must be BUNDLED here, not externalized, or it throws
				// ERR_MODULE_NOT_FOUND at runtime in the packaged app (blank window).
				// electron-builder's pnpm packaging also drops the nested symlinks
				// (e.g. the prosemirror-* tree @tiptap/pm resolves through), so
				// externalizing is not an option even if node_modules were shipped.
				// Only truly runtime-provided modules stay external: `electron`
				// itself, Node built-ins, and electron-updater (loaded lazily and
				// never reached because auto-updates are disabled — see main.ts).
				exclude: [
					"@hubble.md/runtime",
					"@tailwindcss/browser",
					"alpinejs",
					"@tiptap/pm",
					"@tiptap/core",
					"@tiptap/extension-list",
					"@mdly/workspace-kit",
					"@mdly/workspace-kit/file-discovery",
					"@mdly/doc-history",
					"@mdly/doc-history/node",
					"@mdly/doc-comments",
					"diff",
					"ignore",
					"zod",
				],
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
			watch: {
				// The shared UI/workspace-kit packages are built by their own
				// watchers. Watching their generated dist here causes noisy HMR
				// reloads and can catch either package mid-rebuild.
				ignored: [
					"**/packages/ui/dist/**",
					"**/packages/workspace-kit/dist/**",
				],
			},
		},
		build: {
			rollupOptions: {
				input: "index.html",
			},
		},
	},
});
