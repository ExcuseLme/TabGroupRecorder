// 快照操作(§5 捕获防重 / §6 打开 / §7 重命名 / §8 删除)。
// 所有 tabGroups.update 写操作 try/catch 兜底(§13 Chrome 145)。

import {
  getFirstPaint, getSnaps, writeBatch, removeSnaps,
  ensureIcon, buildMeta,
} from "./storage.js";
import { currentWindowId } from "./capture.js";

const newId = () =>
  (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** 读当前 index(内存)。 */
async function loadIndex() {
  const { index } = await getFirstPaint();
  return index;
}

/* ================= §5 捕获 ================= */

/**
 * 捕获一个当前标签行 / 分组行 / 组内标签行。
 * @param {any} row readWindow() 返回的行
 */
export async function capture(row) {
  const index = await loadIndex();
  if (row.kind === "group") return captureGroup(row, index);
  // 组内标签:归入其父分组快照(而非独立标签)(P-23)
  if (row.groupRef) return captureTabInGroup(row, index);
  return captureTab(row, index);
}

/**
 * §5 补充:捕获「分组内的某个标签」→ 创建/合并到该标签所属分组的快照。
 * @param {{groupRef:{name,color}, url, name}} row 子标签行(带 groupRef)
 * @param {any[]} index 当前 index(用于查同名组)
 */
async function captureTabInGroup(row, index) {
  const g = row.groupRef;
  const name = g.name?.trim() || "标签组";
  const dupIdx = index.findIndex((e) => e.type === "group" && e.name === name);

  const now = Date.now();
  const cKey = row.url ? (await sha1(row.url)).slice(0, 16) : null;
  const childSnap = {
    id: newId(), type: "tab",
    name: row.name?.trim() || "标签",
    url: row.url,
    iconKey: cKey, createdAt: now, updatedAt: now,
  };
  if (cKey) await ensureIcon(cKey, row.url);

  // 组不存在 → 新建(复用创建分支)
  if (dupIdx === -1) {
    return captureGroupWithChildren({ name, color: g.color }, index, [childSnap], dupIdx);
  }

  // 组已存在 → **并集追加,绝不淘汰其它标签**(区别于整组 §5.3 替换式合并)
  const entry = index[dupIdx];
  const { [`snap:${entry.id}`]: existing } = await getSnaps([entry.id]);
  if (!existing) return { ok: false, error: "目标分组快照缺失" };

  const children = existing.children || [];
  const sameIdx = children.findIndex((c) => c.url === childSnap.url);
  let nextChildren;
  if (sameIdx !== -1) {
    // 同 url 已在组内:就地刷新(name/icon/updatedAt),不增不删
    nextChildren = children.slice();
    nextChildren[sameIdx] = { ...nextChildren[sameIdx], name: childSnap.name, iconKey: childSnap.iconKey, updatedAt: now };
  } else {
    nextChildren = [...children, childSnap];   // 追加到末尾
  }

  const snap = { ...existing, name, color: g.color, children: nextChildren, updatedAt: now };
  const nextIndex = index.slice();
  nextIndex[dupIdx] = { ...entry, name, color: g.color, childCount: nextChildren.length, updatedAt: now };
  await writeBatch({ [`snap:${entry.id}`]: snap, index: nextIndex, meta: buildMeta(nextIndex) });
  return { ok: true, merged: true, id: entry.id, appended: sameIdx === -1 };
}

/** §5.1 独立标签:按 url 查重 → **删旧建新**(重复捕获视为"最新"快照,P-24 方案X)。 */
async function captureTab(row, index) {
  const dupIdx = index.findIndex((e) => e.type === "tab" && e.url === row.url);
  // 重复捕获意图 = 作为最新快照:先移除已有快照,再重新捕获(不拒绝)
  let baseIndex = index;
  const removedId = dupIdx !== -1 ? index[dupIdx].id : null;
  if (dupIdx !== -1) baseIndex = index.filter((_, i) => i !== dupIdx);

  const iconKey = row.url ? (await sha1(row.url)).slice(0, 16) : null;
  const id = newId();
  const now = Date.now();
  const name = row.name?.trim() || "标签";   // 补充需求4:缺省名称
  const snap = {
    id, type: "tab", name, url: row.url,
    iconKey,
    createdAt: now, updatedAt: now,
  };
  const entry = {
    id, type: "tab", name, url: row.url,
    iconKey, updatedAt: now,
  };
  const nextIndex = [...baseIndex, entry];   // 新快照追加到末尾(最新位置)
  const batch = {
    [`snap:${id}`]: snap,
    index: nextIndex,
    meta: buildMeta(nextIndex),
  };
  // P-21:icon:{key} 存 pageUrl(渲染走 /_favicon 取图片数据,见参照扩展)
  if (iconKey) batch[`icon:${iconKey}`] = row.url;

  // 先删旧快照(set 删不掉 key,需显式 remove),再写新
  if (removedId) await removeSnaps([removedId]);
  await writeBatch(batch);
  return { ok: true, deduped: false, id, replaced: !!removedId };
}

/** §5.2 / §5.3 分组:按 name 防重,同名则合并(URL 并集 + 顺序更新)。 */
async function captureGroup(row, index) {
  const name = row.name?.trim() || "标签组";   // 补充需求4:缺省名称
  const dupIdx = index.findIndex((e) => e.type === "group" && e.name === name);

  // 组内标签 → TabSnapshot[](带各自 id)
  const childSnaps = [];
  for (const c of row.children) {
    const now = Date.now();
    const cKey = c.url ? (await sha1(c.url)).slice(0, 16) : null;
    childSnaps.push({
      id: newId(), type: "tab",
      name: c.name?.trim() || "标签",
      url: c.url,
      iconKey: cKey, createdAt: now, updatedAt: now,
    });
    // P-21:icon:{key} 存 pageUrl
    if (cKey) await ensureIcon(cKey, c.url);
  }
  return captureGroupWithChildren(row, index, childSnaps, dupIdx);
}

/**
 * 分组快照创建/合并核心(供整组捕获与组内单标签捕获复用)。
 * @param {{name,color}} row 分组行(取 name/color)
 * @param {any[]} index 当前 index
 * @param {TabSnapshot[]} childSnaps 待写入/合并的 children
 * @param {number} [dupIdx] 已算好的同名组下标(避免重复计算;缺省时内部重算)
 */
async function captureGroupWithChildren(row, index, childSnaps, dupIdx) {
  const name = row.name?.trim() || "标签组";
  if (dupIdx === undefined) dupIdx = index.findIndex((e) => e.type === "group" && e.name === name);

  if (dupIdx === -1) {
    const id = newId();
    const now = Date.now();
    const snap = {
      id, type: "group", name, color: row.color,
      children: childSnaps, createdAt: now, updatedAt: now,
    };
    const entry = {
      id, type: "group", name, color: row.color,
      childCount: childSnaps.length, updatedAt: now,
    };
    const next = [...index, entry];
    await writeBatch({ [`snap:${id}`]: snap, index: next, meta: buildMeta(next) });
    return { ok: true, merged: false, id };
  }

  // §5.3 同名合并
  const entry = index[dupIdx];
  const { [`snap:${entry.id}`]: existing } = await getSnaps([entry.id]);
  if (!existing) return { ok: false, error: "合并目标快照缺失" };

  const merged = mergeChildren(existing.children || [], childSnaps);
  const now = Date.now();
  const snap = {
    ...existing, name, color: row.color, children: merged, updatedAt: now,
  };
  const next = index.slice();
  next[dupIdx] = { ...entry, name, color: row.color, childCount: merged.length, updatedAt: now };
  await writeBatch({ [`snap:${entry.id}`]: snap, index: next, meta: buildMeta(next) });
  return { ok: true, merged: true, id: entry.id };
}

/** URL 并集去重 + 顺序以最新目标组为准(§5.3)。 */
function mergeChildren(existing, target) {
  const targetUrls = new Set(target.map((t) => t.url));
  const kept = existing.filter((e) => targetUrls.has(e.url)); // 保留仍在目标组中的
  const seen = new Set(kept.map((k) => k.url));
  const added = target.filter((t) => !seen.has(t.url));        // 目标新增的
  return [...target.filter((t) => kept.some((k) => k.url === t.url)), ...added]
    .sort((a, b) => target.findIndex((t) => t.url === a.url) - target.findIndex((t) => t.url === b.url));
}

/** url → 短 hash(用作 iconKey,见 P-21)。 */
async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ================= §6 打开 ================= */

/** 独立标签快照:新标签页打开其 URL。 */
export async function openTabSnapshot(snap) {
  await chrome.tabs.create({ url: snap.url, active: true });
}

/** 分组快照:创建同名同色组并在组内打开全部标签。 */
export async function openGroupSnapshot(snap) {
  await openGroupByName(snap.name, snap.color, snap.children.map((c) => c.url));
}

/** 组内标签快照:在同名组(存在则复用)中打开该标签。 */
export async function openChildSnapshot(groupSnap, child) {
  await openGroupByName(groupSnap.name, groupSnap.color, [child.url]);
}

async function openGroupByName(name, color, urls) {
  // 找同名组(复用)
  let groupId = null;
  try {
    const groups = await chrome.tabGroups.query({});
    const hit = groups.find((g) => g.title === name);
    if (hit) groupId = hit.id;
  } catch { /* §13 兜底:查询失败则新建 */ }

  const tabIds = [];
  for (const url of urls) {
    const t = await chrome.tabs.create({ url, active: false });
    if (t?.id != null) tabIds.push(t.id);
  }
  if (!tabIds.length) return;

  if (groupId == null) {
    groupId = await chrome.tabs.group({ tabIds });
  } else {
    await chrome.tabs.group({ tabIds, groupId });
  }

  // §13:Chrome 145 下 title 写入可能失败 → try/catch 兜底,color 同理
  try {
    await chrome.tabGroups.update(groupId, { title: name, color });
  } catch (e) {
    console.warn("[tabGroups.update] 失败(可能是 Chrome 145 已知 bug):", e);
    try { await chrome.tabGroups.update(groupId, { color }); } catch { /* 忽略 */ }
  }
}

/* ================= §7 重命名 ================= */

export async function renameSnapshot(id, name) {
  const index = await loadIndex();
  const i = index.findIndex((e) => e.id === id);
  if (i === -1) return { ok: false, error: "未找到" };
  const { [`snap:${id}`]: snap } = await getSnaps([id]);
  if (!snap) return { ok: false, error: "未找到" };
  const now = Date.now();
  const next = index.slice();
  next[i] = { ...index[i], name, updatedAt: now };
  await writeBatch({
    [`snap:${id}`]: { ...snap, name, updatedAt: now },
    index: next,
    meta: buildMeta(next),
  });
  return { ok: true };
}

/* ================= §8 删除 ================= */

export async function deleteSnapshot(id) {
  const index = await loadIndex();
  const i = index.findIndex((e) => e.id === id);
  if (i === -1) return { ok: false, error: "未找到" };
  const next = index.filter((e) => e.id !== id);
  await removeSnaps([id]);
  await writeBatch({ index: next, meta: buildMeta(next) });
  return { ok: true };
}

/** 组内标签:仅从该组中删除(§8)。 */
export async function deleteChild(groupId, childId) {
  const { [`snap:${groupId}`]: snap } = await getSnaps([groupId]);
  if (!snap || snap.type !== "group") return { ok: false, error: "未找到" };
  const children = snap.children.filter((c) => c.id !== childId);
  const index = await loadIndex();
  const i = index.findIndex((e) => e.id === groupId);
  const now = Date.now();
  const next = index.slice();
  if (i !== -1) next[i] = { ...index[i], childCount: children.length, updatedAt: now };
  await writeBatch({
    [`snap:${groupId}`]: { ...snap, children, updatedAt: now },
    index: next, meta: buildMeta(next),
  });
  return { ok: true };
}

/** 收起/展开**当前窗口全部**浏览器标签组(标题行"全部"按钮用)。§13 兜底。 */
export async function toggleAllBrowserGroups(collapsed) {
  try {
    const windowId = await currentWindowId();
    const groups = windowId != null
      ? await chrome.tabGroups.query({ windowId })   // 用 windowId(tabGroups 不支持 currentWindow,P-01 教训)
      : await chrome.tabGroups.query({});
    let n = 0;
    for (const g of groups || []) {
      if (g.collapsed === collapsed) continue;
      try { await chrome.tabGroups.update(g.id, { collapsed }); n++; }
      catch (e) { console.warn("[tabGroups.update all] 失败(可能是 Chrome 145 已知 bug):", e); }
    }
    return n;
  } catch (e) {
    console.warn("[tabGroups.query all] 失败:", e);
    return 0;
  }
}
