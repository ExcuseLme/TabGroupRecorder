// URL 相关的纯函数(对应 docs/design-v0.5.md §2.6 / §2.8)。
// 设计原则:保存极宽松(仅拦空值),打开时也**不做协议白名单**判断 ——
// 「能否打开」交给 Chrome 自己决定(见 §2.8 的 P-38 记录)。
// 本文件不依赖任何 DOM / chrome API,便于独立验证。

const SLASH = /^[a-z][a-z0-9+.-]*:\/\//i;                    // 形如 scheme://
const HOST_SHAPE = /^[a-z0-9]([a-z0-9.-]*)(:\d+)?(\/.*)?$/i; // 裸主机 / host:port(/path)

/**
 * 保存侧的唯一闸门:trim + 非空判断。
 * 不做任何格式/协议/规范化校验 —— 用户可能需要保存 bookmarklet 或任意特殊内容。
 * @param {string} raw 用户输入
 * @returns {{ok:true,value:string}|{ok:false,error:string}}
 */
export function valueToSave(raw) {
  const s = (raw ?? "").trim();
  return s ? { ok: true, value: s } : { ok: false, error: "内容不能为空" };
}

/**
 * 生成「按顺序尝试打开」的候选 URL 列表。
 *
 * **不使用协议白名单**:`data:` / `javascript:` / `chrome:` / `blob:` / `view-source:`
 * 等一切能被 `new URL()` 解析的内容都原样交给 `chrome.tabs.create`,
 * 由 Chrome 判定是否可导航 —— 扩展不再替浏览器做协议准入决定(P-38)。
 *
 * 仅对「裸主机形态」追加 `https://` 候选,解决手输 `github.com/x` 的问题。
 * @param {string} raw
 * @returns {string[]} 候选(可能为空 = 连 URL 都算不上)
 */
export function urlCandidates(raw) {
  const s = (raw ?? "").trim();
  if (!s) return [];

  const out = [];

  // ① 能被 new URL() 解析 → 原样交给 Chrome(涵盖 data: / javascript: / chrome: / blob: …)
  try { new URL(s); out.push(s); } catch { /* 继续看是否是裸主机 */ }

  // ② 裸主机形态(如 github.com/x、localhost:3000)→ 追加补 https:// 的候选
  //    注意:已带 :// 的不再补,避免产生 https://https://… 这类垃圾候选
  if (!/\s/.test(s) && HOST_SHAPE.test(s) && !SLASH.test(s)) {
    try {
      const u = new URL(`https://${s}`);
      if (u.hostname) out.push(`https://${s}`);
    } catch { /* 放弃 */ }
  }

  return [...new Set(out)];
}

/**
 * 是否为 bookmarklet(javascript: 协议)。
 * 仅用于打开失败时的提示文案(建议复制到地址栏运行)。
 * @param {string} raw
 */
export function isBookmarklet(raw) {
  return /^\s*javascript:/i.test(raw ?? "");
}
