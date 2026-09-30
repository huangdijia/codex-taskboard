import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const CHUNK_SIZE = 256 * 1024;
const TERMINALS = new Set(['task_complete', 'turn_aborted', 'task_failed', 'turn_failed']);
const EXECUTION_ITEMS = new Set(['Reasoning', 'AgentMessage', 'CommandExecution', 'McpToolCall',
  'SubAgentActivity', 'FileChange', 'Plan', 'ContextCompaction']);
const CHECKPOINT_VERSION = 1;
const PHASES = new Set(['started', 'unknown', 'interrupted', 'completed', 'failed']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validCheckpoint(value, path, threadId) {
  if (!value || value.schemaVersion !== CHECKPOINT_VERSION || value.path !== path || value.threadId !== threadId
    || typeof value.identity !== 'string' || !/^\d+:\d+$/.test(value.identity)
    || !Number.isSafeInteger(value.offset) || value.offset < 0
    || typeof value.anchorHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.anchorHash)
    || !Array.isArray(value.users)) return false;
  if (value.hasCompleteUserTurnHistory !== undefined && typeof value.hasCompleteUserTurnHistory !== 'boolean') return false;
  const positionValid = (position) => Number.isSafeInteger(position) && position > 0 && position <= value.offset;
  if (value.turn !== null && (!value.turn || typeof value.turn.id !== 'string'
    || !PHASES.has(value.turn.phase) || !positionValid(value.turn.position))) return false;
  const keys = new Set();
  let previous = 0;
  for (const user of value.users) {
    if (!user || typeof user.key !== 'string' || typeof user.turnId !== 'string'
      || !user.key.startsWith(`${user.turnId}:`) || keys.has(user.key)
      || !positionValid(user.position) || user.position <= previous) return false;
    keys.add(user.key);
    previous = user.position;
  }
  return true;
}

export class RolloutObserver {
  constructor(path, threadId, { observeInitialEvents = false, checkpoint = null } = {}) {
    this.path = path;
    this.threadId = threadId;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.identity = null;
    this.anchor = Buffer.alloc(0);
    this.turn = null;
    this.users = [];
    this.hasCompleteUserTurnHistory = true;
    this.userKeys = new Set();
    this.latestUser = null;
    this.error = null;
    this.initialized = false;
    this.rebaseline = false;
    this.epoch = 0;
    this.historicalEnd = 0;
    this.observeInitialEvents = observeInitialEvents;
    this.savedCheckpoint = checkpoint;
  }

  checkpoint() {
    if (!this.initialized || this.error || this.rebaseline || this.pending.length) return null;
    return { schemaVersion: CHECKPOINT_VERSION, threadId: this.threadId, path: this.path,
      identity: this.identity, offset: this.offset, anchorHash: hash(this.anchor),
      turn: this.turn ? { id: this.turn.id, phase: this.turn.phase, position: this.turn.position } : null,
      hasCompleteUserTurnHistory: this.hasCompleteUserTurnHistory,
      users: this.users.map(({ key, turnId, position }) => ({ key, turnId, position })) };
  }

  async restoreCheckpoint(file, info) {
    const checkpoint = this.savedCheckpoint;
    this.savedCheckpoint = null;
    if (!validCheckpoint(checkpoint, this.path, this.threadId)
      || checkpoint.identity !== `${info.dev}:${info.ino}` || info.size < checkpoint.offset) return false;
    const anchor = Buffer.alloc(Math.min(64, checkpoint.offset));
    const { bytesRead } = await file.read(anchor, 0, anchor.length, checkpoint.offset - anchor.length);
    if (bytesRead !== anchor.length || hash(anchor) !== checkpoint.anchorHash
      || (anchor.length && anchor.at(-1) !== 10)) return false;
    this.reset(checkpoint.identity);
    this.offset = checkpoint.offset;
    this.anchor = anchor;
    this.turn = checkpoint.turn ? { id: checkpoint.turn.id, phase: checkpoint.turn.phase,
      position: checkpoint.turn.position, observed: false } : null;
    this.users = checkpoint.users.map(({ key, turnId, position }) => ({ key, turnId, position, observed: false }));
    // Old caches cannot establish whether their skipped prefix had legacy user events.
    this.hasCompleteUserTurnHistory = checkpoint.hasCompleteUserTurnHistory === true;
    this.userKeys = new Set(this.users.map((user) => user.key));
    this.latestUser = this.users.at(-1) || null;
    return true;
  }

  reset(identity) {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.anchor = Buffer.alloc(0);
    this.identity = identity;
    this.turn = null;
    this.users = [];
    this.hasCompleteUserTurnHistory = true;
    this.userKeys = new Set();
    this.latestUser = null;
    this.epoch++;
  }

  consume(record, historical, position) {
    if (!record.payload || typeof record.payload !== 'object') return;
    const event = record.payload;
    if (event.thread_id && this.threadId && event.thread_id !== this.threadId) return;
    // Legacy user messages lack the modern turn binding needed for an exact count.
    if ((record.type === 'event_msg' && event.type === 'user_message')
      || (record.type === 'response_item' && event.type === 'message' && event.role === 'user')) {
      this.hasCompleteUserTurnHistory = false;
    }
    if (record.type !== 'event_msg') return;
    const turnId = event.turn_id;
    if (event.type === 'item_completed' && event.item?.type === 'UserMessage'
      && (typeof turnId !== 'string' || !turnId.trim() || typeof event.item.id !== 'string' || !event.item.id.trim())) {
      this.hasCompleteUserTurnHistory = false;
    }
    if (event.type === 'task_started' && typeof turnId === 'string') {
      if (this.turn?.id !== turnId) this.turn = { id: turnId, observed: !historical, phase: 'started', position };
    } else if (TERMINALS.has(event.type) && typeof turnId === 'string') {
      if (!this.turn) this.turn = { id: turnId, observed: false, phase: 'unknown', position };
      if (this.turn.id === turnId) {
        this.turn.phase = event.type === 'turn_aborted' ? 'interrupted'
          : event.type === 'task_complete' && !event.error ? 'completed' : 'failed';
      }
    } else if (event.type === 'item_completed' && event.item?.type === 'UserMessage'
      && typeof turnId === 'string' && turnId.trim() && typeof event.item.id === 'string' && event.item.id.trim()) {
      const key = `${turnId}:${event.item.id}`;
      if (this.userKeys.has(key)) return;
      this.userKeys.add(key);
      const user = { key, turnId, position, observed: !historical };
      this.users.push(user);
      this.latestUser = user;
    } else if ((event.type === 'item_started' || event.type === 'item_completed')
      && EXECUTION_ITEMS.has(event.item?.type) && !historical
      && this.turn?.phase === 'started' && turnId === this.turn.id) {
      // A startup turn needs new execution evidence before it can leave Review.
      // User input and unbound token counters do not prove execution is advancing.
      if (!this.turn.observed) this.turn.observedByActivity = true;
      this.turn.observed = true;
    }
  }

  async scan() {
    let file;
    try {
      const info = await stat(this.path);
      if (!info.isFile()) throw new Error('NOT_FILE');
      file = await open(this.path, 'r');
      const openedInfo = await file.stat();
      const identity = `${openedInfo.dev}:${openedInfo.ino}`;
      // Restored metadata only skips parsing. The startup boundary still makes all
      // already-present events historical, including events appended while offline.
      const restored = !this.initialized && !this.rebaseline && !this.observeInitialEvents
        && this.savedCheckpoint && await this.restoreCheckpoint(file, openedInfo);
      let changed = this.identity !== null && this.identity !== identity;
      if (!changed && this.offset > 0 && openedInfo.size >= this.offset && this.anchor.length) {
        const check = Buffer.alloc(this.anchor.length);
        const result = await file.read(check, 0, check.length, this.offset - check.length);
        changed = result.bytesRead !== check.length || !check.equals(this.anchor);
      }
      const baseline = !this.initialized || this.rebaseline || changed || openedInfo.size < this.offset;
      if (baseline && (!restored || changed || openedInfo.size < this.offset)) this.reset(identity);
      if (baseline) this.historicalEnd = !this.initialized && !this.rebaseline && this.observeInitialEvents ? 0 : openedInfo.size;
      const historicalEnd = this.historicalEnd;
      // Capture the startup boundary before scanning, then consume later appends as observed events.
      await this.readTo(file, openedInfo.size, historicalEnd);
      const current = await file.stat();
      if (current.size < this.offset) throw new Error('FILE_CHANGED');
      if (current.size > this.offset) await this.readTo(file, current.size, historicalEnd);
      const anchorSize = Math.min(64, this.offset);
      this.anchor = Buffer.alloc(anchorSize);
      if (anchorSize) {
        const { bytesRead } = await file.read(this.anchor, 0, anchorSize, this.offset - anchorSize);
        if (bytesRead !== anchorSize) throw new Error('FILE_CHANGED');
      }
      const pathInfo = await stat(this.path);
      if (`${pathInfo.dev}:${pathInfo.ino}` !== identity || pathInfo.size < this.offset) throw new Error('FILE_CHANGED');
      this.initialized = true;
      this.rebaseline = false;
      this.error = null;
    } catch (error) {
      this.error = { code: error.code === 'ENOENT' ? 'ROLLOUT_MISSING'
        : error.message === 'INVALID_JSON' ? 'ROLLOUT_FORMAT_ERROR' : 'ROLLOUT_READ_ERROR',
      message: error.message === 'INVALID_JSON' ? '会话记录格式异常，需重新读取' : '无法读取会话记录，显示上次读取结果' };
      this.rebaseline = true;
      if (this.turn?.phase === 'started') this.turn.observed = false;
    } finally {
      await file?.close();
    }
    return this;
  }

  async readTo(file, end, historicalEnd) {
    while (this.offset < end) {
      const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, end - this.offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
      if (!bytesRead) throw new Error('FILE_CHANGED');
      const base = this.offset - this.pending.length;
      this.offset += bytesRead;
      const data = Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]);
      let cursor = 0;
      let newline;
      while ((newline = data.indexOf(10, cursor)) !== -1) {
        const line = data.subarray(cursor, newline).toString('utf8').trim();
        const position = base + newline + 1;
        if (line) {
          let record;
          try { record = JSON.parse(line); } catch { throw new Error('INVALID_JSON'); }
          this.consume(record, historicalEnd >= 0 && base + cursor < historicalEnd, position);
        }
        cursor = newline + 1;
      }
      // Only the unfinished line stays in memory; message contents never enter the private database.
      this.pending = Buffer.from(data.subarray(cursor));
    }
  }

  execution() {
    if (this.error) return { status: 'Review', reason: '状态待确认 · 会话读取失败' };
    if (this.latestUser && (!this.turn || (this.latestUser.position > this.turn.position && this.latestUser.turnId !== this.turn.id))) {
      return { status: 'Review', reason: '状态待确认 · 新用户回合尚无开始记录' };
    }
    if (this.turn?.phase === 'started' && this.turn.observed) return { status: 'InProgress',
      reason: this.turn.observedByActivity ? '已观察到本轮新的执行记录，尚未收到结束记录'
        : '已观察到本轮开始，尚未收到结束记录' };
    const reasons = { completed: '本轮已结束，等待验收', interrupted: '本轮已中断，等待处理', failed: '本轮失败，等待处理' };
    return { status: 'Review', reason: reasons[this.turn?.phase] || '状态待确认 · 缺少完整执行记录' };
  }
}
