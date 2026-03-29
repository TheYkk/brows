let db = null;
let dirty = false;
let saveTimer = null;

async function initDB() {
  const SQL = await initSqlJs({
    locateFile: () => chrome.runtime.getURL('lib/sql-wasm.wasm'),
  });

  const saved = await loadDatabase();
  if (saved) {
    db = new SQL.Database(new Uint8Array(saved));
    console.log('[brows] DB loaded from IndexedDB');
  } else {
    // IndexedDB empty — try recovering from chrome.storage.local backup
    const fallback = await new Promise((resolve) => {
      chrome.storage.local.get(['brows-backup'], (r) => resolve(r['brows-backup']));
    });
    if (fallback && fallback.length) {
      db = new SQL.Database(new Uint8Array(fallback));
      console.log('[brows] DB restored from chrome.storage.local backup');
    } else {
      db = new SQL.Database();
      console.log('[brows] DB created fresh');
    }
  }
  initSchema(db);
  scheduleSave();
}

function markDirty() {
  dirty = true;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setInterval(async () => {
    if (!dirty || !db) return;
    try {
      await saveDatabase(db);
      dirty = false;
    } catch (e) {
      console.error('[brows] save failed:', e);
    }
  }, 30_000);
}

async function forceSave() {
  if (!db) return;
  try {
    await saveDatabase(db);
    dirty = false;
  } catch (e) {
    console.error('[brows] force save failed:', e);
  }
}

// ── Page Operations ──

function upsertPage(data) {
  const now = data.visitedAt || Date.now();
  const domain = data.domain || '';
  const path = data.path || '';

  const existing = db.exec('SELECT id, visit_count FROM pages WHERE url = ?', [data.url]);
  let pageId;

  if (existing.length && existing[0].values.length) {
    pageId = existing[0].values[0][0];
    const count = existing[0].values[0][1] + 1;
    db.run(
      `UPDATE pages SET title = COALESCE(NULLIF(?, ''), title),
       domain = COALESCE(NULLIF(?, ''), domain),
       path = COALESCE(NULLIF(?, ''), path),
       last_visited_at = ?, visit_count = ?,
       favicon_url = COALESCE(?, favicon_url)
       WHERE id = ?`,
      [data.title || '', domain, path, now, count, data.faviconUrl || null, pageId]
    );
  } else {
    db.run(
      `INSERT INTO pages (url, title, domain, path, first_visited_at, last_visited_at, visit_count, favicon_url)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [data.url, data.title || '', domain, path, now, now, data.faviconUrl || null]
    );
    const res = db.exec('SELECT last_insert_rowid()');
    pageId = res[0].values[0][0];
  }

  db.run(
    'INSERT INTO visits (page_id, visited_at, transition_type, referrer_url) VALUES (?, ?, ?, ?)',
    [pageId, now, data.transitionType || null, data.referrerUrl || null]
  );
  const visitRes = db.exec('SELECT last_insert_rowid()');
  const visitId = visitRes[0].values[0][0];

  syncFTS(pageId);
  markDirty();
  return { pageId, visitId };
}

function updateMetadata(data) {
  const existing = db.exec('SELECT id FROM pages WHERE url = ?', [data.url]);
  if (!existing.length || !existing[0].values.length) return;
  const pageId = existing[0].values[0][0];

  db.run(
    `UPDATE pages SET
       title = COALESCE(NULLIF(?, ''), title),
       meta_description = COALESCE(?, meta_description),
       meta_keywords = COALESCE(?, meta_keywords),
       og_title = COALESCE(?, og_title),
       og_description = COALESCE(?, og_description),
       og_image = COALESCE(?, og_image),
       language = COALESCE(?, language),
       favicon_url = COALESCE(?, favicon_url)
     WHERE id = ?`,
    [
      data.title || '',
      data.metaDescription || null,
      data.metaKeywords || null,
      data.ogTitle || null,
      data.ogDescription || null,
      data.ogImage || null,
      data.language || null,
      data.faviconUrl || null,
      pageId,
    ]
  );

  if (data.referrer) {
    db.run(
      `UPDATE visits SET referrer_url = ?
       WHERE id = (SELECT id FROM visits WHERE page_id = ? ORDER BY visited_at DESC LIMIT 1)`,
      [data.referrer, pageId]
    );
  }

  syncFTS(pageId);
  markDirty();
}

function updateDuration(visitId, durationMs) {
  db.run('UPDATE visits SET duration_ms = ? WHERE id = ?', [durationMs, visitId]);
  markDirty();
}

function syncFTS(pageId) {
  db.run('DELETE FROM pages_fts WHERE docid = ?', [pageId]);
  db.run(
    `INSERT INTO pages_fts (docid, title, url, domain, path, meta_description, meta_keywords, og_title, og_description)
     SELECT id, title, url, domain, path, meta_description, meta_keywords, og_title, og_description
     FROM pages WHERE id = ?`,
    [pageId]
  );
}

// ── Search ──

function search(query, opts = {}) {
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  if (!query || !query.trim()) {
    return getRecent(limit, offset, opts);
  }

  const terms = query.trim().split(/\s+/)
    .map(t => t.replace(/['"()*:\\^]/g, ''))
    .filter(Boolean);
  if (!terms.length) return getRecent(limit, offset, opts);

  const ftsQuery = terms.map(t => `${t}*`).join(' ');
  const results = ftsSearch(ftsQuery, limit, offset);
  if (results.length > 0) return results;

  const fuzzyResults = fuzzySearch(terms, limit, offset);
  if (fuzzyResults.length > 0) return fuzzyResults;

  return getRecent(limit, offset, opts);
}

function ftsSearch(ftsQuery, limit, offset) {
  try {
    const stmt = db.prepare(
      "SELECT docid, matchinfo(pages_fts, 'pcnalx') as info FROM pages_fts WHERE pages_fts MATCH ?"
    );
    stmt.bind([ftsQuery]);

    const scored = [];
    try {
      while (stmt.step()) {
        const row = stmt.get();
        scored.push({
          docid: row[0],
          score: computeBM25(new Uint8Array(row[1]), COLUMN_WEIGHTS),
        });
      }
    } finally {
      stmt.free();
    }

    scored.sort((a, b) => b.score - a.score);
    const pageIds = scored.slice(offset, offset + limit).map(s => s.docid);
    if (!pageIds.length) return [];

    return fetchPagesByIds(pageIds, scored);
  } catch (e) {
    console.error('[brows] FTS search error:', e);
    return [];
  }
}

function fuzzySearch(terms, limit, offset) {
  const prefixes = terms
    .map(t => t.substring(0, Math.max(3, Math.ceil(t.length * 0.7))))
    .filter(t => t.length >= 2);
  if (!prefixes.length) return [];

  const ftsQuery = prefixes.map(p => `${p}*`).join(' OR ');

  try {
    const stmt = db.prepare(
      "SELECT docid FROM pages_fts WHERE pages_fts MATCH ?"
    );
    stmt.bind([ftsQuery]);

    const candidateIds = [];
    try {
      while (stmt.step()) {
        candidateIds.push(stmt.get()[0]);
        if (candidateIds.length >= 500) break;
      }
    } finally {
      stmt.free();
    }

    if (!candidateIds.length) return [];

    const placeholders = candidateIds.map(() => '?').join(',');
    const result = db.exec(
      `SELECT * FROM pages WHERE id IN (${placeholders})`,
      candidateIds
    );
    if (!result.length) return [];

    const cols = result[0].columns;
    const scored = [];

    for (const row of result[0].values) {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });

      const fields = [obj.title, obj.url, obj.domain, obj.path,
        obj.meta_description, obj.meta_keywords, obj.og_title, obj.og_description]
        .filter(Boolean).join(' ');

      let totalDist = 0;
      let allMatched = true;

      for (const term of terms) {
        const dist = bestFuzzyDistance(term, fields);
        if (dist > fuzzyEditThreshold(term)) {
          allMatched = false;
          break;
        }
        totalDist += dist;
      }

      if (allMatched) {
        obj._score = 1 / (1 + totalDist);
        scored.push(obj);
      }
    }

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(offset, offset + limit);
  } catch (e) {
    console.error('[brows] fuzzy search error:', e);
    return [];
  }
}

function fetchPagesByIds(pageIds, scored) {
  const placeholders = pageIds.map(() => '?').join(',');
  const pagesResult = db.exec(
    `SELECT * FROM pages WHERE id IN (${placeholders})`,
    pageIds
  );

  if (!pagesResult.length) return [];

  const scoreMap = new Map(scored.map(s => [s.docid, s.score]));

  const cols = pagesResult[0].columns;
  const pageMap = new Map();
  for (const row of pagesResult[0].values) {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    pageMap.set(obj.id, obj);
  }

  return pageIds
    .filter(id => pageMap.has(id))
    .map(id => ({ ...pageMap.get(id), _score: scoreMap.get(id) || 0 }));
}

function getRecent(limit = 50, offset = 0, opts = {}) {
  let sql = 'SELECT * FROM pages';
  const params = [];
  const conditions = [];

  if (opts.domain) {
    conditions.push('domain = ?');
    params.push(opts.domain);
  }
  if (opts.startDate) {
    conditions.push('last_visited_at >= ?');
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    conditions.push('last_visited_at <= ?');
    params.push(opts.endDate);
  }

  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY last_visited_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = db.exec(sql, params);
  if (!result.length) return [];

  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

function getVisitsForPage(pageId) {
  const result = db.exec(
    'SELECT * FROM visits WHERE page_id = ? ORDER BY visited_at DESC',
    [pageId]
  );
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

function getStats() {
  const pages = db.exec('SELECT COUNT(*) FROM pages');
  const visits = db.exec('SELECT COUNT(*) FROM visits');
  const totalPages = pages.length ? pages[0].values[0][0] : 0;
  const totalVisits = visits.length ? visits[0].values[0][0] : 0;
  return { totalPages, totalVisits };
}

function getTopDomains(limit = 20) {
  const result = db.exec(
    'SELECT domain, COUNT(*) as cnt, SUM(visit_count) as total_visits FROM pages GROUP BY domain ORDER BY total_visits DESC LIMIT ?',
    [limit]
  );
  if (!result.length) return [];
  return result[0].values.map(r => ({ domain: r[0], pageCount: r[1], visitCount: r[2] }));
}

function deletePage(pageId) {
  db.run('DELETE FROM visits WHERE page_id = ?', [pageId]);
  db.run('DELETE FROM pages_fts WHERE docid = ?', [pageId]);
  db.run('DELETE FROM pages WHERE id = ?', [pageId]);
  markDirty();
}

function deleteAll() {
  db.run('DELETE FROM visits');
  db.run('DELETE FROM pages_fts');
  db.run('DELETE FROM pages');
  markDirty();
}

function bulkImport(entries) {
  db.run('BEGIN TRANSACTION');
  try {
    for (const entry of entries) {
      upsertPage(entry);
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    console.error('[brows] bulk import error:', e);
  }
  markDirty();
}

// ── Message Handler ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || msg._dst !== 'offscreen') return;

  if (!db) {
    sendResponse({ error: 'not_ready' });
    return true;
  }

  const handle = async () => {
    switch (msg.type) {
      case MSG.PAGE_VISITED:
        return upsertPage(msg.data);

      case MSG.PAGE_METADATA:
        updateMetadata(msg.data);
        return { ok: true };

      case MSG.UPDATE_DURATION:
        updateDuration(msg.data.visitId, msg.data.durationMs);
        return { ok: true };

      case MSG.SEARCH:
        return { results: search(msg.data.query, msg.data.opts) };

      case MSG.GET_RECENT:
        return { results: getRecent(msg.data?.limit, msg.data?.offset, msg.data?.opts) };

      case MSG.GET_VISITS:
        return { visits: getVisitsForPage(msg.data.pageId) };

      case MSG.GET_STATS:
        return getStats();

      case MSG.GET_TOP_DOMAINS:
        return { domains: getTopDomains(msg.data?.limit) };

      case MSG.DELETE_PAGE:
        deletePage(msg.data.pageId);
        return { ok: true };

      case MSG.DELETE_ALL:
        deleteAll();
        return { ok: true };

      case MSG.IMPORT_HISTORY:
        bulkImport(msg.data.entries);
        await forceSave();
        return { ok: true };

      case MSG.EXPORT_DB: {
        await forceSave();
        const bytes = db.export();
        return { data: Array.from(bytes) };
      }

      case MSG.IMPORT_DB: {
        const SQL = await initSqlJs({
          locateFile: () => chrome.runtime.getURL('lib/sql-wasm.wasm'),
        });
        const incoming = new Uint8Array(msg.data.bytes);
        const newDb = new SQL.Database(incoming);
        // Verify the imported DB has the expected tables
        const check = newDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='pages'");
        if (!check.length || !check[0].values.length) {
          newDb.close();
          return { error: 'Invalid database file: missing pages table' };
        }
        if (db) db.close();
        db = newDb;
        await forceSave();
        const stats = getStats();
        return { ok: true, ...stats };
      }

      default:
        return null;
    }
  };

  handle().then(result => {
    if (result !== null) sendResponse(result);
  }).catch(err => {
    console.error('[brows] message handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

// ── Init ──

initDB().then(() => {
  console.log('[brows] offscreen DB ready');
}).catch(err => {
  console.error('[brows] DB init failed:', err);
});

window.addEventListener('beforeunload', forceSave);
