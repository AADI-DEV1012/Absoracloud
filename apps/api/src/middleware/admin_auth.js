// ── Admin Auth Middleware ──
export function requireAdmin(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET || process.env.WORKER_SECRET;
  const headerKey = req.headers['x-admin-key'] || req.headers['x-admin-secret'];
  
  if (headerKey && adminSecret && headerKey === adminSecret) {
    return next();
  }

  const userId = req.user?.id || req.user?.sub;
  if (req.user && (req.user.role === 'admin' || userId === 1 || String(userId) === '1')) {
    return next();
  }
  return res.status(403).json({ status: 'error', msg: 'Admin access required' });
}
