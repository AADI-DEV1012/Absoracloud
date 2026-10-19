// ── Plans Routes ──
import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { PLANS }     from '../../../../packages/shared/plans.js';
import { redisCmd }  from '../../../../packages/shared/redis.js';

export const plansRouter = Router();

plansRouter.get('/', optionalAuth, (req, res) => {
  res.json({ status: 'success', plans: PLANS });
});

plansRouter.get('/usage', requireAuth, async (req, res) => {
  try {
    const uid = req.user.sub || req.user.id;
    const [vps, gpu, serverless] = await Promise.all([
      redisCmd('GET', `quota:${uid}:vps`),
      redisCmd('GET', `quota:${uid}:devbox`),
      redisCmd('GET', `quota:${uid}:serverless`),
    ]);
    res.json({
      status: 'success',
      usage: {
        vps: parseInt(vps || '0', 10),
        devbox: parseInt(gpu || '0', 10),
        serverless: parseInt(serverless || '0', 10),
      },
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch usage' });
  }
});

plansRouter.get('/quotas', requireAuth, async (req, res) => {
  try {
    const uid = req.user.sub || req.user.id;
    const planKey = req.user.plan || 'free';
    const plan = PLANS[planKey] || PLANS.free;
    const [vps, devbox, serverless] = await Promise.all([
      redisCmd('GET', `quota:${uid}:vps`),
      redisCmd('GET', `quota:${uid}:devbox`),
      redisCmd('GET', `quota:${uid}:serverless`),
    ]);
    res.json({
      status: 'success',
      plan: planKey,
      plan_details: plan,
      usage: {
        vps_seconds: parseInt(vps || '0', 10),
        vps_max_seconds: plan.vps_hours_week * 3600,
        devbox_seconds: parseInt(devbox || '0', 10),
        devbox_max_seconds: plan.devbox_gpu_min * 60,
        serverless_count: parseInt(serverless || '0', 10),
        serverless_max: plan.serverless_functions,
      },
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch quotas' });
  }
});

