import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function connect(dataDirectory, cwd = process.cwd()) {
  const client = new Client({ name: "taskboard-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [process.env.TASKBOARD_SERVER_PATH || join(process.cwd(), "plugins/codex-taskboard/dist/server.mjs")],
    cwd,
    env: { ...process.env, PLUGIN_DATA: dataDirectory },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

test("MCP task flow persists data and rejects stale writes", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "taskboard-test-"));
  let connection;
  try {
    connection = await connect(dataDirectory);
    const tools = (await connection.client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    assert.deepEqual(names, ["taskboard.open", "list_boards", "create_board", "list_tasks", "get_task", "create_task", "update_task"]);
    const entrypoint = tools[0];
    assert.equal(entrypoint._meta.ui.resourceUri, "ui://taskboard/board.html");
    assert.deepEqual(entrypoint._meta["openai/ui"].entrypoints, [{ type: "global" }]);
    assert.match(connection.client.getServerVersion().icons[0].src, /^data:image\/svg\+xml,/);
    const opened = await call(connection.client, "taskboard.open");
    assert.deepEqual(opened.structuredContent.boards, []);
    assert.deepEqual(opened.structuredContent.tasks, []);
    assert.equal(opened.structuredContent.total, 0);
    const resource = await connection.client.readResource({ uri: "ui://taskboard/board.html" });
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(resource.contents[0].text, /TaskBoard/);
    assert.match(resource.contents[0].text, /ui\/initialize/);

    const boardResult = await call(connection.client, "create_board", { name: "Release plan" });
    assert.equal(boardResult.isError, undefined);
    const board = boardResult.structuredContent.board;

    const created = await call(connection.client, "create_task", {
      board_id: board.id, title: "Ship plugin", priority: "high", due_date: "2026-10-15",
    });
    assert.equal(created.isError, undefined);
    const task = created.structuredContent.task;
    assert.equal(task.status, "todo");
    assert.equal(task.version, 1);
    const otherBoard = (await call(connection.client, "create_board", { name: "Operations" })).structuredContent.board;
    const otherTask = (await call(connection.client, "create_task", {
      board_id: otherBoard.id, title: "Review access", status: "in_review",
    })).structuredContent.task;
    const reopened = await call(connection.client, "taskboard.open");
    assert.equal(reopened.structuredContent.boards.length, 2);
    assert.equal(reopened.structuredContent.total, 2);
    assert.equal(reopened.structuredContent.boards[0].taskCount, 1);
    assert.deepEqual(new Set(reopened.structuredContent.tasks.map((item) => item.boardId)), new Set([board.id, otherBoard.id]));
    const allTasks = await call(connection.client, "list_tasks", {});
    assert.equal(allTasks.structuredContent.tasks.length, 2);
    assert.equal(allTasks.structuredContent.total, 2);
    const firstPage = await call(connection.client, "list_tasks", { limit: 1 });
    const secondPage = await call(connection.client, "list_tasks", { limit: 1, offset: 1 });
    assert.equal(firstPage.structuredContent.hasMore, true);
    assert.equal(secondPage.structuredContent.hasMore, false);
    assert.notEqual(firstPage.structuredContent.tasks[0].id, secondPage.structuredContent.tasks[0].id);
    const filtered = await call(connection.client, "list_tasks", { board_id: otherBoard.id });
    assert.deepEqual(filtered.structuredContent.tasks.map((item) => item.id), [otherTask.id]);
    assert.equal(filtered.structuredContent.total, 1);
    const byStatus = await call(connection.client, "list_tasks", { status: "in_review" });
    assert.deepEqual(byStatus.structuredContent.tasks.map((item) => item.id), [otherTask.id]);

    const listed = await call(connection.client, "list_tasks", { board_id: board.id });
    assert.equal(listed.structuredContent.tasks[0].id, task.id);
    assert.equal(listed.structuredContent.tasks[0].description, undefined);

    const updated = await call(connection.client, "update_task", {
      task_id: task.id, expected_version: task.version,
      status: "in_progress", description: "Run the release checks",
    });
    assert.equal(updated.structuredContent.task.status, "in_progress");
    assert.equal(updated.structuredContent.task.version, 2);

    const conflict = await call(connection.client, "update_task", {
      task_id: task.id, expected_version: 1, status: "done",
    });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /VERSION_CONFLICT/);

    const invalidDate = await call(connection.client, "create_task", {
      board_id: board.id, title: "Invalid date", due_date: "2026-02-30",
    });
    assert.equal(invalidDate.isError, true);

    await connection.client.close();
    connection = await connect(dataDirectory, tmpdir());
    const saved = await call(connection.client, "get_task", { task_id: task.id });
    assert.equal(saved.structuredContent.task.description, "Run the release checks");
    assert.equal(saved.structuredContent.task.version, 2);
    const persistedGlobal = await call(connection.client, "taskboard.open");
    assert.equal(persistedGlobal.structuredContent.total, 2);
    assert.deepEqual(new Set(persistedGlobal.structuredContent.tasks.map((item) => item.boardId)), new Set([board.id, otherBoard.id]));
    const persistedFilter = await call(connection.client, "list_tasks", { board_id: otherBoard.id });
    assert.deepEqual(persistedFilter.structuredContent.tasks.map((item) => item.id), [otherTask.id]);
  } finally {
    if (connection) await connection.client.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
