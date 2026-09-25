#!/usr/bin/env python3
"""
☁️ AbsoraCloud Minecraft Multi-Tenant Runner Engine
Hosts isolated Minecraft servers with:
  • JVM Management: Auto-detects & selects correct Java version (Java 8, 11, 17, 21) based on Minecraft release
  • 10+ Server Software Engines: Paper, Purpur, Folia, Pufferfish, Fabric, Quilt, Forge, NeoForge, Arclight, Mohist
  • Automatic Server JAR downloader with resilient multi-source fallbacks
  • Playit.gg / TCP Tunneling for instant connection IPs
  • Direct Upstash Redis state reporting & automatic watchdog timeout management
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
log = logging.getLogger("AbsoraMC")

API_URL             = os.environ.get("API_URL", "https://absoracloud.onrender.com")
WORKER_SECRET       = os.environ.get("WORKER_SECRET", "absoracloud_worker_secret_2026")
RUNNER_ID           = os.environ.get("RUNNER_ID", f"mc-runner-{int(time.time())}")
UPSTASH_REDIS_URL   = os.environ.get("UPSTASH_REDIS_URL", "https://sharing-dodo-298502.upstash.io")
UPSTASH_REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_TOKEN", "gQAAAAAABI4GAAIgcDJiNjFmOTk4YzM4ZGQ0OTMzYTkzZmVkOTg4NmIzNDU0YQ")

CAPACITY   = int(os.environ.get("CAPACITY", "2"))
MC_DIR     = os.path.abspath("./mc_instances")
os.makedirs(MC_DIR, exist_ok=True)

PORT_START = 25565
PORT_END   = 25575

# session_key -> { proc, tunnel_proc, port, ram_mb, expires_at, last_active, tunnel_url }
ACTIVE_MC = {}

def get_free_port():
    used = {v["port"] for v in ACTIVE_MC.values()}
    for p in range(PORT_START, PORT_END + 1):
        if p not in used:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(("127.0.0.1", p)) != 0:
                    return p
    return None

# ── 1. Smart JVM Management ──

def get_recommended_java_version(mc_version: str) -> int:
    """
    Determine the standard Java LTS version required for a given Minecraft release.
      • Minecraft 1.20.5+ & 1.21+ strictly require Java 21
      • Minecraft 1.18 to 1.20.4 require Java 17
      • Minecraft 1.17 requires Java 17 (or 16)
      • Minecraft 1.16.5 runs best on Java 11 (or 8/17)
      • Minecraft 1.12.2 and 1.8.8 require Java 8 (Forge 1.12.2 crashes on Java 9+)
    """
    try:
        clean = re.sub(r"[^0-9.]", "", mc_version)
        parts = [int(p) for p in clean.split(".") if p.isdigit()]
        minor = parts[1] if len(parts) > 1 else 20
        patch = parts[2] if len(parts) > 2 else 0

        if (minor == 20 and patch >= 5) or minor >= 21:
            return 21
        elif minor >= 18:
            return 17
        elif minor == 17:
            return 17
        elif minor == 16:
            return 11
        else:
            return 8
    except Exception:
        return 21

def resolve_java_binary(requested_java: str, mc_version: str) -> str:
    """
    Finds or downloads the exact Java binary for the requested or auto-detected JVM version.
    Supports Java 8, 11, 17, and 21.
    If not pre-installed, auto-downloads portable Adoptium/Temurin JRE binaries into /tmp/jvms.
    """
    if not requested_java or requested_java.lower() == "auto":
        target_ver = get_recommended_java_version(mc_version)
    else:
        try:
            target_ver = int(requested_java)
        except Exception:
            target_ver = get_recommended_java_version(mc_version)

    log.info(f"Resolving JVM: Target Java {target_ver} for MC {mc_version} (Requested: '{requested_java}')")

    # 1. Check GitHub Actions / Ubuntu pre-installed environment variables
    env_var = f"JAVA_HOME_{target_ver}_X64"
    if os.environ.get(env_var):
        java_bin = os.path.join(os.environ[env_var], "bin", "java")
        if os.path.isfile(java_bin) and os.access(java_bin, os.X_OK):
            log.info(f"Found Java {target_ver} via {env_var}: {java_bin}")
            return java_bin

    # 2. Check standard Linux JVM system paths
    candidate_paths = [
        f"/usr/lib/jvm/temurin-{target_ver}-jdk-amd64/bin/java",
        f"/usr/lib/jvm/temurin-{target_ver}-jre-amd64/bin/java",
        f"/usr/lib/jvm/java-{target_ver}-openjdk-amd64/bin/java",
        f"/usr/lib/jvm/java-{target_ver}-openjdk/bin/java",
        f"/usr/lib/jvm/zulu-{target_ver}/bin/java",
        f"/opt/java/{target_ver}/bin/java",
        f"/tmp/jvms/java-{target_ver}/bin/java",
    ]
    for p in candidate_paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            log.info(f"Found Java {target_ver} at: {p}")
            return p

    # 3. Check system 'java' if version matches
    try:
        v_out = subprocess.check_output(["java", "-version"], stderr=subprocess.STDOUT, text=True)
        if f'"{target_ver}.' in v_out or f'"{target_ver}-' in v_out or (target_ver == 8 and '1.8.' in v_out):
            log.info(f"System 'java' already matches Java {target_ver}")
            return "java"
    except Exception:
        pass

    # 4. Auto-download lightweight standalone JRE from Adoptium API
    jvm_dir = f"/tmp/jvms/java-{target_ver}"
    if os.path.isfile(f"{jvm_dir}/bin/java") and os.access(f"{jvm_dir}/bin/java", os.X_OK):
        return f"{jvm_dir}/bin/java"

    log.info(f"Java {target_ver} not found locally. Auto-fetching portable Temurin JRE {target_ver}...")
    try:
        os.makedirs("/tmp/jvms", exist_ok=True)
        temurin_map = {
            8: "https://api.adoptium.net/v3/binary/latest/8/ga/linux/x64/jre/hotspot/normal/eclipse",
            11: "https://api.adoptium.net/v3/binary/latest/11/ga/linux/x64/jre/hotspot/normal/eclipse",
            17: "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse",
            21: "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre/hotspot/normal/eclipse",
        }
        dl_url = temurin_map.get(target_ver, temurin_map[21])
        tar_path = f"/tmp/jvms/jre_{target_ver}.tar.gz"

        r = requests.get(dl_url, stream=True, timeout=60, allow_redirects=True)
        with open(tar_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=32768):
                f.write(chunk)

        os.makedirs(jvm_dir, exist_ok=True)
        subprocess.run(["tar", "-xzf", tar_path, "-C", jvm_dir, "--strip-components=1"], check=True)
        java_bin = f"{jvm_dir}/bin/java"
        if os.path.isfile(java_bin):
            os.chmod(java_bin, 0o755)
            log.info(f"✅ Successfully installed portable Java {target_ver} JRE.")
            return java_bin
    except Exception as e:
        log.warning(f"Could not auto-download Java {target_ver}: {e}. Falling back to system 'java'.")

    return "java"

# ── 2. Multi-Engine Server JAR Downloader ──

def _download_file(url: str, dest_path: str):
    log.info(f"Downloading from: {url}")
    r = requests.get(url, stream=True, timeout=60, allow_redirects=True)
    r.raise_for_status()
    with open(dest_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=32768):
            f.write(chunk)
    log.info(f"Downloaded {os.path.getsize(dest_path)} bytes to {dest_path}")

def download_server_jar(server_type: str, version: str, dest_dir: str) -> str:
    """
    Downloads the appropriate server JAR for:
      paper, purpur, folia, pufferfish, fabric, quilt, forge, neoforge, arclight, mohist.
    Returns the target execution file (e.g. 'server.jar' or 'run.sh').
    """
    st = server_type.lower().strip()
    jar_path = os.path.join(dest_dir, "server.jar")
    if os.path.exists(jar_path) and os.path.getsize(jar_path) > 1024 * 1024:
        return "server.jar"

    log.info(f"Resolving server software: Engine='{st}', Version='{version}'...")

    try:
        # 1. PAPER
        if st == "paper":
            r = requests.get(f"https://api.papermc.io/v2/projects/paper/versions/{version}", timeout=10).json()
            builds = r.get("builds", [])
            latest_build = builds[-1] if builds else "latest"
            dl_url = f"https://api.papermc.io/v2/projects/paper/versions/{version}/builds/{latest_build}/downloads/paper-{version}-{latest_build}.jar"
            _download_file(dl_url, jar_path)
            return "server.jar"

        # 2. PURPUR
        elif st == "purpur":
            dl_url = f"https://api.purpurmc.org/v2/purpur/{version}/latest/download"
            _download_file(dl_url, jar_path)
            return "server.jar"

        # 3. FOLIA
        elif st in ("folia", "filoa"):
            r = requests.get(f"https://api.papermc.io/v2/projects/folia/versions/{version}", timeout=10).json()
            builds = r.get("builds", [])
            latest_build = builds[-1] if builds else "latest"
            dl_url = f"https://api.papermc.io/v2/projects/folia/versions/{version}/builds/{latest_build}/downloads/folia-{version}-{latest_build}.jar"
            _download_file(dl_url, jar_path)
            return "server.jar"

        # 4. PUFFERFISH
        elif st == "pufferfish":
            dl_url = f"https://ci.pufferfish.host/job/Pufferfish-{version}/lastSuccessfulBuild/artifact/build/libs/pufferfish-paperclip-{version}-R0.1-SNAPSHOT-reobf.jar"
            try:
                _download_file(dl_url, jar_path)
                return "server.jar"
            except Exception:
                return download_server_jar("paper", version, dest_dir)

        # 5. FABRIC
        elif st == "fabric":
            r = requests.get("https://meta.fabricmc.net/v2/versions/loader", timeout=10).json()
            loader_ver = r[0]["version"]
            dl_url = f"https://meta.fabricmc.net/v2/versions/loader/{version}/{loader_ver}/1.0.1/server/jar"
            _download_file(dl_url, jar_path)
            return "server.jar"

        # 6. QUILT
        elif st == "quilt":
            r = requests.get("https://meta.quiltmc.org/v3/versions/loader", timeout=10).json()
            loader_ver = r[0]["version"]
            dl_url = f"https://meta.quiltmc.org/v3/versions/loader/{version}/{loader_ver}/0.26.0/server/jar"
            _download_file(dl_url, jar_path)
            return "server.jar"

        # 7. MOHIST (Forge + Paper Hybrid)
        elif st in ("mohist", "moonshight", "mohistmc"):
            r = requests.get(f"https://mohistmc.com/api/v2/projects/mohist/{version}/builds", timeout=10).json()
            latest_build = r["builds"][-1]
            dl_url = f"https://mohistmc.com/api/v2/projects/mohist/{version}/builds/{latest_build}/download"
            _download_file(dl_url, jar_path)
            return "server.jar"

        # 8. ARCLIGHT (Forge/Fabric + Spigot Hybrid)
        elif st == "arclight":
            r = requests.get("https://api.github.com/repos/IzzelAliz/Arclight/releases", timeout=10).json()
            target_asset = None
            for rel in r:
                for asset in rel.get("assets", []):
                    if version in asset.get("name", "") and asset.get("name", "").endswith(".jar"):
                        target_asset = asset.get("browser_download_url")
                        break
                if target_asset:
                    break
            if target_asset:
                _download_file(target_asset, jar_path)
                return "server.jar"
            return download_server_jar("paper", version, dest_dir)

        # 9. NEOFORGE (MC 1.20.2+)
        elif st in ("neoforge", "neo_forge", "neo"):
            r = requests.get("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge", timeout=10).json()
            matching = [v for v in r.get("versions", []) if v.startswith(version.replace("1.", ""))]
            if matching:
                nf_ver = matching[-1]
                installer_url = f"https://maven.neoforged.net/releases/net/neoforged/neoforge/{nf_ver}/neoforge-{nf_ver}-installer.jar"
                installer_path = os.path.join(dest_dir, "installer.jar")
                _download_file(installer_url, installer_path)
                subprocess.run(["java", "-jar", "installer.jar", "--install-server"], cwd=dest_dir, check=True)
                return "run.sh" if os.path.exists(os.path.join(dest_dir, "run.sh")) else "server.jar"
            return download_server_jar("paper", version, dest_dir)

        # 10. FORGE (1.12.2, 1.16.5, 1.18.2, 1.20.1)
        elif st == "forge":
            forge_url = f"https://maven.minecraftforge.net/net/minecraftforge/forge/{version}-latest/forge-{version}-latest-installer.jar"
            try:
                installer_path = os.path.join(dest_dir, "installer.jar")
                _download_file(forge_url, installer_path)
                subprocess.run(["java", "-jar", "installer.jar", "--installServer"], cwd=dest_dir, check=True)
                for fname in os.listdir(dest_dir):
                    if fname.startswith("forge-") and fname.endswith(".jar") and "installer" not in fname:
                        return fname
                if os.path.exists(os.path.join(dest_dir, "run.sh")):
                    return "run.sh"
            except Exception:
                pass
            return download_server_jar("paper", version, dest_dir)

        # Default fallback: Paper
        else:
            return download_server_jar("paper", version, dest_dir)

    except Exception as e:
        log.error(f"Failed to fetch jar for {st} {version}: {e}. Falling back to Paper 1.20.4.")
        paper_url = "https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/496/downloads/paper-1.20.4-496.jar"
        _download_file(paper_url, jar_path)
        return "server.jar"

# ── 3. Networking, Bore TCP Tunneling & Cloudflare SRV Records ──

CF_API_TOKEN        = os.environ.get("CLOUDFLARE_API_TOKEN", os.environ.get("CF_API_TOKEN", ""))
CF_ZONE_ID          = os.environ.get("CLOUDFLARE_ZONE_ID", os.environ.get("CF_ZONE_ID", ""))
CF_DOMAIN           = os.environ.get("CLOUDFLARE_DOMAIN", os.environ.get("CF_DOMAIN", "astrocore.qzz.io"))
BORE_SERVER         = os.environ.get("BORE_SERVER", "bore.pub")

def ensure_bore_binary() -> str:
    """Finds or installs the bore binary."""
    which_bore = shutil.which("bore")
    if which_bore:
        return which_bore

    candidates = ["/usr/local/bin/bore", "/usr/bin/bore", "/tmp/bore", "./bore"]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c

    target = "/tmp/bore"
    try:
        log.info("Downloading bore TCP tunnel binary...")
        url = "https://github.com/ekzhang/bore/releases/download/v0.5.1/bore-v0.5.1-x86_64-unknown-linux-musl.tar.gz"
        tar_path = "/tmp/bore.tar.gz"
        r = requests.get(url, stream=True, timeout=30)
        with open(tar_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        subprocess.run(["tar", "-xzf", tar_path, "-C", "/tmp"], check=True)
        if os.path.isfile(target):
            os.chmod(target, 0o755)
            log.info("Bore binary downloaded and ready at /tmp/bore.")
            return target
    except Exception as e:
        log.warning(f"Could not auto-download bore: {e}")

    return "bore"

def update_cloudflare_srv(servername: str, remote_port: int, target_host: str = "bore.pub") -> bool:
    """
    Creates or updates Cloudflare SRV DNS record:
    _minecraft._tcp.<servername>.astrocore.qzz.io -> target_host:remote_port
    """
    if not (CF_API_TOKEN and CF_ZONE_ID and remote_port):
        log.info("Cloudflare API credentials not set; skipping SRV DNS registration.")
        return False

    dns_servername = re.sub(r'[^a-zA-Z0-9-]', '', servername.lower().replace(' ', '-'))
    record_name = f"_minecraft._tcp.{dns_servername}"
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json"
    }

    try:
        search_url = f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/dns_records?type=SRV&name={record_name}.{CF_DOMAIN}"
        search_res = requests.get(search_url, headers=headers, timeout=10).json()

        record_data = {
            "type": "SRV",
            "name": f"{record_name}.{CF_DOMAIN}",
            "data": {
                "service": "_minecraft",
                "proto": "_tcp",
                "name": f"{dns_servername}.{CF_DOMAIN}",
                "priority": 0,
                "weight": 5,
                "port": int(remote_port),
                "target": target_host
            },
            "ttl": 60
        }

        if search_res.get("success") and len(search_res.get("result", [])) > 0:
            record_id = search_res["result"][0]["id"]
            update_url = f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/dns_records/{record_id}"
            res = requests.put(update_url, headers=headers, json=record_data, timeout=10).json()
            if res.get("success"):
                log.info(f"✅ Updated Cloudflare SRV: {dns_servername}.{CF_DOMAIN} -> {target_host}:{remote_port}")
                return True
        else:
            create_url = f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/dns_records"
            res = requests.post(create_url, headers=headers, json=record_data, timeout=10).json()
            if res.get("success"):
                log.info(f"✅ Created Cloudflare SRV: {dns_servername}.{CF_DOMAIN} -> {target_host}:{remote_port}")
                return True
    except Exception as e:
        log.warning(f"Failed to update Cloudflare SRV record: {e}")

    return False

def cleanup_cloudflare_srv(servername: str):
    """Removes SRV record when server stops."""
    if not (CF_API_TOKEN and CF_ZONE_ID and servername):
        return
    dns_servername = re.sub(r'[^a-zA-Z0-9-]', '', servername.lower().replace(' ', '-'))
    record_name = f"_minecraft._tcp.{dns_servername}"
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json"
    }
    try:
        search_url = f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/dns_records?type=SRV&name={record_name}.{CF_DOMAIN}"
        search_res = requests.get(search_url, headers=headers, timeout=5).json()
        if search_res.get("success"):
            for rec in search_res.get("result", []):
                requests.delete(f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/dns_records/{rec['id']}", headers=headers, timeout=5)
                log.info(f"Cleaned up Cloudflare SRV record for {dns_servername}.{CF_DOMAIN}")
    except Exception as e:
        log.warning(f"Error during SRV cleanup: {e}")

def ensure_playit_tunnel(port: int) -> tuple:
    """Fallback Playit.gg agent for raw TCP Minecraft tunneling."""
    playit_bin = "/tmp/playit"
    if not (os.path.exists(playit_bin) and os.access(playit_bin, os.X_OK)):
        try:
            log.info("Downloading Playit.gg tunnel agent...")
            url = "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64"
            r = requests.get(url, stream=True, timeout=30)
            with open(playit_bin, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
            os.chmod(playit_bin, 0o755)
        except Exception as e:
            log.warning(f"Could not download playit: {e}")

    if os.path.exists(playit_bin) and os.access(playit_bin, os.X_OK):
        try:
            proc = subprocess.Popen(
                [playit_bin, "start"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )
            tunnel_address = None
            def find_address():
                nonlocal tunnel_address
                for line in iter(proc.stdout.readline, ''):
                    if not line:
                        break
                    m = re.search(r"([a-zA-Z0-9-]+\.(?:joinmc\.link|auto\.playit\.gg|gl\.joinmc\.link)(?::\d+)?)", line)
                    if m:
                        tunnel_address = m.group(1)
                        break

            t = threading.Thread(target=find_address, daemon=True)
            t.start()
            t.join(timeout=10)

            if tunnel_address:
                return proc, tunnel_address
        except Exception as e:
            log.warning(f"Playit execution note: {e}")

    try:
        pub_ip = requests.get("https://api.ipify.org", timeout=5).text.strip()
        return None, f"{pub_ip}:{port}"
    except Exception:
        return None, f"{socket.gethostname()}:{port}"

def start_network_tunnel(port: int, servername: str) -> tuple:
    """
    Primary: Starts Bore TCP tunnel to public bore.pub and registers Cloudflare SRV record.
    Fallback: Uses Playit agent if Bore does not acquire a port.
    Returns: (proc, display_url, direct_address, bore_port)
    """
    dns_servername = re.sub(r'[^a-zA-Z0-9-]', '', servername.lower().replace(' ', '-'))
    if not dns_servername:
        dns_servername = f"mc-{int(time.time())}"
    fqdn_domain = f"{dns_servername}.{CF_DOMAIN}"

    bore_bin = ensure_bore_binary()
    try:
        log.info(f"Starting Bore TCP tunnel for port {port} to {BORE_SERVER}...")
        proc = subprocess.Popen(
            [bore_bin, "local", str(port), "--to", BORE_SERVER],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        remote_port = None
        def read_bore_output():
            nonlocal remote_port
            for line in iter(proc.stdout.readline, ''):
                if not line:
                    break
                m = re.search(r'listening at [a-zA-Z0-9.-]+:(\d+)', line)
                if m:
                    remote_port = int(m.group(1))
                    log.info(f"Bore tunnel active: {BORE_SERVER}:{remote_port}")
                    break

        t = threading.Thread(target=read_bore_output, daemon=True)
        t.start()
        t.join(timeout=12)

        if remote_port:
            direct_address = f"{BORE_SERVER}:{remote_port}"
            update_cloudflare_srv(dns_servername, remote_port, BORE_SERVER)
            return proc, fqdn_domain, direct_address, remote_port
    except Exception as e:
        log.warning(f"Bore tunnel start exception: {e}")

    # Fallback to Playit or direct IP
    log.info("Falling back to Playit.gg tunnel...")
    playit_proc, playit_addr = ensure_playit_tunnel(port)
    return playit_proc, playit_addr, playit_addr, port

# ── 4. Server Lifecycle Execution ──

def start_mc_server(session_key: str, server_type: str = "paper", version: str = "1.20.4", java_version: str = "auto", servername: str = "play", ram_mb: int = 1024, timeout_seconds: int = 21600):
    if len(ACTIVE_MC) >= CAPACITY:
        raise Exception(f"MC runner capacity reached ({len(ACTIVE_MC)}/{CAPACITY})")

    if session_key in ACTIVE_MC:
        log.info(f"MC session {session_key} already active.")
        return

    port = get_free_port()
    if not port:
        raise Exception("No free Minecraft ports available")

    inst_dir = os.path.join(MC_DIR, session_key)
    os.makedirs(inst_dir, exist_ok=True)

    # 1. Accept Mojang EULA
    with open(os.path.join(inst_dir, "eula.txt"), "w") as f:
        f.write("eula=true\n")

    # 2. Configure server.properties
    clean_srvname = re.sub(r'[^a-zA-Z0-9-]', '', servername.lower().replace(' ', '-')) or "play"
    with open(os.path.join(inst_dir, "server.properties"), "w") as f:
        f.write(
            f"server-port={port}\n"
            f"query.port={port}\n"
            f"motd=§b§lAbsoraCloud §7- §f{clean_srvname}.{CF_DOMAIN}\n"
            f"online-mode=false\n"
            f"difficulty=easy\n"
            f"max-players=20\n"
            f"enable-command-block=true\n"
        )

    # 3. Resolve JVM & Server JAR
    java_bin = resolve_java_binary(java_version, version)
    exec_target = download_server_jar(server_type, version, inst_dir)

    log.info(f"Starting MC Server {session_key} ({clean_srvname}) on port {port} with {ram_mb}MB RAM using {java_bin}...")

    # 4. Launch Command
    if exec_target == "run.sh" and os.path.exists(os.path.join(inst_dir, "run.sh")):
        os.chmod(os.path.join(inst_dir, "run.sh"), 0o755)
        cmd = ["bash", "run.sh", "nogui"]
    else:
        cmd = [
            java_bin,
            f"-Xms{ram_mb // 2}M",
            f"-Xmx{ram_mb}M",
            "-XX:+UseG1GC",
            "-XX:+ParallelRefProcEnabled",
            "-XX:MaxGCPauseMillis=200",
            "-jar", exec_target,
            "nogui"
        ]

    proc = subprocess.Popen(
        cmd,
        cwd=inst_dir,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True
    )

    # 5. Connect Bore Tunnel + Cloudflare SRV
    tunnel_proc, fqdn_domain, direct_address, remote_port = start_network_tunnel(port, clean_srvname)
    expires_at = time.time() + timeout_seconds

    ACTIVE_MC[session_key] = {
        "proc": proc,
        "tunnel_proc": tunnel_proc,
        "port": port,
        "server_type": server_type,
        "version": version,
        "java_version": java_version,
        "servername": clean_srvname,
        "domain": fqdn_domain,
        "direct_address": direct_address,
        "bore_port": remote_port,
        "ram_mb": ram_mb,
        "expires_at": expires_at,
        "last_active": time.time(),
        "tunnel_url": fqdn_domain,
    }

    log.info(f"✅ MC Server '{session_key}' online! Primary Domain: {fqdn_domain} (Direct: {direct_address})")

    # 6. Direct Upstash Redis REST POST
    if UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN:
        try:
            requests.post(
                UPSTASH_REDIS_URL,
                headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}", "Content-Type": "application/json"},
                json=[
                    "HSET",
                    f"session:{session_key}",
                    "status", "active",
                    "tunnel_url", fqdn_domain,
                    "domain", fqdn_domain,
                    "direct_address", direct_address,
                    "bore_port", str(remote_port),
                    "servername", clean_srvname,
                    "server_type", server_type,
                    "version", version,
                    "expires_at", time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(expires_at))
                ],
                timeout=5
            )
            log.info(f"Pushed MC session {session_key} directly to Upstash Redis.")
        except Exception as e:
            log.warning(f"Redis direct sync note: {e}")

    # 7. Notify API Gateway
    try:
        requests.post(
            f"{API_URL}/worker/session_update",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={
                "session_key": session_key,
                "status": "active",
                "tunnel_url": fqdn_domain,
                "domain": fqdn_domain,
                "direct_address": direct_address,
                "bore_port": remote_port,
                "servername": clean_srvname,
                "expires_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(expires_at)),
            },
            timeout=5,
        )
        log.info(f"Reported MC session {session_key} to API Gateway.")
    except Exception as e:
        log.error(f"Failed to report MC session: {e}")

def stop_mc_server(session_key: str):
    if session_key not in ACTIVE_MC:
        return
    info = ACTIVE_MC.pop(session_key)
    log.info(f"🛑 Stopping MC server {session_key}...")

    # Cleanup Cloudflare SRV
    srvname = info.get("servername")
    if srvname:
        cleanup_cloudflare_srv(srvname)

    # Graceful stop command
    proc = info.get("proc")
    if proc:
        try:
            if proc.stdin:
                proc.stdin.write("stop\n")
                proc.stdin.flush()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

    tunnel_proc = info.get("tunnel_proc")
    if tunnel_proc:
        try:
            tunnel_proc.terminate()
        except Exception:
            pass

    # Report to API Gateway
    try:
        requests.post(
            f"{API_URL}/worker/session_update",
            headers={"Content-Type": "application/json", "x-worker-secret": WORKER_SECRET},
            json={"session_key": session_key, "status": "stopped"},
            timeout=5,
        )
    except Exception:
        pass

    # Direct Redis update
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

# ── 5. Watchdog & Task Queue ──

def local_watchdog():
    while True:
        try:
            now = time.time()
            for k, info in list(ACTIVE_MC.items()):
                if now >= info["expires_at"]:
                    log.info(f"⏱️ Plan time limit reached for MC {k}. Auto-stopping...")
                    stop_mc_server(k)
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
    log.info(f"Listening for tasks on queue {queue_key} and global mc:tasks...")
    while True:
        try:
            # Check runner-specific queue
            res = requests.post(
                UPSTASH_REDIS_URL,
                headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}", "Content-Type": "application/json"},
                json=["LPOP", queue_key],
                timeout=5
            ).json()
            task_raw = res.get("result")

            # Check global mc:tasks queue if empty
            if not task_raw and len(ACTIVE_MC) < CAPACITY:
                res_g = requests.post(
                    UPSTASH_REDIS_URL,
                    headers={"Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}", "Content-Type": "application/json"},
                    json=["LPOP", "mc:tasks"],
                    timeout=5
                ).json()
                task_raw = res_g.get("result")

            if task_raw:
                task = json.loads(task_raw)
                action = task.get("action")
                if action in ("start_mc", "launch"):
                    threading.Thread(
                        target=start_mc_server,
                        args=(
                            task["session_key"],
                            task.get("server_type", "paper"),
                            task.get("version", "1.20.4"),
                            task.get("java_version", "auto"),
                            task.get("servername", "play"),
                            int(task.get("ram_mb", 1024)),
                            int(task.get("timeout_seconds", 21600))
                        ),
                        daemon=True
                    ).start()
                elif action in ("stop_mc", "stop"):
                    stop_mc_server(task["session_key"])
        except Exception as e:
            log.error(f"Error in task listener: {e}")
        time.sleep(3)

if __name__ == "__main__":
    log.info(f"Starting AbsoraCloud Minecraft Engine {RUNNER_ID} (Capacity: {CAPACITY})...")

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
        log.info(f"Registered MC runner {RUNNER_ID} with API Gateway.")
    except Exception as e:
        log.error(f"Failed to register MC runner: {e}")

    initial_key = os.environ.get("INITIAL_SESSION_KEY")
    if initial_key:
        log.info(f"Starting initial MC server for session '{initial_key}'...")
        try:
            ram = int(os.environ.get("RAM_MB", "1024"))
            stype = os.environ.get("SERVER_TYPE", "paper")
            ver = os.environ.get("VERSION", "1.20.4")
            jver = os.environ.get("JAVA_VERSION", "auto")
            sname = os.environ.get("SERVERNAME", "play")
            threading.Thread(
                target=start_mc_server,
                args=(initial_key, stype, ver, jver, sname, ram, 21600),
                daemon=True
            ).start()
        except Exception as e:
            log.error(f"Failed to start initial MC server: {e}")

    threading.Thread(target=local_watchdog, daemon=True).start()
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    threading.Thread(target=task_listener, daemon=True).start()

    log.info("AbsoraCloud Minecraft Engine is active and waiting for server deployments.")
    while True:
        time.sleep(60)

