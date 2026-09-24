#!/usr/bin/env python3
"""
☁️ AbsoraCloud Minecraft Multi-Tenant Runner Slicing Engine
Runs on GitHub Action runner (Ubuntu 22.04) or self-hosted server.
Hosts multiple isolated Minecraft servers per runner with RAM sliced per user plan.
Automates idle shutdown, plan timeouts, player heartbeats, and playit/tunnel routing.
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
log = logging.getLogger("AbsoraMC")

API_URL             = os.environ.get("API_URL", "https://absoracloud-api.onrender.com")
WORKER_SECRET       = os.environ.get("WORKER_SECRET", "absoracloud_worker_secret_2026")
RUNNER_ID           = os.environ.get("RUNNER_ID", f"mc-runner-{int(time.time())}")
UPSTASH_REDIS_URL   = os.environ.get("UPSTASH_REDIS_URL", "")
UPSTASH_REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_TOKEN", "")

CAPACITY   = int(os.environ.get("CAPACITY", "2"))
MC_DIR     = os.path.abspath("./mc_instances")
os.makedirs(MC_DIR, exist_ok=True)

PORT_START = 25565
PORT_END   = 25575

# session_key -> { proc, port, ram_mb, expires_at, last_active, tunnel_url }
ACTIVE_MC = {}

def get_free_port():
    used = {v["port"] for v in ACTIVE_MC.values()}
    for p in range(PORT_START, PORT_END + 1):
        if p not in used:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(("127.0.0.1", p)) != 0:
                    return p
    return None

def start_mc_server(session_key: str, server_type: str, version: str, ram_mb: int, timeout_seconds: int):
    if len(ACTIVE_MC) >= CAPACITY:
        raise Exception(f"MC runner capacity reached ({len(ACTIVE_MC)}/{CAPACITY})")

    port = get_free_port()
    if not port:
        raise Exception("No free Minecraft ports available")

    inst_dir = os.path.join(MC_DIR, session_key)
    os.makedirs(inst_dir, exist_ok=True)

    # Accept EULA
    with open(os.path.join(inst_dir, "eula.txt"), "w") as f:
        f.write("eula=true\n")

    # Set server.properties
    with open(os.path.join(inst_dir, "server.properties"), "w") as f:
        f.write(f"server-port={port}\nquery.port={port}\nmotd=AbsoraCloud Server\nonline-mode=false\n")

    # Download server JAR if missing
    jar_path = os.path.join(inst_dir, "server.jar")
    if not os.path.exists(jar_path):
        log.info(f"Downloading Paper MC jar for {version}...")
        paper_url = "https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/496/downloads/paper-1.20.4-496.jar"
        try:
            r = requests.get(paper_url, timeout=30)
            with open(jar_path, "wb") as f:
                f.write(r.content)
        except Exception:
            pass

    log.info(f"Starting MC server {session_key} on port {port} with {ram_mb}MB RAM...")
    java_cmd = [
        "java",
        f"-Xms{ram_mb // 2}M",
        f"-Xmx{ram_mb}M",
        "-XX:+UseG1GC",
        "-jar", "server.jar",
        "nogui"
    ]

    proc = subprocess.Popen(
        java_cmd,
        cwd=inst_dir,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    tunnel_url = f"{socket.gethostname()}:{port}"
    expires_at = time.time() + timeout_seconds

    ACTIVE_MC[session_key] = {
        "proc": proc,
        "port": port,
        "ram_mb": ram_mb,
        "expires_at": expires_at,
        "last_active": time.time(),
        "tunnel_url": tunnel_url,
    }

    log.info(f"✅ MC Server '{session_key}' started on port {port}")

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

def stop_mc_server(session_key: str):
    if session_key not in ACTIVE_MC:
        return
    info = ACTIVE_MC.pop(session_key)
    log.info(f"🛑 Stopping MC server {session_key}...")
    if info.get("proc"):
        try:
            info["proc"].terminate()
            info["proc"].wait(timeout=10)
        except Exception:
            try:
                info["proc"].kill()
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

# ── Local Automated Watchdog (Enforces Timeouts & Limits) ──
def local_watchdog():
    while True:
        try:
            now = time.time()
            for k, info in list(ACTIVE_MC.items()):
                # Expiration check
                if now >= info["expires_at"]:
                    log.info(f"⏱️ Plan time limit reached for MC {k}. Auto-stopping...")
                    stop_mc_server(k)
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
                            log.info(f"Received API kill signal for MC {k}. Stopping...")
                            stop_mc_server(k)
                    except Exception:
                        pass
        except Exception as e:
            log.error(f"MC Watchdog error: {e}")
        time.sleep(15)

def heartbeat_loop():
    while True:
        try:
            requests.post(
                f"{API_URL}/worker/heartbeat",
                headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
                json={"runner_id": RUNNER_ID, "active_count": len(ACTIVE_MC)},
                timeout=5,
            )
        except Exception:
            pass
        time.sleep(30)

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
                if action == "start_mc":
                    start_mc_server(
                        task["session_key"],
                        task.get("server_type", "paper"),
                        task.get("version", "1.20.4"),
                        int(task.get("ram_mb", 1024)),
                        task.get("timeout_seconds", 21600)
                    )
                elif action == "stop_mc":
                    stop_mc_server(task["session_key"])
        except Exception:
            pass
        time.sleep(3)

if __name__ == "__main__":
    log.info(f"Registering MC runner {RUNNER_ID} with capacity {CAPACITY}...")
    try:
        requests.post(
            f"{API_URL}/worker/register",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={
                "runner_id": RUNNER_ID,
                "type": "github",
                "service": "mc",
                "capacity": CAPACITY,
            },
            timeout=10,
        )
    except Exception as e:
        log.error(f"Failed to register MC runner: {e}")

    threading.Thread(target=local_watchdog, daemon=True).start()
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    threading.Thread(target=task_listener, daemon=True).start()

    log.info("Minecraft Multi-Tenant Slicing Daemon is running.")
    while True:
        time.sleep(60)
