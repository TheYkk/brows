const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    title TEXT DEFAULT '',
    domain TEXT NOT NULL,
    path TEXT DEFAULT '',
    first_visited_at INTEGER NOT NULL,
    last_visited_at INTEGER NOT NULL,
    visit_count INTEGER DEFAULT 1,
    favicon_url TEXT,
    meta_description TEXT,
    meta_keywords TEXT,
    og_title TEXT,
    og_description TEXT,
    og_image TEXT,
    content_type TEXT,
    language TEXT,
    status_code INTEGER
);

CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    visited_at INTEGER NOT NULL,
    transition_type TEXT,
    referrer_url TEXT,
    duration_ms INTEGER DEFAULT 0,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts4(
    title, url, domain, path, meta_description, meta_keywords,
    og_title, og_description,
    tokenize=unicode61
);

CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
CREATE INDEX IF NOT EXISTS idx_pages_last_visited ON pages(last_visited_at);
CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
CREATE INDEX IF NOT EXISTS idx_visits_page_id ON visits(page_id);
CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON visits(visited_at);
`;

// Each migration is a function that receives the db handle.
// Index = version it migrates FROM (e.g. MIGRATIONS[1] upgrades v1 → v2).
const MIGRATIONS = [
  // placeholder for index 0 (no v0 → v1 migration; v1 is the baseline)
];

function getSchemaVersion(db) {
  try {
    const res = db.exec("SELECT value FROM meta WHERE key='schema_version'");
    if (res.length && res[0].values.length) {
      return parseInt(res[0].values[0][0], 10) || 0;
    }
  } catch {
    // meta table may not exist yet
  }
  return 0;
}

function initSchema(db) {
  db.run('PRAGMA foreign_keys=ON;');

  const currentVersion = getSchemaVersion(db);

  if (currentVersion === 0) {
    const stmts = SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      db.run(stmt + ';');
    }
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    return;
  }

  for (let v = currentVersion; v < SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) {
      console.warn(`[brows] no migration for v${v} → v${v + 1}, skipping`);
      continue;
    }
    console.log(`[brows] migrating schema v${v} → v${v + 1}`);
    db.run('BEGIN TRANSACTION');
    try {
      migrate(db);
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(v + 1)]);
      db.run('COMMIT');
    } catch (e) {
      db.run('ROLLBACK');
      console.error(`[brows] migration v${v} → v${v + 1} failed:`, e);
      throw e;
    }
  }
}
