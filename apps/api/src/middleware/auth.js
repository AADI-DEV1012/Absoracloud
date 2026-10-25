// ── Auth Middleware ──
// Extracts and verifies JWT from Authorization header.
// Attaches live req.user = { sub, username, plan, role }

import { verifyToken } from '../../../../packages/shared/jwt.js';
import { queryD1 } from '../../../../packages/shared/d1.js';
import { redisCmd } from '../../../../packages/shared/redis.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ status: 'error', msg: 'Not authenticated' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ status: 'error', msg: 'Invalid or expired token' });
  }

  req.user = payload;
  req.user.id = payload.sub || payload.id;

  // Check ban / live state from Redis cache or D1
  try {
    const userId = req.user.id;
    const isBanned = await redisCmd('GET', `ban:${userId}`);
    if (isBanned) {
      return res.status(403).json({ status: 'error', msg: 'Account has been suspended' });
    }

    // Refresh live plan/role from cache or D1
    const cachedPlan = await redisCmd('HGET', `user:${userId}:profile`, 'plan');
    const cachedRole = await redisCmd('HGET', `user:${userId}:profile`, 'role');
    if (cachedPlan) {
      req.user.plan = cachedPlan;
      if (cachedRole) req.user.role = cachedRole;
    } else {
      const userRows = await queryD1('SELECT plan, role, locked_until FROM users WHERE id = ?', [userId]).catch(() => []);
      if (userRows && userRows[0]) {
        const u = userRows[0];
        if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
          return res.status(403).json({ status: 'error', msg: 'Account is temporarily locked' });
        }
        if (u.plan) req.user.plan = u.plan;
        if (u.role) req.user.role = u.role;
        await redisCmd('HSET', `user:${userId}:profile`, 'plan', u.plan, 'role', u.role);
        await redisCmd('EXPIRE', `user:${userId}:profile`, '60'); // 1-minute live cache
      }
    }
  } catch (_) {}

  next();
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');
  if (token) {
    req.user = verifyToken(token);
    if (req.user) req.user.id = req.user.sub || req.user.id;
  }
  next();
}
