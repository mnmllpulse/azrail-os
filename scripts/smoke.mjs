// Read-only post-deployment checks. Secrets come only from environment variables.
const base = process.env.AZRAIL_URL;
const token = process.env.AZRAIL_TOKEN;
if (!base || !token) throw Error('Set AZRAIL_URL and AZRAIL_TOKEN in your shell.');
const url = new URL(base);
if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) throw Error('HTTPS is required.');
const checks = [
  ['/api/me', false, 401],
  ['/agents/orchestrator/default', true, 404],
  ['/api/me', true, 200],
  ['/health', true, 200],
  ['/api/agents', true, 200],
];
let failed = 0;
for (const [path, authenticated, expected] of checks) {
  try {
    const response = await fetch(new URL(path, url), {
      headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    const ok = response.status === expected;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${path}: ${response.status}, expected ${expected}`);
    if (!ok) failed++;
    await response.body?.cancel();
  } catch { failed++; console.log(`FAIL ${path}: connection or redirect error`); }
}
process.exitCode = failed ? 1 : 0;
