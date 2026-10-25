// ── Worker Auth Middleware ──
// Runners authenticate with a shared secret, not JWT.
export function requireWorkerAuth(req, res, next) {
  const secret = req.headers['x-worker-secret'] || req.body?.worker_secret;
  const expected = process.env.WORKER_SECRET;
  if (!expected) {
    return res.status(500).json({ status: 'error', msg: 'WORKER_SECRET is not configured on server' });
  }
  if (!secret || secret !== expected) {
    return res.status(403).json({ status: 'error', msg: 'Invalid worker secret' });
  }
  next();
}
