-- ================================================================
--  ☁️ AbsoraCloud V3 — Unified D1 SQLite Schema
-- ================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  plan TEXT DEFAULT 'free',
  role TEXT DEFAULT 'user',
  locked_until DATETIME DEFAULT NULL,
  failed_login_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Instances (VPS, DevBox, WebHost, Serverless)
CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  service TEXT NOT NULL, -- 'vps', 'devbox', 'webhost', 'serverless'
  session_key TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'active', 'stopped', 'failed', 'expired', 'dismissed'
  config TEXT DEFAULT '{}',
  public_url TEXT DEFAULT NULL,
  runner_id TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT NULL,
  stopped_at DATETIME DEFAULT NULL
);

-- Runners (Kaggle kernels & compute daemons)
CREATE TABLE IF NOT EXISTS runners (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  service TEXT NOT NULL,
  capacity INTEGER DEFAULT 1,
  active_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ready',
  last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Cloud Storage Files
CREATE TABLE IF NOT EXISTS cloud_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER DEFAULT 0,
  cdn_url TEXT,
  provider TEXT DEFAULT 'local', -- 'local', 'cloudinary', 'imagekit'
  share_token TEXT DEFAULT NULL, -- inferred
  zone TEXT DEFAULT 'edge-us-east', -- inferred
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Bans (Platform abuse protection)
CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  service TEXT DEFAULT 'all',
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Community Support Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Ticket Replies
CREATE TABLE IF NOT EXISTS ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  is_staff INTEGER DEFAULT 0,
  message TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Realtime Events Log
CREATE TABLE IF NOT EXISTS realtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  provider TEXT DEFAULT 'pool',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
