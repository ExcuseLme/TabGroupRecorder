// 快照记录搜索的**纯函数**层(design-v1.0.0.md 需求④)。
// 无 DOM / 无 chrome.* 依赖 → 可被 docs/mockups/selftest.html 直接 import 断言。
//
// 规则(取代 design-v0.6 §4.5.2 / §4.5.3 / D2):
//   匹配范围 = 全部内容:顶层标签 name/url;分组 组名 或 任一子标签 name/url。
//   过滤范围 = 仅顶层:分组一旦出现,其子标签行永不再过滤(展开即全量)。
//   默认展开(D10):子标签命中 ⇒ 展开;仅组名命中 ⇒ 收起;空查询 ⇒ 沿用持久化展开态。

/** 编译正则;空查询 → re=null(不过滤);非法 → error。 */
export function compileSearch(q) {
  if (!q) return { re: null };
  try { return { re: new RegExp(q, "i") }; }
  catch { return { error: "正则表达式无效" }; }
}

/** 单值匹配(re 为 null 时视为不过滤)。 */
export function searchMatch(re, value) {
  return re ? re.test(value ?? "") : true;
}

/**
 * 计算搜索结果的行计划(纯数据,不含按钮/回调)。
 *
 * @param {{
 *   entries: any[],                                  // **已按展示序排好** 的 index 条目
 *   snaps: Record<string, any> | null,               // { "snap:{groupId}": GroupSnapshot }
 *   re: RegExp | null,                               // null = 空查询(不过滤)
 *   expandedOverride?: Record<string, boolean>,      // 搜索态临时展开覆盖
 *   uiExpanded?: Record<string, boolean>,            // 持久化展开态(空查询时用)
 * }} opts
 * @returns {(
 *   { kind: "tab", entry: any } |
 *   { kind: "group", entry: any, expanded: boolean, titleHit: boolean, childHit: boolean } |
 *   { kind: "child", child: any, parentId: string }
 * )[]}
 */
export function planSearchRows({ entries, snaps, re, expandedOverride, uiExpanded }) {
  const override = expandedOverride || {};
  const persisted = uiExpanded || {};
  const out = [];

  for (const e of entries) {
    // ---- 顶层标签快照:名称或 url 命中 → 出现 ----
    if (e.type !== "group") {
      if (re && !searchMatch(re, e.name) && !searchMatch(re, e.url)) continue;
      out.push({ kind: "tab", entry: e });
      continue;
    }

    // ---- 分组快照 ----
    const children = snaps?.[`snap:${e.id}`]?.children || [];
    const titleHit = !re || searchMatch(re, e.name);
    // 任一子标签命中(用 some:只需布尔,且能早短路)
    const childHit = re
      ? children.some((c) => searchMatch(re, c.name) || searchMatch(re, c.url))
      : false;

    // R1:组本身未命中 → 整组不出现
    if (re && !titleHit && !childHit) continue;

    // R3/D10:用户显式点过优先;有查询时按命中情况定默认值;空查询沿用持久化展开态
    const expanded = Object.prototype.hasOwnProperty.call(override, e.id)
      ? !!override[e.id]
      : (re ? childHit : !!persisted[e.id]);

    out.push({ kind: "group", entry: e, expanded, titleHit, childHit });

    // R2:组内**全量**输出,不按命中裁剪(需求④核心)
    if (expanded) {
      for (const c of children) out.push({ kind: "child", child: c, parentId: e.id });
    }
  }
  return out;
}
