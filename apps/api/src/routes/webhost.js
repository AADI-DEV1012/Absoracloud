// ── Web Hosting Routes (Gradio Only HF Space Host) ──
// POST /webhost/deploy, GET /webhost/status, GET /webhost/check_session, DELETE /webhost/remove, POST /webhost/relaunch

import { Router } from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { queryD1, executeD1, d1QueryOne } from '../shared/d1.js';
import { redisCmd, redisParseHash }       from '../shared/redis.js';
import { getPlan }                        from '../shared/plans.js';
import { deploySiteToGradioHost, stopSiteOnGradioHost } from '../services/huggingface.js';
import crypto from 'crypto';

export const webhostRouter = Router();

async function syncUserWebhostState(userId) {
  await executeD1(
    `UPDATE instances 
     SET status = 'failed', stopped_at = datetime('now')
     WHERE user_id = ? AND service = 'webhost' AND status = 'deploying' 
       AND datetime(created_at) <= datetime('now', '-3 minutes')`,
    [userId]
  );
}

// ── Deploy site onto Gradio multi-site host ──
webhostRouter.post('/deploy', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const plan   = getPlan(req.user.plan);
    const { repo_url, site_name } = req.body;

    if (!repo_url || !site_name) {
      return res.status(400).json({ status: 'error', msg: 'repo_url and site_name required' });
    }
    if (!/^[a-z0-9-]{3,30}$/.test(site_name)) {
      return res.status(400).json({ status: 'error', msg: 'site_name: 3-30 chars, lowercase letters/numbers/hyphens' });
    }

    await syncUserWebhostState(userId);

    // Check site quota (only count active or deploying sites)
    const siteCount = await queryD1(
      "SELECT COUNT(*) as cnt FROM instances WHERE user_id = ? AND service = 'webhost' AND status IN ('active', 'deploying')",
      [userId]
    );
    if ((siteCount[0]?.cnt || 0) >= plan.webhost_sites) {
      return res.status(403).json({ status: 'error', msg: `Max ${plan.webhost_sites} active site(s) on your plan` });
    }

    const sessionKey = `web-${site_name}-${crypto.randomUUID().slice(0, 6)}`;
    const timeoutSeconds = req.user.plan === 'free' ? 86400 : 86400 * 30;
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config, expires_at) VALUES (?, 'webhost', ?, 'deploying', ?, ?)",
      [userId, sessionKey, JSON.stringify({ repo_url, site_name, plan: req.user.plan }), expiresAt]
    );

    // Dispatch to Gradio multi-site host
    await deploySiteToGradioHost({
      siteName: site_name,
      repoUrl: repo_url,
      sessionKey,
      timeoutSeconds,
      userId,
      plan: req.user.plan,
    });

    res.json({
      status: 'deploying',
      session_key: sessionKey,
      site_name,
      expires_at: expiresAt,
      msg: 'Deployment dispatched to Gradio host! Generating Cloudflare Tunnel...',
    });
  } catch (e) {
    console.error('WebHost deploy error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to deploy site' });
  }
});

// ── Re-launch Website ──
webhostRouter.post('/relaunch', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.body;
    const inst = await d1QueryOne("SELECT config FROM instances WHERE session_key = ? AND user_id = ?", [session_key, req.user.sub]);
    if (!inst) return res.status(404).json({ status: 'error', msg: 'Site not found' });
    const cfg = JSON.parse(inst.config || '{}');
    
    // Stop old site
    await stopSiteOnGradioHost(session_key);
    await executeD1("UPDATE instances SET status = 'dismissed' WHERE session_key = ?", [session_key]);

    const newSessionKey = `web-${cfg.site_name || 'site'}-${crypto.randomUUID().slice(0, 6)}`;
    const timeoutSeconds = req.user.plan === 'free' ? 86400 : 86400 * 30;
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config, expires_at) VALUES (?, 'webhost', ?, 'deploying', ?, ?)",
      [req.user.sub, newSessionKey, JSON.stringify(cfg), expiresAt]
    );

    await deploySiteToGradioHost({
      siteName: cfg.site_name,
      repoUrl: cfg.repo_url,
      sessionKey: newSessionKey,
      timeoutSeconds,
      userId: req.user.sub,
      plan: req.user.plan,
    });

    res.json({
      status: 'deploying',
      session_key: newSessionKey,
      msg: 'Re-deploying website to Gradio host...',
    });
  } catch (e) {
    console.error('WebHost relaunch error:', e);
    res.status(500).json({ status: 'error', msg: 'Failed to re-launch website' });
  }
});

// ── Check Session / Tunnel URL polling ──
webhostRouter.get('/check_session', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.query;
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'session_key required' });

    const data = redisParseHash(await redisCmd('HGETALL', `session:${session_key}`));
    if (data && data.status) {
      return res.json({
        status: data.status,
        url: data.tunnel_url || null,
        expires_at: data.expires_at || null,
        error: data.error || null,
      });
    }

    const inst = await d1QueryOne("SELECT * FROM instances WHERE session_key = ?", [session_key]);
    if (!inst) return res.status(404).json({ status: 'not_found' });

    if (inst.status === 'deploying') {
      const createdTime = new Date(inst.created_at).getTime();
      if (Date.now() - createdTime > 180000) {
        await executeD1("UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?", [session_key]);
        return res.json({ status: 'failed', msg: 'Deployment timed out on Gradio host.' });
      }
    }

    res.json({
      status: inst.status,
      url: inst.public_url || null,
      expires_at: inst.expires_at || null,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to check site status' });
  }
});

// ── Status ──
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

// ── Remove ──
webhostRouter.delete('/remove', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.body;
    const instance = await d1QueryOne(
      "SELECT * FROM instances WHERE session_key = ? AND user_id = ?", [session_key, req.user.sub]
    );
    if (!instance) return res.status(404).json({ status: 'error', msg: 'Site not found' });

    await stopSiteOnGradioHost(session_key);
    await executeD1("UPDATE instances SET status = 'dismissed', stopped_at = datetime('now') WHERE session_key = ?", [session_key]);

    res.json({ status: 'success', msg: 'Site removed' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to remove site' });
  }
});
