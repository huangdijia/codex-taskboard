import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const output = join(process.cwd(), "plugins/codex-taskboard/dist");
mkdirSync(output, { recursive: true });
await build({
  entryPoints: ["src/ui.mjs"], bundle: true, platform: "browser", format: "iife",
  target: ["es2022"], outfile: join(output, "ui.js"), minify: true,
});
copyFileSync("src/ui.html", join(output, "ui.html"));
await build({
  entryPoints: ["src/server.mjs"], bundle: true, platform: "node", format: "esm",
  target: ["node26"], external: ["node:*"], outfile: join(output, "server.mjs"),
});
