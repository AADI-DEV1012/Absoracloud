// ── Kaggle API Integration ──
// Powers both services:
//   • DevBox  — Kaggle GPU kernels (T4×2) or CPU
//   • VPS     — Kaggle CPU-only kernels (no GPU)

const KAGGLE_API = 'https://www.kaggle.com/api/v1';

function getAuth() {
    const username = process.env.KAGGLE_USERNAME;
    const key = process.env.KAGGLE_KEY;
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
    const runnerId = config.runner_id || `devbox-runner-${sessionKey.slice(-8)}`;
    const kernelSlug = `absoracloud-devbox-${runnerId.slice(-12)}`;
    const isGpu = config.runtime !== 'cpu';

    const kernelPush = {
        slug: `${username}/${kernelSlug}`,
        newTitle: `AbsoraCloud DevBox Pool — ${runnerId}`,
        text: buildDevBoxScript(runnerId, sessionKey, userId, plan, config),
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
 * Triggers a Kaggle CPU-only kernel for a VPS pooled runner session.
 */
export async function triggerVPSKernel(sessionKey, userId, plan, config = {}) {
    const { username, authHeader } = getAuth();
    const runnerId = config.runner_id || `vps-runner-${sessionKey.slice(-8)}`;
    const kernelSlug = `absoracloud-vps-${runnerId.slice(-12)}`;

    const kernelPush = {
        slug: `${username}/${kernelSlug}`,
        newTitle: `AbsoraCloud VPS Pool — ${runnerId}`,
        text: buildVPSScript(runnerId, sessionKey, userId, plan, config),
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
// KERNEL SCRIPTS (Multi-Tenant Pooled Runner with Auto-Shutdown on 0 Users)
// ─────────────────────────────────────────────────────────────────────────────

function buildDevBoxScript(runnerId, initialSessionKey, userId, plan, config = {}) {
    const apiUrl = process.env.API_URL || 'https://absoracloud.onrender.com';
    const secret = process.env.WORKER_SECRET || '';
    const timeoutS = config.timeout_seconds || 14400;
    const capacity = config.capacity || 2;
    const initPass = config.term_pass || '';
    const runnerType = config.runtime === 'cpu' ? 'kaggle_cpu' : 'kaggle_gpu';

    return `
# AbsoraCloud DevBox Multi-Tenant Runner
# Runner: ${runnerId} | Capacity: ${capacity} | Type: ${runnerType}
import subprocess, os, time, requests, re, sys

RUNNER_ID     = "${runnerId}"
RUNNER_TYPE   = "${runnerType}"
API_URL       = "${apiUrl}"
WORKER_SECRET = "${secret}"
CAPACITY      = ${capacity}
TIMEOUT_SEC   = ${timeoutS}
BASE_PORT     = 7860

subprocess.run(["pip", "install", "-q", "requests"], check=False)
subprocess.run(["bash", "-c", "curl -sLo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && chmod +x /usr/local/bin/ttyd"], check=False)
subprocess.run(["bash", "-c", "wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared"], check=False)

# ── Host Hardening & Sandbox Shielding ──
ADMIN_DIR = "/tmp/.absora_admin"
os.makedirs(ADMIN_DIR, mode=0o700, exist_ok=True)
os.chmod(ADMIN_DIR, 0o700)
# Process isolation: mount /proc with hidepid=2 so non-root users cannot see other processes
subprocess.run(["mount", "-o", "remount,rw,hidepid=2", "/proc"], check=False)
# GPU access for video group & create sandbox group
subprocess.run(["bash", "-c", "chmod 666 /dev/nvidia* /dev/nvidia-uvm* /dev/nvidiactl 2>/dev/null; groupadd -f video; groupadd -f sandbox_users"], check=False)
# Deny sudo to sandboxed users
subprocess.run(["bash", "-c", "mkdir -p /etc/sudoers.d && echo '%sandbox_users ALL=(ALL) !ALL' > /etc/sudoers.d/99-absora && chmod 440 /etc/sudoers.d/99-absora 2>/dev/null"], check=False)

try:
    requests.post(f"{API_URL}/api/worker/register",
        json={"runner_id": RUNNER_ID, "type": RUNNER_TYPE, "service": "devbox", "capacity": CAPACITY},
        headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
    print(f"✅ DevBox runner {RUNNER_ID} ({RUNNER_TYPE}) registered with capacity {CAPACITY}")
except Exception as e:
    print("Devbox register error:", e)

sessions = {}
free_ports = [BASE_PORT + i + 1 for i in range(CAPACITY)]
idle_start = None

def start_session(session_key, term_pass):
    if not free_ports:
        print(f"⚠️ No free port for session {session_key}")
        return
    port = free_ports.pop(0)

    # ── Per-Session Unprivileged Sandbox ──
    clean_id = re.sub(r"[^a-zA-Z0-9]", "", session_key)[-8:].lower()
    box_user = f"box_{clean_id}"
    box_home = f"/home/{box_user}"

    # Create dedicated user without root privileges
    subprocess.run(["useradd", "-m", "-d", box_home, "-s", "/bin/bash", "-g", "sandbox_users", box_user], check=False)
    subprocess.run(["usermod", "-aG", "video", box_user], check=False)
    os.chmod(box_home, 0o700)
    subprocess.run(["chown", "-R", f"{box_user}:sandbox_users", box_home], check=False)

    # Configure user environment (.bashrc with GPU/CUDA paths)
    try:
        with open(f"{box_home}/.bashrc", "a") as f:
            print("export PATH=$PATH:/usr/local/bin:/usr/local/cuda/bin:~/.local/bin", file=f)
            print("export CUDA_HOME=/usr/local/cuda", file=f)
            print("export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/usr/local/cuda/lib64", file=f)
    except Exception:
        pass

    # Protected session IO log in user's isolated home directory
    io_log_file = f"{box_home}/.session_io.log"
    with open(io_log_file, "a") as f:
        pass
    subprocess.run(["chown", f"{box_user}:sandbox_users", io_log_file], check=False)
    os.chmod(io_log_file, 0o600)

    # Launch ttyd dropping root privileges via runuser (User cannot kill cloudflared or root processes)
    ttyd_cmd = f"cd {box_home} && /usr/local/bin/ttyd -i 127.0.0.1 -W -p {port} runuser -u {box_user} -- script -q -f -c 'bash -l' {io_log_file}"
    ttyd_proc = subprocess.Popen(["bash", "-c", ttyd_cmd])

    log_file = f"{ADMIN_DIR}/cf_devbox_{port}.log"
    if os.path.exists(log_file):
        os.remove(log_file)
    cf_cmd = f"/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:{port} 2>&1 | tee {log_file}"
    cf_proc = subprocess.Popen(["bash", "-c", cf_cmd])

    sessions[session_key] = {
        "port": port,
        "ttyd_proc": ttyd_proc,
        "cf_proc": cf_proc,
        "url": None,
        "log_file": log_file,
        "io_log_file": io_log_file,
        "last_io_offset": 0,
        "poll_count": 0,
        "box_user": box_user
    }
    print(f"🚀 Started DevBox session {session_key} (sandboxed user {box_user}) on port {port}")

def stop_session(session_key):
    if session_key in sessions:
        info = sessions.pop(session_key)
        # Terminate any background processes spawned by this sandboxed user
        box_user = info.get("box_user")
        if box_user:
            subprocess.run(["pkill", "-9", "-u", box_user], check=False)
        # Final flush of session I/O logs
        io_file = info.get("io_log_file")
        if io_file and os.path.exists(io_file):
            try:
                curr_size = os.path.getsize(io_file)
                last_offset = info.get("last_io_offset", 0)
                if curr_size > last_offset:
                    with open(io_file, "r", errors="ignore") as f:
                        f.seek(last_offset)
                        chunk = f.read()
                    if chunk:
                        requests.post(f"{API_URL}/api/worker/session_logs",
                            json={"session_key": session_key, "runner_id": RUNNER_ID, "logs": chunk},
                            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=5)
            except Exception:
                pass
        try:
            info["ttyd_proc"].terminate()
            info["cf_proc"].terminate()
        except Exception:
            pass
        free_ports.append(info["port"])
        print(f"🛑 Stopped DevBox session {session_key} (freed port {info['port']})")

def check_session_urls():
    for sk, info in list(sessions.items()):
        if not info["url"] and info["poll_count"] < 40:
            info["poll_count"] += 1
            if os.path.exists(info["log_file"]):
                try:
                    log = open(info["log_file"]).read()
                    urls = re.findall(r"https://[\\w-]+\\.trycloudflare\\.com", log)
                    if urls:
                        info["url"] = urls[0]
                        print(f"✅ DevBox session {sk} live at: {urls[0]}")
                        requests.post(f"{API_URL}/api/worker/session_update",
                            json={"session_key": sk, "status": "active", "tunnel_url": urls[0]},
                            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
                except Exception as e:
                    print(f"Devbox tunnel parse error for {sk}:", e)

def sync_session_io_logs():
    for sk, info in list(sessions.items()):
        io_file = info.get("io_log_file")
        if io_file and os.path.exists(io_file):
            try:
                curr_size = os.path.getsize(io_file)
                last_offset = info.get("last_io_offset", 0)
                if curr_size > last_offset:
                    with open(io_file, "r", errors="ignore") as f:
                        f.seek(last_offset)
                        chunk = f.read(65536)
                        info["last_io_offset"] = f.tell()
                    if chunk:
                        requests.post(f"{API_URL}/api/worker/session_logs",
                            json={"session_key": sk, "runner_id": RUNNER_ID, "logs": chunk},
                            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=5)
            except Exception as e:
                pass

if "${initialSessionKey}":
    start_session("${initialSessionKey}", "${initPass}")

start_time = time.time()
while True:
    time.sleep(10)
    if time.time() - start_time > TIMEOUT_SEC:
        print("⏱️ Max DevBox runner lifetime reached. Shutting down.")
        break

    check_session_urls()
    sync_session_io_logs()

    try:
        r = requests.post(f"{API_URL}/api/worker/runner_heartbeat",
            json={"runner_id": RUNNER_ID, "active_count": len(sessions)},
            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
        data = r.json()
        if data.get("kill"):
            print("🛑 Kill signal received for DevBox runner.")
            break

        assignments = data.get("assignments", [])
        assigned_keys = {a["session_key"] for a in assignments}

        for sk in list(sessions.keys()):
            if sk not in assigned_keys:
                stop_session(sk)

        for a in assignments:
            sk = a["session_key"]
            if sk not in sessions:
                start_session(sk, a.get("term_pass", ""))

    except Exception as e:
        print("Devbox heartbeat poll error:", e)

    if len(sessions) == 0:
        if idle_start is None:
            idle_start = time.time()
            print("⏳ DevBox runner has 0 active sessions. Idle countdown started (300s)...")
        elif time.time() - idle_start > 300:
            print("⏱️ Idle timeout (300s) reached with 0 active users. Cleanly shutting down DevBox runner.")
            try:
                requests.post(f"{API_URL}/api/worker/runner_shutdown",
                    json={"runner_id": RUNNER_ID, "reason": "idle_timeout_300s"},
                    headers={"X-Worker-Secret": WORKER_SECRET}, timeout=5)
            except Exception:
                pass
            break
    else:
        if idle_start is not None:
            print("⚡ New DevBox session connected. Idle countdown reset.")
        idle_start = None

for sk in list(sessions.keys()):
    stop_session(sk)
subprocess.run(["pkill", "-9", "-f", "cloudflared"], check=False)
subprocess.run(["pkill", "-9", "-f", "ttyd"], check=False)
print("🏁 DevBox runner shut down complete.")
sys.exit(0)
`.trim();
}

function buildVPSScript(runnerId, initialSessionKey, userId, plan, config = {}) {
    const apiUrl = process.env.API_URL || 'https://absoracloud.onrender.com';
    const secret = process.env.WORKER_SECRET || '';
    const timeoutS = config.timeout_seconds || 14400;
    const capacity = config.capacity || 4;
    const initPass = config.term_pass || '';

    return `
# AbsoraCloud VPS Multi-Tenant Runner (CPU-only)
# Runner: ${runnerId} | Capacity: ${capacity}
import subprocess, os, time, requests, re, sys

RUNNER_ID     = "${runnerId}"
API_URL       = "${apiUrl}"
WORKER_SECRET = "${secret}"
CAPACITY      = ${capacity}
TIMEOUT_SEC   = ${timeoutS}
BASE_PORT     = 7860

subprocess.run(["pip", "install", "-q", "requests"], check=False)
subprocess.run(["bash", "-c", "curl -sLo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && chmod +x /usr/local/bin/ttyd"], check=False)
subprocess.run(["bash", "-c", "wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared"], check=False)

# ── Host Hardening & Sandbox Shielding ──
ADMIN_DIR = "/tmp/.absora_admin"
os.makedirs(ADMIN_DIR, mode=0o700, exist_ok=True)
os.chmod(ADMIN_DIR, 0o700)
# Process isolation: mount /proc with hidepid=2 so non-root users cannot see other processes
subprocess.run(["mount", "-o", "remount,rw,hidepid=2", "/proc"], check=False)
# Sandbox group setup
subprocess.run(["groupadd", "-f", "sandbox_users"], check=False)
# Deny sudo to sandboxed users
subprocess.run(["bash", "-c", "mkdir -p /etc/sudoers.d && echo '%sandbox_users ALL=(ALL) !ALL' > /etc/sudoers.d/99-absora && chmod 440 /etc/sudoers.d/99-absora 2>/dev/null"], check=False)

try:
    requests.post(f"{API_URL}/api/worker/register",
        json={"runner_id": RUNNER_ID, "type": "kaggle_cpu", "service": "vps", "capacity": CAPACITY},
        headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
    print(f"✅ VPS runner {RUNNER_ID} registered with capacity {CAPACITY}")
except Exception as e:
    print("VPS register error:", e)

sessions = {}
free_ports = [BASE_PORT + i + 1 for i in range(CAPACITY)]
idle_start = None

def start_session(session_key, term_pass):
    if not free_ports:
        print(f"⚠️ No free port for session {session_key}")
        return
    port = free_ports.pop(0)

    # ── Per-Session Unprivileged Sandbox ──
    clean_id = re.sub(r"[^a-zA-Z0-9]", "", session_key)[-8:].lower()
    box_user = f"box_{clean_id}"
    box_home = f"/home/{box_user}"

    # Create dedicated user without root privileges
    subprocess.run(["useradd", "-m", "-d", box_home, "-s", "/bin/bash", "-g", "sandbox_users", box_user], check=False)
    os.chmod(box_home, 0o700)
    subprocess.run(["chown", "-R", f"{box_user}:sandbox_users", box_home], check=False)

    # Configure user environment (.bashrc)
    try:
        with open(f"{box_home}/.bashrc", "a") as f:
            print("export PATH=$PATH:/usr/local/bin:~/.local/bin", file=f)
    except Exception:
        pass

    # Protected session IO log in user's isolated home directory
    io_log_file = f"{box_home}/.session_io.log"
    with open(io_log_file, "a") as f:
        pass
    subprocess.run(["chown", f"{box_user}:sandbox_users", io_log_file], check=False)
    os.chmod(io_log_file, 0o600)

    # Launch ttyd dropping root privileges via runuser (User cannot kill cloudflared or root processes)
    ttyd_cmd = f"cd {box_home} && /usr/local/bin/ttyd -i 127.0.0.1 -W -p {port} runuser -u {box_user} -- script -q -f -c 'bash -l' {io_log_file}"
    ttyd_proc = subprocess.Popen(["bash", "-c", ttyd_cmd])

    log_file = f"{ADMIN_DIR}/cf_vps_{port}.log"
    if os.path.exists(log_file):
        os.remove(log_file)
    cf_cmd = f"/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:{port} 2>&1 | tee {log_file}"
    cf_proc = subprocess.Popen(["bash", "-c", cf_cmd])

    sessions[session_key] = {
        "port": port,
        "ttyd_proc": ttyd_proc,
        "cf_proc": cf_proc,
        "url": None,
        "log_file": log_file,
        "io_log_file": io_log_file,
        "last_io_offset": 0,
        "poll_count": 0,
        "box_user": box_user
    }
    print(f"🚀 Started VPS session {session_key} (sandboxed user {box_user}) on port {port}")

def stop_session(session_key):
    if session_key in sessions:
        info = sessions.pop(session_key)
        # Terminate any background processes spawned by this sandboxed user
        box_user = info.get("box_user")
        if box_user:
            subprocess.run(["pkill", "-9", "-u", box_user], check=False)
        # Final flush of session I/O logs
        io_file = info.get("io_log_file")
        if io_file and os.path.exists(io_file):
            try:
                curr_size = os.path.getsize(io_file)
                last_offset = info.get("last_io_offset", 0)
                if curr_size > last_offset:
                    with open(io_file, "r", errors="ignore") as f:
                        f.seek(last_offset)
                        chunk = f.read()
                    if chunk:
                        requests.post(f"{API_URL}/api/worker/session_logs",
                            json={"session_key": session_key, "runner_id": RUNNER_ID, "logs": chunk},
                            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=5)
            except Exception:
                pass
        try:
            info["ttyd_proc"].terminate()
            info["cf_proc"].terminate()
        except Exception:
            pass
        free_ports.append(info["port"])
        print(f"🛑 Stopped VPS session {session_key} (freed port {info['port']})")

def check_session_urls():
    for sk, info in list(sessions.items()):
        if not info["url"] and info["poll_count"] < 40:
            info["poll_count"] += 1
            if os.path.exists(info["log_file"]):
                try:
                    log = open(info["log_file"]).read()
                    urls = re.findall(r"https://[\\w-]+\\.trycloudflare\\.com", log)
                    if urls:
                        info["url"] = urls[0]
                        print(f"✅ VPS session {sk} live at: {urls[0]}")
                        requests.post(f"{API_URL}/api/worker/session_update",
                            json={"session_key": sk, "status": "active", "tunnel_url": urls[0]},
                            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
                except Exception as e:
                    print(f"VPS tunnel parse error for {sk}:", e)

def sync_session_io_logs():
    for sk, info in list(sessions.items()):
        io_file = info.get("io_log_file")
        if io_file and os.path.exists(io_file):
            try:
                curr_size = os.path.getsize(io_file)
                last_offset = info.get("last_io_offset", 0)
                if curr_size > last_offset:
                    with open(io_file, "r", errors="ignore") as f:
                        f.seek(last_offset)
                        chunk = f.read(65536)
                        info["last_io_offset"] = f.tell()
                    if chunk:
                        requests.post(f"{API_URL}/api/worker/session_logs",
                            json={"session_key": sk, "runner_id": RUNNER_ID, "logs": chunk},
                            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=5)
            except Exception as e:
                pass

if "${initialSessionKey}":
    start_session("${initialSessionKey}", "${initPass}")

start_time = time.time()
while True:
    time.sleep(10)
    if time.time() - start_time > TIMEOUT_SEC:
        print("⏱️ Max VPS runner lifetime reached. Shutting down.")
        break

    check_session_urls()
    sync_session_io_logs()

    try:
        r = requests.post(f"{API_URL}/api/worker/runner_heartbeat",
            json={"runner_id": RUNNER_ID, "active_count": len(sessions)},
            headers={"X-Worker-Secret": WORKER_SECRET}, timeout=10)
        data = r.json()
        if data.get("kill"):
            print("🛑 Kill signal received for VPS runner.")
            break

        assignments = data.get("assignments", [])
        assigned_keys = {a["session_key"] for a in assignments}

        for sk in list(sessions.keys()):
            if sk not in assigned_keys:
                stop_session(sk)

        for a in assignments:
            sk = a["session_key"]
            if sk not in sessions:
                start_session(sk, a.get("term_pass", ""))

    except Exception as e:
        print("VPS heartbeat poll error:", e)

    if len(sessions) == 0:
        if idle_start is None:
            idle_start = time.time()
            print("⏳ VPS runner has 0 active sessions. Idle countdown started (300s)...")
        elif time.time() - idle_start > 300:
            print("⏱️ Idle timeout (300s) reached with 0 active users. Cleanly shutting down VPS runner.")
            try:
                requests.post(f"{API_URL}/api/worker/runner_shutdown",
                    json={"runner_id": RUNNER_ID, "reason": "idle_timeout_300s"},
                    headers={"X-Worker-Secret": WORKER_SECRET}, timeout=5)
            except Exception:
                pass
            break
    else:
        if idle_start is not None:
            print("⚡ New VPS session connected. Idle countdown reset.")
        idle_start = None

for sk in list(sessions.keys()):
    stop_session(sk)
subprocess.run(["pkill", "-9", "-f", "cloudflared"], check=False)
subprocess.run(["pkill", "-9", "-f", "ttyd"], check=False)
print("🏁 VPS runner shut down complete.")
sys.exit(0)
`.trim();
}
