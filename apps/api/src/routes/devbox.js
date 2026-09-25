// ── DevBox Routes ──
// POST /devbox/launch, GET /devbox/status, POST /devbox/stop, GET /devbox/gpu_status, GET /devbox/check_session, POST /devbox/relaunch, DELETE /devbox/instance/:session_key

import { Router } from 'express';
import { requireAuth }   from '../middleware/auth.js';
import { requireQuota }  from '../middleware/quota.js';
import { launchLimiter } from '../middleware/abuse_guard.js';
import { triggerKaggleKernel, getKernelStatus } from '../services/kaggle.js';
import { queryD1, executeD1, d1QueryOne }       from '../shared/d1.js';
import { redisCmd, redisParseHash }             from '../shared/redis.js';
import { getPlan }                              from '../shared/plans.js';
import crypto from 'crypto';

export const devboxRouter = Router();

async function syncUserDevBoxState(userId) {
  // Mark pending instances older than 3 minutes as failed
  await executeD1(
    `UPDATE instances 
     SET status = 'failed', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'devbox' AND status = 'pending' 
       AND datetime(created_at) <= datetime('now', '-3 minutes')`,
    [userId]
  );
}

// ── Launch DevBox ──
devboxRouter.post('/launch', requireAuth, launchLimiter, requireQuota('devbox'), async (req, res) => {
  try {
    const userId     = req.user.sub;
    const plan       = getPlan(req.user.plan);
    const { force, relaunch } = req.body;
    const sessionKey = `devbox-${userId}-${crypto.randomUUID().slice(0, 8)}`;

    await syncUserDevBoxState(userId);

    // If force or relaunch, stop previous active instance
    if (force || relaunch) {
      const running = await queryD1(
        "SELECT session_key FROM instances WHERE user_id = ? AND service = 'devbox' AND status IN ('pending','active')",
        [userId]
      );
      for (const r of running) {
        await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ?", [r.session_key]);
        await redisCmd('SREM', 'gpu:active', r.session_key);
        await redisCmd('SET', `kill:${r.session_key}`, '1', 'EX', '300');
        await redisCmd('HDEL', `session:${r.session_key}`, 'status');
      }
    }

    // Check existing active devbox session
    const existing = await d1QueryOne(
      "SELECT id, session_key FROM instances WHERE user_id = ? AND service = 'devbox' AND status IN ('pending','active')", [userId]
    );
    if (existing) {
      return res.status(409).json({ 
        status: 'error', 
        msg: 'You already have an active DevBox session. You can re-launch to replace it.',
        can_relaunch: true,
        session_key: existing.session_key
      });
    }

    // Check GPU pool availability via Redis
    const activeGPU = await redisCmd('SCARD', 'gpu:active');
    const gpuCapacity = 4; // Max concurrent GPU sessions on T4×2

    if (parseInt(activeGPU || '0') >= gpuCapacity) {
      // Queue the request
      await redisCmd('RPUSH', 'gpu:queue', JSON.stringify({
        session_key: sessionKey, user_id: userId, plan: req.user.plan, priority: plan.priority,
      }));
      await executeD1(
        "INSERT INTO instances (user_id, service, session_key, status, config) VALUES (?, 'devbox', ?, 'pending', ?)",
        [userId, sessionKey, JSON.stringify({ gpu: true, queued: true })]
      );
      const queuePos = await redisCmd('LLEN', 'gpu:queue');
      return res.json({ status: 'queued', session_key: sessionKey, queue_position: queuePos, msg: 'GPU pool full — you are in the queue' });
    }

    // GPU available — launch Kaggle kernel
    await redisCmd('SADD', 'gpu:active', sessionKey);
    const expiresAt = new Date(Date.now() + plan.devbox_gpu_min * 60 * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, config, expires_at) VALUES (?, 'devbox', ?, ?, ?)",
      [userId, sessionKey, JSON.stringify({ gpu: true }), expiresAt]
    );

    // Push task to devbox:tasks for the Kaggle GPU runner
    await redisCmd('RPUSH', 'devbox:tasks', JSON.stringify({
      action: 'launch',
      session_key: sessionKey,
      user_id: userId,
      plan: req.user.plan,
      timeout_seconds: plan.devbox_gpu_min * 60,
    }));

    try {
      await triggerKaggleKernel(sessionKey, userId, req.user.plan);
    } catch (kErr) {
      console.warn('Kaggle kernel trigger notice:', kErr.message);
    }

    res.json({ status: 'queued', session_key: sessionKey, expires: expiresAt, msg: 'DevBox GPU session launching...' });
  } catch (e) {
    console.error('DevBox launch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to launch DevBox' });
  }
});

// ── Re-launch DevBox (One-click restart / replace) ──
devboxRouter.post('/relaunch', requireAuth, launchLimiter, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { session_key } = req.body;

    if (session_key) {
      await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ? AND user_id = ?", [session_key, userId]);
      await redisCmd('SREM', 'gpu:active', session_key);
      await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    }

    req.body.force = true;
    const plan = getPlan(req.user.plan);
    const newSessionKey = `devbox-${userId}-${crypto.randomUUID().slice(0, 8)}`;
    await redisCmd('SADD', 'gpu:active', newSessionKey);
    const expiresAt = new Date(Date.now() + plan.devbox_gpu_min * 60 * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, config, expires_at) VALUES (?, 'devbox', ?, ?, ?)",
      [userId, newSessionKey, JSON.stringify({ gpu: true }), expiresAt]
    );

    // Push task to devbox:tasks for the Kaggle GPU runner
    await redisCmd('RPUSH', 'devbox:tasks', JSON.stringify({
      action: 'launch',
      session_key: newSessionKey,
      user_id: userId,
      plan: req.user.plan,
      timeout_seconds: plan.devbox_gpu_min * 60,
    }));

    try {
      await triggerKaggleKernel(newSessionKey, userId, req.user.plan);
    } catch (kErr) {
      console.warn('Kaggle kernel trigger notice:', kErr.message);
    }
    res.json({ status: 'queued', session_key: newSessionKey, expires: expiresAt, msg: 'Re-launching fresh DevBox GPU session...' });
  } catch (e) {
    console.error('DevBox relaunch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to re-launch DevBox' });
  }
});

// ── Check Session (polling endpoint) ──
devboxRouter.get('/check_session', requireAuth, async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ status: 'error', msg: 'Missing session_id' });

    // 1. Check Redis
    const data = redisParseHash(await redisCmd('HGETALL', `session:${session_id}`));
    if (data && data.status) {
      return res.json({
        status: data.status,
        tunnel_url: data.tunnel_url || null,
        expires_at: data.expires_at || null,
        error: data.error || null,
      });
    }

    // 2. Check D1
    const inst = await d1QueryOne(
      "SELECT status, public_url, created_at, expires_at FROM instances WHERE session_key = ? AND user_id = ?",
      [session_id, req.user.sub]
    );

    if (!inst) {
      return res.status(404).json({ status: 'not_found', msg: 'Instance not found' });
    }

    if (inst.status === 'pending') {
      const createdTime = new Date(inst.created_at).getTime();
      if (Date.now() - createdTime > 180000) {
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [session_id]);
        await redisCmd('SREM', 'gpu:active', session_id);
        return res.json({ status: 'failed', msg: 'DevBox GPU allocation timed out or runner failed.' });
      }
    }

    res.json({
      status: inst.status,
      tunnel_url: inst.public_url || null,
      expires_at: inst.expires_at || null,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to check DevBox session' });
  }
});

// ── GPU Pool Status ──
devboxRouter.get('/gpu_status', requireAuth, async (req, res) => {
  try {
    const activeCount = parseInt(await redisCmd('SCARD', 'gpu:active') || '0');
    const queueLength = parseInt(await redisCmd('LLEN', 'gpu:queue') || '0');
    res.json({ status: 'success', active_sessions: activeCount, capacity: 4, queue_length: queueLength });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to get GPU status' });
  }
});

// ── Status ──
devboxRouter.get('/status', requireAuth, async (req, res) => {
  try {
    await syncUserDevBoxState(req.user.sub);

    const instances = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'devbox' AND status != 'dismissed' ORDER BY created_at DESC LIMIT 10",
      [req.user.sub]
    );

    // Enrich instances with real-time Redis state if D1 hasn't updated yet
    for (const inst of instances) {
      if (!inst.public_url || inst.status === 'pending') {
        const data = redisParseHash(await redisCmd('HGETALL', `session:${inst.session_key}`));
        if (data && data.status) {
          inst.status = data.status;
          if (data.tunnel_url) inst.public_url = data.tunnel_url;
          if (data.expires_at) inst.expires_at = data.expires_at;
        }
      }
    }

    res.json({ status: 'success', instances });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch status' });
  }
});

// ── Stop ──
devboxRouter.post('/stop', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.body;
    await executeD1(
      "UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );
    await redisCmd('SREM', 'gpu:active', session_key);
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    await redisCmd('HSET', `session:${session_key}`, 'status', 'stopped');
    await redisCmd('RPUSH', 'devbox:tasks', JSON.stringify({
      action: 'stop',
      session_key,
      user_id: req.user.sub,
    }));
    res.json({ status: 'success', msg: 'DevBox session terminated' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to stop DevBox' });
  }
});

// ── Dismiss Instance ──
devboxRouter.delete('/instance/:session_key', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.params;
    await executeD1(
      "UPDATE instances SET status = 'dismissed' WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );
    await redisCmd('SREM', 'gpu:active', session_key);
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    await redisCmd('RPUSH', 'devbox:tasks', JSON.stringify({
      action: 'stop',
      session_key,
      user_id: req.user.sub,
    }));
    res.json({ status: 'success', msg: 'Instance dismissed' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to dismiss instance' });
  }
});
