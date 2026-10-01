#!/usr/bin/env bash
# ==============================================================================
# ☁️ AbsoraCloud: Unified Bare Metal Node Installer
# Configures Ubuntu Server (8 CPU, 36GB RAM, 80GB SSD) for:
#   • AbsoraCloud API Gateway & Web Dashboard
#   • Linux VPS Container Slicer (Docker)
#   • Web Hosting Deployer Engine
#   • Cloudflare Tunnel (no public IPv4 needed)
#   • Caddy Reverse Proxy (dynamic hostname routing)
#   (DevBox remains on Kaggle GPU)
# ==============================================================================

set -e
export DEBIAN_FRONTEND=noninteractive

echo "=========================================================="
echo "  ☁️  AbsoraCloud: Bare Metal Node Automated Provisioner"
echo "=========================================================="

if [ "$EUID" -ne 0 ]; then
  echo "[-] Please run as root (use: sudo bash setup_vps.sh)"
  exit 1
fi

# ── 1. System Packages Update ──
echo "[1/7] Updating APT repositories & installing core packages..."
apt-get update -qq
apt-get install -y -qq \
    curl wget git ufw htop unzip tar software-properties-common \
    ca-certificates gnupg lsb-release build-essential python3 python3-pip python3-venv

# ── 2. Install Node.js 20 LTS ──
echo "[2/7] Installing Node.js 20 LTS..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1) != "v20" ]]; then
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs
fi
echo "[+] Node version: $(node -v)"
echo "[+] NPM version: $(npm -v)"

# ── 3. Install Docker Engine ──
echo "[3/7] Installing Docker CE for Linux VPS slicing..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi
echo "[+] Docker version: $(docker --version)"

# Build AbsoraCloud VPS base Docker image
echo "[+] Building AbsoraCloud VPS base Docker image..."
cat > /tmp/absoracloud-base.Dockerfile <<'DOCKERFILE'
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN rm -rf /var/lib/apt/lists/* && \
    apt-get update --fix-missing && \
    apt-get install -y --no-install-recommends \
      bash curl wget git nano vim \
      python3 python3-pip \
      gcc g++ make \
      net-tools iputils-ping dnsutils \
      ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    curl -sLo /usr/local/bin/ttyd \
      https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && \
    chmod +x /usr/local/bin/ttyd && \
    rm -rf /var/lib/apt/lists/*
RUN mkdir -p /root/files
WORKDIR /root
CMD ["sleep", "infinity"]
DOCKERFILE
docker build -t absoracloud-base -f /tmp/absoracloud-base.Dockerfile /tmp

# ── 4. Install Cloudflare Tunnel & Caddy Reverse Proxy ──
echo "[4/7] Installing Cloudflared & Caddy..."

# Cloudflared (for tunneling without a public IPv4)
if ! command -v cloudflared &> /dev/null; then
    curl -sL --output /tmp/cloudflared.deb \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    dpkg -i /tmp/cloudflared.deb
fi
echo "[+] Cloudflared version: $(cloudflared --version)"

# Caddy (dynamic reverse proxy for hostname-based routing)
if ! command -v caddy &> /dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy.gpg --yes
    echo 'deb [signed-by=/usr/share/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main' > /etc/apt/sources.list.d/caddy.list
    apt-get update -qq
    apt-get install -y -qq caddy
fi
echo "[+] Caddy version: $(caddy version)"

# ── 5. Install Python Dependencies ──
echo "[5/7] Setting up Python environment..."
pip3 install requests psutil redis websockets \
  "huggingface_hub<0.25.0" gradio fastapi uvicorn \
  --break-system-packages --quiet || \
pip3 install requests psutil redis websockets \
  "huggingface_hub<0.25.0" gradio fastapi uvicorn --quiet

# ── 6. Setup Directory & Repository ──
INSTALL_DIR="/opt/absoracloud"
echo "[6/7] Setting up AbsoraCloud in $INSTALL_DIR..."

if [ -d "$INSTALL_DIR/.git" ]; then
    echo "[+] Updating existing repository..."
    cd "$INSTALL_DIR"
    git remote set-url origin https://github.com/Rishi-dev1210/Absoracloud.git || true
    git pull origin main || true
else
    echo "[+] Cloning AbsoraCloud repository..."
    git clone https://github.com/Rishi-dev1210/Absoracloud.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/absoracloud-v2"
echo "[+] Installing npm dependencies..."
npm install --silent

# Setup data directories
mkdir -p /opt/absoracloud-data/vps_instances
mkdir -p /opt/absoracloud-data/webhost_sites
mkdir -p /opt/absoracloud-data/cloud_storage

# ── 7. Configure Firewall (UFW) ──
echo "[7/7] Configuring UFW Firewall..."
ufw allow 22/tcp comment "SSH"
ufw allow 80/tcp comment "HTTP Web"
ufw allow 443/tcp comment "HTTPS Web"
ufw allow 3000/tcp comment "AbsoraCloud API"
echo "y" | ufw enable || true

# ── 8. Configure Caddy (Single Domain: astrocore.qzz.io) ──
echo "[+] Configuring Caddy Reverse Proxy for Single Domain..."
cat <<'CADDYCONF' > /etc/caddy/Caddyfile
:80, astrocore.qzz.io {
    # AbsoraCloud API Gateway & Control Panel (Default)
    reverse_proxy 127.0.0.1:3000
}
CADDYCONF
systemctl reload caddy || systemctl restart caddy || true

# ── 9. Create Systemd Services ──

# Service A: AbsoraCloud API Gateway & Web Panel
cat <<EOF > /etc/systemd/system/absoracloud-api.service
[Unit]
Description=AbsoraCloud API Gateway & Web Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/absoracloud-v2
EnvironmentFile=-$INSTALL_DIR/absoracloud-v2/.env
Environment="PORT=3000"
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node apps/api/src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Service B: AbsoraCloud Linux VPS Engine (Docker Slicer)
cat <<EOF > /etc/systemd/system/absoracloud-vps.service
[Unit]
Description=AbsoraCloud Linux VPS Docker Slicer Daemon
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/absoracloud-v2/runners/vps-server
EnvironmentFile=-$INSTALL_DIR/absoracloud-v2/.env
Environment="RUNNER_ID=metal-vps-node1"
Environment="CAPACITY=6"
Environment="PORT_START=9001"
Environment="PORT_END=9020"
Environment="API_URL=http://127.0.0.1:3000"
Environment="WORKER_SECRET=absoracloud_worker_secret_2026"
Environment="UPSTASH_REDIS_URL=https://sharing-dodo-298502.upstash.io"
Environment="UPSTASH_REDIS_TOKEN=gQAAAAAABI4GAAIgcDJiNjFmOTk4YzM4ZGQ0OTMzYTkzZmVkOTg4NmIzNDU0YQ"
ExecStart=/usr/bin/python3 shared_server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Service C: AbsoraCloud WebHost Multi-Site Deployer
cat <<EOF > /etc/systemd/system/absoracloud-webhost.service
[Unit]
Description=AbsoraCloud WebHost Multi-Site Deployer Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/absoracloud-v2/runners/webhost-deployer
EnvironmentFile=-$INSTALL_DIR/absoracloud-v2/.env
Environment="RUNNER_ID=metal-webhost-node1"
Environment="CAPACITY=25"
Environment="API_URL=http://127.0.0.1:3000"
Environment="WORKER_SECRET=absoracloud_worker_secret_2026"
Environment="UPSTASH_REDIS_URL=https://sharing-dodo-298502.upstash.io"
Environment="UPSTASH_REDIS_TOKEN=gQAAAAAABI4GAAIgcDJiNjFmOTk4YzM4ZGQ0OTMzYTkzZmVkOTg4NmIzNDU0YQ"
ExecStart=/usr/bin/python3 app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Reload and Start All Services
systemctl daemon-reload
systemctl enable --now absoracloud-api.service
systemctl enable --now absoracloud-vps.service
systemctl enable --now absoracloud-webhost.service

echo ""
echo "=========================================================="
echo "  🎉 AbsoraCloud Bare Metal Provisioning COMPLETE!"
echo "=========================================================="
echo "  • Local API Panel : http://127.0.0.1:3000"
echo "  • Domain          : astrocore.qzz.io (Single Domain)"
echo "  • VPS Containers  : 6-8 concurrent (Docker Isolated)"
echo "  • WebHost Sites   : Managed by webhost daemon"
echo "  • DevBox Kernel   : Dedicated Kaggle GPU (Remote)"
echo "=========================================================="
echo ""
echo "⚡ NEXT STEP: Connect Cloudflare Tunnel (1 Single Hostname):"
echo "  1. In Cloudflare Zero Trust -> Tunnels -> Public Hostnames"
echo "     Add 1 Hostname: astrocore.qzz.io -> HTTP -> localhost:80"
echo "  2. On this server, start tunnel:"
echo "     cloudflared service install <YOUR_TUNNEL_TOKEN>"
echo "     systemctl enable --now cloudflared"
echo ""
echo "Check service statuses anytime with:"
echo "  systemctl status absoracloud-api"
echo "  systemctl status absoracloud-vps"
echo "  systemctl status absoracloud-webhost"
echo "  systemctl status cloudflared"
echo "=========================================================="
