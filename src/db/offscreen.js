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
  } else {
    db = new SQL.Database();
  }
  initSchema(db);
  scheduleSave();
  console.log('[brows] DB initialized');
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

  syncFTS(pageId);
  markDirty();
  return pageId;
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

// ── Favicon Cache ──

function cacheFavicon(domain, dataUri) {
  db.run(
    'INSERT OR REPLACE INTO favicon_cache (domain, data, cached_at) VALUES (?, ?, ?)',
    [domain, dataUri, Date.now()]
  );
  markDirty();
}

function hasFavicon(domain) {
  const r = db.exec('SELECT 1 FROM favicon_cache WHERE domain = ?', [domain]);
  return r.length > 0 && r[0].values.length > 0;
}

function getUncachedDomains(limit = 50) {
  const result = db.exec(
    `SELECT DISTINCT p.domain FROM pages p
     LEFT JOIN favicon_cache fc ON p.domain = fc.domain
     WHERE fc.domain IS NULL
     ORDER BY p.last_visited_at DESC
     LIMIT ?`,
    [limit]
  );
  if (!result.length) return [];
  return result[0].values.map(r => r[0]);
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

  try {
    const stmt = db.prepare(
      "SELECT docid, matchinfo(pages_fts, 'pcnalx') as info FROM pages_fts WHERE pages_fts MATCH ?"
    );
    stmt.bind([ftsQuery]);

    const scored = [];
    while (stmt.step()) {
      const row = stmt.get();
      const docid = row[0];
      const infoBytes = row[1];
      scored.push({ docid, score: computeBM25(new Uint8Array(infoBytes), COLUMN_WEIGHTS) });
    }
    stmt.free();

    scored.sort((a, b) => b.score - a.score);
    const pageIds = scored.slice(offset, offset + limit).map(s => s.docid);
    if (!pageIds.length) return [];

    const placeholders = pageIds.map(() => '?').join(',');
    const pagesResult = db.exec(
      `SELECT * FROM pages WHERE id IN (${placeholders})`,
      pageIds
    );

    if (!pagesResult.length) return [];

    const cols = pagesResult[0].columns;
    const pageMap = {};
    for (const row of pagesResult[0].values) {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      pageMap[obj.id] = obj;
    }

    return pageIds
      .filter(id => pageMap[id])
      .map(id => {
        const p = pageMap[id];
        const s = scored.find(x => x.docid === id);
        return { ...p, _score: s ? s.score : 0 };
      });
  } catch (e) {
    console.error('[brows] search error:', e);
    return getRecent(limit, offset, opts);
  }
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

  const handle = async () => {
    switch (msg.type) {
      case MSG.PAGE_VISITED:
        return { pageId: upsertPage(msg.data) };

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
  chrome.runtime.sendMessage({ type: MSG.DB_READY });
}).catch(err => {
  console.error('[brows] DB init failed:', err);
});

window.addEventListener('beforeunload', forceSave);
