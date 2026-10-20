// ── Admin Routes ──
import { Router } from 'express';
import { requireAuth }   from '../middleware/auth.js';
import { requireAdmin }  from '../middleware/admin_auth.js';
import { asyncHandler }  from '../middleware/async_handler.js';
import { queryD1, executeD1 } from '../../../../packages/shared/d1.js';
import { redisCmd }           from '../../../../packages/shared/redis.js';
import { PLANS }              from '../../../../packages/shared/plans.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/users', asyncHandler(async (req, res) => {
  try {
    const users = await queryD1('SELECT id, username, email, plan, role, created_at, locked_until FROM users ORDER BY id DESC LIMIT 100');
    res.json({ status: 'success', users });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

adminRouter.get('/runners', asyncHandler(async (req, res) => {
  try {
    const runners = await queryD1('SELECT * FROM runners ORDER BY created_at DESC');
    res.json({ status: 'success', runners });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

adminRouter.get('/stats', asyncHandler(async (req, res) => {
  try {
    const [users, instances, runners] = await Promise.all([
      queryD1('SELECT COUNT(*) as cnt FROM users'),
      queryD1("SELECT service, status, COUNT(*) as cnt FROM instances GROUP BY service, status"),
      queryD1("SELECT COUNT(*) as cnt FROM runners WHERE status = 'ready'"),
    ]);
    res.json({ status: 'success', total_users: users[0]?.cnt || 0, instances, active_runners: runners[0]?.cnt || 0 });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
}));

adminRouter.post('/ban', asyncHandler(async (req, res) => {
  try {
    const { username, service = 'all', reason = '' } = req.body;
    if (!username) return res.status(400).json({ status: 'error', msg: 'Username required' });

    await executeD1('INSERT INTO bans (username, service, reason) VALUES (?, ?, ?)', [username, service, reason]);
    await executeD1("UPDATE users SET locked_until = datetime('now', '+100 years') WHERE username = ?", [username]);

    // Terminate any active sessions for this user
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
