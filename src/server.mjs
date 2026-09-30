import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createTaskStore, TaskError, TASK_PRIORITIES, TASK_STATUSES } from "./store.mjs";

const dataDirectory = process.env.PLUGIN_DATA || process.env.TASKBOARD_DATA_DIR;
const store = createTaskStore(dataDirectory);
const icon = {
  src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round"><rect x="2.5" y="3" width="15" height="14" rx="2"/><path d="M7.5 3v14M10.5 7h4M10.5 10h4M10.5 13h3"/></svg>')}`,
  mimeType: "image/svg+xml", sizes: ["20x20"],
};
const server = new McpServer(
  { name: "taskboard", version: "0.1.0", icons: [icon] },
  { instructions: "Use returned IDs. Read a task and pass its version as expected_version before updating it." },
);

const boardSchema = z.object({
  id: z.string(),
  name: z.string(),
  taskCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const taskSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  dueDate: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const summarySchema = taskSchema.pick({
  id: true, boardId: true, title: true, status: true,
  priority: true, dueDate: true, version: true, updatedAt: true,
});
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const UI_URI = "ui://taskboard/board.html";
const uiDirectory = dirname(fileURLToPath(import.meta.url));
const boardHtml = readFileSync(join(uiDirectory, "ui.html"), "utf8")
  .replace("<!--APP_SCRIPT-->", `<script>${readFileSync(join(uiDirectory, "ui.js"), "utf8")}</script>`);

function respond(action) {
  return async (args) => {
    try {
      const result = action(args);
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const code = error instanceof TaskError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof TaskError ? error.message : "TaskBoard could not complete the operation";
      return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
    }
  };
}

registerAppResource(server, "TaskBoard", UI_URI, {}, async () => ({
  contents: [{
    uri: UI_URI,
    mimeType: RESOURCE_MIME_TYPE,
    text: boardHtml,
    _meta: { "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["fullscreen"] } },
  }],
}));

registerAppTool(server, "taskboard.open", {
  title: "TaskBoard",
  description: "Open the local TaskBoard app from the global sidebar.",
  inputSchema: {},
  outputSchema: { boards: z.array(boardSchema), tasks: z.array(summarySchema), hasMore: z.boolean(), offset: z.number().int(), total: z.number().int() },
  annotations: readOnly,
  _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] }, "openai/ui": { entrypoints: [{ type: "global" }] } },
}, respond(() => {
  const result = store.listTasks(undefined, { limit: 100, offset: 0 });
  return { boards: store.listBoards(), ...result, tasks: result.tasks.map((task) => summarySchema.parse(task)) };
}));

server.registerTool("list_boards", {
  title: "List TaskBoard boards",
  description: "Find the local TaskBoard boards and their IDs before listing or creating tasks.",
  inputSchema: {}, outputSchema: { boards: z.array(boardSchema) }, annotations: readOnly,
}, respond(() => ({ boards: store.listBoards() })));

server.registerTool("create_board", {
  title: "Create a TaskBoard board",
  description: "Create a new local task board when the user asks for one.",
  inputSchema: { name: z.string().trim().min(1).max(80) },
  outputSchema: { board: boardSchema }, annotations: write,
}, respond(({ name }) => ({ board: store.createBoard(name) })));

server.registerTool("list_tasks", {
  title: "List TaskBoard tasks",
  description: "Read task summaries across all boards, or filter by board_id. Use offset to fetch more results.",
  inputSchema: {
    board_id: z.string().min(1).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
  },
  outputSchema: { tasks: z.array(summarySchema), hasMore: z.boolean(), offset: z.number().int(), total: z.number().int() },
  annotations: readOnly,
}, respond(({ board_id, status, limit, offset }) => {
  const result = store.listTasks(board_id, { status, limit, offset });
  return { ...result, tasks: result.tasks.map((task) => summarySchema.parse(task)) };
}));

server.registerTool("get_task", {
  title: "Get a task",
  description: "Read a TaskBoard task by its exact ID, including its description and current version.",
  inputSchema: { task_id: z.string().min(1) },
  outputSchema: { task: taskSchema }, annotations: readOnly,
}, respond(({ task_id }) => ({ task: store.getTask(task_id) })));

server.registerTool("create_task", {
  title: "Create a task",
  description: "Add a task to a known TaskBoard board at the user's request.",
  inputSchema: {
    board_id: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10000).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    due_date: z.iso.date().nullable().optional(),
  },
  outputSchema: { task: taskSchema }, annotations: write,
}, respond(({ board_id, title, description, status, priority, due_date }) => ({
  task: store.createTask({ boardId: board_id, title, description, status, priority, dueDate: due_date }),
})));

server.registerTool("update_task", {
  title: "Update a task",
  description: "Change a known task after reading it. Pass the version from get_task as expected_version; conflicts require another read.",
  inputSchema: {
    task_id: z.string().min(1),
    expected_version: z.number().int().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10000).nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    due_date: z.iso.date().nullable().optional(),
  },
  outputSchema: { task: taskSchema }, annotations: write,
}, respond(({ task_id, expected_version, title, description, status, priority, due_date }) => {
  const changes = Object.fromEntries(Object.entries({
    title, description, status, priority, dueDate: due_date,
  }).filter(([, value]) => value !== undefined));
  return { task: store.updateTask(task_id, expected_version, changes) };
}));

await server.connect(new StdioServerTransport());
