/* Optional smoke test against the REAL backend (member B).
 *
 * Behaviour, deliberately honest:
 *   - backend not running  -> print SKIP + how to start it, exit 0 (a missing
 *     local server is not a code failure, and it is never reported as a pass)
 *   - backend running      -> health check, then demo login (alias only, no
 *     access code) + /me + lists + a postcode browse round trip; any failure
 *     exits 1
 *
 *   BND_API_BASE=http://127.0.0.1:8000 node smoke-test.cjs
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
  console.log('    ./start.sh          # or:');
  console.log('    cd backend && .venv/bin/uvicorn app.main:app --port 8000');
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

  /* 2. an unknown demo alias is rejected with 401 ----------------------- */
  const unknown = await request('POST', '/api/v1/demo/sessions', { body: { user_alias: 'mallory' } });
  if (unknown.status !== 401) {
    console.error(`FAIL: unknown demo account should be 401, got ${unknown.status}: ${JSON.stringify(unknown.body)}`);
    process.exit(1);
  }
  console.log(`PASS: POST /api/v1/demo/sessions (unknown alias) -> 401 ${unknown.body && unknown.body.error && unknown.body.error.code}`);

  /* 3. demo login with the alias alone (no access code) ----------------- */
  const login = await request('POST', '/api/v1/demo/sessions', { body: { user_alias: 'alice' } });
  if (login.status !== 201 || !login.body || !login.body.data || !login.body.data.access_token) {
    console.error(`FAIL: demo login as alice returned ${login.status}: ${JSON.stringify(login.body)}`);
    process.exit(1);
  }
  const token = login.body.data.access_token;
  console.log(`PASS: POST /api/v1/demo/sessions (alice, no access code) -> 201, token ${token.slice(0, 8)}…`);

  const me = await request('GET', '/api/v1/me', { token });
  if (me.status !== 200 || !me.body || !me.body.data || !me.body.data.community) {
    console.error(`FAIL: GET /api/v1/me returned ${me.status}: ${JSON.stringify(me.body)}`);
    process.exit(1);
  }
  const home = me.body.data.community;
  console.log(`PASS: GET /api/v1/me -> ${me.body.data.display_name} in ${home.postcode}`);

  const tasks = await request('GET', '/api/v1/tasks?scope=mine&limit=5', { token });
  if (tasks.status !== 200 || !Array.isArray(tasks.body.data)) {
    console.error(`FAIL: GET /api/v1/tasks returned ${tasks.status}: ${JSON.stringify(tasks.body)}`);
    process.exit(1);
  }
  console.log(`PASS: GET /api/v1/tasks?scope=mine -> ${tasks.body.data.length} task(s), total=${tasks.body.meta.total}`);

  const tools = await request('GET', `/api/v1/tools?community_id=${encodeURIComponent(home.id)}&radius_m=2000&limit=5`, { token });
  if (tools.status !== 200 || !Array.isArray(tools.body.data)) {
    console.error(`FAIL: GET /api/v1/tools returned ${tools.status}: ${JSON.stringify(tools.body)}`);
    process.exit(1);
  }
  console.log(`PASS: GET /api/v1/tools (home ${home.outcode}) -> ${tools.body.data.length} tool(s), total=${tools.body.meta.total}`);

  /* 4. the browse path the community page now uses ---------------------- */
  const resolved = await request('GET', `/api/v1/communities/resolve?postcode=${encodeURIComponent('EH14 4AS')}`, { token });
  if (resolved.status !== 200 || !resolved.body || !resolved.body.data || !resolved.body.data.id) {
    console.error(`FAIL: GET /api/v1/communities/resolve returned ${resolved.status}: ${JSON.stringify(resolved.body)}`);
    process.exit(1);
  }
  const other = resolved.body.data;
  console.log(`PASS: GET /api/v1/communities/resolve?postcode=EH14 4AS -> ${other.postcode} (${other.outcode})`);

  const env = await request('GET', `/api/v1/communities/${encodeURIComponent(other.id)}/environment`, { token });
  if (env.status !== 200 || !env.body || !env.body.data) {
    console.error(`FAIL: GET /api/v1/communities/{id}/environment returned ${env.status}: ${JSON.stringify(env.body)}`);
    process.exit(1);
  }
  console.log(`PASS: GET /api/v1/communities/{id}/environment -> status=${env.body.data.status}`);

  const otherTools = await request('GET', `/api/v1/tools?community_id=${encodeURIComponent(other.id)}&radius_m=2000&limit=5`, { token });
  if (otherTools.status !== 200 || !Array.isArray(otherTools.body.data)) {
    console.error(`FAIL: GET /api/v1/tools (browsed community) returned ${otherTools.status}: ${JSON.stringify(otherTools.body)}`);
    process.exit(1);
  }
  console.log(`PASS: GET /api/v1/tools (browsed ${other.outcode}) -> ${otherTools.body.data.length} tool(s), total=${otherTools.body.meta.total}`);

  const logout = await request('POST', '/api/v1/sessions/logout', { token });
  if (logout.status !== 200 || !logout.body || logout.body.data.revoked !== true) {
    console.error(`FAIL: POST /api/v1/sessions/logout returned ${logout.status}: ${JSON.stringify(logout.body)}`);
    process.exit(1);
  }
  console.log('PASS: POST /api/v1/sessions/logout -> {"revoked":true}');
  console.log('SMOKE PASS: health + alias login + me + lists + postcode browse + logout against the real backend.');
}

main().catch(err => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
