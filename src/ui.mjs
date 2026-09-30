import { App } from "@modelcontextprotocol/ext-apps";

const groups = [
  { title: "等待认领", statuses: ["backlog", "todo"] },
  { title: "处理中", statuses: ["in_progress", "blocked"] },
  { title: "等待确认", statuses: ["in_review", "done"] },
];
const statusNames = { backlog: "待整理", todo: "等待认领", in_progress: "处理中", in_review: "等待确认", blocked: "受阻", done: "已完成" };
const priorityNames = { low: "低优先级", medium: "中优先级", high: "高优先级", urgent: "紧急" };
const byId = (id) => document.getElementById(id);
const app = new App({ name: "TaskBoard", version: "0.1.0" }, {});
const state = { boards: [], boardId: "", tasks: [], editing: null, busy: false, initialized: false };

function showError(message) { byId("notice").textContent = message || "操作失败，请重试"; }
function clearError() { byId("notice").textContent = ""; }
async function call(name, args = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text || "操作失败");
  return result.structuredContent || {};
}
function setBusy(value) {
  state.busy = value;
  byId("new-board").disabled = value;
  byId("new-task").disabled = value || !state.boards.length;
  byId("board-select").disabled = value || !state.boards.length;
  byId("refresh").disabled = value;
  byId("save-task").disabled = value;
}
async function run(action) {
  if (state.busy) return;
  clearError(); setBusy(true);
  try { await action(); } catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
function projectName(id) { return state.boards.find((board) => board.id === id)?.name || "未知项目"; }
function renderBoards() {
  const select = byId("board-select");
  select.replaceChildren(new Option("所有项目", ""));
  for (const board of state.boards) select.add(new Option(board.name, board.id));
  select.value = state.boardId;
  byId("new-task").disabled = state.busy || !state.boards.length;
  byId("board-subtitle").textContent = state.boards.length
    ? `${state.boardId ? projectName(state.boardId) : "所有项目"} · ${state.tasks.length} 个任务`
    : "创建项目后即可添加任务";
}
function badge(text, classes) {
  const span = document.createElement("span");
  span.className = `tag ${classes}`; span.textContent = text;
  return span;
}
function renderCard(task) {
  const card = document.createElement("button");
  card.type = "button"; card.className = "card";
  card.setAttribute("aria-label", `查看任务：${task.title}，所属项目：${projectName(task.boardId)}`);
  const id = document.createElement("span"); id.className = "card-id";
  id.textContent = `#${task.id.replace(/^task_/, "").slice(0, 8).toUpperCase()}`;
  const title = document.createElement("span"); title.className = "card-title"; title.textContent = task.title;
  const tags = document.createElement("span"); tags.className = "card-tags";
  const tone = task.status === "blocked" || task.status === "done" ? task.status
    : ["in_progress"].includes(task.status) ? "working"
    : ["in_review"].includes(task.status) ? "confirm" : "";
  tags.append(badge(statusNames[task.status] || task.status, `status ${tone}`));
  tags.append(badge(projectName(task.boardId), "project"));
  if (task.priority !== "none") tags.append(badge(priorityNames[task.priority] || task.priority, `priority ${task.priority}`));
  const meta = document.createElement("span"); meta.className = "card-meta";
  const updated = document.createElement("span");
  updated.textContent = `更新于 ${task.updatedAt.slice(0, 10)}`;
  meta.append(updated);
  if (task.dueDate) {
    const due = document.createElement("span"); due.className = "due";
    due.textContent = `截止 ${task.dueDate}`;
    meta.append(due);
  }
  card.append(id, title, tags, meta);
  card.addEventListener("click", () => run(async () => {
    const detail = await call("get_task", { task_id: task.id });
    openTaskDialog(detail.task);
  }));
  return card;
}
function renderTasks() {
  const content = byId("content"); content.replaceChildren();
  if (!state.boards.length) {
    const empty = document.createElement("div"); empty.className = "welcome";
    const inner = document.createElement("div");
    const title = document.createElement("h2"); title.textContent = "从一个项目开始";
    const note = document.createElement("p"); note.textContent = "点击“新建项目”，开始整理任务。";
    inner.append(title, note); empty.append(inner); content.append(empty);
    return;
  }
  const board = document.createElement("div"); board.className = "board";
  for (const group of groups) {
    const column = document.createElement("section"); column.className = "column";
    const tasks = state.tasks.filter((task) => group.statuses.includes(task.status));
    const head = document.createElement("div"); head.className = "column-head";
    const title = document.createElement("span"); title.textContent = group.title;
    const count = document.createElement("span"); count.className = "count"; count.textContent = String(tasks.length);
    head.append(title, count); column.append(head);
    const cards = document.createElement("div"); cards.className = "cards";
    if (tasks.length) for (const task of tasks) cards.append(renderCard(task));
    else { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "暂无任务"; cards.append(empty); }
    column.append(cards); board.append(column);
  }
  content.append(board);
}
function renderLoading() {
  const content = byId("content"); content.replaceChildren();
  const loading = document.createElement("div"); loading.className = "welcome";
  loading.textContent = "正在加载任务…";
  content.append(loading);
}
async function loadTasks() {
  byId("board-subtitle").textContent = "正在加载任务…";
  renderLoading();
  const tasks = [];
  let offset = 0;
  while (true) {
    const args = { limit: 100, offset };
    if (state.boardId) args.board_id = state.boardId;
    const page = await call("list_tasks", args);
    if (!Array.isArray(page.tasks)) throw new Error("任务数据格式不正确");
    tasks.push(...page.tasks);
    if (!page.hasMore) break;
    if (!page.tasks.length) throw new Error("任务分页未能继续");
    offset += page.tasks.length;
  }
  state.tasks = tasks;
  renderBoards(); renderTasks();
}
async function refresh() {
  const response = await call("list_boards");
  if (!Array.isArray(response.boards)) throw new Error("项目数据格式不正确");
  state.boards = response.boards;
  if (state.boardId && !state.boards.some((board) => board.id === state.boardId)) state.boardId = "";
  renderBoards();
  await loadTasks();
  state.initialized = true;
}
function openTaskDialog(task = null) {
  state.editing = task;
  const form = byId("task-form"); form.reset();
  const project = form.elements.board_id; project.replaceChildren();
  if (!task && !state.boardId && state.boards.length > 1) project.add(new Option("选择所属项目", ""));
  for (const board of state.boards) project.add(new Option(board.name, board.id));
  project.value = task?.boardId || state.boardId || (state.boards.length === 1 ? state.boards[0].id : "");
  project.disabled = Boolean(task);
  byId("task-dialog-title").textContent = task ? "任务详情" : "新建任务";
  if (task) {
    for (const key of ["title", "description", "status", "priority"]) form.elements[key].value = task[key];
    form.elements.due_date.value = task.dueDate || "";
  }
  byId("task-dialog").showModal();
  form.elements.title.focus();
}
byId("new-board").addEventListener("click", () => { byId("board-form").reset(); byId("board-dialog").showModal(); });
byId("new-task").addEventListener("click", () => openTaskDialog());
byId("refresh").addEventListener("click", () => run(refresh));
for (const close of document.querySelectorAll("[data-close]")) close.addEventListener("click", () => byId(close.dataset.close).close());
byId("board-select").addEventListener("change", (event) => run(async () => {
  state.boardId = event.target.value;
  state.tasks = [];
  renderBoards();
  await loadTasks();
}));
byId("board-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const name = event.target.elements.name.value.trim();
    await call("create_board", { name });
    byId("board-dialog").close(); await refresh();
  });
});
byId("task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const form = event.target;
    const values = {
      title: form.elements.title.value.trim(),
      description: form.elements.description.value,
      status: form.elements.status.value,
      priority: form.elements.priority.value,
      due_date: form.elements.due_date.value || null,
    };
    if (state.editing) await call("update_task", { task_id: state.editing.id, expected_version: state.editing.version, ...values });
    else await call("create_task", { board_id: form.elements.board_id.value, ...values });
    byId("task-dialog").close();
    await refresh();
  });
});
// The host may deliver taskboard.open before connect() resolves.
app.ontoolresult = (result) => {
  if (state.busy || state.initialized) return;
  const data = result.structuredContent;
  if (!Array.isArray(data?.boards) || !Array.isArray(data?.tasks)) return;
  state.boards = data.boards;
  state.tasks = data.hasMore ? [] : data.tasks;
  renderBoards();
  if (data.hasMore) byId("board-subtitle").textContent = `正在加载任务…已读取 ${data.tasks.length} 个`;
  if (data.hasMore) renderLoading(); else renderTasks();
};
renderBoards(); renderLoading();
app.connect().then(() => run(refresh)).catch((error) => showError(`无法连接 TaskBoard：${error.message}`));
