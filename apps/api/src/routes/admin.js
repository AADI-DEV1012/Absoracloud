import { Router } from 'express';
import { requireAdmin, ADMIN_USERNAME, ADMIN_SECRET_KEY }  from '../middleware/admin_auth.js';
import { asyncHandler }  from '../middleware/async_handler.js';
import { signToken }     from '../../../../packages/shared/jwt.js';
import { queryD1, executeD1 } from '../../../../packages/shared/d1.js';
import { redisCmd }           from '../../../../packages/shared/redis.js';
import { PLANS }              from '../../../../packages/shared/plans.js';
import { getLogDiskUsage, getRunLog, purgeLogs, appendRunLog } from '../services/run_logger.js';

export const adminRouter = Router();

// ── POST /admin/login — Verify Admin Credentials & Issue Token ──
adminRouter.post('/login', asyncHandler(async (req, res) => {
  const { username, secret_key } = req.body || {};
  if (!username || !secret_key) {
    return res.status(400).json({ status: 'error', msg: 'Admin username and secret key are required' });
  }

  if (
    username.trim().toLowerCase() !== ADMIN_USERNAME.toLowerCase() ||
    secret_key.trim() !== ADMIN_SECRET_KEY
  ) {
    return res.status(401).json({ status: 'error', msg: 'Invalid admin username or secret key' });
  }

  const token = signToken({
    sub: 'admin-absoracloud',
    username: ADMIN_USERNAME,
    role: 'admin',
    is_admin_plane: true
  }, '24h');

  res.json({
    status: 'success',
    msg: 'Admin Plane authenticated successfully',
    token,
    username: ADMIN_USERNAME
  });
}));

// Protect all remaining routes with requireAdmin
adminRouter.use(requireAdmin);

// ── GET /admin/users ──
adminRouter.get('/users', asyncHandler(async (req, res) => {
  try {
    const users = await queryD1('SELECT id, username, email, plan, role, created_at, locked_until FROM users ORDER BY id DESC LIMIT 100');
    res.json({ status: 'success', users });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── GET /admin/runners — Detailed Runner Status ──
adminRouter.get('/runners', asyncHandler(async (req, res) => {
  try {
    const runners = await queryD1('SELECT * FROM runners ORDER BY last_heartbeat DESC');
    
    // Enrich runners with live assignments and heartbeat diff
    const enriched = await Promise.all((runners || []).map(async (r) => {
      let secondsAgo = null;
      if (r.last_heartbeat) {
        const beatTime = new Date(r.last_heartbeat).getTime();
        secondsAgo = Math.max(0, Math.floor((Date.now() - beatTime) / 1000));
      }

      // Fetch active instances on this runner
      const instances = await queryD1(
        "SELECT session_key, user_id, service, status, public_url, created_at FROM instances WHERE runner_id = ? AND status IN ('active', 'pending')",
        [r.id]
      ).catch(() => []);

      return {
        ...r,
        seconds_ago: secondsAgo,
        instances: instances || []
      };
    }));

    res.json({ status: 'success', runners: enriched });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── POST /admin/runners/:id/kill — Terminate Runner Node ──
adminRouter.post('/runners/:id/kill', asyncHandler(async (req, res) => {
  try {
    const runnerId = req.params.id;
    if (!runnerId) return res.status(400).json({ status: 'error', msg: 'runnerId required' });

    // Set kill flag in Redis
    await redisCmd('SET', `kill:runner:${runnerId}`, '1', 'EX', '300');
    await redisCmd('SREM', 'runners:active', runnerId);

    // Update runner status in D1
    await executeD1("UPDATE runners SET status = 'dead', active_count = 0 WHERE id = ?", [runnerId]);

    // Disconnect orphaned instances
    const orphaned = await queryD1(
      "SELECT id, session_key, service FROM instances WHERE runner_id = ? AND status IN ('active', 'pending')",
      [runnerId]
    ).catch(() => []);

    for (const inst of (orphaned || [])) {
      await executeD1("UPDATE instances SET status = 'disconnected', stopped_at = datetime('now') WHERE id = ?", [inst.id]);
      if (inst.session_key) {
        await redisCmd('HSET', `session:${inst.session_key}`, 'status', 'disconnected', 'error', 'Terminated by administrator');
        appendRunLog(inst.service || 'vps', inst.session_key, `Runner ${runnerId} killed by administrator. Session disconnected.`, 'WARN');
      }
    }

    res.json({ status: 'success', msg: `Runner ${runnerId} terminated. Disconnected ${(orphaned || []).length} instances.` });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── GET /admin/runs — List All Service Runs (DevBox, VPS, Serverless, WebHost) ──
adminRouter.get('/runs', asyncHandler(async (req, res) => {
  try {
    const { service, status, limit = 50 } = req.query;
    let sql = 'SELECT * FROM instances WHERE status != "dismissed"';
    const params = [];

    if (service && ['devbox', 'vps', 'serverless', 'webhost'].includes(service)) {
      sql += ' AND service = ?';
      params.push(service);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(100, parseInt(limit) || 50));

    const runs = await queryD1(sql, params);
    res.json({ status: 'success', runs: runs || [] });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── GET /admin/logs — Disk Usage and Stored Log Files (<200MB quota) ──
adminRouter.get('/logs', asyncHandler(async (req, res) => {
  try {
    const usage = getLogDiskUsage();
    res.json({ status: 'success', ...usage });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── GET /admin/logs/:service/:runId — Read Specific Run Log ──
adminRouter.get('/logs/:service/:runId', asyncHandler(async (req, res) => {
  try {
    const { service, runId } = req.params;
    const logData = getRunLog(service, runId);
    if (!logData) {
      return res.status(400).json({ status: 'error', msg: 'Invalid service or runId' });
    }
    res.json({ status: 'success', log: logData });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── POST /admin/logs/purge — Clear Old Run Logs ──
adminRouter.post('/logs/purge', asyncHandler(async (req, res) => {
  try {
    const { service = 'all' } = req.body;
    const result = purgeLogs(service);
    const newUsage = getLogDiskUsage();
    res.json({ status: 'success', ...result, currentUsage: newUsage });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── GET /admin/stats — System Overview with Disk Log Metrics ──
adminRouter.get('/stats', asyncHandler(async (req, res) => {
  try {
    const [users, instances, runners] = await Promise.all([
      queryD1('SELECT COUNT(*) as cnt FROM users'),
      queryD1("SELECT service, status, COUNT(*) as cnt FROM instances GROUP BY service, status"),
      queryD1("SELECT COUNT(*) as cnt FROM runners WHERE status = 'ready'"),
    ]);

    const logUsage = getLogDiskUsage();

    res.json({
      status: 'success',
      total_users: users[0]?.cnt || 0,
      instances: instances || [],
      active_runners: runners[0]?.cnt || 0,
      log_storage: {
        total_mb: logUsage.totalMB,
        max_mb: logUsage.maxMB,
        percent_used: logUsage.percentUsed,
        file_count: logUsage.fileCount,
        breakdown: logUsage.breakdown
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── POST /admin/ban ──
adminRouter.post('/ban', asyncHandler(async (req, res) => {
  try {
    const { username, service = 'all', reason = '' } = req.body;
    if (!username) return res.status(400).json({ status: 'error', msg: 'Username required' });

    await executeD1('INSERT INTO bans (username, service, reason) VALUES (?, ?, ?)', [username, service, reason]);
    await executeD1("UPDATE users SET locked_until = datetime('now', '+100 years') WHERE username = ?", [username]);

    const user = await queryD1('SELECT id FROM users WHERE username = ?', [username]);
    if (user && user[0]) {
      const activeSessions = await queryD1("SELECT session_key FROM instances WHERE user_id = ? AND status = 'active'", [user[0].id]);
      for (const sess of activeSessions) {
        if (sess.session_key) {
          await redisCmd('SET', `kill:${sess.session_key}`, '1', 'EX', '300');
          await redisCmd('HSET', `session:${sess.session_key}`, 'status', 'stopped');
        }
      }
      await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE user_id = ? AND status = 'active'", [user[0].id]);
    }

    res.json({ status: 'success', msg: `${username} banned from ${service}` });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

// ── POST /admin/set_plan ──
adminRouter.post('/set_plan', asyncHandler(async (req, res) => {
  try {
    const { username, plan } = req.body;
    if (!username || !plan) return res.status(400).json({ status: 'error', msg: 'username and plan required' });

    const planKey = plan.toLowerCase();
    if (!PLANS[planKey]) {
      return res.status(400).json({ status: 'error', msg: `Invalid plan. Must be one of: ${Object.keys(PLANS).join(', ')}` });
    }

    await executeD1('UPDATE users SET plan = ? WHERE username = ?', [planKey, username]);
    res.json({ status: 'success', msg: `${username} upgraded to ${planKey}` });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));
