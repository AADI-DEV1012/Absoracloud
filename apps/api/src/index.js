// ── AbsoraCloud API Gateway ──
// Central brain: SSO auth, runner orchestration, quota enforcement.

import express from 'express';
import cors from 'cors';

import { authRouter }      from './routes/auth.js';
import { storageRouter }   from './routes/storage.js';
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
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Force no-cache headers on all dynamic API endpoints
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ── Health Check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'absoracloud-api', version: '2.0.0' });
});

// ── API Router (/api/*) & Direct Routes ──
const apiRouter = express.Router();
apiRouter.use('/auth',      authRouter);
apiRouter.use('/storage',   storageRouter);
apiRouter.use('/vps',       vpsRouter);
apiRouter.use('/devbox',    devboxRouter);
apiRouter.use('/webhost',   webhostRouter);
apiRouter.use('/plans',     plansRouter);
apiRouter.use('/admin',     adminRouter);
apiRouter.use('/worker',    workerRouter);
apiRouter.use('/community', communityRouter);

app.use('/api', apiRouter);

// Direct root route aliases for backward compatibility
app.use('/auth',      authRouter);
app.use('/storage',   storageRouter);
app.use('/vps',       vpsRouter);
app.use('/devbox',    devboxRouter);
app.use('/webhost',   webhostRouter);
app.use('/plans',     plansRouter);
app.use('/admin',     adminRouter);
app.use('/worker',    workerRouter);
app.use('/community', communityRouter);

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, '../../web');

// Serve static web app and Pterodactyl console
app.use(express.static(webDir));
app.use(express.static(path.resolve(__dirname, '../../../')));

// ── Error Handler ──
app.use(errorHandler);

// ── Start ──
app.listen(PORT, () => {
  console.log(`☁️  AbsoraCloud API running on port ${PORT}`);
  startWatchdog(30000); // Check timeouts every 30s
});

export default app;
