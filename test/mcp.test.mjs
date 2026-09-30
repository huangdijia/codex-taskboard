import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixture, onlyThread } from './fixtures.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appUri = 'ui://codex-taskboard/app.html';

async function connect(t, fixture, nativeDbPath = fixture.nativeDbPath) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'PLUGIN_DATA' && value !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'plugins/codex-taskboard/dist/server.mjs')],
    cwd: root,
    env: { ...env, TASKBOARD_CODEX_DB: nativeDbPath, TASKBOARD_DATA_DIR: fixture.dataDirectory },
    stderr: 'pipe',
  });
  let errors = '';
  transport.stderr?.on('data', chunk => { errors += chunk.toString(); });
  const client = new Client({ name: 'taskboard-integration-test', version: '1.0.0' });
  t.after(() => client.close());
  try { await client.connect(transport); }
  catch (error) { throw new Error(`MCP subprocess could not initialize: ${errors}`, { cause: error }); }
  return client;
}

test('MCP exposes the global app, four tools, and bundled initialization protocol', async t => {
  const fixture = await createFixture(t);
  await fixture.addThread({ title: 'MCP fixture' });
  const client = await connect(t, fixture);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'taskboard.accept_thread', 'taskboard.list_threads', 'taskboard.open', 'taskboard.reopen_thread',
  ]);
  const open = tools.find(tool => tool.name === 'taskboard.open');
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
  assert.equal(open._meta.ui.resourceUri, appUri);
  assert.deepEqual(open._meta.ui.visibility, ['app']);
  const list = tools.find(tool => tool.name === 'taskboard.list_threads');
  assert.equal(list.annotations.readOnlyHint, true);
  assert.deepEqual(list._meta.ui.visibility, ['app', 'model']);
  for (const name of ['taskboard.accept_thread', 'taskboard.reopen_thread']) {
    const tool = tools.find(tool => tool.name === name);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.deepEqual(tool._meta.ui.visibility, ['app']);
  }
  const resources = await client.listResources();
  assert.ok(resources.resources.some(resource => resource.uri === appUri));
  const resource = await client.readResource({ uri: appUri });
  const html = resource.contents[0];
  assert.equal(html.mimeType, 'text/html;profile=mcp-app');
  assert.match(html.text, /ui\/initialize/);
  assert.match(html.text, /taskboard\.list_threads/);
  assert.match(html.text, /taskboard\.accept_thread/);
  assert.match(html.text, /taskboard\.reopen_thread/);
  assert.equal(html.text.includes('<!--APP_SCRIPT-->'), false, 'bundled JavaScript must be injected literally without replacement-pattern expansion');
  const scripts = [...html.text.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0][1]), 'resource must contain valid bundled JavaScript');
  assert.deepEqual(html._meta['openai/ui'].availableDisplayModes, ['fullscreen']);
});

test('MCP list, accept, reopen and stale-revision errors traverse the real subprocess', async t => {
  const fixture = await createFixture(t);
  const entry = await fixture.addThread({ title: 'Generated MCP title', name: 'MCP acceptance' });
  const fallback = await fixture.addThread({ title: 'MCP fallback', name: '' });
  const client = await connect(t, fixture);
  const open = await client.callTool({ name: 'taskboard.open', arguments: {} });
  assert.equal(open.isError, undefined);
  let thread = onlyThread(open.structuredContent, entry.id);
  assert.equal(thread.title, 'MCP acceptance');
  assert.equal(onlyThread(open.structuredContent, fallback.id).title, 'MCP fallback');
  assert.equal(thread.status, 'Review');
  assert.equal(thread.messageTurnCount, 0);
  assert.equal(thread.messageTurnCountIncomplete, false);
  let result = await client.callTool({ name: 'taskboard.accept_thread', arguments: { threadId: entry.id, expectedRevision: thread.revision } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.thread.status, 'Done');
  thread = result.structuredContent.thread;
  result = await client.callTool({ name: 'taskboard.list_threads', arguments: { query: 'acceptance' } });
  assert.equal(onlyThread(result.structuredContent, entry.id).status, 'Done');
  result = await client.callTool({ name: 'taskboard.reopen_thread', arguments: { threadId: entry.id, expectedRevision: thread.revision } });
  assert.equal(result.isError, undefined);
  thread = result.structuredContent.thread;
  assert.equal(thread.status, 'Review');
  await entry.append(fixture.user(entry.id, 'new-turn'), fixture.task('task_started', 'new-turn'));
  result = await client.callTool({ name: 'taskboard.accept_thread', arguments: { threadId: entry.id, expectedRevision: thread.revision } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /VERSION_CONFLICT/);
  result = await client.callTool({ name: 'taskboard.list_threads', arguments: {} });
  assert.equal(onlyThread(result.structuredContent, entry.id).status, 'InProgress');
  assert.equal(onlyThread(result.structuredContent, entry.id).messageTurnCount, 1);
});

test('MCP reports inaccessible native data as an error rather than an empty board', async t => {
  const fixture = await createFixture(t);
  const client = await connect(t, fixture, join(fixture.directory, 'missing.sqlite'));
  const result = await client.callTool({ name: 'taskboard.list_threads', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /NATIVE_DB_ERROR/);
  assert.equal(result.structuredContent, undefined);
});
