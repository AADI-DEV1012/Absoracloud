#!/usr/bin/env python3
"""
☁️ AbsoraCloud DevBox Cloud GPU Pool Runner
Runs inside an automated GPU container with Dual Nvidia T4 GPUs.
Handles up to 4 concurrent multi-tenant user sessions with GPU access,
Cloudflare Tunnels, Redis task queue polling, and automated watchdog timeouts.
"""

import os
import sys
import time
import json
import socket
import logging
import threading
import subprocess
import shutil
import re
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("AbsoraDevBox")

API_URL             = os.environ.get("API_URL", "https://absoracloud-api.onrender.com")
WORKER_SECRET       = os.environ.get("WORKER_SECRET", "absoracloud_worker_secret_2026")
RUNNER_ID           = os.environ.get("RUNNER_ID", f"devbox-runner-{int(time.time())}")
UPSTASH_REDIS_URL   = os.environ.get("UPSTASH_REDIS_URL", "https://sharing-dodo-298502.upstash.io")
UPSTASH_REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_TOKEN", "gQAAAAAABI4GAAIgcDJiNjFmOTk4YzM4ZGQ0OTMzYTkzZmVkOTg4NmIzNDU0YQ")

CAPACITY   = 4
PORT_START = 8888
PORT_END   = 8892

ACTIVE_SESSIONS = {}
CLOUDFLARED_BIN = "/tmp/cloudflared"

def ensure_dependencies():
    """Ensure jupyterlab and dependencies are installed."""
    try:
        import jupyterlab
    except ImportError:
        log.info("Installing jupyterlab...")
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "jupyterlab"], check=False)

def ensure_cloudflared():
    global CLOUDFLARED_BIN
    if shutil.which("cloudflared"):
        CLOUDFLARED_BIN = shutil.which("cloudflared")
        return
    if os.path.exists("/tmp/cloudflared") and os.access("/tmp/cloudflared", os.X_OK):
        CLOUDFLARED_BIN = "/tmp/cloudflared"
        return
    log.info("Downloading cloudflared binary...")
    try:
        url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        r = requests.get(url, stream=True, timeout=30)
        with open("/tmp/cloudflared", "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        os.chmod("/tmp/cloudflared", 0o755)
        CLOUDFLARED_BIN = "/tmp/cloudflared"
        log.info("cloudflared binary ready.")
    except Exception as e:
        log.error(f"Failed to download cloudflared: {e}")

def get_free_port():
    used = {v["port"] for v in ACTIVE_SESSIONS.values()}
    for p in range(PORT_START, PORT_END + 1):
        if p not in used:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(("127.0.0.1", p)) != 0:
                    return p
    return None

def start_devbox_session(session_key: str, plan: str = "free", timeout_seconds: int = 3600):
    if len(ACTIVE_SESSIONS) >= CAPACITY:
        log.warning(f"Capacity full ({len(ACTIVE_SESSIONS)}/{CAPACITY}), cannot launch {session_key}")
        return

    if session_key in ACTIVE_SESSIONS:
        log.info(f"Session {session_key} already active.")
        return

    port = get_free_port()
    if not port:
        log.error("No free ports for DevBox session")
        return

    workspace = f"/tmp/devbox_{session_key}"
    os.makedirs(workspace, exist_ok=True)

    log.info(f"Starting DevBox JupyterLab for {session_key} on port {port}...")

    # Launch JupyterLab headless with open remote access & no token requirement
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "jupyter", "lab",
            f"--port={port}",
            "--ip=0.0.0.0",
            "--no-browser",
            "--NotebookApp.token=",
            "--NotebookApp.password=",
            "--ServerApp.token=",
            "--ServerApp.password=",
            "--ServerApp.disable_check_xsrf=True",
            "--ServerApp.allow_remote_access=True",
            "--ServerApp.allow_origin=*",
            "--NotebookApp.allow_remote_access=True",
            "--NotebookApp.allow_origin=*",
            f"--notebook-dir={workspace}",
            "--allow-root"
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    time.sleep(2)

    # Launch Cloudflare quick tunnel
    ensure_cloudflared()
    tunnel_proc = subprocess.Popen(
        [CLOUDFLARED_BIN, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )

    tunnel_url = None

    def read_tunnel_output():
        nonlocal tunnel_url
        try:
            for line in iter(tunnel_proc.stdout.readline, ''):
                if not line:
                    break
                m = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
                if m:
                    tunnel_url = m.group(0)
                    log.info(f"Discovered Cloudflare Tunnel URL: {tunnel_url}")
                    break
        except Exception:
            pass

    t_reader = threading.Thread(target=read_tunnel_output, daemon=True)
    t_reader.start()
    t_reader.join(timeout=25)

    if not tunnel_url:
        log.error(f"Failed to acquire Cloudflare Tunnel for {session_key}")
        try:
            requests.post(
                f"{API_URL}/worker/session_update",
                headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
                json={"session_key": session_key, "status": "failed", "error": "Failed to establish Cloudflare tunnel"},
                timeout=5,
            )
        except Exception:
            pass
        for p in [tunnel_proc, proc]:
            try:
                p.terminate()
            except Exception:
                pass
        return

    expires_at = time.time() + timeout_seconds

    ACTIVE_SESSIONS[session_key] = {
        "proc": proc,
        "tunnel_proc": tunnel_proc,
        "port": port,
        "tunnel_url": tunnel_url,
        "plan": plan,
        "expires_at": expires_at,
        "workspace": workspace,
    }

    log.info(f"✅ DevBox session '{session_key}' live at {tunnel_url}")

    # Notify API Gateway
    try:
        requests.post(
            f"{API_URL}/worker/session_update",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={
                "session_key": session_key,
                "status": "active",
                "tunnel_url": tunnel_url,
                "expires_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(expires_at)),
            },
            timeout=5,
        )
    except Exception as e:
        log.error(f"Failed to report session: {e}")

def stop_devbox_session(session_key: str):
    if session_key not in ACTIVE_SESSIONS:
        return
    info = ACTIVE_SESSIONS.pop(session_key)
    log.info(f"🛑 Stopping DevBox session {session_key}...")

    for p in [info.get("tunnel_proc"), info.get("proc")]:
        if p:
            try:
                p.terminate()
            except Exception:
                pass

    # Free PyTorch GPU memory if CUDA is available
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

    try:
        requests.post(
            f"{API_URL}/worker/session_update",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={"session_key": session_key, "status": "stopped"},
            timeout=5,
        )
    except Exception:
        pass

# ── Redis Task Queue Consumer ──
def redis_queue_consumer():
    if not (UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN):
        log.warning("No Redis credentials, skipping queue consumer.")
        return
    log.info("Started Redis queue consumer for devbox:tasks...")
    while True:
        try:
            res = requests.get(
                f"{UPSTASH_REDIS_URL}/lpop/devbox:tasks",
                headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}"},
                timeout=5
            ).json()
            task_raw = res.get("result")
            if task_raw:
                task = json.loads(task_raw)
                action = task.get("action")
                session_key = task.get("session_key")
                log.info(f"Received DevBox task: {action} for {session_key}")
                if action == "launch":
                    # Run launcher in thread so consumer loop is non-blocking
                    threading.Thread(
                        target=start_devbox_session,
                        args=(session_key, task.get("plan", "free"), int(task.get("timeout_seconds", 3600))),
                        daemon=True
                    ).start()
                elif action == "stop":
                    stop_devbox_session(session_key)
        except Exception as e:
            log.error(f"Error in Redis consumer: {e}")
        time.sleep(3)

# ── Local Automated Watchdog ──
def local_watchdog():
    while True:
        try:
            now = time.time()
            for k, info in list(ACTIVE_SESSIONS.items()):
                if now >= info["expires_at"]:
                    log.info(f"⏱️ GPU time quota reached for DevBox {k}. Auto-stopping...")
                    stop_devbox_session(k)
                    continue

                if UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN:
                    try:
                        r = requests.get(
                            f"{UPSTASH_REDIS_URL}/get/kill:{k}",
                            headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}"},
                            timeout=3
                        ).json()
                        if r.get("result") == "1":
                            log.info(f"API kill signal for DevBox {k}. Stopping...")
                            stop_devbox_session(k)
                    except Exception:
                        pass
        except Exception as e:
            log.error(f"DevBox watchdog error: {e}")
        time.sleep(15)

def heartbeat_loop():
    while True:
        try:
            requests.post(
                f"{API_URL}/worker/heartbeat",
                headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
                json={"runner_id": RUNNER_ID, "active_count": len(ACTIVE_SESSIONS)},
                timeout=5,
            )
        except Exception:
            pass
        time.sleep(30)

if __name__ == "__main__":
    log.info(f"Starting DevBox GPU Pool {RUNNER_ID}...")

    ensure_dependencies()

    # Log GPU info
    try:
        import torch
        if torch.cuda.is_available():
            dev_name = torch.cuda.get_device_name(0)
            log.info(f"🚀 CUDA Detected: {dev_name} (Devices: {torch.cuda.device_count()})")
        else:
            log.info("No CUDA hardware detected in this environment.")
    except Exception:
        pass

    try:
        requests.post(
            f"{API_URL}/worker/register",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={
                "runner_id": RUNNER_ID,
                "type": "kaggle",
                "service": "devbox",
                "capacity": CAPACITY,
            },
            timeout=10,
        )
        log.info(f"Registered DevBox runner {RUNNER_ID} with API Gateway.")
    except Exception as e:
        log.error(f"Failed to register DevBox runner: {e}")

    threading.Thread(target=redis_queue_consumer, daemon=True).start()
    threading.Thread(target=local_watchdog, daemon=True).start()
    threading.Thread(target=heartbeat_loop, daemon=True).start()

    log.info("DevBox GPU Pool is ready and listening for tasks.")
    while True:
        time.sleep(60)
