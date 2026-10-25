// ── AbsoraCloud Automated Watchdog / Reaper ──
// Periodically checks all active instances across VPS, DevBox, WebHost, and Serverless.
// Enforces plan limits, timeouts, runner health, and disconnects failed/abandoned sessions.

import { queryD1, executeD1, ensureSchemaMigrations } from '../../../../packages/shared/d1.js';
import { redisCmd }                                   from '../../../../packages/shared/redis.js';
import { consumeQuota }                               from '../../../../packages/shared/plans.js';
import { removeWebsite, deleteFunction }              from './cloudflare_workers.js';

let watchdogInterval = null;

export async function startWatchdog(intervalMs = 30000) {
  if (watchdogInterval) return;
  console.log('🛡️  Automated Instance & Timeout Watchdog started (every 30s)');

  // Run schema migration check once on boot with explicit error logging
  try {
    await ensureSchemaMigrations();
    console.log('✅ Watchdog: Verified database schema migrations');
  } catch (err) {
    console.error('❌ Watchdog: Schema migration failed:', err.message);
  }

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
    `SELECT id, user_id, service, session_key, runner_id, config, created_at, expires_at 
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

      // Charge quota for compute sessions
      if (inst.service === 'vps' || inst.service === 'devbox') {
        const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(inst.created_at).getTime()) / 1000));
        await consumeQuota(redisCmd, inst.user_id, inst.service, durationSeconds).catch(() => {});
        if (inst.service === 'devbox') {
          try {
            const cfg = JSON.parse(inst.config || '{}');
            if (cfg.gpu) {
              await redisCmd('INCRBY', `quota:${inst.user_id}:devbox_gpu`, String(durationSeconds)).catch(() => {});
            } else {
              await redisCmd('INCRBY', `quota:${inst.user_id}:devbox_cpu`, String(durationSeconds)).catch(() => {});
            }
          } catch (_) {}
        }
      }

      // Tear down Cloudflare Workers for expired webhost & serverless sites
      if (inst.service === 'webhost') {
        try {
          const cfg = JSON.parse(inst.config || '{}');
          if (cfg.site_name) await removeWebsite(cfg.site_name);
        } catch (cfErr) {
          console.warn(`Watchdog: CF Worker remove warning for ${inst.session_key}:`, cfErr.message);
        }
      } else if (inst.service === 'serverless') {
        try {
          const cfg = JSON.parse(inst.config || '{}');
          if (cfg.func_name) await deleteFunction(inst.user_id, cfg.func_name);
        } catch (cfErr) {
          console.warn(`Watchdog: Serverless delete warning for ${inst.session_key}:`, cfErr.message);
        }
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
  // Find instances stuck in 'pending' or 'deploying' for more than 5 minutes
  const stale = await queryD1(
    `SELECT id, user_id, service, session_key, runner_id 
     FROM instances 
     WHERE status IN ('pending', 'deploying') 
       AND datetime(created_at) <= datetime('now', '-5 minutes')`
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

      console.log(`⚠️  Watchdog: Marked stale pending ${inst.service} instance as failed: ${inst.session_key}`);
    } catch (e) {
      console.error(`Failed to mark stale instance ${inst.session_key}:`, e.message);
    }
  }
}

// ── 3. Healthcheck Registered Compute Runners ──
async function checkRunnerHealthAndDisconnectInstances() {
  const staleRunners = await queryD1(
    `SELECT id, service FROM runners 
     WHERE (status = 'ready' AND datetime(last_heartbeat) <= datetime('now', '-90 seconds'))
        OR (status = 'provisioning' AND datetime(last_heartbeat) <= datetime('now', '-300 seconds'))`
  );

  if (staleRunners && staleRunners.length > 0) {
    for (const runner of staleRunners) {
      console.warn(`⚠️  Watchdog: Runner ${runner.id} timed out or missed heartbeats. Marking as dead.`);
      await executeD1("UPDATE runners SET status = 'dead', active_count = 0 WHERE id = ?", [runner.id]);
      await redisCmd('SREM', 'runners:active', runner.id);

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
          await redisCmd('HSET', `session:${inst.session_key}`, 'status', 'disconnected', 'error', 'Host runner lost connection');
        }
        console.log(`⚠️  Disconnected orphaned session ${inst.session_key} on dead runner ${runner.id}`);
      }
    }
  }

  // Purge dead/stopped runners older than 24h to keep table compact
  try {
    await executeD1("DELETE FROM runners WHERE status IN ('dead', 'stopped') AND datetime(last_heartbeat) <= datetime('now', '-24 hours')");
  } catch (_) {}
}
