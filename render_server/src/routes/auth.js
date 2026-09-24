// ── Auth Routes ──
// POST /auth/login, /auth/register, /auth/logout, GET /auth/me

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { queryD1, executeD1, d1QueryOne } from '../shared/d1.js';
import { signToken }                      from '../shared/jwt.js';
import { requireAuth }                    from '../middleware/auth.js';
import { authLimiter }                    from '../middleware/abuse_guard.js';

export const authRouter = Router();

// ── Register ──
authRouter.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ status: 'error', msg: 'All fields required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ status: 'error', msg: 'Password must be at least 6 characters' });
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ status: 'error', msg: 'Username: 3-20 chars, letters/numbers/underscores only' });
    }

    // Check if exists
    const existing = await d1QueryOne(
      'SELECT id FROM users WHERE username = ? OR email = ?', [username, email]
    );
    if (existing) {
      return res.status(409).json({ status: 'error', msg: 'Username or email already registered' });
    }

    const hash = bcrypt.hashSync(password, 10);
    await executeD1(
      'INSERT INTO users (username, email, password, password_hash) VALUES (?, ?, ?, ?)',
      [username, email, hash, hash]
    );

    const user = await d1QueryOne('SELECT * FROM users WHERE username = ?', [username]);
    const token = signToken({
      sub: user.id, username: user.username, plan: user.plan, role: user.role,
    });

    res.json({ status: 'success', token, user: { id: user.id, username: user.username, plan: user.plan, role: user.role } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ status: 'error', msg: 'Registration failed' });
  }
});

// ── Login ──
authRouter.post('/login', authLimiter, async (req, res) => {
  try {
    const login = req.body.login || req.body.username || req.body.email;
    const password = req.body.password;
    if (!login || !password) {
      return res.status(400).json({ status: 'error', msg: 'Username/email and password required' });
    }

    const user = await d1QueryOne(
      'SELECT * FROM users WHERE username = ? OR email = ?', [login, login]
    );
    const hashMatches = user.password_hash && bcrypt.compareSync(password, user.password_hash);
    const legacyMatches = user.password && (user.password === password || bcrypt.compareSync(password, user.password));
    if (!user || (!hashMatches && !legacyMatches)) {
      return res.status(401).json({ status: 'error', msg: 'Invalid credentials' });
    }

    // Check if locked
    if (parseInt(user.locked_until || 0) > Math.floor(Date.now() / 1000)) {
      return res.status(403).json({ status: 'error', msg: 'Account temporarily locked' });
    }

    const token = signToken({
      sub: user.id, username: user.username, plan: user.plan, role: user.role,
    });

    res.json({ status: 'success', token, user: { id: user.id, username: user.username, plan: user.plan, role: user.role } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ status: 'error', msg: 'Login failed' });
  }
});

// ── Me (token validation) ──
authRouter.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await d1QueryOne('SELECT id, username, plan, role FROM users WHERE id = ?', [req.user.sub]);
    if (!user) return res.status(404).json({ status: 'error', msg: 'User not found' });
    res.json({ status: 'success', user });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch user' });
  }
});

// ── Logout (client-side token discard, optional server-side) ──
authRouter.post('/logout', (req, res) => {
  res.json({ status: 'success', msg: 'Logged out' });
});
