// ── AbsoraCloud API Gateway — V3 ──
// Central brain: SSO auth, runner orchestration, quota enforcement.
// V3: VPS on Kaggle CPU, WebHost on CF Workers, Serverless Functions on CF Workers.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function loadEnvFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx !== -1) {
          const key = trimmed.slice(0, idx).trim();
          let val = trimmed.slice(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (_) {}
}

// Auto-load env file from current or workspace root
loadEnvFile(path.resolve('.env.V3'));
loadEnvFile(path.resolve('.env'));
loadEnvFile(path.resolve('../../.env.V3'));
loadEnvFile(path.resolve('../../.env'));

// Map aliases for backward compatibility
if (!process.env.D1_DB_ID && process.env.D1_DB_1_ID) {
  process.env.D1_DB_ID = process.env.D1_DB_1_ID;
}
if (!process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_A_URL) {
  process.env.UPSTASH_REDIS_URL   = process.env.UPSTASH_REDIS_A_URL;
  process.env.UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_A_TOKEN;
}

import express from 'express';
import cors from 'cors';

import { authRouter }       from './routes/auth.js';
import { storageRouter }    from './routes/storage.js';
import { vpsRouter }        from './routes/vps.js';
import { devboxRouter }     from './routes/devbox.js';
import { webhostRouter }    from './routes/webhost.js';
import { serverlessRouter } from './routes/serverless.js';
import { plansRouter }      from './routes/plans.js';
import { adminRouter }      from './routes/admin.js';
import { workerRouter }     from './routes/worker.js';
import { communityRouter }  from './routes/community.js';
import { realtimeRouter }   from './routes/realtime.js';
import { errorHandler }     from './middleware/error_handler.js';
import { startWatchdog }    from './services/watchdog.js';
import { initMonitorBot, handleTelegramWebhook } from './services/monitor_bot.js';

// Process-level crash protection (log without crashing the server)
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
process.on('uncaughtException',  e => console.error('Uncaught exception:', e));

export { asyncHandler as wrap } from './middleware/async_handler.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Render, Cloudflare) for rate limiting & IPs
app.set('trust proxy', 1);

// Disable ETag to prevent 304 Not Modified on dynamic polling endpoints
app.disable('etag');

// ── Global Middleware ──
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Force no-cache on all API responses
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ── Health Check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'absoracloud-api', version: '3.0.0' });
});

// ── API Routes (/api/*) ──
const apiRouter = express.Router();
apiRouter.use('/auth',       authRouter);
apiRouter.use('/storage',    storageRouter);
apiRouter.use('/vps',        vpsRouter);
apiRouter.use('/devbox',     devboxRouter);
apiRouter.use('/webhost',    webhostRouter);
apiRouter.use('/serverless', serverlessRouter);
apiRouter.use('/plans',      plansRouter);
apiRouter.use('/admin',      adminRouter);
apiRouter.use('/worker',     workerRouter);
apiRouter.use('/community',  communityRouter);
apiRouter.use('/realtime',   realtimeRouter);

app.use('/api', apiRouter);

// Root-level aliases for backward compatibility
app.use('/auth',       authRouter);
app.use('/storage',    storageRouter);
app.use('/vps',        vpsRouter);
app.use('/devbox',     devboxRouter);
app.use('/webhost',    webhostRouter);
app.use('/serverless', serverlessRouter);
app.use('/plans',      plansRouter);
app.use('/admin',      adminRouter);
app.use('/worker',     workerRouter);
app.use('/community',  communityRouter);
app.use('/realtime',   realtimeRouter);

// ── Telegram Monitor Webhook ──
app.post('/api/monitor/webhook', handleTelegramWebhook);
app.post('/monitor/webhook', handleTelegramWebhook);

// ── Static File Serving ──
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const webDir     = path.resolve(__dirname, '../../web');

app.use(express.static(webDir));
app.use(express.static(path.resolve(__dirname, '../../../')));

// ── Error Handler ──
app.use(errorHandler);

// ── Start ──
app.listen(PORT, () => {
  console.log(`☁️  AbsoraCloud V3 API running on port ${PORT}`);
  startWatchdog(30000); // Reap expired/stale instances every 30s
  initMonitorBot();     // Start background monitoring bot (if MONITOR_ENABLED=true)
});

export default app;
