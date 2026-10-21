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
