import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "@modelcontextprotocol/ext-apps";

const statuses = ["InProgress", "Review", "Done"];
const byId = (id) => document.getElementById(id);
const app = new App({ name: "Codex TaskBoard", version: "0.2.6" }, {});
const state = {
  data: null, connected: false, busy: false, refreshPending: false,
  filterVersion: 0, activeLoadStarted: false, dragging: null, actionError: "", searchExpanded: false, searchSelectedId: null, searchResults: [], searchOpening: false, searchError: "", searchReadError: "", dataVersion: -1, projectOpen: false, projectActiveCwd: null, projectResults: [], hostTheme: "light", manualTheme: null,
};
let searchTimer;

function filters() {
  return { query: byId("search").value.trim(), cwd: byId("workspace").value,
    showArchived: byId("show-archived").checked, showSubagents: byId("show-subagents").checked };
}
function notice(message = "") { byId("notice").textContent = message; }
function actionFailed(message) { state.actionError = message; notice(message); }
function globalStale(data) {
  return Boolean(data?.stale && (!data.errors?.length || data.errors.some((error) => !error.threadId)));
}
function errorSummary(errors = []) {
  const reasons = { ROLLOUT_MISSING: "会话文件缺失", ROLLOUT_FORMAT_ERROR: "会话记录格式异常", ROLLOUT_READ_ERROR: "会话记录无法读取" };
  const groups = new Map();
  const messages = [];
  for (const error of errors) {
    if (error.threadId && reasons[error.code]) {
      if (!groups.has(error.code)) groups.set(error.code, new Set());
      groups.get(error.code).add(error.threadId);
    } else if (error.message) messages.push(error.message);
  }
  for (const [code, ids] of groups) messages.push(`${ids.size} 个聊天的${reasons[code]}，无法确认最新状态`);
  return [...new Set(messages)].join("；");
}
function errorMessage(result) {
  const errors = result?.structuredContent?.errors;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (errors?.some((error) => error.code === "VERSION_CONFLICT") || text?.startsWith("VERSION_CONFLICT:")) return "任务已发生变化，请刷新后重试。";
  return errorSummary(errors)
    || text?.replace(/^[A-Z_]+:\s*/, "") || "操作失败，请重试。";
}
function updateBusy() {
  byId("refresh").disabled = !state.connected || state.busy || Boolean(state.dragging);
  const refreshLabel = state.busy ? "正在更新任务" : "刷新任务";
  byId("refresh-label").textContent = refreshLabel;
  byId("refresh").setAttribute("aria-label", refreshLabel);
  byId("refresh").title = refreshLabel;
  byId("refresh").classList.toggle("is-loading", state.busy);
  for (const node of document.querySelectorAll(".card[data-draggable]")) {
    node.draggable = node === state.dragging?.node || Boolean(state.connected && !state.busy && !state.refreshPending && !state.dragging && node.dataset.stale !== "true");
  }
  if (state.connected && state.busy && !state.data) byId("summary").textContent = "正在读取线程记录，首次打开需要建立索引…";
  byId("content").setAttribute("aria-busy", String(!state.connected || state.busy));
  renderSearch();
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function shortCwd(cwd) { return String(cwd || "").replace(/\/$/, "").split(/[\\/]/).pop() || "无项目"; }
function projectName(cwd) { return state.data?.workspaces.find((workspace) => workspace.cwd === cwd)?.name || shortCwd(cwd); }
function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未知时间";
}
function icon(name) {
  const paths = {
    progress: "M12 3a9 9 0 1 0 9 9M12 7v5l3 2M16 3h5v5M21 3l-6 6",
    review: "M9 11l2 2 4-4M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3",
    done: "M20 6L9 17l-5-5",
    folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
    clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    message: "M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5",
    moon: "M20.8 13a9 9 0 1 1-9.8-9.8A7 7 0 0 0 20.8 13Z",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  svg.classList.add("icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name] || paths.done); svg.append(path);
  return svg;
}
function displayReason(thread) {
  const reason = thread.reason || "状态待确认";
  if (reason.includes("状态待确认")) return "状态待确认";
  if (reason.includes("本轮已结束")) return "等待验收";
  if (thread.status === "InProgress") return "本轮进行中";
  return reason;
}
function card(thread) {
  const stale = Boolean(globalStale(state.data) || thread.stale);
  const node = element("article", `card${stale ? " stale" : ""}`);
  const top = element("div", "card-top");
  const id = element("span", "card-id", `ID: ${String(thread.id).slice(0, 8)}`);
  id.title = String(thread.id);
  const dot = element("span", "status-dot");
  dot.title = thread.status; dot.setAttribute("aria-hidden", "true");
  top.append(id, dot);
  const title = element("button", "card-title", thread.title || "未命名任务");
  title.title = thread.title || "未命名任务";
  title.type = "button";
  title.addEventListener("click", async () => {
    title.disabled = true;
    try {
      await openThread(thread);
    } catch (error) { actionFailed(`无法打开任务：${error.message}`); }
    finally { title.disabled = false; }
  });
  const tags = element("div", "tags");
  const workspace = element("span", "tag workspace-tag");
  workspace.append(icon("folder"), element("span", "tag-label", projectName(thread.cwd)));
  workspace.title = `项目：${projectName(thread.cwd)}${thread.cwd ? `\n${thread.cwd}` : ""}`;
  tags.append(workspace);
  if (thread.sourceType === "agent_created_thread" && !thread.isSubagent) tags.append(element("span", "tag", "独立线程"));
  if (thread.isSubagent) tags.append(element("span", "tag", "子 Agent"));
  if (thread.archived) tags.append(element("span", "tag", "已归档"));
  if (stale) tags.append(element("span", "tag warning", "数据过期"));
  const reason = element("p", "reason", displayReason(thread));
  reason.title = thread.reason === "已人工验收" ? thread.reason : `${thread.reason || "暂无状态说明"}。状态依据会话记录推断，不代表实时执行状态。`;
  const meta = element("div", "card-meta");
  const time = element("time", "updated");
  time.append(icon("clock"), element("span", "", formatTime(thread.updatedAt)));
  time.title = `更新于 ${new Date(thread.updatedAt).toLocaleString("zh-CN")}`;
  const date = new Date(thread.updatedAt);
  if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
  const count = thread.messageTurnCount;
  const knownCount = Number.isInteger(count) && count >= 0;
  const incomplete = knownCount && thread.messageTurnCountIncomplete;
  const turns = element("span", `turn-count${incomplete ? " incomplete" : ""}`);
  const countLabel = knownCount
    ? `消息轮数：${incomplete ? "至少 " : ""}${count} 个已确认用户回合${incomplete ? "，记录不完整" : ""}；同一回合多次输入只计 1 轮，系统回合不计。`
    : "无法读取消息轮数";
  turns.title = countLabel;
  turns.setAttribute("role", "img"); turns.setAttribute("aria-label", countLabel);
  turns.append(icon("message"), element("span", "", knownCount ? `+${count}` : "—"));
  meta.append(time, turns);
  if (thread.status === "Review" || thread.status === "Done") {
    const shortcut = thread.status === "Review" ? "Alt+ArrowRight" : "Alt+ArrowLeft";
    const operation = thread.status === "Review" ? "移至 Done 并验收完成" : "移至 Review 并重新打开";
    node.tabIndex = 0;
    node.setAttribute("aria-keyshortcuts", shortcut);
    node.setAttribute("aria-label", `${thread.title || "未命名任务"}，${thread.status}`);
    node.setAttribute("aria-description", stale ? "数据过期，请刷新后操作。" : `可拖至对侧栏目，或聚焦此卡片后按 ${shortcut} ${operation}。`);
    node.addEventListener("keydown", (event) => {
      const key = thread.status === "Review" ? "ArrowRight" : "ArrowLeft";
      if (event.target !== node || document.activeElement !== node || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key !== key
        || !canChange(thread) || state.refreshPending || state.dragging) return;
      event.preventDefault();
      void mutate(thread);
    });
    node.dataset.draggable = "true";
    node.dataset.stale = String(stale);
    node.draggable = Boolean(state.connected && !state.busy && !state.refreshPending && !stale);
    node.addEventListener("dragstart", (event) => startDrag(event, thread, node));
    node.addEventListener("dragend", () => finishDrag());
  }
  node.append(top, title, reason, tags, meta);
  return node;
}
function canChange(thread) {
  return Boolean(state.connected && !state.busy && !globalStale(state.data) && !thread.stale
    && (thread.status === "Review" || thread.status === "Done"));
}
function dropAllowed(status) {
  const drag = state.dragging;
  return Boolean(drag && canChange(drag.thread) && drag.filterVersion === state.filterVersion
    && (drag.thread.status === "Review" && status === "Done" || drag.thread.status === "Done" && status === "Review"));
}
function startDrag(event, thread, node) {
  if (!canChange(thread) || state.refreshPending || state.dragging || !event.dataTransfer) {
    event.preventDefault(); return;
  }
  state.dragging = { thread, node, filterVersion: state.filterVersion };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-codex-taskboard-thread", thread.id);
  node.classList.add("dragging");
  for (const column of document.querySelectorAll(".column[data-status]")) {
    column.classList.toggle("drop-available", dropAllowed(column.dataset.status));
  }
  updateBusy();
}
function finishDrag(resume = true) {
  if (!state.dragging) return;
  state.dragging.node.classList.remove("dragging");
  state.dragging = null;
  for (const column of document.querySelectorAll(".column[data-status]")) column.classList.remove("drop-available", "drop-over");
  updateBusy();
  if (resume && state.refreshPending) void refresh();
}
function setupDrop(column, status) {
  if (status === "InProgress") return;
  column.addEventListener("dragover", (event) => {
    if (!dropAllowed(status)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    column.classList.add("drop-over");
  });
  column.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !column.contains(event.relatedTarget)) column.classList.remove("drop-over");
  });
  column.addEventListener("drop", (event) => {
    if (!dropAllowed(status)) return;
    const thread = state.dragging.thread;
    if (event.dataTransfer?.getData("application/x-codex-taskboard-thread") !== thread.id) return;
    event.preventDefault();
    // Keep the dragged revision; a concurrent native change must be rejected by the server.
    finishDrag(false);
    void mutate(thread, { fromDrop: true });
  });
}

function render() {
  const data = state.data;
  if (!data) return;
  const select = byId("workspace");
  const selected = select.value;
  const previousLabel = Array.from(select.options).find((option) => option.value === selected)?.textContent;
  select.replaceChildren(new Option("所有项目", ""));
  for (const workspace of data.workspaces || []) {
    const option = new Option(workspace.name || shortCwd(workspace.cwd), workspace.cwd);
    option.title = workspace.cwd || "无项目";
    select.add(option);
  }
  // Keep a selected workspace when the source is temporarily unavailable.
  if (selected && !Array.from(select.options).some((option) => option.value === selected)) {
    const option = new Option(previousLabel || shortCwd(selected), selected);
    option.title = selected;
    select.add(option);
  }
  select.value = selected;
  const selectedLabel = Array.from(select.options).find((option) => option.value === selected)?.textContent;
  select.title = selected ? `项目：${selectedLabel || shortCwd(selected)}\n${selected}` : "项目选择";
  renderProjectPicker();
  const board = element("div", "board");
  for (const status of statuses) {
    const column = element("section", `column ${status.toLowerCase()}`);
    column.dataset.status = status;
    setupDrop(column, status);
    const head = element("div", "column-head");
    const threads = data.threads.filter((thread) => thread.status === status);
    const subtitle = { InProgress: "进行中", Review: "待验收", Done: "已完成" };
    const mark = { InProgress: "progress", Review: "review", Done: "done" };
    head.append(icon(mark[status]), element("h2", "", status), element("span", "column-subtitle", subtitle[status]), element("span", "count", String(data.counts?.[status] ?? threads.length)));
    const cards = element("div", "cards");
    if (status !== "InProgress") {
      const hint = element("span", "drop-hint", status === "Done" ? "松开即可验收完成" : "松开即可重新打开");
      hint.setAttribute("aria-hidden", "true");
      cards.append(hint);
    }
    if (threads.length) for (const thread of threads) cards.append(card(thread));
    else cards.append(element("p", "empty", "暂无任务"));
    column.append(head, cards); board.append(column);
  }
  byId("content").replaceChildren(board);
  const total = data.threads.length;
  byId("summary").textContent = data.stale
    ? `${total} 个任务 · ${globalStale(data) ? "数据过期" : "部分数据过期"}${data.lastSuccessfulReadAt ? ` · 上次成功读取 ${formatTime(data.lastSuccessfulReadAt)}` : ""}`
    : `${total} 个任务 · 可见时每 5 秒刷新 · Review ↔ Done 可拖动`;
  updateBusy();
}
function receive(result) {
  if (result.isError) throw new Error(errorMessage(result));
  const data = result.structuredContent;
  if (!Array.isArray(data?.threads) || !Array.isArray(data?.workspaces)) throw new Error("任务数据格式不正确。");
  state.data = data;
  state.dataVersion = state.filterVersion;
  state.searchReadError = "";
  notice(errorSummary(data.errors) || state.actionError || (data.stale
    ? globalStale(data) ? "当前数据已过期，请刷新后再验收或重新打开。" : "部分任务数据已过期，请刷新异常任务后再操作。"
    : ""));
  render();
}
function failed(error) {
  state.searchReadError = `读取失败：${error.message}`;
  notice(`读取失败：${error.message}`);
  if (state.data) { state.data = { ...state.data, stale: true, errors: [{ code: "UI_READ_ERROR", message: error.message }] }; render(); }
  else byId("summary").textContent = "读取失败，请点击刷新重试";
  renderSearch();
}
async function refresh() {
  state.refreshPending = true;
  updateBusy();
  if (!state.connected || state.busy || state.dragging) return;
  state.busy = true;
  state.activeLoadStarted = true;
  updateBusy();
  try {
    // One in-flight call and one coalesced pending refresh bound host traffic.
    while (state.refreshPending) {
      state.refreshPending = false;
      const version = state.filterVersion;
      const args = filters();
      try {
        const result = await app.callServerTool({ name: "taskboard.list_threads", arguments: args }, { timeout: 120000 });
        if (version === state.filterVersion) receive(result);
      } catch (error) { if (version === state.filterVersion) failed(error); }
    }
  } finally { state.busy = false; updateBusy(); }
}
async function mutate(thread, { fromDrop = false } = {}) {
  if (!canChange(thread) || state.dragging || (state.refreshPending && !fromDrop)) return;
  state.busy = true;
  state.actionError = "";
  updateBusy(); notice();
  try {
    const result = await app.callServerTool({ name: thread.status === "Review" ? "taskboard.accept_thread" : "taskboard.reopen_thread",
      arguments: { threadId: thread.id, expectedRevision: thread.revision } }, { timeout: 120000 });
    if (result.isError) throw new Error(errorMessage(result));
    if (!result.structuredContent?.thread) throw new Error("操作返回数据不完整，请刷新确认状态。");
    state.refreshPending = true;
  } catch (error) { actionFailed(error.message); }
  finally {
    state.busy = false; updateBusy();
    if (state.refreshPending) await refresh();
  }
}
function filterChanged() { state.actionError = ""; state.filterVersion++; void refresh(); }
function projectOptionId(cwd) { return cwd ? `project-option-cwd-${encodeURIComponent(cwd)}` : "project-option-all"; }
function selectProjectActive(cwd, scroll = false) {
  state.projectActiveCwd = cwd;
  for (const row of byId("project-list").children) {
    const active = row.dataset.cwd === cwd;
    row.classList.toggle("active", active);
    if (active && scroll) row.scrollIntoView({ block: "nearest" });
  }
  if (cwd !== null) byId("project-search").setAttribute("aria-activedescendant", projectOptionId(cwd));
  else byId("project-search").removeAttribute("aria-activedescendant");
}
function renderProjectPicker() {
  const select = byId("workspace");
  const options = Array.from(select.options);
  const selected = options.find((option) => option.value === select.value);
  const label = selected?.textContent || "所有项目";
  byId("project-label").textContent = label;
  byId("project-toggle").setAttribute("aria-label", `项目选择：${label}`);
  byId("project-toggle").title = select.value ? `${label}\n${select.value}` : "所有项目";
  byId("project-toggle").setAttribute("aria-expanded", String(state.projectOpen));
  byId("project-search").setAttribute("aria-expanded", String(state.projectOpen));
  byId("project-menu").hidden = !state.projectOpen;
  if (!state.projectOpen) return;
  const query = byId("project-search").value.trim().toLocaleLowerCase();
  const matches = options.filter((option) => !option.value || `${option.textContent} ${option.value}`.toLocaleLowerCase().includes(query));
  state.projectResults = matches;
  const list = byId("project-list"); const scrollTop = list.scrollTop;
  list.replaceChildren();
  for (const option of matches) {
    const row = element("div", `project-option${option.value === select.value ? " selected" : ""}`);
    row.id = projectOptionId(option.value); row.dataset.cwd = option.value;
    row.title = option.value || "所有项目"; row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(option.value === select.value));
    row.append(element("span", "project-option-name", option.textContent));
    if (option.value === select.value) row.append(icon("done"));
    row.addEventListener("mousedown", (event) => event.preventDefault());
    row.addEventListener("click", () => chooseProject(option.value));
    list.append(row);
  }
  list.scrollTop = scrollTop;
  byId("project-empty").textContent = query && !matches.some((option) => option.value) ? "没有匹配项目" : "";
  const active = matches.some((option) => option.value === state.projectActiveCwd) ? state.projectActiveCwd
    : matches.find((option) => option.value === select.value)?.value ?? matches[0]?.value ?? null;
  selectProjectActive(active);
}
function toggleProject(open = !state.projectOpen, focus = true) {
  state.projectOpen = open;
  if (open) { byId("project-search").value = ""; state.projectActiveCwd = byId("workspace").value; }
  renderProjectPicker();
  if (focus) byId(open ? "project-search" : "project-toggle").focus();
}
function chooseProject(cwd) {
  const select = byId("workspace");
  const changed = select.value !== cwd;
  select.value = cwd;
  toggleProject(false);
  if (changed) filterChanged();
}
byId("project-toggle").addEventListener("click", () => toggleProject());
byId("project-toggle").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); toggleProject(true); }
});
byId("project-search").addEventListener("input", () => { state.projectActiveCwd = null; renderProjectPicker(); });
byId("project-search").addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); toggleProject(false); return; }
  const options = state.projectResults;
  if (!options.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const current = options.findIndex((option) => option.value === state.projectActiveCwd);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const index = Math.max(0, Math.min(options.length - 1, current + direction));
    selectProjectActive(options[index].value, true);
  } else if (event.key === "Enter" && state.projectActiveCwd !== null) {
    event.preventDefault(); chooseProject(state.projectActiveCwd);
  }
});
document.addEventListener("pointerdown", (event) => {
  if (state.projectOpen && !byId("project-picker").contains(event.target)) toggleProject(false, false);
});

async function openThread(thread) {
  const result = await app.openLink({ url: `codex://threads/${encodeURIComponent(thread.id)}` });
  if (result?.isError) throw new Error(errorMessage(result));
}
function updateSearch() {
  const hasQuery = Boolean(byId("search").value.trim());
  const button = byId("search-toggle");
  button.setAttribute("aria-expanded", String(state.searchExpanded));
  byId("search").setAttribute("aria-expanded", String(state.searchExpanded));
  button.dataset.active = String(hasQuery);
  const label = `${state.searchExpanded ? "关闭" : "打开"}搜索聊天${hasQuery ? "（标题筛选已生效）" : ""}`;
  button.setAttribute("aria-label", label); button.title = label;
}
function toggleSearch(expanded = !state.searchExpanded) {
  const dialog = byId("search-dialog");
  state.searchExpanded = expanded;
  updateSearch();
  if (expanded) {
    if (state.projectOpen) toggleProject(false, false);
    if (!dialog.open) dialog.showModal();
    renderSearch();
    byId("search").focus();
  } else {
    if (dialog.open) dialog.close();
    byId("search-toggle").focus();
  }
}
function searchOptionId(id) { return `search-option-${encodeURIComponent(id)}`; }
function selectSearch(id, scroll = false) {
  state.searchSelectedId = id;
  for (const option of byId("search-results").children) {
    const selected = option.dataset.threadId === id;
    option.setAttribute("aria-selected", String(selected));
    option.classList.toggle("selected", selected);
    if (selected && scroll) option.scrollIntoView({ block: "nearest" });
  }
  if (id) byId("search").setAttribute("aria-activedescendant", searchOptionId(id));
  else byId("search").removeAttribute("aria-activedescendant");
}
function renderSearch() {
  if (!state.searchExpanded) return;
  const list = byId("search-results");
  const status = byId("search-status");
  const waiting = !state.data || state.dataVersion !== state.filterVersion;
  const threads = waiting ? [] : state.data.threads;
  state.searchResults = threads;
  byId("search-error").textContent = state.searchError;
  let message = "";
  if (state.searchReadError) message = `${state.searchReadError}${threads.length ? " · 显示上次读取的聊天" : "，请刷新重试"}`;
  else if (waiting) message = state.connected ? "正在搜索聊天…" : "正在连接…";
  else if (globalStale(state.data)) message = "聊天数据已过期，请刷新确认结果";
  else if (state.data.stale) message = errorSummary(state.data.errors) || "部分聊天数据已过期";
  else if (!threads.length) message = "没有匹配的聊天";
  status.textContent = message;
  list.setAttribute("aria-busy", String(waiting && !state.searchReadError));
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  for (const thread of threads) {
    const option = element("div", "search-result");
    option.id = searchOptionId(thread.id); option.dataset.threadId = thread.id;
    option.setAttribute("role", "option");
    option.setAttribute("aria-disabled", String(state.searchOpening));
    const title = element("span", "search-result-title", thread.title || "未命名聊天");
    title.title = thread.title || "未命名聊天";
    const meta = element("span", "search-result-meta", `${projectName(thread.cwd)} · ${thread.status}${thread.archived ? " · 已归档" : ""}`);
    option.append(title, meta);
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => { selectSearch(thread.id); void openSearchThread(thread); });
    list.append(option);
  }
  list.scrollTop = scrollTop;
  const selected = threads.some((thread) => thread.id === state.searchSelectedId) ? state.searchSelectedId : threads[0]?.id || null;
  selectSearch(selected);
}
async function openSearchThread(thread) {
  if (state.searchOpening) return;
  state.searchOpening = true; state.searchError = "";
  renderSearch();
  try {
    await openThread(thread);
    toggleSearch(false);
  } catch (error) {
    state.searchError = `无法打开聊天：${error.message}`;
    actionFailed(state.searchError);
  } finally {
    state.searchOpening = false;
    renderSearch();
  }
}
function updateTheme() {
  const current = state.manualTheme || state.hostTheme;
  applyDocumentTheme(current);
  if (state.manualTheme) document.documentElement.dataset.themeOverride = state.manualTheme;
  else delete document.documentElement.dataset.themeOverride;
  const button = byId("theme-toggle");
  const label = `切换为${current === "dark" ? "浅色" : "深色"}主题（仅当前页面）`;
  button.setAttribute("aria-label", label); button.title = label;
  button.replaceChildren(icon(current === "dark" ? "sun" : "moon"));
}
function theme(context) {
  if (context?.theme) state.hostTheme = context.theme;
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  updateTheme();
}
byId("search-toggle").addEventListener("click", () => toggleSearch());
byId("search").addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); toggleSearch(false); return; }
  const threads = state.searchResults;
  if (!threads.length) return;
  const current = threads.findIndex((thread) => thread.id === state.searchSelectedId);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const index = Math.max(0, Math.min(threads.length - 1, current + direction));
    selectSearch(threads[index].id, true);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const selected = threads.find((thread) => thread.id === state.searchSelectedId);
    if (selected) void openSearchThread(selected);
  }
});
byId("search-dialog").addEventListener("cancel", (event) => { event.preventDefault(); toggleSearch(false); });
byId("search-dialog").addEventListener("close", () => {
  state.searchExpanded = false; updateSearch(); byId("search-toggle").focus();
});
byId("search-dialog").addEventListener("click", (event) => {
  if (event.target !== byId("search-dialog")) return;
  const rect = byId("search-dialog").getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) toggleSearch(false);
});
byId("theme-toggle").addEventListener("click", () => {
  state.manualTheme = (state.manualTheme || state.hostTheme) === "dark" ? "light" : "dark";
  updateTheme();
});
byId("search").addEventListener("input", () => {
  state.searchError = ""; state.searchReadError = ""; state.searchSelectedId = null;
  updateSearch();
  // Invalidate an old query immediately; debounce only the next request.
  state.filterVersion++;
  state.actionError = "";
  state.refreshPending = true;
  updateBusy();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void refresh(), 250);
});
for (const id of ["workspace", "show-archived", "show-subagents"]) byId(id).addEventListener("change", filterChanged);
byId("refresh").addEventListener("click", () => { state.actionError = ""; void refresh(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
const interval = setInterval(() => { if (!document.hidden && state.connected) void refresh(); }, 5000);
app.onhostcontextchanged = theme;
app.ontoolresult = (result) => {
  // Entry-point results may arrive before connect; never replace a newer query.
  if (state.activeLoadStarted || state.filterVersion || state.data) return;
  try { receive(result); } catch (error) { failed(error); }
};
app.onteardown = async () => { finishDrag(false); clearInterval(interval); clearTimeout(searchTimer); return {}; };
renderProjectPicker();
updateSearch();
updateTheme();
updateBusy();
app.connect().then(() => {
  state.connected = true;
  theme(app.getHostContext());
  void refresh();
}).catch((error) => { state.searchReadError = `无法连接 Codex TaskBoard：${error.message}`; notice(state.searchReadError); byId("summary").textContent = "连接失败"; renderSearch(); });
