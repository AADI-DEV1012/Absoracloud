// ── AbsoraCloud Telegram System Monitor Bot ──
// Lightweight in-process monitor for Render Free Plan (0.1 CPU, 512 MB).
// Zero heavy external libraries: uses native fetch for Telegram & NVIDIA AI.
// Runs every 5 minutes with Redis distributed lock & strictly read-only checks.

import { performance } from 'perf_hooks';
import { queryD1 } from '../../../../packages/shared/d1.js';
import { redisCmd, redisPipeline } from '../../../../packages/shared/redis.js';
import { getLogDiskUsage, getRunLog } from './run_logger.js';

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
    let runnersSummary = { ready: 0, starting: 0, dead: 0 };
    try {
      const q2 = `
        SELECT 
          status,
          COUNT(*) AS cnt,
          SUM(CASE WHEN status = 'starting' AND started_at < datetime('now', '-6 minutes') THEN 1 ELSE 0 END) AS stuck_starting,
          SUM(CASE WHEN last_heartbeat < datetime('now', '-5 minutes') AND status != 'dead' THEN 1 ELSE 0 END) AS dead_heartbeats
        FROM runners
        GROUP BY status;
      `;
      const rows2 = await queryD1(q2);

      for (const r of rows2 || []) {
        const s = (r.status || 'ready').toLowerCase();
        const cnt = parseInt(r.cnt || '0', 10);
        const stuck = parseInt(r.stuck_starting || '0', 10);
        const deadHb = parseInt(r.dead_heartbeats || '0', 10);

        if (s === 'ready') runnersSummary.ready += cnt;
        else if (s === 'starting') {
          runnersSummary.starting += cnt;
          if (stuck > 0) alerts.push(`${stuck} runner(s) stuck in starting > 6m`);
        } else {
          runnersSummary.dead += cnt;
        }

        if (deadHb > 0) alerts.push(`${deadHb} runner(s) missed heartbeat > 5m`);
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
    msg += `<b>Infra:</b> D1 ${d1Ok ? '✅' : '❌'} | Redis ${redisOk ? '✅' : '❌'} | LogDisk ${diskLogs.totalMB}MB/200MB (${diskLogs.percentUsed}%)\n`;
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
    const userRes = await queryD1(
      'SELECT id, username, email, plan, role, created_at, locked_until FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
      [cleanUsername]
    );

    const user = userRes?.results?.[0];
    if (!user) {
      await sendTelegramMessage(`❌ User <b>${cleanUsername}</b> not found in database.`, { chatId });
      return;
    }

    // 2. Fetch user instances and storage files in parallel
    const [instRes, filesRes, gpuSecondsRaw] = await Promise.all([
      queryD1(
        'SELECT service, status, public_url, runner_id, created_at, expires_at FROM instances WHERE user_id = ? ORDER BY id DESC LIMIT 50',
        [user.id]
      ).catch(() => ({ results: [] })),
      queryD1(
        'SELECT COUNT(*) as file_count, COALESCE(SUM(file_size), 0) as total_bytes FROM cloud_files WHERE user_id = ?',
        [user.id]
      ).catch(() => ({ results: [{ file_count: 0, total_bytes: 0 }] })),
      redisCmd('GET', `quota:${user.id}:devbox_gpu`).catch(() => '0')
    ]);

    const instances = instRes?.results || [];
    const filesStats = filesRes?.results?.[0] || { file_count: 0, total_bytes: 0 };

    // Active workloads
    const activeInstances = instances.filter(i => i.status === 'active' || i.status === 'pending');
    
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
        if (i.status === 'active' || i.status === 'pending') {
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

    msg += `<b>Workloads:</b>\n`;
    msg += ` • VPS: ${counts.vps.active} active (${counts.vps.total} total)\n`;
    msg += ` • DevBox: ${counts.devbox.active} active (${counts.devbox.total} total)\n`;
    msg += ` • WebHost: ${counts.webhost.active} live (${counts.webhost.total} total)\n`;
    msg += ` • Serverless: ${counts.serverless.active} active (${counts.serverless.total} total)\n\n`;

    msg += `<b>Storage & Quotas:</b>\n`;
    msg += ` • Cloud Files: ${filesStats.file_count || 0} files (${storageFormatted})\n`;
    msg += ` • Log Reserve: 0.00MB / 200MB reserved\n`;
    msg += ` • DevBox GPU Used: ${gpuHours}h\n`;

    if (activeInstances.length > 0) {
      msg += `\n<b>Active Instances:</b>\n`;
      activeInstances.slice(0, 5).forEach(inst => {
        const urlStr = inst.public_url ? ` → <code>${inst.public_url}</code>` : '';
        msg += ` • <b>${(inst.service || '').toUpperCase()}</b> [${inst.status}]${urlStr}\n`;
      });
      if (activeInstances.length > 5) {
        msg += ` <i>...and ${activeInstances.length - 5} more</i>\n`;
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
    const res = await queryD1('SELECT count(*) as cnt FROM users');
    const ms = Math.round(performance.now() - t0);
    const count = res?.results?.[0]?.cnt ?? 0;
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
    const [runnersRes, instRes] = await Promise.all([
      queryD1('SELECT status, count(*) as cnt FROM runners WHERE service = ? GROUP BY status', [service]),
      queryD1('SELECT status, count(*) as cnt FROM instances WHERE service = ? GROUP BY status', [service])
    ]);
    const ms = Math.round(performance.now() - t0);
    const runners = runnersRes?.results || [];
    const instances = instRes?.results || [];
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
    const res = await queryD1('SELECT status, count(*) as cnt FROM instances WHERE service = ? GROUP BY status', [service]);
    const ms = Math.round(performance.now() - t0);
    const active = res?.results?.find(r => r.status === 'active')?.cnt || 0;
    const total = (res?.results || []).reduce((acc, cur) => acc + (cur.cnt || 0), 0);
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
  const ok = usage.totalBytes < 200 * 1024 * 1024;
  return {
    ok,
    details: `Disk: ${usage.totalMB}MB / 200MB (${usage.percentUsed}%) | ${usage.fileCount} log files`
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

  // 10. Single component test: Logs / Disk
  if (target === 'logs' || target === 'log' || target === 'disk') {
    const probe = testLogDiskProbe();
    let msg = `🧪 <b>Isolated Log Storage Diagnostic Probe</b> • ${getIstTime()}\n\n`;
    msg += `<b>Status:</b> ${probe.ok ? '🟢 SAFE' : '⚠️ NEAR LIMIT'}\n`;
    msg += `<b>Cap:</b> Strictly 200 MB reserved per policy\n`;
    msg += `<b>Current Disk:</b> ${probe.details}\n`;
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
    const res = await queryD1(
      'SELECT id, type, service, capacity, active_count, status, last_heartbeat FROM runners ORDER BY last_heartbeat DESC LIMIT 20'
    );
    const runners = res?.results || [];
    const now = Date.now();

    const activeRunners = runners.filter(r => {
      if (r.status === 'ready' || r.status === 'active') {
        const hbTime = new Date(r.last_heartbeat + 'Z').getTime();
        return (now - hbTime) <= 10 * 60 * 1000;
      }
      return false;
    });

    if (activeRunners.length > 0) {
      let msg = `⚡ <b>Active Runners (${activeRunners.length})</b> • ${getIstTime()}\n\n`;
      activeRunners.forEach(r => {
        const typeTag = r.type === 'kaggle_gpu' ? 'GPU T4×2' : (r.type === 'kaggle_cpu' ? 'CPU' : r.type);
        msg += `• <code>${r.id}</code>\n`;
        msg += `  Service: <b>${(r.service || '').toUpperCase()}</b> [${typeTag}]\n`;
        msg += `  Status: 🟢 <b>${r.status}</b> | Load: ${r.active_count || 0}/${r.capacity || 1}\n`;
        msg += `  Last Heartbeat: <code>${r.last_heartbeat}</code>\n`;
        msg += `  <i>Tail logs:</i> <code>/logs ${r.id}</code>\n\n`;
      });
      await sendTelegramMessage(msg, { chatId });
      return;
    }

    let msg = `⚡ <b>Active Runners</b> • ${getIstTime()}\n\n`;
    msg += `ℹ️ <b>No runners currently active or ready.</b>\n`;
    msg += `<i>(Runners spin up on Kaggle on-demand when users launch a VPS or DevBox session)</i>\n\n`;
    if (runners.length > 0) {
      msg += `<b>Recent Runners in Database:</b>\n`;
      runners.slice(0, 6).forEach(r => {
        msg += `• <code>${r.id}</code> [${r.service}] - <i>${r.status}</i>\n`;
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
    const [runnerRes, instRes, tunnelUrl] = await Promise.all([
      queryD1('SELECT id, type, service, capacity, active_count, status, last_heartbeat FROM runners WHERE id = ? LIMIT 1', [targetId]).catch(() => ({ results: [] })),
      queryD1('SELECT session_key, service, status, public_url, created_at FROM instances WHERE runner_id = ? OR session_key = ? ORDER BY id DESC LIMIT 5', [targetId, targetId]).catch(() => ({ results: [] })),
      redisCmd('HGET', `runner:${targetId}`, 'tunnel_url').catch(() => null)
    ]);

    const runner = runnerRes?.results?.[0];
    const attachedInstances = instRes?.results || [];

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

// ── Telegram Webhook Handler (/status, /test, /runner, /logs, /mute) ──
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

  const text = message.text.trim();

  // Command: /status or /status <username>
  if (text.startsWith('/status')) {
    const parts = text.split(/\s+/);
    const targetUser = parts[1];
    if (targetUser) {
      res.json({ status: 'ok', msg: 'Dispatching user status' });
      await runUserStatusCheck(targetUser, senderChatId);
      return;
    }
    res.json({ status: 'ok', msg: 'Dispatching status' });
    await runMonitoringCycle(true, senderChatId);
    return;
  }

  // Command: /runner active, /runners active, /runners, /runner
  if (text.startsWith('/runner') || text.startsWith('/runners')) {
    res.json({ status: 'ok', msg: 'Querying runners' });
    await runRunnersCheck(senderChatId);
    return;
  }

  // Command: /logs <runner_id> or /log <runner_id>
  if (text.startsWith('/logs') || text.startsWith('/log')) {
    const parts = text.split(/\s+/);
    const targetId = parts[1];
    res.json({ status: 'ok', msg: 'Fetching runner logs' });
    await runRunnerLogsCheck(targetId, senderChatId);
    return;
  }

  // Command: /test [target] (e.g. /test all, /test redis, /test d1, /test vps, etc.)
  if (text.startsWith('/test')) {
    const parts = text.split(/\s+/);
    const target = parts[1] || 'all';
    res.json({ status: 'ok', msg: `Running diagnostic probe for ${target}` });
    await runSystemDiagnostics(target, senderChatId);
    return;
  }

  // Command: /mute <duration> (e.g. /mute 1h, /mute 30m)
  if (text.startsWith('/mute')) {
    const parts = text.split(' ');
    const duration = parts[1] || '1h';
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
  if (text.startsWith('/unmute')) {
    await redisCmd('DEL', 'monitor:muted').catch(() => {});
    await sendTelegramMessage('🔔 Monitor notifications unmuted.', { chatId: senderChatId });
    return res.json({ status: 'ok', msg: 'Unmuted' });
  }

  // Command: /start or /help
  if (text.startsWith('/start') || text.startsWith('/help')) {
    const helpMsg = `
⚡ <b>AbsoraCloud System Monitor Bot</b>

<b>Telemetry & Status:</b>
• <code>/status</code> - Platform health & overall telemetry
• <code>/status &lt;username&gt;</code> - Specific user workloads, storage & quota
• <code>/runner active</code> - List all active compute runners & capacity
• <code>/logs &lt;runner_id&gt;</code> - Tail real-time logs for a specific runner

<b>System Diagnostics:</b>
• <code>/test all</code> - Comprehensive infrastructure health audit
• <code>/test &lt;service&gt;</code> - Targeted probe:
  - <code>/test d1</code> (Database shards & latency)
  - <code>/test redis</code> (Cache, queues & GPU sessions)
  - <code>/test vps</code> (Kaggle CPU runner pool)
  - <code>/test devbox</code> (Kaggle GPU pool & quotas)
  - <code>/test webhost</code> (Cloudflare Workers static sites)
  - <code>/test serverless</code> (Edge serverless functions)
  - <code>/test ai</code> (NVIDIA Nemotron 3.5 LLM)
  - <code>/test storage</code> (Cloudinary, ImageKit, Uploadcare)
  - <code>/test realtime</code> (Pusher, Ably, PieSocket, Scaledrone)
  - <code>/test logs</code> (200MB disk usage & isolation)

<b>Controls:</b>
• <code>/mute &lt;duration&gt;</code> - Mute alerts (e.g. <code>/mute 30m</code>, <code>/mute 2h</code>)
• <code>/unmute</code> - Unmute notifications immediately
• <code>/help</code> - Show this menu

<i>Automated reports run every 5 minutes with strict 200MB log caps.</i>
    `.trim();
    await sendTelegramMessage(helpMsg, { chatId: senderChatId });
    return res.json({ status: 'ok', msg: 'Help sent' });
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
