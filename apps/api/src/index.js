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

// ── Global Middleware ──
app.use(cors({
  origin: ['https://absoracloud.qzz.io', 'http://localhost:5173'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health Check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'absoracloud-api', version: '2.0.0' });
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
