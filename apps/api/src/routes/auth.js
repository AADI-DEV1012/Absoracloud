// ── Auth Routes ──
// POST /auth/login, /auth/register, /auth/logout, GET /auth/me

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { queryD1, executeD1, d1QueryOne } from '../../../../packages/shared/d1.js';
import { signToken }                      from '../../../../packages/shared/jwt.js';
import { requireAuth }                    from '../middleware/auth.js';
import { authLimiter }                    from '../middleware/abuse_guard.js';
import { getPlan }                        from '../../../../packages/shared/plans.js';
import { redisCmd }                       from '../../../../packages/shared/redis.js';

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
    if (!user) {
      return res.status(401).json({ status: 'error', msg: 'Invalid credentials' });
    }
    const hashMatches   = user.password_hash && bcrypt.compareSync(password, user.password_hash);
    const legacyMatches = user.password && (user.password === password || bcrypt.compareSync(password, user.password));
    if (!hashMatches && !legacyMatches) {
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

// ── Me (token validation & real live quotas) ──
authRouter.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await d1QueryOne('SELECT id, username, plan, role FROM users WHERE id = ?', [req.user.sub]);
    if (!user) return res.status(404).json({ status: 'error', msg: 'User not found' });

    const plan = getPlan(user.plan || 'free');
    const [vps, devbox, devboxGpu, serverless, webhost, storageRows] = await Promise.all([
      redisCmd('GET', `quota:${user.id}:vps`).catch(() => '0'),
      redisCmd('GET', `quota:${user.id}:devbox`).catch(() => '0'),
      redisCmd('GET', `quota:${user.id}:devbox_gpu`).catch(() => '0'),
      queryD1("SELECT COUNT(*) as cnt FROM instances WHERE user_id = ? AND service = 'serverless' AND status != 'dismissed'", [user.id]).catch(() => [{ cnt: 0 }]),
      queryD1("SELECT COUNT(*) as cnt FROM instances WHERE user_id = ? AND service = 'webhost' AND status != 'dismissed'", [user.id]).catch(() => [{ cnt: 0 }]),
      queryD1("SELECT COALESCE(SUM(file_size), 0) as total_bytes, COUNT(*) as cnt FROM cloud_files WHERE user_id = ?", [user.id]).catch(() => [{ total_bytes: 0, cnt: 0 }])
    ]);

    const vpsSec = parseInt(vps || '0', 10);
    const devboxSec = parseInt(devbox || '0', 10);
    const devboxGpuSec = parseInt(devboxGpu || '0', 10);
    const srvCount = serverless?.[0]?.cnt || 0;
    const webCount = webhost?.[0]?.cnt || 0;
    const storeBytes = storageRows?.[0]?.total_bytes || 0;
    const storeCount = storageRows?.[0]?.cnt || 0;

    const totalStorageBytes = plan.storage_gb * 1024 * 1024 * 1024;
    const usableStorageBytes = totalStorageBytes;

    const quotas = {
      plan: user.plan || 'free',
      plan_name: plan.name,
      vps: {
        used_seconds: vpsSec,
        max_seconds: plan.vps_hours_week * 3600,
        hours_used: (vpsSec / 3600).toFixed(1),
        hours_max: plan.vps_hours_week,
        percent: Math.min(100, Math.round((vpsSec / (plan.vps_hours_week * 3600)) * 100))
      },
      devbox: {
        gpu_allowed: !!plan.gpu_allowed,
        gpu_hours_max: plan.gpu_hours || 0,
        gpu_used_seconds: devboxGpuSec,
        gpu_max_seconds: (plan.devbox_gpu_min || 0) * 60,
        gpu_minutes_used: Math.round(devboxGpuSec / 60),
        gpu_minutes_max: plan.devbox_gpu_min || 0,
        percent: plan.devbox_gpu_min > 0 
          ? Math.min(100, Math.round((devboxGpuSec / (plan.devbox_gpu_min * 60)) * 100))
          : 0,
        used_seconds: devboxSec,
        cpu_minutes_max: plan.devbox_cpu_min || 60,
      },
      serverless: {
        used_count: srvCount,
        max_count: plan.serverless_functions,
        percent: Math.min(100, Math.round((srvCount / plan.serverless_functions) * 100))
      },
      webhost: {
        used_count: webCount,
        max_count: plan.webhost_sites,
        percent: Math.min(100, Math.round((webCount / plan.webhost_sites) * 100))
      },
      storage: {
        used_bytes: storeBytes,
        usable_bytes: usableStorageBytes,
        max_bytes: usableStorageBytes,
        total_disk_bytes: totalStorageBytes,
        reserved_logs_mb: 0,
        used_mb: (storeBytes / (1024 * 1024)).toFixed(2),
        usable_gb: plan.storage_gb.toFixed(2),
        max_gb: plan.storage_gb,
        file_count: storeCount,
        percent: Math.min(100, Math.round((storeBytes / Math.max(1, usableStorageBytes)) * 100))
      }
    };

    let maintenance = null;
    let announcement = null;
    try {
      const [maintRaw, annRaw] = await Promise.all([
        redisCmd('GET', 'platform:maintenance').catch(() => null),
        redisCmd('GET', 'platform:announcement').catch(() => null)
      ]);
      if (maintRaw) {
        const parsed = JSON.parse(maintRaw);
        if (parsed?.enabled) maintenance = parsed;
      }
      if (annRaw) {
        announcement = JSON.parse(annRaw);
      }
    } catch (_) {}

    res.json({ status: 'success', user, quotas, maintenance, announcement });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch user' });
  }
});

// ── Logout (client-side token discard, optional server-side) ──
authRouter.post('/logout', (req, res) => {
  res.json({ status: 'success', msg: 'Logged out' });
});
