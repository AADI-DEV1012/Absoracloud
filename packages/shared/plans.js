// ── Plan Definitions & Quota Helpers ──

export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    storage_gb: 5,
    vps_hours_week: 4,
    vps_cpu: 0.5,
    vps_ram_mb: 2048,
    vps_slots: 1,
    devbox_gpu_min: 30,
    webhost_sites: 1,
    file_manager: true,
    priority: 0,
  },
  basic: {
    name: 'Basic',
    price: 99,
    storage_gb: 25,
    vps_hours_week: 10,
    vps_cpu: 1,
    vps_ram_mb: 4096,
    vps_slots: 2,
    devbox_gpu_min: 120,
    webhost_sites: 3,
    file_manager: true,
    priority: 1,
  },
  pro: {
    name: 'Pro',
    price: 299,
    storage_gb: 75,
    vps_hours_week: 20,
    vps_cpu: 2,
    vps_ram_mb: 8192,
    vps_slots: 3,
    devbox_gpu_min: 240,
    webhost_sites: 5,
    file_manager: true,
    priority: 2,
  },
  enterprise: {
    name: 'Enterprise',
    price: 799,
    storage_gb: 200,
    vps_hours_week: 40,
    vps_cpu: 4,
    vps_ram_mb: 16384,
    vps_slots: 4,
    devbox_gpu_min: 480,
    webhost_sites: 10,
    file_manager: true,
    priority: 3,
  },
};

export function getPlan(key) {
  return PLANS[key] || PLANS.free;
}

export function getPlanLimits(planKey, service) {
  const p = getPlan(planKey);
  switch (service) {
    case 'storage': return { storage_gb: p.storage_gb };
    case 'vps':     return { weekly_seconds: p.vps_hours_week * 3600, cpu: p.vps_cpu, ram_mb: p.vps_ram_mb, slots: p.vps_slots };
    case 'devbox':  return { weekly_seconds: p.devbox_gpu_min * 60 };
    case 'webhost': return { max_sites: p.webhost_sites };
    default:        return {};
  }
}

export async function checkQuota(redisCmd, userId, service, planKey) {
  const limits = getPlanLimits(planKey, service);
  const key = `quota:${userId}:${service}`;
  const used = parseInt(await redisCmd('GET', key) || '0', 10);
  const max = limits.weekly_seconds || 0;

  return {
    allowed: used < max,
    used,
    remaining: Math.max(0, max - used),
    max,
  };
}

export async function consumeQuota(redisCmd, userId, service, seconds) {
  const key = `quota:${userId}:${service}`;
  await redisCmd('INCRBY', key, String(seconds));
  // Set TTL to expire at end of week (Sunday midnight UTC)
  const now = new Date();
  const daysUntilSunday = 7 - now.getUTCDay();
  const ttl = daysUntilSunday * 86400 - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds());
  await redisCmd('EXPIRE', key, String(Math.max(ttl, 3600)));
}
