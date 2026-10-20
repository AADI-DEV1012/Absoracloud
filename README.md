# ☁️ AbsoraCloud V3
> High-Performance Cloud Compute, GPU Workstations, Edge Functions & Distributed Storage

**Repository:** [https://github.com/AADI-DEV1012/Absoracloud](https://github.com/AADI-DEV1012/Absoracloud)  
**Production Platform:** [absoracloud.qzz.io](https://absoracloud.qzz.io)

---

## ⚡ Unified Cloud Architecture

| Service | Architecture & Hardware | Capabilities |
|---|---|---|
| **VPS Cloud Compute** | Hardened Multi-Tenant Isolated Sandboxes (0.5 – 4.0 vCPU, 2 – 16 GB RAM) | Full root web terminal, dedicated cgroups, fair-share scheduling |
| **DevBox Cloud Workstations** | Dual Nvidia Tesla T4 GPU Acceleration (32 GB VRAM Pool) | Interactive JupyterLab notebooks, PyTorch, TensorFlow, CUDA development |
| **Serverless Functions** | AbsoraEdge Micro-Runtime (0ms Cold Starts, Sub-millisecond Execution) | Global edge distribution, instant ESM deployment, automated HTTPS |
| **Cloud Web Hosting** | Automated Git-Connected Edge CDN Cluster | 1-click GitHub repository builds, custom subdomains, global edge routing |
| **Multi-Zone Cloud Storage** | High-Speed Persistent Object Engine (5 GB – 200 GB) | Direct CDN download links, MIME auto-detection, cryptographic checksums |

---

## 📂 Monorepo Structure

```
apps/
  web/          → High-performance single-page web console & landing interface
  api/          → Unified API Gateway: auth, orchestration, quotas & service runners
packages/
  shared/       → Core database clients, cryptographic JWT, and quota definitions
render_server/  → Node.js production service wrapper
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Verify your credentials in `.env.V3` or `.env`.

### 3. Run Locally
```bash
# Start API Gateway
npm start
```

---

## 📜 Legal & Compliance

- **Terms of Service:** Accessible via web interface at `/` or `/terms`
- **Refund Policy:** 7-Day money-back guarantee for subscription tiers
- **Privacy Policy:** Zero data selling, client encryption, GDPR & privacy compliant
