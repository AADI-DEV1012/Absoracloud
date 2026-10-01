#!/usr/bin/env bash
# ==============================================================================
# ☁️ AbsoraCloud: Unified VPS Node Installer
# Configures Ubuntu VPS (8 CPU, 36GB RAM, 80GB SSD) for:
#   • AbsoraCloud API Gateway & Pterodactyl-Style Web Dashboard
#   • Multi-Tenant Minecraft Engine (Paper 26.3, Purpur, Fabric, JVM 21/17/8)
#   • Linux VPS Container Slicer (Docker)
#   • Web Hosting Deployer Engine
#   (DevBox remains on Kaggle GPU)
# ==============================================================================

set -e
export DEBIAN_FRONTEND=noninteractive

echo "=========================================================="
echo "  ☁️  AbsoraCloud: 36GB VPS Node Automated Provisioner"
echo "=========================================================="

if [ "$EUID" -ne 0 ]; then
  echo "[-] Please run as root (use: sudo bash setup_vps.sh)"
  exit 1
fi

PUBLIC_IP=$(curl -s4 https://api.ipify.org || curl -s4 https://ifconfig.me || hostname -I | awk '{print $1}')
echo "[+] Detected Public IP: $PUBLIC_IP"

# ── 1. System Packages Update ──
echo "[1/6] Updating APT repositories & installing core packages..."
apt-get update -qq
apt-get install -y -qq \
    curl wget git ufw htop unzip tar software-properties-common \
    ca-certificates gnupg lsb-release build-essential python3 python3-pip python3-venv

# ── 2. Install Node.js 20 LTS ──
echo "[2/6] Installing Node.js 20 LTS..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1) != "v20" ]]; then
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs
fi
echo "[+] Node version: $(node -v)"
echo "[+] NPM version: $(npm -v)"

# ── 3. Install Java Runtimes (21, 17, 8) ──
echo "[3/6] Installing OpenJDK 21, 17, and 8 for Minecraft..."
apt-get install -y -qq openjdk-21-jdk-headless openjdk-17-jdk-headless openjdk-8-jdk-headless || true
echo "[+] Primary Java: $(java -version 2>&1 | head -n 1)"

# ── 4. Install Docker Engine ──
echo "[4/6] Installing Docker CE for Linux VPS slicing..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi
echo "[+] Docker version: $(docker --version)"

# ── 5. Install Python Dependencies ──
echo "[5/6] Setting up Python environment..."
pip3 install requests psutil redis --break-system-packages --quiet || pip3 install requests psutil redis --quiet

# ── 6. Setup Directory & Repository ──
INSTALL_DIR="/opt/absoracloud"
echo "[6/6] Setting up AbsoraCloud in $INSTALL_DIR..."

if [ -d "$INSTALL_DIR/.git" ]; then
    echo "[+] Updating existing repository..."
    cd "$INSTALL_DIR"
    git pull origin main
else
    echo "[+] Cloning AbsoraCloud repository..."
    git clone https://github.com/AADI-playz23/Absoracloud.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

cd "$INSTALL_DIR/absoracloud-v2"
echo "[+] Installing npm dependencies..."
npm install --silent

# Setup instances directories
mkdir -p /opt/absoracloud-data/mc_instances
mkdir -p /opt/absoracloud-data/vps_instances
mkdir -p /opt/absoracloud-data/webhost_sites

# ── 7. Configure Firewall (UFW) ──
echo "[+] Configuring UFW Firewall..."
ufw allow 22/tcp comment "SSH"
ufw allow 80/tcp comment "HTTP Web"
ufw allow 443/tcp comment "HTTPS Web"
ufw allow 3000/tcp comment "AbsoraCloud API"
ufw allow 25565:25600/tcp comment "Minecraft Game Servers (Direct)"
ufw allow 25565:25600/udp comment "Minecraft UDP Bedrock/Geyser"
ufw allow 22000:22100/tcp comment "Linux VPS Container SSH"
ufw allow 9001:9050/tcp comment "Websites & VPS Terminals"
echo "y" | ufw enable || true

# ── 8. Create Systemd Services ──

# Service A: AbsoraCloud API Gateway & Web Panel
cat <<EOF > /etc/systemd/system/absoracloud-api.service
[Unit]
Description=AbsoraCloud API Gateway & Web Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/absoracloud-v2
Environment="PORT=3000"
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node apps/api/src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Service B: AbsoraCloud Minecraft Engine (Multi-Tenant, 12 server capacity)
cat <<EOF > /etc/systemd/system/absoracloud-mc.service
[Unit]
Description=AbsoraCloud Multi-Tenant Minecraft Daemon (36GB Node)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/absoracloud-v2/runners/mc-daemon
Environment="RUNNER_ID=vps-mc-node1"
Environment="CAPACITY=12"
Environment="PORT_START=25565"
Environment="PORT_END=25600"
Environment="PUBLIC_IP=$PUBLIC_IP"
Environment="API_URL=http://127.0.0.1:3000"
Environment="WORKER_SECRET=absoracloud_worker_secret_2026"
Environment="UPSTASH_REDIS_URL=https://sharing-dodo-298502.upstash.io"
Environment="UPSTASH_REDIS_TOKEN=gQAAAAAABI4GAAIgcDJiNjFmOTk4YzM4ZGQ0OTMzYTkzZmVkOTg4NmIzNDU0YQ"
Environment="CF_DOMAIN=astrocore.qzz.io"
ExecStart=/usr/bin/python3 shared_mc.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Service C: AbsoraCloud Linux VPS Engine (Docker Slicer, 6 container capacity)
cat <<EOF > /etc/systemd/system/absoracloud-vps.service
[Unit]
Description=AbsoraCloud Linux VPS Docker Slicer Daemon
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/absoracloud-v2/runners/vps-server
Environment="RUNNER_ID=vps-vps-node1"
Environment="CAPACITY=6"
Environment="PORT_START=22000"
Environment="PORT_END=22050"
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

# Reload and Start All Services
systemctl daemon-reload
systemctl enable --now absoracloud-api.service
systemctl enable --now absoracloud-mc.service
systemctl enable --now absoracloud-vps.service

echo ""
echo "=========================================================="
echo "  🎉 AbsoraCloud VPS Node Provisioning COMPLETE!"
echo "=========================================================="
echo "  • Node Public IP  : $PUBLIC_IP"
echo "  • Web & API Panel : http://$PUBLIC_IP:3000"
echo "  • Pterodactyl UI  : http://$PUBLIC_IP:3000/console.html"
echo "  • Minecraft Ports : 25565 - 25600 (Direct IP, 0 lag)"
echo "  • Linux VPS Ports : 22000 - 22100 (Docker Isolated)"
echo "  • DevBox Kernel   : Dedicated Kaggle GPU (Remote)"
echo "=========================================================="
echo "Check service statuses anytime with:"
echo "  systemctl status absoracloud-api"
echo "  systemctl status absoracloud-mc"
echo "  systemctl status absoracloud-vps"
echo "=========================================================="
