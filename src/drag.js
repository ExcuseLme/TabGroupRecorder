// 快照记录行拖拽控制器(v0.8.0,design-v0.8.md §5;v0.9.0 增加落点层级视觉区分,见 design-v0.9.md)。
// 只做 DOM 交互与落点计算,不读写 storage;持久化由 onDrop 回调(operations.applyDrop)负责。
//
// 纪律:
//  - 指针捕获挂在稳定的 #list 上(行会被重渲染替换,挂在行上会丢捕获);
//  - 拖动中不整表重渲染、不写 storage;松手只提交一次;
//  - 指针坐标先 clamp 到列表矩形,指针移出面板时落点仍停在列表边缘。

const DRAG_THRESHOLD = 4;      // px:超过才进入拖动态(防误触)
const EDGE_ZONE = 28;          // px:距列表上下边缘多少开始自动滚动
const SCROLL_STEP = 10;        // px/帧
const AUTO_EXPAND_MS = 550;    // ms:悬停折叠组多久自动展开

/** 行内已有交互的元素:从其按下不启动拖拽(交给原有行为)。 */
const EXCLUDE_SELECTOR = ".state-icon, .row-title, .url-field, .url-input, .btn, button";
/** 就地编辑进行中:不启动拖拽(先让失焦提交发生)。 */
const EDITING_SELECTOR =
  '.row-title[contenteditable="true"], .url-input[contenteditable="true"]';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * 绑定列表行拖拽。
 * @param {{
 *   list: HTMLElement,
 *   canStart: () => boolean,
 *   onDrop: (source: any, drop: any) => any,
 *   onAutoExpand?: (groupId: string) => void,
 * }} opts
 */
export function bindRowDrag({ list, canStart, onDrop, onAutoExpand }) {
  if (!list) return { destroy() {} };

  const st = {
    phase: "idle",        // idle | pending | active | busy
    pointerId: null,
    startX: 0, startY: 0, lastX: 0, lastY: 0,
    offsetX: 0, offsetY: 0,
    source: null,         // {kind:'group'|'tab'|'child', id, parentId?}
    sourceRow: null,
    ghost: null,
    indicator: null,
    highlightGroupId: null,  // 当前高亮的组(组内落点)
    drop: null,           // {kind:'top', pos} | {kind:'child', groupId, pos} | {kind:'into', groupId}
    expandTimer: null,
    expandTargetId: null,
    raf: 0,
  };

  /* ---------- DOM 查询 ---------- */
  const allRows = () => Array.from(list.querySelectorAll(".row"));

  function groupRowById(id) {
    return allRows().find(
      (r) => r.dataset.kind === "group" && r.dataset.id === id && r.dataset.child !== "1"
    ) || null;
  }
  function topRows() {
    return allRows().filter((r) => r.dataset.child !== "1");
  }
  function topIndex(rowEl) {
    return topRows().indexOf(rowEl);
  }
  function childRows(gid) {
    return allRows().filter(
      (r) => r.dataset.child === "1" && r.dataset.parent === gid
    );
  }
  /** 组条目视觉块的最后一行(展开时越过全部 child 行)。 */
  function blockEndRow(groupRow) {
    const gid = groupRow.dataset.id;
    let last = groupRow;
    let n = groupRow.nextElementSibling;
    while (n && n.classList && n.classList.contains("row") && n.dataset.parent === gid) {
      last = n;
      n = n.nextElementSibling;
    }
    return last;
  }

  /** 指针下的行;命中不了列表 padding 时取纵向最近的可见行。 */
  function rowAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const hit = el && el.closest ? el.closest(".row") : null;
    if (hit && list.contains(hit)) return hit;

    let best = null;
    let bestDist = Infinity;
    for (const r of allRows()) {
      const rc = r.getBoundingClientRect();
      const d = y < rc.top ? rc.top - y : y > rc.bottom ? y - rc.bottom : 0;
      if (d < bestDist) { bestDist = d; best = r; }
    }
    return best;
  }

  function readSource(rowEl) {
    const id = rowEl.dataset.id;
    if (!id) return null;
    if (rowEl.dataset.child === "1") {
      const parentId = rowEl.dataset.parent || "";
      return parentId ? { kind: "child", id, parentId } : null;
    }
    const kind = rowEl.dataset.kind;
    if (kind !== "group" && kind !== "tab") return null;
    return { kind, id };
  }

  /* ---------- 落点计算 ---------- */
  /**
   * 由「目标行 + 指针在该行的相对位置」得到落点。
   * drop.pos 一律是**插入位置**(0..len),不是元素下标。
   * @returns {{drop:any, anchorRow:HTMLElement|null, after:boolean, intoRow:HTMLElement|null}|null}
   */
  function computeDrop(source, rowEl, y) {
    const rect = rowEl.getBoundingClientRect();
    const rel = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
    const isChild = rowEl.dataset.child === "1";
    const kind = rowEl.dataset.kind;

    // 拖动「标签组」:只能在顶层条目之间移动(不能进组)
    if (source.kind === "group") {
      if (isChild) {
        const g = groupRowById(rowEl.dataset.parent);
        if (!g) return null;
        return {
          drop: { kind: "top", pos: topIndex(g) + 1 },
          anchorRow: blockEndRow(g), after: true, intoRow: null,
        };
      }
      return {
        drop: { kind: "top", pos: topIndex(rowEl) + (rel < 0.5 ? 0 : 1) },
        anchorRow: rowEl, after: rel >= 0.5, intoRow: null,
      };
    }

    // 拖动「标签」:组行上 25% / 下 25% = 顶层插入;中部 = 进入该组
    if (kind === "group" && !isChild) {
      const gid = rowEl.dataset.id;
      if (rel < 0.25) {
        return {
          drop: { kind: "top", pos: topIndex(rowEl) },
          anchorRow: rowEl, after: false, intoRow: null,
        };
      }
      if (rel > 0.75) {
        return {
          drop: { kind: "top", pos: topIndex(rowEl) + 1 },
          anchorRow: blockEndRow(rowEl), after: true, intoRow: null,
        };
      }
      // 「进入组末尾」用专门的 into 落点:折叠组的子行不可见,
      // 不能用可见子行数当位置;由 operations 按真实 children.length 追加。
      return {
        drop: { kind: "into", groupId: gid },
        anchorRow: null, after: false, intoRow: rowEl,
      };
    }

    // 落在 child 行:插入其所属组的指定位置(可跨组 / 也可把顶层标签拖入组)
    if (isChild) {
      const gid = rowEl.dataset.parent;
      const rows = childRows(gid);
      const i = rows.indexOf(rowEl);
      if (i === -1) return null;
      return {
        drop: { kind: "child", groupId: gid, pos: i + (rel < 0.5 ? 0 : 1) },
        anchorRow: rowEl, after: rel >= 0.5, intoRow: null,
      };
    }

    // 落在顶层标签行:顶层插入
    return {
      drop: { kind: "top", pos: topIndex(rowEl) + (rel < 0.5 ? 0 : 1) },
      anchorRow: rowEl, after: rel >= 0.5, intoRow: null,
    };
  }

  /* ---------- 视觉 ---------- */
  function ensureIndicator() {
    // 自动展开会触发整表重渲染(innerHTML 重建),旧插入线会被移除 → 重新挂回
    if (st.indicator && list.contains(st.indicator)) return st.indicator;
    if (st.indicator) st.indicator.remove();
    const el = document.createElement("div");
    el.className = "drop-indicator";
    el.hidden = true;
    list.appendChild(el);
    st.indicator = el;
    return el;
  }

  /**
   * 插入线:childLevel=true → 缩进到子项内容线(表示「放进组内」);
   * false → 通栏(表示「插到顶层条目之间」)。两种意图的线形明显不同。
   */
  function positionIndicator(anchorRow, after, childLevel) {
    const ind = ensureIndicator();
    const lr = list.getBoundingClientRect();
    const ar = anchorRow.getBoundingClientRect();
    const top = ar.top - lr.top + list.scrollTop + (after ? ar.height : 0);
    ind.classList.toggle("child", !!childLevel);
    ind.style.top = Math.max(0, Math.round(top) - 1) + "px";
    ind.hidden = false;
  }

  /* ---------- 目标组高亮(组内落点) ---------- */
  function isRowOfGroup(rowEl, gid) {
    if (rowEl.dataset.parent === gid && rowEl.dataset.child === "1") return true;
    return rowEl.dataset.kind === "group" && rowEl.dataset.child !== "1" && rowEl.dataset.id === gid;
  }
  function clearGroupHighlight() {
    if (!st.highlightGroupId) return;
    for (const r of allRows()) r.classList.remove("drop-group");
    st.highlightGroupId = null;
  }
  /** 高亮整个目标组(组行描边 + 组块淡底):组内落点用。 */
  function setGroupHighlight(gid) {
    if (st.highlightGroupId === gid) {
      // 自动展开会整表重渲染并清掉 class:检测到缺失时重新应用
      if (!gid || list.querySelector(".row.drop-group")) return;
      st.highlightGroupId = null;
    }
    clearGroupHighlight();
    if (!gid) return;
    st.highlightGroupId = gid;
    for (const r of allRows()) if (isRowOfGroup(r, gid)) r.classList.add("drop-group");
  }

  function clearDropVisual() {
    st.drop = null;
    if (st.indicator) st.indicator.hidden = true;
    clearGroupHighlight();
    clearExpandTimer();
  }

  /** 指针移动 → 重算落点并同步视觉。 */
  function updateDrop(x, y) {
    if (st.phase !== "active" || !st.source) return;
    st.lastX = x;
    st.lastY = y;

    const lr = list.getBoundingClientRect();
    const cx = clamp(x, lr.left + 1, lr.right - 1);
    const cy = clamp(y, lr.top + 1, lr.bottom - 1);
    const rowEl = rowAt(cx, cy);
    const res = rowEl ? computeDrop(st.source, rowEl, cy) : null;
    if (!res) { clearDropVisual(); return; }

    st.drop = res.drop;

    // 组内落点(child / into)统一高亮目标组;child 位置的插入线再缩进一级。
    // 这样「放进组内末尾」与「插到组之间的顶级位置」在松手前就有明确不同的视觉形态。
    const childLevel = res.drop.kind === "child" || res.drop.kind === "into";
    setGroupHighlight(childLevel ? res.drop.groupId : "");

    if (res.intoRow) {
      if (st.indicator) st.indicator.hidden = true;   // into:组高亮已足够明确
    } else if (res.anchorRow) {
      positionIndicator(res.anchorRow, res.after, childLevel);
    } else if (st.indicator) {
      st.indicator.hidden = true;
    }
    scheduleAutoExpand(res.intoRow);
  }

  /* ---------- 悬停折叠组自动展开 ---------- */
  function clearExpandTimer() {
    if (st.expandTimer) {
      clearTimeout(st.expandTimer);
      st.expandTimer = null;
    }
    st.expandTargetId = null;
  }

  function scheduleAutoExpand(intoRow) {
    const gid = intoRow && intoRow.dataset.expanded === "0" ? intoRow.dataset.id : "";
    if (!gid) { clearExpandTimer(); return; }
    if (st.expandTargetId === gid && st.expandTimer) return;   // 同一目标已在计时

    clearExpandTimer();
    st.expandTargetId = gid;
    st.expandTimer = setTimeout(() => {
      st.expandTimer = null;
      if (st.phase !== "active") return;
      if (!st.drop || st.drop.kind !== "into" || st.drop.groupId !== gid) return;
      if (typeof onAutoExpand !== "function") return;
      try { onAutoExpand(gid); } catch (e) { console.warn("[drag] 自动展开失败:", e); }
      // 展开会异步重渲染行:分几拍重算落点(行节点被替换后必须重新命中)
      for (const ms of [60, 180, 400]) {
        setTimeout(() => { if (st.phase === "active") updateDrop(st.lastX, st.lastY); }, ms);
      }
    }, AUTO_EXPAND_MS);
  }

  /* ---------- ghost / 自动滚动 ---------- */
  function createGhost() {
    const rect = st.sourceRow.getBoundingClientRect();
    st.offsetX = clamp(st.startX - rect.left, 0, rect.width);
    st.offsetY = clamp(st.startY - rect.top, 0, rect.height);
    const ghost = st.sourceRow.cloneNode(true);
    ghost.classList.remove("drag-source");
    ghost.classList.add("drag-ghost");
    ghost.removeAttribute("id");
    ghost.style.width = rect.width + "px";
    ghost.style.height = rect.height + "px";
    ghost.style.left = Math.round(st.startX - st.offsetX) + "px";
    ghost.style.top = Math.round(st.startY - st.offsetY) + "px";
    document.body.appendChild(ghost);
    st.ghost = ghost;
  }

  function moveGhost(x, y) {
    if (!st.ghost) return;
    st.ghost.style.left = Math.round(x - st.offsetX) + "px";
    st.ghost.style.top = Math.round(y - st.offsetY) + "px";
  }

  function stopAutoScroll() {
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
  }

  function startAutoScroll() {
    stopAutoScroll();
    const loop = () => {
      if (st.phase !== "active") { st.raf = 0; return; }
      const lr = list.getBoundingClientRect();
      const before = list.scrollTop;
      if (st.lastY < lr.top + EDGE_ZONE) list.scrollTop = before - SCROLL_STEP;
      else if (st.lastY > lr.bottom - EDGE_ZONE) list.scrollTop = before + SCROLL_STEP;
      if (list.scrollTop !== before) updateDrop(st.lastX, st.lastY);
      st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
  }

  /* ---------- 状态机 ---------- */
  function activate() {
    st.phase = "active";
    document.documentElement.classList.add("row-dragging");
    if (st.sourceRow) st.sourceRow.classList.add("drag-source");
    createGhost();
    ensureIndicator();
    startAutoScroll();
    updateDrop(st.lastX, st.lastY);
  }

  function cleanup() {
    if (st.sourceRow) st.sourceRow.classList.remove("drag-source");
    if (st.ghost) { st.ghost.remove(); st.ghost = null; }
    if (st.indicator) { st.indicator.remove(); st.indicator = null; }
    clearDropVisual();
    stopAutoScroll();
    document.documentElement.classList.remove("row-dragging");
    if (st.pointerId != null) {
      try {
        if (list.hasPointerCapture && list.hasPointerCapture(st.pointerId)) {
          list.releasePointerCapture(st.pointerId);
        }
      } catch { /* 忽略 */ }
    }
    st.phase = "idle";
    st.pointerId = null;
    st.source = null;
    st.sourceRow = null;
  }

  /** 拖完吞掉紧随其后的一次 click,避免误触发行内按钮/编辑。 */
  function suppressNextClick() {
    const swallow = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      window.removeEventListener("click", swallow, true);
    };
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  }

  /* ---------- 事件 ---------- */
  function onPointerDown(e) {
    if (st.phase !== "idle") return;
    if (typeof canStart === "function" && !canStart()) return;
    if (e.button !== 0 || e.isPrimary === false) return;

    const target = e.target;
    if (!(target instanceof Element)) return;
    const rowEl = target.closest(".row");
    if (!rowEl || !list.contains(rowEl)) return;
    if (rowEl.dataset.drag !== "1") return;
    if (target.closest(EXCLUDE_SELECTOR)) return;          // 已有交互元素 → 不拖
    if (document.querySelector(EDITING_SELECTOR)) return;   // 编辑中 → 不拖

    const source = readSource(rowEl);
    if (!source) return;

    st.phase = "pending";
    st.pointerId = e.pointerId;
    st.startX = st.lastX = e.clientX;
    st.startY = st.lastY = e.clientY;
    st.source = source;
    st.sourceRow = rowEl;
    try { list.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    e.preventDefault();                                     // 禁选中 / 原生图片拖拽
  }

  function onPointerMove(e) {
    if (st.pointerId !== e.pointerId) return;
    if (st.phase !== "pending" && st.phase !== "active") return;
    st.lastX = e.clientX;
    st.lastY = e.clientY;

    if (st.phase === "pending") {
      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      activate();
    }
    if (st.phase === "active") {
      moveGhost(e.clientX, e.clientY);
      updateDrop(e.clientX, e.clientY);
    }
  }

  function onPointerUp(e) {
    if (st.pointerId !== e.pointerId) return;
    if (st.phase !== "pending" && st.phase !== "active") return;

    const activeDrag = st.phase === "active";
    const drop = st.drop;
    const source = st.source;
    cleanup();
    if (!activeDrag) return;                 // 只是点击,未拖动
    suppressNextClick();
    if (!drop) return;                       // 无有效落点 → 取消

    st.phase = "busy";                       // 提交期间拒绝新的拖拽
    Promise.resolve()
      .then(() => onDrop(source, drop))
      .catch((err) => console.warn("[drag] 落点处理失败:", err))
      .finally(() => { st.phase = "idle"; });
  }

  function cancelDrag() {
    if (st.phase !== "pending" && st.phase !== "active") return;
    cleanup();
  }

  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    if (st.phase !== "pending" && st.phase !== "active") return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag();
  };
  const onPointerCancel = (e) => {
    if (st.pointerId !== e.pointerId) return;
    cancelDrag();                                   // 系统取消 → 不落盘
  };
  const onDragStart = (e) => e.preventDefault();    // 禁原生 DnD/图片拖拽

  list.addEventListener("pointerdown", onPointerDown);
  list.addEventListener("pointermove", onPointerMove);
  list.addEventListener("pointerup", onPointerUp);
  list.addEventListener("pointercancel", onPointerCancel);
  list.addEventListener("dragstart", onDragStart);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", cancelDrag);
  window.addEventListener("pagehide", cancelDrag);

  return {
    destroy() {
      cancelDrag();
      list.removeEventListener("pointerdown", onPointerDown);
      list.removeEventListener("pointermove", onPointerMove);
      list.removeEventListener("pointerup", onPointerUp);
      list.removeEventListener("pointercancel", onPointerCancel);
      list.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancelDrag);
      window.removeEventListener("pagehide", cancelDrag);
    },
  };
}
