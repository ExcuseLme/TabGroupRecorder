# TabGroupRecorder

A lightweight Chrome extension for capturing, browsing, and restoring browser tab groups and individual tabs as snapshots — a fast, local-first alternative to heavy tab-group bookmarking workflows.

> Replication and upgrade of the "Tab Groups Extension" snapshot workflow, redesigned for large snapshot collections with progressive loading instead of full upfront loading.

## Features

- **Capture** the current window's tabs and tab groups as snapshots — one at a time or all at once.
- **Snapshot records** — browse saved tab/group snapshots with the **newest capture first**; open, delete, and rename them in place.
- **Drag to reorder** — drag any snapshot row by its empty areas (not the name, URL, expand icon, or action buttons) to reorder group snapshots, standalone tab snapshots, and tabs inside a group; drag a child tab out of its group into the top level, or into another group (collapsed groups auto-expand on hover). Order is persisted and carried by export/import.
- **Smart capture de-duplication** — standalone tabs are de-duplicated by URL, groups by name. Re-capturing a group **only adds**: tabs captured this time come first (in Chrome's current order), while existing tabs missing from this capture are kept in their relative order at the bottom — never dropped. A tab captured inside a group is merged into that group's snapshot (never losing sibling tabs).
- **Open** a standalone tab, a whole group, or a single tab from within a group — always **in the background** (focus stays in the popup, so the panel stays open and you can open several in a row), reusing an existing same-name group in the current window when present.
- **Expand / collapse** tab groups in sync with Chrome (per-row and "expand/collapse all"), while snapshot records keep their own local state independent of Chrome. Snapshot-record groups start **fully collapsed** every time the panel opens.
- **Comfortable hit targets** — the `<>` / `><` expand icons are 16px visually but accept clicks across the **full row height** (**30×44**), and the header's expand/collapse-all button accepts **32×36**. Both show a light hover background over the enlarged area, so the clickable region is visible. Icon size, title position, row height and header height are unchanged, and the enlarged areas never overlap neighbouring text.
- **Two-step delete** — clicking **删除 (Delete)** turns that button into a red **确认 (Confirm)** in place; only a second click on the *same* button deletes. Any other interaction (click elsewhere, any keypress, scroll, right-click, typing, dragging, re-render) instantly reverts it to "Delete". There is no timeout.
- **Favicons** rendered via Chrome's internal `/_favicon/` endpoint (works for `localhost` and `chrome://` pages, offline-friendly, no CORS issues).
- **Export / import** snapshots as JSON — schema-validated import with overwrite mode and automatic backup; export triggers a standard browser download.
- **Regex search** in snapshot records — matches group titles, group-child titles/URLs, and standalone tab titles/URLs. **Filtering applies to top-level entries only**: once a group matches, all of its child tabs stay visible (expanded), so you can search a group name, then open the group and browse inside it. Groups matched through a child tab expand automatically; groups matched only by their own name start collapsed.
- **Tab-suspender aware** — [Tab Suspender Lite](https://github.com/) freezes a tab by navigating it to a self-describing placeholder page (`chrome-extension://<id>/suspended.html?url=…&title=…`), so the original title ends up stored **twice**: once as the tab title and once inside the placeholder URL. Editing either one of them in snapshot records updates the other automatically, so a restored tab never comes back with a stale title. The match is strict — exactly `url` then `title`, no extra params — and any other URL is left completely untouched.
- **No layout jump when scrolling** — the list reserves a permanent scrollbar gutter (`scrollbar-gutter: stable`), so rows and their right-aligned buttons never shift when the scrollbar appears.
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
| **快照记录 (Snapshot Records)** | Browse saved snapshots newest-first. Open / delete / rename entries; expand/collapse groups locally (all groups start collapsed on each open). Header offers **搜索 (Regex Search)**, **导出 (Export)** and **导入 (Import)**. |

Group rows show their group color; tab rows show their favicon. The `<>` / `><` icons indicate click-to-expand / click-to-collapse.

Search matches everything (group names, tabs inside groups, standalone tabs) but only filters the **top level**: a matching group is kept together with all of its tabs, so you can find a group by name and then open it to look for the entry you need.

## Project Structure

```
manifest.json         MV3 manifest, minimal permissions, action.default_popup
popup.html / popup.css   Static shell, layout, styles
src/
  popup.js            App entry: render pipeline, tab switching, fold controls
  capture.js          Reads current window tabs/groups from Chrome APIs
  operations.js       Capture / open / rename / delete / collapse / drag-drop reorder logic
  merge.js            Pure ordering + group-children merge rules (no DOM/chrome deps)
  search.js           Pure search rules: compile, match, and row planning (no DOM/chrome deps)
  url.js              URL candidates for opening + strict Tab Suspender Lite placeholder parse/rewrite (pure)
  drag.js             Snapshot-row drag controller (pointer state machine, drop targets)
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

## Testing

The in-browser self-test pages live under `docs/mockups/` (a git-ignored local folder). Load the
extension unpacked, then open a page from **your own extension ID** in the address bar — no local
server and no command line needed:

```
chrome-extension://<your-extension-id>/docs/mockups/selftest.html       # pure functions / CSS / geometry
chrome-extension://<your-extension-id>/docs/mockups/selftest-v1.html    # integration with the real popup.js
chrome-extension://<your-extension-id>/docs/mockups/selftest-node.html  # storage layer / drag-drop / export
```

The page title turns into `PASS n / FAIL 0` and every assertion is listed with pass/fail colouring.

Their scripts are kept in **external** files (`selftest.js`, `selftest-v1.js`, `selftest-node.js`)
on purpose: the MV3 CSP is `script-src 'self'`, which allows self-hosted scripts but blocks inline
`<script>` blocks. Opening the same file over `file://` does not work either — its `import` calls
fail the same-origin check. Nothing test-related needs to live in `src/` or `tools/`.

The only Node-based suite is the Chrome DevTools Protocol end-to-end runner, which has to drive a
real browser process and is therefore run by the agent, not by hand.

## Known Browser Issue

On **Chrome 145**, the `chrome.tabGroups` API has a known bug affecting group **collapse** and **title** updates (fixed in Chrome 146). All `tabGroups` write calls are wrapped defensively so a browser-side failure never breaks the popup UI.

## License

See [LICENSE](LICENSE).
