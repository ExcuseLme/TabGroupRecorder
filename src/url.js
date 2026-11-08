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

/* ================= TabSuspenderLite 占位页 URL(design-v1.1.0.md) ================= */
//
// TabSuspenderLite(下称 TSL)的「冻结」= 把标签导航到一个自描述占位页,原 URL 与原标题
// 都编码在占位页自己的地址里(TSL 无存储、无后台状态):
//
//   chrome-extension://{chromeExtensionId}/suspended.html?url={原文URL}&title={原标题}
//
// 两个参数都由 URLSearchParams 输出(空格 → "+",其余按 application/x-www-form-urlencoded)。
//
// 因此 TGR 捕获一个被冻结的标签时,快照里的 `name`(Chrome 标签标题 = TSL 占位页的
// document.title)与 `url` 里 title 参数是**同一份内容的两处副本**。用户在「快照记录」
// 里编辑任一侧,都要把另一侧同步过来,否则两处不一致(改标题后恢复出来的页面标题还是旧的)。
//
// 匹配纪律:**严格** —— 必须恰好是 `url` + `title` 两个参数、顺序固定、不多不少;
// 路径必须是 `/suspended.html`;百分号编码必须合法。任一不符 ⇒ 当作普通 URL,
// 两向同步都不生效(绝不擅自改写用户自己填的 URL)。
//
// 扩展 ID 用 `[a-p]{32}`(Chrome 扩展 ID 的字符集):TSL 重新打包/换机器后 ID 会变,
// 写死某一个 ID 会让功能在换 ID 后静默失效。若日后要收紧成只认某一个 ID,
// 只需把下面的正则改成该 ID 的字面量(单点改动)。
const TSL_URL_RE =
  /^chrome-extension:\/\/([a-p]{32})\/suspended\.html\?url=([^&]+)&title=([^&]*)$/;

/** application/x-www-form-urlencoded 解码(URLSearchParams 语义:空格 = "+")。非法编码 → null。 */
function decodeFormValue(raw) {
  try {
    return decodeURIComponent(String(raw).replace(/\+/g, " "));
  } catch {
    return null; // 非法百分号编码(如 %ZZ、%E4 截断)
  }
}

/** application/x-www-form-urlencoded 编码,与 TSL 自己(URLSearchParams)写出的形式一致。 */
function encodeFormValue(value) {
  // "v=" 固定 2 字符,剥掉即得纯编码值(空格 → "+")
  return new URLSearchParams([["v", String(value ?? "")]]).toString().slice(2);
}

/**
 * 解析 TSL 占位页 URL(严格匹配)。
 * @param {string} url
 * @returns {{originalUrl: string, title: string}|null} null = 不是严格的 TSL 占位页 URL
 */
export function parseTslUrl(url) {
  const m = TSL_URL_RE.exec(url ?? "");
  if (!m) return null;
  const originalUrl = decodeFormValue(m[2]);
  const title = decodeFormValue(m[3]);
  if (originalUrl === null || title === null) return null;   // 编码非法 → 不是可信的 TSL URL
  return { originalUrl, title };
}

/**
 * 是否严格符合 TSL 占位页 URL 格式。
 * @param {string} url
 */
export function isTslUrl(url) {
  return parseTslUrl(url) !== null;
}

/**
 * 把 TSL 占位页 URL 里的 `title` 参数改写为新标题。
 *
 * **只动 title 的值**:`url` 参数(原文 URL)逐字保留,参数顺序与其余字符不变。
 * 非 TSL 格式、或新标题与原有 title 语义相同(仅编码写法不同)→ 原样返回,
 * 调用方可无条件使用返回值,无需自己判断格式。
 *
 * @param {string} url
 * @param {string} title 新标题(明文,内部负责编码)
 * @returns {string}
 */
export function setTslTitle(url, title) {
  const m = TSL_URL_RE.exec(url ?? "");
  if (!m) return url;
  const raw = title ?? "";
  if (decodeFormValue(m[3]) === raw) return url;   // 语义未变:保留原始编码,不做无意义改写
  return `chrome-extension://${m[1]}/suspended.html?url=${m[2]}&title=${encodeFormValue(raw)}`;
}

/**
 * 「编辑 URL → 标题联动」的判定:改完 URL 后要不要用 URL 里的 title 覆盖快照标题。
 *
 * 生效条件(全部满足):
 *   1. 新 URL 是严格的 TSL 格式;
 *   2. 新 URL 的 title 解码后**非空**(空串不覆盖,避免把标题清空);
 *   3. 与旧 URL 的 title **不同**(旧 URL 不是 TSL 视为不同)。
 * —— 只改 `url` 参数(换原网址)而 title 没变时不动标题,不会把用户自定义过的标题冲掉。
 *
 * @param {string} oldUrl 编辑前的 URL
 * @param {string} newUrl 编辑后的 URL
 * @returns {string|null} 需要同步的新标题;null = 不改标题
 */
export function tslTitleAfterUrlEdit(oldUrl, newUrl) {
  const next = parseTslUrl(newUrl);
  if (!next) return null;
  if (!next.title.trim()) return null;
  const prev = parseTslUrl(oldUrl);
  if (prev && prev.title === next.title) return null;
  return next.title;
}
