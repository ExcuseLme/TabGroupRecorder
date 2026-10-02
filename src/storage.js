// 分层 key 存储层(对应 docs §4.2 / §4.4 / §4.5)。
// 纪律:读写永远按「前缀一批」;不持久化可重建的派生索引。

import { SCHEMA_VERSION } from "./types.js";

const LS = chrome.storage.local;

/** 读首屏业务数据(meta + index + ui)。t1 阶段调用。 */
export async function getFirstPaint() {
  const data = await LS.get(["meta", "index", "ui"]);
  return {
    meta: data.meta || null,
    index: Array.isArray(data.index) ? data.index : [],
    ui: data.ui || { activeTab: "current", expanded: {} },
  };
}

/** 按 id 批量取快照详情(snap:{id})。展开分组 / 导入校验用。 */
export async function getSnaps(ids) {
  if (!ids.length) return {};
  return LS.get(ids.map((id) => `snap:${id}`));
}

/** 按前缀取全部 snap:* —— 导出用。 */
export async function getAllSnaps() {
  const all = await LS.get(null);
  /** @type {Record<string, any>} */
  const snaps = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("snap:")) snaps[k.slice(5)] = v;
  }
  return snaps;
}

/** 按前缀取全部 icon:* —— 导出用。 */
export async function getAllIcons() {
  const all = await LS.get(null);
  /** @type {Record<string, string>} */
  const icons = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("icon:")) icons[k.slice(5)] = v;
  }
  return icons;
}

/** 一次性取全量原始数据(导出/迁移用)。 */
export async function getEverything() {
  return LS.get(null);
}

/**
 * 原子写:同一逻辑操作的多个 key 在一次 set 内提交(§4.7)。
 * @param {Record<string, any>} batch
 */
export async function writeBatch(batch) {
  await LS.set(batch);
}

/** 删除指定 snap key。 */
export async function removeSnaps(ids) {
  if (!ids.length) return;
  await LS.remove(ids.map((id) => `snap:${id}`));
}

/** 写图标(内容 hash 去重,已存在则复用)。 */
export async function ensureIcon(hash, dataUrl) {
  const key = `icon:${hash}`;
  const hit = await LS.get(key);
  if (hit[key]) return;
  await LS.set({ [key]: dataUrl });
}

/** 读单个图标。 */
export async function getIcon(hash) {
  if (!hash) return null;
  const r = await LS.get(`icon:${hash}`);
  return r[`icon:${hash}`] || null;
}

/** 计数派生(不落盘,由 index 重建)。 */
export function buildMeta(index) {
  let tabs = 0, groups = 0;
  for (const e of index) {
    if (e.type === "group") groups++;
    else tabs++;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    counts: { tabs, groups },
    sizeBytes: 0, // 由调用方按需用 getBytesInUse 填充
    updatedAt: Date.now(),
  };
}

/** 内存防重 Map:tab 按 url、group 按 name(§4.2 派生索引)。 */
export function buildLookup(index) {
  const byUrl = new Map();
  const byName = new Map();
  for (const e of index) {
    if (e.type === "tab" && e.url) byUrl.set(e.url, e.id);
    if (e.type === "group") byName.set(e.name, e.id);
  }
  return { byUrl, byName };
}
