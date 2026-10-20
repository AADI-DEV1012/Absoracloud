// ── Cloudflare D1 HTTP Client ──
// All services use this to query the unified D1 database.

const D1_API = (accountId, dbId) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

export async function queryD1(sql, params = []) {
  const token     = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId      = process.env.D1_DB_ID || process.env.D1_DB_1_ID;

  if (!token || !accountId || !dbId) {
    throw new Error('Missing Cloudflare D1 credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DB_ID)');
  }

  const res = await fetch(D1_API(accountId, dbId), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
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
  const token     = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId      = process.env.D1_DB_ID || process.env.D1_DB_1_ID;

  if (!token || !accountId || !dbId) {
    throw new Error('Missing Cloudflare D1 credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DB_ID)');
  }

  const res = await fetch(D1_API(accountId, dbId), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
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

export async function ensureSchemaMigrations() {
  try {
    // 1. Runners table with last_heartbeat
    await executeD1(
      "CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, type TEXT, service TEXT, capacity INTEGER DEFAULT 1, active_count INTEGER DEFAULT 0, status TEXT DEFAULT 'ready', last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);"
    );

    // 2. Bans table
    await executeD1(
      "CREATE TABLE IF NOT EXISTS bans (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, service TEXT DEFAULT 'all', reason TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);"
    );

    // 3. Ensure runner_id on instances
    const instCols = await queryD1("PRAGMA table_info(instances);");
    if (instCols && !instCols.some(c => c.name === 'runner_id')) {
      await executeD1("ALTER TABLE instances ADD COLUMN runner_id TEXT;");
      console.log('✅ Auto-migration: Added runner_id column to instances table');
    }

    // 4. Ensure provider on cloud_files
    const fileCols = await queryD1("PRAGMA table_info(cloud_files);").catch(() => []);
    if (fileCols && fileCols.length > 0 && !fileCols.some(c => c.name === 'provider')) {
      await executeD1("ALTER TABLE cloud_files ADD COLUMN provider TEXT DEFAULT 'local';");
      console.log('✅ Auto-migration: Added provider column to cloud_files table');
    }
  } catch (err) {
    console.error('❌ Database schema migration error:', err);
    throw err;
  }
}
