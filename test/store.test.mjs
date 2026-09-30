import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createTaskBoardStore, TaskError } from '../src/store.mjs';
import { createFixture, onlyThread } from './fixtures.mjs';

async function setup(t) {
  const fixture = await createFixture(t);
  const store = createTaskBoardStore(fixture);
  t.after(() => store.close());
  return { ...fixture, store };
}

function hasCode(code) {
  return error => error instanceof TaskError && error.code === code;
}

function assertMessageTurns(thread, count, incomplete = false) {
  assert.equal(thread.messageTurnCount, count);
  assert.equal(thread.messageTurnCountIncomplete, incomplete);
}

test('message turns count unique user turns rather than items or system starts', async t => {
  const f = await setup(t);
  const id = 'user-turn-count';
  const first = f.user(id, 'first', 'first-item');
  const entry = await f.addThread({ id, events: [first, first, f.user(id, 'first', 'second-item'),
    f.user(id, 'second', 'third-item'), f.task('task_started', 'system-only')] });
  assertMessageTurns(onlyThread(await f.store.listThreads({}), id), 2);
  await entry.append(f.user(id, 'third', 'fourth-item'), f.task('task_started', 'another-system-turn'));
  assertMessageTurns(onlyThread(await f.store.listThreads({}), id), 3);
  const system = await f.addThread({ events: [f.task('task_started', 'system-only')] });
  assertMessageTurns(onlyThread(await f.store.listThreads({}), system.id), 0);
});

test('malformed modern user records are incomplete and foreign records are filtered first', async t => {
  const f = await setup(t);
  for (const [index, payload] of [
    { item: { type: 'UserMessage', id: 'unbound' } },
    { turn_id: ' \t ', item: { type: 'UserMessage', id: 'blank-turn' } },
    { turn_id: 'missing-item', item: { type: 'UserMessage' } },
    { turn_id: 'blank-item', item: { type: 'UserMessage', id: ' \t ' } },
  ].entries()) {
    const id = `malformed-user-${index}`;
    const entry = await f.addThread({ id, events: [f.record('item_completed', { thread_id: id, ...payload })] });
    assertMessageTurns(onlyThread(await f.store.listThreads({}), id), null, true);
    await entry.append(f.user(id, 'confirmed', 'valid-item'));
    assertMessageTurns(onlyThread(await f.store.listThreads({}), id), 1, true);
  }
  const id = 'foreign-user-filter';
  await f.addThread({ id, events: [
    f.record('item_completed', { thread_id: 'other-thread', turn_id: 'foreign', item: { type: 'UserMessage', id: 'valid' } }),
    f.record('item_completed', { thread_id: 'other-thread', item: { type: 'UserMessage' } }),
    f.record('user_message', { thread_id: 'other-thread' }),
    { type: 'response_item', payload: { type: 'message', role: 'user', thread_id: 'other-thread' } },
  ] });
  assertMessageTurns(onlyThread(await f.store.listThreads({}), id), 0);
});

test('legacy user messages expose unknown counts and mixed histories expose a lower bound', async t => {
  const f = await setup(t);
  for (const [index, legacy] of [f.record('user_message'),
    { type: 'response_item', payload: { type: 'message', role: 'user' } },
  ].entries()) {
    const id = `legacy-user-${index}`;
    const entry = await f.addThread({ id, events: [legacy, f.task('task_started', 'system')] });
    assertMessageTurns(onlyThread(await f.store.listThreads({}), id), null, true);
    await entry.append(f.user(id, 'confirmed', 'item-1'), f.user(id, 'confirmed', 'item-2'));
    assertMessageTurns(onlyThread(await f.store.listThreads({}), id), 1, true);
  }
});

test('a partial user message temporarily marks the count incomplete until its newline arrives', async t => {
  const f = await setup(t);
  const id = 'partial-user-count';
  const entry = await f.addThread({ id, events: [f.user(id, 'first', 'first-item')] });
  assertMessageTurns(onlyThread(await f.store.listThreads({}), id), 1);
  const line = JSON.stringify(f.user(id, 'second', 'second-item'));
  const split = Math.floor(line.length / 2);
  await appendFile(entry.rolloutPath, line.slice(0, split));
  const partial = onlyThread(await f.store.listThreads({}), id);
  assertMessageTurns(partial, 1, true);
  await assert.rejects(f.store.acceptThread(id, partial.revision), hasCode('LOG_NOT_READY'));
  await appendFile(entry.rolloutPath, line.slice(split) + '\n');
  assertMessageTurns(onlyThread(await f.store.listThreads({}), id), 2);
});

test('thread display titles prefer native names and empty names fall back to titles', async t => {
  const f = await setup(t);
  const named = await f.addThread({ title: 'Original generated title', name: 'Saved native name' });
  const fallbacks = [];
  for (const [index, name] of [null, '', ' \t\n '].entries()) {
    const title = `Fallback title ${index}`;
    fallbacks.push({ ...(await f.addThread({ title, name })), title });
  }
  const snapshot = await f.store.listThreads({});
  assert.equal(onlyThread(snapshot, named.id).title, 'Saved native name');
  for (const entry of fallbacks) assert.equal(onlyThread(snapshot, entry.id).title, entry.title);
  assert.deepEqual((await f.store.listThreads({ query: 'saved native' })).threads.map(thread => thread.id), [named.id]);
  assert.equal((await f.store.listThreads({ query: 'original generated' })).threads.length, 0);
  assert.deepEqual((await f.store.listThreads({ query: 'fallback title 0' })).threads.map(thread => thread.id), [fallbacks[0].id]);
});

test('native thread renames refresh display and search and reject the old acceptance revision', async t => {
  const f = await setup(t);
  const entry = await f.addThread({ title: 'Generated title', name: 'Before rename' });
  const before = onlyThread(await f.store.listThreads({}), entry.id);
  f.database.prepare('UPDATE threads SET name = ? WHERE id = ?').run('After rename', entry.id);
  const after = onlyThread(await f.store.listThreads({ query: 'after rename' }), entry.id);
  assert.equal(after.title, 'After rename');
  assert.notEqual(after.revision, before.revision);
  assert.equal((await f.store.listThreads({ query: 'before rename' })).threads.length, 0);
  await assert.rejects(f.store.acceptThread(entry.id, before.revision), hasCode('VERSION_CONFLICT'));
  assert.equal((await f.store.acceptThread(entry.id, after.revision)).thread.status, 'Done');
});

test('project labels prefer saved names for exact roots and refresh after a rename', async t => {
  const f = await setup(t);
  const named = await f.addThread({ cwd: '/code/native-folder', title: 'Native thread name' });
  await f.addThread({ cwd: '/code/native-folder/nested' });
  const statePath = join(f.directory, '.codex-global-state.json');
  await writeFile(statePath, JSON.stringify({ 'local-projects': {
    project: { name: 'Saved project name', rootPaths: ['/code/native-folder'] },
    invalid: { name: '', rootPaths: ['/code/native-folder/nested'] },
  } }));
  const snapshot = await f.store.listThreads({});
  assert.deepEqual(snapshot.workspaces, [
    { cwd: '/code/native-folder', name: 'Saved project name' },
    { cwd: '/code/native-folder/nested', name: 'nested' },
  ]);
  const original = onlyThread(snapshot, named.id);
  await writeFile(statePath, JSON.stringify({ 'local-projects': {
    project: { name: 'Renamed', rootPaths: ['/code/native-folder'] },
  } }));
  const renamed = await f.store.listThreads({ cwd: '/code/native-folder' });
  assert.equal(renamed.workspaces[0].name, 'Renamed');
  assert.equal(renamed.threads.length, 1);
  assert.equal(renamed.threads[0].title, 'Native thread name');
  assert.equal(renamed.threads[0].revision, original.revision, 'display-only project renames must not change acceptance state');
});

test('duplicate project names use the shortest distinct parent suffix', async t => {
  const f = await setup(t);
  for (const cwd of ['/code/one/app/task', '/code/two/app/task', '/elsewhere/task']) await f.addThread({ cwd });
  const snapshot = await f.store.listThreads({});
  assert.deepEqual(snapshot.workspaces, [
    { cwd: '/code/one/app/task', name: 'task · one/app' },
    { cwd: '/code/two/app/task', name: 'task · two/app' },
    { cwd: '/elsewhere/task', name: 'task · elsewhere' },
  ]);
});

test('missing, malformed and ambiguous project metadata fall back without hiding threads', async t => {
  const f = await setup(t);
  await f.addThread({ cwd: '/code/fallback' });
  const statePath = join(f.directory, '.codex-global-state.json');
  const checkFallback = async () => {
    const snapshot = await f.store.listThreads({});
    assert.deepEqual(snapshot.workspaces, [{ cwd: '/code/fallback', name: 'fallback' }]);
    assert.equal(snapshot.threads.length, 1);
    assert.equal(snapshot.stale, false);
  };
  await checkFallback();
  await writeFile(statePath, '{partial');
  await checkFallback();
  await writeFile(statePath, JSON.stringify({ 'local-projects': {
    first: { name: 'First', rootPaths: ['/code/fallback'] },
    second: { name: 'Second', rootPaths: ['/code/fallback'] },
  } }));
  await checkFallback();
  await writeFile(statePath, JSON.stringify({ 'local-projects': {
    valid: { name: 'Recovered', rootPaths: ['/code/fallback'] },
  } }));
  assert.equal((await f.store.listThreads({})).workspaces[0].name, 'Recovered');
  await rm(statePath);
  await checkFallback();
});

function readCheckpoint(fixture, threadId) {
  const database = new DatabaseSync(join(fixture.dataDirectory, 'taskboard.sqlite'), { readOnly: true });
  try {
    const row = database.prepare('SELECT schema_version, checkpoint_json FROM observation_checkpoints WHERE thread_id = ?').get(threadId);
    assert.ok(row, `a successful full-line scan must checkpoint ${threadId}`);
    assert.equal(row.schema_version, 1);
    return JSON.parse(row.checkpoint_json);
  } finally { database.close(); }
}

async function countRolloutReadBytes(path, action) {
  const originalOpen = fsPromises.open;
  let bytes = 0;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path) {
      const originalRead = handle.read;
      handle.read = async (...readArgs) => {
        const result = await originalRead.apply(handle, readArgs);
        bytes += result.bytesRead;
        return result;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await action(); return bytes; }
  finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
}

test('first scan leaves an isolated historical start in Review', async t => {
  const f = await setup(t);
  const entry = await f.addThread({ events: [f.task('task_started', 'old-turn')] });
  const snapshot = await f.store.listThreads({});
  const thread = onlyThread(snapshot, entry.id);
  assert.equal(thread.status, 'Review');
  assert.ok(thread.reason);
  assert.ok(thread.revision);
  assert.equal(snapshot.stale, false);
  assert.ok(snapshot.lastSuccessfulReadAt);
  assert.equal(thread.updatedAt, 1790726400000);
});

test('new starts, matching completion, and interrupted turns update observed state', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  await f.store.listThreads({});
  await entry.append(f.task('task_started', 'turn-1'));
  let thread = onlyThread(await f.store.listThreads({}), entry.id);
  assert.equal(thread.status, 'InProgress');
  const runningRevision = thread.revision;
  await entry.append(f.task('task_complete', 'another-turn'));
  thread = onlyThread(await f.store.listThreads({}), entry.id);
  assert.equal(thread.status, 'InProgress', 'another turn must not finish the active turn');
  await entry.append(f.task('task_complete', 'turn-1'));
  thread = onlyThread(await f.store.listThreads({}), entry.id);
  assert.equal(thread.status, 'Review');
  assert.notEqual(thread.revision, runningRevision);
  await entry.append(f.task('task_started', 'turn-2'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
  await entry.append(f.task('turn_aborted', 'turn-2'));
  thread = onlyThread(await f.store.listThreads({}), entry.id);
  assert.equal(thread.status, 'Review');
  assert.ok(thread.reason);
});

test('an error terminal from another turn cannot end the active turn', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  await f.store.listThreads({});
  await entry.append(f.task('task_started', 'active'));
  await f.store.listThreads({});
  await entry.append(f.task('task_complete', 'unrelated', { error: 'failed' }), f.task('turn_aborted', 'unrelated'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
  await entry.append(f.task('task_complete', 'active', { error: 'failed' }));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
});

test('a split JSONL event is consumed only after its complete newline arrives', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  const initial = onlyThread(await f.store.listThreads({}), entry.id);
  const line = JSON.stringify(f.task('task_started', 'split-turn'));
  const split = Math.floor(line.length / 2);
  await appendFile(entry.rolloutPath, line.slice(0, split));
  const partial = onlyThread(await f.store.listThreads({}), entry.id);
  assert.equal(partial.status, initial.status);
  assert.equal(partial.revision, initial.revision);
  await appendFile(entry.rolloutPath, line.slice(split) + '\n');
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
});

test('a start that was partial at startup remains historical when its tail arrives', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  const historical = JSON.stringify(f.task('task_started', 'historical-split'));
  const split = Math.floor(historical.length / 2);
  await appendFile(entry.rolloutPath, historical.slice(0, split));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
  await appendFile(entry.rolloutPath, historical.slice(split) + '\n');
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
  await entry.append(f.task('task_started', 'new-complete-start'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
});

test('rollout read failure retains stale state and forbids acceptance', async t => {
  const f = await setup(t);
  const id = 'read-failure-count';
  const entry = await f.addThread({ id, events: [f.user(id, 'past'), f.task('task_complete', 'past')] });
  const before = onlyThread(await f.store.listThreads({}), entry.id);
  assertMessageTurns(before, 1);
  await rename(entry.rolloutPath, `${entry.rolloutPath}.unavailable`);
  const snapshot = await f.store.listThreads({});
  const stale = onlyThread(snapshot, entry.id);
  assert.equal(stale.status, before.status);
  assert.equal(stale.stale, true);
  assertMessageTurns(stale, null, true);
  assert.equal(snapshot.stale, true);
  assert.ok(snapshot.errors.some(error => error.threadId === entry.id));
  await assert.rejects(f.store.acceptThread(entry.id, before.revision));
  await rename(`${entry.rolloutPath}.unavailable`, entry.rolloutPath);
  assertMessageTurns(onlyThread(await f.store.listThreads({}), entry.id), 1);
});

test('truncation and inode replacement establish a fresh historical baseline', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  await f.store.listThreads({});
  await entry.append(f.task('task_started', 'current'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
  await writeFile(entry.rolloutPath, JSON.stringify(f.task('task_started', 'old')) + '\n');
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
  await entry.append(f.task('task_started', 'again'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
  const replacement = `${entry.rolloutPath}.replacement`;
  await writeFile(replacement, JSON.stringify(f.task('task_started', 'replaced')) + '\n');
  await rename(replacement, entry.rolloutPath);
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
});

test('acceptance persists across restarts and reopening returns to Review', async t => {
  const f = await createFixture(t);
  const entry = await f.addThread({ events: [f.task('task_started', 'historical')] });
  let store = createTaskBoardStore(f);
  t.after(() => store.close());
  let thread = onlyThread(await store.listThreads({}), entry.id);
  await store.close();
  store = createTaskBoardStore(f);
  thread = onlyThread(await store.listThreads({}), entry.id);
  assert.equal(thread.status, 'Review');
  thread = (await store.acceptThread(entry.id, thread.revision)).thread;
  assert.equal(thread.status, 'Done');
  await store.close();
  store = createTaskBoardStore(f);
  thread = onlyThread(await store.listThreads({}), entry.id);
  assert.equal(thread.status, 'Done');
  thread = (await store.reopenThread(entry.id, thread.revision)).thread;
  assert.equal(thread.status, 'Review');
});

test('restart converts a previously observed unfinished turn into pending Review', async t => {
  const f = await createFixture(t);
  const entry = await f.addThread();
  let store = createTaskBoardStore(f);
  t.after(() => store.close());
  await store.listThreads({});
  await entry.append(f.task('task_started', 'unfinished'));
  assert.equal(onlyThread(await store.listThreads({}), entry.id).status, 'InProgress');
  await store.close();
  store = createTaskBoardStore(f);
  const thread = onlyThread(await store.listThreads({}), entry.id);
  assert.equal(thread.status, 'Review');
  assert.ok(thread.reason);
});

test('an active task cannot be accepted and competing UI acceptances cannot both succeed', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  await f.store.listThreads({});
  await entry.append(f.task('task_started', 'active'));
  let thread = onlyThread(await f.store.listThreads({}), entry.id);
  await assert.rejects(f.store.acceptThread(entry.id, thread.revision));
  await entry.append(f.task('task_complete', 'active'));
  thread = onlyThread(await f.store.listThreads({}), entry.id);
  const results = await Promise.allSettled([
    f.store.acceptThread(entry.id, thread.revision),
    f.store.acceptThread(entry.id, thread.revision),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Done');
});

test('independent stores sharing private storage permit one acceptance and one reopening per revision', async t => {
  const f = await createFixture(t);
  const entry = await f.addThread();
  const first = createTaskBoardStore(f);
  const second = createTaskBoardStore(f);
  t.after(async () => { await first.close(); await second.close(); });
  const initial = await Promise.all([first.listThreads({}), second.listThreads({})]);
  const firstReview = onlyThread(initial[0], entry.id);
  const secondReview = onlyThread(initial[1], entry.id);
  assert.equal(firstReview.status, 'Review');
  assert.equal(secondReview.revision, firstReview.revision);
  const acceptances = await Promise.allSettled([
    first.acceptThread(entry.id, firstReview.revision),
    second.acceptThread(entry.id, secondReview.revision),
  ]);
  assert.equal(acceptances.filter(result => result.status === 'fulfilled').length, 1, 'one shared acceptance revision can be applied once');
  const acceptanceConflict = acceptances.find(result => result.status === 'rejected');
  assert.ok(acceptanceConflict);
  assert.equal(acceptanceConflict.reason.code, 'VERSION_CONFLICT');
  const accepted = await Promise.all([first.listThreads({}), second.listThreads({})]);
  const firstDone = onlyThread(accepted[0], entry.id);
  const secondDone = onlyThread(accepted[1], entry.id);
  assert.equal(firstDone.status, 'Done');
  assert.equal(secondDone.status, 'Done');
  assert.equal(secondDone.revision, firstDone.revision);
  const reopenings = await Promise.allSettled([
    first.reopenThread(entry.id, firstDone.revision),
    second.reopenThread(entry.id, secondDone.revision),
  ]);
  assert.equal(reopenings.filter(result => result.status === 'fulfilled').length, 1, 'one shared reopening revision can be applied once');
  const reopeningConflict = reopenings.find(result => result.status === 'rejected');
  assert.ok(reopeningConflict);
  assert.equal(reopeningConflict.reason.code, 'VERSION_CONFLICT');
  for (const store of [first, second]) {
    assert.equal(onlyThread(await store.listThreads({}), entry.id).status, 'Review');
  }
});

test('only a new real user item invalidates Done; starts and system events preserve it', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  let thread = onlyThread(await f.store.listThreads({}), entry.id);
  await f.store.acceptThread(entry.id, thread.revision);
  await entry.append(f.task('task_started', 'system-turn'), f.record('item_completed', {
    thread_id: entry.id, turn_id: 'system-turn', item: { type: 'SystemMessage', id: 'system-item' },
  }));
  thread = onlyThread(await f.store.listThreads({}), entry.id);
  assert.equal(thread.status, 'Done');
  await entry.append(f.user(entry.id, 'user-turn', 'real-user'));
  thread = onlyThread(await f.store.listThreads({}), entry.id);
  assert.notEqual(thread.status, 'Done');
  assert.equal(thread.status, 'Review');
  await entry.append(f.task('task_started', 'user-turn'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
});

test('a real user item addressed to another thread cannot invalidate this thread acceptance', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  const thread = onlyThread(await f.store.listThreads({}), entry.id);
  await f.store.acceptThread(entry.id, thread.revision);
  await entry.append(f.user('another-thread', 'foreign-user-turn'), f.task('task_started', 'system-turn'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Done');
  await entry.append(f.user(entry.id, 'local-user-turn'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
});

test('a new start after a historical user item is observed as InProgress', async t => {
  const f = await setup(t);
  const id = 'historical-user-thread';
  const entry = await f.addThread({ id, events: [f.user(id, 'historical-user-turn')] });
  assert.equal(onlyThread(await f.store.listThreads({}), id).status, 'Review');
  await entry.append(f.task('task_started', 'new-system-turn'));
  assert.equal(onlyThread(await f.store.listThreads({}), id).status, 'InProgress');
});

test('accept refreshes logs and rejects an outdated UI revision', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  const thread = onlyThread(await f.store.listThreads({}), entry.id);
  await entry.append(f.user(entry.id, 'new-turn'), f.task('task_started', 'new-turn'));
  await assert.rejects(f.store.acceptThread(entry.id, thread.revision), hasCode('VERSION_CONFLICT'));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
});

test('a partially written event prevents acceptance until the log is caught up', async t => {
  const f = await setup(t);
  const entry = await f.addThread();
  const thread = onlyThread(await f.store.listThreads({}), entry.id);
  const event = JSON.stringify(f.user(entry.id, 'pending-turn'));
  await appendFile(entry.rolloutPath, event.slice(0, 30));
  await assert.rejects(f.store.acceptThread(entry.id, thread.revision), hasCode('LOG_NOT_READY'));
  await appendFile(entry.rolloutPath, event.slice(30) + '\n');
  const refreshed = onlyThread(await f.store.listThreads({}), entry.id);
  assert.notEqual(refreshed.revision, thread.revision);
  assert.equal((await f.store.acceptThread(entry.id, refreshed.revision)).thread.status, 'Done');
});

test('archived is independent of Done; filters, sources, counts and workspaces are consistent', async t => {
  const f = await setup(t);
  const main = await f.addThread({ title: 'Alpha launch', cwd: '/workspace/alpha' });
  await f.addThread({ title: 'Beta review', cwd: '/workspace/beta', threadSource: 'agent_created_thread' });
  const archived = await f.addThread({ title: 'Archived review', archived: true });
  const agent = await f.addThread({ title: 'Subagent review', threadSource: 'subagent', source: JSON.stringify({ subagent: { parent_thread_id: main.id } }) });
  const legacyAgent = await f.addThread({ title: 'Legacy subagent', threadSource: null, source: JSON.stringify({ subagent: { parent_thread_id: main.id } }) });
  await f.addThread({ title: 'Automation hidden', threadSource: 'automation' });
  const legacy = await f.addThread({ title: 'Legacy main', threadSource: null });
  let snapshot = await f.store.listThreads({});
  assert.equal(snapshot.threads.length, 3);
  assert.equal(onlyThread(snapshot, legacy.id).sourceType, 'legacy');
  assert.equal(snapshot.threads.some(thread => thread.id === archived.id || thread.id === agent.id || thread.id === legacyAgent.id), false);
  assert.equal(snapshot.workspaces.length, 2);
  snapshot = await f.store.listThreads({ showArchived: true, showSubagents: true });
  assert.equal(snapshot.threads.length, 6);
  assert.equal(onlyThread(snapshot, archived.id).status, 'Review');
  assert.equal(onlyThread(snapshot, agent.id).isSubagent, true);
  assert.equal(onlyThread(snapshot, legacyAgent.id).isSubagent, true);
  snapshot = await f.store.listThreads({ query: 'alpha', cwd: '/workspace/alpha' });
  assert.deepEqual(snapshot.threads.map(thread => thread.id), [main.id]);
  assert.equal(snapshot.counts.Review, 1);
  assert.equal(snapshot.counts.InProgress, 0);
  assert.equal(snapshot.counts.Done, 0);
});

test('minimal supported native schema remains readable without optional metadata columns', async t => {
  const f = await createFixture(t);
  const path = join(f.directory, 'minimal.sqlite');
  const rolloutPath = join(f.directory, 'minimal.jsonl');
  await writeFile(rolloutPath, '');
  const native = new DatabaseSync(path);
  native.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, updated_at INTEGER, archived INTEGER)');
  native.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('minimal', rolloutPath, 'Minimal native thread', '/workspace/minimal', 1790726400, 0);
  native.close();
  const store = createTaskBoardStore({ nativeDbPath: path, dataDirectory: join(f.directory, 'minimal-scratch') });
  t.after(() => store.close());
  const thread = onlyThread(await store.listThreads({}), 'minimal');
  assert.equal(thread.title, 'Minimal native thread');
  assert.equal(thread.status, 'Review');
  assert.equal(thread.sourceType, 'legacy');
  assert.equal(thread.updatedAt, 1790726400000);
  const importedPath = join(f.directory, 'minimal-imported.jsonl');
  await writeFile(importedPath, JSON.stringify(f.task('task_started', 'imported-without-created-at')) + '\n');
  const importer = new DatabaseSync(path);
  importer.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('minimal-imported', importedPath, 'Imported without creation metadata', '/workspace/minimal', Math.floor(Date.now() / 1000), 0);
  importer.close();
  assert.equal(onlyThread(await store.listThreads({}), 'minimal-imported').status, 'Review');
});

test('native writes are forbidden and initial missing, unsupported and locked databases are errors', async t => {
  const f = await createFixture(t);
  const store = createTaskBoardStore(f);
  t.after(() => store.close());
  const entry = await f.addThread();
  const before = await readFile(f.nativeDbPath);
  let thread = onlyThread(await store.listThreads({}), entry.id);
  await store.acceptThread(entry.id, thread.revision);
  assert.deepEqual(await readFile(f.nativeDbPath), before, 'scratch acceptance must not mutate native SQLite');
  for (const kind of ['missing', 'unsupported', 'locked']) {
    const path = join(f.directory, `${kind}.sqlite`);
    let writer;
    if (kind !== 'missing') {
      writer = new DatabaseSync(path);
      writer.exec(kind === 'unsupported' ? 'CREATE TABLE unrelated (id TEXT)' : 'CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, cwd TEXT, updated_at INTEGER, archived INTEGER)');
      if (kind === 'locked') writer.exec('BEGIN EXCLUSIVE');
    }
    const brokenStore = createTaskBoardStore({ nativeDbPath: path, dataDirectory: join(f.directory, kind) });
    try { await assert.rejects(brokenStore.listThreads({}), hasCode('NATIVE_DB_ERROR')); }
    finally { await brokenStore.close(); if (writer) { if (kind === 'locked') writer.exec('ROLLBACK'); writer.close(); } }
  }
});

test('native read failure after a successful read exposes the prior stale snapshot', async t => {
  const f = await setup(t);
  const id = 'native-read-failure-count';
  const entry = await f.addThread({ id, events: [f.user(id, 'confirmed')] });
  const before = await f.store.listThreads({});
  assertMessageTurns(onlyThread(before, id), 1);
  f.database.exec('BEGIN EXCLUSIVE');
  let after;
  try { after = await f.store.listThreads({}); } finally { f.database.exec('ROLLBACK'); }
  assert.equal(after.stale, true);
  assert.equal(onlyThread(after, entry.id).stale, true);
  assertMessageTurns(onlyThread(after, id), null, true);
  assert.equal(after.lastSuccessfulReadAt, before.lastSuccessfulReadAt);
  assert.ok(after.errors.some(error => error.code === 'NATIVE_DB_ERROR'));
  assertMessageTurns(onlyThread(await f.store.listThreads({}), id), 1);
});

test('output filters never stop observation of hidden workspaces, archived threads or subagents', async t => {
  const f = await setup(t);
  const visible = await f.addThread({ title: 'Visible task', cwd: '/workspace/visible' });
  const otherWorkspace = await f.addThread({ title: 'Hidden workspace task', cwd: '/workspace/hidden' });
  const archived = await f.addThread({ title: 'Hidden archived task', archived: true });
  const subagent = await f.addThread({ title: 'Hidden subagent task', threadSource: 'subagent', source: JSON.stringify({ subagent: { parent_thread_id: visible.id } }) });
  const filter = { query: 'Visible', cwd: '/workspace/visible' };
  const initial = await f.store.listThreads(filter);
  assert.deepEqual(initial.threads.map(thread => thread.id), [visible.id]);
  for (const entry of [otherWorkspace, archived, subagent]) {
    await entry.append(f.task('task_started', `hidden-start-${entry.id}`));
  }
  assert.deepEqual((await f.store.listThreads(filter)).threads.map(thread => thread.id), [visible.id]);
  const revealed = await f.store.listThreads({ query: 'Hidden', showArchived: true, showSubagents: true });
  for (const entry of [otherWorkspace, archived, subagent]) {
    assert.equal(onlyThread(revealed, entry.id).status, 'InProgress', `hidden thread ${entry.id} must retain its observed start`);
  }
  assert.equal(revealed.counts.InProgress, 3);
});

test('threads discovered after the initial directory baseline expose their current newly observed turn', async t => {
  const f = await setup(t);
  await f.addThread({ title: 'Initial board task' });
  await f.store.listThreads({});
  const createdAt = Math.floor(Date.now() / 1000);
  const active = await f.addThread({ title: 'New active task', createdAt, events: [f.task('task_started', 'new-active-turn')] });
  const finished = await f.addThread({ title: 'New finished task', createdAt, events: [
    f.task('task_started', 'new-finished-turn'), f.task('task_complete', 'new-finished-turn'),
  ] });
  const imported = await f.addThread({ title: 'Imported historical unfinished task', createdAt: createdAt - 60,
    events: [f.task('task_started', 'imported-old-turn')] });
  const millisecondActive = await f.addThread({ title: 'New task with millisecond creation metadata', createdAt: 0,
    createdAtMs: Date.now(), events: [f.task('task_started', 'new-ms-turn')] });
  const snapshot = await f.store.listThreads({});
  assert.equal(onlyThread(snapshot, active.id).status, 'InProgress');
  assert.equal(onlyThread(snapshot, finished.id).status, 'Review');
  assert.equal(onlyThread(snapshot, imported.id).status, 'Review');
  assert.equal(onlyThread(snapshot, millisecondActive.id).status, 'InProgress');
});

test('native data recovery baselines starts and newly discovered threads written during the interruption', async t => {
  const f = await setup(t);
  const existing = await f.addThread({ title: 'Existing task' });
  await f.store.listThreads({});
  f.database.exec('BEGIN EXCLUSIVE');
  let newcomer;
  let committed = false;
  try {
    const stale = await f.store.listThreads({});
    assert.equal(stale.stale, true);
    await existing.append(f.task('task_started', 'outage-existing-start'));
    newcomer = await f.addThread({ title: 'Discovered after outage', events: [f.task('task_started', 'outage-new-start')] });
    f.database.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) f.database.exec('ROLLBACK');
  }
  const recovered = await f.store.listThreads({});
  assert.equal(recovered.stale, false);
  assert.equal(onlyThread(recovered, existing.id).status, 'Review');
  assert.equal(onlyThread(recovered, newcomer.id).status, 'Review');
  await existing.append(f.task('task_started', 'post-recovery-existing-start'));
  await newcomer.append(f.task('task_started', 'post-recovery-new-start'));
  const current = await f.store.listThreads({});
  assert.equal(onlyThread(current, existing.id).status, 'InProgress');
  assert.equal(onlyThread(current, newcomer.id).status, 'InProgress');
});

for (const type of ['Reasoning', 'AgentMessage', 'CommandExecution', 'McpToolCall', 'SubAgentActivity', 'FileChange', 'Plan', 'ContextCompaction']) {
  test(`new ${type} execution evidence advances a historical unfinished turn but cannot revive a terminal turn`, async t => {
    const f = await setup(t);
    const entry = await f.addThread({ events: [f.task('task_started', 'historical-turn')] });
    assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
    await entry.append(f.record('item_completed', {
      thread_id: entry.id, turn_id: 'historical-turn', item: { type, id: 'new-execution-item' },
    }));
    assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
    await entry.append(f.task('task_complete', 'historical-turn'));
    assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
    await entry.append(f.record('item_completed', {
      thread_id: entry.id, turn_id: 'historical-turn', item: { type, id: 'late-execution-item' },
    }));
    assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
  });
}

test('item_started with execution evidence restores a historical unfinished turn', async t => {
  const f = await setup(t);
  const entry = await f.addThread({ events: [f.task('task_started', 'historical-turn')] });
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'Review');
  await entry.append(f.record('item_started', {
    thread_id: entry.id, turn_id: 'historical-turn', item: { type: 'CommandExecution', id: 'running-command' },
  }));
  assert.equal(onlyThread(await f.store.listThreads({}), entry.id).status, 'InProgress');
});

test('historical execution items, user input, unknown items and unbound counters cannot prove new execution', async t => {
  const f = await setup(t);
  const id = 'non-execution-evidence-thread';
  const entry = await f.addThread({ id, events: [
    f.task('task_started', 'historical-turn'),
    f.record('item_completed', { thread_id: id, turn_id: 'historical-turn', item: { type: 'Reasoning', id: 'old-reasoning' } }),
  ] });
  assert.equal(onlyThread(await f.store.listThreads({}), id).status, 'Review');
  for (const event of [
    f.user(id, 'historical-turn', 'new-user-item'),
    f.record('item_completed', { thread_id: id, turn_id: 'historical-turn', item: { type: 'UnknownExecutionType', id: 'unknown' } }),
    f.record('token_count', { tokens: 100 }),
    f.record('item_started', { thread_id: id, turn_id: 'other-turn', item: { type: 'CommandExecution', id: 'other-turn-command' } }),
    f.record('item_completed', { thread_id: id, item: { type: 'Reasoning', id: 'unbound-reasoning' } }),
  ]) {
    await entry.append(event);
    assert.equal(onlyThread(await f.store.listThreads({}), id).status, 'Review', `${event.payload.type} must not prove this turn is advancing`);
  }
});

test('a valid private metadata checkpoint avoids rereading the historical rollout prefix on restart', async t => {
  const f = await createFixture(t);
  const id = 'cached-large-thread';
  const secret = 'synthetic-body-must-stay-local';
  const user = f.user(id, 'cached-turn', 'original-user');
  user.payload.item.text = secret;
  const prefix = Array.from({ length: 700 }, (_, index) => f.record('item_completed', {
    thread_id: id, turn_id: 'cached-turn', item: { type: 'AgentMessage', id: `historical-${index}`, text: secret.repeat(32) },
  }));
  const entry = await f.addThread({ id, events: [user, ...prefix, f.task('task_started', 'cached-turn'),
    f.record('synthetic_ignored_record', { message: secret.repeat(4) }),
  ] });
  let store = createTaskBoardStore(f);
  t.after(() => store.close());
  const cold = onlyThread(await store.listThreads({}), id);
  assert.equal(cold.status, 'Review');
  assertMessageTurns(cold, 1);
  const checkpoint = readCheckpoint(f, id);
  assert.deepEqual(Object.keys(checkpoint).sort(), ['anchorHash', 'hasCompleteUserTurnHistory', 'identity', 'offset', 'path', 'schemaVersion', 'threadId', 'turn', 'users'].sort());
  assert.equal(checkpoint.hasCompleteUserTurnHistory, true);
  assert.deepEqual(Object.keys(checkpoint.turn).sort(), ['id', 'phase', 'position']);
  assert.deepEqual(checkpoint.users.map(user => Object.keys(user).sort()), [['key', 'position', 'turnId']]);
  assert.equal(checkpoint.users[0].key, 'cached-turn:original-user');
  assert.match(checkpoint.anchorHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(checkpoint).includes(secret), false);
  const fullSize = (await readFile(entry.rolloutPath)).length;
  assert.equal(checkpoint.offset, fullSize);
  await store.close();
  assert.equal((await readFile(join(f.dataDirectory, 'taskboard.sqlite'))).includes(Buffer.from(secret)), false);
  store = createTaskBoardStore(f);
  const bytesRead = await countRolloutReadBytes(entry.rolloutPath, async () => {
    const warm = onlyThread(await store.listThreads({}), id);
    assert.equal(warm.status, 'Review', 'cached unfinished work still needs fresh execution evidence after restart');
    assertMessageTurns(warm, 1);
    await entry.append(f.record('item_started', {
      thread_id: id, turn_id: 'cached-turn', item: { type: 'CommandExecution', id: 'fresh-command' },
    }));
    assert.equal(onlyThread(await store.listThreads({}), id).status, 'InProgress');
  });
  assert.ok(bytesRead > 0, 'checkpoint validity must be checked against the rollout');
  assert.ok(bytesRead < fullSize / 10, `warm restart reread ${bytesRead} of ${fullSize} historical bytes`);
  t.diagnostic(`warm restart and one appended event read ${bytesRead} bytes for a ${fullSize}-byte historical rollout`);
});

test('old checkpoints without history completeness reuse the prefix and report conservative counts', async t => {
  const f = await createFixture(t);
  const entries = [];
  for (const knownUser of [false, true]) {
    const id = `old-checkpoint-${knownUser}`;
    const prefix = Array.from({ length: 300 }, () => f.record('ignored', { text: 'historical-prefix'.repeat(64) }));
    entries.push({ ...(await f.addThread({ id, events: [
      ...(knownUser ? [f.user(id, 'confirmed')] : []), ...prefix,
    ] })), knownUser });
  }
  let store = createTaskBoardStore(f);
  t.after(() => store.close());
  const cold = await store.listThreads({});
  for (const entry of entries) assertMessageTurns(onlyThread(cold, entry.id), Number(entry.knownUser));
  await store.close();
  const writer = new DatabaseSync(join(f.dataDirectory, 'taskboard.sqlite'));
  try {
    for (const entry of entries) {
      const checkpoint = readCheckpoint(f, entry.id);
      delete checkpoint.hasCompleteUserTurnHistory;
      writer.prepare('UPDATE observation_checkpoints SET checkpoint_json = ? WHERE thread_id = ?').run(JSON.stringify(checkpoint), entry.id);
    }
  } finally { writer.close(); }
  store = createTaskBoardStore(f);
  for (const entry of entries) {
    const fullSize = (await readFile(entry.rolloutPath)).length;
    const bytesRead = await countRolloutReadBytes(entry.rolloutPath, async () => {
      assertMessageTurns(onlyThread(await store.listThreads({}), entry.id), entry.knownUser ? 1 : null, true);
    });
    assert.ok(bytesRead > 0 && bytesRead < fullSize / 10, `old cache reread ${bytesRead} of ${fullSize} bytes`);
    assert.equal(readCheckpoint(f, entry.id).hasCompleteUserTurnHistory, false);
  }
});

test('cold and cached completed threads and unchanged Done acceptances retain the same revision', async t => {
  const f = await createFixture(t);
  const id = 'stable-cached-revision-thread';
  await f.addThread({ id, events: [f.user(id, 'completed-turn', 'completed-user'),
    f.task('task_started', 'completed-turn'), f.task('task_complete', 'completed-turn'),
  ] });
  const pending = await f.addThread({ events: [f.task('task_started', 'historical-pending-turn')] });
  let store = createTaskBoardStore(f);
  t.after(() => store.close());
  const cold = await store.listThreads({});
  const coldCompleted = onlyThread(cold, id);
  const coldPending = onlyThread(cold, pending.id);
  assert.equal(coldCompleted.status, 'Review');
  assert.equal(coldPending.status, 'Review');
  readCheckpoint(f, id);
  readCheckpoint(f, pending.id);
  await store.close();
  store = createTaskBoardStore(f);
  const warm = await store.listThreads({});
  assert.equal(onlyThread(warm, id).revision, coldCompleted.revision, 'completed semantics must not depend on checkpoint object layout');
  assert.equal(onlyThread(warm, pending.id).revision, coldPending.revision, 'a still historical unfinished turn has the same state after cached restart');
  const done = (await store.acceptThread(id, coldCompleted.revision)).thread;
  assert.equal(done.status, 'Done');
  await store.close();
  store = createTaskBoardStore(f);
  const unchanged = onlyThread(await store.listThreads({}), id);
  assert.equal(unchanged.status, 'Done');
  assert.equal(unchanged.revision, done.revision, 'unchanged acceptance version must retain its revision across restart');
});

test('checkpointing never persists an unfinished message and preserves its startup historical boundary', async t => {
  const f = await createFixture(t);
  const entry = await f.addThread({ events: [f.task('task_started', 'historical-prefix-turn')] });
  let store = createTaskBoardStore(f);
  t.after(() => store.close());
  await store.listThreads({});
  const checkpointBefore = readCheckpoint(f, entry.id);
  const secret = 'synthetic-unfinished-body-private';
  const line = JSON.stringify(f.task('task_started', 'pending-turn', { message: secret.repeat(4) }));
  const split = line.indexOf(secret) + secret.length;
  await appendFile(entry.rolloutPath, line.slice(0, split));
  await store.listThreads({});
  const checkpointAfter = readCheckpoint(f, entry.id);
  assert.equal(checkpointAfter.offset, checkpointBefore.offset, 'unfinished bytes must not advance the durable cursor');
  assert.equal(JSON.stringify(checkpointAfter).includes(secret), false);
  await store.close();
  assert.equal((await readFile(join(f.dataDirectory, 'taskboard.sqlite'))).includes(Buffer.from(secret)), false);
  store = createTaskBoardStore(f);
  assert.equal(onlyThread(await store.listThreads({}), entry.id).status, 'Review');
  await appendFile(entry.rolloutPath, line.slice(split) + '\n');
  assert.equal(onlyThread(await store.listThreads({}), entry.id).status, 'Review', 'startup partial start must remain historical when completed');
  await entry.append(f.record('item_completed', {
    thread_id: entry.id, turn_id: 'pending-turn', item: { type: 'Reasoning', id: 'fresh-after-pending' },
  }));
  assert.equal(onlyThread(await store.listThreads({}), entry.id).status, 'InProgress');
});

test('cached user IDs preserve Done and invalidate it for real input appended while the store was stopped', async t => {
  const f = await createFixture(t);
  const id = 'cached-accepted-thread';
  const entry = await f.addThread({ id, events: [f.user(id, 'accepted-turn', 'accepted-user'),
    f.task('task_started', 'accepted-turn'), f.task('task_complete', 'accepted-turn'),
  ] });
  let store = createTaskBoardStore(f);
  t.after(() => store.close());
  const thread = onlyThread(await store.listThreads({}), id);
  await store.acceptThread(id, thread.revision);
  assert.equal(readCheckpoint(f, id).users.length, 1);
  await store.close();
  store = createTaskBoardStore(f);
  assert.equal(onlyThread(await store.listThreads({}), id).status, 'Done');
  await store.close();
  await entry.append(f.user(id, 'new-user-turn', 'new-user'));
  store = createTaskBoardStore(f);
  assert.equal(onlyThread(await store.listThreads({}), id).status, 'Review');
  await entry.append(f.task('task_started', 'new-user-turn'));
  assert.equal(onlyThread(await store.listThreads({}), id).status, 'InProgress');
});

for (const invalidation of ['tail-hash', 'truncation', 'replacement', 'path-change']) {
  test(`a checkpoint invalidated by ${invalidation} falls back to a complete historical baseline`, async t => {
    const f = await createFixture(t);
    const prefix = f.record('synthetic_ignored_record', { padding: 'x'.repeat(1024) });
    const entry = await f.addThread({ events: [prefix, f.task('task_started', 'cached-old-turn')] });
    let store = createTaskBoardStore(f);
    t.after(() => store.close());
    await store.listThreads({});
    readCheckpoint(f, entry.id);
    await store.close();
    const original = await readFile(entry.rolloutPath, 'utf8');
    const changed = original.replace('cached-old-turn', 'cached-new-turn');
    let currentPath = entry.rolloutPath;
    if (invalidation === 'tail-hash') {
      assert.equal(changed.length, original.length);
      await writeFile(entry.rolloutPath, changed);
    } else if (invalidation === 'truncation') {
      await writeFile(entry.rolloutPath, JSON.stringify(f.task('task_started', 'cached-new-turn')) + '\n');
    } else if (invalidation === 'replacement') {
      const replacement = `${entry.rolloutPath}.replacement`;
      await writeFile(replacement, changed);
      await rename(replacement, entry.rolloutPath);
    } else {
      currentPath = `${entry.rolloutPath}.relocated`;
      await writeFile(currentPath, changed);
      f.database.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(currentPath, entry.id);
    }
    store = createTaskBoardStore(f);
    const recovered = await store.listThreads({});
    assert.equal(onlyThread(recovered, entry.id).status, 'Review');
    assert.equal(recovered.stale, false);
    assert.equal(recovered.threads.length, 1);
    await appendFile(currentPath, JSON.stringify(f.record('item_started', {
      thread_id: entry.id, turn_id: 'cached-new-turn', item: { type: 'CommandExecution', id: 'fresh-after-cache-reset' },
    })) + '\n');
    assert.equal(onlyThread(await store.listThreads({}), entry.id).status, 'InProgress', 'the fallback must recover the new file turn rather than keep stale cached metadata');
  });
}

test('corrupt checkpoint JSON is disposable and cannot prevent reading or accepting a thread', async t => {
  const f = await createFixture(t);
  const entry = await f.addThread({ events: [f.task('task_started', 'historical-turn')] });
  let store = createTaskBoardStore(f);
  t.after(() => store.close());
  await store.listThreads({});
  readCheckpoint(f, entry.id);
  await store.close();
  const corruptor = new DatabaseSync(join(f.dataDirectory, 'taskboard.sqlite'));
  corruptor.prepare('UPDATE observation_checkpoints SET checkpoint_json = ? WHERE thread_id = ?').run('{broken-json', entry.id);
  corruptor.close();
  store = createTaskBoardStore(f);
  const snapshot = await store.listThreads({});
  const thread = onlyThread(snapshot, entry.id);
  assert.equal(thread.status, 'Review');
  assert.equal(snapshot.stale, false);
  assert.equal((await store.acceptThread(entry.id, thread.revision)).thread.status, 'Done');
});

test('cache SQL read and write failures do not block board reads or acceptance', async t => {
  const f = await setup(t);
  const existing = await f.addThread();
  await f.store.listThreads({});
  readCheckpoint(f, existing.id);
  const corruptor = new DatabaseSync(join(f.dataDirectory, 'taskboard.sqlite'));
  corruptor.exec('DROP TABLE observation_checkpoints');
  corruptor.close();
  const imported = await f.addThread({ events: [f.task('task_started', 'imported-historical-turn')] });
  const snapshot = await f.store.listThreads({});
  assert.equal(snapshot.threads.length, 2);
  assert.equal(snapshot.stale, false);
  for (const entry of [existing, imported]) {
    const thread = onlyThread(snapshot, entry.id);
    assert.equal(thread.status, 'Review');
    assert.equal((await f.store.acceptThread(entry.id, thread.revision)).thread.status, 'Done');
  }
});
