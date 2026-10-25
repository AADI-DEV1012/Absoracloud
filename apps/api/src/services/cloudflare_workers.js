// ── Cloudflare Workers Deployment Service ──
// Powers both: User Web Hosting and Serverless Functions.
// Deploys and manages Cloudflare Workers on behalf of AbsoraCloud users.

function getCfApi() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID in environment');
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
}

function cfHeaders(contentType = 'application/json') {
  const email = process.env.CLOUDFLARE_EMAIL;
  const key   = process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;

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

let cachedSubdomain = process.env.CF_WORKERS_SUBDOMAIN || null;

/**
 * Gets real workers.dev subdomain for the account.
 */
export async function getWorkersSubdomain() {
  if (cachedSubdomain && cachedSubdomain !== 'absoracloud') return cachedSubdomain;
  try {
    const res = await fetch(`${getCfApi()}/workers/subdomain`, {
      headers: cfHeaders('application/json'),
    });
    const data = await res.json();
    if (data.success && data.result?.subdomain) {
      cachedSubdomain = data.result.subdomain;
      return cachedSubdomain;
    }
  } catch (e) {
    console.warn('Could not query workers.dev subdomain:', e.message);
  }
  return process.env.CF_WORKERS_SUBDOMAIN || 'aadibabaji12345';
}

/**
 * Enables the workers.dev subdomain route for a script.
 */
export async function enableWorkerSubdomain(workerName) {
  try {
    const res = await fetch(`${getCfApi()}/workers/scripts/${workerName}/subdomain`, {
      method: 'POST',
      headers: cfHeaders('application/json'),
      body: JSON.stringify({ enabled: true }),
    });
    const data = await res.json();
    return data.success;
  } catch (e) {
    console.warn(`Failed to enable subdomain route for ${workerName}:`, e.message);
    return false;
  }
}

/**
 * Uploads a Worker script supporting both ES Module and Service Worker formats.
 */
async function uploadWorkerScript(workerName, scriptText) {
  const isModule = scriptText.includes('export default') || scriptText.includes('export const');

  if (isModule) {
    const formData = new FormData();
    const metadata = {
      main_module: 'worker.js',
      compatibility_date: '2024-09-23',
    };
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata');
    formData.append('worker.js', new Blob([scriptText], { type: 'application/javascript+module' }), 'worker.js');

    const headers = cfHeaders(null);
    const res = await fetch(`${getCfApi()}/workers/scripts/${workerName}`, {
      method: 'PUT',
      headers,
      body: formData,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`CF Worker module deploy failed (${res.status}): ${err}`);
    }
    return await res.json();
  } else {
    const headers = cfHeaders('application/javascript');
    const res = await fetch(`${getCfApi()}/workers/scripts/${workerName}`, {
      method: 'PUT',
      headers,
      body: scriptText,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`CF Worker deploy failed (${res.status}): ${err}`);
    }
    return await res.json();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEB HOSTING — Deploy a static or Node.js site as a Cloudflare Worker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates or updates a Cloudflare Worker script for web hosting.
 */
export async function deployWebsite({ siteName, repoUrl, sessionKey, userId, plan }) {
  const workerName = `absohost-${siteName}`;
  const script = buildWebsiteWorkerScript({ siteName, repoUrl, userId, plan });

  const data = await uploadWorkerScript(workerName, script);

  // Enable the workers.dev subdomain route
  await enableWorkerSubdomain(workerName);

  const subdomain = await getWorkersSubdomain();
  const publicUrl = `https://${workerName}.${subdomain}.workers.dev`;

  return { workerName, publicUrl, data };
}

/**
 * Deletes a deployed website Worker.
 */
export async function removeWebsite(siteName) {
  const workerName = `absohost-${siteName}`;
  await fetch(`${getCfApi()}/workers/scripts/${workerName}`, {
    method: 'DELETE',
    headers: cfHeaders(),
  });
}

/**
 * Generates the Cloudflare Worker script for static/basic site hosting.
 */
function buildWebsiteWorkerScript({ siteName, repoUrl, userId, plan }) {
  return `
// AbsoraCloud Web Hosting Worker — ${siteName}
// Deployed for user ${userId} on plan: ${plan}
// Source repo: ${repoUrl}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  const repoPath = '${repoUrl}'
    .replace('https://github.com/', '')
    .replace(/\\.git$/, '');

  const branches = ['main', 'master'];

  for (const branch of branches) {
    try {
      const rawUrl = 'https://raw.githubusercontent.com/' + repoPath + '/' + branch + pathname;
      const upstream = await fetch(rawUrl);
      if (upstream.ok) {
        const contentType = guessContentType(pathname);
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=60',
            'X-Powered-By': 'AbsoraCloud Web Hosting',
          },
        });
      }
    } catch (_) {}
  }

  // SPA fallback
  for (const branch of branches) {
    try {
      const rawIndex = 'https://raw.githubusercontent.com/' + repoPath + '/' + branch + '/index.html';
      const index = await fetch(rawIndex);
      if (index.ok) {
        return new Response(index.body, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
    } catch (_) {}
  }

  return new Response('404 — Site not found or branch not found', { status: 404 });
}

function guessContentType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css'))  return 'text/css';
  if (path.endsWith('.js'))   return 'application/javascript';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.png'))  return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.svg'))  return 'image/svg+xml';
  if (path.endsWith('.ico'))  return 'image/x-icon';
  if (path.endsWith('.woff2')) return 'font/woff2';
  return 'text/plain';
}
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVERLESS FUNCTIONS — Deploy user code as a Cloudflare Worker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deploys a user-written function as a Cloudflare Worker.
 */
export async function deployFunction({ funcName, code, userId, plan, sessionKey }) {
  const workerName = `abso-fn-${userId}-${funcName}`;
  const wrappedCode = wrapUserFunctionCode(code, { funcName, userId, plan });

  await uploadWorkerScript(workerName, wrappedCode);

  // Enable the workers.dev subdomain route
  await enableWorkerSubdomain(workerName);

  const subdomain = await getWorkersSubdomain();
  const publicUrl = `https://${workerName}.${subdomain}.workers.dev`;

  return { workerName, publicUrl };
}

/**
 * Deletes a user serverless function Worker.
 */
export async function deleteFunction(userId, funcName) {
  const workerName = `abso-fn-${userId}-${funcName}`;
  await fetch(`${getCfApi()}/workers/scripts/${workerName}`, {
    method: 'DELETE',
    headers: cfHeaders(),
  });
}

/**
 * Lists all workers deployed for a user (by prefix).
 */
export async function listUserFunctions(userId) {
  const res = await fetch(`${getCfApi()}/workers/scripts`, {
    headers: cfHeaders(),
  });
  const data = await res.json();
  if (!data.success) return [];
  const prefix = `abso-fn-${userId}-`;
  return (data.result || [])
    .filter(w => w.id.startsWith(prefix))
    .map(w => ({
      name: w.id.replace(prefix, ''),
      worker_name: w.id,
      created_on: w.created_on,
      modified_on: w.modified_on,
    }));
}

/**
 * Gets usage/analytics for a worker function.
 */
export async function getFunctionStatus(userId, funcName) {
  const workerName = `abso-fn-${userId}-${funcName}`;
  const res = await fetch(`${getCfApi()}/workers/scripts/${workerName}`, {
    headers: cfHeaders(),
  });
  if (!res.ok) return null;
  return await res.json();
}

/**
 * Wraps user code with safety boilerplate and plan metadata.
 */
function wrapUserFunctionCode(userCode, { funcName, userId, plan }) {
  return `
// AbsoraCloud Serverless Function — ${funcName}
// User: ${userId} | Plan: ${plan}
// ⚠️  Sandboxed: Cloudflare Workers runtime

${userCode}
`.trim();
}
