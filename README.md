# Brows

A Chrome extension that replaces the built-in history page with a SQLite-backed system featuring BM25-ranked full-text search, per-visit tracking, and automatic metadata extraction.

Chrome's native history stores minimal data and uses basic substring matching. Brows keeps every visit as a separate record with timestamps, transition types, and time-on-page duration. It extracts Open Graph tags, meta descriptions, keywords, and favicons from every page you visit. Search uses the BM25 ranking algorithm so results are ordered by relevance, not just recency.

## Features

- **BM25 full-text search** across title, URL, domain, path, meta description, keywords, and OG tags
- **Per-visit records** with timestamp, transition type (link, typed, reload, etc.), and duration
- **Metadata extraction** via content script: `<meta description>`, `<meta keywords>`, `og:title`, `og:description`, `og:image`, `<html lang>`, favicon
- **First-visit tracking** — stores both `first_visited_at` and `last_visited_at` per URL
- **SQLite storage** via sql.js (WASM), persisted to IndexedDB
- **Date range and domain filters** in the sidebar
- **Keyboard navigation** — arrow keys, Enter to open, Escape to clear
- **Expandable visit timeline** — click any result to see all visits with timestamps
- **Quick-search popup** with favicon and last-visit time
- **Automatic backups** every 6 hours (file download + redundant `chrome.storage.local` copy)
- **Manual export/import** of the full `.db` file from the history page sidebar
- **Auto-recovery** — if IndexedDB is wiped, restores from the `chrome.storage.local` backup on next startup
- **First-run import** of up to 10,000 entries from Chrome's built-in history

## Installation

Requires a Node.js package manager (npm, bun, pnpm, or yarn) to install the sql.js dependency.

```bash
git clone <repo-url> brows
cd brows
npm install   # or: bun install
npm run setup # optional: copy sql.js into lib/ (same as the manual cp below)
```

sql.js WASM files are already copied to `lib/`. If you need to refresh them:

```bash
cp node_modules/sql.js/dist/sql-wasm.js lib/sql-wasm.js
cp node_modules/sql.js/dist/sql-wasm.wasm lib/sql-wasm.wasm
```

Then load in Chrome:

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `brows/` directory
4. Open `chrome://history` — you'll see the Brows history page

## Project Structure

```
brows/
├── LICENSE                              # MIT license text
├── manifest.json                        # MV3 manifest
├── package.json
├── scripts/
│   └── copy-sqljs.js                    # Copies sql.js dist files into lib/
├── lib/
│   ├── sql-wasm.js                      # sql.js library
│   └── sql-wasm.wasm                    # SQLite compiled to WebAssembly
├── icons/                               # Extension icons (16, 48, 128 px)
└── src/
    ├── background/
    │   └── service-worker.js            # Visit capture, message routing, backups
    ├── db/
    │   ├── offscreen.html               # Host page for sql.js WASM
    │   ├── offscreen.js                 # All database operations
    │   ├── schema.js                    # Table definitions and migrations
    │   ├── bm25.js                      # BM25 scoring from FTS4 matchinfo
    │   └── persistence.js              # Serialize/restore DB to IndexedDB
    ├── content/
    │   └── metadata-extractor.js        # Extracts meta/OG tags from every page
    ├── history/
    │   ├── history.html                 # Overrides chrome://history
    │   ├── history.js                   # Search UI, filters, keyboard nav
    │   └── history.css
    ├── popup/
    │   ├── popup.html                   # Quick-search popup
    │   ├── popup.js
    │   └── popup.css
    └── shared/
        ├── messages.js                  # Message type constants
        └── utils.js                     # URL parsing, date formatting, debounce
```

## Architecture

```
┌─────────────┐    ┌──────────────────┐    ┌────────────────────┐
│  History     │    │  Service Worker   │    │ Offscreen Document │
│  Page /      │───>│                  │───>│                    │
│  Popup       │<───│  (message router,│<───│  sql.js (WASM)     │
│              │    │   visit capture,  │    │  SQLite DB         │
└─────────────┘    │   tab tracking,   │    │  FTS4 index        │
                   │   auto-backup)    │    │  BM25 scoring      │
┌─────────────┐    │                  │    │                    │
│  Content     │───>│                  │    │        ↕           │
│  Script      │    └──────────────────┘    │  IndexedDB         │
└─────────────┘                             └────────────────────┘
```

All database operations go through the offscreen document. The service worker routes messages between the UI pages, content scripts, and the offscreen document. This avoids WASM-in-service-worker limitations and keeps the DB in a long-lived context.

The service worker uses a retry loop (up to 8 attempts with linear backoff) instead of a ready-flag, so it survives MV3 service worker restarts transparently.

## Database Schema

**`pages`** — one row per unique URL:

| Column | Type | Description |
|---|---|---|
| `url` | TEXT UNIQUE | Full URL |
| `title` | TEXT | Page title |
| `domain` | TEXT | Hostname |
| `path` | TEXT | Pathname + query string |
| `first_visited_at` | INTEGER | Epoch ms of first visit |
| `last_visited_at` | INTEGER | Epoch ms of most recent visit |
| `visit_count` | INTEGER | Total visits |
| `favicon_url` | TEXT | Favicon URL |
| `meta_description` | TEXT | `<meta name="description">` |
| `meta_keywords` | TEXT | `<meta name="keywords">` |
| `og_title` | TEXT | `og:title` |
| `og_description` | TEXT | `og:description` |
| `og_image` | TEXT | `og:image` |
| `language` | TEXT | `<html lang>` value |

**`visits`** — one row per individual visit:

| Column | Type | Description |
|---|---|---|
| `page_id` | INTEGER FK | References `pages.id` |
| `visited_at` | INTEGER | Epoch ms |
| `transition_type` | TEXT | `link`, `typed`, `reload`, `imported`, etc. |
| `referrer_url` | TEXT | Referring page URL |
| `duration_ms` | INTEGER | Time spent on page |

**`pages_fts`** — FTS4 virtual table indexing 8 columns from `pages` for full-text search with `unicode61` tokenizer.

## BM25 Search

Search queries are tokenized, prefix-matched (`term*`), and scored using BM25 with weighted columns:

| Column | Weight | Rationale |
|---|---|---|
| title | 10.0 | Strongest relevance signal |
| url | 5.0 | Typed URLs are intentional |
| domain | 3.0 | Site-level matching |
| path | 2.0 | URL path segments |
| meta_description | 1.5 | Author-provided summary |
| meta_keywords | 1.0 | Supplementary terms |
| og_title | 1.0 | Social title variant |
| og_description | 1.0 | Social description variant |

The scoring uses standard BM25 parameters (k1 = 1.2, b = 0.75) and parses the raw `matchinfo('pcnalx')` blob from SQLite FTS4 in JavaScript.

When the search box is empty, results are sorted by `last_visited_at` descending.

## Data Durability

Three layers protect your history data:

1. **`unlimitedStorage` permission** — prevents Chrome from evicting IndexedDB under disk pressure
2. **`chrome.storage.local` redundant copy** — written every 6 hours alongside IndexedDB; the DB auto-recovers from this on startup if IndexedDB is empty
3. **File backup to downloads folder** — a `brows-history-backup.db` file is silently saved every 6 hours; can also be exported/imported manually from the sidebar

To migrate history to a new machine or after a reinstall, use **Export database** in the history page sidebar to download a `.db` file, then **Import backup** on the new installation.

## Permissions

| Permission | Why |
|---|---|
| `history` | Import existing Chrome history on first install |
| `webNavigation` | Detect page loads and transition types |
| `tabs` | Read tab title, URL, and favicon |
| `activeTab` | Content script access for metadata extraction |
| `storage` | Persist backup data in `chrome.storage.local` |
| `unlimitedStorage` | Prevent storage eviction |
| `offscreen` | Host the sql.js WASM database in an offscreen document |
| `alarms` | Schedule periodic auto-backups |
| `downloads` | Save backup files to the downloads folder |
| `<all_urls>` | Run the metadata-extraction content script on all pages |

## License

MIT — see [LICENSE](LICENSE).
