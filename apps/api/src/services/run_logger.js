// ── Run Logger Service ──
// Stores disk-backed logs for each run (devbox, serverless, vps, webhost)
// in the dedicated Absoracloud_Bot Log Vault (10 GB pool) with multi-tier persistence
// across Render restarts via Upstash Redis and Cloudflare D1.

import fs from 'fs';
import path from 'path';
import { executeD1, queryD1 } from '../../../../packages/shared/d1.js';
import { redisCmd } from '../../../../packages/shared/redis.js';

const MAX_LOG_DISK_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB pool
const PRUNE_THRESHOLD_BYTES = 9.5 * 1024 * 1024 * 1024; // Trigger pruning at 9.5 GB
const PRUNE_TARGET_BYTES = 8.5 * 1024 * 1024 * 1024; // Prune to 8.5 GB when near limit
const BOT_USER_ID = 9; // Dedicated Absoracloud_Bot account user ID
const BOT_USERNAME = 'Absoracloud_Bot';

const LOGS_ROOT = process.env.LOGS_DIR || (
  fs.existsSync('/opt/absoracloud-data')
    ? '/opt/absoracloud-data/run_logs'
    : path.resolve(process.cwd(), 'data/run_logs')
);

// Ensure directories exist for all services
const SERVICES = ['devbox', 'vps', 'serverless', 'webhost', 'runners'];
for (const s of SERVICES) {
  try {
    fs.mkdirSync(path.join(LOGS_ROOT, s), { recursive: true });
  } catch (e) {
    console.error(`[RunLogger] Error creating log dir for ${s}:`, e.message);
  }
}

// In-memory tracking for persistent metrics across Render restarts
let persistentLogBytes = 0;
let persistentLogCount = 0;
let persistentBreakdown = { devbox: 0, vps: 0, serverless: 0, webhost: 0, runners: 0 };

// Initialize persistent metrics from D1 on server boot
async function initPersistentMetrics() {
  try {
    const rows = await queryD1(
      "SELECT service, COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as total FROM session_logs GROUP BY service"
    ).catch(() => []);

    let total = 0;
    let count = 0;
    const bd = { devbox: 0, vps: 0, serverless: 0, webhost: 0, runners: 0 };

    if (Array.isArray(rows)) {
      for (const r of rows) {
        const s = (r.service || '').toLowerCase();
        const bytes = Number(r.total || 0);
        const cnt = Number(r.cnt || 0);
        if (bd[s] !== undefined) bd[s] = bytes;
        total += bytes;
        count += cnt;
      }
    }

    persistentLogBytes = total;
    persistentLogCount = count;
    persistentBreakdown = bd;
  } catch (_) {}
}
initPersistentMetrics();

// Debounce queue for synchronizing logs to D1
const d1SyncQueue = new Map();
let d1SyncTimer = null;

function scheduleD1Sync(service, runId, newChunk) {
  const key = `${service}:${runId}`;
  const existing = d1SyncQueue.get(key) || { service, runId, chunks: [] };
  existing.chunks.push(newChunk);
  d1SyncQueue.set(key, existing);

  if (!d1SyncTimer) {
    d1SyncTimer = setTimeout(flushD1SyncQueue, 3500);
  }
}

async function flushD1SyncQueue() {
  d1SyncTimer = null;
  const entries = Array.from(d1SyncQueue.values());
  d1SyncQueue.clear();

  for (const item of entries) {
    const combined = item.chunks.join('');
    const bytes = Buffer.byteLength(combined, 'utf8');
    const sanitizedId = String(item.runId).replace(/[^a-zA-Z0-9_-]/g, '_');

    try {
      // 1. Sync into session_logs table
      await executeD1(
        `INSERT INTO session_logs (user_id, service, session_key, log_content, size_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(session_key) DO UPDATE SET
           log_content = log_content || excluded.log_content,
           size_bytes = size_bytes + excluded.size_bytes,
           updated_at = datetime('now')`,
        [BOT_USER_ID, item.service, sanitizedId, combined, bytes]
      ).catch(() => {});

      // 2. Sync into cloud_files table under Absoracloud_Bot
      const filename = `${item.service}_${sanitizedId}.log`;
      const storedName = `run_logs/${item.service}/${sanitizedId}.log`;

      await executeD1(
        `INSERT INTO cloud_files (user_id, filename, stored_name, file_size, mime_type, provider, storage_type, created_at)
         VALUES (?, ?, ?, ?, 'text/plain', 'bot_vault', 'audit_log', datetime('now'))`,
        [BOT_USER_ID, filename, storedName, bytes]
      ).catch(async () => {
        // If file already exists, update size
        await executeD1(
          "UPDATE cloud_files SET file_size = file_size + ? WHERE user_id = ? AND filename = ?",
          [bytes, BOT_USER_ID, filename]
        ).catch(() => {});
      });
    } catch (_) {}
  }
}

/**
 * Calculates total size of all stored run logs in Absoracloud_Bot's Log Vault.
 * Accurately merges local disk stats and persistent D1/Redis storage.
 */
export function getLogDiskUsage() {
  let localBytes = 0;
  let localFileCount = 0;
  const breakdown = { devbox: 0, vps: 0, serverless: 0, webhost: 0, runners: 0 };
  const filesList = [];

  for (const s of SERVICES) {
    const dir = path.join(LOGS_ROOT, s);
    if (!fs.existsSync(dir)) continue;

    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (!item.endsWith('.log')) continue;
        const filePath = path.join(dir, item);
        try {
          const stats = fs.statSync(filePath);
          localBytes += stats.size;
          localFileCount++;
          breakdown[s] += stats.size;
          filesList.push({
            service: s,
            runId: item.replace(/\.log$/, ''),
            filename: item,
            filePath,
            sizeBytes: stats.size,
            sizeKB: (stats.size / 1024).toFixed(1),
            mtime: stats.mtime
          });
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Count files per service
  const filesCountByService = { devbox: 0, vps: 0, serverless: 0, webhost: 0, runners: 0 };
  for (const f of filesList) {
    if (filesCountByService[f.service] !== undefined) filesCountByService[f.service]++;
  }

  // Sort files by last modified descending
  filesList.sort((a, b) => b.mtime - a.mtime);

  // If local disk was wiped by a Render restart, seamlessly use persistent metrics
  const effectiveTotalBytes = Math.max(localBytes, persistentLogBytes);
  const effectiveFileCount = Math.max(localFileCount, persistentLogCount);
  const effectiveBreakdown = {
    devbox: Math.max(breakdown.devbox, persistentBreakdown.devbox || 0),
    vps: Math.max(breakdown.vps, persistentBreakdown.vps || 0),
    serverless: Math.max(breakdown.serverless, persistentBreakdown.serverless || 0),
    webhost: Math.max(breakdown.webhost, persistentBreakdown.webhost || 0),
    runners: Math.max(breakdown.runners, persistentBreakdown.runners || 0)
  };

  const totalMBVal = effectiveTotalBytes / (1024 * 1024);
  const percentUsed = Math.min(100, parseFloat(((effectiveTotalBytes / MAX_LOG_DISK_BYTES) * 100).toFixed(2)));
  const remainingMB = Math.max(0, parseFloat((10240 - totalMBVal).toFixed(2)));

  return {
    totalBytes: effectiveTotalBytes,
    totalMB: totalMBVal.toFixed(2),
    remainingMB: remainingMB.toFixed(2),
    maxMB: 10240, // 10 GB
    poolGB: 10,
    maxBytes: MAX_LOG_DISK_BYTES,
    percentUsed,
    fileCount: effectiveFileCount,
    logsRoot: LOGS_ROOT,
    owner: BOT_USERNAME,
    ownerId: BOT_USER_ID,
    pruneThresholdMB: 9728, // 9.5 GB
    pruneTargetMB: 8704, // 8.5 GB
    breakdown: {
      devboxMB: (effectiveBreakdown.devbox / (1024 * 1024)).toFixed(2),
      vpsMB: (effectiveBreakdown.vps / (1024 * 1024)).toFixed(2),
      serverlessMB: (effectiveBreakdown.serverless / (1024 * 1024)).toFixed(2),
      webhostMB: (effectiveBreakdown.webhost / (1024 * 1024)).toFixed(2),
      runnersMB: (effectiveBreakdown.runners / (1024 * 1024)).toFixed(2)
    },
    breakdownBytes: effectiveBreakdown,
    breakdownFiles: filesCountByService,
    files: filesList
  };
}

/**
 * Enforces the 10 GB Log Vault quota. If total logs exceed 9.5 GB, deletes oldest logs.
 */
export function ensureDiskUnderQuota() {
  const usage = getLogDiskUsage();
  if (usage.totalBytes <= PRUNE_THRESHOLD_BYTES) return;

  console.warn(`[RunLogger] Absoracloud_Bot Log Vault (${usage.totalMB}MB) near 10GB limit. Pruning oldest logs...`);
  const oldestFirst = [...usage.files].sort((a, b) => a.mtime - b.mtime);

  let currentBytes = usage.totalBytes;
  for (const item of oldestFirst) {
    if (currentBytes <= PRUNE_TARGET_BYTES) break;
    try {
      fs.unlinkSync(item.filePath);
      currentBytes -= item.sizeBytes;
      persistentLogBytes = Math.max(0, persistentLogBytes - item.sizeBytes);
      persistentLogCount = Math.max(0, persistentLogCount - 1);

      // Also prune from Redis and D1
      redisCmd('DEL', `log:${item.service}:${item.runId}`).catch(() => {});
      executeD1("DELETE FROM session_logs WHERE session_key = ?", [item.runId]).catch(() => {});
      executeD1("DELETE FROM cloud_files WHERE user_id = ? AND filename = ?", [BOT_USER_ID, `${item.service}_${item.runId}.log`]).catch(() => {});

      console.log(`[RunLogger] Pruned old log: ${item.service}/${item.filename} (${item.sizeKB}KB)`);
    } catch (e) {
      console.error(`[RunLogger] Error unlinking ${item.filePath}:`, e.message);
    }
  }
}

/**
 * Appends standard log entries to a run's log file on disk, Upstash Redis, and D1.
 */
export function appendRunLog(service, runId, message, level = 'INFO') {
  if (!SERVICES.includes(service) || !runId) return;

  const sanitizedId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const serviceDir = path.join(LOGS_ROOT, service);
  const filePath = path.join(serviceDir, `${sanitizedId}.log`);

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');

  try {
    fs.appendFileSync(filePath, line, 'utf8');

    // Update memory metrics
    persistentLogBytes += bytes;
    if (persistentBreakdown[service] !== undefined) persistentBreakdown[service] += bytes;

    // Asynchronously append to Upstash Redis (with 30-day retention)
    redisCmd('APPEND', `log:${service}:${sanitizedId}`, line).catch(() => {});
    redisCmd('EXPIRE', `log:${service}:${sanitizedId}`, '2592000').catch(() => {});

    // Asynchronously sync to D1
    scheduleD1Sync(service, sanitizedId, line);

    ensureDiskUnderQuota();
  } catch (err) {
    console.error(`[RunLogger] Error writing log for ${service}/${sanitizedId}:`, err.message);
  }
}

/**
 * Appends raw terminal session I/O chunks (user keystrokes, commands & stdout/stderr)
 * into the run's audit log on disk, Upstash Redis, and D1.
 */
export function appendSessionIOLog(service, runId, rawLogs) {
  if (!SERVICES.includes(service) || !runId || !rawLogs) return;

  const sanitizedId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const serviceDir = path.join(LOGS_ROOT, service);
  const filePath = path.join(serviceDir, `${sanitizedId}.log`);
  const bytes = Buffer.byteLength(rawLogs, 'utf8');

  try {
    fs.appendFileSync(filePath, rawLogs, 'utf8');

    // Update memory metrics
    persistentLogBytes += bytes;
    if (persistentBreakdown[service] !== undefined) persistentBreakdown[service] += bytes;

    // Asynchronously append to Upstash Redis
    redisCmd('APPEND', `log:${service}:${sanitizedId}`, rawLogs).catch(() => {});
    redisCmd('EXPIRE', `log:${service}:${sanitizedId}`, '2592000').catch(() => {});

    // Asynchronously sync to D1
    scheduleD1Sync(service, sanitizedId, rawLogs);

    ensureDiskUnderQuota();
  } catch (err) {
    console.error(`[RunLogger] Error writing session I/O for ${service}/${sanitizedId}:`, err.message);
  }
}

/**
 * Reads the full log file for a specific run.
 * If local file was lost during a Render restart, restores seamlessly from Redis or D1!
 */
export async function getRunLogAsync(service, runId) {
  if (!SERVICES.includes(service) || !runId) return null;

  const sanitizedId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const serviceDir = path.join(LOGS_ROOT, service);
  const filePath = path.join(serviceDir, `${sanitizedId}.log`);

  // If local file is missing, restore from Redis or D1
  if (!fs.existsSync(filePath)) {
    try {
      let restored = await redisCmd('GET', `log:${service}:${sanitizedId}`).catch(() => null);
      if (!restored) {
        const rows = await queryD1(
          "SELECT log_content FROM session_logs WHERE session_key = ? LIMIT 1",
          [sanitizedId]
        ).catch(() => []);
        if (rows && rows[0]?.log_content) {
          restored = rows[0].log_content;
        }
      }

      if (restored) {
        fs.writeFileSync(filePath, restored, 'utf8');
      }
    } catch (_) {}
  }

  return getRunLog(service, runId);
}

/**
 * Synchronous read of log file for backwards compatibility.
 */
export function getRunLog(service, runId) {
  if (!SERVICES.includes(service) || !runId) return null;

  const sanitizedId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(LOGS_ROOT, service, `${sanitizedId}.log`);

  if (!fs.existsSync(filePath)) {
    return {
      service,
      runId: sanitizedId,
      exists: false,
      content: `No log entries recorded yet for ${service} run [${sanitizedId}].`
    };
  }

  try {
    const stats = fs.statSync(filePath);
    const MAX_READ = 2 * 1024 * 1024;
    let content = '';

    if (stats.size > MAX_READ) {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(MAX_READ);
      fs.readSync(fd, buffer, 0, MAX_READ, stats.size - MAX_READ);
      fs.closeSync(fd);
      content = `... [Truncated: showing last 2MB of ${(stats.size / (1024 * 1024)).toFixed(2)}MB log] ...\n` + buffer.toString('utf8');
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }

    return {
      service,
      runId: sanitizedId,
      exists: true,
      sizeBytes: stats.size,
      sizeKB: (stats.size / 1024).toFixed(1),
      mtime: stats.mtime,
      content
    };
  } catch (err) {
    return {
      service,
      runId: sanitizedId,
      exists: false,
      content: `Error reading log: ${err.message}`
    };
  }
}

/**
 * Manually purge all or specific service logs across local disk, Redis, and D1.
 */
export async function purgeLogs(service = 'all') {
  let count = 0;
  const targets = service === 'all' ? SERVICES : [service];

  for (const s of targets) {
    const dir = path.join(LOGS_ROOT, s);
    if (fs.existsSync(dir)) {
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          if (item.endsWith('.log')) {
            const runId = item.replace(/\.log$/, '');
            fs.unlinkSync(path.join(dir, item));
            redisCmd('DEL', `log:${s}:${runId}`).catch(() => {});
            count++;
          }
        }
      } catch (_) {}
    }

    // Clean from D1
    if (s === 'all') {
      await executeD1("DELETE FROM session_logs").catch(() => {});
      await executeD1("DELETE FROM cloud_files WHERE user_id = ? AND storage_type = 'audit_log'", [BOT_USER_ID]).catch(() => {});
    } else {
      await executeD1("DELETE FROM session_logs WHERE service = ?", [s]).catch(() => {});
    }
  }

  persistentLogBytes = 0;
  persistentLogCount = 0;
  persistentBreakdown = { devbox: 0, vps: 0, serverless: 0, webhost: 0, runners: 0 };

  return { purgedFiles: count };
}
