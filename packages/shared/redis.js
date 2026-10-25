// ── Upstash Redis HTTP Client ──
// Used for heartbeats, session locks, GPU queue, and quota tracking.

function getRedisConfig() {
  const url   = process.env.UPSTASH_REDIS_URL || process.env.UPSTASH_REDIS_A_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN || process.env.UPSTASH_REDIS_A_TOKEN;

  if (!url || !token) {
    throw new Error('Missing Upstash Redis credentials (UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN)');
  }
  return { url, token };
}

export async function redisCmd(...args) {
  const { url, token } = getRedisConfig();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Redis error: ${data.error}`);
  }

  return data.result;
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
