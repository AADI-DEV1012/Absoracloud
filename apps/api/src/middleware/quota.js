// ── Quota Enforcement Middleware ──
import { checkQuota }       from '../../../../packages/shared/plans.js';
import { redisCmd }         from '../../../../packages/shared/redis.js';

// Factory: returns middleware that checks quota for a specific service.
export function requireQuota(service) {
  return async (req, res, next) => {
    try {
      const runtime = (req.body?.runtime || 'gpu').toLowerCase();
      const quota = await checkQuota(redisCmd, req.user.sub, service, req.user.plan, runtime);
      if (!quota.allowed) {
        return res.status(403).json({
          status: 'error',
          msg: quota.msg || `Weekly ${service} quota exhausted. Upgrade your plan for more time.`,
          used: quota.used,
          max: quota.max,
        });
      }
      req.quota = quota;
      next();
    } catch (e) {
      console.error('Quota check error:', e);
      next(); // fail open — don't block users on Redis errors
    }
  };
}
