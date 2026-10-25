// ── Global Error Handler ──
import { recordServerError } from '../services/error_tracker.js';

export function errorHandler(err, req, res, _next) {
  console.error('Unhandled error:', err);
  recordServerError(err, { path: req?.originalUrl || req?.url, method: req?.method, status: 500 });
  res.status(500).json({ status: 'error', msg: 'Internal server error' });
}
