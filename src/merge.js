// 快照顺序与整组合并的纯函数(design-v0.6 §1 / §2 / §3)。
// 纪律:本文件不依赖任何 DOM / chrome API,便于在 Node 或 docs/mockups/selftest 中独立验证。

/**
 * 快照记录的展示顺序:最新捕获的条目在最上面。
 * index 存储顺序保持「最近捕获顺序(旧→新)」,展示层只做反转(不迁移、不改导出格式)。
 * @template T
 * @param {T[]} index
 * @returns {T[]} 反转后的新数组(不修改入参)
 */
export function orderForDisplay(index) {
  return Array.isArray(index) ? index.slice().reverse() : [];
}

/**
 * 展示顺序 → index 存储顺序(v0.8 拖拽排序)。
 * `index` 存储「旧→新」、展示层反转;拖拽得到的是**展示顺序**,
 * 落盘时反转一次即可,导出/导入格式不变。
 * @template T
 * @param {T[]} displayEntries 展示顺序(最新在上)
 * @returns {T[]} 反转后的新数组(不修改入参)
 */
export function toStorageOrder(displayEntries) {
  return Array.isArray(displayEntries) ? displayEntries.slice().reverse() : [];
}

/**
 * index 存储顺序 → 展示顺序(与 orderForDisplay 同义,供拖拽路径显式表达意图)。
 * @template T
 * @param {T[]} index
 * @returns {T[]}
 */
export function toDisplayOrder(index) {
  return orderForDisplay(index);
}

/** 整数夹取(非整数/NaN 回落到 min)。 */
export function clampIndex(n, min, max) {
  const v = Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.max(min, Math.min(max, v));
}

/**
 * 同数组内移动(拖拽重排的核心)。
 * `from` 为原下标;`insertPos` 为**原数组坐标下的插入位置**(0..len,
 * 例如「插到第 i 项之前」= i、「插到末尾」= len)。
 * 返回值是新数组;原位/原位之后返回**内容相同的新数组**(调用方用 sameIdOrder 判无变化)。
 * @template T
 * @param {T[]} list
 * @param {number} from
 * @param {number} insertPos
 * @returns {T[]}
 */
export function moveWithin(list, from, insertPos) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const n = arr.length;
  if (!n) return arr;
  const f = clampIndex(from, 0, n - 1);
  const p = clampIndex(insertPos, 0, n);
  if (p === f || p === f + 1) return arr;      // 自身位置之前/之后 → 无变化
  const [item] = arr.splice(f, 1);
  arr.splice(p > f ? p - 1 : p, 0, item);      // 移除后下标前移一位
  return arr;
}

/**
 * 在 pos 处插入(0..len,越界夹取),返回新数组。
 * @template T
 * @param {T[]} list
 * @param {number} pos
 * @param {T} item
 * @returns {T[]}
 */
export function insertAt(list, pos, item) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const p = clampIndex(pos, 0, arr.length);
  arr.splice(p, 0, item);
  return arr;
}

/**
 * 两个数组的「身份顺序」是否一致(对象比 id,原始值直接比)。
 * 用于判断一次拖拽是否真的改变了顺序(未改变则不写盘)。
 * @param {any[]} a
 * @param {any[]} b
 * @returns {boolean}
 */
export function sameIdOrder(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const key = (x) => (x && typeof x === "object" ? x.id : x);
  for (let i = 0; i < a.length; i++) {
    if (key(a[i]) !== key(b[i])) return false;
  }
  return true;
}

/**
 * 整组重复捕获的合并(§5.3 修正):
 *  - 只增不减:existing 中每一项要么被本次捕获「认领并刷新」,要么原样保留;
 *  - 顺序:本次捕获顺序在前(按 URL 去重),旧独有项按原相对顺序追加末尾;
 *  - 无法用 URL 识别的项(缺失/空 url)不参与配对,一律进 tail(D9 历史数据)。
 *
 * @param {TabSnapshot[]} existing 已有组快照 children
 * @param {TabSnapshot[]} target   本次捕获到的 children(按 Chrome 组内顺序)
 * @returns {TabSnapshot[]} 合并结果
 */
export function mergeGroupChildren(existing, target) {
  const old = Array.isArray(existing) ? existing : [];
  const fresh = Array.isArray(target) ? target : [];

  // 非空 url -> 尚未被认领的 existing 下标数组(保序;支持同 URL 多条的旧数据)
  const byUrl = new Map();
  old.forEach((e, i) => {
    const k = e.url;
    if (typeof k !== "string" || !k) return;   // 无有效 url:不参与配对
    if (!byUrl.has(k)) byUrl.set(k, []);
    byUrl.get(k).push(i);
  });

  const used = new Set();      // 已被本次捕获认领的 existing 下标
  const head = [];             // 本次捕获顺序
  const seenTarget = new Set(); // 本次捕获内部的 URL 去重

  for (const t of fresh) {
    const k = t.url;
    const identifiable = typeof k === "string" && !!k;
    if (identifiable) {
      if (seenTarget.has(k)) continue;  // §5.3 URL 并集:本次捕获内同 URL 只取第一个
      seenTarget.add(k);
    }

    const queue = identifiable ? (byUrl.get(k) || []) : [];
    const hit = queue.find((i) => !used.has(i));
    if (hit === undefined) {
      head.push(t);                     // 本次新捕获到的标签快照
    } else {
      used.add(hit);
      // 保留旧对象(id/createdAt),刷新本次捕获到的可变字段(name 以浏览器为准,D6)
      head.push({
        ...old[hit],
        name: t.name,
        url: t.url,
        iconKey: t.iconKey,
        updatedAt: t.updatedAt,
      });
    }
  }

  // 旧独有项:保持相对顺序,全部沉底;重复 URL、无 url 的旧条目也一律保留
  const tail = old.filter((_, i) => !used.has(i));
  return [...head, ...tail];
}
