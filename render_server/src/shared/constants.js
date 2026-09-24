// ── Shared Constants ──

export const SERVICE_TYPES   = ['mc', 'vps', 'devbox', 'webhost'];
export const SESSION_STATUSES = ['pending', 'active', 'stopped', 'expired', 'error'];
export const RUNNER_TYPES    = ['github', 'kaggle', 'huggingface'];

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const RUNNER_TTL_SECONDS    = 25_200; // 7 hours
export const MAX_POLL_ATTEMPTS     = 90;
export const POLL_INTERVAL_MS      = 3_000;
