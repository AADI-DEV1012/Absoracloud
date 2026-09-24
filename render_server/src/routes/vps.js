// ── VPS Routes ──
// POST /vps/launch, GET /vps/status, POST /vps/stop, GET /vps/check_session

import { Router } from 'express';
import { requireAuth }    from '../middleware/auth.js';
import { requireQuota }   from '../middleware/quota.js';
import { launchLimiter }  from '../middleware/abuse_guard.js';
import { triggerWorkflow } from '../services/github_actions.js';
import { queryD1, executeD1, d1QueryOne } from '../shared/d1.js';
import { redisCmd, redisParseHash }       from '../shared/redis.js';
import { getPlan }                        from '../shared/plans.js';
import crypto from 'crypto';

export const vpsRouter = Router();

// ── Launch VPS ──
vpsRouter.post('/launch', requireAuth, launchLimiter, requireQuota('vps'), async (req, res) => {
  try {
    const userId = req.user.sub;
    const plan   = getPlan(req.user.plan);
    const sessionKey = `vps-${userId}-${crypto.randomUUID().slice(0, 8)}`;

    // Count active VPS slots
    const active = await queryD1(
      "SELECT id FROM instances WHERE user_id = ? AND service = 'vps' AND status IN ('pending','active')",
      [userId]
    );
    if (active.length >= plan.vps_slots) {
      return res.status(409).json({ status: 'error', msg: `Max ${plan.vps_slots} concurrent VPS slots for your plan` });
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
      await redisCmd('HSET', `session:${sessionKey}`, 'user_id', String(userId), 'status', 'pending', 'runner_id', runner.id);
      await redisCmd('EXPIRE', `session:${sessionKey}`, String(plan.vps_hours_week / 7 * 3600));

      // Check Redis for tunnel URL
      const rData = redisParseHash(await redisCmd('HGETALL', `runner:${runner.id}`));

      res.json({
        status: 'queued',
        session_key: sessionKey,
        plan: req.user.plan,
        expires: expiresAt,
        tunnel_url: rData.tunnel_url || null,
      });
    } else {
      // Slow path: need to spin up runner
      await triggerWorkflow('vps_runner.yml', { session_key: sessionKey });
      res.json({ status: 'queued', session_key: sessionKey, plan: req.user.plan, expires: expiresAt });
    }
  } catch (e) {
    console.error('VPS launch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to launch VPS' });
  }
});

// ── Check Session (polling endpoint) ──
vpsRouter.get('/check_session', requireAuth, async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ status: 'error', msg: 'Missing session_id' });

    const data = redisParseHash(await redisCmd('HGETALL', `session:${session_id}`));
    if (!data || !data.status) {
      return res.json({ status: 'pending' });
    }

    res.json({
      status: data.status,
      tunnel_url: data.tunnel_url || null,
      expires_at: data.expires_at ? parseInt(data.expires_at) : null,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to check session' });
  }
});

// ── Status ──
vpsRouter.get('/status', requireAuth, async (req, res) => {
  try {
    const instances = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'vps' ORDER BY created_at DESC LIMIT 10",
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
    res.json({ status: 'success', msg: 'VPS termination signal sent' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to stop VPS' });
  }
});
