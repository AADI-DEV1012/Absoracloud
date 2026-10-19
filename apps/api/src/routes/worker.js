// ── Worker Routes ──
// Called by runners (MC daemon, VPS server, DevBox kernel) to register and heartbeat.

import { Router } from 'express';
import { requireWorkerAuth } from '../middleware/worker_auth.js';
import { executeD1, d1QueryOne } from '../../../../packages/shared/d1.js';
import { redisCmd }              from '../../../../packages/shared/redis.js';

export const workerRouter = Router();
workerRouter.use(requireWorkerAuth);

// ── Register runner ──
workerRouter.post('/register', async (req, res) => {
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
});

// ── Heartbeat ──
workerRouter.post('/heartbeat', async (req, res) => {
  const { runner_id, active_count = 0 } = req.body;
  if (!runner_id) return res.status(400).json({ status: 'error', msg: 'runner_id required' });

  await executeD1(
    "UPDATE runners SET last_heartbeat = datetime('now'), active_count = ? WHERE id = ?",
    [active_count, runner_id]
  );
  await redisCmd('HSET', `runner:${runner_id}`, 'heartbeat', String(Math.floor(Date.now() / 1000)), 'active_count', String(active_count));

  res.json({ status: 'success' });
});

// ── Session update (runner reports session state changes) ──
workerRouter.post('/session_update', async (req, res) => {
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
});
