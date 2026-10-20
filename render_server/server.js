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
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  } catch (e) {}
}

loadEnvFile(path.resolve('./.env.V3'));
loadEnvFile(path.resolve('../.env.V3'));
loadEnvFile(path.resolve('./.env'));
loadEnvFile(path.resolve('../.env'));

// ── Map env aliases for backward compatibility ──
if (!process.env.D1_DB_ID && process.env.D1_DB_1_ID) {
  process.env.D1_DB_ID = process.env.D1_DB_1_ID;
}
if (!process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_A_URL) {
  process.env.UPSTASH_REDIS_URL   = process.env.UPSTASH_REDIS_A_URL;
  process.env.UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_A_TOKEN;
}
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is missing. Server cannot start securely.');
  process.exit(1);
}
if (!process.env.WORKER_SECRET) {
  console.error('FATAL: WORKER_SECRET environment variable is missing. Server cannot start securely.');
  process.exit(1);
}
if (!process.env.GITHUB_OWNER)  process.env.GITHUB_OWNER  = 'lunarhost520';
if (!process.env.GITHUB_REPO)   process.env.GITHUB_REPO   = 'Absoracloud';

// Boot AbsoraCloud API Gateway
await import('../apps/api/src/index.js');
