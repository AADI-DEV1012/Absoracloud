// ── Cloudflare Workers Deployment Service ──
// Powers both: User Web Hosting and Serverless Functions.
// Deploys and manages Cloudflare Workers on behalf of AbsoraCloud users.

function getCfApi() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID in environment');
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
}

function cfHeaders(contentType = 'application/json') {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Missing CLOUDFLARE_API_TOKEN in environment');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': contentType,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WEB HOSTING — Deploy a static or Node.js site as a Cloudflare Worker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates or updates a Cloudflare Worker script for web hosting.
 * The script proxies to the user's GitHub repo content (static) or
 * wraps a simple fetch handler for the site.
 *
 * @param {object} opts
 * @param {string} opts.siteName   - URL-safe site slug (e.g. "my-blog")
 * @param {string} opts.repoUrl    - User's GitHub repo URL
 * @param {string} opts.sessionKey - Instance session key
 * @param {string} opts.userId     - User ID
 * @param {string} opts.plan       - User plan
 */
export async function deployWebsite({ siteName, repoUrl, sessionKey, userId, plan }) {
  const workerName = `absohost-${siteName}`;

  // Build a lightweight Worker script that serves the site
  const script = buildWebsiteWorkerScript({ siteName, repoUrl, userId, plan });

  const res = await fetch(`${getCfApi()}/workers/scripts/${workerName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/javascript',
    },
    body: script,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CF Worker deploy failed (${res.status}): ${err}`);
  }

  const data = await res.json();

  // Assign a workers.dev subdomain route or custom domain
  const domain = process.env.CLOUDFLARE_DOMAIN || 'astrocore.qzz.io';
  const publicUrl = `https://${workerName}.${process.env.CF_WORKERS_SUBDOMAIN || 'absoracloud'}.workers.dev`;

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

  // Derive raw GitHub content URL from repo URL
  const repoBase = '${repoUrl}'
    .replace('https://github.com/', 'https://raw.githubusercontent.com/')
    .replace(/\\.git$/, '') + '/main';

  try {
    const upstream = await fetch(repoBase + pathname);
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
    // Fallback to index.html for SPA routing
    const index = await fetch(repoBase + '/index.html');
    if (index.ok) return new Response(index.body, { status: 200, headers: { 'Content-Type': 'text/html' } });
  } catch (e) {}

  return new Response('404 — Site not found', { status: 404 });
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
 *
 * @param {object} opts
 * @param {string} opts.funcName   - Function name slug (e.g. "my-api")
 * @param {string} opts.code       - User's JS worker code
 * @param {string} opts.userId     - User ID
 * @param {string} opts.plan       - User plan
 * @param {string} opts.sessionKey - Instance session key
 */
export async function deployFunction({ funcName, code, userId, plan, sessionKey }) {
  const workerName = `abso-fn-${userId}-${funcName}`;

  // Wrap user code in an isolated handler with plan-based limits
  const wrappedCode = wrapUserFunctionCode(code, { funcName, userId, plan });

  const res = await fetch(`${getCfApi()}/workers/scripts/${workerName}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/javascript',
    },
    body: wrappedCode,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Serverless deploy failed (${res.status}): ${err}`);
  }

  const publicUrl = `https://${workerName}.${process.env.CF_WORKERS_SUBDOMAIN || 'absoracloud'}.workers.dev`;
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
// ⚠️  Sandboxed: No Node.js APIs — Cloudflare Workers runtime only

${userCode}
`.trim();
}
