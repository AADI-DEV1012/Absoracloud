// ── Serverless Functions Routes (Cloudflare Workers) ──
// POST /serverless/deploy   — Deploy a new function
// GET  /serverless/status   — List all user functions
// PUT  /serverless/update   — Update existing function code
// DELETE /serverless/:name  — Delete a function
// GET  /serverless/:name/status — Get function info

import { Router } from 'express';
import { requireAuth }   from '../middleware/auth.js';
import { launchLimiter } from '../middleware/abuse_guard.js';
import { queryD1, executeD1, d1QueryOne } from '../../../../packages/shared/d1.js';
import { redisCmd }      from '../../../../packages/shared/redis.js';
import { getPlan }       from '../../../../packages/shared/plans.js';
import {
  deployFunction,
  deleteFunction,
  listUserFunctions,
  getFunctionStatus,
} from '../services/cloudflare_workers.js';
import crypto from 'crypto';

export const serverlessRouter = Router();

const FUNC_NAME_REGEX = /^[a-z0-9-]{2,30}$/;

// ── Deploy New Function ──
serverlessRouter.post('/deploy', requireAuth, launchLimiter, async (req, res) => {
  try {
    const userId = req.user.sub;
    const plan   = getPlan(req.user.plan);
    const { func_name, code } = req.body;

    if (!func_name || !code) {
      return res.status(400).json({ status: 'error', msg: 'func_name and code are required' });
    }
    if (!FUNC_NAME_REGEX.test(func_name)) {
      return res.status(400).json({ status: 'error', msg: 'func_name: 2-30 chars, lowercase letters/numbers/hyphens only' });
    }
    if (code.length > plan.serverless_code_limit_kb * 1024) {
      return res.status(400).json({ status: 'error', msg: `Code size exceeds plan limit (${plan.serverless_code_limit_kb}KB)` });
    }

    // Check function quota
    const fnCount = await queryD1(
      "SELECT COUNT(*) as cnt FROM instances WHERE user_id = ? AND service = 'serverless' AND status = 'active'",
      [userId]
    );
    if ((fnCount[0]?.cnt || 0) >= plan.serverless_functions) {
      return res.status(403).json({
        status: 'error',
        msg: `Max ${plan.serverless_functions} serverless function(s) on your plan. Delete an existing function or upgrade.`,
      });
    }

    // Check for duplicate name using exact json_extract or exact match
    const existing = await d1QueryOne(
      "SELECT session_key FROM instances WHERE user_id = ? AND service = 'serverless' AND status = 'active' AND json_extract(config, '$.func_name') = ?",
      [userId, func_name]
    );
    if (existing) {
      return res.status(409).json({ status: 'error', msg: `Function "${func_name}" already exists. Use PUT /serverless/update to update it.` });
    }

    const sessionKey = `fn-${userId}-${func_name}-${crypto.randomUUID().slice(0, 6)}`;

    await executeD1(
      "INSERT INTO instances (user_id, service, session_key, status, config) VALUES (?, 'serverless', ?, 'deploying', ?)",
      [userId, sessionKey, JSON.stringify({ func_name, plan: req.user.plan })]
    );

    // Deploy to Cloudflare Workers
    let publicUrl;
    try {
      const deployRes = await deployFunction({
        funcName: func_name,
        code,
        userId,
        plan: req.user.plan,
        sessionKey,
      });
      publicUrl = deployRes.publicUrl;

      await executeD1(
        "UPDATE instances SET status = 'active', public_url = ? WHERE session_key = ?",
        [publicUrl, sessionKey]
      );
    } catch (deployErr) {
      await executeD1(
        "UPDATE instances SET status = 'failed', stopped_at = datetime('now') WHERE session_key = ?",
        [sessionKey]
      );
      throw deployErr;
    }

    res.json({
      status: 'active',
      session_key: sessionKey,
      func_name,
      endpoint: publicUrl,
      msg: `Function "${func_name}" deployed to Cloudflare Workers edge network!`,
    });
  } catch (e) {
    console.error('Serverless deploy error:', e);
    res.status(500).json({ status: 'error', msg: e.message || 'Failed to deploy function' });
  }
});

// ── Update Existing Function ──
serverlessRouter.put('/update', requireAuth, launchLimiter, async (req, res) => {
  try {
    const userId = req.user.sub;
    const plan   = getPlan(req.user.plan);
    const { func_name, code } = req.body;

    if (!func_name || !code) {
      return res.status(400).json({ status: 'error', msg: 'func_name and code are required' });
    }
    if (!FUNC_NAME_REGEX.test(func_name)) {
      return res.status(400).json({ status: 'error', msg: 'func_name: 2-30 chars, lowercase letters/numbers/hyphens only' });
    }
    if (code.length > plan.serverless_code_limit_kb * 1024) {
      return res.status(400).json({ status: 'error', msg: `Code size exceeds plan limit (${plan.serverless_code_limit_kb}KB)` });
    }

    const inst = await d1QueryOne(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'serverless' AND status = 'active' AND json_extract(config, '$.func_name') = ?",
      [userId, func_name]
    );
    if (!inst) {
      return res.status(404).json({ status: 'error', msg: `Function "${func_name}" not found.` });
    }

    const { publicUrl } = await deployFunction({
      funcName: func_name,
      code,
      userId,
      plan: req.user.plan,
      sessionKey: inst.session_key,
    });

    res.json({
      status: 'active',
      func_name,
      endpoint: publicUrl,
      msg: `Function "${func_name}" updated successfully.`,
    });
  } catch (e) {
    console.error('Serverless update error:', e);
    res.status(500).json({ status: 'error', msg: e.message || 'Failed to update function' });
  }
});

// ── List All User Functions ──
serverlessRouter.get('/status', requireAuth, async (req, res) => {
  try {
    const functions = await queryD1(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'serverless' AND status != 'dismissed' ORDER BY created_at DESC",
      [req.user.sub]
    );
    res.json({ status: 'success', functions });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to list functions' });
  }
});

// ── Get Single Function Status ──
serverlessRouter.get('/:func_name/status', requireAuth, async (req, res) => {
  try {
    const { func_name } = req.params;
    if (!FUNC_NAME_REGEX.test(func_name)) {
      return res.status(400).json({ status: 'error', msg: 'Invalid function name' });
    }
    const inst = await d1QueryOne(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'serverless' AND status = 'active' AND json_extract(config, '$.func_name') = ?",
      [req.user.sub, func_name]
    );
    if (!inst) return res.status(404).json({ status: 'error', msg: 'Function not found' });

    const cfStatus = await getFunctionStatus(req.user.sub, func_name).catch(() => null);
    res.json({ status: 'success', function: inst, cf_status: cfStatus });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to get function status' });
  }
});

// ── Delete Function ──
serverlessRouter.delete('/:func_name', requireAuth, async (req, res) => {
  try {
    const { func_name } = req.params;
    if (!FUNC_NAME_REGEX.test(func_name)) {
      return res.status(400).json({ status: 'error', msg: 'Invalid function name' });
    }

    const inst = await d1QueryOne(
      "SELECT * FROM instances WHERE user_id = ? AND service = 'serverless' AND json_extract(config, '$.func_name') = ?",
      [req.user.sub, func_name]
    );
    if (!inst) return res.status(404).json({ status: 'error', msg: 'Function not found' });

    try {
      await deleteFunction(req.user.sub, func_name);
    } catch (e) {
      console.warn(`CF Worker delete warning for fn ${func_name}:`, e.message);
    }

    await executeD1(
      "UPDATE instances SET status = 'dismissed', stopped_at = datetime('now') WHERE session_key = ?",
      [inst.session_key]
    );

    res.json({ status: 'success', msg: `Function "${func_name}" deleted.` });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: 'Failed to delete function' });
  }
});
