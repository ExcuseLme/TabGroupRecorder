// 列表渲染(§2 行结构 / §9-2 轻量虚拟列表 / §5-8 操作绑定)。

const LIST = () => document.getElementById("list");

/**
 * 全局未完成编辑(P-19)。popup 被点外部/点扩展图标关闭时不触发 blur,
 * `pagehide` 时据此同步落盘;不走异步读链(renameSnapshot 的 loadIndex)。
 */
let pendingEdit = null;
window.addEventListener("pagehide", () => {
  if (!pendingEdit) return;
  const { el, flushNow } = pendingEdit;
  pendingEdit = null;
  try { flushNow(el.textContent.trim()); } catch (e) { console.error("pagehide flush 失败", e); }
});


const SVG_FOLD = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 2L8 5.5L12.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 14L8 10.5L12.5 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_UNFOLD = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 5.5L8 2L12.5 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 10.5L8 14L12.5 10.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * 列表渲染:全量渲染行 + 原生 CSS 滚动。
 * 移除视口裁剪与 DOM 清空重建——这是 R4-1(展开错位)/ R4-其他3(切tab标题回退)/
 * R4-N3(极长标题变空白)的共同根因。行量级(数百)下全量渲染开销可接受,
 * 符合"复杂度优先";原生滚动条随内容自然出现(R4-N2)。
 */
export class VirtualList {
  constructor(el) {
    this.el = el;
    this.rows = [];
    this.onScroll = () => this.keepScroll();
    el.addEventListener("scroll", this.onScroll, { passive: true });
  }
  /** 滚动时不重建 DOM,仅保留 scrollTop(原生滚动本就不需干预)。 */
  keepScroll() { /* no-op: 原生滚动自身稳定 */ }

  setRows(rows) {
    const prevScroll = this.el.scrollTop;   // 保留滚动位置
    this.rows = rows;
    this.render();
    this.el.scrollTop = prevScroll;
  }

  render() {
    const { el, rows } = this;
    if (!rows.length) {
      el.innerHTML = `<div class="empty">暂无数据</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (let i = 0; i < rows.length; i++) {
      frag.appendChild(buildRow(rows[i]));
    }
    el.innerHTML = "";
    el.appendChild(frag);
  }
}

function buildRow(row) {
  const div = document.createElement("div");
  div.className = "row" + (row.child ? " child" : "") + (row.url ? " has-url" : "");

  const dot = document.createElement("div");
  dot.className = "dot";
  if (row.color) {
    // 标签组:保持圆形色块(P-26 方案B)
    dot.style.background = cssGroupColor(row.color);
  } else if (row.pageUrl) {
    // 当前标签:直接带 pageUrl,hydrateIcons 走 /_favicon(P-25)
    dot.classList.add("dot--img");   // 图标:仿参照扩展白底、锁定尺寸(P-26 方案B)
    dot.dataset.pageurl = row.pageUrl;
  } else if (row.iconKey) {
    // 快照行:iconKey → storage 取 pageUrl → 同样走 /_favicon(P-21)
    dot.classList.add("dot--img");   // 同上(P-26 方案B)
    dot.dataset.iconkey = row.iconKey;
  }
  div.appendChild(dot);

  const main = document.createElement("div");
  main.className = "row-main";

  // 名称行(状态图标 + 名称)
  const head = document.createElement("div");
  head.className = "row-head";

  // 分组行:状态图标 <> / ><
  if (row.kind === "group") {
    const ic = document.createElement("span");
    ic.className = "state-icon";
    ic.title = row.expanded ? "点击后收起" : "点击后展开";
    ic.innerHTML = row.expanded ? SVG_FOLD : SVG_UNFOLD;
    ic.addEventListener("click", (e) => { e.stopPropagation(); row.onToggle?.(); });
    head.appendChild(ic);
  }

  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = row.name;
  // 悬停显示完整标题(与原 URL 行一致,走原生 title —— P-31:不自绘 tooltip)。
  // 长标题被 text-overflow:ellipsis 截断时,用户仍能看到全文(§2.12)。
  if (row.name) title.title = row.name;
  // 仅非只读行可点击进入编辑(其他问题1:当前标签 tab 为只读)
  if (!row.readonly) {
    title.addEventListener("click", () => startEdit(title, row, "name"));
  }
  head.appendChild(title);
  main.appendChild(head);

  // URL 第二行(§2.3):仅快照记录里的标签行有 url;分组行没有,保持单行
  if (row.url !== undefined && row.url !== null) {
    const field = document.createElement("div");
    field.className = "url-field";
    const input = document.createElement("span");
    input.className = "url-input";
    input.textContent = row.url;
    input.title = row.url;                     // 完整值走原生 title(P-31:不自绘 tooltip)
    if (!row.readonly) {
      input.addEventListener("click", () => startEdit(input, row, "url"));
    }
    field.appendChild(input);
    // 重复提示徽标位(编辑时由 onUrlInput 控制显示)
    main.appendChild(field);
  }

  div.appendChild(main);

  // 工具按钮
  const tools = document.createElement("div");
  tools.className = "row-tools";
  for (const b of row.buttons || []) {
    const btn = document.createElement("button");
    btn.className = `btn ${b.cls}`;
    btn.textContent = b.label;
    if (b.title) btn.title = b.title;
    // 透传事件对象:按钮回调可自行判断(0.7.2 起「打开」一律后台,不再读取修饰键)
    btn.addEventListener("click", (e) => { e.stopPropagation(); b.onClick(e); });
    tools.appendChild(btn);
  }
  div.appendChild(tools);
  return div;
}

/**
 * 就地编辑(§7 名称 / §2.4 URL):点击文本进入编辑态,失焦/回车提交,Esc 放弃。
 * @param {HTMLElement} el 被编辑的可编辑元素
 * @param {any} row 行模型
 * @param {'name'|'url'} field 编辑哪个字段
 */
function startEdit(el, row, field = "name") {
  if (el.isContentEditable) return;
  const list = LIST();
  const isUrl = field === "url";
  const fieldEl = isUrl ? el.closest(".url-field") : null;

  el.contentEditable = "true";
  el.classList.add("editing");
  if (fieldEl) fieldEl.classList.add("editing");
  el.style.textOverflow = "clip";  // 编辑态去掉省略号(避免遮挡文本)

  // 编辑态临时摘掉原生 tooltip:否则悬停/聚焦时气泡浮在文本上方挡住正在编辑的内容,
  // 退出编辑时原样还原(§2.12)。保存原值以保证 restore 精确。
  const savedTitle = el.getAttribute("title");
  if (savedTitle != null) el.removeAttribute("title");

  // 限制编辑框宽度:不超过列表可视宽度(避免遮挡右侧按钮,问题3/其他问题3)
  const rowEl = el.closest(".row");
  const tools = rowEl?.querySelector(".row-tools");
  const maxW = (list.clientWidth - 32) - (tools?.offsetWidth || 0) - 48;
  el.style.maxWidth = Math.max(120, maxW) + "px";

  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  // 编辑中实时重复检测(§2.7):仅提示,不拦截保存
  const onInput = () => {
    if (!fieldEl) return;
    const v = el.textContent.trim();
    fieldEl.classList.toggle("is-dup", !!v && !!row.isDupContent?.(v));
  };
  if (isUrl) el.addEventListener("input", onInput);

  // 统一收尾:finish(save=true) 提交,finish(false) 放弃(Escape)。
  // 回滚 0.1.10/0.1.11 的 async/scheduleCommit 复杂化(曾致按钮丢失/顺序错乱)。
  // 完成编辑后**同步** flush 写盘 + 整 tab 刷新(P-18/P-22):同步执行,用户永远
  // 看不到中间态(错乱/丢按钮在出现前即被整页刷新覆盖)。
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    pendingEdit = null;                    // 已收尾,取消 pagehide 兜底
    el.contentEditable = "false";
    el.classList.remove("editing");
    if (fieldEl) fieldEl.classList.remove("editing", "is-dup");
    el.style.textOverflow = "";
    el.style.maxWidth = "";
    el.style.minWidth = "";
    // 还原编辑前摘掉的原生 tooltip(§2.12)
    if (savedTitle != null) el.setAttribute("title", savedTitle);
    if (isUrl) el.removeEventListener("input", onInput);
    list.scrollLeft = 0;

    const val = el.textContent.trim();

    // ---------- URL 字段(§2.4 / §2.6) ----------
    if (isUrl) {
      const oldUrl = row.url ?? "";
      if (!save) { el.textContent = oldUrl; return; }   // Escape 还原
      if (!val) {                                        // 唯一校验:非空
        el.textContent = oldUrl;
        row.onUrlRejected?.("内容不能为空");
        return;
      }
      if (val === oldUrl) { el.textContent = val; return; }
      row.url = val;
      const r = row.onUrlEdit?.(val);                    // 写盘 + 缓存 + 同步刷列表
      if (r && r.ok === false) row.onUrlRejected?.(r.error || "保存失败");
      return;
    }

    // ---------- 名称字段(与原有 startRename 行为一致) ----------
    if (save && val && val !== row.name) {
      row.name = val;
      row.onFlush?.(val);                  // 同步 flush 写盘(顶层直写 / 组内记 pending)
      row.onRenamed?.(val);                // 同步刷新 state 缓存
      row.onRefresh?.();                   // 同步刷新整个快照列表 tab(P-18/P-22)
    } else if (!save) {
      el.textContent = row.name;           // Escape:还原
    }
  };

  // 注册 pagehide 兜底:仅当仍在编辑(done=false)时同步落盘(P-19)
  // URL 不做兜底:属新增字段,且空值/无效输入不应静默写盘
  if (!isUrl) {
    pendingEdit = { el, row, flushNow: (v) => { if (!done && v && v !== row.name) row.onFlush?.(v); } };
  }

  el.addEventListener("blur", () => finish(true), { once: true });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); el.blur(); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); el.blur(); }
  });

  // 编辑态:锁定 minWidth 防止溢出触发 list 横向滚动(P-08)
  el.style.minWidth = el.offsetWidth + "px";
  const onListScroll = () => { list.scrollLeft = 0; };
  list.addEventListener("scroll", onListScroll);
  el.addEventListener("blur", () => list.removeEventListener("scroll", onListScroll), { once: true });
}

const GROUP_COLORS = {
  grey: "#9aa0a6", blue: "#4285f4", red: "#ea4335", yellow: "#fbbc04",
  green: "#34a853", pink: "#f439a0", purple: "#a142f4", cyan: "#24c1e0",
  orange: "#fa903e",
};
function cssGroupColor(c) { return GROUP_COLORS[c] || "#9aa0a6"; }

/** 渲染骨架(t0,零数据)。 */
export function renderSkeleton() {
  const el = LIST();
  el.classList.add("skeleton");
  el.innerHTML = Array.from({ length: 6 })
    .map(() => `<div class="row"><div class="dot"></div><div class="row-main"><span class="row-title"></span></div></div>`)
    .join("");
}

/** 数据渲染完成后移除骨架 class(防止 ::after 灰条残留到真实行上)。 */
export function clearSkeleton() {
  LIST().classList.remove("skeleton");
}
