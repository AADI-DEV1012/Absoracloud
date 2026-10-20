// ── Cloud Storage Route ──
// Secure, high-speed object storage for AbsoraCloud users.
// Supports file upload, download, streaming preview, direct shareable URLs, and plan quotas.

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { executeD1, queryD1 } from '../../../../packages/shared/d1.js';
import { redisCmd, redisParseHash } from '../../../../packages/shared/redis.js';
import { getPlan } from '../../../../packages/shared/plans.js';
import { uploadMediaToCloudPool } from '../services/media_cdn.js';

export const storageRouter = Router();

// Storage directory on host filesystem
const STORAGE_DIR = process.env.STORAGE_DIR || (
  fs.existsSync('/opt/absoracloud-data')
    ? '/opt/absoracloud-data/cloud_storage'
    : path.resolve(process.cwd(), 'data/cloud_storage')
);

// Ensure storage root directory exists
try {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
} catch (e) {
  console.error('[Storage] Error creating storage directory:', e.message);
}

// Ensure database table exists
async function ensureTable() {
  try {
    await executeD1(`
      CREATE TABLE IF NOT EXISTS cloud_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT DEFAULT 'application/octet-stream',
        public_url TEXT,
        provider TEXT DEFAULT 'local',
        storage_type TEXT DEFAULT 'vps',
        created_at DATETIME DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {}
}
ensureTable();

// MIME type detector helper
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.js': 'application/javascript',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// ── GET /storage/files — List all files for current user ──
storageRouter.get('/files', requireAuth, async (req, res) => {
  const userId = req.user.id || req.user.sub;

  try {
    let files = [];
    try {
      files = await queryD1(
        'SELECT id, filename, file_size, mime_type, public_url, provider, created_at FROM cloud_files WHERE user_id = ? ORDER BY id DESC',
        [userId]
      );
    } catch (d1Err) {
      const fileIds = await redisCmd('SMEMBERS', `user:${userId}:file_ids`);
      if (Array.isArray(fileIds) && fileIds.length > 0) {
        for (const fid of fileIds) {
          const raw = await redisCmd('HGETALL', `file:${fid}`);
          const record = redisParseHash(raw);
          if (record && record.filename) {
            files.push({
              id: record.id || fid,
              filename: record.filename,
              file_size: parseInt(record.file_size) || 0,
              mime_type: record.mime_type || 'application/octet-stream',
              public_url: record.public_url || null,
              provider: record.provider || 'local',
              created_at: record.created_at || new Date().toISOString(),
            });
          }
        }
      }
    }

    const totalBytes = files.reduce((acc, f) => acc + (parseInt(f.file_size) || 0), 0);
    const plan = getPlan(req.user.plan || 'free');
    const totalStorageBytes = (plan.storage_gb || 5) * 1024 * 1024 * 1024;
    const usableStorageBytes = totalStorageBytes;

    res.json({
      status: 'success',
      total_files: files.length,
      used_bytes: totalBytes,
      quota_bytes: usableStorageBytes,
      total_storage_bytes: totalStorageBytes,
      reserved_logs_mb: 0,
      reserved_logs_bytes: 0,
      usable_gb: (plan.storage_gb || 5).toFixed(2),
      total_gb: plan.storage_gb || 5,
      plan: plan.name,
      files,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
});

// ── POST /storage/upload — Upload a file ──
storageRouter.post('/upload', requireAuth, async (req, res) => {
  const userId = req.user.id || req.user.sub;
  const { filename, content_base64, mime_type } = req.body;

  if (!filename || !content_base64) {
    return res.status(400).json({ status: 'error', msg: 'filename and content_base64 are required' });
  }

  try {
    const fileBuffer = Buffer.from(content_base64, 'base64');
    const fileSize = fileBuffer.length;

    // Check plan quota: 100% full storage allocated to user (logs managed in unified 1GB platform pool)
    const plan = getPlan(req.user.plan || 'free');
    const totalStorageBytes = (plan.storage_gb || 5) * 1024 * 1024 * 1024;
    const usableStorageBytes = totalStorageBytes;

    let currentFiles = [];
    try {
      currentFiles = await queryD1('SELECT file_size FROM cloud_files WHERE user_id = ?', [userId]);
    } catch (e) {
      // If D1 fails, try Redis quota tracker
      const rBytes = await redisCmd('GET', `storage:bytes:${userId}`);
      if (rBytes !== null) {
        currentFiles = [{ file_size: parseInt(rBytes) || 0 }];
      } else {
        return res.status(503).json({ status: 'error', msg: 'Database quota service temporarily unavailable. Please retry in a moment.' });
      }
    }

    const currentBytes = currentFiles.reduce((acc, f) => acc + (parseInt(f.file_size) || 0), 0);
    if (currentBytes + fileSize > usableStorageBytes) {
      const usableGB = ((plan.storage_gb * 1024 - reservedLogsMb) / 1024).toFixed(2);
      return res.status(403).json({
        status: 'error',
        msg: `Storage quota exceeded for ${plan.name} plan. (${usableGB} GB usable space; ${reservedLogsMb} MB reserved for system runtime logs). Upgrade plan to upload more.`,
      });
    }

    // Save to user storage directory
    const userDir = path.join(STORAGE_DIR, `user_${userId}`);
    fs.mkdirSync(userDir, { recursive: true });

    const safeOriginal = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniquePrefix = crypto.randomBytes(8).toString('hex');
    const storedName = `${uniquePrefix}_${safeOriginal}`;
    const filePath = path.join(userDir, storedName);

    fs.writeFileSync(filePath, fileBuffer);

    const detectedMime = mime_type || getMimeType(safeOriginal);
    const host = req.headers.host || 'absoracloud.onrender.com';
    const proto = req.headers['x-forwarded-proto'] || 'https';

    let fileId = null;
    try {
      const result = await executeD1(
        `INSERT INTO cloud_files (user_id, filename, stored_name, file_size, mime_type, provider, created_at)
         VALUES (?, ?, ?, ?, ?, 'local', datetime('now'))`,
        [userId, safeOriginal, storedName, fileSize, detectedMime]
      );
      fileId = result?.last_row_id || Date.now();
    } catch (d1Err) {
      fileId = Date.now();
      await redisCmd('SADD', `user:${userId}:file_ids`, String(fileId));
      await redisCmd(
        'HSET',
        `file:${fileId}`,
        'id', String(fileId),
        'user_id', String(userId),
        'filename', safeOriginal,
        'stored_name', storedName,
        'file_size', String(fileSize),
        'mime_type', detectedMime,
        'created_at', new Date().toISOString()
      );
    }

    // Track total user storage in Redis
    await redisCmd('INCRBY', `storage:bytes:${userId}`, String(fileSize)).catch(() => {});

    let finalUrl = `${proto}://${host}/api/storage/file/${fileId}/${encodeURIComponent(safeOriginal)}`;
    let cdnProvider = 'local';

    // If image/video media, attempt high-speed CDN pool backup
    if (detectedMime.startsWith('image/') || detectedMime.startsWith('video/')) {
      try {
        const cdnResult = await uploadMediaToCloudPool(content_base64, safeOriginal);
        if (cdnResult && cdnResult.url) {
          finalUrl = cdnResult.url;
          cdnProvider = cdnResult.provider;
        }
      } catch (_) {}
    }

    // Update public URL and provider in DB
    try {
      await executeD1('UPDATE cloud_files SET public_url = ?, provider = ? WHERE id = ?', [finalUrl, cdnProvider, fileId]);
    } catch (e) {}

    res.json({
      status: 'success',
      msg: 'File uploaded successfully',
      file: {
        id: fileId,
        filename: safeOriginal,
        file_size: fileSize,
        mime_type: detectedMime,
        public_url: finalUrl,
        provider: cdnProvider,
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
});

// ── GET /storage/file/:id/:filename — Public Direct Share / Stream ──
storageRouter.get('/file/:id/:filename?', async (req, res) => {
  const { id } = req.params;

  try {
    let fileRecord = null;
    try {
      const rows = await queryD1('SELECT * FROM cloud_files WHERE id = ?', [id]);
      if (rows && rows.length > 0) fileRecord = rows[0];
    } catch (e) {
      const raw = await redisCmd('HGETALL', `file:${id}`);
      fileRecord = redisParseHash(raw);
    }

    if (!fileRecord || !fileRecord.stored_name) {
      return res.status(404).send('File not found or has been deleted');
    }

    const userDir = path.join(STORAGE_DIR, `user_${fileRecord.user_id}`);
    const filePath = path.join(userDir, fileRecord.stored_name);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File binary missing on storage node');
    }

    const mime = fileRecord.mime_type || getMimeType(fileRecord.filename);
    
    // Security / XSS Prevention:
    // Never render HTML, JavaScript, SVG, or unknown active formats inline on the app domain
    const isDangerousMime = mime.includes('html') || mime.includes('javascript') || mime.includes('svg') || mime === 'application/octet-stream';
    const dispositionType = isDangerousMime ? 'attachment' : 'inline';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${fileRecord.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  } catch (err) {
    res.status(500).send('Error streaming file');
  }
});

// ── GET /storage/download/:id — Force Download ──
storageRouter.get('/download/:id', async (req, res) => {
  const { id } = req.params;

  try {
    let fileRecord = null;
    try {
      const rows = await queryD1('SELECT * FROM cloud_files WHERE id = ?', [id]);
      if (rows && rows.length > 0) fileRecord = rows[0];
    } catch (e) {
      const raw = await redisCmd('HGETALL', `file:${id}`);
      fileRecord = redisParseHash(raw);
    }

    if (!fileRecord || !fileRecord.stored_name) {
      return res.status(404).send('File not found');
    }

    const userDir = path.join(STORAGE_DIR, `user_${fileRecord.user_id}`);
    const filePath = path.join(userDir, fileRecord.stored_name);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found on disk');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(filePath, fileRecord.filename);
  } catch (err) {
    res.status(500).send('Error downloading file');
  }
});

// ── DELETE /storage/file/:id — Delete a file ──
storageRouter.delete('/file/:id', requireAuth, async (req, res) => {
  const userId = req.user.id || req.user.sub;
  const { id } = req.params;

  try {
    let fileRecord = null;
    try {
      const rows = await queryD1('SELECT * FROM cloud_files WHERE id = ? AND user_id = ?', [id, userId]);
      if (rows && rows.length > 0) fileRecord = rows[0];
    } catch (e) {
      const raw = await redisCmd('HGETALL', `file:${id}`);
      const r = redisParseHash(raw);
      if (r && String(r.user_id) === String(userId)) fileRecord = r;
    }

    if (!fileRecord) {
      return res.status(404).json({ status: 'error', msg: 'File not found or permission denied' });
    }

    // Delete from disk
    const userDir = path.join(STORAGE_DIR, `user_${userId}`);
    const filePath = path.join(userDir, fileRecord.stored_name);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {}
    }

    // Delete from DB & Redis
    try {
      await executeD1('DELETE FROM cloud_files WHERE id = ? AND user_id = ?', [id, userId]);
    } catch (e) {}

    const freedBytes = parseInt(fileRecord.file_size) || 0;
    await redisCmd('DECRBY', `storage:bytes:${userId}`, String(freedBytes)).catch(() => {});
    await redisCmd('SREM', `user:${userId}:file_ids`, String(id));
    await redisCmd('DEL', `file:${id}`);

    res.json({ status: 'success', msg: 'File deleted successfully' });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
});
