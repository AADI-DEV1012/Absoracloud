-- ══════════════════════════════════════════════
-- AbsoraCloud V2 — Initial Schema
-- Target: Cloudflare D1 (SQLite)
-- ══════════════════════════════════════════════

-- ── Users & Auth (Global SSO) ──
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    plan          TEXT    DEFAULT 'free',
    role          TEXT    DEFAULT 'user',
    created_at    DATETIME DEFAULT (datetime('now')),
    locked_until  INTEGER  DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    token      TEXT    UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS bans (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT NOT NULL,
    service   TEXT NOT NULL,
    reason    TEXT,
    banned_at DATETIME DEFAULT (datetime('now'))
);

-- ── Instances (Unified across all services) ──
CREATE TABLE IF NOT EXISTS instances (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    service     TEXT    NOT NULL,
    status      TEXT    DEFAULT 'pending',
    runner_id   TEXT,
    session_key TEXT    UNIQUE,
    config      TEXT,
    public_url  TEXT,
    created_at  DATETIME DEFAULT (datetime('now')),
    expires_at  DATETIME,
    stopped_at  DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ── Runners (Active compute nodes) ──
CREATE TABLE IF NOT EXISTS runners (
    id             TEXT PRIMARY KEY,
    type           TEXT    NOT NULL,
    service        TEXT    NOT NULL,
    capacity       INTEGER DEFAULT 1,
    active_count   INTEGER DEFAULT 0,
    status         TEXT    DEFAULT 'starting',
    started_at     DATETIME DEFAULT (datetime('now')),
    last_heartbeat DATETIME
);

-- ── Plan Definitions ──
CREATE TABLE IF NOT EXISTS plan_definitions (
    plan_key        TEXT PRIMARY KEY,
    vps_hours_week  INTEGER DEFAULT 4,
    devbox_gpu_min  INTEGER DEFAULT 30,
    webhost_sites   INTEGER DEFAULT 1,
    vps_ram_mb      INTEGER DEFAULT 2048,
    storage_gb      INTEGER DEFAULT 5,
    priority        INTEGER DEFAULT 0
);

-- Seed default plans
INSERT OR IGNORE INTO plan_definitions (plan_key, vps_hours_week, devbox_gpu_min, webhost_sites, vps_ram_mb, storage_gb, priority)
VALUES
    ('free',       4,  30,  1,  2048,  5,   0),
    ('basic',      10, 120, 3,  4096,  25,  1),
    ('pro',        20, 240, 5,  8192,  75,  2),
    ('enterprise', 40, 480, 10, 16384, 200, 3);
