// ── Cloudflare D1 HTTP Client ──
// All services use this to query the unified D1 database.

const D1_API = (accountId, dbId) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

export async function queryD1(sql, params = []) {
  const token     = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId      = process.env.D1_DB_ID;

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
  const dbId      = process.env.D1_DB_ID;

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
