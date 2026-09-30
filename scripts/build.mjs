import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'plugins/codex-taskboard/dist');
mkdirSync(output, { recursive: true });
await build({
  entryPoints: [join(root, 'src/ui.mjs')], bundle: true, platform: 'browser', format: 'iife',
  target: ['es2022'], outfile: join(output, 'ui.js'), minify: true,
});
copyFileSync(join(root, 'src/ui.html'), join(output, 'ui.html'));
await build({
  entryPoints: [join(root, 'src/server.mjs')], bundle: true, platform: 'node', format: 'esm',
  target: ['node26'], external: ['node:*'], outfile: join(output, 'server.mjs'),
});
