// ── Shared Constants — V3 Architecture ──

export const SERVICE_TYPES    = ['vps', 'devbox', 'webhost', 'serverless', 'storage'];
export const SESSION_STATUSES = ['pending', 'active', 'deploying', 'stopped', 'expired', 'failed', 'dismissed', 'disconnected'];
export const RUNNER_TYPES     = ['kaggle_cpu', 'kaggle_gpu', 'cloudflare_workers'];

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const RUNNER_TTL_SECONDS    = 25_200; // 7 hours
export const MAX_POLL_ATTEMPTS     = 90;
export const POLL_INTERVAL_MS      = 3_000;
