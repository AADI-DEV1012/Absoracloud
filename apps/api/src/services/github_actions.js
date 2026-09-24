// ── GitHub Actions Workflow Trigger ──
// Dispatches workflows in the monorepo to spin up runners.

export async function triggerWorkflow(workflowFile, inputs = {}) {
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  const pat   = process.env.GITHUB_PAT;

  if (!owner || !repo || !pat) {
    throw new Error('Missing GITHUB_OWNER, GITHUB_REPO, or GITHUB_PAT');
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub Actions dispatch failed (${res.status}): ${text}`);
  }

  return true;
}
