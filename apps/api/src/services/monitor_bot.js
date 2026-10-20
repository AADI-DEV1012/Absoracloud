// ── AbsoraCloud Telegram System Monitor Bot ──
// Lightweight in-process monitor for Render Free Plan (0.1 CPU, 512 MB).
// Zero heavy external libraries: uses native fetch for Telegram & NVIDIA AI.
// Runs every 5 minutes with Redis distributed lock & strictly read-only checks.

import { performance } from 'perf_hooks';
import { queryD1 } from '../../../../packages/shared/d1.js';
import { redisCmd, redisPipeline } from '../../../../packages/shared/redis.js';
import { getLogDiskUsage } from './run_logger.js';

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

// ── Telegram Webhook Handler (/status & /mute) ──
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

  // Command: /status
  if (text.startsWith('/status')) {
    res.json({ status: 'ok', msg: 'Dispatching status' });
    await runMonitoringCycle(true, senderChatId);
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

<b>Available Commands:</b>
• <code>/status</code> - Run immediate health & telemetry check
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
