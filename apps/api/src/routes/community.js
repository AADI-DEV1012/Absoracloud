// ── Community Routes ──
import { Router } from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { queryD1, executeD1 } from '../../../../packages/shared/d1.js';

export const communityRouter = Router();

communityRouter.get('/tickets', requireAuth, async (req, res) => {
  const tickets = req.user.role === 'admin'
    ? await queryD1('SELECT * FROM tickets ORDER BY created_at DESC LIMIT 50')
    : await queryD1('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [req.user.sub]);
  res.json({ status: 'success', tickets });
});

communityRouter.post('/submit', requireAuth, async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ status: 'error', msg: 'Subject and message required' });
  await executeD1(
    'INSERT INTO tickets (user_id, username, subject, message) VALUES (?, ?, ?, ?)',
    [req.user.sub, req.user.username, subject, message]
  );
  res.json({ status: 'success', msg: 'Ticket submitted' });
});

communityRouter.post('/reply', requireAuth, async (req, res) => {
  const { ticket_id, message } = req.body;
  if (!ticket_id || !message) return res.status(400).json({ status: 'error', msg: 'ticket_id and message required' });
  await executeD1(
    'INSERT INTO ticket_replies (ticket_id, author, is_staff, message) VALUES (?, ?, ?, ?)',
    [ticket_id, req.user.username, req.user.role === 'admin' ? 1 : 0, message]
  );
  res.json({ status: 'success', msg: 'Reply posted' });
});
