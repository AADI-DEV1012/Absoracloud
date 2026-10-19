// ── Hugging Face Spaces (Gradio Only) Multi-Site Host Integration ──
// Deploys and manages up to 20+ websites on a single Gradio HF Space.
// Each site gets an isolated local port and a public Cloudflare Tunnel URL.

import { redisCmd } from '../../../packages/shared/redis.js';

const HF_API = 'https://huggingface.co/api';

/**
 * Ensures the Gradio Host Space exists on Hugging Face with `sdk: gradio`.
 */
export async function ensureGradioHostSpace() {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error('Missing HF_TOKEN');

  const owner = process.env.HF_USERNAME || 'absoracloud';
  const spaceName = process.env.HF_SPACE_NAME || 'absoracloud-webhost';

  const res = await fetch(`${HF_API}/repos/create`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'space',
      name: spaceName,
      sdk: 'gradio', // STRICTLY GRADIO ONLY
      private: false,
    }),
  });

  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`HF Space creation failed (${res.status}): ${text}`);
  }

  return `https://${owner}-${spaceName}.hf.space`;
}

/**
 * Dispatches a site deployment to the Gradio multi-site host via Redis queue.
 * The Gradio host pulls the task, runs the web server, starts cloudflared, and reports the URL.
 */
export async function deploySiteToGradioHost({ siteName, repoUrl, sessionKey, timeoutSeconds, userId, plan }) {
  const task = {
    action: 'deploy',
    site_name: siteName,
    repo_url: repoUrl,
    session_key: sessionKey,
    user_id: userId,
    plan,
    timeout_seconds: timeoutSeconds,
    created_at: new Date().toISOString(),
  };

  // Push task to the webhost queue that the Gradio app listens to
  await redisCmd('RPUSH', 'webhost:tasks', JSON.stringify(task));

  // Initialize session state in Redis
  await redisCmd('HSET', `session:${sessionKey}`, 
    'status', 'deploying',
    'site_name', siteName,
    'service', 'webhost',
    'repo_url', repoUrl
  );
  await redisCmd('EXPIRE', `session:${sessionKey}`, String(timeoutSeconds + 3600));

  return { status: 'queued', session_key: sessionKey };
}

/**
 * Sends a termination signal to stop a specific website on the Gradio host.
 */
export async function stopSiteOnGradioHost(sessionKey) {
  // Push stop task to Gradio host queue & set kill flag
  await redisCmd('SET', `kill:${sessionKey}`, '1', 'EX', '300');
  await redisCmd('RPUSH', 'webhost:tasks', JSON.stringify({
    action: 'stop',
    session_key: sessionKey,
  }));
}
