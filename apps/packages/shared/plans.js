// ── Plan Definitions & Quota Helpers ──
// V3 Architecture:
//   VPS      → Kaggle CPU notebooks
//   DevBox   → Kaggle GPU notebooks (T4×2)
//   WebHost  → Cloudflare Workers
//   Serverless → Cloudflare Workers functions

export const PLANS = {
  free: {
    name: 'Free',
    price: 0,
    // Storage: 5 GB total with 200 MB reserved for system runtime logs
    storage_gb: 5,
    logs_reserved_mb: 200,
    // VPS
    vps_hours_week: 4,
    vps_cpu: 0.5,
    vps_ram_mb: 2048,
    vps_slots: 1,
    // DevBox: Free plan has NO GPU, standard CPU only
    gpu_allowed: false,
    gpu_hours: 0,
    devbox_gpu_min: 0,
    devbox_cpu_min: 60,
    // Web Hosting
    webhost_sites: 1,
    // Serverless Functions
    serverless_functions: 1,
    serverless_code_limit_kb: 128,
    // Features
    file_manager: true,
    priority: 0,
  },
  basic: {
    name: 'Basic',
    price: 99,
    storage_gb: 25,
    logs_reserved_mb: 200,
    vps_hours_week: 10,
    vps_cpu: 1,
    vps_ram_mb: 4096,
    vps_slots: 2,
    // DevBox: Strict 1 hour GPU limit
    gpu_allowed: true,
    gpu_hours: 1,
    devbox_gpu_min: 60,
    devbox_cpu_min: 180,
    webhost_sites: 3,
    serverless_functions: 5,
    serverless_code_limit_kb: 512,
    file_manager: true,
    priority: 1,
  },
  pro: {
    name: 'Pro',
    price: 299,
    storage_gb: 75,
    logs_reserved_mb: 200,
    vps_hours_week: 20,
    vps_cpu: 2,
    vps_ram_mb: 8192,
    vps_slots: 3,
    // DevBox: Strict 3 hours GPU limit
    gpu_allowed: true,
    gpu_hours: 3,
    devbox_gpu_min: 180,
    devbox_cpu_min: 360,
    webhost_sites: 5,
    serverless_functions: 15,
    serverless_code_limit_kb: 1024,
    file_manager: true,
    priority: 2,
  },
  enterprise: {
    name: 'Enterprise',
    price: 799,
    storage_gb: 200,
    logs_reserved_mb: 200,
    vps_hours_week: 40,
    vps_cpu: 4,
    vps_ram_mb: 16384,
    vps_slots: 4,
    // DevBox: Strict 5 hours GPU limit
    gpu_allowed: true,
    gpu_hours: 5,
    devbox_gpu_min: 300,
    devbox_cpu_min: 720,
    webhost_sites: 10,
    serverless_functions: 50,
    serverless_code_limit_kb: 4096,
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
    case 'storage': return { 
      storage_gb: p.storage_gb,
      logs_reserved_mb: p.logs_reserved_mb || 200,
      usable_storage_mb: (p.storage_gb * 1024) - (p.logs_reserved_mb || 200),
      usable_storage_bytes: ((p.storage_gb * 1024) - (p.logs_reserved_mb || 200)) * 1024 * 1024
    };
    case 'vps': return { 
      weekly_seconds: p.vps_hours_week * 3600, 
      cpu: p.vps_cpu, 
      ram_mb: p.vps_ram_mb, 
      slots: p.vps_slots 
    };
    case 'devbox': return { 
      weekly_seconds: (p.devbox_gpu_min || 0) * 60,
      gpu_allowed: !!p.gpu_allowed,
      gpu_hours: p.gpu_hours || 0,
      devbox_gpu_min: p.devbox_gpu_min || 0,
      devbox_cpu_min: p.devbox_cpu_min || 60
    };
    case 'webhost': return { max_sites: p.webhost_sites };
    case 'serverless': return { max_functions: p.serverless_functions, code_limit_kb: p.serverless_code_limit_kb };
    default: return {};
  }
}

export async function checkQuota(redisCmd, userId, service, planKey, runtime = 'gpu') {
  const p = getPlan(planKey);
  if (service === 'devbox') {
    if (runtime === 'gpu') {
      if (!p.gpu_allowed || (p.gpu_hours || 0) <= 0) {
        return {
          allowed: false,
          used: 0,
          max: 0,
          msg: 'GPU compute is exclusive to paid plans with strict limits: Basic (1h), Pro (3h), Enterprise (5h). Upgrade your plan or switch to standard CPU.'
        };
      }
      const maxSeconds = (p.devbox_gpu_min || p.gpu_hours * 60) * 60;
      const key = `quota:${userId}:devbox_gpu`;
      const used = parseInt(await redisCmd('GET', key) || '0', 10);
      return {
        allowed: used < maxSeconds,
        used,
        remaining: Math.max(0, maxSeconds - used),
        max: maxSeconds,
        msg: `Strict GPU limit reached (${p.gpu_hours}h for ${p.name} plan). Upgrade your plan or switch to standard CPU.`
      };
    } else {
      const maxSeconds = (p.devbox_cpu_min || 60) * 60;
      const key = `quota:${userId}:devbox_cpu`;
      const used = parseInt(await redisCmd('GET', key) || '0', 10);
      return {
        allowed: used < maxSeconds,
        used,
        remaining: Math.max(0, maxSeconds - used),
        max: maxSeconds,
        msg: `DevBox CPU quota reached for your plan.`
      };
    }
  }

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
  // TTL expires at end of week (Sunday midnight UTC)
  const now = new Date();
  const daysUntilSun = 7 - now.getUTCDay();
  const ttl = daysUntilSun * 86400 - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds());
  await redisCmd('EXPIRE', key, String(Math.max(ttl, 3600)));
}
