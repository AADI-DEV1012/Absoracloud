// ── DevBox Routes ──
// POST /devbox/launch, GET /devbox/status, POST /devbox/stop, GET /devbox/gpu_status, GET /devbox/check_session, POST /devbox/relaunch, DELETE /devbox/instance/:session_key

import { Router } from 'express';
import { requireAuth }   from '../middleware/auth.js';
import { requireQuota }  from '../middleware/quota.js';
import { launchLimiter } from '../middleware/abuse_guard.js';
import { triggerKaggleKernel, getKernelStatus } from '../services/kaggle.js';
import { queryD1, executeD1, d1QueryOne }       from '../../../../packages/shared/d1.js';
import { redisCmd, redisParseHash }             from '../../../../packages/shared/redis.js';
import { getPlan, consumeQuota }                from '../../../../packages/shared/plans.js';
import crypto from 'crypto';

export const devboxRouter = Router();

async function syncUserDevBoxState(userId) {
  // Mark pending instances older than 5 minutes as failed
  await executeD1(
    `UPDATE instances 
     SET status = 'failed', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'devbox' AND status = 'pending' 
       AND datetime(created_at) <= datetime('now', '-5 minutes')`,
    [userId]
  );
}

// ── Launch DevBox ──
devboxRouter.post('/launch', requireAuth, launchLimiter, requireQuota('devbox'), async (req, res) => {
  try {
    const userId     = req.user.sub;
    const plan       = getPlan(req.user.plan);
    const { force, relaunch, runtime = 'gpu' } = req.body;
    const sessionKey = `devbox-${userId}-${crypto.randomUUID().slice(0, 8)}`;

    await syncUserDevBoxState(userId);

    // If force or relaunch, stop previous active instance
    if (force || relaunch) {
      const running = await queryD1(
        "SELECT id, session_key, created_at FROM instances WHERE user_id = ? AND service = 'devbox' AND status IN ('pending','active')",
        [userId]
      );
      for (const r of running) {
        const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 1000));
        await consumeQuota(redisCmd, userId, 'devbox', durationSeconds).catch(() => {});
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

    // Check GPU pool availability via Redis if GPU runtime requested
    if (runtime === 'gpu') {
      const activeGPU = await redisCmd('SCARD', 'gpu:active');
      const gpuCapacity = 4;

      if (parseInt(activeGPU || '0') >= gpuCapacity) {
        return res.status(503).json({
          status: 'error',
          msg: 'GPU cluster at maximum capacity. Please wait a few minutes or launch a CPU session.'
        });
      }
      await redisCmd('SADD', 'gpu:active', sessionKey);
    }

    const timeoutSeconds = plan.devbox_gpu_min * 60;
    const termPass = crypto.randomBytes(6).toString('hex');
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();
    const config = JSON.stringify({ gpu: runtime === 'gpu', runtime, term_pass: termPass });

    // Check for an active multi-tenant DevBox runner with spare capacity
    const availableRunner = await d1QueryOne(
      `SELECT id, capacity, active_count 
       FROM runners 
       WHERE service = 'devbox' 
         AND status = 'ready' 
         AND active_count < capacity 
         AND datetime(last_heartbeat) >= datetime('now', '-45 seconds')
       ORDER BY active_count DESC 
       LIMIT 1`
    );

    let assignedRunnerId = null;
    let reusedPool = false;

    if (availableRunner) {
      assignedRunnerId = availableRunner.id;
      reusedPool = true;
      await executeD1("UPDATE runners SET active_count = active_count + 1 WHERE id = ?", [assignedRunnerId]);
      console.log(`⚡ Pooled DevBox runner slot assigned: ${assignedRunnerId} (active: ${availableRunner.active_count + 1}/${availableRunner.capacity})`);
    } else {
      assignedRunnerId = `devbox-runner-${crypto.randomUUID().slice(0, 8)}`;
      await executeD1(
        "INSERT INTO runners (id, type, service, capacity, active_count, status, last_heartbeat) VALUES (?, ?, 'devbox', 2, 1, 'provisioning', datetime('now'))",
        [assignedRunnerId, runtime === 'gpu' ? 'kaggle_gpu' : 'kaggle_cpu']
      );
      console.log(`🚀 Provisioning new Kaggle DevBox runner: ${assignedRunnerId}`);
    }

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config, runner_id, expires_at) VALUES (?, 'devbox', ?, 'pending', ?, ?, ?)",
      [userId, sessionKey, config, assignedRunnerId, expiresAt]
    );

    await redisCmd('HSET', `session:${sessionKey}`,
      'user_id', String(userId),
      'status', 'pending',
      'service', 'devbox',
      'term_pass', termPass,
      'runner_id', assignedRunnerId
    );
    await redisCmd('EXPIRE', `session:${sessionKey}`, String(timeoutSeconds + 3600));

    if (!reusedPool) {
      try {
        await triggerKaggleKernel(sessionKey, userId, req.user.plan, {
          runner_id: assignedRunnerId,
          capacity: 2,
          runtime,
          timeout_seconds: timeoutSeconds,
          term_pass: termPass
        });
      } catch (kErr) {
        console.error('Kaggle kernel trigger error:', kErr.message);
        if (runtime === 'gpu') await redisCmd('SREM', 'gpu:active', sessionKey);
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [sessionKey]);
        await executeD1("UPDATE runners SET status = 'failed' WHERE id = ?", [assignedRunnerId]);
        await redisCmd('HSET', `session:${sessionKey}`, 'status', 'failed', 'error', kErr.message);
        return res.status(502).json({ status: 'error', msg: `Failed to provision DevBox runner: ${kErr.message}` });
      }
    }

    res.json({
      status: 'queued',
      session_key: sessionKey,
      runtime,
      expires: expiresAt,
      term_pass: termPass,
      reused_pool: reusedPool,
      runner_id: assignedRunnerId,
      msg: reusedPool 
        ? 'Connected to active DevBox compute pool. Initializing workspace...'
        : `DevBox ${runtime === 'gpu' ? '2× Tesla T4 GPU' : 'CPU'} session launching...`
    });
  } catch (e) {
    console.error('DevBox launch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to launch DevBox' });
  }
});

// ── Re-launch DevBox (One-click restart / replace) ──
devboxRouter.post('/relaunch', requireAuth, launchLimiter, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { session_key, runtime = 'gpu' } = req.body;

    if (session_key) {
      const oldInst = await d1QueryOne("SELECT id, created_at FROM instances WHERE session_key = ? AND user_id = ?", [session_key, userId]);
      if (oldInst) {
        const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(oldInst.created_at).getTime()) / 1000));
        await consumeQuota(redisCmd, userId, 'devbox', durationSeconds).catch(() => {});
        await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ?", [session_key]);
        await redisCmd('SREM', 'gpu:active', session_key);
        await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
      }
    }

    const plan = getPlan(req.user.plan);
    const newSessionKey = `devbox-${userId}-${crypto.randomUUID().slice(0, 8)}`;
    if (runtime === 'gpu') {
      await redisCmd('SADD', 'gpu:active', newSessionKey);
    }
    const timeoutSeconds = plan.devbox_gpu_min * 60;
    const termPass = crypto.randomBytes(6).toString('hex');
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();
    const config = JSON.stringify({ gpu: runtime === 'gpu', runtime, term_pass: termPass });

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config, expires_at) VALUES (?, 'devbox', ?, 'pending', ?, ?)",
      [userId, newSessionKey, config, expiresAt]
    );

    await redisCmd('HSET', `session:${newSessionKey}`,
      'user_id', String(userId),
      'status', 'pending',
      'service', 'devbox',
      'term_pass', termPass
    );
    await redisCmd('EXPIRE', `session:${newSessionKey}`, String(timeoutSeconds + 3600));

    try {
      await triggerKaggleKernel(newSessionKey, userId, req.user.plan, {
        runtime,
        timeout_seconds: timeoutSeconds,
        term_pass: termPass
      });
    } catch (kErr) {
      console.error('Kaggle kernel trigger error:', kErr.message);
      if (runtime === 'gpu') await redisCmd('SREM', 'gpu:active', newSessionKey);
      await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [newSessionKey]);
      await redisCmd('HSET', `session:${newSessionKey}`, 'status', 'failed', 'error', kErr.message);
      return res.status(502).json({ status: 'error', msg: `Failed to re-launch DevBox: ${kErr.message}` });
    }

    res.json({
      status: 'queued',
      session_key: newSessionKey,
      runtime,
      expires: expiresAt,
      term_pass: termPass,
      msg: `Re-launching fresh DevBox ${runtime === 'gpu' ? '2× Tesla T4 GPU' : 'CPU'} session...`
    });
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

    // 1. Verify ownership in D1 first
    const inst = await d1QueryOne(
      "SELECT id, user_id, status, public_url, created_at, expires_at, config FROM instances WHERE session_key = ?",
      [session_id]
    );

    if (!inst) {
      return res.status(404).json({ status: 'not_found', msg: 'Instance not found' });
    }
    if (inst.user_id !== req.user.sub && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'forbidden', msg: 'Access denied' });
    }

    // 2. Check Redis for live tunnel_url
    const data = redisParseHash(await redisCmd('HGETALL', `session:${session_id}`));
    const cfg = JSON.parse(inst.config || '{}');
    const termPass = data?.term_pass || cfg.term_pass || null;

    if (data && data.status) {
      if (data.tunnel_url && !inst.public_url) {
        await executeD1("UPDATE instances SET status = ?, public_url = ? WHERE session_key = ?", [data.status, data.tunnel_url, session_id]);
      }
      return res.json({
        status: data.status,
        tunnel_url: data.tunnel_url || inst.public_url || null,
        expires_at: data.expires_at || inst.expires_at || null,
        term_pass: termPass,
        error: data.error || null,
      });
    }

    if (inst.status === 'pending') {
      const createdTime = new Date(inst.created_at).getTime();
      if (Date.now() - createdTime > 300000) {
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [session_id]);
        await redisCmd('SREM', 'gpu:active', session_id);
        return res.json({ status: 'failed', msg: 'DevBox GPU allocation timed out or runner failed.' });
      }
    }

    res.json({
      status: inst.status,
      tunnel_url: inst.public_url || null,
      expires_at: inst.expires_at || null,
      term_pass: termPass,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to check DevBox session' });
  }
});

// ── GPU Pool Status ──
devboxRouter.get('/gpu_status', requireAuth, async (req, res) => {
  try {
    const activeCount = parseInt(await redisCmd('SCARD', 'gpu:active') || '0');
    res.json({ status: 'success', active_sessions: activeCount, capacity: 4 });
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

    for (const inst of instances) {
      let termPass = null;
      try {
        const cfg = JSON.parse(inst.config || '{}');
        termPass = cfg.term_pass || null;
      } catch (_) {}
      inst.term_pass = termPass;

      if (inst.public_url && inst.status === 'active') continue;
      const rawData = await redisCmd('HGETALL', `session:${inst.session_key}`);
      const data = redisParseHash(rawData);
      if (data && (data.status === 'active' || data.tunnel_url)) {
        if (data.tunnel_url) inst.public_url = data.tunnel_url;
        if (data.status) inst.status = data.status;
        if (data.term_pass && !inst.term_pass) inst.term_pass = data.term_pass;
        await executeD1(
          "UPDATE instances SET status = ?, public_url = COALESCE(?, public_url), stopped_at = NULL WHERE session_key = ?",
          [inst.status, inst.public_url || null, inst.session_key]
        );
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
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'session_key required' });

    const inst = await d1QueryOne(
      "SELECT id, created_at, status, runner_id FROM instances WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );
    if (!inst) return res.status(404).json({ status: 'error', msg: 'Instance not found or access denied' });

    const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(inst.created_at).getTime()) / 1000));
    await consumeQuota(redisCmd, req.user.sub, 'devbox', durationSeconds).catch(() => {});

    await executeD1(
      "UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );
    if (inst.runner_id) {
      await executeD1("UPDATE runners SET active_count = MAX(0, active_count - 1) WHERE id = ?", [inst.runner_id]);
    }

    await redisCmd('SREM', 'gpu:active', session_key);
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    await redisCmd('HSET', `session:${session_key}`, 'status', 'stopped');

    res.json({ status: 'success', msg: 'DevBox session terminated' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to stop DevBox' });
  }
});

// ── Dismiss Instance ──
devboxRouter.delete('/instance/:session_key', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.params;
    const inst = await d1QueryOne("SELECT id, runner_id, status FROM instances WHERE session_key = ? AND user_id = ?", [session_key, req.user.sub]);
    if (!inst) return res.status(404).json({ status: 'error', msg: 'Instance not found or access denied' });

    await executeD1(
      "UPDATE instances SET status = 'dismissed' WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );

    if (inst.runner_id && inst.status !== 'stopped' && inst.status !== 'dismissed') {
      await executeD1("UPDATE runners SET active_count = MAX(0, active_count - 1) WHERE id = ?", [inst.runner_id]);
    }

    await redisCmd('SREM', 'gpu:active', session_key);
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    res.json({ status: 'success', msg: 'Instance dismissed' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to dismiss instance' });
  }
});
