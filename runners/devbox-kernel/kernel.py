#!/usr/bin/env python3
"""
☁️ AbsoraCloud DevBox Cloud GPU Workstation Runner
Runs inside an automated GPU container with Dual Nvidia T4 GPUs.
Colab-style interactive compute:
  • Multi-runtime kernel switching: "Python 3 (2× Tesla T4 GPU)" ↔ "Python 3 (Standard CPU)"
  • Integrated headless JupyterLab with pre-configured welcome notebook
  • Dedicated bash web terminal
  • Direct Upstash Redis REST POST state synchronization
  • Dual Nvidia Tesla T4 GPU hardware acceleration with VRAM auto-clearing
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

API_URL             = os.environ.get("API_URL", "https://absoracloud.onrender.com")
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

def setup_kernels():
    """
    Install Colab-style runtime kernelspecs:
    1. Python 3 (2× Tesla T4 GPU): CUDA_VISIBLE_DEVICES="0,1"
    2. Python 3 (Standard CPU): CUDA_VISIBLE_DEVICES=""
    This allows switching runtimes directly on the same notebook via the top-right kernel selector.
    """
    try:
        import jupyter_client.kernelspec as ks

        # 1. GPU Runtime (2x Tesla T4)
        gpu_dir = "/tmp/kernels/python3-gpu"
        os.makedirs(gpu_dir, exist_ok=True)
        with open(f"{gpu_dir}/kernel.json", "w") as f:
            json.dump({
                "argv": [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                "display_name": "Python 3 (2× Tesla T4 GPU)",
                "language": "python",
                "env": {
                    "CUDA_VISIBLE_DEVICES": "0,1"
                },
                "metadata": {
                    "debugger": True
                }
            }, f, indent=2)

        # 2. CPU Runtime (GPU masked, CPU only)
        cpu_dir = "/tmp/kernels/python3-cpu"
        os.makedirs(cpu_dir, exist_ok=True)
        with open(f"{cpu_dir}/kernel.json", "w") as f:
            json.dump({
                "argv": [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                "display_name": "Python 3 (Standard CPU)",
                "language": "python",
                "env": {
                    "CUDA_VISIBLE_DEVICES": ""
                },
                "metadata": {
                    "debugger": True
                }
            }, f, indent=2)

        km = ks.KernelSpecManager()

        # Install with prefix (sys.prefix e.g. /opt/conda)
        try:
            km.install_kernel_spec(gpu_dir, "python3-gpu", prefix=sys.prefix, replace=True)
            km.install_kernel_spec(cpu_dir, "python3-cpu", prefix=sys.prefix, replace=True)
        except Exception:
            pass

        # Install to user home (~/.local/share/jupyter/kernels)
        try:
            km.install_kernel_spec(gpu_dir, "python3-gpu", user=True, replace=True)
            km.install_kernel_spec(cpu_dir, "python3-cpu", user=True, replace=True)
        except Exception:
            pass

        # Direct copy into all known jupyter kernel locations
        target_dirs = [
            os.path.join(sys.prefix, "share", "jupyter", "kernels"),
            "/usr/local/share/jupyter/kernels",
            "/usr/share/jupyter/kernels",
            os.path.expanduser("~/.local/share/jupyter/kernels"),
        ]
        for td in target_dirs:
            try:
                g_dest = os.path.join(td, "python3-gpu")
                c_dest = os.path.join(td, "python3-cpu")
                os.makedirs(g_dest, exist_ok=True)
                shutil.copy(f"{gpu_dir}/kernel.json", os.path.join(g_dest, "kernel.json"))
                os.makedirs(c_dest, exist_ok=True)
                shutil.copy(f"{cpu_dir}/kernel.json", os.path.join(c_dest, "kernel.json"))

                # Also update existing default python3 kernel to 2x Tesla T4 GPU by default
                p3_dest = os.path.join(td, "python3")
                if os.path.exists(p3_dest):
                    p3_file = os.path.join(p3_dest, "kernel.json")
                    try:
                        with open(p3_file, "r") as pf:
                            pdata = json.load(pf)
                        pdata["display_name"] = "Python 3 (2× Tesla T4 GPU)"
                        pdata["env"] = {"CUDA_VISIBLE_DEVICES": "0,1"}
                        with open(p3_file, "w") as pf:
                            json.dump(pdata, pf, indent=2)
                    except Exception:
                        pass
            except Exception:
                pass

        log.info("✅ Colab runtimes installed: 'Python 3 (2× Tesla T4 GPU)' & 'Python 3 (Standard CPU)'.")
    except Exception as e:
        log.warning(f"Kernel registration note: {e}")

def configure_jupyterlab():
    """Configure modern Colab-like dark theme and clean editor settings."""
    try:
        settings_base = os.path.expanduser("~/.jupyter/lab/user-settings")
        theme_dir = os.path.join(settings_base, "@jupyterlab", "apputils-extension")
        os.makedirs(theme_dir, exist_ok=True)
        with open(os.path.join(theme_dir, "themes.jupyterlab-settings"), "w") as f:
            json.dump({"theme": "JupyterLab Dark"}, f, indent=2)

        doc_dir = os.path.join(settings_base, "@jupyterlab", "docmanager-extension")
        os.makedirs(doc_dir, exist_ok=True)
        with open(os.path.join(doc_dir, "plugin.jupyterlab-settings"), "w") as f:
            json.dump({"autosaveInterval": 30}, f, indent=2)

        term_dir = os.path.join(settings_base, "@jupyterlab", "terminal-extension")
        os.makedirs(term_dir, exist_ok=True)
        with open(os.path.join(term_dir, "plugin.jupyterlab-settings"), "w") as f:
            json.dump({
                "theme": "dark",
                "fontSize": 14,
                "fontFamily": "Menlo, Consolas, 'DejaVu Sans Mono', monospace"
            }, f, indent=2)
    except Exception as e:
        log.warning(f"JupyterLab settings configuration note: {e}")

def create_welcome_notebook(workspace: str):
    """Create a friendly Google Colab-style starter notebook in the workspace."""
    welcome_path = os.path.join(workspace, "welcome.ipynb")

    welcome_content = {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "# ⚡ AbsoraCloud DevBox — Cloud GPU Workstation\n",
                    "Welcome to your interactive notebook and terminal environment — designed to feel and work just like **Google Colab**.\n",
                    "\n",
                    "---\n",
                    "\n",
                    "### 🔄 Hardware Runtime Switching (Colab Style)\n",
                    "Switch between **GPU** and **Standard CPU** compute seamlessly at any time on this same notebook:\n",
                    "1. Click the **Runtime / Kernel name** in the top-right corner (currently `Python 3 (2× Tesla T4 GPU)`).\n",
                    "2. Select:\n",
                    "   * 🟢 **Python 3 (2× Tesla T4 GPU)** — Full hardware access to dual Nvidia Tesla T4 GPUs (32GB VRAM, CUDA 12)\n",
                    "   * ⚪ **Python 3 (Standard CPU)** — High-performance CPU compute with GPU hardware masked\n",
                    "3. Click **Select** — execution immediately switches hardware!\n",
                    "\n",
                    "---\n",
                    "\n",
                    "### 💻 Dedicated Web Terminal\n",
                    "- Open a full bash terminal anytime via **File → New → Terminal**, or using the **Terminal** button on your AbsoraCloud Dashboard.\n",
                    "- You can also run bash commands in any notebook cell by prefixing with `!` (e.g. `!pip install transformers`)."
                ]
            },
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": [
                    "# 1. Inspect hardware and active GPU drivers:\n",
                    "!nvidia-smi"
                ]
            },
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": [
                    "# 2. Test PyTorch CUDA acceleration:\n",
                    "import torch\n",
                    "\n",
                    "cuda_ok = torch.cuda.is_available()\n",
                    "print(f\"CUDA Accelerated: {cuda_ok}\")\n",
                    "if cuda_ok:\n",
                    "    print(f\"Detected {torch.cuda.device_count()} GPU(s):\")\n",
                    "    for i in range(torch.cuda.device_count()):\n",
                    "        vram = torch.cuda.get_device_properties(i).total_memory / (1024**3)\n",
                    "        print(f\"  • GPU {i}: {torch.cuda.get_device_name(i)} ({vram:.1f} GB VRAM)\")\n",
                    "else:\n",
                    "    print(\"Currently running on CPU Runtime. Switch kernel in top-right to 'Python 3 (2× Tesla T4 GPU)' to access GPU hardware.\")"
                ]
            },
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": [
                    "# 3. Fast Dual GPU Tensor Benchmark:\n",
                    "if torch.cuda.is_available():\n",
                    "    for i in range(torch.cuda.device_count()):\n",
                    "        dev = f'cuda:{i}'\n",
                    "        a = torch.randn(4096, 4096, device=dev)\n",
                    "        b = torch.matmul(a, a)\n",
                    "        print(f\"⚡ GPU {i} Matrix Multiplication (4096x4096): PASSED\")\n",
                    "else:\n",
                    "    print(\"Running on CPU.\")"
                ]
            }
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3 (2× Tesla T4 GPU)",
                "language": "python",
                "name": "python3-gpu"
            },
            "language_info": {
                "name": "python"
            }
        },
        "nbformat": 4,
        "nbformat_minor": 2
    }

    try:
        with open(welcome_path, "w", encoding="utf-8") as f:
            json.dump(welcome_content, f, indent=2)
        os.chmod(welcome_path, 0o666)
    except Exception as e:
        log.warning(f"Could not write welcome.ipynb: {e}")

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

def start_devbox_session(session_key: str, plan: str = "free", timeout_seconds: int = 3600, runtime: str = "gpu"):
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
    os.chmod(workspace, 0o777)

    # Ensure Colab kernels and theme settings are up to date
    setup_kernels()
    configure_jupyterlab()
    create_welcome_notebook(workspace)

    log.info(f"Starting DevBox JupyterLab for {session_key} on port {port} (Runtime: {runtime})...")

    # Launch JupyterLab headless with open remote access, dark theme & direct welcome notebook load
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
            "--ServerApp.default_url=/lab/tree/welcome.ipynb",
            "--NotebookApp.default_url=/lab/tree/welcome.ipynb",
            f"--notebook-dir={workspace}",
            "--allow-root"
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    time.sleep(2)

    # Pre-create Terminal 1 so user can directly click "Terminal" from dashboard
    try:
        requests.post(f"http://127.0.0.1:{port}/api/terminals", timeout=5)
    except Exception:
        pass

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
        "runtime": runtime,
        "expires_at": expires_at,
        "workspace": workspace,
    }

    log.info(f"✅ DevBox session '{session_key}' live at {tunnel_url}")

    # 1. Direct Upstash Redis REST POST (Instant status update, zero gateway delay)
    if UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN:
        try:
            requests.post(
                UPSTASH_REDIS_URL,
                headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}", "Content-Type": "application/json"},
                json=[
                    "HSET",
                    f"session:{session_key}",
                    "status", "active",
                    "tunnel_url", tunnel_url,
                    "runtime", runtime,
                    "expires_at", time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(expires_at))
                ],
                timeout=5
            )
            log.info(f"Pushed session {session_key} directly to Upstash Redis.")
        except Exception as e:
            log.warning(f"Redis direct sync notice: {e}")

    # 2. Notify API Gateway
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
        log.info(f"Reported session {session_key} to API Gateway.")
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

    if UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN:
        try:
            requests.post(
                UPSTASH_REDIS_URL,
                headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}", "Content-Type": "application/json"},
                json=["HSET", f"session:{session_key}", "status", "stopped"],
                timeout=5
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
            res = requests.post(
                UPSTASH_REDIS_URL,
                headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}", "Content-Type": "application/json"},
                json=["LPOP", "devbox:tasks"],
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
                        args=(
                            session_key,
                            task.get("plan", "free"),
                            int(task.get("timeout_seconds", 3600)),
                            task.get("runtime", "gpu")
                        ),
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
                        r = requests.post(
                            UPSTASH_REDIS_URL,
                            headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}", "Content-Type": "application/json"},
                            json=["GET", f"kill:{k}"],
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
    log.info(f"Starting DevBox Colab-Style GPU Pool {RUNNER_ID}...")

    ensure_dependencies()
    setup_kernels()

    # Log GPU info
    try:
        import torch
        if torch.cuda.is_available():
            dev_name = torch.cuda.get_device_name(0)
            log.info(f"🚀 CUDA Hardware Detected: {dev_name} (Devices: {torch.cuda.device_count()})")
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

    log.info("DevBox Colab-Style GPU Pool is ready and listening for tasks.")
    while True:
        time.sleep(60)
