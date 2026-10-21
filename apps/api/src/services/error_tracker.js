// ── AbsoraCloud Server Error Tracker ──
// Keeps recent server errors in memory for 60 seconds, then flushes them to disk.
// Provides /errors [n] command with fast, reliable access to error telemetry.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const LOGS_DIR = process.env.LOGS_DIR || (
  fs.existsSync('/opt/absoracloud-data')
    ? '/opt/absoracloud-data/run_logs'
    : path.resolve(process.cwd(), 'data/run_logs')
);

const ERROR_LOG_PATH = path.join(LOGS_DIR, 'server_errors.log');

try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch (_) {}

// In-memory buffer of errors
// Each item: { id, timestamp, createdAtMs, message, stack, path, method }
const inMemoryErrors = [];
const BUFFER_TTL_MS = 60 * 1000; // 60 seconds in memory

/**
 * Record a server error into the in-memory buffer.
 */
export function recordServerError(err, context = {}) {
  const errorObj = {
    id: crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    createdAtMs: Date.now(),
    message: err?.message || String(err),
    stack: err?.stack || '',
    path: context.path || context.url || context.originalUrl || 'internal',
    method: context.method || 'API',
    status: context.status || 500
  };

  inMemoryErrors.push(errorObj);

  // Safety cap for in-memory buffer: max 200 items in a sudden spike
  if (inMemoryErrors.length > 200) {
    flushOldErrorsToDisk();
  }
}

/**
 * Flush errors older than 60 seconds to disk log file.
 */
export function flushOldErrorsToDisk() {
  const now = Date.now();
  const toFlush = [];
  const keep = [];

  for (const item of inMemoryErrors) {
    if (now - item.createdAtMs >= BUFFER_TTL_MS) {
      toFlush.push(item);
    } else {
      keep.push(item);
    }
  }

  // Update in-memory list
  inMemoryErrors.length = 0;
  inMemoryErrors.push(...keep);

  if (toFlush.length > 0) {
    try {
      const lines = toFlush.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(ERROR_LOG_PATH, lines, 'utf8');
    } catch (e) {
      console.error('[ErrorTracker] Failed to flush errors to disk:', e.message);
    }
  }
}

// Flush timer runs every 10 seconds
setInterval(() => {
  try {
    flushOldErrorsToDisk();
  } catch (_) {}
}, 10000);

/**
 * Get the last n errors (combining in-memory buffer and disk file).
 */
export function getRecentErrors(count = 10) {
  flushOldErrorsToDisk();
  const result = [...inMemoryErrors];

  // If in-memory doesn't satisfy requested count, read recent lines from disk
  if (result.length < count && fs.existsSync(ERROR_LOG_PATH)) {
    try {
      const fileData = fs.readFileSync(ERROR_LOG_PATH, 'utf8');
      const lines = fileData.trim().split('\n').filter(Boolean);
      const needed = count - result.length;
      const diskItems = lines.slice(-needed).map(line => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return { message: line, timestamp: new Date().toISOString() };
        }
      });
      result.unshift(...diskItems);
    } catch (_) {}
  }

  // Return last count items sorted newest first
  return result.slice(-count).reverse();
}
