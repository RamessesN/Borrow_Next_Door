/* Optional smoke test against the REAL backend (member B).
 *
 * Behaviour, deliberately honest:
 *   - backend not running  -> print SKIP + how to start it, exit 0 (a missing
 *     local server is not a code failure, and it is never reported as a pass)
 *   - backend running      -> health check, then login + /me + one list call
 *     with DEMO_ACCESS_CODE from the environment; any failure exits 1
 *   - DEMO_ACCESS_CODE unset while the backend runs -> health PASS, then an
 *     explicit SKIP for the authenticated checks (no code is ever hard-coded)
 *
 *   BND_API_BASE=http://127.0.0.1:8000 DEMO_ACCESS_CODE=... node smoke-test.cjs
 */
const http = require('node:http');

const BASE = (process.env.BND_API_BASE || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const TIMEOUT_MS = 5000;

function request(method, path, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const payload = opts.body ? JSON.stringify(opts.body) : null;
    const headers = { Accept: 'application/json' };
    if (payload) headers['Content-Type'] = 'application/json';
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const req = http.request(url, { method, headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startHint() {
  console.log('  To start it:');
  console.log('    cd backend && DEMO_ACCESS_CODE="<a team code of 16+ characters>" \\');
  console.log('      .venv/bin/uvicorn app.main:app --port 8000');
  console.log('  Then re-run: npm test   (or: node smoke-test.cjs)');
}

async function main() {
  /* 1. liveness -------------------------------------------------------- */
  let health;
  try {
    health = await request('GET', '/health/live');
  } catch (err) {
    console.log(`SKIP: backend not reachable at ${BASE} (${err.message}).`);
    console.log('      No real-backend smoke was run — this is not a pass.');
    startHint();
    process.exit(0);
  }
  if (health.status !== 200 || !health.body || !health.body.data || health.body.data.status !== 'live') {
    console.error(`FAIL: GET /health/live returned ${health.status}: ${JSON.stringify(health.body)}`);
    process.exit(1);
  }
  console.log(`PASS: GET ${BASE}/health/live -> ${JSON.stringify(health.body.data)}`);

  /* 2. authenticated checks ------------------------------------------- */
  const code = process.env.DEMO_ACCESS_CODE;
  if (!code) {
    console.log('SKIP: authenticated checks (set DEMO_ACCESS_CODE to a 16+ character team code to run them).');
    process.exit(0);
  }

  const login = await request('POST', '/api/v1/demo/sessions', {
    body: { user_alias: 'alice', access_code: code }
  });
  if (login.status !== 201 || !login.body || !login.body.data || !login.body.data.access_token) {
    console.error(`FAIL: demo login as alice returned ${login.status}: ${JSON.stringify(login.body)}`);
    process.exit(1);
  }
  const token = login.body.data.access_token;
  console.log(`PASS: POST /api/v1/demo/sessions (alice) -> 201, token ${token.slice(0, 8)}…`);

  const me = await request('GET', '/api/v1/me', { token });
  if (me.status !== 200 || !me.body || !me.body.data || !me.body.data.community) {
    console.error(`FAIL: GET /api/v1/me returned ${me.status}: ${JSON.stringify(me.body)}`);
    process.exit(1);
  }
  const communityId = me.body.data.community.id;
  console.log(`PASS: GET /api/v1/me -> ${me.body.data.display_name} in ${me.body.data.community.postcode}`);

  const tasks = await request('GET', '/api/v1/tasks?scope=mine&limit=5', { token });
  if (tasks.status !== 200 || !Array.isArray(tasks.body.data)) {
    console.error(`FAIL: GET /api/v1/tasks returned ${tasks.status}: ${JSON.stringify(tasks.body)}`);
    process.exit(1);
  }
  console.log(`PASS: GET /api/v1/tasks?scope=mine -> ${tasks.body.data.length} task(s), total=${tasks.body.meta.total}`);

  const tools = await request('GET', `/api/v1/tools?community_id=${encodeURIComponent(communityId)}&radius_m=2000&limit=5`, { token });
  if (tools.status !== 200 || !Array.isArray(tools.body.data)) {
    console.error(`FAIL: GET /api/v1/tools returned ${tools.status}: ${JSON.stringify(tools.body)}`);
    process.exit(1);
  }
  console.log(`PASS: GET /api/v1/tools -> ${tools.body.data.length} tool(s), total=${tools.body.meta.total}`);

  const logout = await request('POST', '/api/v1/sessions/logout', { token });
  if (logout.status !== 200 || !logout.body || logout.body.data.revoked !== true) {
    console.error(`FAIL: POST /api/v1/sessions/logout returned ${logout.status}: ${JSON.stringify(logout.body)}`);
    process.exit(1);
  }
  console.log('PASS: POST /api/v1/sessions/logout -> {"revoked":true}');
  console.log('SMOKE PASS: health + login + me + lists + logout against the real backend.');
}

main().catch(err => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
