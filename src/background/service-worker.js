importScripts('../shared/messages.js');

// ── Offscreen Document Lifecycle ──

async function ensureOffscreen() {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
  } catch {
    // hasDocument can throw if called while creation is in flight
  }
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('src/db/offscreen.html'),
      reasons: ['WORKERS'],
      justification: 'SQLite WASM database for history storage',
    });
  } catch (e) {
    if (!e.message?.includes('Only a single offscreen')) throw e;
  }
}

const MAX_RETRIES = 8;
const RETRY_BASE_MS = 300;

async function sendToDB(message) {
  const tagged = { ...message, _dst: 'offscreen' };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await ensureOffscreen();
    try {
      const resp = await chrome.runtime.sendMessage(tagged);
      if (resp && resp.error === 'not_ready') {
        await sleep(RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      return resp;
    } catch {
      await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  return { error: 'DB unavailable after retries' };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Tab Duration Tracking ──

let activeTabInfo = { tabId: null, url: null, startTime: null, visitId: null };

function startTracking(tabId, url) {
  finishTracking();
  activeTabInfo = { tabId, url, startTime: Date.now(), visitId: null };
}

function finishTracking() {
  if (activeTabInfo.tabId && activeTabInfo.startTime) {
    const duration = Date.now() - activeTabInfo.startTime;
    if (duration > 1000 && activeTabInfo.url) {
      sendToDB({
        type: MSG.UPDATE_DURATION,
        data: { visitId: activeTabInfo.visitId, durationMs: duration },
      }).catch(() => {});
    }
  }
  activeTabInfo = { tabId: null, url: null, startTime: null, visitId: null };
}

// ── Visit Capture ──

function isTrackable(url) {
  return url && (url.startsWith('http://') || url.startsWith('https://'));
}

const pendingTransitions = new Map();

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isTrackable(details.url)) return;
  pendingTransitions.set(details.tabId, details.transitionType || 'unknown');
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!isTrackable(details.url)) return;

  const transitionType = pendingTransitions.get(details.tabId) || 'unknown';
  pendingTransitions.delete(details.tabId);

  try {
    const tab = await chrome.tabs.get(details.tabId);
    const url = new URL(details.url);

    const data = {
      url: details.url,
      title: tab.title || '',
      domain: url.hostname,
      path: url.pathname + url.search,
      visitedAt: Date.now(),
      transitionType,
      faviconUrl: tab.favIconUrl || null,
    };

    const result = await sendToDB({ type: MSG.PAGE_VISITED, data });
    if (result && result.pageId) {
      activeTabInfo.visitId = result.pageId;
    }

    startTracking(details.tabId, details.url);
  } catch (e) {
    // Tab may have been closed
  }
});

// ── Tab Switch / Focus Tracking ──

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (isTrackable(tab.url)) {
      startTracking(info.tabId, tab.url);
    } else {
      finishTracking();
    }
  } catch {
    finishTracking();
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    finishTracking();
  }
});

// ── Message Router ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === MSG.PAGE_METADATA && sender.tab) {
    sendToDB({ type: MSG.PAGE_METADATA, data: { ...msg.data, url: sender.tab.url } })
      .then(r => sendResponse(r))
      .catch(() => sendResponse(null));
    return true;
  }

  // Forward UI messages (search, stats, etc.) to offscreen DB
  if ([MSG.SEARCH, MSG.GET_RECENT, MSG.GET_VISITS, MSG.GET_STATS,
       MSG.GET_TOP_DOMAINS, MSG.DELETE_PAGE, MSG.DELETE_ALL,
       MSG.EXPORT_DB, MSG.IMPORT_DB].includes(msg.type)) {
    sendToDB(msg)
      .then(r => sendResponse(r))
      .catch(() => sendResponse({ error: 'DB unavailable' }));
    return true;
  }
});

// ── First-Run History Import ──

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;

  try {
    const items = await chrome.history.search({
      text: '',
      maxResults: 10000,
      startTime: 0,
    });

    const entries = [];
    for (const item of items) {
      if (!isTrackable(item.url)) continue;
      const url = new URL(item.url);
      entries.push({
        url: item.url,
        title: item.title || '',
        domain: url.hostname,
        path: url.pathname + url.search,
        visitedAt: item.lastVisitTime || Date.now(),
        transitionType: 'imported',
      });
    }

    if (entries.length) {
      const BATCH = 500;
      for (let i = 0; i < entries.length; i += BATCH) {
        await sendToDB({
          type: MSG.IMPORT_HISTORY,
          data: { entries: entries.slice(i, i + BATCH) },
        });
      }
    }

    console.log(`[brows] imported ${entries.length} history items`);
  } catch (e) {
    console.error('[brows] history import failed:', e);
  }
});

// ── Automatic Backup ──

const BACKUP_ALARM = 'brows-auto-backup';
const BACKUP_INTERVAL_MIN = 360; // 6 hours

chrome.alarms.create(BACKUP_ALARM, { periodInMinutes: BACKUP_INTERVAL_MIN });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== BACKUP_ALARM) return;
  await runAutoBackup();
});

async function runAutoBackup() {
  try {
    const resp = await sendToDB({ type: MSG.EXPORT_DB });
    if (!resp || resp.error || !resp.data) return;

    const bytes = new Uint8Array(resp.data);

    // Layer 1: redundant copy in chrome.storage.local (separate from IndexedDB)
    await chrome.storage.local.set({
      'brows-backup': Array.from(bytes),
      'brows-backup-time': Date.now(),
    });

    // Layer 2: save a real file to the downloads folder
    const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: 'brows-history-backup.db',
      conflictAction: 'overwrite',
      saveAs: false,
    }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

    console.log(`[brows] auto-backup complete (${(bytes.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    console.error('[brows] auto-backup failed:', e);
  }
}

// ── Startup ──

ensureOffscreen().catch(console.error);
