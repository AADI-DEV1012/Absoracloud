// ── Kaggle API Integration ──
// Triggers Kaggle notebook kernels for DevBox GPU sessions.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function triggerKaggleKernel(sessionKey, userId, plan) {
  const username = process.env.KAGGLE_USERNAME || 'aadiplayz23';
  const key      = process.env.KAGGLE_KEY || 'KGAT_a84a19068f9bb226aecf9d9c17d32cd3';

  if (!username || !key) {
    throw new Error('Missing KAGGLE_USERNAME or KAGGLE_KEY');
  }

  const authHeader = key.startsWith('KGAT_')
    ? `Bearer ${key}`
    : `Basic ${Buffer.from(`${username}:${key}`).toString('base64')}`;

  // Read kernel runner script from disk
  let scriptContent = '';
  const possiblePaths = [
    path.resolve(__dirname, '../../../runners/devbox-kernel/kernel.py'),
    path.resolve(__dirname, '../../../../runners/devbox-kernel/kernel.py'),
    path.resolve(process.cwd(), 'runners/devbox-kernel/kernel.py'),
    path.resolve(process.cwd(), 'absoracloud-v2/runners/devbox-kernel/kernel.py'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      scriptContent = fs.readFileSync(p, 'utf8');
      break;
    }
  }

  const kernelPush = {
    slug: `${username}/absoracloud-devbox`,
    newTitle: 'AbsoraCloud DevBox',
    text: scriptContent || "print('AbsoraCloud DevBox Runner')",
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: true,
    enableInternet: true,
  };

  const res = await fetch('https://www.kaggle.com/api/v1/kernels/push', {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(kernelPush),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kaggle kernel push failed (${res.status}): ${text}`);
  }

  return await res.json();
}

export async function getKernelStatus(kernelRef = 'absoracloud-devbox') {
  const username = process.env.KAGGLE_USERNAME || 'aadiplayz23';
  const key      = process.env.KAGGLE_KEY || 'KGAT_a84a19068f9bb226aecf9d9c17d32cd3';
  const authHeader = key.startsWith('KGAT_')
    ? `Bearer ${key}`
    : `Basic ${Buffer.from(`${username}:${key}`).toString('base64')}`;

  const res = await fetch(`https://www.kaggle.com/api/v1/kernels/status?userName=${username}&kernelSlug=${kernelRef}`, {
    headers: { 'Authorization': authHeader },
  });

  return await res.json();
}
