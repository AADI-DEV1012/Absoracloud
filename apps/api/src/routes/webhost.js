// ── Web Hosting Routes (Cloudflare Workers) ──
// POST /webhost/deploy, GET /webhost/status, GET /webhost/check_session,
// DELETE /webhost/remove, POST /webhost/relaunch

import { Router } from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { queryD1, executeD1, d1QueryOne } from '../../../../packages/shared/d1.js';
import { redisCmd, redisParseHash }       from '../../../../packages/shared/redis.js';
import { getPlan }                        from '../../../../packages/shared/plans.js';
import { deployWebsite, removeWebsite }   from '../services/cloudflare_workers.js';

import crypto from 'crypto';

export const webhostRouter = Router();

async function syncUserWebhostState(userId) {
  // Mark deploying sites that timed out (>90s) as failed
  await executeD1(
    `UPDATE instances 
     SET status = 'failed', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'webhost' AND status = 'deploying' 
       AND datetime(created_at) <= datetime('now', '-90 seconds')`,
    [userId]
  );
}

// ── Deploy site via Cloudflare Workers ──
webhostRouter.post('/deploy', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const plan   = getPlan(req.user.plan);
    const { repo_url, site_name } = req.body;

    if (!repo_url || !site_name) {
      return res.status(400).json({ status: 'error', msg: 'repo_url and site_name required' });
    }
    if (!/^[a-z0-9-]{3,30}$/.test(site_name)) {
      return res.status(400).json({ status: 'error', msg: 'site_name: 3-30 chars, lowercase letters/numbers/hyphens only' });
    }

    await syncUserWebhostState(userId);

    // Check site quota
    const siteCount = await queryD1(
      "SELECT COUNT(*) as cnt FROM instances WHERE user_id = ? AND service = 'webhost' AND status IN ('active', 'deploying')",
      [userId]
    );
    if ((siteCount[0]?.cnt || 0) >= plan.webhost_sites) {
      return res.status(403).json({ status: 'error', msg: `Max ${plan.webhost_sites} active site(s) on your plan` });
    }

    // Check for duplicate site_name
    const existing = await d1QueryOne(
      "SELECT session_key FROM instances WHERE user_id = ? AND service = 'webhost' AND status IN ('active','deploying') AND config LIKE ?",
      [userId, `%"site_name":"${site_name}"%`]
    );
    if (existing) {
      return res.status(409).json({ status: 'error', msg: `Site name "${site_name}" is already in use. Choose a different name.` });
    }

    const sessionKey = `web-${site_name}-${crypto.randomUUID().slice(0, 6)}`;
    const timeoutSeconds = req.user.plan === 'free' ? 86400 : 86400 * 30;
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config, expires_at) VALUES (?, 'webhost', ?, 'deploying', ?, ?)",
      [userId, sessionKey, JSON.stringify({ repo_url, site_name, plan: req.user.plan }), expiresAt]
    );

    // Initialize Redis session state
    await redisCmd('HSET', `session:${sessionKey}`,
      'status', 'deploying',
      'site_name', site_name,
      'service', 'webhost'
    );
    await redisCmd('EXPIRE', `session:${sessionKey}`, String(timeoutSeconds + 3600));

    // Deploy directly to Cloudflare Workers (async — don't block response)
    deployWebsite({ siteName: site_name, repoUrl: repo_url, sessionKey, userId, plan: req.user.plan })
      .then(async ({ publicUrl }) => {
        await executeD1(
          "UPDATE instances SET status = 'active', public_url = ? WHERE session_key = ?",
          [publicUrl, sessionKey]
        );
        await redisCmd('HSET', `session:${sessionKey}`, 'status', 'active', 'tunnel_url', publicUrl);
        console.log(`✅ WebHost deployed: ${site_name} → ${publicUrl}`);
      })
      .catch(async (err) => {
        await executeD1(
          "UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?",
          [sessionKey]
        );
        await redisCmd('HSET', `session:${sessionKey}`, 'status', 'failed', 'error', err.message);
        console.error(`❌ WebHost deploy failed for ${site_name}:`, err.message);
      });

    res.json({
      status: 'deploying',
      session_key: sessionKey,
      site_name,
      expires_at: expiresAt,
      msg: 'Deploying to Cloudflare Workers — your site will be live in seconds...',
    });
  } catch (e) {
    console.error('WebHost deploy error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to deploy site' });
  }
});

// ── Re-deploy / Refresh Site ──
webhostRouter.post('/relaunch', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.body;
    const inst = await d1QueryOne(
      "SELECT config FROM instances WHERE session_key = ? AND user_id = ?",
      [session_key, req.user.sub]
    );
    if (!inst) return res.status(404).json({ status: 'error', msg: 'Site not found' });

    const cfg = JSON.parse(inst.config || '{}');

    // Remove old Worker and dismiss old instance
    try { await removeWebsite(cfg.site_name); } catch (_) {}
    await executeD1("UPDATE instances SET status = 'dismissed' WHERE session_key = ?", [session_key]);

    const newSessionKey = `web-${cfg.site_name || 'site'}-${crypto.randomUUID().slice(0, 6)}`;
    const timeoutSeconds = req.user.plan === 'free' ? 86400 : 86400 * 30;
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config, expires_at) VALUES (?, 'webhost', ?, 'deploying', ?, ?)",
      [req.user.sub, newSessionKey, JSON.stringify(cfg), expiresAt]
    );

    await redisCmd('HSET', `session:${newSessionKey}`, 'status', 'deploying', 'service', 'webhost');

    deployWebsite({ siteName: cfg.site_name, repoUrl: cfg.repo_url, sessionKey: newSessionKey, userId: req.user.sub, plan: req.user.plan })
      .then(async ({ publicUrl }) => {
        await executeD1("UPDATE instances SET status = 'active', public_url = ? WHERE session_key = ?", [publicUrl, newSessionKey]);
        await redisCmd('HSET', `session:${newSessionKey}`, 'status', 'active', 'tunnel_url', publicUrl);
      })
      .catch(async (err) => {
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [newSessionKey]);
        await redisCmd('HSET', `session:${newSessionKey}`, 'status', 'failed', 'error', err.message);
      });

    res.json({ status: 'deploying', session_key: newSessionKey, msg: 'Re-deploying to Cloudflare Workers...' });
  } catch (e) {
    console.error('WebHost relaunch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to re-deploy site' });
  }
});

// ── Poll Session Status ──
webhostRouter.get('/check_session', requireAuth, async (req, res) => {
  try {
    const session_key = req.query.session_key || req.query.session_id;
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'session_key required' });

    // 1. Redis first (fastest)
    const data = redisParseHash(await redisCmd('HGETALL', `session:${session_key}`));
    if (data && data.status) {
      return res.json({
        status: data.status,
        url: data.tunnel_url || null,
        expires_at: data.expires_at || null,
        error: data.error || null,
      });
    }

    // 2. D1 fallback
    const inst = await d1QueryOne("SELECT * FROM instances WHERE session_key = ?", [session_key]);
    if (!inst) return res.status(404).json({ status: 'not_found' });

    if (inst.status === 'deploying') {
      const createdTime = new Date(inst.created_at).getTime();
      if (Date.now() - createdTime > 90000) {
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [session_key]);
        await redisCmd('HSET', `session:${session_key}`, 'status', 'failed', 'error', 'Cloudflare Worker deployment timed out.');
        return res.json({ status: 'failed', msg: 'Deployment timed out.' });
      }
    }

    res.json({ status: inst.status, url: inst.public_url || null, expires_at: inst.expires_at || null });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to check site status' });
  }
});

// ── List All Sites ──
webhostRouter.get('/status', requireAuth, async (req, res) => {
  try {
    await syncUserWebhostState(req.user.sub);
    const sites = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'webhost' AND status != 'dismissed' ORDER BY created_at DESC",
      [req.user.sub]
    );
    res.json({ status: 'success', sites });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch sites' });
  }
});

// ── Remove Site ──
async function handleRemoveSite(req, res) {
  try {
    const session_key = req.body?.session_key || req.query?.session_key || req.params?.session_key;
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'session_key required' });

    const instance = await d1QueryOne(
      "SELECT * FROM instances WHERE session_key = ? AND user_id = ?", [session_key, req.user.sub]
    );
    if (!instance) return res.status(404).json({ status: 'error', msg: 'Site not found' });

    const cfg = JSON.parse(instance.config || '{}');

    // Delete Cloudflare Worker
    try { await removeWebsite(cfg.site_name); } catch (e) {
      console.warn(`CF Worker delete warning for ${cfg.site_name}:`, e.message);
    }

    await executeD1(
      "UPDATE instances SET status = 'dismissed', stopped_at = datetime('now') WHERE session_key = ?",
      [session_key]
    );
    await redisCmd('SET', `kill:${session_key}`, '1', 'EX', '300');

    res.json({ status: 'success', msg: 'Site removed from Cloudflare Workers' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to remove site' });
  }
}

webhostRouter.delete('/remove', requireAuth, handleRemoveSite);
webhostRouter.delete('/instance/:session_key', requireAuth, handleRemoveSite);
