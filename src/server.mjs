import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createTaskBoardStore, TaskError } from './store.mjs';

const codeHome = process.env.CODEX_HOME || join(homedir(), '.codex');
// Some CLI hosts do not expand plugin placeholders; never create that literal path.
const resolvedDirectory = (value) => value && !value.includes('${') ? value : undefined;
const dataDirectory = resolvedDirectory(process.env.PLUGIN_DATA)
  || resolvedDirectory(process.env.TASKBOARD_DATA_DIR)
  || join(codeHome, 'plugin-data', 'codex-taskboard');
const store = createTaskBoardStore({
  nativeDbPath: process.env.TASKBOARD_CODEX_DB || join(codeHome, 'state_5.sqlite'),
  dataDirectory,
});
const UI_URI = 'ui://codex-taskboard/app.html';
const uiDirectory = dirname(fileURLToPath(import.meta.url));
const boardHtml = readFileSync(join(uiDirectory, 'ui.html'), 'utf8')
  .replace('<!--APP_SCRIPT-->', () => `<script>${readFileSync(join(uiDirectory, 'ui.js'), 'utf8')}</script>`);
const icon = {
  src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33"><rect x="2.5" y="3" width="15" height="14" rx="2"/><path d="M7.5 3v14M10.5 7h4M10.5 10h4M10.5 13h3"/></svg>')}`,
  mimeType: 'image/svg+xml', sizes: ['20x20'],
};
const server = new McpServer({ name: 'codex-taskboard', version: '0.2.8', icons: [icon] }, {
  instructions: 'Read Codex thread status with taskboard.list_threads. Status is inferred from recorded events, not live process telemetry. User acceptance and reopening are performed only through the Codex TaskBoard app.',
});
const threadSchema = z.object({
  id: z.string(), title: z.string(), cwd: z.string(), updatedAt: z.number(),
  status: z.enum(['InProgress', 'Review', 'Done']), reason: z.string(),
  revision: z.string(), archived: z.boolean(), isSubagent: z.boolean(),
  sourceType: z.string(), stale: z.boolean(),
  messageTurnCount: z.number().int().nonnegative().nullable(), messageTurnCountIncomplete: z.boolean(),
});
const listOutput = {
  threads: z.array(threadSchema),
  counts: z.object({ InProgress: z.number().int(), Review: z.number().int(), Done: z.number().int() }),
  workspaces: z.array(z.object({ cwd: z.string(), name: z.string() })),
  stale: z.boolean(), lastSuccessfulReadAt: z.string().nullable(),
  errors: z.array(z.object({ code: z.string(), message: z.string(), threadId: z.string().optional() })),
};
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
function respond(action) {
  return async (args) => {
    try {
      const result = await action(args);
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const code = error instanceof TaskError ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof TaskError ? error.message : 'Codex TaskBoard could not complete the operation';
      return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
    }
  };
}
registerAppResource(server, 'Codex TaskBoard', UI_URI, {}, async () => ({
  contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: boardHtml,
    _meta: { 'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } },
  }],
}));
registerAppTool(server, 'taskboard.open', {
  title: 'Codex TaskBoard', description: 'Open Codex TaskBoard from the global sidebar.',
  inputSchema: {}, outputSchema: listOutput, annotations: readOnly,
  _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'global' }] } },
}, respond(() => store.listThreads({ query: '', cwd: '', showArchived: false, showSubagents: false })));
registerAppTool(server, 'taskboard.list_threads', {
  title: 'List Codex threads', description: 'Read locally recorded Codex threads and their inferred status. Archived threads, subagents and automations are hidden by default.',
  inputSchema: { query: z.string().default(''), cwd: z.string().default(''), showArchived: z.boolean().default(false), showSubagents: z.boolean().default(false) },
  outputSchema: listOutput, annotations: readOnly,
  _meta: { ui: { resourceUri: UI_URI, visibility: ['app', 'model'] } },
}, respond((filters) => store.listThreads(filters)));
for (const [name, title, description, action] of [
  ['accept_thread', 'Accept thread', 'Record the user’s acceptance of the reviewed thread in private plugin storage.', (threadId, revision) => store.acceptThread(threadId, revision)],
  ['reopen_thread', 'Reopen thread', 'Remove the user’s acceptance of this thread from private plugin storage.', (threadId, revision) => store.reopenThread(threadId, revision)],
]) {
  registerAppTool(server, `taskboard.${name}`, {
    title, description,
    inputSchema: { threadId: z.string().min(1), expectedRevision: z.string().min(1) },
    outputSchema: { thread: threadSchema }, annotations: write,
    _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } },
  }, respond(({ threadId, expectedRevision }) => action(threadId, expectedRevision)));
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await server.close(); } finally { await store.close(); }
}
process.once('SIGTERM', () => { shutdown().then(() => process.exit(0), () => process.exit(1)); });
process.once('SIGINT', () => { shutdown().then(() => process.exit(0), () => process.exit(1)); });
await server.connect(new StdioServerTransport());
