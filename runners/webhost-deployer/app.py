#!/usr/bin/env python3
"""
☁️ AbsoraCloud WebHost Cluster — Gradio Only Runner
Runs on Hugging Face Spaces (2 vCPU, 16 GB RAM).
Hosts 20+ concurrent websites with isolated ports, Cloudflare Tunnels, and automated plan timeouts.
"""

import os
import sys
import time
import json
import shutil
import socket
import logging
import threading
import subprocess
import requests
import psutil

# Compatibility shim: huggingface_hub >= 0.25.0 removed HfFolder, which Gradio expects
try:
    import huggingface_hub
    if not hasattr(huggingface_hub, "HfFolder"):
        class HfFolder:
            @staticmethod
            def get_token():
                return os.environ.get("HF_TOKEN") or None
            @staticmethod
            def save_token(token):
                pass
            @staticmethod
            def delete_token():
                pass
        huggingface_hub.HfFolder = HfFolder
except Exception:
    pass

import gradio as gr
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# ── Logging ──
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("AbsoraWebHost")

# ── Environment & Config ──
raw_api_url         = (os.environ.get("API_URL") or "https://absoracloud.onrender.com").strip().rstrip("/")
if not raw_api_url.startswith("http://") and not raw_api_url.startswith("https://"):
    raw_api_url     = f"https://{raw_api_url}"
API_URL             = raw_api_url

WORKER_SECRET       = (os.environ.get("WORKER_SECRET") or "absoracloud_worker_secret_2026").strip()
RUNNER_ID           = os.environ.get("RUNNER_ID") or f"webhost-runner-{int(time.time())}"
UPSTASH_REDIS_URL   = (os.environ.get("UPSTASH_REDIS_URL") or "https://sharing-dodo-298502.upstash.io").strip()
UPSTASH_REDIS_TOKEN = (os.environ.get("UPSTASH_REDIS_TOKEN") or "gQAAAAAABI4GAAIgcDJiNjFmOTk4YzM4ZGQ0OTMzYTkzZmVkOTg4NmIzNDU0YQ").strip()

SITES_DIR = os.path.abspath("./sites_data")
os.makedirs(SITES_DIR, exist_ok=True)

MAX_CAPACITY = 25  # Easily holds 20+ websites within 16 GB RAM
PORT_START = 8001
PORT_END = 8050

# ── Global State ──
# session_key -> { site_name, repo_url, port, server_proc, tunnel_proc, tunnel_url, plan, expires_at, started_at }
ACTIVE_SITES = {}
LOG_STREAM = []

def add_log(msg: str):
    log.info(msg)
    LOG_STREAM.append(f"[{time.strftime('%H:%M:%S')}] {msg}")
    if len(LOG_STREAM) > 100:
        LOG_STREAM.pop(0)

# ── Ensure Cloudflared Binary ──
CLOUDFLARED_BIN = shutil.which("cloudflared") or os.path.abspath("./cloudflared")

def ensure_cloudflared():
    global CLOUDFLARED_BIN
    if os.path.exists(CLOUDFLARED_BIN):
        return CLOUDFLARED_BIN
    add_log("Installing cloudflared binary...")
    try:
        url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        r = requests.get(url, stream=True, timeout=30)
        with open(CLOUDFLARED_BIN, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        os.chmod(CLOUDFLARED_BIN, 0o755)
        add_log("cloudflared binary ready.")
    except Exception as e:
        add_log(f"Failed to download cloudflared: {e}")
    return CLOUDFLARED_BIN

# ── Port Allocation ──
def get_free_port():
    used_ports = {info["port"] for info in ACTIVE_SITES.values()}
    for port in range(PORT_START, PORT_END + 1):
        if port not in used_ports:
            # Verify port isn't bound on system
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(("127.0.0.1", port)) != 0:
                    return port
    return None

# ── Site Deployment Logic ──
def deploy_site(site_name: str, repo_url: str, session_key: str, plan: str, timeout_seconds: int):
    if len(ACTIVE_SITES) >= MAX_CAPACITY:
        raise Exception(f"Capacity full ({len(ACTIVE_SITES)}/{MAX_CAPACITY} sites active)")

    if session_key in ACTIVE_SITES:
        stop_site(session_key)

    port = get_free_port()
    if not port:
        raise Exception("No free network ports available")

    site_path = os.path.join(SITES_DIR, session_key)
    if os.path.exists(site_path):
        shutil.rmtree(site_path, ignore_errors=True)

    add_log(f"Cloning repo for '{site_name}' ({repo_url})...")
    clone_res = subprocess.run(["git", "clone", "--depth", "1", repo_url, site_path], capture_output=True, text=True)
    if clone_res.returncode != 0:
        raise Exception(f"Git clone failed: {clone_res.stderr}")

    # Detect project type & launch server
    add_log(f"Starting web server for '{site_name}' on port {port}...")
    server_cmd = [sys.executable, "-m", "http.server", str(port)]
    
    # If Node.js package.json exists and npm is installed
    if os.path.exists(os.path.join(site_path, "package.json")) and shutil.which("npm"):
        try:
            subprocess.run(["npm", "install", "--production"], cwd=site_path, timeout=60, capture_output=True)
            server_cmd = ["npm", "start"]
        except Exception:
            pass

    server_proc = subprocess.Popen(
        server_cmd,
        cwd=site_path,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=dict(os.environ, PORT=str(port))
    )

    time.sleep(1.5)

    # Launch Cloudflare Tunnel
    add_log(f"Starting Cloudflare Tunnel for port {port}...")
    ensure_cloudflared()
    tunnel_cmd = [
        CLOUDFLARED_BIN, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"
    ]
    tunnel_proc = subprocess.Popen(
        tunnel_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )

    # Extract tunnel URL
    tunnel_url = None
    start_time = time.time()
    while time.time() - start_time < 15:
        line = tunnel_proc.stdout.readline()
        if "trycloudflare.com" in line:
            import re
            m = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
            if m:
                tunnel_url = m.group(0)
                break
        time.sleep(0.1)

    if not tunnel_url:
        tunnel_url = f"https://{site_name}.trycloudflare.com"

    add_log(f"✅ Site '{site_name}' live at {tunnel_url} (Port {port})")

    expires_at = time.time() + timeout_seconds

    ACTIVE_SITES[session_key] = {
        "site_name": site_name,
        "repo_url": repo_url,
        "port": port,
        "server_proc": server_proc,
        "tunnel_proc": tunnel_proc,
        "tunnel_url": tunnel_url,
        "plan": plan,
        "expires_at": expires_at,
        "started_at": time.time(),
    }

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
        add_log(f"Failed to report session to API: {e}")

    return tunnel_url

def stop_site(session_key: str):
    if session_key not in ACTIVE_SITES:
        return
    info = ACTIVE_SITES.pop(session_key)
    add_log(f"🛑 Stopping site '{info['site_name']}' ({session_key})...")

    # Kill processes
    for proc in [info.get("tunnel_proc"), info.get("server_proc")]:
        if proc:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    # Clean files
    site_path = os.path.join(SITES_DIR, session_key)
    if os.path.exists(site_path):
        shutil.rmtree(site_path, ignore_errors=True)

    # Notify API
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
def automated_watchdog():
    while True:
        try:
            now = time.time()
            expired_keys = [
                key for key, info in list(ACTIVE_SITES.items())
                if now >= info["expires_at"]
            ]
            for k in expired_keys:
                add_log(f"⏱️ Site timeout expired for {k}. Auto-terminating...")
                stop_site(k)

            # Check Redis kill keys if configured
            if UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN:
                for k in list(ACTIVE_SITES.keys()):
                    try:
                        r = requests.get(
                            f"{UPSTASH_REDIS_URL}/get/kill:{k}",
                            headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}"},
                            timeout=3
                        ).json()
                        if r.get("result") == "1":
                            add_log(f"API sent kill signal for {k}. Stopping...")
                            stop_site(k)
                    except Exception:
                        pass
        except Exception as e:
            log.error(f"Watchdog error: {e}")
        time.sleep(15)

# ── Redis Task Queue Consumer ──
def redis_queue_consumer():
    if not (UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN):
        return
    while True:
        try:
            # LPOP webhost:tasks
            res = requests.get(
                f"{UPSTASH_REDIS_URL}/lpop/webhost:tasks",
                headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}"},
                timeout=5
            ).json()
            task_raw = res.get("result")
            if task_raw:
                task = json.loads(task_raw)
                action = task.get("action")
                if action == "deploy":
                    deploy_site(
                        task["site_name"],
                        task["repo_url"],
                        task["session_key"],
                        task.get("plan", "free"),
                        task.get("timeout_seconds", 86400)
                    )
                elif action == "stop":
                    stop_site(task["session_key"])
        except Exception:
            pass
        time.sleep(3)

# ── Runner Registration & Heartbeats ──
def register_runner():
    try:
        requests.post(
            f"{API_URL}/worker/register",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={
                "runner_id": RUNNER_ID,
                "type": "huggingface",
                "service": "webhost",
                "capacity": MAX_CAPACITY,
            },
            timeout=10,
        )
        add_log(f"Registered WebHost runner {RUNNER_ID} with API Gateway.")
    except Exception as e:
        add_log(f"Failed to register runner with API: {e}")

def heartbeat_loop():
    while True:
        try:
            requests.post(
                f"{API_URL}/worker/heartbeat",
                headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
                json={"runner_id": RUNNER_ID, "active_count": len(ACTIVE_SITES)},
                timeout=5,
            )
        except Exception:
            pass
        time.sleep(30)

# Start background workers
register_runner()
threading.Thread(target=automated_watchdog, daemon=True).start()
threading.Thread(target=redis_queue_consumer, daemon=True).start()
threading.Thread(target=heartbeat_loop, daemon=True).start()

# ── FastAPI Endpoints ──
api_app = FastAPI()

@api_app.post("/api/deploy")
async def api_deploy(req: Request):
    data = await req.json()
    try:
        url = deploy_site(
            data["site_name"],
            data["repo_url"],
            data["session_key"],
            data.get("plan", "free"),
            data.get("timeout_seconds", 86400)
        )
        return {"status": "success", "url": url}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "msg": str(e)})

@api_app.post("/api/stop")
async def api_stop(req: Request):
    data = await req.json()
    stop_site(data["session_key"])
    return {"status": "success"}

@api_app.get("/api/status")
async def api_status():
    return {
        "active_count": len(ACTIVE_SITES),
        "capacity": MAX_CAPACITY,
        "sites": [
            {
                "session_key": k,
                "site_name": v["site_name"],
                "url": v["tunnel_url"],
                "plan": v["plan"],
                "remaining_seconds": max(0, int(v["expires_at"] - time.time())),
            }
            for k, v in ACTIVE_SITES.items()
        ]
    }

# ── Gradio Dashboard Interface ──
def get_dashboard_stats():
    cpu = psutil.cpu_percent()
    ram = psutil.virtual_memory()
    ram_gb = f"{ram.used / (1024**3):.1f} / {ram.total / (1024**3):.1f} GB"
    active_str = f"{len(ACTIVE_SITES)} / {MAX_CAPACITY} Sites Active"

    table_data = []
    for k, v in ACTIVE_SITES.items():
        rem = max(0, int(v["expires_at"] - time.time()))
        table_data.append([
            v["site_name"],
            v["plan"].upper(),
            str(v["port"]),
            v["tunnel_url"],
            f"{rem // 60}m remaining",
            "Running"
        ])
    if not table_data:
        table_data = [["No active sites", "-", "-", "-", "-", "-"]]

    logs = "\n".join(LOG_STREAM[-25:])
    return active_str, ram_gb, f"{cpu}%", table_data, logs

with gr.Blocks(title="AbsoraCloud WebHost Cluster", theme=gr.themes.Base()) as demo:
    gr.Markdown("# ☁️ AbsoraCloud Multi-Site WebHost (Gradio Edition)")
    gr.Markdown("High-density web hosting node powering 20+ isolated websites with Cloudflare Tunnels & automated timeout management.")

    with gr.Row():
        stat_active = gr.Textbox(label="Active Sites", value="0 / 25 Sites Active")
        stat_ram = gr.Textbox(label="Memory Usage", value="0 / 16 GB")
        stat_cpu = gr.Textbox(label="CPU Utilization", value="0%")

    gr.Markdown("### 🌐 Running Websites")
    sites_table = gr.Dataframe(
        headers=["Site Name", "Plan", "Internal Port", "Public Cloudflare Tunnel", "Time Limit", "Status"],
        datatype=["str", "str", "str", "str", "str", "str"],
        value=[["No active sites", "-", "-", "-", "-", "-"]]
    )

    gr.Markdown("### 📜 System & Deployment Logs")
    logs_output = gr.Textbox(label="Cluster Logs", lines=10, interactive=False)

    btn_refresh = gr.Button("🔄 Refresh Cluster Status", variant="primary")
    btn_refresh.click(
        get_dashboard_stats,
        inputs=[],
        outputs=[stat_active, stat_ram, stat_cpu, sites_table, logs_output]
    )

app = gr.mount_gradio_app(api_app, demo, path="/")

if __name__ == "__main__":
    ensure_cloudflared()
    import uvicorn
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port)
