// ── Worker Auth Middleware ──
// Runners authenticate with a shared secret, not JWT.
export function requireWorkerAuth(req, res, next) {
  const secret = req.headers['x-worker-secret'] || req.body?.worker_secret;
  if (!secret || secret !== process.env.WORKER_SECRET) {
    return res.status(403).json({ status: 'error', msg: 'Invalid worker secret' });
  }
  next();
}
