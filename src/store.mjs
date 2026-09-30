import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"];
export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"];

export class TaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}

function mapBoard(row) {
  return {
    id: row.id,
    name: row.name,
    taskCount: row.task_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row) {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTaskStore(dataDirectory) {
  if (!dataDirectory) {
    throw new TaskError("DATA_DIR_REQUIRED", "PLUGIN_DATA or TASKBOARD_DATA_DIR is required");
  }
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDirectory, "taskboard.sqlite"));
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  const schemaVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (schemaVersion > 1) {
    db.close();
    throw new TaskError("UNSUPPORTED_SCHEMA", `Database schema ${schemaVersion} is newer than this plugin`);
  }
  if (schemaVersion === 0) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done')),
        priority TEXT NOT NULL CHECK (priority IN ('none','low','medium','high','urgent')),
        due_date TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_by_board ON tasks(board_id, status, updated_at);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  const readBoard = db.prepare(`
    SELECT b.*, COUNT(t.id) AS task_count
    FROM boards b LEFT JOIN tasks t ON t.board_id = b.id
    WHERE b.id = ? GROUP BY b.id
  `);
  const readTask = db.prepare("SELECT * FROM tasks WHERE id = ?");

  function getBoard(id) {
    const row = readBoard.get(id);
    if (!row) throw new TaskError("BOARD_NOT_FOUND", `Board ${id} was not found`);
    return mapBoard(row);
  }

  function getTask(id) {
    const row = readTask.get(id);
    if (!row) throw new TaskError("TASK_NOT_FOUND", `Task ${id} was not found`);
    return mapTask(row);
  }

  return {
    close: () => db.close(),
    listBoards() {
      return db.prepare(`
        SELECT b.*, COUNT(t.id) AS task_count
        FROM boards b LEFT JOIN tasks t ON t.board_id = b.id
        GROUP BY b.id ORDER BY b.created_at, b.id
      `).all().map(mapBoard);
    },
    getBoard,
    createBoard(name) {
      const now = new Date().toISOString();
      const id = `board_${randomUUID()}`;
      db.prepare("INSERT INTO boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(id, name.trim(), now, now);
      return getBoard(id);
    },
    listTasks(boardId, { status, limit = 50, offset = 0 } = {}) {
      if (boardId) getBoard(boardId);
      const conditions = [];
      const params = [];
      if (boardId) { conditions.push("board_id = ?"); params.push(boardId); }
      if (status) { conditions.push("status = ?"); params.push(status); }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const total = db.prepare(`SELECT COUNT(*) AS count FROM tasks ${where}`).get(...params).count;
      const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
        .all(...params, limit + 1, offset);
      return { tasks: rows.slice(0, limit).map(mapTask), hasMore: rows.length > limit, offset, total };
    },
    getTask,
    createTask({ boardId, title, description = "", status = "todo", priority = "none", dueDate = null }) {
      getBoard(boardId);
      const now = new Date().toISOString();
      const id = `task_${randomUUID()}`;
      db.prepare(`
        INSERT INTO tasks (id, board_id, title, description, status, priority, due_date, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, boardId, title.trim(), description, status, priority, dueDate, now, now);
      return getTask(id);
    },
    updateTask(id, expectedVersion, changes) {
      if (!Object.keys(changes).length) {
        throw new TaskError("EMPTY_UPDATE", "Provide at least one field to update");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = getTask(id);
        if (current.version !== expectedVersion) {
          throw new TaskError("VERSION_CONFLICT", `Task version is ${current.version}; read it again before updating`);
        }
        const next = { ...current, ...changes };
        if (next.description === null) next.description = "";
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, due_date = ?,
            version = version + 1, updated_at = ? WHERE id = ? AND version = ?
        `).run(next.title.trim(), next.description, next.status, next.priority, next.dueDate, now, id, expectedVersion);
        db.exec("COMMIT");
        return getTask(id);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
