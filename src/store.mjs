import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { RolloutObserver } from './rollout.mjs';

export class TaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

function sourceOf(row) {
  let source;
  try { source = JSON.parse(row.source || 'null'); } catch { source = null; }
  const isSubagent = row.thread_source === 'subagent' || Boolean(source?.subagent);
  const sourceType = row.thread_source || (isSubagent ? 'subagent' : 'legacy');
  return { isSubagent, sourceType, isPrimary: !isSubagent && ['user', 'agent_created_thread', 'legacy'].includes(sourceType) };
}

function displayName(row) {
  return (typeof row.name === 'string' && row.name.trim()) || row.title || '未命名线程';
}

export function createTaskBoardStore({ nativeDbPath, dataDirectory, projectStatePath = nativeDbPath && join(dirname(nativeDbPath), '.codex-global-state.json') }) {
  if (!dataDirectory) throw new TaskError('DATA_DIR_REQUIRED', '需要 PLUGIN_DATA 或 TASKBOARD_DATA_DIR');
  if (!nativeDbPath) throw new TaskError('NATIVE_DB_REQUIRED', '需要原生线程数据库路径');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const privateDb = new DatabaseSync(join(dataDirectory, 'taskboard.sqlite'));
  privateDb.exec('PRAGMA busy_timeout = 1000;');
  const version = privateDb.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { privateDb.close(); throw new TaskError('UNSUPPORTED_SCHEMA', '验收数据库版本不受支持'); }
  privateDb.exec(`CREATE TABLE IF NOT EXISTS acceptances (
    thread_id TEXT PRIMARY KEY, accepted INTEGER NOT NULL DEFAULT 0,
    user_key TEXT, file_identity TEXT, cursor INTEGER NOT NULL DEFAULT 0,
    accepted_at TEXT, version INTEGER NOT NULL DEFAULT 1
  ); PRAGMA user_version = 1;`);
  const readAcceptance = privateDb.prepare('SELECT * FROM acceptances WHERE thread_id = ?');
  const invalidateAcceptance = privateDb.prepare('UPDATE acceptances SET accepted = 0, version = version + 1 WHERE thread_id = ? AND accepted = 1 AND version = ?');
  const saveAcceptance = privateDb.prepare(`INSERT INTO acceptances(thread_id,accepted,user_key,file_identity,cursor,accepted_at,version)
    VALUES(?,1,?,?,?,?,1) ON CONFLICT(thread_id) DO UPDATE SET accepted=1,user_key=excluded.user_key,
    file_identity=excluded.file_identity,cursor=excluded.cursor,accepted_at=excluded.accepted_at,version=version+1`);
  // This disposable cache has its own version; acceptance schema and failures retain
  // their existing contract. Cache failures must never disable the board.
  let checkpointQueries;
  try {
    privateDb.exec(`CREATE TABLE IF NOT EXISTS observation_checkpoints (
      thread_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, checkpoint_json TEXT NOT NULL
    )`);
    checkpointQueries = {
      read: privateDb.prepare('SELECT schema_version, checkpoint_json FROM observation_checkpoints WHERE thread_id = ?'),
      write: privateDb.prepare(`INSERT INTO observation_checkpoints(thread_id,schema_version,checkpoint_json)
        VALUES(?,1,?) ON CONFLICT(thread_id) DO UPDATE SET
        schema_version=excluded.schema_version,checkpoint_json=excluded.checkpoint_json`),
      remove: privateDb.prepare('DELETE FROM observation_checkpoints WHERE thread_id = ?'),
    };
  } catch { checkpointQueries = null; }
  const checkpointStamps = new WeakMap();
  let nativeDb;
  let nativeIdentity;
  let selectRows;
  let rows = null;
  let lastSuccessfulReadAt = null;
  let chain = Promise.resolve();
  let closed = false;
  const observedSince = Math.floor(Date.now() / 1000) * 1000;
  let catalogInitialized = false;
  let observationInterrupted = false;
  const observers = new Map();
  const cards = new Map();
  let projectStateStamp;
  let projectNames = new Map();

  function workspaceOptions(cwds) {
    try {
      const info = statSync(projectStatePath);
      const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (stamp !== projectStateStamp) {
        const projects = JSON.parse(readFileSync(projectStatePath, 'utf8'))['local-projects'];
        const names = new Map();
        if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
          for (const project of Object.values(projects)) {
            if (typeof project?.name !== 'string' || !project.name.trim() || !Array.isArray(project.rootPaths)) continue;
            for (const root of project.rootPaths) {
              if (typeof root !== 'string' || !root) continue;
              if (!names.has(root)) names.set(root, new Set());
              names.get(root).add(project.name.trim());
            }
          }
        }
        // Exact roots supply display labels only; ambiguous roots keep their folder name.
        projectNames = new Map([...names].filter(([, values]) => values.size === 1).map(([root, values]) => [root, [...values][0]]));
        projectStateStamp = stamp;
      }
    } catch {
      // Optional project metadata must not turn an otherwise readable board into an error.
      projectNames = new Map();
      projectStateStamp = undefined;
    }
    const options = [...new Set(cwds)].sort().map((cwd) => ({ cwd, name: projectNames.get(cwd) || basename(cwd) || cwd || '无项目' }));
    const groups = new Map();
    for (const option of options) {
      if (!groups.has(option.name)) groups.set(option.name, []);
      groups.get(option.name).push(option);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const parents = group.map(({ cwd }) => dirname(cwd).split('/').filter(Boolean));
      const limit = Math.max(...parents.map((parts) => parts.length));
      let suffixes;
      for (let depth = 1; depth <= limit; depth++) {
        suffixes = parents.map((parts) => parts.slice(-depth).join('/') || '/');
        if (new Set(suffixes).size === group.length) break;
      }
      if (!suffixes || new Set(suffixes).size !== group.length) suffixes = group.map(({ cwd }) => cwd);
      group.forEach((option, index) => { option.name += ` · ${suffixes[index]}`; });
    }
    return options;
  }

  function loadCheckpoint(threadId) {
    try {
      const row = checkpointQueries?.read.get(threadId);
      return row?.schema_version === 1 ? JSON.parse(row.checkpoint_json) : null;
    } catch { return null; }
  }

  function saveCheckpoints(candidates) {
    if (!checkpointQueries) return;
    const updates = [];
    for (const observer of candidates) {
      const stamp = `${observer.identity}:${observer.offset}:${observer.epoch}`;
      if (observer.error) {
        updates.push({ observer, remove: true });
      } else if (checkpointStamps.get(observer) !== stamp) {
        const checkpoint = observer.checkpoint();
        if (checkpoint) updates.push({ observer, stamp, json: JSON.stringify(checkpoint) });
      }
    }
    if (!updates.length) return;
    let transaction = false;
    try {
      // Batch startup writes instead of fsync-ing once for each thread. Each row is
      // self-contained, so concurrent older checkpoints only reduce cache efficiency.
      privateDb.exec('BEGIN IMMEDIATE');
      transaction = true;
      for (const update of updates) {
        if (update.remove) checkpointQueries.remove.run(update.observer.threadId);
        else checkpointQueries.write.run(update.observer.threadId, update.json);
      }
      privateDb.exec('COMMIT');
      transaction = false;
      for (const update of updates) {
        if (update.remove) checkpointStamps.delete(update.observer);
        else checkpointStamps.set(update.observer, update.stamp);
      }
    } catch {
      if (transaction) {
        try { privateDb.exec('ROLLBACK'); } catch { /* Cache is best-effort. */ }
      }
    }
  }

  function readRows() {
    try {
      const info = statSync(nativeDbPath);
      const identity = `${info.dev}:${info.ino}`;
      if (nativeDb && nativeIdentity !== identity) {
        nativeDb.close(); nativeDb = null; selectRows = null;
      }
      if (!nativeDb) {
        nativeDb = new DatabaseSync(nativeDbPath, { readOnly: true });
        nativeDb.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
        const columns = new Set(nativeDb.prepare('PRAGMA table_info(threads)').all().map((column) => column.name));
        if (!['id', 'rollout_path', 'title', 'cwd', 'updated_at', 'archived'].every((name) => columns.has(name))) {
          throw new Error('UNSUPPORTED_NATIVE_SCHEMA');
        }
        const optional = ['name', 'updated_at_ms', 'created_at', 'created_at_ms', 'thread_source', 'source'].map((name) => columns.has(name) ? name : `NULL AS ${name}`);
        selectRows = nativeDb.prepare(`SELECT id,rollout_path,title,cwd,updated_at,archived,${optional.join(',')} FROM threads`);
        nativeIdentity = identity;
      }
      return selectRows.all();
    } catch {
      nativeDb?.close(); nativeDb = null; selectRows = null;
      throw new TaskError('NATIVE_DB_ERROR', '无法读取原生线程数据库，请检查路径、访问权限和数据库格式');
    }
  }

  function serialize(action) {
    const result = chain.then(() => {
      if (closed) throw new TaskError('STORE_CLOSED', '看板已关闭');
      return action();
    });
    chain = result.catch(() => {});
    return result;
  }

  function acceptanceState(id, observer, retries = 0) {
    let acceptance = readAcceptance.get(id);
    if (!acceptance?.accepted) return { acceptance, valid: false, unconfirmed: false };
    if (observer.error) return { acceptance, valid: true, unconfirmed: false };
    let newInput = false;
    let unconfirmed = false;
    if (acceptance.user_key) {
      const acceptedIndex = observer.users.findIndex((user) => user.key === acceptance.user_key);
      newInput = acceptedIndex >= 0 && acceptedIndex < observer.users.length - 1;
      if (acceptedIndex < 0) {
        newInput = Boolean(observer.latestUser?.observed);
        unconfirmed = !newInput;
      }
    } else {
      newInput = Boolean(observer.latestUser && (observer.latestUser.observed
        || (observer.identity === acceptance.file_identity && observer.latestUser.position > acceptance.cursor)));
      unconfirmed = !newInput && (observer.identity !== acceptance.file_identity || observer.offset < acceptance.cursor);
    }
    if (newInput) {
      const result = invalidateAcceptance.run(id, acceptance.version);
      if (!result.changes) {
        if (retries >= 3) throw new TaskError('PRIVATE_DB_BUSY', '验收记录正在变化，请刷新后操作');
        return acceptanceState(id, observer, retries + 1);
      }
      acceptance = readAcceptance.get(id);
    }
    return { acceptance, valid: Boolean(acceptance?.accepted) && !unconfirmed, unconfirmed };
  }

  function cardFor(row, observer, nativeStale = false) {
    const source = sourceOf(row);
    const { acceptance, valid, unconfirmed } = acceptanceState(row.id, observer);
    const execution = observer.execution();
    const stale = nativeStale || Boolean(observer.error);
    const status = valid ? 'Done' : nativeStale || unconfirmed ? 'Review' : execution.status;
    const reason = valid ? '已人工验收' : nativeStale ? '状态待确认 · 原生数据库读取失败'
      : unconfirmed ? '状态待确认 · 验收对应的用户记录需复核' : execution.reason;
    const metadata = { id: row.id, title: displayName(row), cwd: row.cwd || '',
      updatedAt: Number(row.updated_at_ms || Number(row.updated_at) * 1000),
      archived: Boolean(row.archived), isSubagent: source.isSubagent, sourceType: source.sourceType };
    const knownUserTurns = new Set(observer.users.filter((user) => user.turnId.trim()
      && user.key.slice(user.turnId.length + 1).trim()).map((user) => user.turnId)).size;
    const messageTurnCount = stale || (!observer.hasCompleteUserTurnHistory && !knownUserTurns) ? null : knownUserTurns;
    const messageTurnCountIncomplete = stale || !observer.hasCompleteUserTurnHistory || Boolean(observer.pending.length);
    const turnRevision = observer.turn ? [observer.turn.id, observer.turn.phase, observer.turn.position,
      observer.turn.phase === 'started' && observer.turn.observed] : null;
    const revision = createHash('sha256').update(JSON.stringify([metadata, status, reason, stale,
      observer.latestUser?.key, turnRevision, observer.identity, observer.epoch, acceptance?.version || 0,
      messageTurnCount, observer.hasCompleteUserTurnHistory])).digest('hex').slice(0, 24);
    // An unfinished line only changes display coverage; mutations already reject it as LOG_NOT_READY.
    const card = { ...metadata, status, reason, revision, stale, messageTurnCount, messageTurnCountIncomplete };
    cards.set(row.id, card);
    return card;
  }

  async function refresh(filters = {}) {
    const errors = [];
    let nativeStale = false;
    try { rows = readRows(); }
    catch (error) {
      if (rows === null) throw error;
      errors.push({ code: error.code, message: error.message });
      nativeStale = true;
      observationInterrupted = true;
      for (const observer of observers.values()) {
        observer.rebaseline = true;
        if (observer.turn?.phase === 'started') observer.turn.observed = false;
      }
    }
    // Filters affect presentation only. Establish and advance observation for every
    // thread the board can display, including hidden workspaces and archived cards.
    const observable = rows.filter((row) => {
      const source = sourceOf(row);
      return source.isPrimary || source.isSubagent;
    });
    for (const row of observable) {
      let observer = observers.get(row.id);
      if (!observer || observer.path !== row.rollout_path) {
        // Creation time bounds when a newly discovered thread entered observation;
        // it never determines execution state, which still comes from ordered events.
        const createdAt = Number(row.created_at_ms || Number(row.created_at) * 1000);
        const observeInitialEvents = !observer && catalogInitialized && !observationInterrupted && !nativeStale
          && createdAt >= observedSince;
        observer = new RolloutObserver(row.rollout_path, row.id, { observeInitialEvents,
          checkpoint: observeInitialEvents ? null : loadCheckpoint(row.id) });
        observers.set(row.id, observer);
      }
      if (!nativeStale) await observer.scan();
    }
    if (!nativeStale) {
      catalogInitialized = true;
      observationInterrupted = false;
      saveCheckpoints(observers.values());
    }
    const eligible = rows.filter((row) => {
      const source = sourceOf(row);
      return source.isPrimary || (filters.showSubagents && source.isSubagent);
    });
    const workspaces = workspaceOptions(eligible.map((row) => row.cwd || ''));
    const query = (filters.query || '').trim().toLocaleLowerCase();
    const selected = eligible.filter((row) => (filters.showArchived || !row.archived)
      && (!filters.cwd || row.cwd === filters.cwd) && (!query || displayName(row).toLocaleLowerCase().includes(query)));
    const threads = [];
    for (const row of selected) {
      const observer = observers.get(row.id);
      if (observer.error) errors.push({ ...observer.error, threadId: row.id });
      threads.push(cardFor(row, observer, nativeStale));
    }
    threads.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const counts = { InProgress: 0, Review: 0, Done: 0 };
    for (const thread of threads) counts[thread.status]++;
    const stale = nativeStale || errors.length > 0;
    if (!stale) lastSuccessfulReadAt = new Date().toISOString();
    return { threads, counts, workspaces, stale, lastSuccessfulReadAt, errors };
  }

  async function mutate(threadId, expectedRevision, accepted) {
    const previous = cards.get(threadId);
    if (!previous) throw new TaskError('THREAD_NOT_FOUND', '请先刷新并读取该线程');
    const currentRows = readRows();
    const row = currentRows.find((candidate) => candidate.id === threadId);
    if (!row) throw new TaskError('THREAD_NOT_FOUND', '原生线程已不存在，请刷新');
    const observer = observers.get(threadId);
    if (!observer || observer.path !== row.rollout_path) throw new TaskError('VERSION_CONFLICT', '会话记录已变化，请刷新后操作');
    await observer.scan();
    saveCheckpoints([observer]);
    // Revision comparison and acceptance updates share a write lock across MCP processes.
    privateDb.exec('BEGIN IMMEDIATE');
    try {
      const current = cardFor(row, observer);
      if (current.stale) throw new TaskError('STATE_UNAVAILABLE', '当前记录读取失败，请刷新后操作');
      if (current.revision !== expectedRevision) throw new TaskError('VERSION_CONFLICT', '线程状态已变化，请刷新后操作');
      if (observer.pending.length) throw new TaskError('LOG_NOT_READY', '会话记录正在写入，请刷新后操作');
      if (accepted) {
        if (current.status !== 'Review') throw new TaskError('INVALID_STATUS', '仅 Review 线程可以验收');
        saveAcceptance.run(threadId, observer.latestUser?.key || null, observer.identity,
          observer.offset, new Date().toISOString());
      } else {
        if (current.status !== 'Done') throw new TaskError('INVALID_STATUS', '仅 Done 线程可以重新打开');
        invalidateAcceptance.run(threadId, readAcceptance.get(threadId).version);
      }
      privateDb.exec('COMMIT');
    } catch (error) {
      privateDb.exec('ROLLBACK');
      throw error;
    }
    return { thread: cardFor(row, observer) };
  }

  return {
    listThreads: (filters = {}) => serialize(() => refresh(filters)),
    acceptThread: (threadId, expectedRevision) => serialize(() => mutate(threadId, expectedRevision, true)),
    reopenThread: (threadId, expectedRevision) => serialize(() => mutate(threadId, expectedRevision, false)),
    close: async () => { await chain; closed = true; nativeDb?.close(); privateDb.close(); },
  };
}
