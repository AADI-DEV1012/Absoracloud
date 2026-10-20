// ── VPS Routes — V3 Architecture (Kaggle CPU-only) ──
// POST /vps/launch, GET /vps/status, POST /vps/stop, GET /vps/check_session, POST /vps/relaunch, DELETE /vps/instance/:session_key

import { Router } from 'express';
import { requireAuth }    from '../middleware/auth.js';
import { requireQuota }   from '../middleware/quota.js';
import { launchLimiter }  from '../middleware/abuse_guard.js';

import { queryD1, executeD1, d1QueryOne } from '../../../../packages/shared/d1.js';
import { redisCmd, redisParseHash }       from '../../../../packages/shared/redis.js';
import { getPlan, consumeQuota }          from '../../../../packages/shared/plans.js';
import { triggerVPSKernel }               from '../services/kaggle.js';
import crypto from 'crypto';

export const vpsRouter = Router();

// Helper to sync stale pending instances (5 min timeout)
async function syncUserVPSState(userId) {
  await executeD1(
    `UPDATE instances 
     SET status = 'failed', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'vps' AND status = 'pending' 
       AND datetime(created_at) <= datetime('now', '-5 minutes')`,
    [userId]
  );
}

// ── Launch VPS ──
vpsRouter.post('/launch', requireAuth, launchLimiter, requireQuota('vps'), async (req, res) => {
  try {
    const userId = req.user.sub;
    const plan = getPlan(req.user.plan);
    const { force, relaunch } = req.body;
    const sessionKey = `vps-${userId}-${crypto.randomUUID().slice(0, 8)}`;

    await syncUserVPSState(userId);

    // If force or relaunch, stop previous active instance
    if (force || relaunch) {
      const running = await queryD1(
        "SELECT id, session_key, created_at FROM instances WHERE user_id = ? AND service = 'vps' AND status IN ('pending','active')",
        [userId]
      );
      for (const r of running) {
        const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 1000));
        await consumeQuota(redisCmd, userId, 'vps', durationSeconds).catch(() => {});
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

    const timeoutSeconds = Math.floor(plan.vps_hours_week / 7 * 3600);
    const termPass = crypto.randomBytes(6).toString('hex');
    const config = JSON.stringify({ cpu: plan.vps_cpu, ram_mb: plan.vps_ram_mb, runtime: 'kaggle_cpu', term_pass: termPass });
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config, expires_at) VALUES (?, 'vps', ?, 'pending', ?, ?)",
      [userId, sessionKey, config, expiresAt]
    );

    await redisCmd('HSET', `session:${sessionKey}`,
      'user_id', String(userId),
      'status', 'pending',
      'service', 'vps',
      'term_pass', termPass
    );
    await redisCmd('EXPIRE', `session:${sessionKey}`, String(timeoutSeconds + 3600));

    // Trigger Kaggle CPU Kernel for VPS
    try {
      await triggerVPSKernel(sessionKey, userId, req.user.plan, {
        ram_mb: plan.vps_ram_mb,
        timeout_seconds: timeoutSeconds,
        term_pass: termPass,
      });
    } catch (kErr) {
      console.error('Kaggle VPS kernel trigger error:', kErr.message);
      await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [sessionKey]);
      await redisCmd('HSET', `session:${sessionKey}`, 'status', 'failed', 'error', kErr.message);
      return res.status(502).json({ status: 'error', msg: `Failed to provision Kaggle VPS runtime: ${kErr.message}` });
    }

    res.json({
      status: 'queued',
      session_key: sessionKey,
      plan: req.user.plan,
      expires: expiresAt,
      term_pass: termPass,
      msg: 'VPS container initializing on Kaggle CPU runtime...'
    });
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

    // Verify ownership of the old session if provided
    if (session_key) {
      const oldInst = await d1QueryOne("SELECT id, created_at FROM instances WHERE session_key = ? AND user_id = ?", [session_key, userId]);
      if (oldInst) {
        const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(oldInst.created_at).getTime()) / 1000));
        await consumeQuota(redisCmd, userId, 'vps', durationSeconds).catch(() => {});
        await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ?", [session_key]);
        await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
      }
    }

    const plan = getPlan(req.user.plan);
    const newSessionKey = `vps-${userId}-${crypto.randomUUID().slice(0, 8)}`;
    const timeoutSeconds = Math.floor(plan.vps_hours_week / 7 * 3600);
    const termPass = crypto.randomBytes(6).toString('hex');
    const config = JSON.stringify({ cpu: plan.vps_cpu, ram_mb: plan.vps_ram_mb, runtime: 'kaggle_cpu', term_pass: termPass });
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config, expires_at) VALUES (?, 'vps', ?, 'pending', ?, ?)",
      [userId, newSessionKey, config, expiresAt]
    );

    await redisCmd('HSET', `session:${newSessionKey}`,
      'user_id', String(userId),
      'status', 'pending',
      'service', 'vps',
      'term_pass', termPass
    );
    await redisCmd('EXPIRE', `session:${newSessionKey}`, String(timeoutSeconds + 3600));

    // Trigger Kaggle CPU Kernel
    try {
      await triggerVPSKernel(newSessionKey, userId, req.user.plan, {
        ram_mb: plan.vps_ram_mb,
        timeout_seconds: timeoutSeconds,
        term_pass: termPass,
      });
    } catch (kErr) {
      console.error('Kaggle VPS kernel relaunch error:', kErr.message);
      await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [newSessionKey]);
      await redisCmd('HSET', `session:${newSessionKey}`, 'status', 'failed', 'error', kErr.message);
      return res.status(502).json({ status: 'error', msg: `Failed to re-launch Kaggle VPS: ${kErr.message}` });
    }

    res.json({ status: 'queued', session_key: newSessionKey, term_pass: termPass, msg: 'Re-launching VPS on Kaggle CPU runtime...' });
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

    // 1. Verify ownership in D1 first before exposing any details
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
        expires_at: data.expires_at ? parseInt(data.expires_at) : (inst.expires_at || null),
        term_pass: termPass,
        error: data.error || null,
      });
    }

    // Auto-mark timed out pending (300s / 5m timeout)
    if (inst.status === 'pending') {
      const createdTime = new Date(inst.created_at).getTime();
      if (Date.now() - createdTime > 300000) {
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [session_id]);
        await redisCmd('HSET', `session:${session_id}`, 'status', 'failed', 'error', 'Runner startup timed out or failed to connect.');
        return res.json({ status: 'failed', msg: 'Runner startup timed out or failed to connect.' });
      }
    }

    res.json({
      status: inst.status,
      tunnel_url: inst.public_url || null,
      expires_at: inst.expires_at || null,
      term_pass: termPass,
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
        if (data.tunnel_url) {
          inst.public_url = data.tunnel_url;
        }
        if (data.status) {
          inst.status = data.status;
        }
        if (data.term_pass && !inst.term_pass) {
          inst.term_pass = data.term_pass;
        }
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
vpsRouter.post('/stop', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.body;
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'session_key required' });

    // Verify ownership
    const inst = await d1QueryOne(
      "SELECT id, created_at, status FROM instances WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );
    if (!inst) return res.status(404).json({ status: 'error', msg: 'VPS instance not found or access denied' });

    const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(inst.created_at).getTime()) / 1000));
    await consumeQuota(redisCmd, req.user.sub, 'vps', durationSeconds).catch(() => {});

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
    const inst = await d1QueryOne("SELECT id FROM instances WHERE session_key = ? AND user_id = ?", [session_key, req.user.sub]);
    if (!inst) return res.status(404).json({ status: 'error', msg: 'Instance not found or access denied' });

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
