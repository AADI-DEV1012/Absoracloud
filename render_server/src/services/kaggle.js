// ── Kaggle API Integration ──
// Triggers Kaggle notebook kernels for DevBox GPU sessions.

export async function triggerKaggleKernel(sessionKey, userId, plan) {
  const username = process.env.KAGGLE_USERNAME;
  const key      = process.env.KAGGLE_KEY;

  if (!username || !key) {
    throw new Error('Missing KAGGLE_USERNAME or KAGGLE_KEY');
  }

  const auth = Buffer.from(`${username}:${key}`).toString('base64');

  const kernelPush = {
    id: `${username}/absoracloud-devbox`,
    data: {
      title: `AbsoraCloud DevBox - ${sessionKey}`,
      code_file: 'runner.py',
      language: 'python',
      kernel_type: 'script',
      is_private: true,
      enable_gpu: true,
      enable_internet: true,
      dataset_sources: [],
      competition_sources: [],
      kernel_sources: [],
      category_ids: [],
    },
  };

  const res = await fetch('https://www.kaggle.com/api/v1/kernels/push', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
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

export async function getKernelStatus(kernelRef) {
  const username = process.env.KAGGLE_USERNAME;
  const key      = process.env.KAGGLE_KEY;
  const auth     = Buffer.from(`${username}:${key}`).toString('base64');

  const res = await fetch(`https://www.kaggle.com/api/v1/kernels/status?userName=${username}&kernelSlug=${kernelRef}`, {
    headers: { 'Authorization': `Basic ${auth}` },
  });

  return await res.json();
}
