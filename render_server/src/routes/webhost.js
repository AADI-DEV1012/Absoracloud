// ── Web Hosting Routes (Gradio Only HF Space Host) ──
// POST /webhost/deploy, GET /webhost/status, POST /webhost/check_session, DELETE /webhost/remove

import { Router } from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { queryD1, executeD1, d1QueryOne } from '../../../packages/shared/d1.js';
import { redisCmd, redisParseHash }       from '../../../packages/shared/redis.js';
import { getPlan }                        from '../../../packages/shared/plans.js';
import { deploySiteToGradioHost, stopSiteOnGradioHost } from '../services/huggingface.js';
import crypto from 'crypto';

export const webhostRouter = Router();

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

    // Check site quota
    const siteCount = await queryD1(
      "SELECT COUNT(*) as cnt FROM instances WHERE user_id = ? AND service = 'webhost' AND status = 'active'",
      [userId]
    );
    if ((siteCount[0]?.cnt || 0) >= plan.webhost_sites) {
      return res.status(403).json({ status: 'error', msg: `Max ${plan.webhost_sites} sites on your plan` });
    }

    const sessionKey = `web-${site_name}-${crypto.randomUUID().slice(0, 6)}`;

    // Timeout: Free sites expire in 24 hours (or renew on visit); Paid plans get 7-30 days
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

// ── Check Session / Tunnel URL polling ──
webhostRouter.get('/check_session', requireAuth, async (req, res) => {
  try {
    const { session_key } = req.query;
    if (!session_key) return res.status(400).json({ status: 'error', msg: 'session_key required' });

    const data = redisParseHash(await redisCmd('HGETALL', `session:${session_key}`));
    if (!data || !data.status) {
      const inst = await d1QueryOne("SELECT * FROM instances WHERE session_key = ?", [session_key]);
      return res.json({ status: inst?.status || 'pending', url: inst?.public_url || null });
    }

    res.json({
      status: data.status,
      url: data.tunnel_url || null,
      expires_at: data.expires_at || null,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to check site status' });
  }
});

// ── Status ──
webhostRouter.get('/status', requireAuth, async (req, res) => {
  try {
    const sites = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'webhost' ORDER BY created_at DESC",
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
    await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE session_key = ?", [session_key]);

    res.json({ status: 'success', msg: 'Site removed' });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to remove site' });
  }
});
