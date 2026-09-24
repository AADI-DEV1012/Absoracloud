// ── Rate Limiting / Abuse Guard ──
import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minute
  max: 60,                 // 60 requests per minute per IP
  message: { status: 'error', msg: 'Too many requests. Slow down.' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,                   // 15 login/register attempts
  message: { status: 'error', msg: 'Too many auth attempts. Try again later.' },
});

export const launchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { status: 'error', msg: 'Too many launch requests. Wait a moment.' },
});
