// ── Cloud Storage Route ──
// Secure, high-speed object storage for AbsoraCloud users.
// Supports file upload, download, streaming preview, direct shareable URLs, and plan quotas.

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { executeD1, queryD1 } from '../../../packages/shared/d1.js';
import { redisCmd } from '../../../packages/shared/redis.js';
import { getPlan } from '../../../packages/shared/plans.js';
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
        storage_type TEXT DEFAULT 'vps',
        created_at DATETIME DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    // If D1 fails, Redis fallback handles metadata
  }
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
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.7z': 'application/x-7z-compressed',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.py': 'text/x-python',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// ── GET /storage/files — List user files ──
storageRouter.get('/files', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    let files = [];
    try {
      files = await queryD1(
        'SELECT id, filename, file_size, mime_type, public_url, created_at FROM cloud_files WHERE user_id = ? ORDER BY id DESC',
        [userId]
      );
    } catch (e) {
      // Redis fallback
      const fileIds = await redisCmd('SMEMBERS', `user:${userId}:file_ids`);
      if (Array.isArray(fileIds) && fileIds.length > 0) {
        for (const fid of fileIds) {
          const raw = await redisCmd('HGETALL', `file:${fid}`);
          if (raw && Object.keys(raw).length > 0) {
            files.push(raw);
          }
        }
      }
    }

    // Calculate total storage used
    const totalBytes = files.reduce((acc, f) => acc + (parseInt(f.file_size) || 0), 0);
    const plan = getPlan(req.user.plan || 'free');
    const maxStorageBytes = (plan.storage_gb || 5) * 1024 * 1024 * 1024;

    res.json({
      status: 'success',
      files: files || [],
      used_bytes: totalBytes,
      max_bytes: maxStorageBytes,
      plan_name: plan.name,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
});

// ── POST /storage/upload — Upload a file ──
storageRouter.post('/upload', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { filename, content_base64, mime_type } = req.body;

  if (!filename || !content_base64) {
    return res.status(400).json({ status: 'error', msg: 'filename and content_base64 are required' });
  }

  try {
    const fileBuffer = Buffer.from(content_base64, 'base64');
    const fileSize = fileBuffer.length;

    // Check plan quota
    const plan = getPlan(req.user.plan || 'free');
    const maxStorageBytes = (plan.storage_gb || 5) * 1024 * 1024 * 1024;

    let currentFiles = [];
    try {
      currentFiles = await queryD1('SELECT file_size FROM cloud_files WHERE user_id = ?', [userId]);
    } catch (e) {}

    const currentBytes = currentFiles.reduce((acc, f) => acc + (parseInt(f.file_size) || 0), 0);
    if (currentBytes + fileSize > maxStorageBytes) {
      const maxGB = plan.storage_gb || 5;
      return res.status(403).json({
        status: 'error',
        msg: `Storage quota exceeded for ${plan.name} plan (${maxGB} GB limit). Upgrade plan to upload more.`,
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
    const host = req.get('host') || 'astrocore.qzz.io';
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';

    let fileId = Date.now();
    try {
      const meta = await executeD1(
        'INSERT INTO cloud_files (user_id, filename, stored_name, file_size, mime_type, storage_type) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, safeOriginal, storedName, fileSize, detectedMime, 'vps']
      );
      if (meta && meta.last_row_id) fileId = meta.last_row_id;
    } catch (e) {
      // Redis fallback
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

    // Update public URL in DB
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
      fileRecord = await redisCmd('HGETALL', `file:${id}`);
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
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${fileRecord.filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h

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
      fileRecord = await redisCmd('HGETALL', `file:${id}`);
    }

    if (!fileRecord || !fileRecord.stored_name) {
      return res.status(404).send('File not found');
    }

    const userDir = path.join(STORAGE_DIR, `user_${fileRecord.user_id}`);
    const filePath = path.join(userDir, fileRecord.stored_name);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found on disk');
    }

    res.download(filePath, fileRecord.filename);
  } catch (err) {
    res.status(500).send('Error downloading file');
  }
});

// ── DELETE /storage/file/:id — Delete a file ──
storageRouter.delete('/file/:id', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    let fileRecord = null;
    try {
      const rows = await queryD1('SELECT * FROM cloud_files WHERE id = ? AND user_id = ?', [id, userId]);
      if (rows && rows.length > 0) fileRecord = rows[0];
    } catch (e) {
      fileRecord = await redisCmd('HGETALL', `file:${id}`);
      if (fileRecord && String(fileRecord.user_id) !== String(userId)) fileRecord = null;
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

    await redisCmd('SREM', `user:${userId}:file_ids`, String(id));
    await redisCmd('DEL', `file:${id}`);

    res.json({ status: 'success', msg: 'File deleted successfully' });
  } catch (err) {
    res.status(500).json({ status: 'error', msg: err.message });
  }
});
