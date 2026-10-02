// popup 主入口:严格 t0 / t1 / t2 时序(§4.4)。
// t0:同步渲染静态壳 + 骨架,零 await —— 面板可见性不依赖任何数据。
// t1:(面板已可见后)异步拉 index/meta/ui。
// t2:视口内懒取图标。

import { getFirstPaint, getSnaps, getIcon, writeBatch } from "./storage.js";
import { readWindow } from "./capture.js";
import {
  capture, openTabSnapshot, openGroupSnapshot, openChildSnapshot,
  renameSnapshot, deleteSnapshot, deleteChild,
  toggleAllBrowserGroups,
} from "./operations.js";
import { buildExportObject, triggerDownload, importOverwrite } from "./transfer.js";
import { VirtualList, renderSkeleton, clearSkeleton } from "./render.js";

/** 「展开/折叠全部」按钮图标(纵向双箭头,与状态图标风格一致)。 */
const SVG_UNFOLD_ALL = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 6L8 2L12.5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 10L8 14L12.5 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_FOLD_ALL = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 2L8 6L12.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 14L8 10L12.5 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const state = {
  tab: "current",        // current | records
  // 快照记录的展开状态(持久化;与当前标签隔离,P-20)
  ui: { expanded: {} },
  index: [],
  currentRows: [],       // 当前标签行(readWindow 结果)
  recordsRows: [],       // 快照记录扁平行
  recordsLoaded: false,
};

/* ============ t0:同步,零 await ============ */
function boot() {
  renderSkeleton();                    // 立即画骨架
  bindTabs();
  bindHeaderActions();
  bindChromeRefresh();                 // 监听 Chrome 标签/分组变化 → 面板自动同步(P-29 治本,照参照 delayRefresh)
  // 面板此刻已可见;t1 紧随其后异步开始(不阻塞 t0)
  requestAnimationFrame(() => { void paint(); });
  // P-32 诊断:渲染后打印各层高度(scrollHeight vs clientHeight),定位外层滚动条归属
  setTimeout(diagnoseScroll, 500);
}

/** P-32 诊断:哪层 scrollHeight > clientHeight,滚动条就属于谁。 */
function diagnoseScroll() {
  const html = document.documentElement;
  const body = document.body;
  const list = document.getElementById("list");
  console.log(`[P-32] html: scrollH=${html.scrollHeight} clientH=${html.clientHeight} 溢出=${html.scrollHeight > html.clientHeight}`);
  console.log(`[P-32] body: scrollH=${body.scrollHeight} clientH=${body.clientHeight} 溢出=${body.scrollHeight > body.clientHeight}`);
  if (list) console.log(`[P-32] list: scrollH=${list.scrollHeight} clientH=${list.clientHeight} 溢出=${list.scrollHeight > list.clientHeight}(此为合理的列表内滚动)`);
  console.log(`[P-32] 窗口: innerHeight=${window.innerHeight} visualViewport=${window.visualViewport?.height}`);
  // 找出 body 直属子元素中高度之和是否超 body(定位超高元素)
  let sum = 0;
  for (const el of body.children) { sum += el.getBoundingClientRect().height; }
  console.log(`[P-32] body 直属子元素高度和=${sum.toFixed(1)}(含 ${body.children.length} 个)`);
}

/* Chrome 变化 → 面板自动刷新(防抖):面板永远是 Chrome 的投影,消除状态"相反"(P-29) */
let refreshTimer = null;
function scheduleRefresh() {
  if (state.tab !== "current") return;      // 仅当前标签 tab 关心 Chrome 变化
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { void renderCurrent(); }, 120);
}
function bindChromeRefresh() {
  try {
    chrome.tabGroups.onCreated?.addListener(scheduleRefresh);
    chrome.tabGroups.onUpdated?.addListener(scheduleRefresh);
    chrome.tabGroups.onRemoved?.addListener(scheduleRefresh);
    chrome.tabs.onCreated?.addListener(scheduleRefresh);
    chrome.tabs.onRemoved?.addListener(scheduleRefresh);
    chrome.tabs.onUpdated?.addListener(scheduleRefresh);
  } catch (e) { console.warn("[refresh] 监听注册失败:", e); }
}

/* ============ t1:异步数据 ============ */
async function paint() {
  try {
    const { index, ui } = await getFirstPaint();
    state.index = index;
    state.ui = ui || { expanded: {} };
    state.tab = "current";   // 每次展开面板始终进入「当前标签」(问题1)
    syncTabs();

    if (state.tab === "current") await renderCurrent();
    else await renderRecords();
  } catch (e) {
    console.error("paint 失败:", e);
    showEmpty("加载失败,请重试");
  }
}

/**
 * 统一渲染入口:数据 → 扁平化 → setRows。
 * 两个 tab 共用同一条数据流(消除 renderCurrent / renderRecords / toggle 三处分叉),
 * 这是 P-06(展开不插子行)的结构性根治。
 */
function renderList() {
  const flat = state.tab === "current"
    ? flattenCurrent(state.currentRows)
    : flattenRecords();
  getList().setRows(flat);
  void hydrateIcons();   // 当前标签图标异步渲染(P-25:dataset.pageurl → /_favicon);与 renderRecords 一致
  syncFoldAllBtn();      // 每次列表渲染同步「展开/折叠全部」按钮状态
}

/**
 * 当前标签扁平化:顶层行 + 展开分组的子标签行。
 * 展开态 = 浏览器真实 collapsed 的反值(当前标签是 Chrome 实时镜像,toggle 后重读 Chrome)。
 * —— 与快照记录的 ui.expanded 完全隔离,保证与 Chrome 标签栏状态一致(P-20 / P-29)。
 */
function flattenCurrent(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind === "group") {
      // 单一真相:面板展开态 = Chrome 真实 collapsed 的反值,不设面板状态层(P-29,照参照扩展)
      const expanded = !r.collapsed;
      out.push(toCurrentGroupRow(r, expanded));
      if (expanded) {
        for (const c of r.children || []) {
          // 组内子标签:构造完整行对象(含父分组上下文 groupRef),再让 onClick 指向它——
          // 否则闭包捕获的是原始 c,拿不到 groupRef(P-23 根因)。
          const rowObj = {
            ...toCurrentTabRow(c),
            child: true,
            groupRef: { name: r.name, color: r.color },
          };
          rowObj.buttons[0].onClick = () => doCapture(rowObj);
          out.push(rowObj);
        }
      }
    } else {
      out.push(toCurrentTabRow(r));
    }
  }
  return out;
}

/** 快照记录扁平化占位:顶层行 + 展开分组的 _needSnap 占位(稍后批量补 children)。 */
function flattenRecords() {
  const out = [];
  for (const e of state.index) {
    const expanded = !!state.ui.expanded[e.id];
    if (e.type === "group") {
      out.push({ kind: "group", id: e.id, name: e.name, color: e.color, expanded, _grp: true });
      if (expanded) out.push({ _needSnap: e.id });
    } else {
      out.push({ kind: "tab", id: e.id, name: e.name, iconKey: e.iconKey });
    }
  }
  return out;
}

async function renderCurrent() {
  clearSkeleton();
  setHeader("当前标签", "(当前窗口中的所有标签和分组)", false);
  try {
    state.currentRows = await readWindow();   // popup 直连 API(§14.1)
  } catch (e) {
    console.error("readWindow 失败:", e);
    state.currentRows = [];
  }
  renderList();
}

async function renderRecords() {
  clearSkeleton();
  setHeader("快照记录", "(已保存的所有标签和分组快照)", true);
  await applyPendingChildEdits();          // P-19:应用 pagehide 期间的组内改名补偿
  const { index } = await getFirstPaint();  // 含补偿后的最新 index
  state.index = index;
  if (!state.index.length) { showEmpty("暂无快照,去「当前标签」捕获"); return; }

  const flat = await buildRecordsFlat();
  state.recordsRows = flat;
  getList().setRows(flat);
  void hydrateIcons();
}

/**
 * 扁平化快照记录(需读 snap 补 children,故 async)。
 * 结构:顶层行 + 展开分组的 _needSnap 占位 → 批量拉 snap 展开 children。
 */
async function buildRecordsFlat() {
  const placeholder = flattenRecords();
  const needIds = placeholder.filter((r) => r._needSnap).map((r) => r._needSnap);
  const snaps = await getSnaps(needIds);

  const flat = [];
  for (const r of placeholder) {
    if (r._needSnap) {
      const s = snaps[`snap:${r._needSnap}`];
      for (const c of s?.children || []) {
        flat.push(toRecordChildRow(c, r._needSnap));
      }
    } else {
      flat.push(bindRecordRow(r));
    }
  }
  return flat;
}

/**
 * 完成编辑后的**同步**整 tab 刷新(P-18/P-22):基于内存 state(已 flush+reload)同步
 * 重建并渲染,不做任何 await —— 用户在错乱/丢按钮出现前即看到刷新后的正确列表。
 * 展开分组的 children 复用上一次的 recordsRows(编辑只改名,children 结构不变)。
 */
function refreshRecordsSync() {
  if (state.tab !== "records") return;
  const placeholder = flattenRecords();
  const out = [];
  for (const r of placeholder) {
    if (r._needSnap) continue;               // children 由下方按组补入
    out.push(bindRecordRow(r));
    if (r.kind === "group" && r.expanded) {
      for (const old of state.recordsRows) { // 复用旧 children 行(名称已同步更新)
        if (old.child && old.parentId === r.id) out.push(old);
      }
    }
  }
  state.recordsRows = out;
  getList().setRows(out);
  void hydrateIcons();
}

/* t2:视口内图标懒取(当前标签 pageUrl 直取 / 快照 iconKey 查 storage,统一走 /_favicon) */
async function hydrateIcons() {
  // getList() 返回 VirtualList 实例(无 querySelectorAll);直接查 document(P-21)
  const imgs = document.querySelectorAll("#list .dot:not([data-iconed])");
  for (const dot of imgs) {
    let pageUrl = dot.dataset.pageurl;          // 当前标签:直接带(P-25)
    if (!pageUrl && dot.dataset.iconkey) {
      pageUrl = await getIcon(dot.dataset.iconkey);  // 快照:storage 取 pageUrl(P-21)
    }
    if (pageUrl) {
      // 参照扩展:favicon 权限 + /_favicon/ 内部接口按 pageUrl 返回图片数据(无 CORS、离线可用)
      const src = `/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=36`;
      dot.innerHTML = `<img src="${src}" alt="" />`;
    }
    dot.setAttribute("data-iconed", "1");
  }
}

/* ============ 行模型(按 tab / 类型拆分,绑定行为) ============ */

/** 当前标签·分组行:单一真相 = Chrome 真实状态(照参照扩展 onCollapseClick)。 */
function toCurrentGroupRow(r, expanded) {
  return {
    kind: "group", name: r.name, color: r.color, expanded,
    readonly: true,
    onToggle: async () => {
      try {
        // 照参照:读 Chrome 真实状态 → 取反 → 写回 → 重读渲染(面板=Chrome 投影,不会相反)
        const cur = await chrome.tabGroups.get(r.groupId);
        const next = !cur.collapsed;
        await chrome.tabGroups.update(r.groupId, { collapsed: next });
        await renderCurrent();               // 重读 Chrome,r.collapsed 更新 → flatten 取新值
      } catch (e) {
        console.warn("[P-29] 折叠失败(Chrome 145 已知 bug?§13):", e);
      }
    },
    buttons: [{ cls: "cap", label: "捕获", onClick: () => doCapture(r) }],
    children: r.children,
  };
}

/** 当前标签·标签行(只读,可捕获)。图标统一走 /_favicon/?pageUrl=(P-25,与快照记录一致)。 */
function toCurrentTabRow(r) {
  return {
    kind: "tab", name: r.name,
    pageUrl: r.url || null,                 // 直接用 tab.url,渲染走 /_favicon(P-25)
    readonly: true,
    buttons: [{ cls: "cap", label: "捕获", onClick: () => doCapture(r) }],
  };
}

/** 快照记录·顶层行绑定行为。 */
function bindRecordRow(r) {
  if (r.kind === "group") {
    return {
      ...r,
      onToggle: () => toggleExpand(r.id),
      onRename: (v) => renameSnapshot(r.id, v),
      onRenamed: (v) => renameIndexEntry(r.id, v),   // 同步更新内存 index(P-18/22)
      onRefresh: () => refreshRecordsSync(),          // 同步整 tab 刷新(P-18/22)
      onFlush: (v) => flushTopLevel(r.id, v),   // pagehide 同步直写(P-19)
      buttons: [
        { cls: "open", label: "打开", onClick: () => doOpenGroup(r.id) },
        { cls: "del", label: "删除", onClick: () => doDelete(r.id) },
      ],
    };
  }
  return {
    ...r,
    onRename: (v) => renameSnapshot(r.id, v),
    onRenamed: (v) => renameIndexEntry(r.id, v),       // 同步更新内存 index(P-18/22)
    onRefresh: () => refreshRecordsSync(),              // 同步整 tab 刷新(P-18/22)
    onFlush: (v) => flushTopLevel(r.id, v),     // pagehide 同步直写(P-19)
    buttons: [
      { cls: "open", label: "打开", onClick: () => doOpenTab(r.id) },
      { cls: "del", label: "删除", onClick: () => doDelete(r.id) },
    ],
  };
}

/** 同步更新内存 state.index 中该条的名称(避免 async 重读 storage 的中间态)。 */
function renameIndexEntry(id, name) {
  const i = state.index.findIndex((e) => e.id === id);
  if (i !== -1) {
    const next = state.index.slice();
    next[i] = { ...next[i], name, updatedAt: Date.now() };
    state.index = next;
  }
  const cached = state.recordsRows.find((t) => t.id === id);
  if (cached) cached.name = name;
}

/** 快照记录·组内子标签行。 */
function toRecordChildRow(c, parentId) {
  return {
    kind: "tab", id: c.id, name: c.name, iconKey: c.iconKey,
    child: true, parentId,
    onRename: (v) => renameChild(parentId, c.id, v),
    onRenamed: (v) => {                                   // 同步缓存(P-17)
      const x = state.recordsRows.find((t) => t.id === c.id);
      if (x) x.name = v;
    },
    onRefresh: () => refreshRecordsSync(),                // 同步整 tab 刷新(P-18/22)
    onFlush: (v) => flushChild(parentId, c.id, v),        // pagehide 补偿(P-19)
    buttons: [
      { cls: "open", label: "打开", onClick: () => doOpenChild({ id: c.id, parentId }) },
      { cls: "del", label: "删除", onClick: () => doDeleteChild({ id: c.id, parentId }) },
    ],
  };
}

/* ============ 操作 ============ */
async function doCapture(row) {
  try {
    const r = await capture(row);
    // 重复捕获 → 删旧建新,作为最新快照(P-24)
    toast(r.replaced ? "已重新捕获为最新快照" : "已捕获到快照记录");
    await reloadIndex();
  } catch (e) {
    console.error(e); toast("捕获失败");
  }
}

async function doOpenTab(id) {
  const s = await findSnap(id);
  if (s) await openTabSnapshot(s);
}
async function doOpenGroup(id) {
  const s = await findSnap(id);
  if (s) await openGroupSnapshot(s);
}
async function doOpenChild(row) {
  const g = await findSnap(row.parentId);
  const c = g?.children?.find((x) => x.id === row.id);
  if (g && c) await openChildSnapshot(g, c);
}
async function doDelete(id) {
  const r = await deleteSnapshot(id);
  if (r.ok) { toast("已删除"); await reloadIndex(); await renderRecords(); }
}
async function doDeleteChild(row) {
  const r = await deleteChild(row.parentId, row.id);
  if (r.ok) { toast("已从分组中删除"); await reloadIndex(); await renderRecords(); }
}

/** 组内标签重命名:仅改 snap.children 中对应项,不改 index(其他问题2)。 */
async function renameChild(groupId, childId, name) {
  const { [`snap:${groupId}`]: snap } = await getSnaps([groupId]);
  if (!snap || snap.type !== "group") return { ok: false };
  const children = snap.children.map((c) => c.id === childId ? { ...c, name } : c);
  await writeBatch({
    [`snap:${groupId}`]: { ...snap, children, updatedAt: Date.now() },
  });
  // 同步缓存,避免切 tab 后回退为旧标题(其他问题2.1)
  const cached = state.recordsRows.find((r) => r.id === childId);
  if (cached) cached.name = name;
  return { ok: true };
}
async function toggleExpand(id) {
  const next = !state.ui.expanded[id];
  state.ui.expanded[id] = next;
  try { await chrome.storage.local.set({ ui: state.ui }); } catch { /* 忽略 */ }
  await renderRecords();
  // 快照记录是本地持久化数据,展开/折叠**不绑定 Chrome**(与「全部」分支一致;P-30)
}

async function findSnap(id) {
  const map = await getSnaps([id]);
  return map[`snap:${id}`];
}

/* ============ P-19:pagehide 同步落盘 ============ */
/**
 * 顶层快照(独立标签/组):pagehide 时**同步**读改写,不走 renameSnapshot 的异步读链。
 * chrome.storage.local.get/set 是 Promise 但本地即取,popup 销毁前足以完成;
 * 若极端情况下未完成,下次 renderRecords 由 pendingChild 同思路兜底(此处直接覆盖 index)。
 */
function flushTopLevel(id, name) {
  try {
    chrome.storage.local.get(["index", `snap:${id}`], (data) => {
      const index = Array.isArray(data.index) ? data.index : [];
      const i = index.findIndex((e) => e.id === id);
      const snap = data[`snap:${id}`];
      const now = Date.now();
      const next = index.slice();
      if (i !== -1) next[i] = { ...index[i], name, updatedAt: now };
      const batch = { index: next, meta: buildMetaLocal(next) };
      if (snap) batch[`snap:${id}`] = { ...snap, name, updatedAt: now };
      chrome.storage.local.set(batch, () => {});
    });
  } catch (e) { console.error("flushTopLevel 失败", e); }
}

/** 组内子标签:需先读 group,pagehide 下读链可能来不及 → 记 pending,下次渲染补偿。 */
function flushChild(groupId, childId, name) {
  pendingChildEdits.set(childId, { groupId, childId, name });
  // 尝试立即应用(能成就成)
  applyPendingChildEdits();
}

/** 待应用的组内改名(pagehide 后补偿)。 */
const pendingChildEdits = new Map();

/** 在 renderRecords 前应用所有 pending 组内改名,保证下次打开显示新名(P-19)。 */
async function applyPendingChildEdits() {
  if (!pendingChildEdits.size) return;
  const edits = [...pendingChildEdits.values()];
  pendingChildEdits.clear();
  for (const e of edits) {
    try {
      const data = await getSnaps([e.groupId]);
      const snap = data[`snap:${e.groupId}`];
      if (!snap || snap.type !== "group") continue;
      const children = snap.children.map((c) => c.id === e.childId ? { ...c, name: e.name } : c);
      await writeBatch({ [`snap:${e.groupId}`]: { ...snap, children, updatedAt: Date.now() } });
    } catch (err) { console.error("补偿组内改名失败", err); }
  }
}

/** 本地 buildMeta(避免 import 循环;与 storage.buildMeta 一致)。 */
function buildMetaLocal(index) {
  let tabs = 0, groups = 0;
  for (const e of index) { if (e.type === "group") groups++; else tabs++; }
  return { schemaVersion: 1, counts: { tabs, groups }, sizeBytes: 0, updatedAt: Date.now() };
}
async function reloadIndex() {
  const { index, ui } = await getFirstPaint();
  state.index = index;
  // 不整体覆盖 state.ui(会把内存展开态盖成存储态 → 提交后重渲染展开集合突变、
  // 观感顺序变化,P-22);仅把存储中新增的展开标记合并进来,保留当前内存态。
  const storedExpanded = ui?.expanded || {};
  state.ui = { ...state.ui, ...ui, expanded: { ...storedExpanded, ...state.ui.expanded } };
}

/* ============ UI 绑定 ============ */
function getList() { return vlist; }
let vlist;

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const t = btn.dataset.tab;
      if (t === state.tab) return;
      state.tab = t;
      syncTabs();
      // 不再持久化 activeTab(问题1:每次展开始终回到当前标签)
      // 重新渲染:renderRecords 每次从 index/snap 重建,读到最新名称(其他问题2.1)
      if (t === "current") await renderCurrent();
      else await renderRecords();
    });
  });
}
function syncTabs() {
  document.querySelectorAll(".tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === state.tab));
}

/* ============ 标题行「展开/折叠全部」按钮(参照扩展 collapseAll 交互) ============ */

/** 计算当前 tab 是否"有任一分组展开"(→ 显示"收起全部",否则"展开全部")。 */
function anyGroupExpanded() {
  if (state.tab === "current") {
    return state.currentRows.some((r) => r.kind === "group" && !r.collapsed);  // Chrome 真值(P-29 单一真相)
  }
  return state.index.some((e) => e.type === "group" && state.ui.expanded[e.id]);
}

/** 同步"全部"按钮的图标 + hover 文案(按 tab 与当前状态)。 */
function syncFoldAllBtn() {
  const btn = document.getElementById("btn-fold-all");
  if (!btn) return;
  const expand = !anyGroupExpanded();           // 是否执行"展开"
  const noun = state.tab === "current" ? "标签组" : "标签组快照";
  const word = expand ? "展开" : "收起";
  btn.title = `${word}全部${noun}`;             // hover 提示(即时,无过渡)
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = expand ? SVG_UNFOLD_ALL : SVG_FOLD_ALL;   // 图标随状态
  btn.dataset.expand = expand ? "1" : "";
}

/** 点击「全部」:面板内所有分组同步翻转 + 浏览器所有标签组同步(§13 兜底)。 */
async function onFoldAllClick() {
  const expand = !anyGroupExpanded();
  if (state.tab === "current") {
    // 当前标签:写 Chrome 全部 → 重读渲染(单一真相,照参照;§13 兜底)
    await toggleAllBrowserGroups(!expand);
    await renderCurrent();
  } else {
    // 快照记录:本地快照列表,仅作用于本 tab,不触碰 Chrome(P-28)
    for (const e of state.index) {
      if (e.type === "group") state.ui.expanded[e.id] = expand;
    }
    try { await chrome.storage.local.set({ ui: state.ui }); } catch { /* 忽略 */ }
    await renderRecords();
  }
  syncFoldAllBtn();
}

function setHeader(title, sub, showActions) {
  document.getElementById("header-title").textContent = title;
  document.getElementById("header-sub").textContent = sub;
  document.getElementById("header-actions").hidden = !showActions;
  document.getElementById("capture-all-wrap").hidden = showActions;  // 两组按钮互斥
  syncFoldAllBtn();                            // 更新"全部"按钮状态/文案
}

function bindHeaderActions() {
  document.getElementById("btn-fold-all").addEventListener("click", onFoldAllClick);
  document.getElementById("btn-capture-all").addEventListener("click", onCaptureAll);
  document.getElementById("btn-export").addEventListener("click", onExport);
  document.getElementById("btn-import").addEventListener("click", () =>
    document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", onImportFile);
}

/** 捕获全部当前标签/分组(补充需求1)。 */
async function onCaptureAll() {
  try {
    let okCount = 0, deduped = 0;
    for (const r of state.currentRows) {
      const res = await capture(r);
      if (res?.deduped) deduped++;
      else if (res?.ok) okCount++;
    }
    await reloadIndex();
    toast(`捕获完成:新增 ${okCount} 条${deduped ? `,跳过重复 ${deduped} 条` : ""}`);
  } catch (e) { console.error(e); toast("捕获全部失败"); }
}

async function onExport() {
  try {
    const obj = await buildExportObject();
    await triggerDownload(obj);
    toast("已触发导出下载");
  } catch (e) { console.error(e); toast("导出失败"); }
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    let obj;
    try { obj = JSON.parse(text); }
    catch { toast("文件不是合法 JSON"); return; }
    const r = await importOverwrite(obj);
    if (!r.ok) { toast(`校验失败:${r.error}`); return; }
    toast("导入成功");
    await reloadIndex();
    state.tab = "records"; syncTabs();
    await renderRecords();
  } catch (err) { console.error(err); toast("导入失败"); }
}

function showEmpty(msg) {
  const el = document.getElementById("list");
  el.classList.remove("skeleton");
  el.innerHTML = `<div class="empty">${msg}</div>`;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ============ 启动 ============ */
vlist = new VirtualList(document.getElementById("list"));
boot();
