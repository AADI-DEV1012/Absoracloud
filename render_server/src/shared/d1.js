// ── Cloudflare D1 HTTP Client ──
// Supports 3 database shards for redundancy and load balancing.
// 
// STRATEGY:
// - Writes: replicate to ALL shards (primary first, then async replicas)
// - Consistent reads (queryD1Primary / d1QueryOne): ALWAYS from primary (DB_1)
//   → Used by auth, user lookups, and anything needing latest data
// - Load-balanced reads (queryD1): round-robin across shards
//   → Used for analytics, listing, non-critical reads

const D1_API = (accountId, dbId) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

// ── Shard Manager ──
let _shardIndex = 0;

function getShards() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token     = process.env.CLOUDFLARE_API_TOKEN;

  if (!token || !accountId) {
    throw new Error('Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID');
  }

  const ids = [
    process.env.D1_DB_1_ID,
    process.env.D1_DB_2_ID,
    process.env.D1_DB_3_ID,
  ].filter(Boolean);

  if (ids.length === 0) {
    throw new Error('No D1 database IDs configured (D1_DB_1_ID, D1_DB_2_ID, D1_DB_3_ID)');
  }

  return ids.map(id => ({
    url: D1_API(accountId, id),
    id,
    token,
  }));
}

function getPrimary() {
  return getShards()[0];
}

function getNextShard() {
  const shards = getShards();
  const shard = shards[_shardIndex % shards.length];
  _shardIndex = (_shardIndex + 1) % shards.length;
  return shard;
}

// ── Core D1 Request ──
async function d1Request(shard, sql, params) {
  const res = await fetch(shard.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${shard.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  const data = await res.json();
  if (!data.success) {
    console.error(`D1 Error [${shard.id.slice(0,8)}]:`, data.errors);
    throw new Error(data.errors?.[0]?.message || 'D1 query failed');
  }

  return data.result[0];
}

// ── Read (primary only): consistent reads for auth, user data ──
// Use this for anything that MUST return the latest written data.
export async function queryD1(sql, params = []) {
  const shard = getPrimary();
  const result = await d1Request(shard, sql, params);
  return result.results;
}

// ── Read (load-balanced): round-robin across shards ──
// Use for listing, analytics, non-critical reads where eventual consistency is OK.
export async function queryD1Balanced(sql, params = []) {
  const shard = getNextShard();
  const result = await d1Request(shard, sql, params);
  return result.results;
}

// ── Write: replicate across ALL shards for consistency ──
export async function executeD1(sql, params = []) {
  const shards = getShards();

  // Execute on primary (first shard) — this is the source of truth
  const primary = shards[0];
  const result = await d1Request(primary, sql, params);

  // Replicate to remaining shards (fire-and-forget, log errors)
  if (shards.length > 1) {
    const replicas = shards.slice(1);
    Promise.allSettled(
      replicas.map(shard =>
        d1Request(shard, sql, params).catch(e =>
          console.warn(`D1 Replica write failed [${shard.id.slice(0,8)}]:`, e.message)
        )
      )
    );
  }

  return result.meta;
}

// ── Read single row (always primary for consistency) ──
export async function d1QueryOne(sql, params = []) {
  const rows = await queryD1(sql, params);
  return rows[0] || null;
}

// ── Health check: verify all shards respond ──
export async function checkD1Health() {
  const shards = getShards();
  const results = await Promise.allSettled(
    shards.map(async (shard) => {
      const result = await d1Request(shard, "SELECT 1 as ok", []);
      return { id: shard.id, ok: result.results[0]?.ok === 1 };
    })
  );

  return results.map((r, i) => ({
    db: `DB_${i + 1}`,
    id: shards[i].id.slice(0, 8),
    status: r.status === 'fulfilled' ? 'online' : 'offline',
    error: r.status === 'rejected' ? r.reason?.message : null,
  }));
}
