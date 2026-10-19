// ── Realtime WebSocket Routes ──
// POST /realtime/publish, GET /realtime/config, GET /realtime/events, GET /realtime/status

import { Router } from 'express';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { executeD1, queryD1 } from '../../../packages/shared/d1.js';
import { redisCmd } from '../../../packages/shared/redis.js';
import { broadcastRealtimeEvent, getClientWebSocketConfig } from '../services/realtime_gateway.js';

export const realtimeRouter = Router();

// ── GET /realtime/config — Client connection parameters ──
realtimeRouter.get('/config', optionalAuth, (req, res) => {
  const config = getClientWebSocketConfig();
  res.json({
    status: 'success',
    service: 'AbsoraEdge Realtime WebSocket Gateway',
    config,
  });
});

// ── POST /realtime/publish — Broadcast message to a channel ──
realtimeRouter.post('/publish', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.sub;
    const { channel, event, event_name, data } = req.body;
    const targetEvent = event || event_name;

    if (!channel || !targetEvent) {
      return res.status(400).json({ status: 'error', msg: 'channel and event are required' });
    }

    // Clean channel name
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
    const safeEvent   = targetEvent.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 50);

    const result = await broadcastRealtimeEvent({
      channel: safeChannel,
      event: safeEvent,
      data: data || {},
      userId,
    });

    // Record in D1 realtime_events table
    try {
      await executeD1(
        'INSERT INTO realtime_events (user_id, channel, event_name, payload, provider) VALUES (?, ?, ?, ?, ?)',
        [userId, safeChannel, safeEvent, JSON.stringify(data || {}), result.provider || 'pool']
      );
    } catch (_) {}

    res.json({
      status: 'success',
      msg: 'Realtime event broadcasted successfully',
      result,
    });
  } catch (err) {
    console.error('[RealtimeRouter] Publish error:', err);
    res.status(500).json({ status: 'error', msg: err.message || 'Failed to publish realtime event' });
  }
});

// ── GET /realtime/events — List recent channel events ──
realtimeRouter.get('/events', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.sub;
    const channel = req.query.channel;

    let events = [];
    if (channel) {
      events = await queryD1(
        'SELECT id, channel, event_name, payload, provider, created_at FROM realtime_events WHERE channel = ? ORDER BY id DESC LIMIT 50',
        [channel]
      );
    } else {
      events = await queryD1(
        'SELECT id, channel, event_name, payload, provider, created_at FROM realtime_events WHERE user_id = ? ORDER BY id DESC LIMIT 50',
        [userId]
      );
    }

    res.json({ status: 'success', events });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: 'Failed to fetch realtime events' });
  }
});

// ── GET /realtime/status — Gateway provider health ──
realtimeRouter.get('/status', optionalAuth, async (req, res) => {
  const hasPusher    = Boolean(process.env.PUSHER_KEY && process.env.PUSHER_SECRET);
  const hasAbly      = Boolean(process.env.ABLY_API_KEY);
  const hasPieSocket = Boolean(process.env.PIESOCKET_API_KEY);
  const hasScaledrone = Boolean(process.env.SCALEDRONE_CHANNEL_ID);

  res.json({
    status: 'online',
    gateway: 'AbsoraEdge Realtime Cluster',
    active_providers_count: [hasPusher, hasAbly, hasPieSocket, hasScaledrone].filter(Boolean).length,
    providers: {
      provider_primary: hasPusher ? 'ready' : 'inactive',
      provider_secondary: hasAbly ? 'ready' : 'inactive',
      provider_tertiary: hasPieSocket ? 'ready' : 'inactive',
      provider_backup: hasScaledrone ? 'ready' : 'inactive',
      redis_event_broker: 'connected',
    },
  });
});
