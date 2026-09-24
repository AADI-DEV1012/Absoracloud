// ── AbsoraCloud Automated Watchdog / Reaper ──
// Periodically checks all active instances across MC, VPS, DevBox, and WebHost.
// Enforces plan limits, timeouts, and runner health automatically.

import { queryD1, executeD1 } from '../shared/d1.js';
import { redisCmd }           from '../shared/redis.js';

let watchdogInterval = null;

export function startWatchdog(intervalMs = 30000) {
  if (watchdogInterval) return;
  console.log('🛡️  Automated Instance & Timeout Watchdog started (every 30s)');

  watchdogInterval = setInterval(async () => {
    try {
      await reapExpiredInstances();
      await checkRunnerHealth();
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
  // Find instances that are active or pending but past their expires_at
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
      // Send kill signal via Redis for runner daemons to terminate containers/processes
      if (inst.session_key) {
        await redisCmd('SET', `kill:${inst.session_key}`, '1', 'EX', '300');
        await redisCmd('HDEL', `session:${inst.session_key}`, 'status');
      }

      // If DevBox GPU session, free up GPU pool slot
      if (inst.service === 'devbox' && inst.session_key) {
        await redisCmd('SREM', 'gpu:active', inst.session_key);
      }

      // Update D1 database
      await executeD1(
        "UPDATE instances SET status = 'expired', stopped_at = datetime('now') WHERE id = ?",
        [inst.id]
      );

      // Decrement runner active_count if runner_id is associated
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

// ── 2. Check Runner Heartbeats ──
async function checkRunnerHealth() {
  // If a runner hasn't sent a heartbeat in 3 minutes, mark it offline
  const deadRunners = await queryD1(
    `SELECT id FROM runners 
     WHERE status = 'ready' 
       AND last_heartbeat IS NOT NULL 
       AND datetime(last_heartbeat) <= datetime('now', '-3 minutes')`
  );

  for (const runner of deadRunners) {
    await executeD1("UPDATE runners SET status = 'offline' WHERE id = ?", [runner.id]);
    await redisCmd('SREM', 'runners:active', runner.id);
    console.warn(`⚠️ Runner ${runner.id} timed out without heartbeat — marked offline.`);
  }
}
