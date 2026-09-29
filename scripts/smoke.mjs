// Read-only post-deployment checks. Secrets come only from environment variables.
const base = process.env.AZRAIL_URL;
const token = process.env.AZRAIL_TOKEN;
if (!base || !token) throw Error('Set AZRAIL_URL and AZRAIL_TOKEN in your shell.');

const origin = new URL(base);
if (origin.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(origin.hostname)) {
  throw Error('HTTPS is required.');
}

let failed = 0;
const auth = { Authorization: `Bearer ${token}` };

async function check(path, { authenticated = false, status = 200, contains } = {}) {
  try {
    const response = await fetch(new URL(path, origin), {
      headers: authenticated ? auth : {},
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    let body = '';
    if (contains || response.headers.get('content-type')?.includes('application/json')) {
      body = await response.text();
    } else {
      await response.body?.cancel();
    }
    const okStatus = response.status === status;
    const okBody = contains ? body.includes(contains) : true;
    const ok = okStatus && okBody;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${path}: ${response.status}, expected ${status}${contains ? `, marker=${JSON.stringify(contains)}` : ''}`);
    if (!ok) failed++;
    return { ok, status: response.status, body };
  } catch (err) {
    failed++;
    console.log(`FAIL ${path}: ${err instanceof Error ? err.message : 'connection or redirect error'}`);
    return { ok: false, status: 0, body: '' };
  }
}

// Canonical product shell and preserved advanced/legacy assets.
await check('/', { contains: 'Что <span>создать?</span>' });
await check('/pulse.html', { contains: 'id="composer"' });
await check('/system.html', { contains: 'PULSE SYSTEM' });
await check('/ultimate.html', { contains: 'AZRAIL' });
await check('/index.html', { contains: 'AZRAIL' });

// Auth boundary and disabled direct agent transport.
await check('/api/azrail/me', { status: 401 });
await check('/agents/orchestrator/default', { authenticated: true, status: 404 });
await check('/api/azrail/me', { authenticated: true });
await check('/health', { authenticated: true });
await check('/api/azrail/agents', { authenticated: true });
await check('/api/azrail/routing-settings', { authenticated: true });

// Project-first read path. No records are created by smoke.
const projects = await check('/api/azrail/projects', { authenticated: true });
if (projects.ok) {
  try {
    const payload = JSON.parse(projects.body);
    const projectId = Array.isArray(payload.projects) ? payload.projects[0]?.id : undefined;
    if (projectId) {
      await check('/api/azrail/projects/' + encodeURIComponent(projectId) + '/workspace', { authenticated: true });
      await check('/api/azrail/metrics?projectId=' + encodeURIComponent(projectId), { authenticated: true });
    } else {
      console.log('SKIP project workspace/metrics: staging has no projects yet.');
    }
  } catch {
    failed++;
    console.log('FAIL /api/azrail/projects: invalid JSON response');
  }
}

process.exitCode = failed ? 1 : 0;
