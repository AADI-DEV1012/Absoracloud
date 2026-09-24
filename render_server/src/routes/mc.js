// ── MC Hosting Routes ──
// POST /mc/launch, GET /mc/status, POST /mc/stop

import { Router } from 'express';
import { requireAuth }    from '../middleware/auth.js';
import { requireQuota }   from '../middleware/quota.js';
import { launchLimiter }  from '../middleware/abuse_guard.js';
import { triggerWorkflow } from '../services/github_actions.js';
import { queryD1, executeD1, d1QueryOne } from '../shared/d1.js';
import { redisCmd, redisParseHash }       from '../shared/redis.js';
import { getPlan }                        from '../shared/plans.js';
import crypto from 'crypto';

export const mcRouter = Router();

// ── Launch MC Server ──
mcRouter.post('/launch', requireAuth, launchLimiter, requireQuota('mc'), async (req, res) => {
  try {
    const userId   = req.user.sub;
    const plan     = getPlan(req.user.plan);
    const { server_type = 'paper', version = '1.21.1' } = req.body;
    const sessionKey = `mc-${userId}-${crypto.randomUUID().slice(0, 8)}`;

    // Check for existing active MC session
    const existing = await d1QueryOne(
      "SELECT id FROM instances WHERE user_id = ? AND service = 'mc' AND status IN ('pending','active')", [userId]
    );
    if (existing) {
      return res.status(409).json({ status: 'error', msg: 'You already have an active MC server' });
    }

    // Check for available multi-tenant MC runner
    const runners = await queryD1(
      "SELECT * FROM runners WHERE service = 'mc' AND status = 'ready' AND active_count < capacity ORDER BY active_count ASC LIMIT 1"
    );

    const config = JSON.stringify({ server_type, version, ram_mb: plan.mc_ram_mb });
    const expiresAt = new Date(Date.now() + (plan.mc_hours_week / 7) * 3600 * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, config, expires_at) VALUES (?, 'mc', ?, ?, ?)",
      [userId, sessionKey, config, expiresAt]
    );

    if (runners.length > 0) {
      const runner = runners[0];
      await executeD1("UPDATE runners SET active_count = active_count + 1 WHERE id = ?", [runner.id]);
      await redisCmd('HSET', `session:${sessionKey}`, 'user_id', String(userId), 'status', 'pending', 'runner_id', runner.id);
      await redisCmd('EXPIRE', `session:${sessionKey}`, String(Math.floor((plan.mc_hours_week / 7) * 3600)));

      // Notify runner via Redis pub/sub or queue
      await redisCmd('RPUSH', `runner:${runner.id}:tasks`, JSON.stringify({
        action: 'start_mc',
        session_key: sessionKey,
        server_type,
        version,
        ram_mb: plan.mc_ram_mb,
        expires_at: expiresAt,
      }));

      res.json({ status: 'queued', session_key: sessionKey, runner_id: runner.id, expires: expiresAt, msg: 'MC instance assigned to active runner' });
    } else {
      // Trigger GitHub Actions workflow to spin up new runner
      await triggerWorkflow('mc_runner.yml', {
        session_key: sessionKey,
        user_id: String(userId),
        plan: req.user.plan,
        server_type,
        version,
        ram_mb: String(plan.mc_ram_mb),
      });

      res.json({ status: 'queued', session_key: sessionKey, expires: expiresAt, msg: 'Spinning up new MC runner...' });
    }
  } catch (e) {
    console.error('MC launch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to launch MC server' });
  }
});

// ── Check Status ──
mcRouter.get('/status', requireAuth, async (req, res) => {
  try {
    const instances = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'mc' ORDER BY created_at DESC LIMIT 5",
      [req.user.sub]
    );
    res.json({ status: 'success', instances });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch status' });
  }
});

// ── Stop MC Server ──
mcRouter.post('/stop', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.body;
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'Missing session_key' });

    await executeD1(
      "UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );

    // Notify runner via Redis
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');

    res.json({ status: 'success', msg: 'Stop signal sent' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to stop server' });
  }
});
