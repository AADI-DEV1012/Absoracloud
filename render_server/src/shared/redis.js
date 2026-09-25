// ── Upstash Redis HTTP Client ──
// Dual-shard support: Redis A = primary, Redis B = failover.
// Used for heartbeats, session locks, GPU queue, and quota tracking.

function getRedisConfig() {
  // Try primary (A) first, fallback to B
  let url   = process.env.UPSTASH_REDIS_URL   || process.env.UPSTASH_REDIS_A_URL;
  let token = process.env.UPSTASH_REDIS_TOKEN || process.env.UPSTASH_REDIS_A_TOKEN;

  if (!url || !token) {
    url   = process.env.UPSTASH_REDIS_B_URL;
    token = process.env.UPSTASH_REDIS_B_TOKEN;
  }

  if (!url || !token) {
    throw new Error('Missing Upstash Redis credentials (UPSTASH_REDIS_A_URL/TOKEN or UPSTASH_REDIS_B_URL/TOKEN)');
  }

  return { url, token };
}

export async function redisCmd(...args) {
  const { url, token } = getRedisConfig();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    const data = await res.json();
    if (data.error) {
      console.warn(`Redis error: ${data.error}`);
      return null;
    }

    return data.result;
  } catch (e) {
    // Graceful degradation: Redis unavailable
    console.warn(`Redis unavailable: ${e.message}`);
    return null;
  }
}

export function redisParseHash(flatArr) {
  if (!Array.isArray(flatArr)) return {};
  const obj = {};
  for (let i = 0; i < flatArr.length; i += 2) {
    obj[flatArr[i]] = flatArr[i + 1];
  }
  return obj;
}

export async function redisPipeline(commands) {
  const { url, token } = getRedisConfig();

  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  const data = await res.json();
  return data;
}

// ── Health check ──
export async function checkRedisHealth() {
  try {
    const result = await redisCmd('PING');
    if (result === null) {
      return { status: 'offline', error: 'Redis unreachable (DNS or connection failed)' };
    }
    return { status: 'online', response: result };
  } catch (e) {
    return { status: 'offline', error: e.message };
  }
}
