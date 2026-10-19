// ── Root Server Entrypoint ──
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Auto-heal missing dependencies if build manager did not link them
try {
  const expressPkg = path.resolve('./node_modules/express/package.json');
  if (!fs.existsSync(expressPkg)) {
    console.log('⚡ [AbsoraCloud] express not found in node_modules, running npm install...');
    execSync('npm install --prefer-offline --no-audit', { stdio: 'inherit' });
    console.log('✅ [AbsoraCloud] Dependencies installed successfully');
  }
} catch (e) {
  console.warn('⚠️ [AbsoraCloud] Auto-install notice:', e.message);
}

// Auto-load .env / .env.V3 from current directory
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

loadEnvFile(path.resolve('./.env.V3'));
loadEnvFile(path.resolve('./.env'));
loadEnvFile(path.resolve('./render_server/.env'));

// ── Map env aliases for backward compatibility ──
if (!process.env.D1_DB_ID && process.env.D1_DB_1_ID) {
  process.env.D1_DB_ID = process.env.D1_DB_1_ID;
}

if (!process.env.UPSTASH_REDIS_URL) {
  if (process.env.UPSTASH_REDIS_A_URL) {
    process.env.UPSTASH_REDIS_URL   = process.env.UPSTASH_REDIS_A_URL;
    process.env.UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_A_TOKEN;
  }
}

if (!process.env.WORKER_SECRET) {
  process.env.WORKER_SECRET = 'absoracloud_worker_secret_2026';
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'absoracloud_jwt_secret_production_2026_key';
}

if (!process.env.GITHUB_OWNER) process.env.GITHUB_OWNER = 'lunarhost520';
if (!process.env.GITHUB_REPO)  process.env.GITHUB_REPO  = 'Absoracloud';

// Boot AbsoraCloud API Gateway via dynamic import
await import('./apps/api/src/index.js');
