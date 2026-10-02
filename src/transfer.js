// 导出 / 导入(§4.11)。
// 导出:Blob + <a download> 规范触发(可被 FDM 拦截),固定在 popup 上下文。
// 导入:File.text() → JSON.parse → schema 校验 → 通过才写入。

import {
  getFirstPaint, getAllSnaps, getAllIcons, writeBatch, removeSnaps, getEverything,
} from "./storage.js";
import { FORMAT_NAME, SCHEMA_VERSION } from "./types.js";

const EXPORT_FORMAT_VERSION = 1;

/* ================= 导出 ================= */

export async function buildExportObject() {
  const { meta, index } = await getFirstPaint();
  const snaps = await getAllSnaps();
  const icons = await getAllIcons();
  const { ui, ...metaRest } = meta || {};
  return {
    format: FORMAT_NAME,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    meta: metaRest,
    index,
    snaps,
    icons,
  };
}

/** 触发浏览器下载(§4.11.2):规范 <a download> 路径,popup 上下文。 */
export async function triggerDownload(obj) {
  const json = JSON.stringify(obj, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `tabgroup-recorder-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ================= 导入:校验(§4.11.3) ================= */

/**
 * 校验导出对象 schema。返回 { ok:true } 或 { ok:false, error }。
 * 任一项不通过 → 整体拒绝,不写入任何数据。
 */
export function validateExport(obj) {
  if (!obj || typeof obj !== "object") return fail("根节点不是对象");
  if (obj.format !== FORMAT_NAME) return fail(`format 不匹配(期望 ${FORMAT_NAME})`);
  if (obj.formatVersion !== EXPORT_FORMAT_VERSION)
    return fail(`不支持的 formatVersion: ${obj.formatVersion}`);
  if (obj.schemaVersion !== SCHEMA_VERSION)
    return fail(`不支持的 schemaVersion: ${obj.schemaVersion}`);

  if (!Array.isArray(obj.index)) return fail("index 必须是数组");
  if (!obj.snaps || typeof obj.snaps !== "object") return fail("snaps 必须是对象");
  if (!obj.icons || typeof obj.icons !== "object") return fail("icons 必须是对象");

  // 每条 index 项
  for (let i = 0; i < obj.index.length; i++) {
    const e = obj.index[i];
    const path = `index[${i}]`;
    if (!e || typeof e !== "object") return fail(`${path} 不是对象`);
    if (!e.id) return fail(`${path}.id 缺失`);
    if (e.type !== "tab" && e.type !== "group") return fail(`${path}.type 非法: ${e.type}`);
    if (typeof e.name !== "string") return fail(`${path}.name 缺失`);
    if (!obj.snaps[e.id]) return fail(`${path}.id=${e.id} 在 snaps 中缺失`);
  }

  // 每条 snap
  for (const [id, s] of Object.entries(obj.snaps)) {
    const path = `snaps[${id}]`;
    if (!s || typeof s !== "object") return fail(`${path} 不是对象`);
    if (!s.id) return fail(`${path}.id 缺失`);
    if (s.type === "tab") {
      if (typeof s.url !== "string" || !s.url) return fail(`${path}.url 缺失或非法`);
      if (s.iconKey && !obj.icons[s.iconKey]) return fail(`${path}.iconKey=${s.iconKey} 在 icons 中缺失`);
    } else if (s.type === "group") {
      if (typeof s.color !== "string") return fail(`${path}.color 缺失`);
      if (!Array.isArray(s.children)) return fail(`${path}.children 必须是数组`);
      for (let j = 0; j < s.children.length; j++) {
        const c = s.children[j];
        if (!c || typeof c !== "object" || !c.id || c.type !== "tab")
          return fail(`${path}.children[${j}] 非法`);
        if (typeof c.url !== "string" || !c.url)
          return fail(`${path}.children[${j}].url 缺失`);
        if (c.iconKey && !obj.icons[c.iconKey])
          return fail(`${path}.children[${j}].iconKey=${c.iconKey} 在 icons 中缺失`);
      }
    } else {
      return fail(`${path}.type 非法: ${s.type}`);
    }
  }

  // 计数一致
  if (obj.meta && obj.meta.counts) {
    const groups = obj.index.filter((e) => e.type === "group").length;
    const tabs = obj.index.filter((e) => e.type === "tab").length;
    if (obj.meta.counts.groups !== groups)
      return fail(`meta.counts.groups(${obj.meta.counts.groups}) 与 index 实际(${groups})不一致`);
    if (obj.meta.counts.tabs !== tabs)
      return fail(`meta.counts.tabs(${obj.meta.counts.tabs}) 与 index 实际(${tabs})不一致`);
  }

  return { ok: true };
}

function fail(error) {
  return { ok: false, error };
}

/* ================= 导入:写入 ================= */

/** 覆盖模式:先备份,再一次 set 写入 + 清残留(§4.11.5)。 */
export async function importOverwrite(obj) {
  const v = validateExport(obj);
  if (!v.ok) return v;

  // 自动本地备份
  try {
    const current = await getEverything();
    if (current.index) {
      await chrome.storage.local.set({ "backup:auto": current });
    }
  } catch { /* 备份失败不阻断导入 */ }

  // 清残留 snap:* / icon:*
  const all = await getEverything();
  const stale = Object.keys(all).filter((k) => k.startsWith("snap:") || k.startsWith("icon:"));
  await removeSnaps(stale.filter((k) => k.startsWith("snap:")).map((k) => k.slice(5)));
  const staleIcons = stale.filter((k) => k.startsWith("icon:"));
  if (staleIcons.length) await chrome.storage.local.remove(staleIcons);

  // 一次性写入
  const batch = {
    meta: obj.meta || null,
    index: obj.index,
    ui: { activeTab: "records", expanded: {} },
  };
  for (const [id, s] of Object.entries(obj.snaps)) batch[`snap:${id}`] = s;
  for (const [h, d] of Object.entries(obj.icons)) batch[`icon:${h}`] = d;
  await writeBatch(batch);

  return { ok: true };
}
