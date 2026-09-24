// ── Auth Middleware ──
// Extracts and verifies JWT from Authorization header.
// Attaches req.user = { sub, username, plan, role }

import { verifyToken } from '../../../packages/shared/jwt.js';

export function requireAuth(req, res, next) {
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
  next();
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');
  if (token) {
    req.user = verifyToken(token);
  }
  next();
}
