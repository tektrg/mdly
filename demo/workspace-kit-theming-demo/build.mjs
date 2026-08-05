// One-time esbuild bundle step (charter's resolved decision on how this demo
// loads the kit's ~15 runtime libraries: bundled once here, not an
// import-map/CDN dependency on separately-versioned packages -- this also
// doubles as a dry run of how a real host, e.g. SpeechToDo, will eventually
// bundle the kit). Deliberately plain esbuild, no Tailwind/PostCSS/etc: this
// demo's own toolchain has zero CSS build tooling beyond bundling the plain
// CSS files it and the kit already ship (R14/R15).
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const serveMode = process.argv.includes("--serve");
const watchMode = serveMode || process.argv.includes("--watch");

const buildOptions = {
	entryPoints: [join(rootDir, "src/main.tsx")],
	outdir: join(rootDir, "dist"),
	entryNames: "main",
	bundle: true,
	format: "esm",
	platform: "browser",
	target: ["es2022"],
	sourcemap: true,
	logLevel: "info",
	define: {
		"process.env.NODE_ENV": JSON.stringify("production"),
	},
	loader: {
		".css": "css",
	},
};

async function run() {
	if (watchMode) {
		const ctx = await esbuild.context(buildOptions);
		await ctx.watch();
		console.log("[build] watching for changes...");
		if (serveMode) {
			const PORT = Number(process.env.PORT ?? 4173);
			startStaticServer(PORT);
		}
	} else {
		await esbuild.build(buildOptions);
	}
}

function startStaticServer(port) {
	const mimeTypes = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".map": "application/json; charset=utf-8",
		".svg": "image/svg+xml",
	};

	const server = createServer((req, res) => {
		let urlPath = (req.url ?? "/").split("?")[0];
		if (urlPath === "/") urlPath = "/index.html";
		const filePath = join(rootDir, decodeURIComponent(urlPath));
		if (!existsSync(filePath)) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		const ext = extname(filePath);
		res.writeHead(200, {
			"Content-Type": mimeTypes[ext] ?? "application/octet-stream",
		});
		import("node:fs").then(({ createReadStream }) =>
			createReadStream(filePath).pipe(res),
		);
	});

	server.listen(port, () => {
		console.log(`[serve] http://localhost:${port}/index.html`);
	});
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
