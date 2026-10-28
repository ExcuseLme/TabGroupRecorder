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
  updateTabUrl, updateChildUrl,
  applyDrop,
} from "./operations.js";
import { buildExportObject, triggerDownload, importOverwrite } from "./transfer.js";
import { VirtualList, renderSkeleton, clearSkeleton } from "./render.js";
import { bindRowDrag } from "./drag.js";
import { orderForDisplay } from "./merge.js";

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
  renderGen: 0,          // 渲染代际 token:await 之后校验,防止旧渲染覆盖新 tab(P-45)
  // 快照记录正则搜索态(design-v0.6 §4);纯读派生视图,不落盘
  search: {
    active: false,
    gen: 0,              // 每次进入/退出 +1,用于丢弃过期的组快照加载结果
    query: "",
    re: null,            // null = 空查询(不过滤)
    invalid: false,      // 正则语法错误
    composing: false,    // 中文输入法组合期不编译
    snaps: null,         // { "snap:{groupId}": GroupSnapshot } 全量组快照缓存
    snapsLoading: null,  // 进行中的加载 Promise(并发去重)
    rows: [],            // 搜索投影行(不写 state.recordsRows)
    expanded: {},        // 搜索态临时展开覆盖(不落盘)
    prevScroll: 0,       // 进入搜索前的滚动位置,退出时恢复
  },
};

/** 快照图标 pageUrl 内存缓存(iconKey → pageUrl 或 "" 负缓存),避免搜索每 120ms 重渲染时重复读 storage。 */
const iconPageCache = new Map();

/* ============ t0:同步,零 await ============ */
function boot() {
  renderSkeleton();                    // 立即画骨架
  bindTabs();
  bindHeaderActions();
  bindSearchInteractions();            // 搜索按钮 / 覆盖层输入 / 结果行 mousedown 保护(design-v0.6 §4)
  bindResizeHandle();                  // 面板高度拖拽(§1.4;纯同步,不阻塞 t0)
  bindChromeRefresh();                 // 监听 Chrome 标签/分组变化 → 面板自动同步(P-29 治本,照参照 delayRefresh)
  // 面板此刻已可见;t1 紧随其后异步开始(不阻塞 t0)
  requestAnimationFrame(() => { void paint(); });
  // P-32 诊断:渲染后打印各层高度(scrollHeight vs clientHeight),定位外层滚动条归属
  setTimeout(diagnoseScroll, 500);
}

/* ============ 面板高度调整(§1.5) ============ */
// H_MAX 必须 = Chrome popup 硬上限(Chromium kExtensionPopupMaxSize = {800,600})。
// 超过它 html 会高于视口 → 外层滚动条(P-32 复发),见 docs §1.10。
const H_MIN = 260, H_MAX = 600, H_STEP = 8, H_STEP_BIG = 32;
let dragState = null;
let badgeTimer = null;

/** 徽标显隐的唯一入口(text=null 隐藏)。统一 clearTimeout,避免残留定时器误隐藏。 */
function setBadge(text) {
  const badge = document.getElementById("resize-badge");
  if (!badge) return;
  clearTimeout(badgeTimer);
  badgeTimer = null;
  if (text == null) { badge.hidden = true; return; }
  badge.textContent = text;
  badge.hidden = false;
}

/** 短暂显示徽标后自动隐藏(键盘微调用,不常驻)。 */
function flashBadge(text) {
  setBadge(text);
  badgeTimer = setTimeout(() => setBadge(null), 900);
}

/**
 * 应用高度:只改根节点 --h 变量与 data-panel-h 开关(单次布局)。
 * @param {number} h 目标高度
 * @param {{showBadge?:boolean}} opts 是否显示高度徽标
 *   —— **默认 false**:恢复持久化高度时不能显示徽标,否则每次开面板都挂着 "600 px"
 *   (P-39)。仅「主动调整」(拖拽 / 键盘)才传 true。
 */
function applyH(h, { showBadge = false } = {}) {
  const v = Math.max(H_MIN, Math.min(H_MAX, Math.round(h)));
  const root = document.documentElement;
  root.style.setProperty("--h", v + "px");
  root.dataset.panelH = "1";            // 打开"显式高度"开关(§1.3)
  if (showBadge) setBadge(v + " px");
  return v;
}

/** 当前实际渲染高度(未拖过时作为拖拽起点,从"自适应"平滑进入拖拽)。 */
function currentPanelH() {
  return Math.round(document.body.getBoundingClientRect().height);
}

/** 持久化高度(只在松手/键盘调整后写一次,拖动中不写)。 */
function persistPanelH(h) {
  const v = Math.round(h);
  state.ui.panelHeight = v;
  try { chrome.storage.local.set({ ui: state.ui }); } catch { /* 忽略 */ }
}

/** 清除持久化高度 → 恢复内容自适应(双击手柄)。 */
function resetPanelH() {
  const root = document.documentElement;
  root.style.removeProperty("--h");
  delete root.dataset.panelH;
  setBadge(null);
  delete state.ui.panelHeight;
  try { chrome.storage.local.set({ ui: state.ui }); } catch { /* 忽略 */ }
}

function bindResizeHandle() {
  const handle = document.getElementById("resize-handle");
  if (!handle) return;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragState = { startY: e.clientY, startH: currentPanelH(), id: e.pointerId };
    handle.setPointerCapture(e.pointerId);       // 关键:指针移出面板仍能收到 move
    handle.classList.add("dragging");
    document.documentElement.classList.add("resizing");
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragState || e.pointerId !== dragState.id) return;
    // 向下 = 变高;拖拽过程中实时显示徽标(这是"主动调整",应当显示)
    applyH(dragState.startH + (e.clientY - dragState.startY), { showBadge: true });
  });

  const endDrag = (e) => {
    if (!dragState || (e && e.pointerId !== dragState.id)) return;
    dragState = null;
    handle.classList.remove("dragging");
    document.documentElement.classList.remove("resizing");
    setBadge(null);                      // 松手即隐藏徽标,不常驻
    // 读回真实高度落盘,保证存储值与视觉一致
    if (document.documentElement.dataset.panelH) persistPanelH(currentPanelH());
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  // 双击:恢复自适应
  handle.addEventListener("dblclick", (e) => { e.preventDefault(); resetPanelH(); });

  // 键盘无障碍调整:徽标短暂闪现后自动消失(不常驻,见 P-39)
  handle.addEventListener("keydown", (e) => {
    const cur = currentPanelH();
    let next = null;
    if (e.key === "ArrowUp") next = cur - (e.shiftKey ? H_STEP_BIG : H_STEP);
    else if (e.key === "ArrowDown") next = cur + (e.shiftKey ? H_STEP_BIG : H_STEP);
    else if (e.key === "Home") next = H_MIN;
    else if (e.key === "End") next = H_MAX;
    if (next == null) return;
    e.preventDefault();
    const v = applyH(next);          // 不在此显示徽标
    flashBadge(v + " px");           // 短暂闪现,900ms 后自动隐藏
    persistPanelH(v);
  });
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
    // §1.6:应用上次拖拽保存的高度(必须在 t1 之后 —— t0 零 await 不能读 storage)
    if (state.ui.panelHeight) applyH(state.ui.panelHeight);
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
          // P-42/D9:捕获载荷必须携带真实 url。toCurrentTabRow 是只读展示模型(只有 pageUrl),
          // 若直接传 rowObj,组内子项会以 url=undefined 落库,导致防重永远命中同一条、导出无法再导入。
          // 注意:不能把 url 加进行模型 —— buildRow 见 url 会渲染出第二行 URL,改变「当前标签」外观。
          rowObj.buttons[0].onClick = () => doCapture({ ...rowObj, url: c.url });
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
  // §1.2:index 存储「最近捕获顺序(旧→新)」,展示层反转为「最新在上」。
  // 所有快照记录渲染路径(普通/展开/编辑后同步刷新)都复用本函数,故只此一处取序。
  for (const e of orderForDisplay(state.index)) {
    const expanded = !!state.ui.expanded[e.id];
    if (e.type === "group") {
      // v0.8:顶层条目可拖拽(整组移动,children 跟随)
      out.push({ kind: "group", id: e.id, name: e.name, color: e.color, expanded, _grp: true, draggable: true });
      if (expanded) out.push({ _needSnap: e.id });
    } else {
      // §2.3:顶层标签快照带 url → 渲染第二行(来自 index,零额外读取)
      out.push({ kind: "tab", id: e.id, name: e.name, iconKey: e.iconKey, url: e.url, draggable: true });
    }
  }
  return out;
}

async function renderCurrent() {
  const gen = ++state.renderGen;
  clearSkeleton();
  setHeader("当前标签", "(当前窗口中的所有标签和分组)", false);
  let rows = [];
  try {
    rows = await readWindow();   // popup 直连 API(§14.1)
  } catch (e) {
    console.error("readWindow 失败:", e);
  }
  // P-45:await 期间可能已切 tab / 已发起新渲染 → 旧结果直接丢弃
  if (gen !== state.renderGen || state.tab !== "current") return;
  state.currentRows = rows;
  renderList();
}

async function renderRecords() {
  const gen = ++state.renderGen;
  clearSkeleton();
  setHeader("快照记录", "(已保存的所有标签和分组快照)", true);
  await applyPendingChildEdits();          // P-19:应用 pagehide 期间的组内改名补偿
  const { index } = await getFirstPaint();  // 含补偿后的最新 index
  if (gen !== state.renderGen || state.tab !== "records") return;
  state.index = index;
  if (!state.index.length) { showEmpty("暂无快照,去「当前标签」捕获"); return; }

  // 搜索态:全量组快照缓存就绪后,按当前 query 构建只读投影行(§4)
  if (state.search.active) {
    const ok = await ensureSearchSnaps();
    if (!ok || gen !== state.renderGen || state.tab !== "records") return;
    renderSearchView();
    return;
  }

  const flat = await buildRecordsFlat();
  if (gen !== state.renderGen || state.tab !== "records") return;
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
  if (state.search.active) { renderSearchView(); return; }   // 搜索态编辑被禁用;防御性走搜索投影
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
      const key = dot.dataset.iconkey;
      if (iconPageCache.has(key)) {
        pageUrl = iconPageCache.get(key);        // 搜索期重渲染命中缓存,零 storage 读
      } else {
        pageUrl = await getIcon(key);            // 快照:storage 取 pageUrl(P-21)
        iconPageCache.set(key, pageUrl || "");   // "" = 负缓存,避免反复读取缺失图标
      }
    }
    if (pageUrl) {
      // 参照扩展:favicon 权限 + /_favicon/ 内部接口按 pageUrl 返回图片数据(无 CORS、离线可用)
      const src = `/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=36`;
      dot.innerHTML = `<img src="${src}" alt="" draggable="false" />`;   // v0.8:禁原生图片拖拽抢行拖拽
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

/**
 * §2.7 实时重复检测:判断内容是否与「其它」快照重复。
 * 数据源全部来自内存(state.index + state.recordsRows),零额外 IO。
 * 已知局限:折叠未展开分组的 children 不在检测范围内(漏报可接受,提示非门禁)。
 * @param {string} content 待检测内容
 * @param {string} selfId 自身 id(排除自己)
 * @returns {boolean}
 */
function isDupContent(content, selfId) {
  const v = (content ?? "").trim();
  if (!v) return false;
  for (const e of state.index) {                       // 顶层标签快照(必然可用)
    if (e.id === selfId) continue;
    if (e.type === "tab" && (e.url ?? "").trim() === v) return true;
  }
  for (const r of state.recordsRows) {                 // 已渲染行(含已展开分组的 children)
    if (!r || r.id === selfId) continue;
    if (r.kind === "tab" && (r.url ?? "").trim() === v) return true;
  }
  return false;
}

// 0.7.2:打开一律在后台(不转移焦点 → 面板保持开启),不再区分修饰键。
const OPEN_TITLE = "打开(后台打开)";

/** 快照记录操作按钮工厂:普通行与搜索投影行共用,避免行为分叉。 */
function recordGroupButtons(id) {
  return [
    { cls: "open", label: "打开", title: OPEN_TITLE, onClick: () => doOpenGroup(id) },
    { cls: "del", label: "删除", onClick: () => doDelete(id) },
  ];
}
function recordTabButtons(id) {
  return [
    { cls: "open", label: "打开", title: OPEN_TITLE, onClick: () => doOpenTab(id) },
    { cls: "del", label: "删除", onClick: () => doDelete(id) },
  ];
}
function recordChildButtons(parentId, childId) {
  return [
    { cls: "open", label: "打开", title: OPEN_TITLE, onClick: () => doOpenChild({ id: childId, parentId }) },
    { cls: "del", label: "删除", onClick: () => doDeleteChild({ id: childId, parentId }) },
  ];
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
      buttons: recordGroupButtons(r.id),
    };
  }
  return {
    ...r,
    onRename: (v) => renameSnapshot(r.id, v),
    onRenamed: (v) => renameIndexEntry(r.id, v),       // 同步更新内存 index(P-18/22)
    onRefresh: () => refreshRecordsSync(),              // 同步整 tab 刷新(P-18/22)
    onFlush: (v) => flushTopLevel(r.id, v),     // pagehide 同步直写(P-19)
    // §2.4 / §2.7:URL 查看 + 就地编辑 + 实时重复提示
    isDupContent: (v) => isDupContent(v, r.id),
    onUrlEdit: (v) => doEditUrlTop(r.id, v),
    onUrlRejected: (msg) => toast(msg),
    buttons: recordTabButtons(r.id),
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
    kind: "tab", id: c.id, name: c.name, iconKey: c.iconKey, url: c.url,
    child: true, parentId, draggable: true,
    onRename: (v) => renameChild(parentId, c.id, v),
    onRenamed: (v) => {                                   // 同步缓存(P-17)
      const x = state.recordsRows.find((t) => t.id === c.id);
      if (x) x.name = v;
    },
    onRefresh: () => refreshRecordsSync(),                // 同步整 tab 刷新(P-18/22)
    onFlush: (v) => flushChild(parentId, c.id, v),        // pagehide 补偿(P-19)
    // §2.4 / §2.7:URL 查看 + 就地编辑 + 实时重复提示
    isDupContent: (v) => isDupContent(v, c.id),
    onUrlEdit: (v) => doEditUrlChild(parentId, c.id, v),
    onUrlRejected: (msg) => toast(msg),
    buttons: recordChildButtons(parentId, c.id),
  };
}

/* ============ 快照记录·正则搜索(design-v0.6 §4) ============ */
// 纪律:搜索本身不写 storage;结果为只读投影行,展开只写临时 state.search.expanded。
// 匹配字段:组标题 / 组内标签标题、url / 顶层标签标题、url;new RegExp(q,"i"),不用 g。

let searchTimer = null;

function searchEls() {
  return {
    input: document.getElementById("search-input"),
    overlay: document.getElementById("search-overlay"),
  };
}

function compileSearch(q) {
  if (!q) return { re: null };
  try { return { re: new RegExp(q, "i") }; }
  catch { return { error: "正则表达式无效" }; }
}

function searchMatch(re, value) {
  return re.test(value ?? "");
}

/** 搜索投影行:只读、不绑编辑/持久化展开;打开/删除沿用普通行行为。 */
function toSearchGroupRow(e, expanded) {
  return {
    kind: "group", id: e.id, name: e.name, color: e.color, expanded,
    readonly: true,
    onToggle: () => toggleSearchExpand(e.id),   // 只写 search.expanded
    buttons: recordGroupButtons(e.id),
  };
}
function toSearchTabRow(e) {
  return {
    kind: "tab", id: e.id, name: e.name, iconKey: e.iconKey, url: e.url,
    readonly: true,
    buttons: recordTabButtons(e.id),
  };
}
function toSearchChildRow(c, parentId) {
  return {
    kind: "tab", id: c.id, name: c.name, iconKey: c.iconKey, url: c.url,
    child: true, parentId,
    readonly: true,
    buttons: recordChildButtons(parentId, c.id),
  };
}

/** 全组快照缓存:进入搜索时一次读取;并发调用共享同一 Promise。 */
async function ensureSearchSnaps() {
  const s = state.search;
  if (!s.active) return false;
  if (s.snaps) return true;
  if (s.snapsLoading) return s.snapsLoading;

  const ids = state.index.filter((e) => e.type === "group").map((e) => e.id);
  const p = getSnaps(ids)
    .then((raw) => {
      if (state.search !== s || !s.active) return false;   // 加载期间已退出/重进
      s.snaps = raw;
      return true;
    })
    .catch((e) => { console.warn("[search] 组快照加载失败:", e); return false; })
    .finally(() => { if (s.snapsLoading === p) s.snapsLoading = null; });
  s.snapsLoading = p;
  return p;
}

/**
 * 构建搜索投影列表(§4.5):
 *  - 顶层标签:标题或 url 命中;
 *  - 组:组标题命中或任一子标签命中;有 url 查询时,子标签只显示命中项,
 *        组标题命中则视为整组命中(展开后显示全部子标签);
 *  - 空查询:不过滤,展开态沿用 ui.expanded(视觉等同正常列表)。
 */
function buildSearchFlat() {
  const s = state.search;
  const re = s.re;
  const out = [];
  for (const e of orderForDisplay(state.index)) {
    if (e.type === "tab") {
      if (re && !searchMatch(re, e.name) && !searchMatch(re, e.url)) continue;
      out.push(toSearchTabRow(e));
      continue;
    }

    const snap = s.snaps?.[`snap:${e.id}`];
    const children = snap?.children || [];
    const titleHit = !re || searchMatch(re, e.name);
    const hits = re
      ? children.filter((c) => searchMatch(re, c.name) || searchMatch(re, c.url))
      : children;
    if (re && !titleHit && !hits.length) continue;

    const expanded = Object.prototype.hasOwnProperty.call(s.expanded, e.id)
      ? !!s.expanded[e.id]
      : (re ? hits.length > 0 : !!state.ui.expanded[e.id]);
    out.push(toSearchGroupRow(e, expanded));
    if (expanded) {
      // 组标题命中 = 整组命中 → 展开显示全部子标签;仅子标签命中 → 只显示命中子行
      const visible = re && !titleHit ? hits : children;
      for (const c of visible) out.push(toSearchChildRow(c, e.id));
    }
  }
  return out;
}

/** 同步重绘搜索结果(缓存已就绪,零 await)。 */
function renderSearchView({ resetScroll = false } = {}) {
  if (state.tab !== "records" || !state.search.active) return;
  state.renderGen++;                     // 使进行中的异步渲染失效
  if (state.search.invalid) {
    state.search.rows = [];
    showEmpty("正则表达式无效,请检查输入");
    syncFoldAllBtn();                    // 「全部」图标随当前结果刷新
    if (resetScroll) getList().el.scrollTop = 0;
    return;
  }
  const flat = buildSearchFlat();
  state.search.rows = flat;
  if (!flat.length) {
    showEmpty(state.search.query ? "无匹配结果" : "暂无快照,去「当前标签」捕获");
  } else {
    getList().setRows(flat);
    void hydrateIcons();
  }
  syncFoldAllBtn();                      // 搜索态「全部」按可见结果联动(0.7.1)
  if (resetScroll) getList().el.scrollTop = 0;
}

/** 搜索态折叠/展开:只写临时覆盖,不写 ui.expanded、不落盘。 */
function toggleSearchExpand(id) {
  const row = state.search.rows.find((r) => r.kind === "group" && r.id === id);
  const cur = Object.prototype.hasOwnProperty.call(state.search.expanded, id)
    ? !!state.search.expanded[id]
    : !!row?.expanded;
  state.search.expanded[id] = !cur;
  renderSearchView();
}

/** 覆盖层显隐 + 被遮住按钮的可用态(避免 Tab/Enter 误触导出/导入)。 */
function showSearchOverlay(show) {
  const { input, overlay } = searchEls();
  if (overlay) overlay.hidden = !show;
  for (const id of ["btn-search", "btn-export", "btn-import"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = show;
  }
  // 「展开/收起全部」搜索态保持可用(0.7.1):作用于当前结果,见 onFoldAllClick / anyGroupExpanded
  if (!show && input) {
    input.value = "";
    input.classList.remove("invalid");
  }
}

async function enterSearch() {
  const s = state.search;
  if (s.active || state.tab !== "records") return;
  s.active = true;
  s.gen++;
  s.query = "";
  s.re = null;
  s.invalid = false;
  s.composing = false;
  s.snaps = null;
  s.snapsLoading = null;
  s.rows = [];
  s.expanded = {};
  s.prevScroll = getList().el.scrollTop;

  showSearchOverlay(true);
  const { input } = searchEls();
  input.value = "";
  input.focus();

  const ok = await ensureSearchSnaps();
  if (!ok || !state.search.active || state.tab !== "records") return;
  renderSearchView({ resetScroll: true });
}

/** 退出搜索:清状态、恢复按钮、恢复正常列表与原滚动位置。 */
function exitSearch({ rerender = true } = {}) {
  const s = state.search;
  if (!s.active) return;
  const prev = s.prevScroll || 0;
  s.gen++;
  s.active = false;
  s.query = "";
  s.re = null;
  s.invalid = false;
  s.composing = false;
  s.snaps = null;
  s.snapsLoading = null;
  s.rows = [];
  s.expanded = {};
  s.prevScroll = 0;
  clearTimeout(searchTimer);
  searchTimer = null;
  showSearchOverlay(false);

  if (rerender && state.tab === "records") {
    void renderRecords().then(() => {
      if (state.tab === "records" && !state.search.active) getList().el.scrollTop = prev;
    });
  }
}

function onSearchInput() {
  if (!state.search.active || state.search.composing) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applySearchQuery, 120);   // 120ms 防抖,与 scheduleRefresh 一致
}

function applySearchQuery() {
  if (!state.search.active) return;
  const { input } = searchEls();
  const q = input.value;
  state.search.query = q;
  state.search.expanded = {};                        // D8:查询变化清空临时展开
  const c = compileSearch(q);
  state.search.re = c.re || null;
  state.search.invalid = !!c.error;
  input.classList.toggle("invalid", state.search.invalid);
  renderSearchView({ resetScroll: true });
}

/** 搜索交互绑定:按钮 / 输入 / 失焦 / Esc / IME / 结果行点击保护。 */
function bindSearchInteractions() {
  const { input } = searchEls();
  document.getElementById("btn-search").addEventListener("click", () => { void enterSearch(); });

  input.addEventListener("input", onSearchInput);
  input.addEventListener("compositionstart", () => { state.search.composing = true; });
  input.addEventListener("compositionend", () => {
    state.search.composing = false;
    onSearchInput();
  });
  // 需求:焦点离开后退出搜索。点击结果行时通过取消 mousedown 默认聚焦保住输入焦点,
  // 否则 blur → 同步重渲染会在 mouseup/click 前销毁按钮,导致「打开/删除」点击丢失。
  input.addEventListener("blur", () => { if (state.search.active) exitSearch(); });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    exitSearch();
    input.blur();
  });
  document.getElementById("list").addEventListener("mousedown", (e) => {
    if (!state.search.active) return;
    if (e.target.closest(".row")) e.preventDefault();
  }, true);
  // 搜索态点击「展开/收起全部」也不能让输入框失焦,否则 click 前已退出搜索、作用到全量列表
  document.getElementById("btn-fold-all").addEventListener("mousedown", (e) => {
    if (state.search.active) e.preventDefault();
  });
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

/* ============ 打开(0.7.2:一律后台,面板保持开启) ============ */
// 后台打开 = chrome.tabs.create({ active:false }):不转移焦点 → popup 不被销毁。
// 不再读取 Ctrl/Cmd 修饰键(0.5.0 的「Ctrl 后台打开」已成为唯一且默认的行为)。

/** 统一处理打开结果反馈(§2.8)。 */
function handleOpenResult(r) {
  if (!r) return;
  if (r.ok) {
    toast("已后台打开");
    return;
  }
  if (r.copy) {
    // bookmarklet:尝试复制,给明确退出路径(§2.8)
    navigator.clipboard?.writeText(r.copy)
      .then(() => toast("bookmarklet 无法由扩展执行,已复制,可粘贴到地址栏运行"))
      .catch(() => toast(r.error || "打开失败"));
    return;
  }
  toast(r.error || "打开失败");
}

async function doOpenTab(id) {
  const s = await findSnap(id);
  if (!s) return;
  handleOpenResult(await openTabSnapshot(s));
}
async function doOpenGroup(id) {
  const s = await findSnap(id);
  if (!s) return;
  handleOpenResult(await openGroupSnapshot(s));
}
async function doOpenChild(row) {
  const g = await findSnap(row.parentId);
  const c = g?.children?.find((x) => x.id === row.id);
  if (!g || !c) return;
  handleOpenResult(await openChildSnapshot(g, c));
}

/* ============ §2.4 URL 编辑 ============ */
/** 顶层标签快照改 URL:写盘 + 同步缓存 + 同步重建列表(P-18/P-22 纪律)。 */
async function doEditUrlTop(id, url) {
  const r = await updateTabUrl(id, url);
  if (!r.ok) return r;
  // 同步更新内存 index,避免切 tab 后回退(P-17 同类)
  const i = state.index.findIndex((e) => e.id === id);
  if (i !== -1) {
    const next = state.index.slice();
    next[i] = { ...next[i], url: r.url, updatedAt: Date.now() };
    state.index = next;
  }
  const cached = state.recordsRows.find((t) => t.id === id);
  if (cached) cached.url = r.url;
  refreshRecordsSync();
  return { ok: true };
}

/** 组内标签快照改 URL:只改该 child。 */
async function doEditUrlChild(groupId, childId, url) {
  const r = await updateChildUrl(groupId, childId, url);
  if (!r.ok) return r;
  const cached = state.recordsRows.find((t) => t.id === childId);
  if (cached) cached.url = r.url;
  refreshRecordsSync();
  return { ok: true };
}

async function doDelete(id) {
  const r = await deleteSnapshot(id);
  if (r.ok) {
    if (state.search.active) state.search.snaps = null;   // 搜索缓存失效,重读组快照
    toast("已删除"); await reloadIndex(); await renderRecords();
  }
}
async function doDeleteChild(row) {
  const r = await deleteChild(row.parentId, row.id);
  if (r.ok) {
    if (state.search.active) state.search.snaps = null;
    toast("已从分组中删除"); await reloadIndex(); await renderRecords();
  }
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

/* ============ v0.8 拖拽排序(design-v0.8.md) ============ */
/** 拖拽落点 → 持久化 → 重读 index 并整表重渲染;失败 toast 且回到存储真实状态。 */
async function handleRowDrop(source, drop) {
  const r = await applyDrop(source, drop);
  if (!r.ok) {
    toast(r.error || "移动失败");
    return r;
  }
  if (r.changed) {
    await reloadIndex();
    await renderRecords();
  }
  return r;
}

/** 拖动悬停在折叠组上 → 展开(只展开,不收起;展开态本身是持久化 UI 状态)。 */
function expandGroupForDrag(groupId) {
  if (!state.ui.expanded[groupId]) void toggleExpand(groupId);
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
      exitSearch({ rerender: false });   // 切 tab 显式退出搜索(不依赖 blur 副作用)
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
  if (state.search.active) {
    // 搜索态:以当前结果行的实际展开态为准(含临时 search.expanded 覆盖)
    return state.search.rows.some((r) => r.kind === "group" && r.expanded);
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
  } else if (state.search.active) {
    // 搜索态(0.7.1):只作用于当前结果中可见的组,写临时展开、不落盘,搜索保持打开
    for (const r of state.search.rows) {
      if (r.kind === "group") state.search.expanded[r.id] = expand;
    }
    renderSearchView();            // 内部会重算行并 syncFoldAllBtn
    return;
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
    exitSearch({ rerender: false });   // 导入后不复用旧 query(通常不可达,防御)
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
// v0.8:快照记录行拖拽排序 / 跨组移动(仅在 records tab 且非搜索态可用)
bindRowDrag({
  list: document.getElementById("list"),
  canStart: () => state.tab === "records" && !state.search.active,
  onDrop: handleRowDrop,
  onAutoExpand: expandGroupForDrag,
});
boot();
