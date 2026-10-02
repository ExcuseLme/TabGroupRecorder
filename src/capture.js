// 当前标签数据源(§3):读取当前窗口的标签与分组。
// popup 直连 chrome.tabs / chrome.tabGroups,不经 service worker(§14.1)。

/** 读取当前窗口结构,返回可直接渲染的行模型。 */
/** 取当前窗口 windowId(tabs.query 支持 currentWindow;tabGroups.query 不支持,须用 windowId)。 */
export async function currentWindowId() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs[0]?.windowId ?? null;
  } catch { return null; }
}

export async function readWindow() {
  // 先取当前窗口的 tabs 与 windowId(tabs.query 支持 currentWindow)
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const windowId = tabs[0]?.windowId;
  // tabGroups.query 不支持 currentWindow,需用 windowId(或省略 = 所有窗口)
  const groups = windowId != null
    ? await chrome.tabGroups.query({ windowId })
    : await chrome.tabGroups.query({});

  const groupById = new Map(groups.map((g) => [g.id, g]));
  // 按 index 排序,保持窗口内真实顺序
  tabs.sort((a, b) => a.index - b.index);

  /** @type {any[]} */
  const rows = [];
  const emittedGroups = new Set();

  for (const tab of tabs) {
    const gid = tab.groupId;
    if (gid != null && gid !== -1 && groupById.has(gid)) {
      if (!emittedGroups.has(gid)) {
        emittedGroups.add(gid);
        const g = groupById.get(gid);
        const members = tabs.filter((t) => t.groupId === gid);
        rows.push({
          kind: "group",
          id: `grp:${gid}`,
          groupId: gid,
          name: g.title || "(未命名分组)",
          color: g.color,
          collapsed: g.collapsed,
          children: members.map(tabToRow),
        });
      }
    } else {
      rows.push(tabToRow(tab));
    }
  }
  return rows;
}

function tabToRow(tab) {
  return {
    kind: "tab",
    id: `tab:${tab.id}`,
    tabId: tab.id,
    name: tab.title || "(无标题)",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || "",
  };
}

