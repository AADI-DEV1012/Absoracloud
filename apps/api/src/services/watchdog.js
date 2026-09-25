// ── AbsoraCloud Automated Watchdog / Reaper ──
// Periodically checks all active instances across MC, VPS, DevBox, and WebHost.
// Enforces plan limits, timeouts, runner health, and disconnects failed/abandoned sessions.

import { queryD1, executeD1 } from '../shared/d1.js';
import { redisCmd }           from '../shared/redis.js';

let watchdogInterval = null;

export function startWatchdog(intervalMs = 30000) {
  if (watchdogInterval) return;
  console.log('🛡️  Automated Instance & Timeout Watchdog started (every 30s)');

  watchdogInterval = setInterval(async () => {
    try {
      await reapExpiredInstances();
      await reapStalePendingInstances();
      await checkRunnerHealthAndDisconnectInstances();
    } catch (err) {
      console.error('Watchdog cycle error:', err.message);
    }
  }, intervalMs);
}

export function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
}

// ── 1. Reap Expired Instances ──
async function reapExpiredInstances() {
  const expired = await queryD1(
    `SELECT id, user_id, service, session_key, runner_id, expires_at 
     FROM instances 
     WHERE status IN ('active', 'pending') 
       AND expires_at IS NOT NULL 
       AND datetime(expires_at) <= datetime('now')`
  );

  if (!expired || expired.length === 0) return;

  console.log(`⏱️  Watchdog: Found ${expired.length} expired instance(s). Reaping...`);

  for (const inst of expired) {
    try {
      if (inst.session_key) {
        await redisCmd('SET', `kill:${inst.session_key}`, '1', 'EX', '300');
        await redisCmd('HSET', `session:${inst.session_key}`, 'status', 'expired');
      }

      if (inst.service === 'devbox' && inst.session_key) {
        await redisCmd('SREM', 'gpu:active', inst.session_key);
      }

      await executeD1(
        "UPDATE instances SET status = 'expired', stopped_at = datetime('now') WHERE id = ?",
        [inst.id]
      );

      if (inst.runner_id) {
        await executeD1(
          "UPDATE runners SET active_count = MAX(0, active_count - 1) WHERE id = ?",
          [inst.runner_id]
        );
      }

      console.log(`✅ Reaped expired ${inst.service} instance: ${inst.session_key}`);
    } catch (e) {
      console.error(`Failed to reap instance ${inst.session_key}:`, e.message);
    }
  }
}

// ── 2. Reap Stale Pending Instances (Startup Failed or Timed Out) ──
async function reapStalePendingInstances() {
  // Find instances stuck in 'pending' or 'deploying' for more than 3 minutes
  const stale = await queryD1(
    `SELECT id, user_id, service, session_key, runner_id 
     FROM instances 
     WHERE status IN ('pending', 'deploying') 
       AND datetime(created_at) <= datetime('now', '-3 minutes')`
  );

  if (!stale || stale.length === 0) return;

  console.log(`⏱️  Watchdog: Found ${stale.length} stale pending instance(s). Marking as failed...`);

  for (const inst of stale) {
    try {
      await executeD1(
        "UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE id = ?",
        [inst.id]
      );

      if (inst.session_key) {
        await redisCmd('SET', `kill:${inst.session_key}`, '1', 'EX', '300');
        await redisCmd('HSET', `session:${inst.session_key}`, 'status', 'failed', 'error', 'Startup timed out or runner failed to connect');
      }

      if (inst.service === 'devbox' && inst.session_key) {
        await redisCmd('SREM', 'gpu:active', inst.session_key);
      }

      if (inst.runner_id) {
        await executeD1(
          "UPDATE runners SET active_count = MAX(0, active_count - 1) WHERE id = ?",
          [inst.runner_id]
        );
      }
      console.log(`❌ Marked stale pending instance as failed: ${inst.session_key}`);
    } catch (e) {
      console.error(`Failed to reap stale instance ${inst.session_key}:`, e.message);
    }
  }
}

// ── 3. Check Runner Health & Disconnect Orphaned Instances ──
async function checkRunnerHealthAndDisconnectInstances() {
  // If a runner hasn't sent a heartbeat in 3 minutes, mark it offline
  const deadRunners = await queryD1(
    `SELECT id FROM runners 
     WHERE status = 'ready' 
       AND last_heartbeat IS NOT NULL 
       AND datetime(last_heartbeat) <= datetime('now', '-3 minutes')`
  );

  if (!deadRunners || deadRunners.length === 0) return;

  for (const runner of deadRunners) {
    await executeD1("UPDATE runners SET status = 'offline', active_count = 0 WHERE id = ?", [runner.id]);
    await redisCmd('SREM', 'runners:active', runner.id);
    console.warn(`⚠️ Runner ${runner.id} timed out without heartbeat — marked offline.`);

    // Find and disconnect any instances tied to this dead runner
    const orphaned = await queryD1(
      `SELECT id, session_key, service FROM instances 
       WHERE runner_id = ? AND status IN ('active', 'pending')`,
      [runner.id]
    );

    for (const inst of orphaned) {
      await executeD1(
        "UPDATE instances SET status = 'disconnected', stopped_at = datetime('now') WHERE id = ?",
        [inst.id]
      );
      if (inst.session_key) {
        await redisCmd('HSET', `session:${inst.session_key}`, 'status', 'disconnected', 'error', 'Runner disconnected or lost heartbeat');
      }
      if (inst.service === 'devbox' && inst.session_key) {
        await redisCmd('SREM', 'gpu:active', inst.session_key);
      }
      console.warn(`⚠️ Marked instance as disconnected: ${inst.session_key} (Runner ${runner.id} offline)`);
    }
  }
}
