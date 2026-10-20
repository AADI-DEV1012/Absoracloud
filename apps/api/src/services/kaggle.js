// ── Kaggle API Integration ──
// Powers both services:
//   • DevBox  — Kaggle GPU kernels (T4×2) or CPU
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
// DEVBOX — GPU Kernel (T4×2) or CPU
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Triggers a Kaggle GPU/CPU kernel for a DevBox IDE session.
 */
export async function triggerKaggleKernel(sessionKey, userId, plan, config = {}) {
  const { username, authHeader } = getAuth();
  const kernelSlug = `absoracloud-devbox-${sessionKey.slice(-8)}`;
  const isGpu = config.runtime !== 'cpu';

  const kernelPush = {
    slug: `${username}/${kernelSlug}`,
    newTitle: `AbsoraCloud DevBox — ${sessionKey}`,
    text: buildDevBoxScript(sessionKey, userId, plan, config),
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: isGpu,
    enableInternet: true,
  };

  const res = await fetch(`${KAGGLE_API}/kernels/push`, {
    method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(kernelPush),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kaggle kernel push failed (${res.status}): ${text}`);
  }
  return await res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// VPS — CPU-only Kernel (no GPU)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Triggers a Kaggle CPU-only kernel for a VPS session.
 */
export async function triggerVPSKernel(sessionKey, userId, plan, config = {}) {
  const { username, authHeader } = getAuth();
  const kernelSlug = `absoracloud-vps-${sessionKey.slice(-8)}`;

  const kernelPush = {
    slug: `${username}/${kernelSlug}`,
    newTitle: `AbsoraCloud VPS — ${sessionKey}`,
    text: buildVPSScript(sessionKey, userId, plan, config),
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: false,
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

export async function getKernelStatus(kernelSlug) {
  const { username, authHeader } = getAuth();
  const res = await fetch(
    `${KAGGLE_API}/kernels/status?userName=${username}&kernelSlug=${kernelSlug}`,
    { headers: { 'Authorization': authHeader } }
  );
  return await res.json();
}

export async function getDevBoxKernelStatus(sessionKey) {
  const { username } = getAuth();
  const slug = sessionKey ? `absoracloud-devbox-${sessionKey.slice(-8)}` : 'absoracloud-devbox';
  return getKernelStatus(`${username}/${slug}`);
}

export async function getVPSKernelStatus(sessionKey) {
  const { username } = getAuth();
  return getKernelStatus(`${username}/absoracloud-vps-${sessionKey.slice(-8)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// KERNEL SCRIPTS
// ─────────────────────────────────────────────────────────────────────────────

function buildDevBoxScript(sessionKey, userId, plan, config = {}) {
  const apiUrl   = process.env.API_URL || 'https://absoracloud.onrender.com';
  const secret   = process.env.WORKER_SECRET || '';
  const termPass = config.term_pass || '';
  const passArg  = termPass ? `-c admin:${termPass}` : '';
  const timeoutS = (config.timeout_seconds) || 7200;

  return `
# AbsoraCloud DevBox Runner
# Session: ${sessionKey} | User: ${userId} | Plan: ${plan}
import subprocess, os, time, requests, re

SESSION_KEY   = "${sessionKey}"
API_URL       = "${apiUrl}"
WORKER_SECRET = "${secret}"
TIMEOUT_SEC   = ${timeoutS}

def report_url(url):
    try:
        requests.post(f"{API_URL}/api/worker/session_update",
            json={"session_key": SESSION_KEY, "status": "active", "tunnel_url": url},
            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
    except Exception as e:
        print("session_update error:", e)

def check_heartbeat():
    try:
        r = requests.post(f"{API_URL}/api/worker/heartbeat",
            json={"session_key": SESSION_KEY, "status": "active"},
            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
        data = r.json()
        if data.get("kill"):
            return False
    except Exception as e:
        print("heartbeat error:", e)
    return True

subprocess.run(["pip", "install", "-q", "requests"], check=False)

# Install ttyd for browser terminal
subprocess.Popen(["bash", "-c",
    "curl -sLo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 "
    f"&& chmod +x /usr/local/bin/ttyd && ttyd ${passArg} -W -p 7860 bash"
])

# Install cloudflared for tunnel
subprocess.Popen(["bash", "-c",
    "wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 "
    "-O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared "
    "&& cloudflared tunnel --url http://localhost:7860 2>&1 | tee /tmp/cf.log"
])

# Poll for tunnel URL (poll every 3s up to 60 times)
for _ in range(60):
    time.sleep(3)
    try:
        if os.path.exists("/tmp/cf.log"):
            log = open("/tmp/cf.log").read()
            urls = re.findall(r"https://[\\w-]+\\.trycloudflare\\.com", log)
            if urls:
                report_url(urls[0])
                print(f"✅ DevBox live: {urls[0]}")
                break
    except Exception as e:
        print("devbox poll error:", e)

# Keep alive with heartbeats & check kill signals
start = time.time()
while True:
    if time.time() - start > TIMEOUT_SEC:
        print("⏱️ DevBox session timeout reached. Shutting down.")
        break
    if not check_heartbeat():
        print("🛑 Kill signal received — shutting down DevBox.")
        break
    time.sleep(30)
`.trim();
}

function buildVPSScript(sessionKey, userId, plan, config = {}) {
  const apiUrl   = process.env.API_URL || 'https://absoracloud.onrender.com';
  const secret   = process.env.WORKER_SECRET || '';
  const termPass = config.term_pass || '';
  const passArg  = termPass ? `-c admin:${termPass}` : '';
  const timeoutS = config.timeout_seconds || 14400;

  return `
# AbsoraCloud VPS — CPU Kernel Runner (no GPU)
# Session: ${sessionKey} | User: ${userId} | Plan: ${plan}
import subprocess, os, time, requests, re

SESSION_KEY   = "${sessionKey}"
API_URL       = "${apiUrl}"
WORKER_SECRET = "${secret}"
TIMEOUT_SEC   = ${timeoutS}

def report_url(url):
    try:
        requests.post(f"{API_URL}/api/worker/session_update",
            json={"session_key": SESSION_KEY, "status": "active", "tunnel_url": url},
            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
    except Exception as e:
        print("session_update error:", e)

def check_heartbeat():
    try:
        r = requests.post(f"{API_URL}/api/worker/heartbeat",
            json={"session_key": SESSION_KEY, "status": "active"},
            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
        data = r.json()
        if data.get("kill"):
            return False
    except Exception as e:
        print("heartbeat error:", e)
    return True

subprocess.run(["pip", "install", "-q", "requests"], check=False)

# Install ttyd on CPU runtime
subprocess.Popen(["bash", "-c",
    "curl -sLo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 "
    f"&& chmod +x /usr/local/bin/ttyd && ttyd ${passArg} -W -p 7860 bash"
])

# Cloudflare tunnel
subprocess.Popen(["bash", "-c",
    "wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 "
    "-O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared "
    "&& cloudflared tunnel --url http://localhost:7860 2>&1 | tee /tmp/cf_vps.log"
])

# Poll for tunnel URL (every 3s up to 60 times)
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

# Keep alive with heartbeats & check kill signals
start = time.time()
while True:
    if time.time() - start > TIMEOUT_SEC:
        print("⏱️ VPS session timeout reached. Shutting down.")
        break
    if not check_heartbeat():
        print("🛑 Kill signal received — shutting down VPS.")
        break
    time.sleep(30)
`.trim();
}
