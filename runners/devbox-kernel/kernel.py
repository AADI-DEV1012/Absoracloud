#!/usr/bin/env python3
"""
☁️ AbsoraCloud DevBox Kaggle GPU Pool Runner
Runs inside a Kaggle notebook with Dual Nvidia T4 GPUs (ZeroGPU pool).
Handles up to 4 concurrent multi-tenant user sessions with GPU access,
Cloudflare Tunnels, and automated watchdog timeouts.
"""

import os
import sys
import time
import json
import socket
import logging
import threading
import subprocess
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("AbsoraDevBox")

API_URL             = os.environ.get("API_URL", "https://absoracloud-api.onrender.com")
WORKER_SECRET       = os.environ.get("WORKER_SECRET", "absoracloud_worker_secret_2026")
RUNNER_ID           = os.environ.get("RUNNER_ID", f"devbox-kaggle-{int(time.time())}")
UPSTASH_REDIS_URL   = os.environ.get("UPSTASH_REDIS_URL", "")
UPSTASH_REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_TOKEN", "")

CAPACITY   = 4
PORT_START = 8888
PORT_END   = 8892

ACTIVE_SESSIONS = {}

def get_free_port():
    used = {v["port"] for v in ACTIVE_SESSIONS.values()}
    for p in range(PORT_START, PORT_END + 1):
        if p not in used:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(("127.0.0.1", p)) != 0:
                    return p
    return None

def start_devbox_session(session_key: str, plan: str, timeout_seconds: int):
    if len(ACTIVE_SESSIONS) >= CAPACITY:
        raise Exception("DevBox GPU capacity full")

    port = get_free_port()
    if not port:
        raise Exception("No free ports for DevBox session")

    workspace = f"/tmp/devbox_{session_key}"
    os.makedirs(workspace, exist_ok=True)

    log.info(f"Starting DevBox JupyterLab/VSCode for {session_key} on port {port}...")

    # Launch JupyterLab / bash web console
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "jupyter", "lab",
            f"--port={port}",
            "--ip=127.0.0.1",
            "--no-browser",
            "--NotebookApp.token=''",
            f"--notebook-dir={workspace}"
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    # Launch Cloudflare tunnel
    tunnel_proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )

    tunnel_url = None
    start_t = time.time()
    while time.time() - start_t < 15:
        line = tunnel_proc.stdout.readline()
        if "trycloudflare.com" in line:
            import re
            m = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
            if m:
                tunnel_url = m.group(0)
                break
        time.sleep(0.1)

    if not tunnel_url:
        tunnel_url = f"https://{session_key}.trycloudflare.com"

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

    # Notify API
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

    # Free PyTorch GPU memory if installed
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
    log.info(f"Registering DevBox Kaggle GPU Pool {RUNNER_ID}...")
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
    except Exception as e:
        log.error(f"Failed to register DevBox runner: {e}")

    threading.Thread(target=local_watchdog, daemon=True).start()
    threading.Thread(target=heartbeat_loop, daemon=True).start()

    log.info("Kaggle GPU Pool is ready.")
    while True:
        time.sleep(60)
