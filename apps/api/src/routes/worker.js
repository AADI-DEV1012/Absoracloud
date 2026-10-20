// ── Worker Routes ──
// Called by runners (MC daemon, VPS server, DevBox kernel) to register and heartbeat.

import { Router } from 'express';
import { requireWorkerAuth }  from '../middleware/worker_auth.js';
import { asyncHandler }       from '../middleware/async_handler.js';
import { executeD1, d1QueryOne, queryD1 } from '../../../../packages/shared/d1.js';
import { redisCmd }              from '../../../../packages/shared/redis.js';

export const workerRouter = Router();
workerRouter.use(requireWorkerAuth);

// ── Register runner ──
workerRouter.post('/register', asyncHandler(async (req, res) => {
  try {
    const { runner_id, type, service, capacity = 1, tunnel_url } = req.body;
    if (!runner_id || !type || !service) {
      return res.status(400).json({ status: 'error', msg: 'runner_id, type, service required' });
    }

    await executeD1(
      `INSERT OR REPLACE INTO runners (id, type, service, capacity, status, last_heartbeat)
       VALUES (?, ?, ?, ?, 'ready', datetime('now'))`,
      [runner_id, type, service, capacity]
    );

    // Store tunnel URL in Redis
    if (tunnel_url) {
      await redisCmd('HSET', `runner:${runner_id}`, 'tunnel_url', tunnel_url, 'status', 'ready');
      await redisCmd('EXPIRE', `runner:${runner_id}`, '25200'); // 7h
    }

    await redisCmd('SADD', 'runners:active', runner_id);
    res.json({ status: 'success', msg: 'Runner registered' });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── Heartbeat ──
workerRouter.post('/heartbeat', asyncHandler(async (req, res) => {
  try {
    const { runner_id, active_count = 0, session_key, status, tunnel_url } = req.body;

    // Handle session updates sent to /heartbeat
    if (session_key) {
      if (status || tunnel_url) {
        await executeD1(
          "UPDATE instances SET status = COALESCE(?, status), public_url = COALESCE(?, public_url) WHERE session_key = ?",
          [status || 'active', tunnel_url || null, session_key]
        );
        if (tunnel_url) {
          await redisCmd('HSET', `session:${session_key}`, 'status', status || 'active', 'tunnel_url', tunnel_url);
        }
      }
      return res.json({ status: 'success', msg: 'Session heartbeat registered' });
    }

    if (!runner_id) return res.status(400).json({ status: 'error', msg: 'runner_id or session_key required' });

    await executeD1(
      "UPDATE runners SET last_heartbeat = datetime('now'), active_count = ? WHERE id = ?",
      [active_count, runner_id]
    );
    await redisCmd('HSET', `runner:${runner_id}`, 'heartbeat', String(Math.floor(Date.now() / 1000)), 'active_count', String(active_count));

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── Runner Heartbeat (Multi-tenant master daemon) ──
workerRouter.post('/runner_heartbeat', asyncHandler(async (req, res) => {
  try {
    const { runner_id, active_count = 0 } = req.body;
    if (!runner_id) {
      return res.status(400).json({ status: 'error', msg: 'runner_id required' });
    }

    await executeD1(
      "UPDATE runners SET last_heartbeat = datetime('now'), active_count = ?, status = 'ready' WHERE id = ?",
      [active_count, runner_id]
    );
    await redisCmd('HSET', `runner:${runner_id}`, 'heartbeat', String(Math.floor(Date.now() / 1000)), 'active_count', String(active_count));

    // Fetch instances assigned to this runner that are pending or active
    const instances = await queryD1(
      "SELECT session_key, status, config FROM instances WHERE runner_id = ? AND status IN ('pending', 'active')",
      [runner_id]
    );

    const assignments = (instances || []).map(inst => {
      let termPass = '';
      try {
        const cfg = JSON.parse(inst.config || '{}');
        termPass = cfg.term_pass || '';
      } catch {}
      return { session_key: inst.session_key, term_pass: termPass, status: inst.status };
    });

    const kill = await redisCmd('GET', `kill:runner:${runner_id}`);

    res.json({
      status: 'success',
      assignments,
      kill: kill === '1'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── Runner Clean Shutdown (Called when idle for 5 min with 0 users) ──
workerRouter.post('/runner_shutdown', asyncHandler(async (req, res) => {
  try {
    const { runner_id, reason = 'idle_timeout' } = req.body;
    if (!runner_id) {
      return res.status(400).json({ status: 'error', msg: 'runner_id required' });
    }

    await executeD1("UPDATE runners SET status = 'stopped' WHERE id = ?", [runner_id]);
    await redisCmd('SREM', 'runners:active', runner_id);
    await redisCmd('HDEL', `runner:${runner_id}`, 'status');

    console.log(`🛑 Runner ${runner_id} clean shutdown acknowledged (reason: ${reason})`);
    res.json({ status: 'success', msg: `Runner ${runner_id} shut down acknowledged` });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── Session update (runner reports session state changes) ──
workerRouter.post('/session_update', asyncHandler(async (req, res) => {
  try {
    const { session_key, status, tunnel_url, expires_at } = req.body;
    if (!session_key || !status) {
      return res.status(400).json({ status: 'error', msg: 'session_key and status required' });
    }

    await executeD1(
      "UPDATE instances SET status = ?, public_url = COALESCE(?, public_url) WHERE session_key = ?",
      [status, tunnel_url || null, session_key]
    );

    // Update Redis session state
    const fields = ['status', status];
    if (tunnel_url) fields.push('tunnel_url', tunnel_url);
    if (expires_at) fields.push('expires_at', String(expires_at));
    await redisCmd('HSET', `session:${session_key}`, ...fields);

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));
