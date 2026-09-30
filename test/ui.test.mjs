import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../src/ui.mjs', import.meta.url), 'utf8')).replace(/^import .*\n/, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Small DOM/host doubles exercise the production event handlers without a browser dependency.
class Node {
  constructor() {
    this.children = []; this.dataset = {}; this.value = ''; this.checked = false; this.listeners = {};
    this.className = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); },
      remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
      toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  add(node) { this.append(node); }
  get options() { return this.children; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  getBoundingClientRect() { return { left: 10, top: 10, right: 510, bottom: 400 }; }
  scrollIntoView() { this.scrolledIntoView = true; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() { this.focused = true; this.onFocus?.(this); }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
}
function dragEvent() {
  const data = new Map();
  return {
    dataTransfer: { setData: (key, value) => data.set(key, value), getData: (key) => data.get(key) },
    preventDefault() { this.prevented = true; },
  };
}
const thread = (status = 'Review', overrides = {}) => ({
  id: 'thread-real-id', title: '任务', status, cwd: '/code/test', updatedAt: 1,
  revision: 'original-revision', reason: '等待验收', stale: false, sourceType: 'user', ...overrides,
});
const result = (threads) => ({ structuredContent: { threads, workspaces: [], errors: [], stale: false } });

async function harness(threads, workspaces = [], options = {}) {
  const ids = Object.fromEntries(['search', 'search-toggle', 'search-dialog', 'search-results', 'search-status', 'search-error', 'theme-toggle', 'workspace', 'show-archived', 'show-subagents', 'refresh', 'refresh-label', 'content', 'summary', 'notice'].map((id) => [id, new Node()]));
  const allNodes = () => {
    const walk = (node) => [node, ...node.children.flatMap(walk)];
    return Object.values(ids).flatMap(walk);
  };
  const query = (selector) => {
    const [, name, attribute] = selector.match(/^\.([\w-]+)(?:\[data-([\w-]+)\])?$/);
    return allNodes().filter((node) => node.className.split(' ').includes(name) && (!attribute || attribute in node.dataset));
  };
  const calls = []; const links = []; let poll; let app;
  const root = new Node();
  class App {
    constructor() { app = this; }
    connect() { return Promise.resolve(); }
    getHostContext() { return {}; }
    callServerTool(args) { return new Promise((resolve) => calls.push({ args, resolve })); }
    openLink(args) { return new Promise((resolve, reject) => links.push({ args, resolve, reject })); }
  }
  const doc = { documentElement: root, hidden: false, activeElement: null, getElementById: (id) => ids[id], querySelectorAll: query, addEventListener() {} };
  const makeNode = () => { const node = new Node(); node.onFocus = (value) => { doc.activeElement = value; }; return node; };
  for (const node of Object.values(ids)) node.onFocus = (value) => { doc.activeElement = value; };
  doc.createElement = makeNode; doc.createElementNS = makeNode;
  const context = {
    App, applyDocumentTheme(theme) { root.dataset.theme = theme; }, applyHostStyleVariables() {}, applyHostFonts() {},
    document: doc,
    Option: class extends Node { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
    setInterval: (handler) => { poll = handler; return 1; }, clearInterval() {},
    setTimeout: () => 1, clearTimeout() {},
  };
  vm.runInNewContext(source, context);
  await tick();
  const initial = options.initialResult || result(threads);
  if (initial.structuredContent) initial.structuredContent.workspaces = workspaces;
  if (!options.pending) { calls[0].resolve(initial); await tick(); calls.length = 0; }
  return { ids, calls, links, poll, root, doc, hostContextChanged: (context) => app.onhostcontextchanged(context), cards: () => query('.card'), column: (status) => query('.column[data-status]').find((node) => node.dataset.status === status) };
}

test('project picker and card share saved names while filtering keeps the full path', async () => {
  const h = await harness([thread()], [{ cwd: '/code/test', name: '产品项目' }]);
  assert.equal(h.ids.workspace.options[0].textContent, '所有项目');
  assert.equal(h.ids.workspace.options[1].textContent, '产品项目');
  assert.equal(h.ids.workspace.options[1].title, '/code/test');
  const tag = h.cards()[0].children.find((node) => node.className === 'tags').children[0];
  assert.equal(tag.children[1].textContent, '产品项目');
  assert.equal(tag.title, '项目：产品项目\n/code/test');
  h.ids.workspace.value = '/code/test';
  h.ids.workspace.listeners.change();
  assert.equal(h.calls[0].args.arguments.cwd, '/code/test');
  const filtered = result([thread()]);
  filtered.structuredContent.workspaces = [{ cwd: '/code/test', name: '产品项目' }];
  h.calls[0].resolve(filtered); await tick();
  assert.equal(h.ids.workspace.title, '项目：产品项目\n/code/test');
});

for (const [from, to, tool] of [['Review', 'Done', 'taskboard.accept_thread'], ['Done', 'Review', 'taskboard.reopen_thread']]) {
  test(`drag ${from} to ${to} uses its mutation and original revision`, async () => {
    const h = await harness([thread(from)]);
    const event = dragEvent();
    assert.equal(h.cards()[0].draggable, true);
    h.cards()[0].listeners.dragstart(event);
    h.column(to).listeners.dragover(event);
    assert.equal(event.prevented, true);
    assert.match(h.column(to).className, /drop-over/);
    h.column(to).listeners.drop(event);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].args.name, tool);
    assert.equal(h.calls[0].args.arguments.threadId, 'thread-real-id');
    assert.equal(h.calls[0].args.arguments.expectedRevision, 'original-revision');
    h.calls[0].resolve({ structuredContent: { thread: thread(to) } }); await tick();
    assert.equal(h.calls[1].args.name, 'taskboard.list_threads');
    h.calls[1].resolve(result([thread(to)])); await tick();
    assert.ok(h.column(to).contains(h.cards()[0]));
  });
}

test('InProgress, stale, busy and invalid drops never send mutations', async () => {
  for (const value of [thread('InProgress'), thread('Review', { stale: true })]) {
    const h = await harness([value]); const node = h.cards()[0];
    assert.ok(!node.draggable);
    const event = dragEvent(); node.listeners.dragstart?.(event);
    h.column('Done').listeners.drop(event);
    assert.equal(h.calls.length, 0);
  }
  const h = await harness([thread()]); const node = h.cards()[0]; const event = dragEvent();
  node.listeners.dragstart(event);
  h.column('Review').listeners.drop(event);
  assert.equal(h.column('InProgress').listeners.drop, undefined);
  h.column('Done').listeners.drop(dragEvent());
  assert.equal(h.calls.length, 0);
  node.listeners.dragend();
  h.poll();
  assert.equal(node.draggable, false);
  node.listeners.dragstart(dragEvent());
  h.column('Done').listeners.drop(event);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.name, 'taskboard.list_threads');
  h.calls[0].resolve(result([thread()])); await tick();
});

test('polling waits for drag end and version conflict remains visible after catch-up', async () => {
  const h = await harness([thread()]); const node = h.cards()[0]; const event = dragEvent();
  node.listeners.dragstart(event);
  h.poll(); h.poll();
  assert.equal(h.calls.length, 0);
  assert.equal(h.cards()[0], node);
  h.column('Done').listeners.drop(event);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.name, 'taskboard.accept_thread');
  h.calls[0].resolve({ isError: true, structuredContent: { errors: [{ code: 'VERSION_CONFLICT', message: 'conflict' }] } });
  await tick();
  assert.match(h.ids.notice.textContent, /请刷新/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args.name, 'taskboard.list_threads');
  h.calls[1].resolve(result([thread()])); await tick();
  assert.match(h.ids.notice.textContent, /请刷新/);
  assert.equal(h.cards()[0].draggable, true);

  const next = h.cards()[0]; next.listeners.dragstart(dragEvent()); h.poll();
  assert.equal(h.calls.length, 2);
  next.listeners.dragend();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].args.name, 'taskboard.list_threads');
  h.calls[2].resolve(result([thread()])); await tick();
});


test('search toggle focuses input and Escape collapses without clearing its active query', async () => {
  const h = await harness([thread()]);
  assert.ok(!h.ids['search-dialog'].open);
  h.ids['search-toggle'].listeners.click();
  assert.equal(h.ids['search-dialog'].open, true);
  assert.equal(h.ids['search-toggle']['aria-expanded'], 'true');
  assert.equal(h.ids.search.focused, true);
  h.ids.search.value = '保留的标题'; h.ids.search.listeners.input();
  assert.equal(h.ids['search-toggle'].dataset.active, 'true');
  let prevented = false;
  h.ids.search.listeners.keydown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(!h.ids['search-dialog'].open);
  assert.equal(h.ids.search.value, '保留的标题');
  assert.equal(h.ids['search-toggle']['aria-expanded'], 'false');
  assert.equal(h.ids['search-toggle'].focused, true);
  assert.match(h.ids['search-toggle'].title, /筛选已生效/);
  h.poll(); assert.equal(h.calls[0].args.arguments.query, '保留的标题');
  h.calls[0].resolve(result([thread()])); await tick();
  h.ids['search-toggle'].listeners.click();
  h.ids.search.value = ''; h.ids.search.listeners.input();
  assert.equal(h.ids['search-toggle'].dataset.active, 'false');
});

test('theme follows host until local toggle and then preserves the local choice', async () => {
  const h = await harness([thread()]);
  h.hostContextChanged({ theme: 'dark' });
  assert.equal(h.root.dataset.theme, 'dark');
  assert.equal(h.root.dataset.themeOverride, undefined);
  assert.match(h.ids['theme-toggle'].title, /浅色/);
  h.ids['theme-toggle'].listeners.click();
  assert.equal(h.root.dataset.theme, 'light');
  assert.equal(h.root.dataset.themeOverride, 'light');
  h.hostContextChanged({ theme: 'dark', styles: { variables: {} } });
  assert.equal(h.root.dataset.theme, 'light');
  assert.match(h.ids['theme-toggle']['aria-label'], /深色.*仅当前页面/);
  h.ids['theme-toggle'].listeners.click();
  assert.equal(h.root.dataset.theme, 'dark');
  assert.equal(h.root.dataset.themeOverride, 'dark');
});


function keyEvent(node, key, overrides = {}) {
  return { target: node, key, altKey: true, preventDefault() { this.prevented = true; }, ...overrides };
}
for (const [from, to, key, tool] of [['Review', 'Done', 'ArrowRight', 'taskboard.accept_thread'], ['Done', 'Review', 'ArrowLeft', 'taskboard.reopen_thread']]) {
  test(`focused ${from} keyboard shortcut moves to ${to} with its revision`, async () => {
    const h = await harness([thread(from)]); const node = h.cards()[0];
    assert.equal(node.tabIndex, 0);
    assert.equal(node['aria-keyshortcuts'], `Alt+${key}`);
    assert.ok(!node.children.some((child) => child.className === 'card-action'));
    node.focus(); const event = keyEvent(node, key); node.listeners.keydown(event);
    assert.equal(event.prevented, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].args.name, tool);
    assert.equal(h.calls[0].args.arguments.expectedRevision, 'original-revision');
    h.calls[0].resolve({ structuredContent: { thread: thread(to) } }); await tick();
    h.calls[1].resolve(result([thread(to)])); await tick();
  });
}

test('keyboard does not mutate child-button, unfocused, stale, busy, pending or dragging cards', async () => {
  const h = await harness([thread()]); const node = h.cards()[0];
  node.listeners.keydown(keyEvent(node, 'ArrowRight'));
  node.focus(); node.listeners.keydown(keyEvent(node, 'ArrowLeft'));
  node.listeners.keydown(keyEvent(node, 'ArrowRight', { altKey: false }));
  node.listeners.keydown(keyEvent(node, 'ArrowRight', { ctrlKey: true }));
  const title = node.children.find((child) => child.className === 'card-title');
  title.focus(); node.listeners.keydown(keyEvent(title, 'ArrowRight'));
  assert.equal(h.calls.length, 0);
  node.focus(); node.listeners.dragstart(dragEvent());
  node.listeners.keydown(keyEvent(node, 'ArrowRight'));
  assert.equal(h.calls.length, 0); node.listeners.dragend();
  h.ids.search.value = 'query'; h.ids.search.listeners.input();
  node.listeners.keydown(keyEvent(node, 'ArrowRight')); assert.equal(h.calls.length, 0);
  h.poll(); node.listeners.keydown(keyEvent(node, 'ArrowRight'));
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args.name, 'taskboard.list_threads');
  h.calls[0].resolve(result([thread()])); await tick();
  const stale = await harness([thread('Review', { stale: true })]);
  stale.cards()[0].focus(); stale.cards()[0].listeners.keydown(keyEvent(stale.cards()[0], 'ArrowRight'));
  assert.equal(stale.calls.length, 0);
  const progress = await harness([thread('InProgress')]);
  assert.equal(progress.cards()[0].listeners.keydown, undefined);
});


const searchKey = (h, key) => h.ids.search.listeners.keydown({ key, preventDefault() {} });

test('search dialog opens final chat title via arrow keys and Enter and returns focus', async () => {
  const h = await harness([thread('Review', { title: '最终聊天标题' }), thread('Done', { id: 'thread/second', title: '第二个聊天' })]);
  h.ids['search-toggle'].listeners.click();
  assert.equal(h.ids['search-results'].children[0].children[0].textContent, '最终聊天标题');
  assert.equal(h.doc.activeElement, h.ids.search);
  searchKey(h, 'ArrowDown');
  assert.equal(h.ids.search['aria-activedescendant'], 'search-option-thread%2Fsecond');
  assert.equal(h.ids['search-results'].children[1]['aria-selected'], 'true');
  searchKey(h, 'ArrowUp'); searchKey(h, 'ArrowDown'); searchKey(h, 'Enter');
  assert.equal(h.links.length, 1);
  assert.equal(h.links[0].args.url, 'codex://threads/thread%2Fsecond');
  h.links[0].resolve({}); await tick();
  assert.equal(h.ids['search-dialog'].open, false);
  assert.equal(h.doc.activeElement, h.ids['search-toggle']);
});

test('search link failure stays visible and permits another attempt', async () => {
  const h = await harness([thread()]); h.ids['search-toggle'].listeners.click();
  searchKey(h, 'Enter'); searchKey(h, 'Enter');
  assert.equal(h.links.length, 1);
  h.links[0].resolve({ isError: true, content: [{ type: 'text', text: 'Link refused' }] }); await tick();
  assert.equal(h.ids['search-dialog'].open, true);
  assert.match(h.ids['search-error'].textContent, /无法打开聊天.*Link refused/);
  assert.equal(h.doc.activeElement, h.ids.search);
  searchKey(h, 'Enter'); assert.equal(h.links.length, 2);
  h.links[1].resolve({}); await tick();
  assert.equal(h.ids['search-dialog'].open, false);
});

test('search refresh keeps input focus and selected chat across result reordering', async () => {
  const first = thread(); const second = thread('Done', { id: 'second' });
  const h = await harness([first, second]); h.ids['search-toggle'].listeners.click();
  searchKey(h, 'ArrowDown');
  h.poll(); h.calls[0].resolve(result([second, first])); await tick();
  assert.equal(h.doc.activeElement, h.ids.search);
  assert.equal(h.ids.search.value, '');
  assert.equal(h.ids.search['aria-activedescendant'], 'search-option-second');
  assert.equal(h.ids['search-results'].children[0]['aria-selected'], 'true');
  h.poll(); h.calls[1].resolve(result([])); await tick();
  assert.match(h.ids['search-status'].textContent, /没有匹配/);
  assert.equal(h.ids.search['aria-activedescendant'], undefined);
  searchKey(h, 'Enter'); assert.equal(h.links.length, 0);
});

test('search backdrop and native cancel close dialog without clearing query', async () => {
  const h = await harness([thread()]); h.ids['search-toggle'].listeners.click();
  h.ids.search.value = '保留查询'; h.ids.search.listeners.input();
  const dialog = h.ids['search-dialog'];
  dialog.listeners.click({ target: dialog, clientX: 20, clientY: 20 });
  assert.equal(dialog.open, true);
  dialog.listeners.click({ target: dialog, clientX: 0, clientY: 0 });
  assert.equal(dialog.open, false);
  assert.equal(h.ids.search.value, '保留查询');
  assert.equal(h.doc.activeElement, h.ids['search-toggle']);
  h.ids['search-toggle'].listeners.click();
  dialog.listeners.cancel({ preventDefault() {} });
  assert.equal(dialog.open, false);
  assert.equal(h.ids['search-toggle'].dataset.active, 'true');
});

test('search loading and read failure are distinct from an empty result', async () => {
  const h = await harness([], [], { pending: true }); h.ids['search-toggle'].listeners.click();
  assert.match(h.ids['search-status'].textContent, /正在搜索/);
  searchKey(h, 'Enter'); assert.equal(h.links.length, 0);
  h.calls[0].resolve({ isError: true, content: [{ type: 'text', text: 'Database offline' }] }); await tick();
  assert.match(h.ids['search-status'].textContent, /读取失败.*Database offline/);
  assert.doesNotMatch(h.ids['search-status'].textContent, /没有匹配/);
  searchKey(h, 'Enter'); assert.equal(h.links.length, 0);
});

test('thread read errors aggregate missing counts while retaining snapshots and global reasons', async () => {
  const saved = thread('Review', { title: '保留的聊天标题' }); const h = await harness([saved]);
  const cases = [
    [[{ code: 'ROLLOUT_MISSING', threadId: saved.id, message: 'generic' }], /1 个聊天的会话文件缺失，无法确认最新状态/],
    [[{ code: 'ROLLOUT_MISSING', threadId: saved.id, message: 'generic' }, { code: 'ROLLOUT_MISSING', threadId: 'another', message: 'generic' }], /2 个聊天的会话文件缺失，无法确认最新状态/],
    [[{ code: 'ROLLOUT_FORMAT_ERROR', threadId: saved.id, message: 'generic' }], /1 个聊天的会话记录格式异常，无法确认最新状态/],
    [[{ code: 'ROLLOUT_READ_ERROR', threadId: saved.id, message: 'generic' }], /1 个聊天的会话记录无法读取，无法确认最新状态/],
    [[{ code: 'NATIVE_READ_ERROR', message: '原生数据库读取失败' }], /^原生数据库读取失败$/],
  ];
  for (const [errors, expected] of cases) {
    h.poll(); const call = h.calls.at(-1); const response = result([saved]);
    Object.assign(response.structuredContent, { stale: true, errors }); call.resolve(response); await tick();
    assert.match(h.ids.notice.textContent, expected);
    assert.equal(h.cards()[0].children.find((node) => node.className === 'card-title').textContent, saved.title);
  }
});


test('all card statuses show message-turn counts with unknown and partial semantics', async () => {
  const values = [
    thread('InProgress', { id: 'zero', messageTurnCount: 0, messageTurnCountIncomplete: false }),
    thread('Review', { id: 'partial', messageTurnCount: 7, messageTurnCountIncomplete: true }),
    thread('Done', { id: 'unknown', messageTurnCount: null, messageTurnCountIncomplete: true }),
  ];
  const h = await harness(values);
  const badges = h.cards().map((card) => card.children.find((node) => node.className === 'card-meta').children[1]);
  assert.equal(badges[0].children[1].textContent, '+0');
  assert.match(badges[0].title, /0 个已确认用户回合/);
  assert.match(badges[0].title, /同一回合多次输入只计 1 轮.*系统回合不计/);
  assert.equal(badges[1].children[1].textContent, '+7');
  assert.match(badges[1].title, /至少 7.*记录不完整/);
  assert.match(badges[1].className, /incomplete/);
  assert.equal(badges[1]['aria-label'], badges[1].title);
  assert.equal(badges[2].children[1].textContent, '—');
  assert.equal(badges[2].title, '无法读取消息轮数');
  assert.doesNotMatch(badges[2].className, /incomplete/);
});

test('search Escape during IME composition keeps the dialog open and query intact', async () => {
  const h = await harness([thread()]); h.ids['search-toggle'].listeners.click();
  h.ids.search.value = '正在输入中文'; let prevented = false;
  h.ids.search.listeners.keydown({ key: 'Escape', isComposing: true, preventDefault() { prevented = true; } });
  assert.equal(h.ids['search-dialog'].open, true);
  assert.equal(h.ids.search.value, '正在输入中文');
  assert.equal(prevented, false);
  h.ids.search.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(h.links.length, 0);
  h.ids.search.listeners.keydown({ key: 'Escape', isComposing: false, preventDefault() {} });
  assert.equal(h.ids['search-dialog'].open, false);
});
