// ── Media Storage CDN Shards Service ──
// Multi-provider media disk pool: Cloudinary + ImageKit + Uploadcare
// Automatic upload failover and direct CDN link generation

import crypto from 'crypto';

// ── Upload to Cloudinary ──
async function uploadToCloudinary(base64Content, filename) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary credentials missing');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const cleanName = filename.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const publicId  = `absora_${Date.now()}_${cleanName}`;

  // Signature: SHA1 of sorted parameters + apiSecret
  const stringToSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(stringToSign).digest('hex');

  const formData = new FormData();
  formData.append('file', `data:application/octet-stream;base64,${base64Content}`);
  formData.append('api_key', apiKey);
  formData.append('timestamp', String(timestamp));
  formData.append('public_id', publicId);
  formData.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
    method: 'POST',
    body: formData,
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Cloudinary upload failed (${res.status})`);
  }

  return {
    provider: 'cloudinary',
    url: data.secure_url || data.url,
    size: data.bytes,
    format: data.format,
  };
}

// ── Upload to ImageKit ──
async function uploadToImageKit(base64Content, filename) {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/5pob2zpac';

  if (!privateKey) throw new Error('ImageKit credentials missing');

  const formData = new FormData();
  formData.append('file', base64Content);
  formData.append('fileName', filename);
  formData.append('useUniqueFileName', 'true');

  const authHeader = `Basic ${Buffer.from(`${privateKey}:`).toString('base64')}`;

  const res = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST',
    headers: { 'Authorization': authHeader },
    body: formData,
  });

  const data = await res.json();
  if (!res.ok || data.message) {
    throw new Error(data.message || `ImageKit upload failed (${res.status})`);
  }

  return {
    provider: 'imagekit',
    url: data.url || `${urlEndpoint}/${data.name}`,
    size: data.size,
  };
}

// ── Multi-Provider Media CDN Upload ──
export async function uploadMediaToCloudPool(base64Content, filename) {
  const providers = [
    { name: 'cloudinary', fn: () => uploadToCloudinary(base64Content, filename) },
    { name: 'imagekit',   fn: () => uploadToImageKit(base64Content, filename) },
  ];

  for (const prov of providers) {
    try {
      const res = await prov.fn();
      return res;
    } catch (err) {
      console.warn(`[MediaCDN] Provider ${prov.name} upload failed:`, err.message);
    }
  }

  return null;
}
