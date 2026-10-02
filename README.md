# TabGroupRecorder

A lightweight Chrome extension for capturing, browsing, and restoring browser tab groups and individual tabs as snapshots — a fast, local-first alternative to heavy tab-group bookmarking workflows.

> Replication and upgrade of the "Tab Groups Extension" snapshot workflow, redesigned for large snapshot collections with progressive loading instead of full upfront loading.

## Features

- **Capture** the current window's tabs and tab groups as snapshots — one at a time or all at once.
- **Snapshot records** — browse saved tab/group snapshots; open, delete, and rename them in place.
- **Smart capture de-duplication** — standalone tabs are de-duplicated by URL, groups by name; re-capturing an existing item refreshes it as the newest entry, and a tab captured inside a group is merged into that group's snapshot (never losing sibling tabs).
- **Open** a standalone tab, a whole group, or a single tab from within a group — reusing an existing same-name group in the current window when present.
- **Expand / collapse** tab groups in sync with Chrome (per-row and "expand/collapse all"), while snapshot records keep their own local state independent of Chrome.
- **Favicons** rendered via Chrome's internal `/_favicon/` endpoint (works for `localhost` and `chrome://` pages, offline-friendly, no CORS issues).
- **Export / import** snapshots as JSON — schema-validated import with overwrite mode and automatic backup; export triggers a standard browser download.
- **Fast startup** — the popup renders a static shell first (zero async), then loads data and lazy-loads icons, so opening the panel is never blocked by data loading.

## Requirements

- Google Chrome **89+**
- Manifest V3

## Installation (unpacked)

No build step required — the extension is plain JavaScript.

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this repository's root directory
4. Click the extension icon in the toolbar to open the popup

## Usage

| Tab | Description |
|---|---|
| **当前标签 (Current Tabs)** | Live view of all tabs and groups in the current window. Use **捕获 (Capture)** per row, or **捕获全部 (Capture All)** in the header, to save snapshots. |
| **快照记录 (Snapshot Records)** | Browse saved snapshots. Open / delete / rename entries; expand/collapse groups locally. Header offers **导出 (Export)** and **导入 (Import)**. |

Group rows show their group color; tab rows show their favicon. The `<>` / `><` icons indicate click-to-expand / click-to-collapse.

## Project Structure

```
manifest.json         MV3 manifest, minimal permissions, action.default_popup
popup.html / popup.css   Static shell, layout, styles
src/
  popup.js            App entry: render pipeline, tab switching, fold controls
  capture.js          Reads current window tabs/groups from Chrome APIs
  operations.js       Capture / open / rename / delete / collapse logic
  storage.js          Layered chrome.storage.local access (meta/index/snap:*/icon:*)
  transfer.js         JSON export (a[download]) + import with schema validation
  render.js           List rendering, state icons, in-place rename
  types.js            Data contracts (JSDoc)
assets/               Extension icons
tools/gen-icons.js    Zero-dependency icon generator (Node)
docs/                 Design spec & issue tracking (git-ignored, local only)
```

## Design Notes

- **Layered storage** — `chrome.storage.local` is split into `meta` / `index` / `snap:{id}` / `icon:{hash}` keys so the first paint reads only a small index, keeping startup fast regardless of collection size.
- **Progressive rendering** — static shell first, then data, then lazy icon hydration; the list is rendered as a single pass with native scrolling.
- **No build chain** — plain ES modules loaded directly by Chrome.

## Known Browser Issue

On **Chrome 145**, the `chrome.tabGroups` API has a known bug affecting group **collapse** and **title** updates (fixed in Chrome 146). All `tabGroups` write calls are wrapped defensively so a browser-side failure never breaks the popup UI.

## License

See [LICENSE](LICENSE).
