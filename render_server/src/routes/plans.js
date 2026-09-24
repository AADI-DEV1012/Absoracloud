// ── Plans Routes ──
import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { PLANS }     from '../../../packages/shared/plans.js';
import { redisCmd }  from '../../../packages/shared/redis.js';

export const plansRouter = Router();

plansRouter.get('/', optionalAuth, (req, res) => {
  res.json({ status: 'success', plans: PLANS });
});

plansRouter.get('/usage', requireAuth, async (req, res) => {
  try {
    const uid = req.user.sub;
    const [mc, vps, gpu] = await Promise.all([
      redisCmd('GET', `quota:${uid}:mc`),
      redisCmd('GET', `quota:${uid}:vps`),
      redisCmd('GET', `quota:${uid}:devbox`),
    ]);
    res.json({ status: 'success', usage: { mc: parseInt(mc || '0'), vps: parseInt(vps || '0'), devbox: parseInt(gpu || '0') } });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch usage' });
  }
});
