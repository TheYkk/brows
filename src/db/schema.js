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

function initSchema(db) {
  db.run('PRAGMA journal_mode=WAL;');
  db.run('PRAGMA foreign_keys=ON;');

  const stmts = SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    db.run(stmt + ';');
  }

  const existing = db.exec("SELECT value FROM meta WHERE key='schema_version'");
  if (!existing.length || !existing[0].values.length) {
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  }
}
