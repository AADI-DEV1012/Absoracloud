#!/usr/bin/env python3
"""
☁️ AbsoraCloud VPS Multi-Tenant Runner Slicing Engine
Runs on GitHub Action runner (Ubuntu 22.04) or self-hosted server.
Slices single host into isolated Docker containers with strict CPU & RAM limits per plan.
Automates timeouts, heartbeats, and Cloudflare Tunnel routing.
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
log = logging.getLogger("AbsoraVPS")

# ── Environment ──
API_URL             = os.environ.get("API_URL", "https://absoracloud-api.onrender.com")
WORKER_SECRET       = os.environ.get("WORKER_SECRET", "absoracloud_worker_secret_2026")
RUNNER_ID           = os.environ.get("RUNNER_ID", f"vps-runner-{int(time.time())}")
UPSTASH_REDIS_URL   = os.environ.get("UPSTASH_REDIS_URL", "")
UPSTASH_REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_TOKEN", "")

CAPACITY   = int(os.environ.get("CAPACITY", "4"))
PORT_START = 9001
PORT_END   = 9020

# plan_key -> { cpus, memory_mb }
PLAN_LIMITS = {
    "free":       {"cpus": "0.5", "memory": "2048m"},
    "basic":      {"cpus": "1.0", "memory": "4096m"},
    "pro":        {"cpus": "2.0", "memory": "8192m"},
    "enterprise": {"cpus": "4.0", "memory": "16384m"},
}

# session_key -> { container_name, port, tunnel_proc, tunnel_url, plan, expires_at }
ACTIVE_VPS = {}

def get_free_port():
    used = {v["port"] for v in ACTIVE_VPS.values()}
    for p in range(PORT_START, PORT_END + 1):
        if p not in used:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(("127.0.0.1", p)) != 0:
                    return p
    return None

def start_vps_container(session_key: str, plan: str, timeout_seconds: int):
    if len(ACTIVE_VPS) >= CAPACITY:
        raise Exception(f"VPS runner capacity reached ({len(ACTIVE_VPS)}/{CAPACITY})")

    port = get_free_port()
    if not port:
        raise Exception("No free network ports available")

    limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])
    container_name = f"absora-vps-{session_key}"

    # Remove stale container if exists
    subprocess.run(["docker", "rm", "-f", container_name], capture_output=True)

    log.info(f"Launching container '{container_name}' (Plan: {plan}, CPUs: {limits['cpus']}, RAM: {limits['memory']})...")

    # Run sliced docker container with resource limits & web terminal (ttyd)
    docker_cmd = [
        "docker", "run", "-d",
        "--name", container_name,
        "--cpus", limits["cpus"],
        "--memory", limits["memory"],
        "-p", f"127.0.0.1:{port}:7681",
        "absoracloud-base",
        "ttyd", "-p", "7681", "-W", "bash"
    ]
    res = subprocess.run(docker_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        # Fallback if ttyd not in base image: run standard container
        docker_cmd_fb = [
            "docker", "run", "-d",
            "--name", container_name,
            "--cpus", limits["cpus"],
            "--memory", limits["memory"],
            "absoracloud-base", "sleep", "infinity"
        ]
        subprocess.run(docker_cmd_fb, capture_output=True)

    # Start Cloudflare Tunnel for this port
    tunnel_cmd = [
        "cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"
    ]
    tunnel_proc = subprocess.Popen(
        tunnel_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
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

    ACTIVE_VPS[session_key] = {
        "container_name": container_name,
        "port": port,
        "tunnel_proc": tunnel_proc,
        "tunnel_url": tunnel_url,
        "plan": plan,
        "expires_at": expires_at,
    }

    log.info(f"✅ VPS '{session_key}' ready at {tunnel_url} (Port {port})")

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

    return tunnel_url

def stop_vps_container(session_key: str):
    if session_key not in ACTIVE_VPS:
        return
    info = ACTIVE_VPS.pop(session_key)
    log.info(f"🛑 Halting VPS '{session_key}'...")

    if info.get("tunnel_proc"):
        try:
            info["tunnel_proc"].terminate()
        except Exception:
            pass

    subprocess.run(["docker", "rm", "-f", info["container_name"]], capture_output=True)

    try:
        requests.post(
            f"{API_URL}/worker/session_update",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={"session_key": session_key, "status": "stopped"},
            timeout=5,
        )
    except Exception:
        pass

# ── Local Automated Watchdog (Enforces Timeouts & Limits) ──
def local_watchdog():
    while True:
        try:
            now = time.time()
            for k, info in list(ACTIVE_VPS.items()):
                # Timeout limit reached
                if now >= info["expires_at"]:
                    log.info(f"⏱️ Plan time limit expired for VPS {k}. Auto-stopping...")
                    stop_vps_container(k)
                    continue

                # Check Redis kill signal
                if UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN:
                    try:
                        r = requests.get(
                            f"{UPSTASH_REDIS_URL}/get/kill:{k}",
                            headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}"},
                            timeout=3
                        ).json()
                        if r.get("result") == "1":
                            log.info(f"Received API kill signal for VPS {k}. Stopping...")
                            stop_vps_container(k)
                    except Exception:
                        pass
        except Exception as e:
            log.error(f"VPS watchdog error: {e}")
        time.sleep(15)

# ── Heartbeat Worker ──
def heartbeat_loop():
    while True:
        try:
            requests.post(
                f"{API_URL}/worker/heartbeat",
                headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
                json={"runner_id": RUNNER_ID, "active_count": len(ACTIVE_VPS)},
                timeout=5,
            )
        except Exception:
            pass
        time.sleep(30)

# ── Redis Task Queue Listener ──
def task_listener():
    if not (UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN):
        return
    queue_key = f"runner:{RUNNER_ID}:tasks"
    while True:
        try:
            res = requests.get(
                f"{UPSTASH_REDIS_URL}/lpop/{queue_key}",
                headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}"},
                timeout=5
            ).json()
            task_raw = res.get("result")
            if task_raw:
                task = json.loads(task_raw)
                action = task.get("action")
                if action == "start_vps":
                    start_vps_container(
                        task["session_key"],
                        task.get("plan", "free"),
                        task.get("timeout_seconds", 14400)
                    )
                elif action == "stop_vps":
                    stop_vps_container(task["session_key"])
        except Exception:
            pass
        time.sleep(3)

if __name__ == "__main__":
    # Register runner with API
    log.info(f"Registering VPS runner {RUNNER_ID} with capacity {CAPACITY}...")
    try:
        requests.post(
            f"{API_URL}/worker/register",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={
                "runner_id": RUNNER_ID,
                "type": "github",
                "service": "vps",
                "capacity": CAPACITY,
            },
            timeout=10,
        )
    except Exception as e:
        log.error(f"Failed to register runner: {e}")

    # Start background threads
    threading.Thread(target=local_watchdog, daemon=True).start()
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    threading.Thread(target=task_listener, daemon=True).start()

    log.info("VPS Multi-Tenant Slicing Daemon is running.")
    while True:
        time.sleep(60)
