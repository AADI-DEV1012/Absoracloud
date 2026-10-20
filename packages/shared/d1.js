// ── Cloudflare D1 HTTP Client ──
// All services use this to query the unified D1 database.

const D1_API = (accountId, dbId) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

function getCfHeaders(contentType = 'application/json') {
  const email = process.env.CLOUDFLARE_EMAIL;
  const key   = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  const headers = { 'Content-Type': contentType };
  if (email && key) {
    headers['X-Auth-Email'] = email;
    headers['X-Auth-Key']   = key;
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    throw new Error('Missing Cloudflare credentials (CLOUDFLARE_API_TOKEN or CLOUDFLARE_EMAIL + CLOUDFLARE_GLOBAL_API_KEY)');
  }
  return headers;
}

export async function queryD1(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId      = process.env.D1_DB_ID || process.env.D1_DB_1_ID;

  if (!accountId || !dbId) {
    throw new Error('Missing Cloudflare D1 database credentials (CLOUDFLARE_ACCOUNT_ID, D1_DB_ID)');
  }

  const res = await fetch(D1_API(accountId, dbId), {
    method: 'POST',
    headers: getCfHeaders('application/json'),
    body: JSON.stringify({ sql, params }),
  });

  const data = await res.json();
  if (!data.success) {
    console.error('D1 Query Error:', data.errors);
    throw new Error(data.errors?.[0]?.message || 'D1 query failed');
  }

  return data.result[0].results;
}

export async function executeD1(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId      = process.env.D1_DB_ID || process.env.D1_DB_1_ID;

  if (!accountId || !dbId) {
    throw new Error('Missing Cloudflare D1 database credentials (CLOUDFLARE_ACCOUNT_ID, D1_DB_ID)');
  }

  const res = await fetch(D1_API(accountId, dbId), {
    method: 'POST',
    headers: getCfHeaders('application/json'),
    body: JSON.stringify({ sql, params }),
  });

  const data = await res.json();
  if (!data.success) {
    console.error('D1 Execute Error:', data.errors);
    throw new Error(data.errors?.[0]?.message || 'D1 execute failed');
  }

  return data.result[0].meta;
}

export async function d1QueryOne(sql, params = []) {
  const rows = await queryD1(sql, params);
  return rows[0] || null;
}

export async function addColumnIfMissing(table, column, type) {
  try {
    const cols = await queryD1(`PRAGMA table_info(${table});`);
    if (cols && !cols.some(c => c.name === column)) {
      await executeD1(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
      console.log(`✅ Auto-migration: Added ${column} to ${table}`);
    }
  } catch (err) {
    console.error(`❌ Migration error adding column ${column} to ${table}:`, err.message || err);
    throw err;
  }
}

export async function ensureSchemaMigrations() {
  try {
    // 1. Create runners table
    await executeD1(
      "CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, type TEXT, service TEXT, capacity INTEGER DEFAULT 1, active_count INTEGER DEFAULT 0, status TEXT DEFAULT 'ready', last_heartbeat DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);"
    );

    // 2. Add columns if missing
    await addColumnIfMissing('instances', 'runner_id', 'TEXT');
    await addColumnIfMissing('runners', 'last_heartbeat', 'DATETIME');
    await addColumnIfMissing('cloud_files', 'provider', 'TEXT');
    await addColumnIfMissing('cloud_files', 'share_token', 'TEXT');
  } catch (err) {
    console.error('❌ Database schema migration failed:', err.message || err);
    throw err;
  }
}
