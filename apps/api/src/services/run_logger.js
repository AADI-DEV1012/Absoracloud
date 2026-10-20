// ── Run Logger Service ──
// Stores disk-backed logs for each run (devbox, serverless, vps, webhost)
// strictly capped under 200MB with automated rotation and pruning.

import fs from 'fs';
import path from 'path';

const MAX_LOG_DISK_BYTES = 200 * 1024 * 1024; // 200 MB limit
const PRUNE_TARGET_BYTES = 160 * 1024 * 1024; // Prune to 160 MB when near limit

const LOGS_ROOT = process.env.LOGS_DIR || (
  fs.existsSync('/opt/absoracloud-data')
    ? '/opt/absoracloud-data/run_logs'
    : path.resolve(process.cwd(), 'data/run_logs')
);

// Ensure directories exist for all services
const SERVICES = ['devbox', 'vps', 'serverless', 'webhost'];
for (const s of SERVICES) {
  try {
    fs.mkdirSync(path.join(LOGS_ROOT, s), { recursive: true });
  } catch (e) {
    console.error(`[RunLogger] Error creating log dir for ${s}:`, e.message);
  }
}

/**
 * Calculates total disk size of all stored run logs in bytes.
 */
export function getLogDiskUsage() {
  let totalBytes = 0;
  let fileCount = 0;
  const breakdown = { devbox: 0, vps: 0, serverless: 0, webhost: 0 };
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
          totalBytes += stats.size;
          fileCount++;
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

  // Sort files by last modified descending
  filesList.sort((a, b) => b.mtime - a.mtime);

  return {
    totalBytes,
    totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
    maxMB: 200,
    percentUsed: Math.min(100, Math.round((totalBytes / MAX_LOG_DISK_BYTES) * 100)),
    fileCount,
    breakdown: {
      devboxMB: (breakdown.devbox / (1024 * 1024)).toFixed(2),
      vpsMB: (breakdown.vps / (1024 * 1024)).toFixed(2),
      serverlessMB: (breakdown.serverless / (1024 * 1024)).toFixed(2),
      webhostMB: (breakdown.webhost / (1024 * 1024)).toFixed(2)
    },
    files: filesList
  };
}

/**
 * Enforces the 200MB quota. If total logs exceed 190MB, deletes oldest logs.
 */
export function ensureDiskUnderQuota() {
  const usage = getLogDiskUsage();
  if (usage.totalBytes <= 190 * 1024 * 1024) return; // Within safe threshold

  console.warn(`[RunLogger] Log disk usage (${usage.totalMB}MB) near 200MB limit. Pruning oldest logs...`);
  // Sort oldest first
  const oldestFirst = [...usage.files].sort((a, b) => a.mtime - b.mtime);

  let currentBytes = usage.totalBytes;
  for (const item of oldestFirst) {
    if (currentBytes <= PRUNE_TARGET_BYTES) break;
    try {
      fs.unlinkSync(item.filePath);
      currentBytes -= item.sizeBytes;
      console.log(`[RunLogger] Pruned old log: ${item.service}/${item.filename} (${item.sizeKB}KB)`);
    } catch (e) {
      console.error(`[RunLogger] Error unlinking ${item.filePath}:`, e.message);
    }
  }
}

/**
 * Appends log entries to a run's log file on disk.
 */
export function appendRunLog(service, runId, message, level = 'INFO') {
  if (!SERVICES.includes(service) || !runId) return;

  const sanitizedId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const serviceDir = path.join(LOGS_ROOT, service);
  const filePath = path.join(serviceDir, `${sanitizedId}.log`);

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

  try {
    fs.appendFileSync(filePath, line, 'utf8');
    ensureDiskUnderQuota();
  } catch (err) {
    console.error(`[RunLogger] Error writing log for ${service}/${sanitizedId}:`, err.message);
  }
}

/**
 * Reads the full log file for a specific run.
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
    // If file > 2MB, read the last 2MB to keep browser responsive
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
 * Manually purge all or specific service logs.
 */
export function purgeLogs(service = 'all') {
  let count = 0;
  const targets = service === 'all' ? SERVICES : [service];

  for (const s of targets) {
    const dir = path.join(LOGS_ROOT, s);
    if (!fs.existsSync(dir)) continue;
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (item.endsWith('.log')) {
          fs.unlinkSync(path.join(dir, item));
          count++;
        }
      }
    } catch (_) {}
  }
  return { purgedFiles: count };
}
