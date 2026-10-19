// ── Render Server Entrypoint ──
import fs from 'fs';
import path from 'path';

function loadEnvFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx !== -1) {
          const key = trimmed.slice(0, idx).trim();
          let val = trimmed.slice(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {}
}

// Auto-load .env / .env.V3 from current or parent directories
loadEnvFile(path.resolve('./.env.V3'));
loadEnvFile(path.resolve('../.env.V3'));
loadEnvFile(path.resolve('./.env'));
loadEnvFile(path.resolve('../.env'));
loadEnvFile(path.resolve('../../.env'));

// ── Map env aliases for backward compatibility ──
// D1: primary DB ID
if (!process.env.D1_DB_ID && process.env.D1_DB_1_ID) {
  process.env.D1_DB_ID = process.env.D1_DB_1_ID;
}

// Redis: auto-select from Redis A or Redis B
if (!process.env.UPSTASH_REDIS_URL) {
  if (process.env.UPSTASH_REDIS_A_URL) {
    process.env.UPSTASH_REDIS_URL   = process.env.UPSTASH_REDIS_A_URL;
    process.env.UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_A_TOKEN;
  } else if (process.env.UPSTASH_REDIS_B_URL) {
    process.env.UPSTASH_REDIS_URL   = process.env.UPSTASH_REDIS_B_URL;
    process.env.UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_B_TOKEN;
  }
}

// Worker secret: ensure default if not set
if (!process.env.WORKER_SECRET) {
  process.env.WORKER_SECRET = 'absoracloud_worker_secret_2026';
}

// JWT secret: ensure default
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'absoracloud_jwt_secret_production_2026_key';
}

// GitHub: repo reference only — no runners used in V3
if (!process.env.GITHUB_OWNER) process.env.GITHUB_OWNER = 'lunarhost520';
if (!process.env.GITHUB_REPO)  process.env.GITHUB_REPO  = 'Absoracloud';

// Boot AbsoraCloud API Gateway
import '../apps/api/src/index.js';
