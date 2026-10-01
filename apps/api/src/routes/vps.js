// ── VPS Routes ──
// POST /vps/launch, GET /vps/status, POST /vps/stop, GET /vps/check_session, POST /vps/relaunch, DELETE /vps/instance/:session_key

import { Router } from 'express';
import { requireAuth }    from '../middleware/auth.js';
import { requireQuota }   from '../middleware/quota.js';
import { launchLimiter }  from '../middleware/abuse_guard.js';

import { queryD1, executeD1, d1QueryOne } from '../shared/d1.js';
import { redisCmd, redisParseHash }       from '../shared/redis.js';
import { getPlan }                        from '../shared/plans.js';
import crypto from 'crypto';

export const vpsRouter = Router();

// Helper to sync stale pending or disconnected instances
async function syncUserVPSState(userId) {
  // Mark pending instances older than 90 seconds as failed so user is not blocked
  await executeD1(
    `UPDATE instances 
     SET status = 'failed', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'vps' AND status = 'pending' 
       AND datetime(created_at) <= datetime('now', '-90 seconds')`,
    [userId]
  );
  // Mark active instances whose runner is offline as disconnected
  await executeD1(
    `UPDATE instances 
     SET status = 'disconnected', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'vps' AND status = 'active'
       AND runner_id IN (SELECT id FROM runners WHERE status = 'offline')`,
    [userId]
  );
}

// ── Launch VPS ──
vpsRouter.post('/launch', requireAuth, launchLimiter, requireQuota('vps'), async (req, res) => {
  try {
    const userId = req.user.sub;
    const plan   = getPlan(req.user.plan);
    const { force, relaunch } = req.body;
    const sessionKey = `vps-${userId}-${crypto.randomUUID().slice(0, 8)}`;

    // Sync stale or disconnected instances
    await syncUserVPSState(userId);

    // If user explicitly requested re-launch or force restart, stop existing instances
    if (force || relaunch) {
      const running = await queryD1(
        "SELECT session_key FROM instances WHERE user_id = ? AND service = 'vps' AND status IN ('pending','active')",
        [userId]
      );
      for (const r of running) {
        await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ?", [r.session_key]);
        await redisCmd('SET', `kill:${r.session_key}`, '1', 'EX', '300');
        await redisCmd('HDEL', `session:${r.session_key}`, 'status');
      }
    }

    // Count strictly active VPS slots
    const active = await queryD1(
      "SELECT id, session_key, status FROM instances WHERE user_id = ? AND service = 'vps' AND status IN ('pending','active')",
      [userId]
    );

    if (active.length >= plan.vps_slots) {
      return res.status(409).json({ 
        status: 'error', 
        msg: `Max ${plan.vps_slots} concurrent VPS slot(s) for your plan. You can re-launch to replace your existing instance.`,
        can_relaunch: true,
        session_key: active[0]?.session_key
      });
    }

    // Find an available runner
    const runners = await queryD1(
      "SELECT * FROM runners WHERE service = 'vps' AND status = 'ready' AND active_count < capacity ORDER BY active_count ASC LIMIT 1"
    );

    const config = JSON.stringify({ cpu: plan.vps_cpu, ram_mb: plan.vps_ram_mb });
    const expiresAt = new Date(Date.now() + plan.vps_hours_week / 7 * 3600 * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, config, expires_at) VALUES (?, 'vps', ?, ?, ?)",
      [userId, sessionKey, config, expiresAt]
    );

    if (runners.length > 0) {
      // Fast path: runner available
      const runner = runners[0];
      await executeD1("UPDATE runners SET active_count = active_count + 1 WHERE id = ?", [runner.id]);
      await executeD1("UPDATE instances SET runner_id = ? WHERE session_key = ?", [runner.id, sessionKey]);
      await redisCmd('HSET', `session:${sessionKey}`, 'user_id', String(userId), 'status', 'pending', 'runner_id', runner.id);
      await redisCmd('EXPIRE', `session:${sessionKey}`, String(Math.floor(plan.vps_hours_week / 7 * 3600)));

      // Queue container start task to runner
      await redisCmd('RPUSH', `runner:${runner.id}:tasks`, JSON.stringify({
        action: 'start_vps',
        session_key: sessionKey,
        plan: req.user.plan,
        timeout_seconds: Math.floor(plan.vps_hours_week / 7 * 3600)
      }));

      // Check Redis for tunnel URL
      const rData = redisParseHash(await redisCmd('HGETALL', `runner:${runner.id}`));

      res.json({
        status: 'queued',
        session_key: sessionKey,
        plan: req.user.plan,
        expires: expiresAt,
        tunnel_url: rData.tunnel_url || null,
        msg: 'VPS assigned to active runner — launching container...'
      });
    } else {
      // No runner has capacity — push to global VPS task queue
      // (the persistent bare-metal daemon polls vps:tasks)
      await redisCmd('RPUSH', 'vps:tasks', JSON.stringify({
        action: 'start_vps',
        session_key: sessionKey,
        plan: req.user.plan,
        timeout_seconds: Math.floor(plan.vps_hours_week / 7 * 3600)
      }));
      res.json({ 
        status: 'queued', 
        session_key: sessionKey, 
        plan: req.user.plan, 
        expires: expiresAt,
        msg: 'VPS container queued — launching shortly...' 
      });
    }
  } catch (e) {
    console.error('VPS launch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to launch VPS' });
  }
});

// ── Re-launch VPS (One-click restart / replace) ──
vpsRouter.post('/relaunch', requireAuth, launchLimiter, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { session_key } = req.body;

    // Stop old instance
    if (session_key) {
      await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ? AND user_id = ?", [session_key, userId]);
      await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    }

    // Call launch logic with force flag
    req.body.force = true;
    const plan = getPlan(req.user.plan);
    const newSessionKey = `vps-${userId}-${crypto.randomUUID().slice(0, 8)}`;
    const config = JSON.stringify({ cpu: plan.vps_cpu, ram_mb: plan.vps_ram_mb });
    const expiresAt = new Date(Date.now() + plan.vps_hours_week / 7 * 3600 * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, config, expires_at) VALUES (?, 'vps', ?, ?, ?)",
      [userId, newSessionKey, config, expiresAt]
    );

    // Check ready runner
    const runners = await queryD1(
      "SELECT * FROM runners WHERE service = 'vps' AND status = 'ready' AND active_count < capacity ORDER BY active_count ASC LIMIT 1"
    );

    if (runners.length > 0) {
      const runner = runners[0];
      await executeD1("UPDATE runners SET active_count = active_count + 1 WHERE id = ?", [runner.id]);
      await executeD1("UPDATE instances SET runner_id = ? WHERE session_key = ?", [runner.id, newSessionKey]);
      await redisCmd('HSET', `session:${newSessionKey}`, 'user_id', String(userId), 'status', 'pending', 'runner_id', runner.id);
      await redisCmd('RPUSH', `runner:${runner.id}:tasks`, JSON.stringify({
        action: 'start_vps',
        session_key: newSessionKey,
        plan: req.user.plan,
        timeout_seconds: Math.floor(plan.vps_hours_week / 7 * 3600)
      }));
      return res.json({ status: 'queued', session_key: newSessionKey, msg: 'Re-launching on active runner...' });
    }

    await redisCmd('RPUSH', 'vps:tasks', JSON.stringify({ action: 'start_vps', session_key: newSessionKey, plan: req.user.plan, timeout_seconds: 14400 }));
    res.json({ status: 'queued', session_key: newSessionKey, msg: 'Re-launching VPS container...' });
  } catch (e) {
    console.error('VPS relaunch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to re-launch VPS' });
  }
});

// ── Check Session (polling endpoint) ──
vpsRouter.get('/check_session', requireAuth, async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ status: 'error', msg: 'Missing session_id' });

    // 1. Check Redis first
    const data = redisParseHash(await redisCmd('HGETALL', `session:${session_id}`));
    if (data && data.status) {
      return res.json({
        status: data.status,
        tunnel_url: data.tunnel_url || null,
        expires_at: data.expires_at ? parseInt(data.expires_at) : null,
        error: data.error || null,
      });
    }

    // 2. Fallback to D1 database
    const inst = await d1QueryOne(
      "SELECT status, public_url, created_at, expires_at, runner_id FROM instances WHERE session_key = ? AND user_id = ?",
      [session_id, req.user.sub]
    );

    if (!inst) {
      return res.status(404).json({ status: 'not_found', msg: 'Instance not found' });
    }

    // Auto-mark timed out pending (90s timeout)
    if (inst.status === 'pending') {
      const createdTime = new Date(inst.created_at).getTime();
      if (Date.now() - createdTime > 90000) {
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [session_id]);
        await redisCmd('HSET', `session:${session_id}`, 'status', 'failed', 'error', 'Runner startup timed out or failed to connect.');
        return res.json({ status: 'failed', msg: 'Runner startup timed out or failed to connect.' });
      }
    }

    // Auto-mark disconnected if runner went offline
    if (inst.runner_id && inst.status === 'active') {
      const r = await d1QueryOne("SELECT status FROM runners WHERE id = ?", [inst.runner_id]);
      if (r && r.status === 'offline') {
        await executeD1("UPDATE instances SET status = 'disconnected', stopped_at = datetime('now') WHERE session_key = ?", [session_id]);
        await redisCmd('HSET', `session:${session_id}`, 'status', 'disconnected', 'error', 'Runner went offline.');
        return res.json({ status: 'disconnected', msg: 'Runner went offline.' });
      }
    }

    res.json({
      status: inst.status,
      tunnel_url: inst.public_url || null,
      expires_at: inst.expires_at || null,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to check session' });
  }
});

// ── Status ──
vpsRouter.get('/status', requireAuth, async (req, res) => {
  try {
    await syncUserVPSState(req.user.sub);

    const instances = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'vps' AND status != 'dismissed' ORDER BY created_at DESC LIMIT 10",
      [req.user.sub]
    );
    res.json({ status: 'success', instances });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch status' });
  }
});

// ── Stop ──
vpsRouter.post('/stop', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.body;
    await executeD1(
      "UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    await redisCmd('HSET', `session:${session_key}`, 'status', 'stopped');
    res.json({ status: 'success', msg: 'VPS termination signal sent' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to stop VPS' });
  }
});

// ── Dismiss Instance (Remove from dashboard list) ──
vpsRouter.delete('/instance/:session_key', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.params;
    await executeD1(
      "UPDATE instances SET status = 'dismissed' WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    res.json({ status: 'success', msg: 'Instance dismissed' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to dismiss instance' });
  }
});
