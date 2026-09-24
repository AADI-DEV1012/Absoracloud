// ── Admin Routes ──
import { Router } from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin_auth.js';
import { queryD1, executeD1 } from '../../../packages/shared/d1.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/users', async (req, res) => {
  const users = await queryD1('SELECT id, username, email, plan, role, created_at, locked_until FROM users ORDER BY id DESC LIMIT 100');
  res.json({ status: 'success', users });
});

adminRouter.get('/runners', async (req, res) => {
  const runners = await queryD1('SELECT * FROM runners ORDER BY started_at DESC');
  res.json({ status: 'success', runners });
});

adminRouter.get('/stats', async (req, res) => {
  const [users, instances, runners] = await Promise.all([
    queryD1('SELECT COUNT(*) as cnt FROM users'),
    queryD1("SELECT service, status, COUNT(*) as cnt FROM instances GROUP BY service, status"),
    queryD1('SELECT COUNT(*) as cnt FROM runners WHERE status = \'ready\''),
  ]);
  res.json({ status: 'success', total_users: users[0].cnt, instances, active_runners: runners[0].cnt });
});

adminRouter.post('/ban', async (req, res) => {
  const { username, service = 'all', reason = '' } = req.body;
  if (!username) return res.status(400).json({ status: 'error', msg: 'Username required' });
  await executeD1('INSERT INTO bans (username, service, reason) VALUES (?, ?, ?)', [username, service, reason]);
  res.json({ status: 'success', msg: `${username} banned from ${service}` });
});

adminRouter.post('/set_plan', async (req, res) => {
  const { username, plan } = req.body;
  if (!username || !plan) return res.status(400).json({ status: 'error', msg: 'username and plan required' });
  await executeD1('UPDATE users SET plan = ? WHERE username = ?', [plan, username]);
  res.json({ status: 'success', msg: `${username} upgraded to ${plan}` });
});
