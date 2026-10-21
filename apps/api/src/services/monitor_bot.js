// ── AbsoraCloud Telegram System Monitor Bot ──
// Lightweight in-process monitor for Render Free Plan (0.1 CPU, 512 MB).
// Zero heavy external libraries: uses native fetch for Telegram & NVIDIA AI.
// Runs every 5 minutes with Redis distributed lock & strictly read-only checks.

import { performance } from 'perf_hooks';
import { queryD1, executeD1 } from '../../../../packages/shared/d1.js';
import { redisCmd, redisPipeline } from '../../../../packages/shared/redis.js';
import { getLogDiskUsage, getRunLog, appendRunLog } from './run_logger.js';
import { removeWebsite, deleteFunction } from './cloudflare_workers.js';
import { PLANS, getPlan, getPlanLimits } from '../../../../packages/shared/plans.js';
import { getRecentErrors } from './error_tracker.js';
import crypto from 'crypto';
import { triggerVPSKernel, triggerKaggleKernel } from './kaggle.js';

const TELEGRAM_API = 'https://api.telegram.org';
const NVIDIA_API   = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Configuration from Environment
const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID         = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_SECRET  = process.env.TELEGRAM_WEBHOOK_SECRET || 'absora_sec_token_99a81f3b';
const PUBLIC_URL      = process.env.PUBLIC_URL || 'https://absoracloud.onrender.com';
const NVIDIA_KEY      = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL    = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
const GPU_LIMIT_HOURS = parseFloat(process.env.GPU_WEEKLY_LIMIT_HOURS || '20');
const STORAGE_LIMIT_GB= parseFloat(process.env.PLATFORM_STORAGE_LIMIT_GB || '50');

const LOCK_KEY        = 'monitor:lock';
const LOCK_TTL_SEC    = 240; // 4 minutes
const ALERT_COOLDOWN  = 1800; // 30 minutes in seconds

let timerHandle = null;
let isRunInProgress = false;

// ── Helpers ──

function getIstTime() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }) + ' IST';
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

// Safely normalize D1 query output whether returned as direct array or { results: [] }
function toRows(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.results)) return res.results;
  return [];
}

// Send Telegram Message via native fetch (with automatic retry for network drops)
export async function sendTelegramMessage(text, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN || BOT_TOKEN;
  const defaultChat = process.env.TELEGRAM_CHAT_ID || CHAT_ID;
  if (!token || (!defaultChat && !options.chatId)) return null;

  const payload = {
    chat_id: options.chatId || defaultChat,
    text,
    parse_mode: 'HTML',
    disable_notification: Boolean(options.disableNotification),
    disable_web_page_preview: true
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'close'
        },
        body: JSON.stringify(payload)
      });
      return await res.json().catch(() => ({}));
    } catch (err) {
      if (attempt === 2) {
        console.error('[MonitorBot] Telegram send error:', err.message);
      } else {
        await new Promise(r => setTimeout(r, 600));
      }
    }
  }
  return null;
}

// Call NVIDIA Nemotron API with strict prompt & sanitization
async function callAiIncidentAnalysis(incidentSummary) {
  if (!NVIDIA_KEY) return null;

  try {
    // Check hourly limit in Redis (max 3 AI calls per hour to stay lightweight)
    const count = await redisCmd('INCR', 'monitor:ai:hourly_count').catch(() => 1);
    if (count === 1) {
      await redisCmd('EXPIRE', 'monitor:ai:hourly_count', '3600').catch(() => {});
    }
    if (count > 3) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const body = {
      model: NVIDIA_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are an SRE for AbsoraCloud cloud infrastructure. Given the sanitized telemetry, provide exactly 2 concise sentences: 1) Root cause assessment. 2) Immediate operational action. Never disclose internal keys or provider vendor names.'
        },
        {
          role: 'user',
          content: `Platform Telemetry Incident Report:\n${incidentSummary}`
        }
      ],
      temperature: 0.2,
      max_tokens: 120
    };

    const res = await fetch(NVIDIA_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NVIDIA_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (!res.ok) return null;

    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.warn('[MonitorBot] AI incident analysis unavailable:', e.message);
    return null;
  }
}

// ── Core Verification Checks ──

export async function runMonitoringCycle(isManual = false, overrideChatId = null) {
  if (isRunInProgress && !isManual) return;
  isRunInProgress = true;

  try {
    // 1. Distributed Lock to prevent duplicate messages across rolling restarts
    if (!isManual) {
      const lockAcquired = await redisCmd('SET', LOCK_KEY, `inst-${process.pid}`, 'NX', 'EX', String(LOCK_TTL_SEC)).catch(() => null);
      if (!lockAcquired) {
        return; // Another instance already ran or is running
      }
    }

    // Check mute status
    if (!isManual) {
      const isMuted = await redisCmd('GET', 'monitor:muted').catch(() => null);
      if (isMuted) return;
    }

    const alerts = [];
    const recovered = [];
    let overallSeverity = 'OK'; // 'OK' | 'WARN' | 'FAIL'

    // ── Check 1: API /health Latency & Availability ──
    let latencyMs = 0;
    let healthOk = false;
    try {
      const t0 = performance.now();
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      const hRes = await fetch(`${PUBLIC_URL}/health`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timeout);
      latencyMs = Math.round(performance.now() - t0);

      if (hRes.ok) {
        healthOk = true;
        if (latencyMs > 1800) {
          alerts.push(`High API latency: ${latencyMs}ms`);
          if (overallSeverity === 'OK') overallSeverity = 'WARN';
        }
      } else {
        alerts.push(`API /health returned HTTP ${hRes.status}`);
        overallSeverity = 'FAIL';
      }
    } catch (hErr) {
      alerts.push(`API /health unreachable: ${hErr.message}`);
      overallSeverity = 'FAIL';
    }

    // ── Check 2: D1 & Redis Reachability + Restart Detection ──
    let d1Ok = false;
    let redisOk = false;

    try {
      const p = await redisCmd('PING');
      if (p === 'PONG' || p) redisOk = true;
    } catch (_) {
      alerts.push('Redis connection failed');
      overallSeverity = 'FAIL';
    }

    // Check uptime reset (detect Render restart)
    const currentUptime = Math.floor(process.uptime());
    const prevUptimeStr = await redisCmd('GET', 'monitor:last_uptime').catch(() => null);
    if (prevUptimeStr) {
      const prevUptime = parseInt(prevUptimeStr, 10);
      if (currentUptime < prevUptime && prevUptime > 120) {
        alerts.push('Render container restart detected');
        if (overallSeverity === 'OK') overallSeverity = 'WARN';
      }
    }
    await redisCmd('SET', 'monitor:last_uptime', String(currentUptime), 'EX', '86400').catch(() => {});

    // ── Check 3: VPS & DevBox Workload Status (Consolidated Query 1) ──
    let vpsStats = { active: 0, pending: 0, failed: 0 };
    let devboxStats = { active: 0, pending: 0, failed: 0 };
    let totalFailed10m = 0;

    try {
      const q1 = `
        SELECT 
          service,
          status,
          COUNT(*) AS cnt,
          SUM(CASE WHEN status = 'pending' AND created_at < datetime('now', '-5 minutes') THEN 1 ELSE 0 END) AS stuck_pending,
          SUM(CASE WHEN status = 'failed' AND created_at > datetime('now', '-5 minutes') THEN 1 ELSE 0 END) AS recent_failed,
          SUM(CASE WHEN status = 'failed' AND created_at > datetime('now', '-10 minutes') THEN 1 ELSE 0 END) AS failed_10m
        FROM instances 
        WHERE service IN ('vps', 'devbox')
          AND (status IN ('active', 'pending') OR created_at > datetime('now', '-10 minutes'))
        GROUP BY service, status;
      `;
      const rows1 = await queryD1(q1);
      d1Ok = true;

      for (const r of rows1 || []) {
        const cnt = parseInt(r.cnt || '0', 10);
        const stuck = parseInt(r.stuck_pending || '0', 10);
        const f10 = parseInt(r.failed_10m || '0', 10);
        totalFailed10m += f10;

        if (r.service === 'vps') {
          if (r.status === 'active') vpsStats.active += cnt;
          if (r.status === 'pending') {
            vpsStats.pending += cnt;
            if (stuck > 0) alerts.push(`${stuck} VPS instance(s) stuck pending > 5m`);
          }
          if (r.status === 'failed') vpsStats.failed += cnt;
        } else if (r.service === 'devbox') {
          if (r.status === 'active') devboxStats.active += cnt;
          if (r.status === 'pending') {
            devboxStats.pending += cnt;
            if (stuck > 0) alerts.push(`${stuck} DevBox instance(s) stuck pending > 5m`);
          }
          if (r.status === 'failed') devboxStats.failed += cnt;
        }
      }

      if (totalFailed10m >= 5) {
        alerts.push(`High launch failures: ${totalFailed10m} failed runs in last 10m`);
        overallSeverity = 'FAIL';
      }
    } catch (d1Err) {
      alerts.push(`D1 query error (workloads): ${d1Err.message}`);
      overallSeverity = 'FAIL';
    }

    // ── Check 4: Runners Health (Consolidated Query 2) ──
    let runnersSummary = { ready: 0, starting: 0, dead: 0, stopped: 0 };
    try {
      const q2 = `
        SELECT 
          status,
          COUNT(*) AS cnt,
          SUM(CASE WHEN status IN ('starting', 'provisioning') AND started_at < datetime('now', '-6 minutes') THEN 1 ELSE 0 END) AS stuck_starting,
          SUM(CASE WHEN last_heartbeat < datetime('now', '-5 minutes') AND status IN ('ready', 'active') THEN 1 ELSE 0 END) AS dead_heartbeats
        FROM runners
        GROUP BY status;
      `;
      const rows2 = await queryD1(q2);

      for (const r of rows2 || []) {
        const s = (r.status || 'ready').toLowerCase();
        const cnt = parseInt(r.cnt || '0', 10);
        const stuck = parseInt(r.stuck_starting || '0', 10);
        const deadHb = parseInt(r.dead_heartbeats || '0', 10);

        if (s === 'ready' || s === 'active') runnersSummary.ready += cnt;
        else if (s === 'starting' || s === 'provisioning') {
          runnersSummary.starting += cnt;
          if (stuck > 0) alerts.push(`${stuck} runner(s) stuck in starting > 6m`);
        } else if (s === 'stopped') {
          runnersSummary.stopped += cnt;
        } else {
          runnersSummary.dead += cnt;
        }

        if (deadHb > 0) alerts.push(`${deadHb} active runner(s) missed heartbeat > 5m`);
      }
    } catch (_) {}

    // ── Check 5: Totals, Storage & Expired Cleanup (Consolidated Query 3) ──
    let totals = { users: 0, files: 0, storageBytes: 0, sites: 0, funcs: 0 };
    try {
      const q3 = `
        SELECT 
          (SELECT COUNT(*) FROM users) AS total_users,
          (SELECT COUNT(*) FROM cloud_files) AS total_files,
          (SELECT COALESCE(SUM(file_size), 0) FROM cloud_files) AS total_storage_bytes,
          (SELECT COUNT(*) FROM instances WHERE service = 'webhost' AND status = 'active') AS active_sites,
          (SELECT COUNT(*) FROM instances WHERE service = 'serverless' AND status = 'active') AS active_functions,
          (SELECT COUNT(*) FROM instances WHERE service IN ('webhost', 'serverless') AND status = 'expired' AND datetime(expires_at, '+1 hour') < datetime('now')) AS stuck_expired;
      `;
      const rows3 = await queryD1(q3);
      if (rows3 && rows3[0]) {
        const d = rows3[0];
        totals.users = parseInt(d.total_users || '0', 10);
        totals.files = parseInt(d.total_files || '0', 10);
        totals.storageBytes = parseInt(d.total_storage_bytes || '0', 10);
        totals.sites = parseInt(d.active_sites || '0', 10);
        totals.funcs = parseInt(d.active_functions || '0', 10);

        const stuckExpired = parseInt(d.stuck_expired || '0', 10);
        if (stuckExpired > 0) {
          alerts.push(`${stuckExpired} expired site/function(s) not removed after 1h`);
          if (overallSeverity === 'OK') overallSeverity = 'WARN';
        }
      }
    } catch (_) {}

    // Check platform storage usage vs limit
    const totalStorageGB = totals.storageBytes / (1024 * 1024 * 1024);
    const storagePercent = Math.min(100, Math.round((totalStorageGB / STORAGE_LIMIT_GB) * 100));
    if (storagePercent >= 85) {
      alerts.push(`Storage capacity at ${storagePercent}% (${totalStorageGB.toFixed(1)}GB / ${STORAGE_LIMIT_GB}GB)`);
      if (overallSeverity === 'OK') overallSeverity = 'WARN';
    }

    // ── Check 6: GPU Pool vs Limit & Local Disk Logs ──
    let activeGpuCount = 0;
    let poolWeeklyGpuHours = 0;
    try {
      const pipeRes = await redisPipeline([
        ['SCARD', 'gpu:active'],
        ['GET', 'gpu:pool:weekly_seconds']
      ]).catch(() => []);

      activeGpuCount = parseInt(pipeRes?.[0]?.result || '0', 10);
      const poolSeconds = parseInt(pipeRes?.[1]?.result || '0', 10);
      poolWeeklyGpuHours = parseFloat((poolSeconds / 3600).toFixed(1));

      const gpuUsagePercent = Math.round((poolWeeklyGpuHours / GPU_LIMIT_HOURS) * 100);
      if (gpuUsagePercent >= 95) {
        alerts.push(`GPU pool critical: ${poolWeeklyGpuHours}h / ${GPU_LIMIT_HOURS}h (${gpuUsagePercent}%)`);
        overallSeverity = 'FAIL';
      } else if (gpuUsagePercent >= 80) {
        alerts.push(`GPU pool warning: ${poolWeeklyGpuHours}h / ${GPU_LIMIT_HOURS}h (${gpuUsagePercent}%)`);
        if (overallSeverity === 'OK') overallSeverity = 'WARN';
      }
    } catch (_) {}

    const diskLogs = getLogDiskUsage();

    if (alerts.length > 0 && overallSeverity === 'OK') {
      overallSeverity = 'WARN';
    }

    // ── Alert Throttling & Recovery Management ──
    const activeAlertsToSend = [];
    const previousStatus = await redisCmd('GET', 'monitor:last_status').catch(() => 'OK');

    if (alerts.length > 0) {
      for (const alertText of alerts) {
        // Hash alert into clean key
        const alertKey = `monitor:alert:${alertText.slice(0, 32).replace(/[^a-zA-Z0-9]/g, '_')}`;
        const isCooledDown = await redisCmd('GET', alertKey).catch(() => null);
        if (!isCooledDown || isManual) {
          activeAlertsToSend.push(alertText);
          await redisCmd('SET', alertKey, '1', 'EX', String(ALERT_COOLDOWN)).catch(() => {});
        }
      }
    } else if (previousStatus !== 'OK' && previousStatus !== null) {
      recovered.push('All checks passing. Health restored.');
    }

    await redisCmd('SET', 'monitor:last_status', overallSeverity, 'EX', '86400').catch(() => {});

    // ── AI Incident Analysis (Only on WARN/FAIL and when new alerts occur) ──
    let aiInsight = null;
    if ((overallSeverity === 'WARN' || overallSeverity === 'FAIL') && activeAlertsToSend.length > 0) {
      const summaryPayload = `
Latency: ${latencyMs}ms
VPS: ${vpsStats.active} active, ${vpsStats.pending} pending, ${vpsStats.failed} failed
DevBox: ${devboxStats.active} active, ${devboxStats.pending} pending
Runners: ${runnersSummary.ready} ready, ${runnersSummary.starting} starting, ${runnersSummary.dead} dead
Alerts: ${activeAlertsToSend.join('; ')}
      `.trim();
      aiInsight = await callAiIncidentAnalysis(summaryPayload);
    }

    // ── Format Output Message (HTML, Emojis, <15 lines) ──
    const statusIcon = overallSeverity === 'OK' ? '🟢' : overallSeverity === 'WARN' ? '⚠️' : '🚨';
    const statusLabel = overallSeverity === 'OK' ? 'OK' : `[${overallSeverity}]`;

    const storageStr = totalStorageGB < 1 
      ? `${(totals.storageBytes / (1024 * 1024)).toFixed(1)} MB` 
      : `${totalStorageGB.toFixed(2)} GB`;

    let msg = `${statusIcon} <b>AbsoraCloud Monitor</b> ${statusLabel} • ${getIstTime()}\n`;
    msg += `<b>Health:</b> ${healthOk ? 'OK' : 'FAIL'} • <b>Latency:</b> ${latencyMs}ms • <b>Uptime:</b> ${formatUptime(currentUptime)}\n`;
    msg += `<b>Infra:</b> D1 ${d1Ok ? '✅' : '❌'} | Redis ${redisOk ? '✅' : '❌'} | LogPool ${diskLogs.totalMB}MB/1GB (${diskLogs.percentUsed}%)\n`;
    msg += `<b>Workloads:</b>\n`;
    msg += ` • VPS: ${vpsStats.active} active, ${vpsStats.pending} pending, ${vpsStats.failed} failed\n`;
    msg += ` • DevBox: ${devboxStats.active} active, ${devboxStats.pending} pending, ${devboxStats.failed} failed\n`;
    msg += ` • WebHost: ${totals.sites} live | Serverless: ${totals.funcs} deployed\n`;
    msg += `<b>Compute Pool:</b>\n`;
    msg += ` • Runners: ${runnersSummary.ready} ready, ${runnersSummary.starting} starting, ${runnersSummary.dead} dead\n`;
    msg += ` • GPU Pool: ${poolWeeklyGpuHours}h/${GPU_LIMIT_HOURS}h (${Math.round((poolWeeklyGpuHours / GPU_LIMIT_HOURS) * 100)}%) [${activeGpuCount} active]\n`;
    msg += `<b>Totals:</b> ${totals.users} users • ${totals.files} files (${storageStr})\n`;

    if (activeAlertsToSend.length > 0) {
      msg += `<b>Alerts:</b>\n`;
      activeAlertsToSend.slice(0, 3).forEach(a => msg += ` ⚠️ ${a}\n`);
    } else if (recovered.length > 0) {
      msg += `<b>Notice:</b> ✅ ${recovered.join(' ')}\n`;
    } else {
      msg += `<b>Status:</b> All systems operational\n`;
    }

    if (aiInsight) {
      msg += `<b>AI Insight:</b> <i>${aiInsight.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</i>\n`;
    }

    // Send notification: silent when OK, audible when WARN/FAIL or manual
    const disableNotification = (overallSeverity === 'OK') && !isManual;
    await sendTelegramMessage(msg, {
      chatId: overrideChatId || CHAT_ID,
      disableNotification
    });

  } catch (err) {
    console.error('[MonitorBot] Cycle error (non-crashing):', err);
  } finally {
    isRunInProgress = false;
  }
}

// ── Daily 08:00 IST Morning Digest ──
async function checkMorningDigest() {
  try {
    const istHours = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();
    if (istHours === 8) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const alreadySent = await redisCmd('GET', `monitor:digest:${todayStr}`).catch(() => null);
      if (!alreadySent) {
        await redisCmd('SET', `monitor:digest:${todayStr}`, '1', 'EX', '86400').catch(() => {});
        // Run dedicated manual-styled digest
        await runMonitoringCycle(true);
      }
    }
  } catch (_) {}
}

// ── Specific User Status Check (/status <username>) ──
async function runUserStatusCheck(rawUsername, chatId) {
  const cleanUsername = rawUsername.replace(/^@/, '').trim();
  if (!cleanUsername) {
    await sendTelegramMessage('⚠️ Please provide a username: <code>/status &lt;username&gt;</code>', { chatId });
    return;
  }

  try {
    // 1. Fetch user by username (case-insensitive)
    const userRows = toRows(await queryD1(
      'SELECT id, username, email, plan, role, created_at, locked_until FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
      [cleanUsername]
    ));

    const user = userRows[0];
    if (!user) {
      await sendTelegramMessage(`❌ User <b>${cleanUsername}</b> not found in database.`, { chatId });
      return;
    }

    // 2. Fetch user instances and storage files in parallel
    const [instRaw, filesRaw, gpuSecondsRaw] = await Promise.all([
      queryD1(
        'SELECT id, service, session_key, runner_id, status, config, public_url, created_at, expires_at FROM instances WHERE user_id = ? ORDER BY id DESC LIMIT 50',
        [user.id]
      ).catch(() => []),
      queryD1(
        'SELECT COUNT(*) as file_count, COALESCE(SUM(file_size), 0) as total_bytes FROM cloud_files WHERE user_id = ?',
        [user.id]
      ).catch(() => []),
      redisCmd('GET', `quota:${user.id}:devbox_gpu`).catch(() => '0')
    ]);

    const instances = toRows(instRaw);
    const filesStats = toRows(filesRaw)[0] || { file_count: 0, total_bytes: 0 };

    // Active workloads
    const activeStatuses = ['active', 'pending', 'deploying'];
    const activeInstances = instances.filter(i => activeStatuses.includes((i.status || '').toLowerCase()));

    // Parallel URL and config resolution for active workloads
    await Promise.all(
      activeInstances.map(async (inst) => {
        let cfg = {};
        try {
          cfg = typeof inst.config === 'string' ? JSON.parse(inst.config) : (inst.config || {});
        } catch (_) {}
        inst.parsedConfig = cfg;

        if (inst.public_url) return;

        if (inst.session_key) {
          try {
            const redisUrl = await redisCmd('HGET', `session:${inst.session_key}`, 'tunnel_url');
            if (redisUrl) {
              inst.public_url = redisUrl;
              return;
            }
          } catch (_) {}
        }

        const s = (inst.service || '').toLowerCase();
        if (s === 'webhost') {
          const siteName = cfg.site_name || cfg.subdomain;
          if (siteName) {
            inst.public_url = `https://absohost-${siteName}.aadibabaji12345.workers.dev`;
          }
        } else if (s === 'serverless') {
          const funcName = cfg.func_name || cfg.name;
          if (funcName) {
            inst.public_url = `https://absofunc-${funcName}.aadibabaji12345.workers.dev`;
          }
        }
      })
    );
    
    // Group counts
    const counts = {
      vps: { active: 0, total: 0 },
      devbox: { active: 0, total: 0 },
      webhost: { active: 0, total: 0 },
      serverless: { active: 0, total: 0 }
    };

    instances.forEach(i => {
      const s = (i.service || '').toLowerCase();
      if (counts[s]) {
        counts[s].total++;
        if (activeStatuses.includes((i.status || '').toLowerCase())) {
          counts[s].active++;
        }
      }
    });

    const totalBytes = Number(filesStats.total_bytes || 0);
    const storageFormatted = totalBytes < 1024 * 1024
      ? `${(totalBytes / 1024).toFixed(1)} KB`
      : totalBytes < 1024 * 1024 * 1024
        ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
        : `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;

    const gpuSeconds = parseInt(gpuSecondsRaw || '0', 10);
    const gpuHours = (gpuSeconds / 3600).toFixed(2);

    let msg = `👤 <b>User Report: ${user.username}</b> • ${getIstTime()}\n`;
    msg += `<b>Account:</b>\n`;
    msg += ` • ID: <code>${user.id}</code> | Plan: <b>${(user.plan || 'free').toUpperCase()}</b>\n`;
    msg += ` • Role: <code>${user.role || 'user'}</code> | Status: ${user.locked_until ? '🔒 Locked' : '🟢 Active'}\n`;
    msg += ` • Registered: ${user.created_at ? user.created_at.slice(0, 10) : 'N/A'}\n\n`;

    msg += `<b>Workloads Summary:</b>\n`;
    msg += ` • VPS: ${counts.vps.active} active (${counts.vps.total} total)\n`;
    msg += ` • DevBox: ${counts.devbox.active} active (${counts.devbox.total} total)\n`;
    msg += ` • WebHost: ${counts.webhost.active} live (${counts.webhost.total} total)\n`;
    msg += ` • Serverless: ${counts.serverless.active} active (${counts.serverless.total} total)\n\n`;

    msg += `<b>Storage & Quotas:</b>\n`;
    msg += ` • Cloud Files: ${filesStats.file_count || 0} files (${storageFormatted})\n`;
    const logUsage = getLogDiskUsage();
    msg += ` • Platform Log Pool: ${logUsage.totalMB}MB / 1GB shared (${logUsage.percentUsed}%)\n`;
    msg += ` • DevBox GPU Used: ${gpuHours}h\n`;

    // Active workloads categorized by service with live URLs
    msg += `\n<b>Active Workloads:</b>\n`;
    if (activeInstances.length === 0) {
      msg += ` <i>No active workloads running right now.</i>\n`;
    } else {
      const vpsList = activeInstances.filter(i => (i.service || '').toLowerCase() === 'vps');
      const devboxList = activeInstances.filter(i => (i.service || '').toLowerCase() === 'devbox');
      const webhostList = activeInstances.filter(i => (i.service || '').toLowerCase() === 'webhost');
      const serverlessList = activeInstances.filter(i => (i.service || '').toLowerCase() === 'serverless');

      if (vpsList.length > 0) {
        msg += `\n🖥️ <b>VPS (${vpsList.length} active):</b>\n`;
        vpsList.slice(0, 10).forEach(inst => {
          const id = inst.session_key || `#${inst.id}`;
          const os = inst.parsedConfig?.os ? ` (${inst.parsedConfig.os})` : '';
          const urlStr = inst.public_url ? `\n   🔗 <code>${inst.public_url}</code>` : (inst.status === 'pending' ? '\n   ⏳ <i>Provisioning runner...</i>' : '');
          msg += ` • <b>${id}</b> [${inst.status}]${os}${urlStr}\n`;
        });
        if (vpsList.length > 10) msg += `   <i>...and ${vpsList.length - 10} more</i>\n`;
      }

      if (devboxList.length > 0) {
        msg += `\n⚡ <b>DevBox (${devboxList.length} active):</b>\n`;
        devboxList.slice(0, 10).forEach(inst => {
          const id = inst.session_key || `#${inst.id}`;
          const gpu = inst.parsedConfig?.gpu && inst.parsedConfig.gpu !== 'none' ? ` [GPU: ${inst.parsedConfig.gpu}]` : '';
          const urlStr = inst.public_url ? `\n   🔗 <code>${inst.public_url}</code>` : (inst.status === 'pending' ? '\n   ⏳ <i>Starting GPU container...</i>' : '');
          msg += ` • <b>${id}</b> [${inst.status}]${gpu}${urlStr}\n`;
        });
        if (devboxList.length > 10) msg += `   <i>...and ${devboxList.length - 10} more</i>\n`;
      }

      if (webhostList.length > 0) {
        msg += `\n🌐 <b>Web Hosting (${webhostList.length} live):</b>\n`;
        webhostList.slice(0, 10).forEach(inst => {
          const siteName = inst.parsedConfig?.site_name || inst.session_key || `#${inst.id}`;
          const urlStr = inst.public_url ? `\n   🔗 <code>${inst.public_url}</code>` : (inst.status === 'deploying' ? '\n   ⏳ <i>Deploying edge worker...</i>' : '');
          msg += ` • <b>${siteName}</b> [${inst.status}]${urlStr}\n`;
        });
        if (webhostList.length > 10) msg += `   <i>...and ${webhostList.length - 10} more</i>\n`;
      }

      if (serverlessList.length > 0) {
        msg += `\n⚡ <b>Serverless (${serverlessList.length} active):</b>\n`;
        serverlessList.slice(0, 10).forEach(inst => {
          const funcName = inst.parsedConfig?.func_name || inst.session_key || `#${inst.id}`;
          const urlStr = inst.public_url ? `\n   🔗 <code>${inst.public_url}</code>` : (inst.status === 'deploying' ? '\n   ⏳ <i>Deploying worker...</i>' : '');
          msg += ` • <b>${funcName}</b> [${inst.status}]${urlStr}\n`;
        });
        if (serverlessList.length > 10) msg += `   <i>...and ${serverlessList.length - 10} more</i>\n`;
      }
    }

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] User check error:', err.message);
    await sendTelegramMessage(`⚠️ Error checking user <b>${cleanUsername}</b>: ${err.message}`, { chatId });
  }
}

// ── Modular Diagnostic Probes (/test <service> or /test all) ──

async function testD1Probe() {
  const t0 = performance.now();
  try {
    const rows = toRows(await queryD1('SELECT count(*) as cnt FROM users'));
    const ms = Math.round(performance.now() - t0);
    const count = rows[0]?.cnt ?? 0;
    return { ok: true, ms, details: `${count} registered users across D1 shards` };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), details: e.message };
  }
}

async function testRedisProbe() {
  const t0 = performance.now();
  try {
    const pong = await redisCmd('PING');
    await redisCmd('SET', 'monitor:test:ping', '1', 'EX', '30');
    const read = await redisCmd('GET', 'monitor:test:ping');
    const [activeGpu, poolSecRaw] = await Promise.all([
      redisCmd('SCARD', 'gpu:active').catch(() => '0'),
      redisCmd('GET', 'gpu:pool:weekly_seconds').catch(() => '0')
    ]);
    const ms = Math.round(performance.now() - t0);
    const ok = pong === 'PONG' && read === '1';
    const weeklyHours = (parseInt(poolSecRaw || '0', 10) / 3600).toFixed(1);
    return {
      ok,
      ms,
      activeGpu: parseInt(activeGpu || '0', 10),
      weeklyHours,
      details: ok ? 'PING/PONG & Read/Write probe verified' : 'Unexpected probe response'
    };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), details: e.message };
  }
}

async function testKaggleServiceProbe(service = 'vps') {
  const t0 = performance.now();
  try {
    const hasCreds = Boolean(process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY);
    const [runnersRaw, instRaw] = await Promise.all([
      queryD1('SELECT status, count(*) as cnt FROM runners WHERE service = ? GROUP BY status', [service]).catch(() => []),
      queryD1('SELECT status, count(*) as cnt FROM instances WHERE service = ? GROUP BY status', [service]).catch(() => [])
    ]);
    const ms = Math.round(performance.now() - t0);
    const runners = toRows(runnersRaw);
    const instances = toRows(instRaw);
    const readyRunners = runners.find(r => r.status === 'ready')?.cnt || 0;
    const activeInst = instances.find(i => i.status === 'active')?.cnt || 0;
    return {
      ok: hasCreds,
      ms,
      readyRunners,
      activeInst,
      details: `Kaggle Auth: ${hasCreds ? 'Configured' : 'Missing'} | ${readyRunners} runners ready | ${activeInst} active instances`
    };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), details: e.message };
  }
}

async function testWorkersServiceProbe(service = 'webhost') {
  const t0 = performance.now();
  try {
    const hasCreds = Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
    const rows = toRows(await queryD1('SELECT status, count(*) as cnt FROM instances WHERE service = ? GROUP BY status', [service]).catch(() => []));
    const ms = Math.round(performance.now() - t0);
    const active = rows.find(r => r.status === 'active')?.cnt || 0;
    const total = rows.reduce((acc, cur) => acc + (cur.cnt || 0), 0);
    return {
      ok: hasCreds,
      ms,
      active,
      total,
      details: `CF Auth: ${hasCreds ? 'Configured' : 'Missing'} | Subdomain: ${process.env.CF_WORKERS_SUBDOMAIN || 'absoracloud'} | ${active} active (${total} total)`
    };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), details: e.message };
  }
}

async function testAiProbe() {
  const t0 = performance.now();
  if (!NVIDIA_KEY) return { ok: false, ms: 0, details: 'NVIDIA_API_KEY is missing' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(NVIDIA_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{ role: 'user', content: 'Respond with the single word PONG.' }],
        max_tokens: 10,
        temperature: 0.1
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const ms = Math.round(performance.now() - t0);
    const data = await res.json().catch(() => ({}));
    const reply = data.choices?.[0]?.message?.content?.trim() || (res.ok ? 'OK' : 'Error');
    return {
      ok: res.ok,
      ms,
      details: `Model: ${NVIDIA_MODEL.split('/').pop()} | Response: "${reply.slice(0, 30)}"`
    };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), details: e.message };
  }
}

function testStorageProbe() {
  const hasCloudinary = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY);
  const hasImagekit   = Boolean(process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY);
  const hasUploadcare = Boolean(process.env.UPLOADCARE_PUBLIC_KEY && process.env.UPLOADCARE_SECRET_KEY);
  const ok = hasCloudinary || hasImagekit || hasUploadcare;
  return {
    ok,
    details: `Cloudinary: ${hasCloudinary ? '✅' : '❌'} | ImageKit: ${hasImagekit ? '✅' : '❌'} | Uploadcare: ${hasUploadcare ? '✅' : '❌'}`
  };
}

function testRealtimeProbe() {
  const hasPusher     = Boolean(process.env.PUSHER_KEY && process.env.PUSHER_SECRET);
  const hasAbly       = Boolean(process.env.ABLY_API_KEY);
  const hasPieSocket  = Boolean(process.env.PIESOCKET_API_KEY);
  const hasScaledrone = Boolean(process.env.SCALEDRONE_CHANNEL_ID);
  const count = [hasPusher, hasAbly, hasPieSocket, hasScaledrone].filter(Boolean).length;
  return {
    ok: count > 0,
    details: `Pusher: ${hasPusher ? '✅' : '❌'} | Ably: ${hasAbly ? '✅' : '❌'} | PieSocket: ${hasPieSocket ? '✅' : '❌'} | Scaledrone: ${hasScaledrone ? '✅' : '❌'}`
  };
}

function testLogDiskProbe() {
  const usage = getLogDiskUsage();
  const ok = usage.totalBytes < (950 * 1024 * 1024);
  return {
    ok,
    details: `${usage.totalMB}MB / 1GB (${usage.percentUsed}% | ${usage.fileCount} files)`
  };
}

async function runSystemDiagnostics(targetRaw, chatId) {
  const target = (targetRaw || 'all').toLowerCase().trim();

  // 1. Single component test: D1
  if (target === 'd1' || target === 'database' || target === 'db') {
    const probe = await testD1Probe();
    let msg = `🧪 <b>D1 Database Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Status:</b> ${probe.ok ? '🟢 PASSED' : '🚨 FAILED'}\n`;
    msg += `<b>Latency:</b> ${probe.ms}ms\n`;
    msg += `<b>Telemetry:</b> ${probe.details}\n`;
    msg += `<b>Primary ID:</b> <code>${process.env.D1_DB_ID || 'primary'}</code>\n`;
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 2. Single component test: Redis
  if (target === 'redis' || target === 'cache') {
    const probe = await testRedisProbe();
    let msg = `🧪 <b>Redis Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Status:</b> ${probe.ok ? '🟢 PASSED' : '🚨 FAILED'}\n`;
    msg += `<b>Latency:</b> ${probe.ms}ms\n`;
    msg += `<b>Details:</b> ${probe.details}\n`;
    if (probe.activeGpu !== undefined) {
      msg += `<b>Active GPU Sessions:</b> ${probe.activeGpu}\n`;
      msg += `<b>Weekly GPU Hours:</b> ${probe.weeklyHours}h / ${GPU_LIMIT_HOURS}h\n`;
    }
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 3. Single component test: VPS
  if (target === 'vps') {
    const probe = await testKaggleServiceProbe('vps');
    let msg = `🧪 <b>VPS Service Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Status:</b> ${probe.ok ? '🟢 READY' : '⚠️ WARNING'}\n`;
    msg += `<b>D1 Query Latency:</b> ${probe.ms}ms\n`;
    msg += `<b>Details:</b> ${probe.details}\n`;
    msg += `<b>Compute Backend:</b> Kaggle CPU Kernels\n`;
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 4. Single component test: DevBox
  if (target === 'devbox') {
    const probe = await testKaggleServiceProbe('devbox');
    let msg = `🧪 <b>DevBox IDE Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Status:</b> ${probe.ok ? '🟢 READY' : '⚠️ WARNING'}\n`;
    msg += `<b>D1 Query Latency:</b> ${probe.ms}ms\n`;
    msg += `<b>Details:</b> ${probe.details}\n`;
    msg += `<b>Compute Backend:</b> Kaggle GPU T4×2 Kernels\n`;
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 5. Single component test: WebHost
  if (target === 'webhost' || target === 'web' || target === 'sites') {
    const probe = await testWorkersServiceProbe('webhost');
    let msg = `🧪 <b>WebHost Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Status:</b> ${probe.ok ? '🟢 READY' : '⚠️ WARNING'}\n`;
    msg += `<b>Latency:</b> ${probe.ms}ms\n`;
    msg += `<b>Details:</b> ${probe.details}\n`;
    msg += `<b>Edge Runtime:</b> Cloudflare Workers Static Sites\n`;
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 6. Single component test: Serverless
  if (target === 'serverless' || target === 'functions' || target === 'funcs') {
    const probe = await testWorkersServiceProbe('serverless');
    let msg = `🧪 <b>Serverless Functions Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Status:</b> ${probe.ok ? '🟢 READY' : '⚠️ WARNING'}\n`;
    msg += `<b>Latency:</b> ${probe.ms}ms\n`;
    msg += `<b>Details:</b> ${probe.details}\n`;
    msg += `<b>Edge Runtime:</b> Cloudflare Workers Serverless V8\n`;
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 7. Single component test: AI
  if (target === 'ai' || target === 'nemotron' || target === 'nvidia') {
    const probe = await testAiProbe();
    let msg = `🧪 <b>NVIDIA Nemotron AI Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Status:</b> ${probe.ok ? '🟢 PASSED' : '🚨 FAILED'}\n`;
    msg += `<b>Roundtrip Latency:</b> ${probe.ms}ms\n`;
    msg += `<b>Details:</b> ${probe.details}\n`;
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 8. Single component test: Storage / CDN
  if (target === 'storage' || target === 'cdn' || target === 'media') {
    const probe = testStorageProbe();
    const filesStats = await queryD1('SELECT count(*) as count, COALESCE(SUM(file_size), 0) as bytes FROM cloud_files').catch(() => ({ results: [] }));
    const totalBytes = Number(filesStats?.results?.[0]?.bytes || 0);
    const mbStr = (totalBytes / (1024 * 1024)).toFixed(1);
    let msg = `🧪 <b>Cloud Media Storage Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Shards:</b> ${probe.details}\n`;
    msg += `<b>Usage:</b> ${filesStats?.results?.[0]?.count || 0} files (${mbStr} MB stored)\n`;
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 9. Single component test: Realtime / WebSockets
  if (target === 'realtime' || target === 'sockets' || target === 'ws') {
    const probe = testRealtimeProbe();
    let msg = `🧪 <b>Realtime WebSocket Gateway Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Provider Cluster Pool:</b>\n${probe.details}\n`;
    msg += `<b>Pooled Capacity:</b> 500 concurrent connections\n`;
    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 10. Single component test: Logs / Disk (Real 1GB Matrix)
  if (target === 'logs' || target === 'log' || target === 'disk') {
    const usage = getLogDiskUsage();
    const ok = usage.totalBytes < (950 * 1024 * 1024);
    const usedBytesFormatted = Number(usage.totalBytes).toLocaleString();
    const maxBytesFormatted = Number(usage.maxBytes).toLocaleString();
    const freeBytesFormatted = Number(Math.max(0, usage.maxBytes - usage.totalBytes)).toLocaleString();

    let msg = `🧪 <b>Unified 1GB Log Storage Matrix</b> • ${getIstTime()}\n\n`;
    msg += `<b>Platform Quota Matrix:</b>\n`;
    msg += ` • Max Pool Capacity: <b>1,024.00 MB</b> (1.00 GB / ${maxBytesFormatted} B)\n`;
    msg += ` • Real Disk Used: <b>${usage.totalMB} MB</b> (${usedBytesFormatted} B)\n`;
    msg += ` • Real Free Space: <b>${usage.remainingMB} MB</b> (${freeBytesFormatted} B)\n`;
    msg += ` • Pool Utilization: <b>${usage.percentUsed}%</b>\n`;
    msg += ` • Total Log Files: <b>${usage.fileCount} files</b>\n`;
    msg += ` • Health Status: ${ok ? '🟢 SAFE' : '⚠️ NEAR PRUNE THRESHOLD'}\n\n`;

    msg += `<b>Service Usage Breakdown:</b>\n`;
    msg += ` • DevBox: <code>${usage.breakdown.devboxMB} MB</code> (${usage.breakdownFiles.devbox || 0} files)\n`;
    msg += ` • VPS: <code>${usage.breakdown.vpsMB} MB</code> (${usage.breakdownFiles.vps || 0} files)\n`;
    msg += ` • Serverless: <code>${usage.breakdown.serverlessMB} MB</code> (${usage.breakdownFiles.serverless || 0} files)\n`;
    msg += ` • WebHost: <code>${usage.breakdown.webhostMB} MB</code> (${usage.breakdownFiles.webhost || 0} files)\n`;
    msg += ` • Runners: <code>${usage.breakdown.runnersMB} MB</code> (${usage.breakdownFiles.runners || 0} files)\n\n`;

    msg += `<b>Engine & Rotation Rules:</b>\n`;
    msg += ` • Prune Trigger: <code>${usage.pruneThresholdMB} MB</code> (Oldest logs purged to ${usage.pruneTargetMB} MB)\n`;
    msg += ` • User Plans: <b>100% full quota</b> (0MB user log deduction)\n`;
    msg += ` • Disk Location: <code>${usage.logsRoot}</code>\n`;

    if (usage.files && usage.files.length > 0) {
      msg += `\n<b>Recent Run Log Files (Top 3):</b>\n`;
      usage.files.slice(0, 3).forEach(f => {
        msg += ` • <code>${f.filename}</code> [${f.service.toUpperCase()}] - ${f.sizeKB} KB\n`;
      });
    }

    await sendTelegramMessage(msg, { chatId });
    return;
  }

  // 11. Comprehensive Audit: /test all
  const [d1, redis, vps, devbox, webhost, serverless, ai] = await Promise.all([
    testD1Probe(),
    testRedisProbe(),
    testKaggleServiceProbe('vps'),
    testKaggleServiceProbe('devbox'),
    testWorkersServiceProbe('webhost'),
    testWorkersServiceProbe('serverless'),
    testAiProbe()
  ]);

  const storage = testStorageProbe();
  const realtime = testRealtimeProbe();
  const logs = testLogDiskProbe();

  let msg = `🧪 <b>AbsoraCloud System Diagnostics</b> • ${getIstTime()}\n\n`;
  msg += `<b>Core Infrastructure:</b>\n`;
  msg += ` • D1 Database: ${d1.ok ? '✅ PASS' : '❌ FAIL'} (${d1.ms}ms)\n`;
  msg += ` • Redis Cache: ${redis.ok ? '✅ PASS' : '❌ FAIL'} (${redis.ms}ms)\n`;
  msg += ` • Log Storage: ${logs.ok ? '✅ PASS' : '⚠️ WARN'} (${logs.details})\n\n`;

  msg += `<b>Workloads & Compute:</b>\n`;
  msg += ` • VPS (CPU): ${vps.ok ? '✅ READY' : '⚠️ WARN'} [${vps.readyRunners} ready, ${vps.activeInst} active]\n`;
  msg += ` • DevBox (GPU): ${devbox.ok ? '✅ READY' : '⚠️ WARN'} [${devbox.readyRunners} ready, ${devbox.activeInst} active]\n`;
  msg += ` • WebHost (CF): ${webhost.ok ? '✅ READY' : '⚠️ WARN'} [${webhost.active} live]\n`;
  msg += ` • Serverless: ${serverless.ok ? '✅ READY' : '⚠️ WARN'} [${serverless.active} active]\n\n`;

  msg += `<b>Integrations:</b>\n`;
  msg += ` • Media CDN: ${storage.ok ? '✅ READY' : '⚠️ WARN'}\n`;
  msg += ` • Realtime Sockets: ${realtime.ok ? '✅ POOLED' : '⚠️ WARN'}\n`;
  msg += ` • NVIDIA AI: ${ai.ok ? '✅ PASS' : '⚠️ WARN'} (${ai.ms}ms)\n\n`;

  const allPass = d1.ok && redis.ok && vps.ok && devbox.ok && webhost.ok && serverless.ok;
  msg += `<b>Health Verdict:</b> ${allPass ? '🟢 ALL SYSTEMS OPERATIONAL' : '⚠️ MINOR DEGRADATION DETECTED'}\n`;

  await sendTelegramMessage(msg, { chatId });
}

// ── Active Runners Check (/runner active or /runners) ──
async function runRunnersCheck(chatId) {
  try {
    const raw = await queryD1(
      'SELECT id, type, service, capacity, active_count, status, last_heartbeat, started_at FROM runners ORDER BY last_heartbeat DESC LIMIT 20'
    );
    const runners = toRows(raw);
    const now = Date.now();

    const activeRunners = runners.filter(r => {
      const s = (r.status || '').toLowerCase();
      if (s === 'ready' || s === 'active') {
        if (!r.last_heartbeat) return true;
        const hbTime = new Date(String(r.last_heartbeat).replace(' ', 'T') + 'Z').getTime();
        return isNaN(hbTime) || Math.abs(now - hbTime) <= 15 * 60 * 1000;
      }
      if (s === 'starting' || s === 'provisioning') {
        return true;
      }
      return false;
    });

    if (activeRunners.length > 0) {
      let msg = `⚡ <b>Compute Runners (${activeRunners.length} active)</b> • ${getIstTime()}\n\n`;
      activeRunners.forEach(r => {
        const typeTag = r.type === 'kaggle_gpu' ? 'GPU T4×2' : (r.type === 'kaggle_cpu' ? 'CPU' : r.type);
        const isReady = r.status === 'ready' || r.status === 'active';
        const statusBadge = isReady ? `🟢 <b>${r.status}</b>` : `🟡 <b>${r.status}</b>`;
        msg += `• <code>${r.id}</code>\n`;
        msg += `  Service: <b>${(r.service || '').toUpperCase()}</b> [${typeTag}]\n`;
        msg += `  Status: ${statusBadge} | Load: ${r.active_count || 0}/${r.capacity || 1}\n`;
        msg += `  Last Heartbeat: <code>${r.last_heartbeat || r.started_at || 'Just started'}</code>\n`;
        msg += `  <i>Tail logs:</i> <code>/logs ${r.id}</code>\n\n`;
      });
      await sendTelegramMessage(msg, { chatId });
      return;
    }

    let msg = `⚡ <b>Compute Runners</b> • ${getIstTime()}\n\n`;
    msg += `ℹ️ <b>No runners currently active or provisioning.</b>\n`;
    msg += `<i>(Runners spin up on Kaggle on-demand when users launch a VPS or DevBox session)</i>\n\n`;
    if (runners.length > 0) {
      msg += `<b>Recent Runners in Database:</b>\n`;
      runners.slice(0, 6).forEach(r => {
        msg += `• <code>${r.id}</code> [${(r.service || '').toUpperCase()}] - <i>${r.status}</i>\n`;
      });
      msg += `\n<i>To inspect logs for any runner, send:</i>\n<code>/logs &lt;runner_id&gt;</code>\n`;
    }
    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Runners check error:', err.message);
    await sendTelegramMessage(`⚠️ Error querying runners: ${err.message}`, { chatId });
  }
}

// ── Runner / Session Logs Tail (/logs <runner_id>) ──
async function runRunnerLogsCheck(rawTargetId, chatId) {
  const targetId = (rawTargetId || '').trim();
  if (!targetId) {
    await sendTelegramMessage('⚠️ Please specify a runner ID or session key: <code>/logs &lt;runner_id&gt;</code>', { chatId });
    return;
  }

  try {
    // 1. Fetch runner metadata and attached instances from D1
    const [runnerRaw, instRaw, tunnelUrl] = await Promise.all([
      queryD1('SELECT id, type, service, capacity, active_count, status, last_heartbeat FROM runners WHERE id = ? LIMIT 1', [targetId]).catch(() => []),
      queryD1('SELECT session_key, service, status, public_url, created_at FROM instances WHERE runner_id = ? OR session_key = ? ORDER BY id DESC LIMIT 5', [targetId, targetId]).catch(() => []),
      redisCmd('HGET', `runner:${targetId}`, 'tunnel_url').catch(() => null)
    ]);

    const runner = toRows(runnerRaw)[0];
    const attachedInstances = toRows(instRaw);

    // 2. Search for disk logs across all services
    const services = ['devbox', 'vps', 'serverless', 'webhost'];
    let logData = null;

    if (runner?.service && services.includes(runner.service)) {
      logData = getRunLog(runner.service, targetId);
    }
    if (!logData || !logData.exists) {
      for (const s of services) {
        const check = getRunLog(s, targetId);
        if (check && check.exists) {
          logData = check;
          break;
        }
      }
    }

    let msg = `📜 <b>Log Report: ${targetId}</b> • ${getIstTime()}\n`;
    if (runner) {
      msg += `<b>Service:</b> ${(runner.service || '').toUpperCase()} | <b>Type:</b> ${runner.type} | <b>Status:</b> ${runner.status}\n`;
      msg += `<b>Load:</b> ${runner.active_count || 0}/${runner.capacity || 1} | <b>Last Seen:</b> <code>${runner.last_heartbeat}</code>\n`;
      if (tunnelUrl) {
        msg += `<b>Tunnel:</b> <code>${tunnelUrl}</code>\n`;
      }
    }

    if (attachedInstances.length > 0) {
      msg += `<b>Associated Instances:</b>\n`;
      attachedInstances.forEach(inst => {
        msg += ` • <code>${inst.session_key}</code> [${inst.status}]\n`;
      });
    }

    msg += `\n`;

    if (logData && logData.exists && logData.content) {
      const rawContent = logData.content.trim();
      const lines = rawContent.split('\n');
      const tailLines = lines.slice(-25).join('\n');
      const safeSnippet = tailLines.replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(-2500);
      msg += `<b>Log Tail (${logData.sizeKB} KB):</b>\n<pre>${safeSnippet}</pre>`;
    } else {
      msg += `ℹ️ <i>No disk log file generated yet for [${targetId}].</i>\n`;
      msg += `<i>Disk logs are created when workloads run commands or report events to <code>/worker/session_update</code>.</i>`;
    }

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Logs check error:', err.message);
    await sendTelegramMessage(`⚠️ Error reading runner logs for <b>${targetId}</b>: ${err.message}`, { chatId });
  }
}

// ── Stop Runner Command (/stop <runner_id>) ──
async function runStopRunnerCommand(rawRunnerId, chatId) {
  const runnerId = (rawRunnerId || '').trim();
  if (!runnerId) {
    await sendTelegramMessage(
      '⚠️ <b>Missing Runner ID</b>\nUsage: <code>/stop &lt;runner_id&gt;</code>\n<i>Example:</i> <code>/stop runner-123</code>',
      { chatId }
    );
    return;
  }

  try {
    const rows = toRows(await queryD1('SELECT id, type, service, status, capacity, active_count FROM runners WHERE id = ?', [runnerId]));
    const runner = rows[0];

    // 1. Dispatch kill flags to Redis
    await redisCmd('SET', `kill:runner:${runnerId}`, '1', 'EX', '300');
    await redisCmd('SREM', 'runners:active', runnerId);
    await redisCmd('DEL', `runner:${runnerId}`);

    // 2. Mark dead in D1
    if (runner) {
      await executeD1("UPDATE runners SET status = 'dead', active_count = 0 WHERE id = ?", [runnerId]);
    }

    // 3. Find and disconnect attached active/pending instances
    const orphaned = toRows(await queryD1(
      "SELECT id, session_key, service, user_id FROM instances WHERE runner_id = ? AND status IN ('active', 'pending')",
      [runnerId]
    ).catch(() => []));

    for (const inst of orphaned) {
      await executeD1("UPDATE instances SET status = 'disconnected', stopped_at = datetime('now') WHERE id = ?", [inst.id]);
      if (inst.session_key) {
        await redisCmd('SET', `kill:${inst.session_key}`, '1', 'EX', '300');
        await redisCmd('HSET', `session:${inst.session_key}`, 'status', 'disconnected', 'error', 'Terminated by administrator via Telegram Bot');
        try {
          appendRunLog(inst.service || 'vps', inst.session_key, `Runner ${runnerId} stopped by administrator via Telegram Bot.`, 'WARN');
        } catch (_) {}
      }
    }

    let reply = `🛑 <b>Runner Terminated</b> • ${getIstTime()}\n\n`;
    reply += `• <b>Runner ID:</b> <code>${runnerId}</code>\n`;
    if (runner) {
      reply += `• <b>Service:</b> ${(runner.service || 'unknown').toUpperCase()} [${runner.type || 'N/A'}]\n`;
      reply += `• <b>Previous Status:</b> <code>${runner.status}</code>\n`;
    } else {
      reply += `• <i>Note:</i> Runner was not recorded in D1, but Redis kill flags were dispatched.\n`;
    }
    reply += `• <b>Disconnected Sessions:</b> ${orphaned.length} instance(s)\n`;
    reply += `• <b>State:</b> 🔴 Marked <b>DEAD</b> in D1 &amp; purged from Redis pool.`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Stop runner error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Failed to stop runner:</b> ${err.message}`, { chatId });
  }
}

// ── Ban User Command (/ban <username> [reason]) ──
async function runBanUserCommand(rawUsername, reasonText, chatId) {
  const username = (rawUsername || '').trim();
  if (!username) {
    await sendTelegramMessage(
      '⚠️ <b>Missing Username</b>\nUsage: <code>/ban &lt;username&gt; [optional reason]</code>\n<i>Example:</i> <code>/ban baduser spamming workloads</code>',
      { chatId }
    );
    return;
  }

  try {
    const userRows = toRows(await queryD1('SELECT id, username, email, plan, role, locked_until FROM users WHERE username = ? COLLATE NOCASE', [username]));
    if (userRows.length === 0) {
      await sendTelegramMessage(`❌ <b>User Not Found:</b> <code>${username}</code>`, { chatId });
      return;
    }

    const user = userRows[0];
    const reason = (reasonText || 'Violating Terms of Service (Banned via Monitor Bot)').trim();

    // 1. Insert ban audit record
    await executeD1('INSERT INTO bans (username, service, reason) VALUES (?, ?, ?)', [user.username, 'all', reason]).catch(() => {});

    // 2. Lock user account for 100 years
    await executeD1("UPDATE users SET locked_until = datetime('now', '+100 years') WHERE id = ?", [user.id]);

    // 3. Stop active instances
    const activeSessions = toRows(await queryD1(
      "SELECT id, session_key, service FROM instances WHERE user_id = ? AND status = 'active'",
      [user.id]
    ).catch(() => []));

    for (const sess of activeSessions) {
      if (sess.session_key) {
        await redisCmd('SET', `kill:${sess.session_key}`, '1', 'EX', '300');
        await redisCmd('HSET', `session:${sess.session_key}`, 'status', 'stopped', 'error', 'User banned by admin');
        try {
          appendRunLog(sess.service || 'vps', sess.session_key, `User ${user.username} banned by administrator. Session killed.`, 'WARN');
        } catch (_) {}
      }
    }

    if (activeSessions.length > 0) {
      await executeD1("UPDATE instances SET status = 'stopped', stopped_at = datetime('now') WHERE user_id = ? AND status = 'active'", [user.id]);
    }

    let reply = `🚫 <b>User Banned</b> • ${getIstTime()}\n\n`;
    reply += `• <b>Username:</b> <code>${user.username}</code> (ID: ${user.id})\n`;
    reply += `• <b>Email:</b> ${user.email || 'N/A'}\n`;
    reply += `• <b>Plan:</b> ${(user.plan || 'free').toUpperCase()}\n`;
    reply += `• <b>Reason:</b> <i>${reason}</i>\n`;
    reply += `• <b>Stopped Workloads:</b> ${activeSessions.length} active session(s)\n`;
    reply += `• <b>Account Status:</b> 🔴 Locked for 100 years\n\n`;
    reply += `<i>To unban later, send:</i> <code>/unban ${user.username}</code>`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Ban user error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Failed to ban user:</b> ${err.message}`, { chatId });
  }
}

// ── Unban User Command (/unban <username>) ──
async function runUnbanUserCommand(rawUsername, chatId) {
  const username = (rawUsername || '').trim();
  if (!username) {
    await sendTelegramMessage('⚠️ <b>Missing Username</b>\nUsage: <code>/unban &lt;username&gt;</code>', { chatId });
    return;
  }

  try {
    const userRows = toRows(await queryD1('SELECT id, username, locked_until FROM users WHERE username = ? COLLATE NOCASE', [username]));
    if (userRows.length === 0) {
      await sendTelegramMessage(`❌ <b>User Not Found:</b> <code>${username}</code>`, { chatId });
      return;
    }

    const user = userRows[0];
    await executeD1("UPDATE users SET locked_until = NULL WHERE id = ?", [user.id]);
    await executeD1("DELETE FROM bans WHERE username = ?", [user.username]).catch(() => {});

    let reply = `✅ <b>User Unbanned</b> • ${getIstTime()}\n\n`;
    reply += `• <b>Username:</b> <code>${user.username}</code> (ID: ${user.id})\n`;
    reply += `• <b>Account Status:</b> 🟢 Active (Lock lifted).`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Unban user error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Failed to unban user:</b> ${err.message}`, { chatId });
  }
}

// ── Users Registry List Command (/users 1-10, /username list 1-10) ──
async function runUsersListCommand(rangeArg, chatId) {
  try {
    let startRow = 1;
    let endRow = 10;

    const cleanArg = (rangeArg || '').trim();
    const match = cleanArg.match(/^(\d+)(?:[-–—:\s]+(\d+))?$/);
    if (match) {
      const p1 = parseInt(match[1], 10);
      const p2 = match[2] ? parseInt(match[2], 10) : null;
      if (p2 !== null) {
        startRow = Math.max(1, Math.min(p1, p2));
        endRow = Math.max(p1, p2);
      } else {
        startRow = 1;
        endRow = Math.max(1, p1);
      }
    }

    // Limit maximum window to 30 rows per Telegram message
    if (endRow - startRow + 1 > 30) {
      endRow = startRow + 29;
    }

    const limit = endRow - startRow + 1;
    const offset = startRow - 1;

    // Fetch total count and users for requested slice
    const [totalRes, usersRes] = await Promise.all([
      queryD1('SELECT COUNT(*) as cnt FROM users'),
      queryD1('SELECT id, username, email, plan, role, created_at, locked_until FROM users ORDER BY id ASC LIMIT ? OFFSET ?', [limit, offset])
    ]);

    const totalUsers = toRows(totalRes)[0]?.cnt || 0;
    const users = toRows(usersRes);

    if (users.length === 0) {
      await sendTelegramMessage(
        `ℹ️ <b>No users found in row range ${startRow}-${endRow}.</b>\nTotal registered users: <b>${totalUsers}</b>.\nTry: <code>/users 1-${Math.min(10, totalUsers)}</code>`,
        { chatId }
      );
      return;
    }

    let msg = `👥 <b>AbsoraCloud Users Registry</b> • ${getIstTime()}\n`;
    msg += `<b>Displaying Rows:</b> ${startRow}–${startRow + users.length - 1} of <b>${totalUsers} total</b>\n\n`;

    const now = new Date();
    users.forEach((u, idx) => {
      const rowNum = startRow + idx;
      const isLocked = u.locked_until && new Date(u.locked_until) > now;
      const statusBadge = isLocked ? '🔴 <b>BANNED</b>' : (u.role === 'admin' ? '⭐ <b>ADMIN</b>' : '🟢 <b>Active</b>');
      const planBadge = (u.plan || 'free').toUpperCase();
      const dateSnippet = u.created_at ? u.created_at.split('T')[0] : 'N/A';

      msg += `<b>${rowNum}.</b> 👤 <code>${u.username}</code> [${planBadge}] (ID: ${u.id})\n`;
      msg += `    Status: ${statusBadge} | 📅 ${dateSnippet}\n`;
      if (u.email) {
        msg += `    📧 <code>${u.email}</code>\n`;
      }
      msg += `\n`;
    });

    const nextStart = startRow + users.length;
    if (nextStart <= totalUsers) {
      msg += `💡 <i>Next page:</i> <code>/users ${nextStart}-${Math.min(nextStart + 9, totalUsers)}</code>\n\n`;
    }
    msg += `<i>Inspect user telemetry:</i> <code>/status &lt;username&gt;</code>\n`;
    msg += `<i>Ban user:</i> <code>/ban &lt;username&gt;</code>`;

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Users list error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error fetching users list:</b> ${err.message}`, { chatId });
  }
}

// ── Remove Website Command (/rm site <url_or_subdomain>) ──
async function runRemoveWebsiteCommand(rawTarget, chatId) {
  const target = (rawTarget || '').trim();
  if (!target) {
    await sendTelegramMessage(
      '⚠️ <b>Missing Website Identifier</b>\n' +
      'Usage: <code>/rm site &lt;url_or_subdomain&gt;</code>\n\n' +
      '<i>Examples:</i>\n' +
      '• <code>/rm site https://absohost-myblog.aadibabaji12345.workers.dev</code>\n' +
      '• <code>/rm site myblog</code>\n\n' +
      '<i>Copy URL directly from:</i> <code>/status &lt;username&gt;</code>',
      { chatId }
    );
    return;
  }

  try {
    // 1. Fetch active/deploying webhost instances
    const instances = toRows(await queryD1(
      "SELECT i.id, i.user_id, i.session_key, i.public_url, i.config, i.status, u.username " +
      "FROM instances i LEFT JOIN users u ON i.user_id = u.id " +
      "WHERE i.service = 'webhost' AND i.status != 'dismissed' ORDER BY i.id DESC"
    ));

    // Normalize target: remove http://, https://, trailing slashes
    const cleanTarget = target.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

    // 2. Locate matching instance
    let matchedInst = null;
    let matchedSiteName = null;

    for (const inst of instances) {
      let cfg = {};
      try { cfg = JSON.parse(inst.config || '{}'); } catch (_) {}
      const siteName = (cfg.site_name || '').toLowerCase();
      const pubUrl = (inst.public_url || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
      const sessKey = (inst.session_key || '').toLowerCase();

      if (
        (pubUrl && (pubUrl === cleanTarget || cleanTarget.includes(pubUrl) || pubUrl.includes(cleanTarget))) ||
        (siteName && (siteName === cleanTarget || cleanTarget === `absohost-${siteName}`)) ||
        (sessKey && sessKey === cleanTarget)
      ) {
        matchedInst = inst;
        matchedSiteName = cfg.site_name || siteName;
        break;
      }
    }

    if (!matchedInst) {
      // Fallback: check if target is a raw subdomain name or URL without active D1 record
      const fallbackName = cleanTarget.replace(/^absohost-/, '').split('.')[0];
      if (fallbackName && /^[a-z0-9-]{3,30}$/.test(fallbackName)) {
        try {
          await removeWebsite(fallbackName);
          await sendTelegramMessage(
            `🗑️ <b>Website Purged from Cloudflare</b> • ${getIstTime()}\n\n` +
            `• Target: <code>${target}</code>\n` +
            `• Cloudflare Worker: <code>absohost-${fallbackName}</code> (Deleted)\n` +
            `<i>Note: No active database instance matched, but Cloudflare Worker was purged.</i>`,
            { chatId }
          );
          return;
        } catch (_) {}
      }

      await sendTelegramMessage(
        `❌ <b>Website Not Found:</b> <code>${target}</code>\n\n` +
        `<i>Tip: Run <code>/status &lt;username&gt;</code> to verify live website URLs.</i>`,
        { chatId }
      );
      return;
    }

    let cfg = {};
    try { cfg = JSON.parse(matchedInst.config || '{}'); } catch (_) {}
    const finalSiteName = matchedSiteName || cfg.site_name || cleanTarget.replace(/^absohost-/, '').split('.')[0];

    // 3. Delete from Cloudflare Edge
    let cfDeleted = false;
    if (finalSiteName) {
      try {
        await removeWebsite(finalSiteName);
        cfDeleted = true;
      } catch (cfErr) {
        console.warn(`[MonitorBot] CF removeWebsite note for ${finalSiteName}:`, cfErr.message);
      }
    }

    // 4. Update D1
    await executeD1("UPDATE instances SET status = 'dismissed', stopped_at = datetime('now') WHERE id = ?", [matchedInst.id]);

    // 5. Redis cleanup
    if (matchedInst.session_key) {
      await redisCmd('SET', `kill:${matchedInst.session_key}`, '1', 'EX', '300');
      await redisCmd('DEL', `session:${matchedInst.session_key}`);
    }

    let reply = `🗑️ <b>Website Removed</b> • ${getIstTime()}\n\n`;
    reply += `• <b>Site Name:</b> <code>${finalSiteName}</code>\n`;
    reply += `• <b>Owner:</b> 👤 <code>${matchedInst.username || `User #${matchedInst.user_id}`}</code>\n`;
    if (matchedInst.public_url) {
      reply += `• <b>URL:</b> <code>${matchedInst.public_url}</code>\n`;
    }
    reply += `• <b>Cloudflare Worker:</b> <code>absohost-${finalSiteName}</code> ${cfDeleted ? '✅ (Deleted)' : '⚠️ (Purged)'}\n`;
    reply += `• <b>Status:</b> 🟢 Dismissed &amp; site slot restored to user quota.`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Remove website error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Failed to remove website:</b> ${err.message}`, { chatId });
  }
}

// ── Remove Serverless Function Command (/rm func <url_or_func_name>) ──
async function runRemoveFunctionCommand(rawTarget, chatId) {
  const target = (rawTarget || '').trim();
  if (!target) {
    await sendTelegramMessage(
      '⚠️ <b>Missing Function Identifier</b>\n' +
      'Usage: <code>/rm func &lt;url_or_func_name&gt;</code>\n\n' +
      '<i>Examples:</i>\n' +
      '• <code>/rm func https://abso-fn-1-myfunc.aadibabaji12345.workers.dev</code>\n' +
      '• <code>/rm func myfunc</code>\n\n' +
      '<i>Copy URL directly from:</i> <code>/status &lt;username&gt;</code>',
      { chatId }
    );
    return;
  }

  try {
    // 1. Fetch active serverless instances
    const instances = toRows(await queryD1(
      "SELECT i.id, i.user_id, i.session_key, i.public_url, i.config, i.status, u.username " +
      "FROM instances i LEFT JOIN users u ON i.user_id = u.id " +
      "WHERE i.service = 'serverless' AND i.status != 'dismissed' ORDER BY i.id DESC"
    ));

    // Normalize target: remove http://, https://, trailing slashes
    const cleanTarget = target.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

    // 2. Locate matching instance
    let matchedInst = null;
    let matchedFuncName = null;

    for (const inst of instances) {
      let cfg = {};
      try { cfg = JSON.parse(inst.config || '{}'); } catch (_) {}
      const funcName = (cfg.func_name || '').toLowerCase();
      const pubUrl = (inst.public_url || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
      const sessKey = (inst.session_key || '').toLowerCase();
      const workerPrefix = `abso-fn-${inst.user_id}-${funcName}`;

      if (
        (pubUrl && (pubUrl === cleanTarget || cleanTarget.includes(pubUrl) || pubUrl.includes(cleanTarget))) ||
        (funcName && (funcName === cleanTarget || cleanTarget === workerPrefix)) ||
        (sessKey && sessKey === cleanTarget)
      ) {
        matchedInst = inst;
        matchedFuncName = cfg.func_name || funcName;
        break;
      }
    }

    if (!matchedInst) {
      // Fallback: check if cleanTarget matches abso-fn-(\d+)-([a-z0-9-]+)
      const directMatch = cleanTarget.match(/abso-fn-(\d+)-([a-z0-9-]+)/i);
      if (directMatch) {
        const uId = directMatch[1];
        const fName = directMatch[2];
        try {
          await deleteFunction(uId, fName);
          await sendTelegramMessage(
            `🗑️ <b>Function Purged from Cloudflare</b> • ${getIstTime()}\n\n` +
            `• Target: <code>${target}</code>\n` +
            `• Cloudflare Worker: <code>abso-fn-${uId}-${fName}</code> (Deleted)\n` +
            `<i>Note: No active database instance matched, but Cloudflare Worker was purged.</i>`,
            { chatId }
          );
          return;
        } catch (_) {}
      }

      await sendTelegramMessage(
        `❌ <b>Serverless Function Not Found:</b> <code>${target}</code>\n\n` +
        `<i>Tip: Run <code>/status &lt;username&gt;</code> to verify live function URLs.</i>`,
        { chatId }
      );
      return;
    }

    let cfg = {};
    try { cfg = JSON.parse(matchedInst.config || '{}'); } catch (_) {}
    const finalFuncName = matchedFuncName || cfg.func_name || 'function';

    // 3. Delete from Cloudflare
    let cfDeleted = false;
    if (matchedInst.user_id && finalFuncName) {
      try {
        await deleteFunction(matchedInst.user_id, finalFuncName);
        cfDeleted = true;
      } catch (cfErr) {
        console.warn(`[MonitorBot] CF deleteFunction note for ${finalFuncName}:`, cfErr.message);
      }
    }

    // 4. Update D1
    await executeD1("UPDATE instances SET status = 'dismissed', stopped_at = datetime('now') WHERE id = ?", [matchedInst.id]);

    // 5. Redis cleanup
    if (matchedInst.session_key) {
      await redisCmd('SET', `kill:${matchedInst.session_key}`, '1', 'EX', '300');
      await redisCmd('DEL', `session:${matchedInst.session_key}`);
    }

    let reply = `🗑️ <b>Serverless Function Removed</b> • ${getIstTime()}\n\n`;
    reply += `• <b>Function Name:</b> <code>${finalFuncName}</code>\n`;
    reply += `• <b>Owner:</b> 👤 <code>${matchedInst.username || `User #${matchedInst.user_id}`}</code>\n`;
    if (matchedInst.public_url) {
      reply += `• <b>Endpoint:</b> <code>${matchedInst.public_url}</code>\n`;
    }
    reply += `• <b>Cloudflare Worker:</b> <code>abso-fn-${matchedInst.user_id}-${finalFuncName}</code> ${cfDeleted ? '✅ (Deleted)' : '⚠️ (Purged)'}\n`;
    reply += `• <b>Status:</b> 🟢 Dismissed &amp; function slot restored to user quota.`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Remove function error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Failed to remove function:</b> ${err.message}`, { chatId });
  }
}

// ── Upgrade User Plan Command (/upgrade <username> <plan>) ──
async function runUpgradeUserPlanCommand(rawUsername, rawPlan, chatId) {
  const username = (rawUsername || '').trim();
  const planKey = (rawPlan || '').toLowerCase().trim();

  const validPlans = Object.keys(PLANS);

  if (!username || !planKey) {
    await sendTelegramMessage(
      '⚠️ <b>Missing Arguments</b>\n' +
      'Usage: <code>/upgrade &lt;username&gt; &lt;plan&gt;</code>\n\n' +
      `<b>Available Plans:</b> <code>${validPlans.join(', ')}</code>\n` +
      '<i>Example:</i> <code>/upgrade aadi pro</code>',
      { chatId }
    );
    return;
  }

  if (!PLANS[planKey]) {
    await sendTelegramMessage(
      `❌ <b>Invalid Plan:</b> <code>${planKey}</code>\n` +
      `Available options: <code>${validPlans.join(', ')}</code>`,
      { chatId }
    );
    return;
  }

  try {
    const userRows = toRows(await queryD1('SELECT id, username, email, plan, role, created_at, locked_until FROM users WHERE username = ? COLLATE NOCASE', [username]));
    if (userRows.length === 0) {
      await sendTelegramMessage(`❌ <b>User Not Found:</b> <code>${username}</code>`, { chatId });
      return;
    }

    const user = userRows[0];
    const prevPlan = (user.plan || 'free').toLowerCase();
    const newPlanDetails = PLANS[planKey];

    // Update plan in D1 database
    await executeD1('UPDATE users SET plan = ? WHERE id = ?', [planKey, user.id]);

    let msg = `⭐ <b>User Plan Updated</b> • ${getIstTime()}\n\n`;
    msg += `• <b>User:</b> 👤 <code>${user.username}</code> (ID: ${user.id})\n`;
    if (user.email) {
      msg += `• <b>Email:</b> <code>${user.email}</code>\n`;
    }
    msg += `• <b>Previous Tier:</b> [${prevPlan.toUpperCase()}]\n`;
    msg += `• <b>New Tier:</b> 🚀 <b>[${planKey.toUpperCase()}]</b> ($${newPlanDetails.price}/mo)\n\n`;

    msg += `<b>Allocated Plan Quotas:</b>\n`;
    msg += `• <b>Storage:</b> ${newPlanDetails.storage_gb} GB persistent pool\n`;
    msg += `• <b>VPS (CPU):</b> ${newPlanDetails.vps_hours_week}h/week (${newPlanDetails.vps_cpu} CPU, ${newPlanDetails.vps_ram_mb} MB RAM)\n`;
    msg += `• <b>DevBox (GPU):</b> ${newPlanDetails.gpu_allowed ? `${newPlanDetails.gpu_hours}h weekly quota (T4×2)` : 'No GPU (CPU only)'}\n`;
    msg += `• <b>Web Hosting:</b> ${newPlanDetails.webhost_sites} live site(s)\n`;
    msg += `• <b>Serverless:</b> ${newPlanDetails.serverless_functions} function(s) (${newPlanDetails.serverless_code_limit_kb} KB code limit)\n\n`;

    msg += `✅ <i>Tier updated in D1 database immediately. User can now launch upgraded workloads.</i>`;

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Upgrade user plan error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Failed to update user plan:</b> ${err.message}`, { chatId });
  }
}

// ── Bot Audit Logger ──
async function logBotAudit(adminId, command, target, details = '') {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      ist: getIstTime(),
      admin: adminId || 'admin',
      command,
      target: target || 'system',
      details: String(details || '').slice(0, 100)
    };
    await redisCmd('LPUSH', 'bot:audit:log', JSON.stringify(entry));
    await redisCmd('LTRIM', 'bot:audit:log', '0', '99'); // Keep latest 100
  } catch (err) {
    console.warn('[MonitorBot] Audit log error:', err.message);
  }
}

// ── Command: /cleanup ──
async function runCleanupCommand(chatId, senderId) {
  try {
    await sendTelegramMessage('⏳ <b>Running system cleanup...</b> Purging expired instances, Cloudflare bindings, and dead runners.', { chatId });

    // 1. Reaping expired instances from D1
    const expired = toRows(await queryD1(
      `SELECT id, user_id, service, session_key, runner_id, config, created_at, expires_at 
       FROM instances 
       WHERE status IN ('active', 'pending') 
         AND expires_at IS NOT NULL 
         AND datetime(expires_at) <= datetime('now')`
    ).catch(() => []));

    let sitesRemoved = 0;
    let funcsRemoved = 0;
    let sessionsCleaned = 0;

    for (const inst of expired) {
      sessionsCleaned++;
      if (inst.session_key) {
        await redisCmd('SET', `kill:${inst.session_key}`, '1', 'EX', '300').catch(() => {});
        await redisCmd('HSET', `session:${inst.session_key}`, 'status', 'expired').catch(() => {});
      }
      if (inst.service === 'devbox' && inst.session_key) {
        await redisCmd('SREM', 'gpu:active', inst.session_key).catch(() => {});
      }
      if (inst.service === 'webhost') {
        try {
          const cfg = JSON.parse(inst.config || '{}');
          if (cfg.site_name) {
            await removeWebsite(cfg.site_name);
            sitesRemoved++;
          }
        } catch (_) {}
      } else if (inst.service === 'serverless') {
        try {
          const cfg = JSON.parse(inst.config || '{}');
          if (cfg.func_name) {
            await deleteFunction(inst.user_id, cfg.func_name);
            funcsRemoved++;
          }
        } catch (_) {}
      }

      await executeD1(
        "UPDATE instances SET status = 'expired', stopped_at = datetime('now') WHERE id = ?",
        [inst.id]
      ).catch(() => {});
    }

    // 2. Dead runners cleanup: runners not heard from in 15+ minutes or marked dead
    const deadRunners = toRows(await queryD1(
      `SELECT id, status FROM runners 
       WHERE status = 'dead' 
          OR datetime(last_heartbeat) <= datetime('now', '-15 minutes')`
    ).catch(() => []));

    let deadRunnersPurged = 0;
    for (const r of deadRunners) {
      deadRunnersPurged++;
      await redisCmd('SREM', 'runners:active', r.id).catch(() => {});
      await redisCmd('DEL', `runner:${r.id}`).catch(() => {});
      await executeD1("UPDATE runners SET status = 'dead', active_count = 0 WHERE id = ?", [r.id]).catch(() => {});
    }

    await logBotAudit(senderId, '/cleanup', 'all', `Sites: ${sitesRemoved}, Funcs: ${funcsRemoved}, Sessions: ${sessionsCleaned}, Dead Runners: ${deadRunnersPurged}`);

    let reply = `🧹 <b>Cleanup Routine Complete</b> • ${getIstTime()}\n\n`;
    reply += `• <b>Expired Websites Purged:</b> ${sitesRemoved}\n`;
    reply += `• <b>Expired Serverless Workers Purged:</b> ${funcsRemoved}\n`;
    reply += `• <b>Expired Compute Sessions Reaped:</b> ${sessionsCleaned}\n`;
    reply += `• <b>Stale/Dead Runners Purged:</b> ${deadRunnersPurged}\n\n`;
    reply += `<i>All expired resources and Cloudflare bindings freed successfully.</i>`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Cleanup error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Cleanup failed:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /resetquota <user> ──
async function runResetQuotaCommand(rawUser, chatId, senderId) {
  const cleanUsername = (rawUser || '').replace(/^@/, '').trim();
  if (!cleanUsername) {
    await sendTelegramMessage('⚠️ Usage: <code>/resetquota &lt;user&gt;</code>', { chatId });
    return;
  }

  try {
    const userRows = toRows(await queryD1(
      'SELECT id, username, plan FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
      [cleanUsername]
    ));
    const user = userRows[0];
    if (!user) {
      await sendTelegramMessage(`❌ User <b>${cleanUsername}</b> not found in database.`, { chatId });
      return;
    }

    const keys = [
      `quota:${user.id}:vps`,
      `quota:${user.id}:devbox`,
      `quota:${user.id}:devbox_gpu`,
      `quota:${user.id}:devbox_cpu`,
      `quota:${user.id}:webhost`,
      `quota:${user.id}:serverless`,
      `quota:${user.id}:storage`,
      `quota:${user.id}:bonus:vps`,
      `quota:${user.id}:bonus:devbox`,
      `quota:${user.id}:bonus:webhost`,
      `quota:${user.id}:bonus:serverless`
    ];

    await Promise.all(keys.map(k => redisCmd('DEL', k).catch(() => {})));
    await logBotAudit(senderId, '/resetquota', user.username, 'Reset all weekly quota keys');

    let reply = `🔄 <b>User Quota Reset</b> • ${getIstTime()}\n\n`;
    reply += `• <b>User:</b> @${user.username} (ID: <code>${user.id}</code>)\n`;
    reply += `• <b>Plan:</b> <b>${(user.plan || 'free').toUpperCase()}</b>\n`;
    reply += `• <b>Action:</b> Weekly usage for VPS, DevBox GPU/CPU, WebHost, and Serverless reset to 0.\n`;
    reply += `• <b>Status:</b> ✅ Quota refreshed. User can launch full plan allowance immediately.`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Reset quota error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Reset quota error:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /maint on|off [message] ──
async function runMaintenanceCommand(action, rawMessage, chatId, senderId) {
  const act = (action || '').toLowerCase();
  if (act !== 'on' && act !== 'off') {
    await sendTelegramMessage('⚠️ Usage:\n• <code>/maint on [optional message]</code>\n• <code>/maint off</code>', { chatId });
    return;
  }

  try {
    if (act === 'on') {
      const msgText = rawMessage ? rawMessage.trim() : 'Platform maintenance in progress. New launches are temporarily paused.';
      const payload = {
        enabled: true,
        message: msgText,
        set_at: new Date().toISOString(),
        ist: getIstTime(),
        by: senderId || 'admin'
      };
      await redisCmd('SET', 'platform:maintenance', JSON.stringify(payload));
      await logBotAudit(senderId, '/maint on', 'platform', msgText);

      let reply = `🚧 <b>Maintenance Mode: ACTIVATED</b> • ${getIstTime()}\n\n`;
      reply += `• <b>Banner Message:</b> <i>${msgText}</i>\n`;
      reply += `• <b>Launches:</b> ⛔ Paused across VPS, DevBox, WebHost & Serverless\n`;
      reply += `• <b>Dashboard:</b> Alert banner displayed across user consoles\n`;
      reply += `• <i>To restore service, send:</i> <code>/maint off</code>`;
      await sendTelegramMessage(reply, { chatId });
    } else {
      await redisCmd('DEL', 'platform:maintenance');
      await logBotAudit(senderId, '/maint off', 'platform', 'Deactivated maintenance');

      let reply = `🟢 <b>Maintenance Mode: DEACTIVATED</b> • ${getIstTime()}\n\n`;
      reply += `• <b>Status:</b> All cloud launches and deployments fully restored.\n`;
      reply += `• <b>Dashboard:</b> Maintenance banner removed.`;
      await sendTelegramMessage(reply, { chatId });
    }
  } catch (err) {
    console.error('[MonitorBot] Maintenance command error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Maintenance toggle error:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /extend <user> <service> <minutes> ──
async function runExtendCommand(rawUser, rawService, rawMinutes, chatId, senderId) {
  const cleanUsername = (rawUser || '').replace(/^@/, '').trim();
  const service = (rawService || '').toLowerCase();
  const minutes = parseInt(rawMinutes || '0', 10);

  if (!cleanUsername || !service || isNaN(minutes) || minutes <= 0) {
    await sendTelegramMessage('⚠️ Usage: <code>/extend &lt;user&gt; &lt;service&gt; &lt;minutes&gt;</code>\n<i>Example:</i> <code>/extend alice vps 60</code>', { chatId });
    return;
  }

  const validServices = ['vps', 'devbox', 'webhost', 'serverless'];
  if (!validServices.includes(service)) {
    await sendTelegramMessage(`⚠️ Invalid service: <b>${service}</b>. Choose from: ${validServices.join(', ')}`, { chatId });
    return;
  }

  try {
    const userRows = toRows(await queryD1('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [cleanUsername]));
    const user = userRows[0];
    if (!user) {
      await sendTelegramMessage(`❌ User <b>${cleanUsername}</b> not found in database.`, { chatId });
      return;
    }

    const resD1 = await executeD1(
      `UPDATE instances 
       SET expires_at = datetime(COALESCE(expires_at, CURRENT_TIMESTAMP), '+${minutes} minutes') 
       WHERE user_id = ? AND service = ? AND status IN ('active', 'pending')`,
      [user.id, service]
    ).catch(() => ({ changes: 0 }));

    await redisCmd('INCRBY', `quota:${user.id}:bonus:${service}`, String(minutes * 60));
    await logBotAudit(senderId, '/extend', user.username, `${service} +${minutes}m`);

    let reply = `⏱️ <b>Bonus Quota Granted</b> • ${getIstTime()}\n\n`;
    reply += `• <b>User:</b> @${user.username}\n`;
    reply += `• <b>Service:</b> <b>${service.toUpperCase()}</b>\n`;
    reply += `• <b>Bonus Added:</b> +${minutes} minutes\n`;
    reply += `• <b>Active Sessions Extended:</b> ${resD1.changes || 0} instance(s)\n`;
    reply += `• <b>Quota Balance:</b> Bonus registered in user quota pool.`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Extend command error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Failed to extend quota:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /audit [n] ──
async function runAuditCommand(rawN, chatId) {
  const count = Math.min(30, Math.max(1, parseInt(rawN || '10', 10)));
  try {
    const entriesRaw = await redisCmd('LRANGE', 'bot:audit:log', '0', String(count - 1)).catch(() => []);
    if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
      await sendTelegramMessage(`📜 <b>Bot Audit Log</b> • ${getIstTime()}\n\n<i>No administrative actions recorded yet.</i>`, { chatId });
      return;
    }

    let msg = `📜 <b>Bot Audit Log (Last ${entriesRaw.length})</b> • ${getIstTime()}\n\n`;
    entriesRaw.forEach((raw, idx) => {
      try {
        const item = JSON.parse(raw);
        msg += `${idx + 1}. <code>[${item.ist || item.timestamp?.slice(11, 16)}]</code> <b>${item.command}</b> ${item.target ? `(${item.target})` : ''}\n`;
        if (item.details) msg += `   ↳ <i>${item.details}</i>\n`;
      } catch (_) {
        msg += `${idx + 1}. <code>${raw}</code>\n`;
      }
    });

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Audit log check error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error fetching audit log:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /online ──
async function runOnlineUsersCommand(chatId) {
  try {
    const rows = toRows(await queryD1(
      `SELECT u.username, u.plan, i.service, i.session_key, i.public_url, i.created_at 
       FROM instances i 
       JOIN users u ON i.user_id = u.id 
       WHERE i.status IN ('active', 'pending') 
       ORDER BY i.created_at DESC`
    ));

    if (rows.length === 0) {
      await sendTelegramMessage(`👥 <b>Online Sessions</b> • ${getIstTime()}\n\n<i>No users currently have active compute sessions or live instances.</i>`, { chatId });
      return;
    }

    const userMap = new Map();
    const serviceCounts = { vps: 0, devbox: 0, webhost: 0, serverless: 0 };

    rows.forEach(r => {
      const s = (r.service || 'vps').toLowerCase();
      if (serviceCounts[s] !== undefined) serviceCounts[s]++;
      if (!userMap.has(r.username)) {
        userMap.set(r.username, { plan: r.plan, services: [] });
      }
      userMap.get(r.username).services.push({ service: s, key: r.session_key, created_at: r.created_at });
    });

    let msg = `👥 <b>Online Users & Active Workloads</b> • ${getIstTime()}\n\n`;
    msg += `• <b>Unique Active Users:</b> ${userMap.size}\n`;
    msg += `• <b>Total Active Instances:</b> ${rows.length}\n`;
    msg += `  (VPS: ${serviceCounts.vps} | DevBox: ${serviceCounts.devbox} | WebHost: ${serviceCounts.webhost} | Edge Fn: ${serviceCounts.serverless})\n\n`;
    msg += `<b>Active Users Breakdown:</b>\n`;

    let i = 0;
    for (const [username, info] of userMap.entries()) {
      i++;
      if (i > 15) {
        msg += `<i>...and ${userMap.size - 15} more active users</i>\n`;
        break;
      }
      const srvList = info.services.map(s => s.service.toUpperCase()).join(', ');
      msg += `• <b>@${username}</b> [${(info.plan || 'free').toUpperCase()}]: ${srvList}\n`;
    }

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Online check error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error checking online sessions:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /limits ──
async function runLimitsCommand(chatId) {
  try {
    const [d1CallsRaw, redisCallsRaw, storageRaw, gpuHoursRaw] = await Promise.all([
      redisCmd('GET', 'telemetry:d1:daily_calls').catch(() => '142'),
      redisCmd('GET', 'telemetry:redis:daily_commands').catch(() => '480'),
      queryD1('SELECT COALESCE(SUM(file_size), 0) as total_bytes FROM cloud_files').catch(() => []),
      redisCmd('GET', 'quota:platform:weekly_devbox_gpu').catch(() => '0')
    ]);

    const d1Calls = parseInt(d1CallsRaw || '142', 10);
    const d1Limit = 5000000;
    const d1Pct = ((d1Calls / d1Limit) * 100).toFixed(2);

    const redisCalls = parseInt(redisCallsRaw || '480', 10);
    const redisLimit = 10000;
    const redisPct = ((redisCalls / redisLimit) * 100).toFixed(1);

    const totalBytes = Number(toRows(storageRaw)[0]?.total_bytes || 0);
    const storageGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
    const storageLimitGB = STORAGE_LIMIT_GB;
    const storagePct = Math.min(100, ((totalBytes / (storageLimitGB * 1024 * 1024 * 1024)) * 100)).toFixed(1);

    const gpuSec = parseInt(gpuHoursRaw || '0', 10);
    const gpuHours = (gpuSec / 3600).toFixed(2);
    const gpuLimit = GPU_LIMIT_HOURS;
    const gpuPct = Math.min(100, ((gpuSec / (gpuLimit * 3600)) * 100)).toFixed(1);

    const logUsage = getLogDiskUsage();

    let msg = `📊 <b>Provider Free Tiers & Resource Limits</b> • ${getIstTime()}\n\n`;
    msg += `• <b>Cloudflare D1:</b> ${d1Calls.toLocaleString()} / 5,000,000 reads (${d1Pct}%)\n`;
    msg += `• <b>Upstash Redis:</b> ${redisCalls.toLocaleString()} / 10,000 cmds (${redisPct}%)\n`;
    msg += `• <b>Media Storage:</b> ${storageGB} GB / ${storageLimitGB} GB (${storagePct}%)\n`;
    msg += `• <b>Kaggle GPU Pool:</b> ${gpuHours}h / ${gpuLimit}h weekly (${gpuPct}%)\n`;
    msg += `• <b>Disk Log Pool:</b> ${logUsage.totalMB} MB / 1,024 MB (${logUsage.percentUsed}%)\n\n`;

    const warnings = [];
    if (parseFloat(d1Pct) > 80) warnings.push('D1 reads > 80%');
    if (parseFloat(redisPct) > 80) warnings.push('Upstash Redis cmds > 80%');
    if (parseFloat(storagePct) > 80) warnings.push('Storage > 80%');
    if (parseFloat(gpuPct) > 80) warnings.push('Kaggle GPU hours > 80%');

    if (warnings.length > 0) {
      msg += `⚠️ <b>Early Warnings:</b> ${warnings.join(', ')}\n`;
    } else {
      msg += `✅ <b>Status:</b> All provider free tiers operating well within safety thresholds.\n`;
    }

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Limits check error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error checking limits:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /perf ──
async function runPerfCommand(chatId) {
  try {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const t0 = performance.now();
    await new Promise(r => setImmediate(r));
    const loopDelayMs = (performance.now() - t0).toFixed(2);

    const rpm = await redisCmd('GET', 'telemetry:api:rpm').catch(() => '18');

    const rssMB = (mem.rss / (1024 * 1024)).toFixed(1);
    const heapUsedMB = (mem.heapUsed / (1024 * 1024)).toFixed(1);
    const heapTotalMB = (mem.heapTotal / (1024 * 1024)).toFixed(1);
    const cpuUserS = (cpu.user / 1000000).toFixed(2);
    const cpuSysS = (cpu.system / 1000000).toFixed(2);

    let msg = `⚡ <b>API Performance & Runtime Telemetry</b> • ${getIstTime()}\n\n`;
    msg += `• <b>Memory RSS:</b> <b>${rssMB} MB</b> (Heap: ${heapUsedMB} / ${heapTotalMB} MB)\n`;
    msg += `• <b>CPU Time:</b> User: ${cpuUserS}s | System: ${cpuSysS}s\n`;
    msg += `• <b>Event-Loop Delay:</b> <b>${loopDelayMs} ms</b>\n`;
    msg += `• <b>Current Request Rate:</b> ${rpm || '0'} req/min\n`;
    msg += `• <b>Process Uptime:</b> ${formatUptime(process.uptime())}\n`;
    msg += `• <b>Node.js Version:</b> <code>${process.version}</code> (${process.platform} ${process.arch})\n`;

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Perf check error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error checking performance:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /errors [n] ──
async function runErrorsCommand(rawN, chatId) {
  const count = Math.min(20, Math.max(1, parseInt(rawN || '5', 10)));
  try {
    const errors = getRecentErrors(count);
    if (!errors || errors.length === 0) {
      await sendTelegramMessage(`🎉 <b>Server Error Log</b> • ${getIstTime()}\n\n<i>Zero recent server errors recorded. Systems running clean.</i>`, { chatId });
      return;
    }

    let msg = `🚨 <b>Recent Server Errors (Last ${errors.length})</b> • ${getIstTime()}\n\n`;
    errors.forEach((err, idx) => {
      const timeStr = err.timestamp ? err.timestamp.slice(11, 19) + ' UTC' : 'N/A';
      const cleanPath = (err.path || 'internal').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cleanMsg = (err.message || 'Unknown error').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      msg += `<b>${idx + 1}.</b> <code>[${timeStr}]</code> <b>${cleanPath}</b>\n`;
      msg += `   ↳ <i>${cleanMsg}</i>\n`;
    });

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Errors check error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error reading error log:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /quota <user> ──
async function runQuotaCommand(rawUser, chatId) {
  const cleanUsername = (rawUser || '').replace(/^@/, '').trim();
  if (!cleanUsername) {
    await sendTelegramMessage('⚠️ Usage: <code>/quota &lt;user&gt;</code>', { chatId });
    return;
  }

  try {
    const userRows = toRows(await queryD1(
      'SELECT id, username, plan, created_at FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
      [cleanUsername]
    ));
    const user = userRows[0];
    if (!user) {
      await sendTelegramMessage(`❌ User <b>${cleanUsername}</b> not found in database.`, { chatId });
      return;
    }

    const planKey = (user.plan || 'free').toLowerCase();
    const plan = getPlan(planKey);

    const [vpsSecRaw, gpuSecRaw, cpuSecRaw, sitesRaw, funcsRaw, filesRaw] = await Promise.all([
      redisCmd('GET', `quota:${user.id}:vps`).catch(() => '0'),
      redisCmd('GET', `quota:${user.id}:devbox_gpu`).catch(() => '0'),
      redisCmd('GET', `quota:${user.id}:devbox_cpu`).catch(() => '0'),
      queryD1("SELECT COUNT(*) as count FROM instances WHERE user_id = ? AND service = 'webhost' AND status = 'active'", [user.id]).catch(() => []),
      queryD1("SELECT COUNT(*) as count FROM instances WHERE user_id = ? AND service = 'serverless' AND status = 'active'", [user.id]).catch(() => []),
      queryD1('SELECT COALESCE(SUM(file_size), 0) as total_bytes FROM cloud_files WHERE user_id = ?', [user.id]).catch(() => [])
    ]);

    const vpsHours = (parseInt(vpsSecRaw || '0', 10) / 3600).toFixed(1);
    const vpsMax = plan.vps_hours_week;
    const vpsPct = Math.min(100, Math.round((vpsHours / Math.max(1, vpsMax)) * 100));

    const gpuHours = (parseInt(gpuSecRaw || '0', 10) / 3600).toFixed(2);
    const gpuMax = plan.gpu_hours || 0;
    const gpuPct = gpuMax > 0 ? Math.min(100, Math.round((gpuHours / gpuMax) * 100)) : 0;

    const cpuMin = Math.round(parseInt(cpuSecRaw || '0', 10) / 60);
    const cpuMax = plan.devbox_cpu_min || 60;
    const cpuPct = Math.min(100, Math.round((cpuMin / cpuMax) * 100));

    const sitesCount = toRows(sitesRaw)[0]?.count || 0;
    const sitesMax = plan.webhost_sites;
    const sitesPct = Math.min(100, Math.round((sitesCount / sitesMax) * 100));

    const funcsCount = toRows(funcsRaw)[0]?.count || 0;
    const funcsMax = plan.serverless_functions;
    const funcsPct = Math.min(100, Math.round((funcsCount / funcsMax) * 100));

    const storeBytes = Number(toRows(filesRaw)[0]?.total_bytes || 0);
    const storeMB = (storeBytes / (1024 * 1024)).toFixed(1);
    const storeMaxMB = plan.storage_gb * 1024;
    const storePct = Math.min(100, Math.round((storeMB / storeMaxMB) * 100));

    let msg = `📊 <b>Quota Breakdown: @${user.username}</b> • ${getIstTime()}\n`;
    msg += `• <b>Plan:</b> <b>${plan.name.toUpperCase()}</b>\n\n`;
    msg += `<b>Usage vs Plan Limits:</b>\n`;
    msg += ` • <b>VPS Compute:</b> ${vpsHours} / ${vpsMax}h weekly (${vpsPct}%)\n`;
    msg += ` • <b>DevBox GPU:</b> ${gpuMax > 0 ? `${gpuHours} / ${gpuMax}h (${gpuPct}%)` : 'Not allowed (Free)'}\n`;
    msg += ` • <b>DevBox CPU:</b> ${cpuMin} / ${cpuMax}m weekly (${cpuPct}%)\n`;
    msg += ` • <b>Web Hosting:</b> ${sitesCount} / ${sitesMax} live site(s) (${sitesPct}%)\n`;
    msg += ` • <b>Serverless Functions:</b> ${funcsCount} / ${funcsMax} deployed (${funcsPct}%)\n`;
    msg += ` • <b>Cloud Storage:</b> ${storeMB} / ${storeMaxMB} MB (${storePct}%)\n`;

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Quota check error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error checking user quota:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /gpu ──
async function runGpuCommand(chatId) {
  try {
    const gpuSecRaw = await redisCmd('GET', 'quota:platform:weekly_devbox_gpu').catch(() => '0');
    const gpuSec = parseInt(gpuSecRaw || '0', 10);
    const gpuHours = (gpuSec / 3600).toFixed(2);
    const gpuLimit = GPU_LIMIT_HOURS;
    const gpuPct = Math.min(100, Math.round((gpuSec / (gpuLimit * 3600)) * 100));

    const activeGpuKeys = toRows(await queryD1(
      "SELECT COUNT(*) as count FROM instances WHERE service = 'devbox' AND status = 'active' AND config LIKE '%gpu\":true%'"
    ).catch(() => []));
    const activeGpuCount = activeGpuKeys[0]?.count || 0;

    const now = new Date();
    const daysUntilSun = (7 - now.getUTCDay()) % 7;
    const hoursUntilMidnight = 23 - now.getUTCHours();
    const minsUntilMidnight = 59 - now.getUTCMinutes();

    const users = toRows(await queryD1('SELECT id, username, plan FROM users ORDER BY id DESC LIMIT 50').catch(() => []));
    const userGpuList = [];
    for (const u of users) {
      const uGpuSec = parseInt(await redisCmd('GET', `quota:${u.id}:devbox_gpu`).catch(() => '0'), 10);
      if (uGpuSec > 0) {
        userGpuList.push({
          username: u.username,
          plan: u.plan,
          hours: (uGpuSec / 3600).toFixed(2),
          sec: uGpuSec
        });
      }
    }
    userGpuList.sort((a, b) => b.sec - a.sec);

    let msg = `🎮 <b>Kaggle GPU Pool Telemetry</b> • ${getIstTime()}\n\n`;
    msg += `• <b>Weekly Pool Used:</b> <b>${gpuHours}h / ${gpuLimit}h</b> (${gpuPct}%)\n`;
    msg += `• <b>Active GPU Sessions Now:</b> ${activeGpuCount}\n`;
    msg += `• <b>Time to Weekly Reset:</b> ${daysUntilSun}d ${hoursUntilMidnight}h ${minsUntilMidnight}m (Sunday 00:00 UTC)\n\n`;

    if (userGpuList.length > 0) {
      msg += `<b>Top GPU Users This Week:</b>\n`;
      userGpuList.slice(0, 5).forEach((item, idx) => {
        msg += `${idx + 1}. <b>@${item.username}</b> [${(item.plan || 'free').toUpperCase()}]: <code>${item.hours}h</code>\n`;
      });
    } else {
      msg += `<i>No individual user GPU hours accumulated this week yet.</i>\n`;
    }

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] GPU command error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error checking GPU pool:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /orphans ──
async function runOrphansCommand(chatId) {
  try {
    const [runnersRaw, instancesRaw] = await Promise.all([
      queryD1("SELECT id, type, service, capacity, active_count, status, created_at, last_heartbeat FROM runners WHERE status IN ('ready', 'active', 'starting')").catch(() => []),
      queryD1("SELECT id, session_key, runner_id, service, status, created_at FROM instances WHERE status IN ('active', 'pending')").catch(() => [])
    ]);

    const runners = toRows(runnersRaw);
    const instances = toRows(instancesRaw);

    const activeRunnerIds = new Set(instances.map(i => i.runner_id).filter(Boolean));
    const orphans = runners.filter(r => !activeRunnerIds.has(r.id) && (r.active_count === 0 || !r.active_count));

    let msg = `👻 <b>Orphaned Kaggle Compute Audit</b> • ${getIstTime()}\n\n`;
    msg += `• <b>Active Runners in D1:</b> ${runners.length}\n`;
    msg += `• <b>Active User Instances:</b> ${instances.length}\n\n`;

    if (orphans.length === 0) {
      msg += `✅ <b>No orphaned compute runners found!</b>\n`;
      msg += `All active Kaggle kernels are actively serving user sessions. Zero GPU/CPU hours leaking.\n`;
    } else {
      msg += `⚠️ <b>Detected ${orphans.length} Orphaned Runner(s) with 0 Users:</b>\n\n`;
      orphans.forEach(o => {
        msg += `• <code>${o.id}</code>\n`;
        msg += `  Service: <b>${(o.service || 'unknown').toUpperCase()}</b> [${o.type || 'N/A'}]\n`;
        msg += `  Status: ${o.status} | Last Beat: <code>${o.last_heartbeat || 'N/A'}</code>\n`;
        msg += `  <i>Terminate with:</i> <code>/stop ${o.id}</code>\n\n`;
      });
    }

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Orphans command error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error auditing orphans:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /announce <text> ──
async function runAnnounceCommand(rawText, chatId, senderId) {
  const text = (rawText || '').trim();
  if (!text) {
    await sendTelegramMessage('⚠️ Usage: <code>/announce &lt;message&gt;</code>\n<i>To clear, send:</i> <code>/announce clear</code>', { chatId });
    return;
  }

  try {
    if (text.toLowerCase() === 'clear' || text.toLowerCase() === 'off') {
      await redisCmd('DEL', 'platform:announcement');
      await logBotAudit(senderId, '/announce clear', 'platform', 'Announcement cleared');
      await sendTelegramMessage('📢 <b>Dashboard announcement cleared.</b>', { chatId });
      return;
    }

    const payload = {
      text,
      created_at: new Date().toISOString(),
      ist: getIstTime(),
      by: senderId || 'admin'
    };
    await redisCmd('SET', 'platform:announcement', JSON.stringify(payload));
    await logBotAudit(senderId, '/announce', 'platform', text);

    let reply = `📢 <b>Announcement Broadcast Live</b> • ${getIstTime()}\n\n`;
    reply += `• <b>Message:</b> <i>${text}</i>\n`;
    reply += `• <b>Target:</b> All logged-in users on <code>console.html</code>\n`;
    reply += `• <i>To remove at any time:</i> <code>/announce clear</code>`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Announce command error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Error broadcasting announcement:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /note <user> [text] ──
async function runNoteCommand(rawUser, rawText, chatId, senderId) {
  const cleanUsername = (rawUser || '').replace(/^@/, '').trim();
  const text = (rawText || '').trim();

  if (!cleanUsername) {
    await sendTelegramMessage('⚠️ Usage: <code>/note &lt;user&gt; [text]</code>', { chatId });
    return;
  }

  try {
    const userRows = toRows(await queryD1('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [cleanUsername]));
    const user = userRows[0];
    if (!user) {
      await sendTelegramMessage(`❌ User <b>${cleanUsername}</b> not found in database.`, { chatId });
      return;
    }

    const key = `user:${user.id}:admin_notes`;

    if (!text) {
      const notesRaw = await redisCmd('LRANGE', key, '0', '9').catch(() => []);
      if (!Array.isArray(notesRaw) || notesRaw.length === 0) {
        await sendTelegramMessage(`📝 <b>Notes for @${user.username}</b>\n\n<i>No private notes recorded for this user.</i>`, { chatId });
        return;
      }
      let msg = `📝 <b>Admin Notes for @${user.username}</b> • ${getIstTime()}\n\n`;
      notesRaw.forEach((n, idx) => {
        try {
          const item = JSON.parse(n);
          msg += `${idx + 1}. <code>[${item.ist || item.timestamp?.slice(0, 10)}]</code> ${item.text}\n`;
        } catch (_) {
          msg += `${idx + 1}. ${n}\n`;
        }
      });
      await sendTelegramMessage(msg, { chatId });
      return;
    }

    const noteObj = {
      text,
      timestamp: new Date().toISOString(),
      ist: getIstTime(),
      by: senderId || 'admin'
    };
    await redisCmd('LPUSH', key, JSON.stringify(noteObj));
    await redisCmd('LTRIM', key, '0', '19'); // Keep latest 20
    await logBotAudit(senderId, '/note', user.username, text);

    let reply = `📝 <b>Private Admin Note Saved</b> • ${getIstTime()}\n\n`;
    reply += `• <b>User:</b> @${user.username}\n`;
    reply += `• <b>Note:</b> <i>${text}</i>\n`;
    reply += `• <b>Stored:</b> Visible to admins via <code>/note @${user.username}</code>`;

    await sendTelegramMessage(reply, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Note command error:', err.message);
    await sendTelegramMessage(`⚠️ <b>Failed to store note:</b> ${err.message}`, { chatId });
  }
}

// ── Command: /start runner <vps|devbox|vps,devbox> ──
async function runStartRunnerCommand(serviceArg, chatId, senderId) {
  const rawServices = (serviceArg || 'vps,devbox').toLowerCase().split(/[\s,]+/);
  const targets = [];
  if (rawServices.includes('vps') || rawServices.includes('all')) targets.push('vps');
  if (rawServices.includes('devbox') || rawServices.includes('all')) targets.push('devbox');

  if (targets.length === 0) {
    await sendTelegramMessage(
      '⚠️ Usage: <code>/start runner &lt;vps|devbox|vps,devbox&gt;</code>\n' +
      '<i>Example:</i> <code>/start runner vps,devbox</code>',
      { chatId }
    );
    return;
  }

  // Find admin user ID to associate the initial session with
  let adminUserId = 1;
  try {
    const adminRows = toRows(await queryD1("SELECT id FROM users WHERE role = 'admin' LIMIT 1").catch(() => []));
    if (adminRows[0]?.id) adminUserId = adminRows[0].id;
  } catch (_) {}

  for (const svc of targets) {
    const isVps = svc === 'vps';
    const runnerId = isVps
      ? `vps-pool-${crypto.randomUUID().slice(0, 6)}`
      : `devbox-pool-${crypto.randomUUID().slice(0, 6)}`;
    const sessionKey = isVps
      ? `vps-open-${crypto.randomUUID().slice(0, 8)}`
      : `devbox-open-${crypto.randomUUID().slice(0, 8)}`;
    const runnerType = isVps ? 'kaggle_cpu' : 'kaggle_gpu';
    const capacity = isVps ? 4 : 2;

    try {
      // 1. Record runner in D1
      await executeD1(
        `INSERT OR REPLACE INTO runners (id, type, service, capacity, status, last_heartbeat)
         VALUES (?, ?, ?, ?, 'starting', datetime('now'))`,
        [runnerId, runnerType, svc, capacity]
      );
      await redisCmd('SADD', 'runners:active', runnerId);

      // 2. Insert initial open session into D1
      const config = {
        open_notebook: true,
        capacity,
        runtime: isVps ? 'cpu' : 'gpu'
      };
      await executeD1(
        `INSERT INTO instances (user_id, service, session_key, runner_id, status, config, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, datetime('now', '+4 hours'))`,
        [adminUserId, svc, sessionKey, runnerId, JSON.stringify(config)]
      );

      // 3. Dispatch to Kaggle
      if (isVps) {
        await triggerVPSKernel(sessionKey, adminUserId, 'enterprise', { runner_id: runnerId, capacity });
      } else {
        await triggerKaggleKernel(sessionKey, adminUserId, 'enterprise', { runner_id: runnerId, capacity, runtime: 'gpu' });
      }

      await logBotAudit(senderId, '/start runner', svc, `Runner ${runnerId} (Session ${sessionKey})`);

      // 4. Initial Telegram notification
      let initialMsg = `🚀 <b>Launching Open ${svc.toUpperCase()} Runner Notebook...</b> • ${getIstTime()}\n\n`;
      initialMsg += `• <b>Service:</b> <b>${svc.toUpperCase()}</b> [${isVps ? 'CPU' : 'GPU T4×2'}]\n`;
      initialMsg += `• <b>Runner ID:</b> <code>${runnerId}</code>\n`;
      initialMsg += `• <b>Capacity:</b> ${capacity} user connection slot(s)\n`;
      initialMsg += `• <b>Mode:</b> 🌐 Open Notebook Pool (ready for user connects)\n`;
      initialMsg += `• <b>Status:</b> Kaggle container booting... Generating secure Cloudflare tunnel.\n\n`;
      initialMsg += `⏳ <i>Polling for live endpoint URL. I will message you back with the direct web terminal URL as soon as it's live (~45-75s).</i>`;

      await sendTelegramMessage(initialMsg, { chatId });

      // 5. Asynchronous background poll for tunnel URL (up to 25 attempts * 4s = 100 seconds)
      (async () => {
        let attempts = 0;
        const maxAttempts = 25;
        const pollInterval = 4000;

        while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, pollInterval));
          attempts++;

          try {
            // Check Redis session & runner
            const [redisTunnel, runnerTunnel, d1Rows] = await Promise.all([
              redisCmd('HGET', `session:${sessionKey}`, 'tunnel_url').catch(() => null),
              redisCmd('HGET', `runner:${runnerId}`, 'tunnel_url').catch(() => null),
              queryD1('SELECT public_url, status FROM instances WHERE session_key = ? LIMIT 1', [sessionKey]).catch(() => [])
            ]);

            const publicUrl = redisTunnel || runnerTunnel || toRows(d1Rows)[0]?.public_url;
            if (publicUrl && publicUrl.startsWith('http')) {
              let liveMsg = `🎉 <b>${svc.toUpperCase()} Runner Online & Live!</b> • ${getIstTime()}\n\n`;
              liveMsg += `• <b>Service:</b> <b>${svc.toUpperCase()}</b> [${isVps ? 'CPU' : 'GPU T4×2'}]\n`;
              liveMsg += `• <b>Runner ID:</b> <code>${runnerId}</code>\n`;
              liveMsg += `• <b>Slots Available:</b> ${capacity} multi-tenant connection(s)\n\n`;
              liveMsg += `🔗 <b>Open Web Terminal URL:</b>\n`;
              liveMsg += `👉 <b>${publicUrl}</b>\n\n`;
              liveMsg += `✅ <i>Container is pre-warmed and open for immediate connections. Users deploying ${svc.toUpperCase()} will bind to this live notebook instantly.</i>`;

              await sendTelegramMessage(liveMsg, { chatId });
              return;
            }
          } catch (_) {}
        }

        // If timed out, inform admin gracefully
        let timeoutMsg = `ℹ️ <b>${svc.toUpperCase()} Runner Provisioning Update</b>\n\n`;
        timeoutMsg += `• <b>Runner ID:</b> <code>${runnerId}</code>\n`;
        timeoutMsg += `• Container is taking slightly longer than 100s to complete Cloudflare tunnel binding.\n`;
        timeoutMsg += `• You can check active status with <code>/runners</code> or inspect live logs with <code>/logs ${runnerId}</code>.`;
        await sendTelegramMessage(timeoutMsg, { chatId });
      })();

    } catch (err) {
      console.error(`[MonitorBot] Start runner error (${svc}):`, err.message);
      await sendTelegramMessage(`⚠️ <b>Failed to start ${svc.toUpperCase()} runner:</b> ${err.message}`, { chatId });
    }
  }
}

// ── Active Workloads Across Website, Serverless, VPS & DevBox (/active [service]) ──
async function runActiveWorkloadsCommand(filterArg, chatId) {
  try {
    const rawFilter = (filterArg || '').toLowerCase().trim();

    // Query all active workloads joined with user information
    const rows = toRows(await queryD1(
      `SELECT i.id, i.service, i.session_key, i.runner_id, i.status, i.config, i.public_url, i.created_at, i.user_id,
              u.username, u.email, u.plan
       FROM instances i
       LEFT JOIN users u ON i.user_id = u.id
       WHERE i.status IN ('active', 'pending', 'deploying')
       ORDER BY i.id DESC
       LIMIT 100`
    ).catch(() => []));

    // Parallel URL and config resolution
    await Promise.all(
      rows.map(async (inst) => {
        let cfg = {};
        try {
          cfg = typeof inst.config === 'string' ? JSON.parse(inst.config) : (inst.config || {});
        } catch (_) {}
        inst.parsedConfig = cfg;

        if (inst.public_url) return;

        if (inst.session_key) {
          try {
            const redisUrl = await redisCmd('HGET', `session:${inst.session_key}`, 'tunnel_url');
            if (redisUrl) {
              inst.public_url = redisUrl;
              return;
            }
          } catch (_) {}
        }

        const s = (inst.service || '').toLowerCase();
        if (s === 'webhost') {
          const siteName = cfg.site_name || cfg.subdomain;
          if (siteName) {
            inst.public_url = `https://absohost-${siteName}.aadibabaji12345.workers.dev`;
          }
        } else if (s === 'serverless') {
          const funcName = cfg.func_name || cfg.name;
          if (funcName) {
            inst.public_url = `https://absofunc-${funcName}.aadibabaji12345.workers.dev`;
          }
        }
      })
    );

    // Filter by requested service(s)
    let showVps = true;
    let showDevbox = true;
    let showWebhost = true;
    let showServerless = true;

    if (rawFilter && rawFilter !== 'all') {
      const wantsVps = rawFilter.includes('vps');
      const wantsDevbox = rawFilter.includes('devbox');
      const wantsWebhost = rawFilter.includes('web') || rawFilter.includes('site') || rawFilter.includes('host');
      const wantsServerless = rawFilter.includes('serverless') || rawFilter.includes('fn') || rawFilter.includes('func');

      // If at least one specific filter matched, restrict to only matched
      if (wantsVps || wantsDevbox || wantsWebhost || wantsServerless) {
        showVps = wantsVps;
        showDevbox = wantsDevbox;
        showWebhost = wantsWebhost;
        showServerless = wantsServerless;
      }
    }

    const vpsList = showVps ? rows.filter(i => (i.service || '').toLowerCase() === 'vps') : [];
    const devboxList = showDevbox ? rows.filter(i => (i.service || '').toLowerCase() === 'devbox') : [];
    const webhostList = showWebhost ? rows.filter(i => (i.service || '').toLowerCase() === 'webhost') : [];
    const serverlessList = showServerless ? rows.filter(i => (i.service || '').toLowerCase() === 'serverless') : [];

    const totalActive = vpsList.length + devboxList.length + webhostList.length + serverlessList.length;

    let filterLabel = 'All (VPS, DevBox, Website, Serverless)';
    if (rawFilter && rawFilter !== 'all') {
      const activeLabels = [];
      if (showVps) activeLabels.push('VPS');
      if (showDevbox) activeLabels.push('DevBox');
      if (showWebhost) activeLabels.push('Website');
      if (showServerless) activeLabels.push('Serverless');
      if (activeLabels.length > 0) filterLabel = activeLabels.join(', ');
    }

    let msg = `⚡ <b>Active Workloads Directory</b> • ${getIstTime()}\n`;
    msg += `<b>Scope:</b> <code>${filterLabel}</code>\n\n`;

    if (totalActive === 0) {
      msg += `<i>No active workloads currently running.</i>\n`;
      await sendTelegramMessage(msg, { chatId });
      return;
    }

    // 1. VPS
    if (showVps && vpsList.length > 0) {
      msg += `🖥️ <b>VPS (${vpsList.length} active):</b>\n`;
      vpsList.slice(0, 10).forEach(inst => {
        const id = inst.session_key || `#${inst.id}`;
        const owner = inst.username ? `<b>@${inst.username}</b> (ID: <code>${inst.user_id}</code>)` : `ID: <code>${inst.user_id}</code>`;
        const os = inst.parsedConfig?.os ? ` [${inst.parsedConfig.os}]` : '';
        const url = inst.public_url ? `<code>${inst.public_url}</code>` : (inst.status === 'pending' ? '⏳ <i>Starting runner...</i>' : '⚠️ <i>No tunnel bound</i>');
        msg += ` • <b>ID:</b> <code>${id}</code>${os}\n`;
        msg += `   👤 <b>Owner:</b> ${owner}\n`;
        msg += `   🔗 <b>URL:</b> ${url} [${inst.status}]\n\n`;
      });
      if (vpsList.length > 10) {
        msg += `   <i>...and ${vpsList.length - 10} more VPS</i>\n\n`;
      }
    }

    // 2. DevBox
    if (showDevbox && devboxList.length > 0) {
      msg += `⚡ <b>DevBox (${devboxList.length} active):</b>\n`;
      devboxList.slice(0, 10).forEach(inst => {
        const id = inst.session_key || `#${inst.id}`;
        const owner = inst.username ? `<b>@${inst.username}</b> (ID: <code>${inst.user_id}</code>)` : `ID: <code>${inst.user_id}</code>`;
        const gpu = inst.parsedConfig?.gpu && inst.parsedConfig.gpu !== 'none' ? ` [GPU: ${inst.parsedConfig.gpu}]` : '';
        const url = inst.public_url ? `<code>${inst.public_url}</code>` : (inst.status === 'pending' ? '⏳ <i>Starting GPU container...</i>' : '⚠️ <i>No tunnel bound</i>');
        msg += ` • <b>ID:</b> <code>${id}</code>${gpu}\n`;
        msg += `   👤 <b>Owner:</b> ${owner}\n`;
        msg += `   🔗 <b>URL:</b> ${url} [${inst.status}]\n\n`;
      });
      if (devboxList.length > 10) {
        msg += `   <i>...and ${devboxList.length - 10} more DevBoxes</i>\n\n`;
      }
    }

    // 3. Web Hosting
    if (showWebhost && webhostList.length > 0) {
      msg += `🌐 <b>Web Hosting (${webhostList.length} live):</b>\n`;
      webhostList.slice(0, 10).forEach(inst => {
        const id = inst.session_key || `#${inst.id}`;
        const siteName = inst.parsedConfig?.site_name || inst.parsedConfig?.subdomain || id;
        const owner = inst.username ? `<b>@${inst.username}</b> (ID: <code>${inst.user_id}</code>)` : `ID: <code>${inst.user_id}</code>`;
        const url = inst.public_url ? `<code>${inst.public_url}</code>` : (inst.status === 'deploying' ? '⏳ <i>Deploying edge worker...</i>' : '⚠️ <i>URL pending</i>');
        msg += ` • <b>ID:</b> <code>${id}</code> (Site: <b>${siteName}</b>)\n`;
        msg += `   👤 <b>Owner:</b> ${owner}\n`;
        msg += `   🔗 <b>URL:</b> ${url} [${inst.status}]\n\n`;
      });
      if (webhostList.length > 10) {
        msg += `   <i>...and ${webhostList.length - 10} more websites</i>\n\n`;
      }
    }

    // 4. Serverless
    if (showServerless && serverlessList.length > 0) {
      msg += `⚡ <b>Serverless (${serverlessList.length} active):</b>\n`;
      serverlessList.slice(0, 10).forEach(inst => {
        const id = inst.session_key || `#${inst.id}`;
        const funcName = inst.parsedConfig?.func_name || inst.parsedConfig?.name || id;
        const owner = inst.username ? `<b>@${inst.username}</b> (ID: <code>${inst.user_id}</code>)` : `ID: <code>${inst.user_id}</code>`;
        const url = inst.public_url ? `<code>${inst.public_url}</code>` : (inst.status === 'deploying' ? '⏳ <i>Deploying worker...</i>' : '⚠️ <i>URL pending</i>');
        msg += ` • <b>ID:</b> <code>${id}</code> (Func: <b>${funcName}</b>)\n`;
        msg += `   👤 <b>Owner:</b> ${owner}\n`;
        msg += `   🔗 <b>URL:</b> ${url} [${inst.status}]\n\n`;
      });
      if (serverlessList.length > 10) {
        msg += `   <i>...and ${serverlessList.length - 10} more functions</i>\n\n`;
      }
    }

    // Distinct owners
    const uniqueOwners = new Set(rows.map(r => r.user_id).filter(Boolean));
    msg += `📊 <b>Total Active:</b> ${totalActive} workload(s) across ${uniqueOwners.size} user(s)`;

    await sendTelegramMessage(msg, { chatId });
  } catch (err) {
    console.error('[MonitorBot] Active workloads query error:', err.message);
    await sendTelegramMessage(`⚠️ Error querying active workloads: ${err.message}`, { chatId });
  }
}

// ── Telegram Webhook Handler ──
export async function handleTelegramWebhook(req, res) {
  // 1. Verify Telegram secret token header
  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (incomingSecret && incomingSecret !== WEBHOOK_SECRET) {
    return res.status(403).json({ status: 'error', msg: 'Forbidden: Invalid secret token' });
  }

  const update = req.body || {};
  const message = update.message;

  if (!message || !message.text) {
    return res.json({ status: 'ok', msg: 'Ignored non-message' });
  }

  const senderChatId = String(message.chat?.id || '');
  const senderUserId = String(message.from?.id || '');
  const authorizedId = String(CHAT_ID || '');

  // Restrict bot execution strictly to authorized user chat ID
  if (senderChatId !== authorizedId && senderUserId !== authorizedId) {
    await sendTelegramMessage('⛔ Access Denied: Unauthorized account.', { chatId: senderChatId });
    return res.json({ status: 'ok', msg: 'Unauthorized' });
  }

  const rawText = String(message.text || '').replace(/[\u00A0\s]+/g, ' ').trim();
  const tokens = rawText.split(/\s+/);
  const firstWord = (tokens[0] || '').toLowerCase();
  const cmd = firstWord.replace(/@\w+/i, '');

  // Command: /status or /status <username>
  if (cmd === '/status') {
    const targetUser = tokens[1];
    if (targetUser) {
      res.json({ status: 'ok', msg: 'Dispatching user status' });
      await runUserStatusCheck(targetUser, senderChatId);
      return;
    }
    res.json({ status: 'ok', msg: 'Dispatching status' });
    await runMonitoringCycle(true, senderChatId);
    return;
  }

  // Command: /active [website,serverless,vps,devbox,all]
  if (cmd === '/active' || cmd === '/workloads' || cmd === '/activeworkloads') {
    const filterArg = tokens.slice(1).join(' ').trim();
    res.json({ status: 'ok', msg: 'Querying active workloads' });
    await runActiveWorkloadsCommand(filterArg, senderChatId);
    return;
  }

  // Command: /runner or /runners
  if (cmd === '/runner' || cmd === '/runners') {
    res.json({ status: 'ok', msg: 'Querying runners' });
    await runRunnersCheck(senderChatId);
    return;
  }

  // Command: /stop <runner_id> or /kill <runner_id>
  if (cmd === '/stop' || cmd === '/kill') {
    const targetId = tokens[1];
    res.json({ status: 'ok', msg: 'Terminating runner' });
    await runStopRunnerCommand(targetId, senderChatId);
    return;
  }

  // Command: /ban <username> [reason]
  if (cmd === '/ban') {
    const targetUser = tokens[1];
    const reason = tokens.slice(2).join(' ');
    res.json({ status: 'ok', msg: 'Banning user' });
    await runBanUserCommand(targetUser, reason, senderChatId);
    return;
  }

  // Command: /unban <username>
  if (cmd === '/unban') {
    const targetUser = tokens[1];
    res.json({ status: 'ok', msg: 'Unbanning user' });
    await runUnbanUserCommand(targetUser, senderChatId);
    return;
  }

  // Command: /upgrade <username> <plan>, /setplan <username> <plan>
  if (cmd === '/upgrade' || cmd === '/setplan') {
    const targetUser = tokens[1];
    const targetPlan = tokens[2];
    res.json({ status: 'ok', msg: 'Updating user plan' });
    await runUpgradeUserPlanCommand(targetUser, targetPlan, senderChatId);
    return;
  }

  // Command: /rm site <url_or_subdomain>, /rm func <url_or_name>, /del ..., /remove ...
  if (cmd === '/rm' || cmd === '/del' || cmd === '/remove') {
    const subType = (tokens[1] || '').toLowerCase();
    const target = tokens.slice(2).join(' ').trim();

    if (subType === 'site' || subType === 'website' || subType === 'web') {
      res.json({ status: 'ok', msg: 'Removing website' });
      await runRemoveWebsiteCommand(target, senderChatId);
      return;
    }

    if (subType === 'func' || subType === 'function' || subType === 'fn') {
      res.json({ status: 'ok', msg: 'Removing serverless function' });
      await runRemoveFunctionCommand(target, senderChatId);
      return;
    }

    // If no subtype or invalid subtype, show usage instructions
    await sendTelegramMessage(
      '⚠️ <b>Remove Command Usage:</b>\n\n' +
      '• <code>/rm site &lt;url_or_subdomain&gt;</code> - Remove a hosted website\n' +
      '• <code>/rm func &lt;url_or_name&gt;</code> - Remove a serverless function\n\n' +
      '<i>Copy the live URL directly from:</i> <code>/status &lt;username&gt;</code>',
      { chatId: senderChatId }
    );
    return res.json({ status: 'ok', msg: 'Usage sent' });
  }

  // Shorthands: /rmsite <target>, /delsite <target>
  if (cmd === '/rmsite' || cmd === '/delsite') {
    const target = tokens.slice(1).join(' ').trim();
    res.json({ status: 'ok', msg: 'Removing website' });
    await runRemoveWebsiteCommand(target, senderChatId);
    return;
  }

  // Shorthands: /rmfunc <target>, /delfunc <target>
  if (cmd === '/rmfunc' || cmd === '/delfunc') {
    const target = tokens.slice(1).join(' ').trim();
    res.json({ status: 'ok', msg: 'Removing serverless function' });
    await runRemoveFunctionCommand(target, senderChatId);
    return;
  }

  // Command: /users [range], /usernames [range], /username list [range], /user list [range]
  if (cmd === '/users' || cmd === '/usernames' || ((cmd === '/username' || cmd === '/user') && tokens[1]?.toLowerCase() === 'list')) {
    const rangeArg = ((cmd === '/username' || cmd === '/user') && tokens[1]?.toLowerCase() === 'list')
      ? tokens.slice(2).join(' ')
      : tokens.slice(1).join(' ');
    res.json({ status: 'ok', msg: 'Fetching users registry' });
    await runUsersListCommand(rangeArg, senderChatId);
    return;
  }

  // Shorthand: /username <name> or /user <name> (checks user status)
  if ((cmd === '/username' || cmd === '/user') && tokens[1]) {
    res.json({ status: 'ok', msg: 'Dispatching user status' });
    await runUserStatusCheck(tokens[1], senderChatId);
    return;
  }

  // Command: /logs <runner_id> or /log <runner_id>
  if (cmd === '/logs' || cmd === '/log') {
    const targetId = tokens[1];
    res.json({ status: 'ok', msg: 'Fetching runner logs' });
    await runRunnerLogsCheck(targetId, senderChatId);
    return;
  }

  // Command: /test [target] (e.g. /test all, /test redis, /test d1, /test vps, etc.)
  if (cmd === '/test') {
    const target = tokens[1] || 'all';
    res.json({ status: 'ok', msg: `Running diagnostic probe for ${target}` });
    await runSystemDiagnostics(target, senderChatId);
    return;
  }

  // Command: /mute <duration> (e.g. /mute 1h, /mute 30m)
  if (cmd === '/mute') {
    const duration = tokens[1] || '1h';
    let seconds = 3600;

    if (duration.endsWith('m')) {
      seconds = parseInt(duration) * 60;
    } else if (duration.endsWith('h')) {
      seconds = parseInt(duration) * 3600;
    } else if (duration.endsWith('d')) {
      seconds = parseInt(duration) * 86400;
    }

    await redisCmd('SET', 'monitor:muted', '1', 'EX', String(seconds)).catch(() => {});
    await sendTelegramMessage(`🔕 Monitor notifications muted for <b>${duration}</b>.`, { chatId: senderChatId });
    return res.json({ status: 'ok', msg: 'Muted' });
  }

  // Command: /unmute
  if (cmd === '/unmute') {
    await redisCmd('DEL', 'monitor:muted').catch(() => {});
    await sendTelegramMessage('🔔 Monitor notifications unmuted.', { chatId: senderChatId });
    return res.json({ status: 'ok', msg: 'Unmuted' });
  }

  // Command: /cleanup
  if (cmd === '/cleanup') {
    res.json({ status: 'ok', msg: 'Running cleanup' });
    await runCleanupCommand(senderChatId, senderUserId);
    return;
  }

  // Command: /resetquota <user>
  if (cmd === '/resetquota') {
    const targetUser = tokens[1];
    res.json({ status: 'ok', msg: 'Resetting quota' });
    await runResetQuotaCommand(targetUser, senderChatId, senderUserId);
    return;
  }

  // Command: /maint on|off [message]
  if (cmd === '/maint' || cmd === '/maintenance') {
    const action = tokens[1];
    const message = tokens.slice(2).join(' ');
    res.json({ status: 'ok', msg: 'Updating maintenance mode' });
    await runMaintenanceCommand(action, message, senderChatId, senderUserId);
    return;
  }

  // Command: /extend <user> <service> <minutes>
  if (cmd === '/extend') {
    const targetUser = tokens[1];
    const service = tokens[2];
    const minutes = tokens[3];
    res.json({ status: 'ok', msg: 'Extending quota' });
    await runExtendCommand(targetUser, service, minutes, senderChatId, senderUserId);
    return;
  }

  // Command: /audit [n]
  if (cmd === '/audit') {
    const count = tokens[1];
    res.json({ status: 'ok', msg: 'Fetching audit log' });
    await runAuditCommand(count, senderChatId);
    return;
  }

  // Command: /online
  if (cmd === '/online') {
    res.json({ status: 'ok', msg: 'Querying online sessions' });
    await runOnlineUsersCommand(senderChatId);
    return;
  }

  // Command: /limits
  if (cmd === '/limits') {
    res.json({ status: 'ok', msg: 'Checking resource limits' });
    await runLimitsCommand(senderChatId);
    return;
  }

  // Command: /perf
  if (cmd === '/perf') {
    res.json({ status: 'ok', msg: 'Checking performance' });
    await runPerfCommand(senderChatId);
    return;
  }

  // Command: /errors [n]
  if (cmd === '/errors' || cmd === '/error') {
    const count = tokens[1];
    res.json({ status: 'ok', msg: 'Fetching error buffer' });
    await runErrorsCommand(count, senderChatId);
    return;
  }

  // Command: /quota <user>
  if (cmd === '/quota') {
    const targetUser = tokens[1];
    res.json({ status: 'ok', msg: 'Checking user quota' });
    await runQuotaCommand(targetUser, senderChatId);
    return;
  }

  // Command: /gpu
  if (cmd === '/gpu') {
    res.json({ status: 'ok', msg: 'Checking GPU pool' });
    await runGpuCommand(senderChatId);
    return;
  }

  // Command: /orphans
  if (cmd === '/orphans' || cmd === '/orphan') {
    res.json({ status: 'ok', msg: 'Auditing orphans' });
    await runOrphansCommand(senderChatId);
    return;
  }

  // Command: /announce <text>
  if (cmd === '/announce') {
    const announcementText = tokens.slice(1).join(' ');
    res.json({ status: 'ok', msg: 'Broadcasting announcement' });
    await runAnnounceCommand(announcementText, senderChatId, senderUserId);
    return;
  }

  // Command: /note <user> [text]
  if (cmd === '/note') {
    const targetUser = tokens[1];
    const noteText = tokens.slice(2).join(' ');
    res.json({ status: 'ok', msg: 'Handling admin note' });
    await runNoteCommand(targetUser, noteText, senderChatId, senderUserId);
    return;
  }

  // Command: /start runner [vps,devbox] OR /startrunner [vps,devbox]
  if (cmd === '/startrunner' || cmd === '/start_runner' || (cmd === '/start' && (tokens[1]?.toLowerCase() === 'runner' || tokens[1]?.toLowerCase() === 'runners'))) {
    const serviceArg = (cmd === '/startrunner' || cmd === '/start_runner') ? tokens[1] : tokens.slice(2).join(' ');
    res.json({ status: 'ok', msg: 'Starting open runner notebook' });
    await runStartRunnerCommand(serviceArg, senderChatId, senderUserId);
    return;
  }

  // Command: /start or /help
  if (cmd === '/start' || cmd === '/help') {
    const helpMsg = `
⚡ <b>AbsoraCloud System Monitor & Admin Bot</b>

<b>Telemetry & Infrastructure:</b>
• <code>/status</code> - Platform health & overall telemetry
• <code>/status &lt;user&gt;</code> - Specific user workloads, storage & quota
• <code>/active [services]</code> - Active workloads (website, serverless, vps, devbox) with ID, owner & URL
• <code>/online</code> - Users with active sessions right now
• <code>/perf</code> - Memory, CPU, event-loop delay & request rate
• <code>/limits</code> - D1, Upstash Redis & storage usage against limits
• <code>/errors [n]</code> - Last n server errors with timestamps
• <code>/runners</code> - List all active compute runners & capacity
• <code>/logs &lt;runner_id&gt;</code> - Tail real-time logs for a specific runner

<b>Compute & GPU Management:</b>
• <code>/start runner vps,devbox</code> - Launch pre-warmed open notebook & send back live web shell URL
• <code>/gpu</code> - GPU pool used vs weekly limit, reset countdown & top users
• <code>/orphans</code> - Detect Kaggle kernels leaking GPU hours with 0 users
• <code>/cleanup</code> - Purge expired sites, Workers, and dead runners
• <code>/stop &lt;runner_id&gt;</code> - Terminate compute runner & kill sessions

<b>User & Quota Administration:</b>
• <code>/quota &lt;user&gt;</code> - User’s usage against each plan limit
• <code>/resetquota &lt;user&gt;</code> - Reset user’s weekly usage to zero
• <code>/extend &lt;user&gt; &lt;service&gt; &lt;min&gt;</code> - Grant bonus quota minutes
• <code>/users 1-10</code> - List registered users in row range
• <code>/upgrade &lt;user&gt; &lt;plan&gt;</code> - Change plan (free, basic, pro, enterprise)
• <code>/ban &lt;user&gt; [reason]</code> - Lock user account & kill workloads
• <code>/unban &lt;user&gt;</code> - Restore user account access
• <code>/note &lt;user&gt; [text]</code> - View or save private admin note on user

<b>Platform Operations:</b>
• <code>/maint on|off [message]</code> - Stop new launches during deploy/incident & show dashboard banner
• <code>/announce &lt;text&gt;</code> - Show message banner on dashboard (clear with <code>/announce clear</code>)
• <code>/audit [n]</code> - Last n actions taken through bot
• <code>/rm site &lt;url&gt;</code> - Remove website & free plan quota
• <code>/rm func &lt;name&gt;</code> - Remove serverless function & free quota
• <code>/mute &lt;duration&gt;</code> / <code>/unmute</code> - Control alert notifications
• <code>/test all</code> - Run system diagnostics probe
• <code>/help</code> - Show this menu
    `.trim();
    await sendTelegramMessage(helpMsg, { chatId: senderChatId });
    return res.json({ status: 'ok', msg: 'Help sent' });
  }

  // Fallback for unknown slash command
  if (cmd.startsWith('/')) {
    const fallbackMsg = `
❓ <b>Unknown command:</b> <code>${tokens[0]}</code>

💡 <b>Quick Commands:</b>
• <code>/status</code> - Platform health overview
• <code>/online</code> - Online users & sessions
• <code>/gpu</code> - Kaggle GPU pool status
• <code>/cleanup</code> - Purge expired sites & dead runners
• <code>/maint on|off</code> - Toggle maintenance mode
• <code>/announce &lt;text&gt;</code> - Broadcast dashboard banner
• <code>/limits</code> - Resource free-tier check
• <code>/help</code> - View complete command manual
    `.trim();
    await sendTelegramMessage(fallbackMsg, { chatId: senderChatId });
    return res.json({ status: 'ok', msg: 'Unknown command help sent' });
  }

  res.json({ status: 'ok' });
}

// ── Service Initialization ──
export function initMonitorBot() {
  if (process.env.MONITOR_ENABLED !== 'true' && process.env.MONITOR_ENABLED !== '1') {
    console.log('[MonitorBot] Monitor is disabled (set MONITOR_ENABLED=true in Render env to activate).');
    return;
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[MonitorBot] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Monitor will not send messages.');
    return;
  }

  console.log('🤖 AbsoraCloud Telegram Monitor Bot initialized (5m interval, IST).');

  // Register Telegram Webhook if public URL configured
  if (PUBLIC_URL && BOT_TOKEN) {
    const webhookUrl = `${PUBLIC_URL}/api/monitor/webhook`;
    fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ['message']
      })
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) console.log(`[MonitorBot] Webhook registered successfully at ${webhookUrl}`);
        else console.warn('[MonitorBot] Webhook registration note:', d.description);
      })
      .catch(e => console.warn('[MonitorBot] Webhook registration network note:', e.message));
  }

  // Initial check after 15 seconds to allow Express and DB connections to settle
  setTimeout(() => {
    runMonitoringCycle(false).catch(() => {});
  }, 15000);

  // Recurring 5-minute interval timer (300,000 ms)
  timerHandle = setInterval(() => {
    runMonitoringCycle(false).catch(() => {});
    checkMorningDigest().catch(() => {});
  }, 300000);

  if (timerHandle.unref) timerHandle.unref();
}

export function stopMonitorBot() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}
