import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'taskboard-test-'));
  const nativeDbPath = join(directory, 'state_5.sqlite');
  const dataDirectory = join(directory, 'scratch');
  await mkdir(dataDirectory);
  const database = new DatabaseSync(nativeDbPath);
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL, created_at_ms INTEGER, updated_at INTEGER NOT NULL, updated_at_ms INTEGER,
    thread_source TEXT,
    source TEXT NOT NULL, model_provider TEXT NOT NULL DEFAULT 'openai',
    cwd TEXT NOT NULL, title TEXT NOT NULL, name TEXT,
    sandbox_policy TEXT NOT NULL DEFAULT '{}', approval_mode TEXT NOT NULL DEFAULT 'never',
    tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER,
    cli_version TEXT NOT NULL DEFAULT 'test', first_user_message TEXT NOT NULL DEFAULT ''
  )`);
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const record = (type, payload = {}) => ({
    timestamp: new Date(Date.UTC(2026, 8, 30, 0, 0, ++sequence)).toISOString(),
    type: 'event_msg', payload: { type, ...payload },
  });
  const task = (type, turnId, payload = {}) => record(type, { turn_id: turnId, ...payload });
  const user = (threadId, turnId, itemId = `item-${++sequence}`) => record('item_completed', {
    thread_id: threadId, turn_id: turnId, item: { type: 'UserMessage', id: itemId },
  });
  const addThread = async ({ id = `thread-${++sequence}`, title = id, name = null, cwd = '/workspace/alpha',
    source = 'cli', threadSource = 'user', archived = false, updatedAt = 1790726400,
    createdAt = updatedAt - 60, createdAtMs = null, events = [], hasUserEvent = true } = {}) => {
    const rolloutPath = join(directory, `${id}.jsonl`);
    await writeFile(rolloutPath, events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
    database.prepare(`INSERT INTO threads
      (id, rollout_path, created_at, created_at_ms, updated_at, thread_source, source, cwd, title, name, archived, has_user_event)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, rolloutPath, createdAt, createdAtMs, updatedAt, threadSource, source, cwd, title, name, Number(archived), Number(hasUserEvent));
    return { id, rolloutPath, append: async (...events) => appendFile(rolloutPath, events.map(event => JSON.stringify(event)).join('\n') + '\n') };
  };
  return { directory, nativeDbPath, dataDirectory, database, record, task, user, addThread };
}

export function onlyThread(snapshot, id) {
  const thread = snapshot.threads.find(thread => thread.id === id);
  if (!thread) throw new Error(`Missing thread ${id} in ${JSON.stringify(snapshot)}`);
  return thread;
}
