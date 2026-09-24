-- ══════════════════════════════════════════════
-- User storage credentials
-- ══════════════════════════════════════════════

ALTER TABLE users ADD COLUMN gdrive_refresh_token TEXT;
ALTER TABLE users ADD COLUMN github_storage_repo  TEXT;
ALTER TABLE users ADD COLUMN github_storage_token TEXT;
