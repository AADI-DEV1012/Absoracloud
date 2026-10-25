// ── Admin Auth Middleware ──
import { verifyToken } from '../../../../packages/shared/jwt.js';

export const ADMIN_USERNAME = 'absoracloud';
export const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET || '@ZH%j|Bc=!8-?[tB';

export function requireAdmin(req, res, next) {
  const headerKey = req.headers['x-admin-key'] || req.headers['x-admin-secret'];
  const headerUser = req.headers['x-admin-user'] || req.headers['x-admin-username'];

  // Check 1: Direct secret key match in header
  if (headerKey && (headerKey === ADMIN_SECRET_KEY || headerKey === process.env.WORKER_SECRET)) {
    if (!headerUser || headerUser.toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
      req.user = { id: 0, sub: 'admin', username: ADMIN_USERNAME, role: 'admin' };
      return next();
    }
  }

  // Check 2: Bearer JWT token issued specifically for absoracloud admin
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (token) {
    const payload = verifyToken(token);
    if (
      payload &&
      payload.role === 'admin' &&
      payload.username &&
      payload.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
    ) {
      req.user = payload;
      return next();
    }
  }

  // Check 3: Live user token with role === 'admin' and username === 'absoracloud'
  if (
    req.user &&
    req.user.role === 'admin' &&
    req.user.username &&
    req.user.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
  ) {
    return next();
  }

  return res.status(403).json({
    status: 'error',
    msg: 'Access Denied: Admin Plane requires username absoracloud and valid secret key.'
  });
}
