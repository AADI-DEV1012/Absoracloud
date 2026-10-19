// ── Kaggle API Integration ──
// Powers both services:
//   • DevBox  — Kaggle GPU kernels (T4×2)
//   • VPS     — Kaggle CPU-only kernels (no GPU)

const KAGGLE_API = 'https://www.kaggle.com/api/v1';

function getAuth() {
  const username = process.env.KAGGLE_USERNAME;
  const key      = process.env.KAGGLE_KEY;
  if (!username || !key) throw new Error('Missing KAGGLE_USERNAME or KAGGLE_KEY');
  const authHeader = key.startsWith('KGAT_')
    ? `Bearer ${key}`
    : `Basic ${Buffer.from(`${username}:${key}`).toString('base64')}`;
  return { username, key, authHeader };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEVBOX — GPU Kernel (T4×2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Triggers a Kaggle GPU kernel for a DevBox IDE session.
 */
export async function triggerKaggleKernel(sessionKey, userId, plan) {
  const { username, authHeader } = getAuth();

  const kernelPush = {
    slug: `${username}/absoracloud-devbox`,
    newTitle: 'AbsoraCloud DevBox',
    text: buildDevBoxScript(sessionKey, userId, plan),
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: true,      // GPU T4×2
    enableInternet: true,
  };

  const res = await fetch(`${KAGGLE_API}/kernels/push`, {
    method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(kernelPush),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kaggle GPU kernel push failed (${res.status}): ${text}`);
  }
  return await res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// VPS — CPU-only Kernel (no GPU)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Triggers a Kaggle CPU-only kernel for a VPS session.
 * CPU runtime is cheaper on quota and suited for terminal/shell workloads.
 */
export async function triggerVPSKernel(sessionKey, userId, plan, config = {}) {
  const { username, authHeader } = getAuth();

  // Each VPS gets a unique kernel slug so they can run concurrently
  const kernelSlug = `absoracloud-vps-${sessionKey.slice(-8)}`;

  const kernelPush = {
    slug: `${username}/${kernelSlug}`,
    newTitle: `AbsoraCloud VPS — ${sessionKey}`,
    text: buildVPSScript(sessionKey, userId, plan, config),
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: false,     // CPU-only — no GPU requested
    enableInternet: true,
  };

  const res = await fetch(`${KAGGLE_API}/kernels/push`, {
    method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(kernelPush),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kaggle VPS kernel push failed (${res.status}): ${text}`);
  }
  return await res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS CHECKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the current status of any Kaggle kernel by slug.
 */
export async function getKernelStatus(kernelSlug) {
  const { username, authHeader } = getAuth();
  const res = await fetch(
    `${KAGGLE_API}/kernels/status?userName=${username}&kernelSlug=${kernelSlug}`,
    { headers: { 'Authorization': authHeader } }
  );
  return await res.json();
}

/**
 * Gets GPU DevBox kernel status.
 */
export async function getDevBoxKernelStatus() {
  const { username } = getAuth();
  return getKernelStatus(`${username}/absoracloud-devbox`);
}

/**
 * Gets VPS kernel status by session key.
 */
export async function getVPSKernelStatus(sessionKey) {
  const { username } = getAuth();
  return getKernelStatus(`${username}/absoracloud-vps-${sessionKey.slice(-8)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// KERNEL SCRIPTS
// ─────────────────────────────────────────────────────────────────────────────

function buildDevBoxScript(sessionKey, userId, plan) {
  const apiUrl   = process.env.API_URL || 'https://absoracloud.onrender.com';
  const secret   = process.env.WORKER_SECRET || '';
  const redisUrl = process.env.UPSTASH_REDIS_URL || '';
  const redisTok = process.env.UPSTASH_REDIS_TOKEN || '';

  return `
# AbsoraCloud DevBox — GPU Kernel Runner
# Session: ${sessionKey} | User: ${userId} | Plan: ${plan}
import subprocess, os, time, requests, json

SESSION_KEY  = "${sessionKey}"
API_URL      = "${apiUrl}"
WORKER_SECRET = "${secret}"
REDIS_URL    = "${redisUrl}"
REDIS_TOKEN  = "${redisTok}"

def redis_cmd(*args):
    r = requests.post(REDIS_URL, json=list(args),
        headers={"Authorization": f"Bearer {REDIS_TOKEN}", "Content-Type": "application/json"})
    return r.json().get("result")

def report_url(url):
    try:
        redis_cmd("HSET", f"session:{SESSION_KEY}", "status", "active", "tunnel_url", url)
    except Exception as re:
        print("redis error:", re)
    try:
        requests.post(f"{API_URL}/api/worker/session_update",
            json={"session_key": SESSION_KEY, "status": "active", "tunnel_url": url},
            headers={"X-Worker-Secret": WORKER_SECRET})
    except Exception as he:
        print("api update error:", he)

# Install ttyd for browser terminal (-W for writable terminal)
subprocess.run(["pip", "install", "-q", "requests"], check=False)
subprocess.Popen(["bash", "-c",
    "curl -sLo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 "
    "&& chmod +x /usr/local/bin/ttyd && ttyd -W -p 7860 bash"
])

# Install cloudflared for tunnel
subprocess.Popen(["bash", "-c",
    "wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 "
    "-O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared "
    "&& cloudflared tunnel --url http://localhost:7860 2>&1 | tee /tmp/cf.log"
])

# Wait for tunnel URL and report (poll every 3s up to 60 times)
for _ in range(60):
    time.sleep(3)
    try:
        if os.path.exists("/tmp/cf.log"):
            log = open("/tmp/cf.log").read()
            import re
            urls = re.findall(r"https://[\\w-]+\\.trycloudflare\\.com", log)
            if urls:
                report_url(urls[0])
                print(f"✅ DevBox live: {urls[0]}")
                break
    except Exception as e:
        print("devbox poll error:", e)

# Keep alive with heartbeats
while True:
    kill = redis_cmd("GET", f"kill:{SESSION_KEY}")
    if kill:
        print("🛑 Kill signal received — shutting down DevBox.")
        break
    redis_cmd("HSET", f"session:{SESSION_KEY}", "status", "active")
    time.sleep(30)
`.trim();
}

function buildVPSScript(sessionKey, userId, plan, config = {}) {
  const apiUrl   = process.env.API_URL || 'https://absoracloud.onrender.com';
  const secret   = process.env.WORKER_SECRET || '';
  const redisUrl = process.env.UPSTASH_REDIS_URL || '';
  const redisTok = process.env.UPSTASH_REDIS_TOKEN || '';
  const ramMb    = config.ram_mb || 2048;
  const timeoutS = config.timeout_seconds || 14400;

  return `
# AbsoraCloud VPS — CPU Kernel Runner (no GPU)
# Session: ${sessionKey} | User: ${userId} | Plan: ${plan}
import subprocess, os, time, requests, re

SESSION_KEY    = "${sessionKey}"
API_URL        = "${apiUrl}"
WORKER_SECRET  = "${secret}"
REDIS_URL      = "${redisUrl}"
REDIS_TOKEN    = "${redisTok}"
TIMEOUT_SEC    = ${timeoutS}

def redis_cmd(*args):
    r = requests.post(REDIS_URL, json=list(args),
        headers={"Authorization": f"Bearer {REDIS_TOKEN}", "Content-Type": "application/json"})
    return r.json().get("result")

def report_url(url):
    try:
        redis_cmd("HSET", f"session:{SESSION_KEY}", "status", "active", "tunnel_url", url)
    except Exception as re:
        print("redis error:", re)
    try:
        requests.post(f"{API_URL}/api/worker/session_update",
            json={"session_key": SESSION_KEY, "status": "active", "tunnel_url": url},
            headers={"X-Worker-Secret": WORKER_SECRET})
    except Exception as he:
        print("api update error:", he)

subprocess.run(["pip", "install", "-q", "requests"], check=False)

# Install ttyd (browser terminal) on CPU runtime (-W for writable terminal)
subprocess.Popen(["bash", "-c",
    "curl -sLo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 "
    "&& chmod +x /usr/local/bin/ttyd && ttyd -W -p 7860 bash"
])

# Cloudflare tunnel
subprocess.Popen(["bash", "-c",
    "wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 "
    "-O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared "
    "&& cloudflared tunnel --url http://localhost:7860 2>&1 | tee /tmp/cf_vps.log"
])

# Wait for tunnel URL and report (poll every 3s up to 60 times)
for _ in range(60):
    time.sleep(3)
    try:
        if os.path.exists("/tmp/cf_vps.log"):
            log = open("/tmp/cf_vps.log").read()
            urls = re.findall(r"https://[\\w-]+\\.trycloudflare\\.com", log)
            if urls:
                report_url(urls[0])
                print(f"✅ VPS live: {urls[0]}")
                break
    except Exception as e:
        print("vps poll error:", e)

# Keep alive with heartbeats, respect kill signal and timeout
start = time.time()
while True:
    if time.time() - start > TIMEOUT_SEC:
        print("⏱️ VPS session timeout reached. Shutting down.")
        break
    kill = redis_cmd("GET", f"kill:{SESSION_KEY}")
    if kill:
        print("🛑 Kill signal received — shutting down VPS.")
        break
    redis_cmd("HSET", f"session:{SESSION_KEY}", "status", "active")
    time.sleep(30)
`.trim();
}
