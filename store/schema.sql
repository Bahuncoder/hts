-- Reference data. Read-heavy, single-writer, rebuilt from public sources.
-- Ships as a build artifact so no database needs provisioning at deploy time.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS hts (
    hts           TEXT PRIMARY KEY,
    digits        TEXT NOT NULL,
    indent        INTEGER NOT NULL,
    description   TEXT NOT NULL,
    full_path     TEXT NOT NULL,
    general_rate  TEXT,
    special_rate  TEXT,
    other_rate    TEXT,
    units         TEXT,
    is_leaf       INTEGER NOT NULL DEFAULT 0,
    chapter       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hts_digits  ON hts(digits);
CREATE INDEX IF NOT EXISTS hts_chapter ON hts(chapter);
CREATE INDEX IF NOT EXISTS hts_leaf    ON hts(is_leaf);

-- Chapter 99 remedy rules, parsed from the rate lines.
CREATE TABLE IF NOT EXISTS ch99_rule (
    hts               TEXT PRIMARY KEY,
    effect            TEXT NOT NULL,
    rate_pct          REAL,
    countries         TEXT,
    base_refs         TEXT,
    excepts           TEXT,
    suspended         INTEGER NOT NULL DEFAULT 0,
    suspension_note   TEXT,
    country_inherited INTEGER NOT NULL DEFAULT 0,
    raw_rate          TEXT,
    description       TEXT
);

-- Product scope recovered from the Chapter 99 U.S. Notes (PDF prose).
CREATE TABLE IF NOT EXISTS ch99_scope (
    heading        TEXT NOT NULL,
    code           TEXT NOT NULL,
    PRIMARY KEY (heading, code)
);
CREATE INDEX IF NOT EXISTS scope_code ON ch99_scope(code);

CREATE TABLE IF NOT EXISTS ch99_scope_meta (
    heading         TEXT PRIMARY KEY,
    note            TEXT,
    countries       TEXT,
    code_count      INTEGER,
    effective_from  TEXT,
    described_scope INTEGER DEFAULT 0,
    source_excerpt  TEXT
);

-- CBP CROSS classification rulings; each is pre-tagged with its HTS codes.
CREATE TABLE IF NOT EXISTS ruling (
    ruling_number TEXT PRIMARY KEY,
    subject       TEXT,
    ruling_date   TEXT,
    collection    TEXT,
    categories    TEXT,
    tariffs       TEXT,
    body          TEXT,
    revoked       INTEGER NOT NULL DEFAULT 0,
    url           TEXT
);
CREATE INDEX IF NOT EXISTS ruling_date ON ruling(ruling_date);

-- Maps a ruling to each HTS code it classifies to, for precedent lookup.
CREATE TABLE IF NOT EXISTS ruling_tariff (
    ruling_number TEXT NOT NULL,
    hts           TEXT NOT NULL,
    digits        TEXT NOT NULL,
    PRIMARY KEY (ruling_number, hts)
);
CREATE INDEX IF NOT EXISTS rt_digits ON ruling_tariff(digits);

-- Federal Register tariff actions, for the change log and alerts.
CREATE TABLE IF NOT EXISTS fr_document (
    document_number TEXT PRIMARY KEY,
    title           TEXT,
    doc_type        TEXT,
    publication_date TEXT,
    html_url        TEXT,
    abstract        TEXT,
    agencies        TEXT,
    hts_mentions    TEXT,
    seen_at         TEXT,
    raw_text_url    TEXT
);
CREATE INDEX IF NOT EXISTS fr_pub ON fr_document(publication_date);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
