// ── Global Error Handler ──
export function errorHandler(err, req, res, _next) {
  console.error('Unhandled error:', err);
  res.status(500).json({ status: 'error', msg: 'Internal server error' });
}
