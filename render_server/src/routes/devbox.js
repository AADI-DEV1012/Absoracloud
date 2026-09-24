// ── DevBox Routes ──
// POST /devbox/launch, GET /devbox/status, POST /devbox/stop, GET /devbox/gpu_status

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

// ── Launch DevBox ──
devboxRouter.post('/launch', requireAuth, launchLimiter, requireQuota('devbox'), async (req, res) => {
  try {
    const userId     = req.user.sub;
    const plan       = getPlan(req.user.plan);
    const sessionKey = `devbox-${userId}-${crypto.randomUUID().slice(0, 8)}`;

    // Check existing active devbox session
    const existing = await d1QueryOne(
      "SELECT id FROM instances WHERE user_id = ? AND service = 'devbox' AND status IN ('pending','active')", [userId]
    );
    if (existing) {
      return res.status(409).json({ status: 'error', msg: 'You already have an active DevBox session' });
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

    await triggerKaggleKernel(sessionKey, userId, req.user.plan);

    res.json({ status: 'queued', session_key: sessionKey, expires: expiresAt, msg: 'DevBox GPU session launching...' });
  } catch (e) {
    console.error('DevBox launch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to launch DevBox' });
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
    const instances = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'devbox' ORDER BY created_at DESC LIMIT 5",
      [req.user.sub]
    );
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
    res.json({ status: 'success', msg: 'DevBox session terminated' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to stop DevBox' });
  }
});
