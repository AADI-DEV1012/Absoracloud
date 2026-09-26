// ── MC Hosting Routes ──
// POST /mc/launch, GET /mc/status, POST /mc/stop, GET /mc/check_session, POST /mc/relaunch, DELETE /mc/instance/:session_key

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

// Helper to sync stale pending or disconnected instances
async function syncUserMCState(userId) {
  // Mark pending instances older than 3 minutes as failed
  await executeD1(
    `UPDATE instances 
     SET status = 'failed', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'mc' AND status = 'pending' 
       AND datetime(created_at) <= datetime('now', '-3 minutes')`,
    [userId]
  );
  // Mark active instances whose runner is offline as disconnected
  await executeD1(
    `UPDATE instances 
     SET status = 'disconnected', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'mc' AND status = 'active'
       AND runner_id IN (SELECT id FROM runners WHERE status = 'offline')`,
    [userId]
  );
}

// ── Launch MC Server ──
mcRouter.post('/launch', requireAuth, launchLimiter, requireQuota('mc'), async (req, res) => {
  try {
    const userId   = req.user.sub;
    const plan     = getPlan(req.user.plan);
    const { server_type = 'paper', version = '1.20.4', java_version = 'auto', servername = '', force, relaunch } = req.body;
    const sessionKey = `mc-${userId}-${crypto.randomUUID().slice(0, 8)}`;

    let cleanName = (servername || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
    if (!cleanName) {
      cleanName = `craft-${crypto.randomUUID().slice(0, 6)}`;
    }

    // Sync stale or disconnected instances
    await syncUserMCState(userId);

    // If force or relaunch, stop previous active instance
    if (force || relaunch) {
      const running = await queryD1(
        "SELECT session_key FROM instances WHERE user_id = ? AND service = 'mc' AND status IN ('pending','active')",
        [userId]
      );
      for (const r of running) {
        await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ?", [r.session_key]);
        await redisCmd('SET', `kill:${r.session_key}`, '1', 'EX', '300');
        await redisCmd('HDEL', `session:${r.session_key}`, 'status');
      }
    }

    // Check for existing active MC session
    const existing = await d1QueryOne(
      "SELECT id, session_key FROM instances WHERE user_id = ? AND service = 'mc' AND status IN ('pending','active')", [userId]
    );
    if (existing) {
      return res.status(409).json({ 
        status: 'error', 
        msg: 'You already have an active MC server. You can re-launch to replace it.',
        can_relaunch: true,
        session_key: existing.session_key
      });
    }

    // Check for available multi-tenant MC runner
    const runners = await queryD1(
      "SELECT * FROM runners WHERE service = 'mc' AND status = 'ready' AND active_count < capacity ORDER BY active_count ASC LIMIT 1"
    );

    const config = JSON.stringify({ server_type, version, java_version, servername: cleanName, domain: `${cleanName}.astrocore.qzz.io`, ram_mb: plan.mc_ram_mb });
    const expiresAt = new Date(Date.now() + (plan.mc_hours_week / 7) * 3600 * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, config, expires_at) VALUES (?, 'mc', ?, ?, ?)",
      [userId, sessionKey, config, expiresAt]
    );

    if (runners.length > 0) {
      const runner = runners[0];
      await executeD1("UPDATE runners SET active_count = active_count + 1 WHERE id = ?", [runner.id]);
      await executeD1("UPDATE instances SET runner_id = ? WHERE session_key = ?", [runner.id, sessionKey]);
      await redisCmd('HSET', `session:${sessionKey}`, 'user_id', String(userId), 'status', 'pending', 'runner_id', runner.id);
      await redisCmd('EXPIRE', `session:${sessionKey}`, String(Math.floor((plan.mc_hours_week / 7) * 3600)));

      // Notify runner via Redis task queue
      await redisCmd('RPUSH', `runner:${runner.id}:tasks`, JSON.stringify({
        action: 'start_mc',
        session_key: sessionKey,
        server_type,
        version,
        java_version,
        servername: cleanName,
        ram_mb: plan.mc_ram_mb,
        expires_at: expiresAt,
      }));

      res.json({ 
        status: 'queued', 
        session_key: sessionKey, 
        runner_id: runner.id, 
        servername: cleanName,
        domain: `${cleanName}.astrocore.qzz.io`,
        expires: expiresAt, 
        msg: `MC instance assigned to active runner — deploying ${cleanName}.astrocore.qzz.io...` 
      });
    } else {
      // Trigger GitHub Actions workflow to spin up new runner
      await triggerWorkflow('mc_runner.yml', {
        session_key: sessionKey,
        user_id: String(userId),
        plan: req.user.plan,
        server_type,
        version,
        java_version: String(java_version || 'auto'),
        servername: cleanName,
        ram_mb: String(plan.mc_ram_mb),
      });

      res.json({ 
        status: 'queued', 
        session_key: sessionKey, 
        servername: cleanName,
        domain: `${cleanName}.astrocore.qzz.io`,
        expires: expiresAt, 
        msg: `Spinning up new MC runner for ${cleanName}.astrocore.qzz.io...` 
      });
    }
  } catch (e) {
    console.error('MC launch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to launch MC server' });
  }
});

// ── Re-launch MC Server (One-click restart / replace) ──
mcRouter.post('/relaunch', requireAuth, launchLimiter, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { session_key, server_type = 'paper', version = '1.20.4', java_version = 'auto', servername = '' } = req.body;

    let cleanName = (servername || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
    if (!cleanName) {
      cleanName = `craft-${crypto.randomUUID().slice(0, 6)}`;
    }

    if (session_key) {
      await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ? AND user_id = ?", [session_key, userId]);
      await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    }

    req.body.force = true;
    req.body.server_type = server_type;
    req.body.version = version;
    req.body.java_version = java_version;
    req.body.servername = cleanName;

    const plan = getPlan(req.user.plan);
    const newSessionKey = `mc-${userId}-${crypto.randomUUID().slice(0, 8)}`;
    const config = JSON.stringify({ server_type, version, java_version, servername: cleanName, domain: `${cleanName}.astrocore.qzz.io`, ram_mb: plan.mc_ram_mb });
    const expiresAt = new Date(Date.now() + (plan.mc_hours_week / 7) * 3600 * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, config, expires_at) VALUES (?, 'mc', ?, ?, ?)",
      [userId, newSessionKey, config, expiresAt]
    );

    const runners = await queryD1(
      "SELECT * FROM runners WHERE service = 'mc' AND status = 'ready' AND active_count < capacity ORDER BY active_count ASC LIMIT 1"
    );

    if (runners.length > 0) {
      const runner = runners[0];
      await executeD1("UPDATE runners SET active_count = active_count + 1 WHERE id = ?", [runner.id]);
      await executeD1("UPDATE instances SET runner_id = ? WHERE session_key = ?", [runner.id, newSessionKey]);
      await redisCmd('HSET', `session:${newSessionKey}`, 'user_id', String(userId), 'status', 'pending', 'runner_id', runner.id);
      await redisCmd('RPUSH', `runner:${runner.id}:tasks`, JSON.stringify({
        action: 'start_mc',
        session_key: newSessionKey,
        server_type,
        version,
        java_version,
        servername: cleanName,
        ram_mb: plan.mc_ram_mb,
        expires_at: expiresAt,
      }));
      return res.json({ status: 'queued', session_key: newSessionKey, servername: cleanName, domain: `${cleanName}.astrocore.qzz.io`, msg: `Re-launching ${cleanName}.astrocore.qzz.io on active runner...` });
    }

    await triggerWorkflow('mc_runner.yml', {
      session_key: newSessionKey,
      user_id: String(userId),
      plan: req.user.plan,
      server_type,
      version,
      java_version: String(java_version || 'auto'),
      servername: cleanName,
      ram_mb: String(plan.mc_ram_mb),
    });
    res.json({ status: 'queued', session_key: newSessionKey, servername: cleanName, domain: `${cleanName}.astrocore.qzz.io`, msg: `Re-launching fresh MC runner for ${cleanName}.astrocore.qzz.io...` });
  } catch (e) {
    console.error('MC relaunch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to re-launch MC server' });
  }
});

// ── Check Session (polling endpoint) ──
mcRouter.get('/check_session', requireAuth, async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ status: 'error', msg: 'Missing session_id' });

    // 1. Check Redis first
    const data = redisParseHash(await redisCmd('HGETALL', `session:${session_id}`));
    if (data && data.status) {
      return res.json({
        status: data.status,
        tunnel_url: data.domain || data.tunnel_url || null,
        domain: data.domain || null,
        direct_address: data.direct_address || null,
        bore_port: data.bore_port || null,
        servername: data.servername || null,
        expires_at: data.expires_at || null,
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

    if (inst.status === 'pending') {
      const createdTime = new Date(inst.created_at).getTime();
      if (Date.now() - createdTime > 180000) {
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [session_id]);
        return res.json({ status: 'failed', msg: 'Minecraft server setup timed out or runner failed.' });
      }
    }

    if (inst.runner_id && inst.status === 'active') {
      const r = await d1QueryOne("SELECT status FROM runners WHERE id = ?", [inst.runner_id]);
      if (r && r.status === 'offline') {
        await executeD1("UPDATE instances SET status = 'disconnected', stopped_at = datetime('now') WHERE session_key = ?", [session_id]);
        return res.json({ status: 'disconnected', msg: 'Runner went offline.' });
      }
    }

    res.json({
      status: inst.status,
      tunnel_url: inst.public_url || null,
      expires_at: inst.expires_at || null,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to check MC session' });
  }
});

// ── Check Status ──
mcRouter.get('/status', requireAuth, async (req, res) => {
  try {
    await syncUserMCState(req.user.sub);

    const instances = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'mc' AND status != 'dismissed' ORDER BY created_at DESC LIMIT 10",
      [req.user.sub]
    );

    // Live Redis enrichment
    for (const inst of instances) {
      const raw = await redisCmd('HGETALL', `session:${inst.session_key}`);
      const data = redisParseHash(raw);
      if (data) {
        if (data.domain || data.tunnel_url) inst.public_url = data.domain || data.tunnel_url;
        if (data.direct_address) inst.direct_address = data.direct_address;
        if (data.bore_port) inst.bore_port = data.bore_port;
        if (data.servername) inst.servername = data.servername;
        if (data.status && data.status !== 'pending') inst.status = data.status;
        if (data.expires_at) inst.expires_at = data.expires_at;
      }
    }

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
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
    await redisCmd('HSET', `session:${session_key}`, 'status', 'stopped');

    res.json({ status: 'success', msg: 'Stop signal sent' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to stop server' });
  }
});

// ── Dismiss Instance ──
mcRouter.delete('/instance/:session_key', requireAuth, async (req, res) => {
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

// ── Pterodactyl Panel: Fetch Server Console Logs ──
mcRouter.get('/logs', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.query;
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'Missing session_key' });
    const raw = await redisCmd('LRANGE', `mc:${session_key}:logs`, '0', '-1');
    const logs = Array.isArray(raw) ? raw : [];
    res.json({ status: 'success', logs });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch logs' });
  }
});

// ── Pterodactyl Panel: Send Console Command ──
mcRouter.post('/command', requireAuth, async (req, res) => {
  try {
    const { session_key, command } = req.body;
    if (!session_key || !command) return res.status(400).json({ status: 'error', msg: 'Missing parameters' });
    
    // Echo command in logs buffer
    await redisCmd('RPUSH', `mc:${session_key}:logs`, `> ${command}`);
    // Push command to runner queue
    await redisCmd('RPUSH', `mc:${session_key}:cmd`, command);
    res.json({ status: 'success', msg: 'Command dispatched' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to send command' });
  }
});

// ── Pterodactyl Panel: Power Actions (start, restart, stop, kill) ──
mcRouter.post('/power', requireAuth, async (req, res) => {
  try {
    const { session_key, action } = req.body;
    if (!session_key || !action) return res.status(400).json({ status: 'error', msg: 'Missing parameters' });

    if (action === 'stop' || action === 'kill') {
      await executeD1(
        "UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ? AND user_id = ?",
        [session_key, req.user.sub]
      );
      await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');
      await redisCmd('HSET', `session:${session_key}`, 'status', 'stopped');
      await redisCmd('RPUSH', `mc:${session_key}:logs`, `[Server] Power action triggered: ${action.toUpperCase()}`);
      return res.json({ status: 'success', msg: `Server ${action} signal sent` });
    }

    if (action === 'restart') {
      await redisCmd('RPUSH', `mc:${session_key}:logs`, `[Server] Restart signal received.`);
      await redisCmd('RPUSH', `mc:${session_key}:cmd`, 'stop');
      return res.json({ status: 'success', msg: 'Restart initiated' });
    }

    res.json({ status: 'success' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to process power action' });
  }
});

// ── Pterodactyl Panel: Live Stats ──
mcRouter.get('/stats', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.query;
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'Missing session_key' });
    const raw = await redisCmd('HGETALL', `session:${session_key}`);
    const data = redisParseHash(raw) || {};
    res.json({
      status: 'success',
      stats: {
        cpu: parseFloat(data.cpu || '0.0'),
        ram_used: parseInt(data.ram_used || '0', 10),
        ram_max: parseInt(data.ram_mb || '1024', 10),
        domain: data.domain || data.tunnel_url || null,
        direct_address: data.direct_address || null,
        bore_port: data.bore_port || null,
        server_status: data.status || 'unknown'
      }
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch stats' });
  }
});
