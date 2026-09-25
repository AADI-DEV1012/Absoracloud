// ── AbsoraCloud API Gateway ──
// Central brain: SSO auth, runner orchestration, quota enforcement.

import express from 'express';
import cors from 'cors';

import { authRouter }      from './routes/auth.js';
import { mcRouter }        from './routes/mc.js';
import { vpsRouter }       from './routes/vps.js';
import { devboxRouter }    from './routes/devbox.js';
import { webhostRouter }   from './routes/webhost.js';
import { plansRouter }     from './routes/plans.js';
import { adminRouter }     from './routes/admin.js';
import { workerRouter }    from './routes/worker.js';
import { communityRouter } from './routes/community.js';
import { errorHandler }    from './middleware/error_handler.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Render, Cloudflare) for rate limiting & secure cookies
app.set('trust proxy', 1);

// Disable ETag generation to prevent 304 Not Modified on dynamic polling/status endpoints
app.disable('etag');

// ── Global Middleware ──
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Force no-cache headers on all dynamic API endpoints
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

import { checkD1Health } from './shared/d1.js';
import { checkRedisHealth } from './shared/redis.js';
import { queryD1 } from './shared/d1.js';

// ── Health Check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'absoracloud-api', version: '2.0.0' });
});

// ── Deep Health Check (verifies D1 shards + Redis) ──
app.get('/health/deep', async (req, res) => {
  try {
    const [d1Health, redisHealth] = await Promise.all([
      checkD1Health(),
      checkRedisHealth(),
    ]);

    const allD1Online = d1Health.every(d => d.status === 'online');
    const redisOnline = redisHealth.status === 'online';

    res.json({
      status: allD1Online && redisOnline ? 'healthy' : 'degraded',
      service: 'absoracloud-api',
      version: '2.0.0',
      d1_shards: d1Health,
      redis: redisHealth,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: e.message });
  }
});

// ── DB Tables Verification ──
app.get('/health/db', async (req, res) => {
  try {
    const tables = await queryD1(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    );
    const tableNames = tables.map(t => t.name);

    const required = ['users', 'instances', 'runners', 'plan_definitions'];
    const missing = required.filter(t => !tableNames.includes(t));

    res.json({
      status: missing.length === 0 ? 'ok' : 'missing_tables',
      tables: tableNames,
      required,
      missing,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', msg: e.message });
  }
});

// ── Service Routes ──
app.use('/auth',      authRouter);
app.use('/mc',        mcRouter);
app.use('/vps',       vpsRouter);
app.use('/devbox',    devboxRouter);
app.use('/webhost',   webhostRouter);
app.use('/plans',     plansRouter);
app.use('/admin',     adminRouter);
app.use('/worker',    workerRouter);
app.use('/community', communityRouter);

import { startWatchdog } from './services/watchdog.js';

// ── Error Handler ──
app.use(errorHandler);

// ── Start ──
app.listen(PORT, () => {
  console.log(`☁️  AbsoraCloud API running on port ${PORT}`);
  startWatchdog(30000); // Check timeouts every 30s
});

export default app;
