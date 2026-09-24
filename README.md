# ☁️ AbsoraCloud V2

**Production URL:** [absoracloud.qzz.io](https://absoracloud.qzz.io)

---

## Architecture

| Component | Host | Purpose |
|---|---|---|
| **Frontend** | Vercel | Landing, Dashboard, Service UIs |
| **API Gateway** | Render | Central auth, orchestration, all `/api/*` routes |
| **MC Hosting** | GitHub Actions | Minecraft servers (Paper, Forge, Fabric) |
| **VPS** | GitHub Actions | Ephemeral Linux containers (Docker) |
| **DevBox IDE** | Kaggle Notebook | T4×2 GPU pool, browser IDE |
| **Web Hosting** | HF Spaces | Static/Node.js sites from GitHub repos |

## Monorepo Structure

```
apps/web/          → Vercel frontend (Vite + React)
apps/api/          → Render API gateway (Express)
runners/mc-daemon/ → Minecraft runner (Python)
runners/vps-server/→ VPS runner (Python + Docker)
runners/devbox-kernel/ → DevBox GPU runner (Kaggle)
runners/webhost-deployer/ → Web hosting (HF Spaces)
packages/shared/   → Shared libs (D1, Redis, JWT, Plans)
schema/            → Cloudflare D1 SQL migrations
```

## Quick Start

```bash
# Install dependencies
npm install

# Run API locally
cd apps/api && npm run dev

# Run frontend locally
cd apps/web && npm run dev
```

## Environment Variables

See `apps/api/.env.example` for all required secrets.
