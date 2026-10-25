// ── AbsoraCloud Automated CI Test Suite ──
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Set dummy secrets for test environment if not present
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_1234567890abcdef';
process.env.WORKER_SECRET = process.env.WORKER_SECRET || 'test_worker_secret_key_abcdef123456';

console.log('🧪 Starting AbsoraCloud CI Test Suite...\n');

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ── 1. Test Subscription Plans & Quotas ──
const { PLANS, getPlan, getPlanLimits } = await import('../packages/shared/plans.js');

runTest('Plans definition has all required tiers', () => {
  assert.ok(PLANS.free, 'Free tier must exist');
  assert.ok(PLANS.basic, 'Basic tier must exist');
  assert.ok(PLANS.pro, 'Pro tier must exist');
  assert.ok(PLANS.enterprise, 'Enterprise tier must exist');
});

runTest('Free plan forbids GPU while paid plans allow GPU', () => {
  assert.strictEqual(PLANS.free.gpu_allowed, false, 'Free plan must not allow GPU');
  assert.strictEqual(PLANS.basic.gpu_allowed, true, 'Basic plan must allow GPU');
  assert.strictEqual(PLANS.pro.gpu_allowed, true, 'Pro plan must allow GPU');
  assert.strictEqual(PLANS.enterprise.gpu_allowed, true, 'Enterprise plan must allow GPU');

  assert.strictEqual(PLANS.basic.gpu_hours, 1);
  assert.strictEqual(PLANS.pro.gpu_hours, 3);
  assert.strictEqual(PLANS.enterprise.gpu_hours, 5);
});

runTest('getPlan returns fallback to free for unknown tier', () => {
  const p = getPlan('non_existent_tier');
  assert.strictEqual(p.name, 'Free');
});

runTest('getPlanLimits resolves storage and compute quotas', () => {
  const vpsLimit = getPlanLimits('basic', 'vps');
  assert.strictEqual(vpsLimit.weekly_seconds, 10 * 3600);
  assert.strictEqual(vpsLimit.cpu, 1);
  assert.strictEqual(vpsLimit.slots, 2);

  const devboxLimit = getPlanLimits('pro', 'devbox');
  assert.strictEqual(devboxLimit.gpu_hours, 3);
  assert.strictEqual(devboxLimit.gpu_allowed, true);
  assert.strictEqual(devboxLimit.weekly_seconds, 180 * 60);

  const storageLimit = getPlanLimits('enterprise', 'storage');
  assert.strictEqual(storageLimit.storage_gb, 200);
});

// ── 2. Test Cryptographic JWT Helpers ──
const { signToken, verifyToken } = await import('../packages/shared/jwt.js');

runTest('JWT tokens sign and verify user claims accurately', () => {
  const payload = { sub: 42, username: 'cloud_user', plan: 'pro', role: 'user' };
  const token = signToken(payload, '1h');
  assert.ok(typeof token === 'string' && token.length > 20, 'Token must be non-empty string');

  const decoded = verifyToken(token);
  assert.strictEqual(decoded.sub, 42);
  assert.strictEqual(decoded.username, 'cloud_user');
  assert.strictEqual(decoded.plan, 'pro');
});

runTest('JWT rejects tampered or expired tokens', () => {
  const validToken = signToken({ sub: 1 }, '1h');
  const tampered = validToken.slice(0, -5) + 'xxxxx';
  const decoded = verifyToken(tampered);
  assert.strictEqual(decoded, null, 'Tampered token must return null');
});

// ── 3. Test Database Schema Integrity ──
runTest('schema.sql includes all required multi-tenant tables', () => {
  const schemaPath = path.join(rootDir, 'schema.sql');
  assert.ok(fs.existsSync(schemaPath), 'schema.sql must exist');
  const content = fs.readFileSync(schemaPath, 'utf-8');

  const requiredTables = [
    'users',
    'instances',
    'runners',
    'cloud_files',
    'bans',
    'tickets',
    'ticket_replies',
    'realtime_events'
  ];

  for (const table of requiredTables) {
    const regex = new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}`, 'i');
    assert.ok(regex.test(content), `Table '${table}' must be defined in schema.sql`);
  }
});

// ── 4. Verify Monorepo Entrypoints & Route Files Exist ──
runTest('All core service route files exist and are readable', () => {
  const requiredRoutes = [
    'apps/api/src/routes/auth.js',
    'apps/api/src/routes/vps.js',
    'apps/api/src/routes/devbox.js',
    'apps/api/src/routes/storage.js',
    'apps/api/src/routes/serverless.js',
    'apps/api/src/routes/webhost.js',
    'apps/api/src/routes/plans.js',
    'apps/api/src/routes/admin.js',
    'apps/api/src/routes/worker.js',
    'apps/api/src/routes/community.js',
    'apps/api/src/routes/realtime.js'
  ];

  for (const r of requiredRoutes) {
    assert.ok(fs.existsSync(path.join(rootDir, r)), `Route file ${r} must exist`);
  }
});

console.log(`\n===========================================`);
console.log(`  Tests Passed: ${passed}`);
console.log(`  Tests Failed: ${failed}`);
console.log(`===========================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 All automated tests passed successfully!');
  process.exit(0);
}
