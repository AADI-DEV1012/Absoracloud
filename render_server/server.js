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

// Auto-load .env from current or parent directories
loadEnvFile(path.resolve('./.env'));
loadEnvFile(path.resolve('../.env'));
loadEnvFile(path.resolve('../../.env'));

// Map D1_DB_1_ID to D1_DB_ID if not set
if (!process.env.D1_DB_ID && process.env.D1_DB_1_ID) {
  process.env.D1_DB_ID = process.env.D1_DB_1_ID;
}
if (!process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_B_URL) {
  process.env.UPSTASH_REDIS_URL = process.env.UPSTASH_REDIS_B_URL;
  process.env.UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_B_TOKEN;
}

// Boot AbsoraCloud API Gateway
import './src/index.js';
