/* DOM + API harness for A's UI wiring.
 *
 * Loads web/task-module.js, web/map-module.js, web/api.js and web/app.js in a vm context that
 * looks like a browser: a minimal DOM, localStorage, and a **mock backend**
 * standing in for member B's FastAPI server (test/harness.cjs only — no
 * network, no real server, nothing outside this file).
 *
 * The mock speaks B's real contract: {data, meta} / {error, meta} envelopes,
 * Bearer tokens, Idempotency-Key on writes, and the frozen error codes
 * (TOOL_UNAVAILABLE, UNAUTHENTICATED, …). The e2e test therefore exercises the
 * real api.js + app.js code paths end to end.
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOKEN_KEY = 'bnd.token';
const USER_KEY = 'bnd.user';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------------ helpers */
const tick = () => new Promise(resolve => setImmediate(resolve));
const now = () => new Date().toISOString();
const ACTIVE = ['pending', 'accepted', 'on_loan'];

/* Distance between two community/coordinate objects, in metres. */
function haversineMeters(a, b) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* --------------------------------------------------------- mock B backend */
function createMockBackend(options) {
  options = options || {};

  /* Two fixture communities: the demo accounts' home street, and a second
     postcode visitors can browse to. resolve/lookup go through `registry`. */
  const community = {
    id: 'c1111111-1111-4111-8111-111111111111', postcode: 'EH8 9AB', outcode: 'EH8',
    latitude: 55.944703, longitude: -3.187417, country: 'Scotland',
    source: 'fixture', source_kind: 'fixture', fetched_at: '2026-10-03T09:00:00Z'
  };
  const otherCommunity = {
    id: 'c2222222-2222-4222-8222-222222222222', postcode: 'EH14 4AS', outcode: 'EH14',
    latitude: 55.904100, longitude: -3.248900, country: 'Scotland',
    source: 'fixture', source_kind: 'fixture', fetched_at: '2026-10-03T09:00:00Z'
  };
  const communities = [community, otherCommunity];
  const registry = new Map(communities.map(c => [c.id, c]));
  const users = {
    alice: { id: 'u1111111-1111-4111-8111-111111111111', alias: 'alice', display_name: 'Alice', community_id: community.id },
    bob: { id: 'u2222222-2222-4222-8222-222222222222', alias: 'bob', display_name: 'Bob', community_id: community.id },
    carol: { id: 'u3333333-3333-4333-8333-333333333333', alias: 'carol', display_name: 'Carol', community_id: community.id },
    /* Not offered on the sign-in panel: a neighbour one street over, so a
       browsed community has its own tool to show. */
    dana: { id: 'u4444444-4444-4444-8444-444444444444', alias: 'dana', display_name: 'Dana', community_id: otherCommunity.id }
  };
  const templates = [
    { id: 'park_cleanup', title: 'Park cleanup', description: 'Collect litter at a local park.', requirements: [{ category: 'litter_picker', quantity: 1 }, { category: 'reusable_gloves', quantity: 1 }] },
    { id: 'flowerbed_care', title: 'Flowerbed care', description: 'Water and weed a flowerbed.', requirements: [{ category: 'watering_can', quantity: 1 }, { category: 'hand_trowel', quantity: 1 }] }
  ];
  const TOOL_CATEGORIES = ['litter_picker', 'reusable_gloves', 'watering_can', 'hand_trowel'];

  const db = { tools: [], tasks: [], loans: [], events: [] };
  const sessions = new Map();   // token -> {alias, valid}
  const idem = new Map();       // user:key -> {fingerprint, status, body}
  const calls = [];             // every request the client made
  const writes = [];            // {path, key, status}
  let seq = 0;
  const rid = () => 'r' + String(++seq).padStart(6, '0');
  const newId = prefix => `${prefix}${String(++seq).padStart(4, '0')}${'x'.repeat(0)}`;

  /* Seeded tool in the *other* fixture community: browsing EH14 4AS must show
     a different list from home, so the list has to come from the API query. */
  db.tools.push({
    id: 't9000000-0000-4000-8000-000000000009', name: 'Colinton wheelbarrow', category: 'hand_trowel',
    description: 'Lives in the EH14 4AS tool shed.', owner_alias: 'dana',
    community_id: otherCommunity.id,
    availability: 'available', is_archived: false, created_at: now(), updated_at: now()
  });

  const ok = (data, extra) => ({ status: 200, body: { data, meta: Object.assign({ request_id: rid() }, extra || {}) } });
  const created = data => ({ status: 201, body: { data, meta: { request_id: rid() } } });
  const fail = (status, code, message, details) => ({ status, body: { error: { code, message, details: details || {} }, meta: { request_id: rid() } } });

  function header(init, name) {
    const headers = init.headers || {};
    const wanted = name.toLowerCase();
    for (const key of Object.keys(headers)) if (key.toLowerCase() === wanted) return headers[key];
    return null;
  }

  function userFor(init, auth) {
    const raw = header(init, 'authorization') || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
    const session = token ? sessions.get(token) : null;
    if (!session || !session.valid) return { error: fail(401, 'UNAUTHENTICATED', 'Authentication required.') };
    return { user: users[session.alias], token };
  }

  /* Idempotency exactly like B: required on business writes, one key per
     intent, replay on the same key, 409 when a key is reused for new data. */
  function idempotent(init, user, fingerprint, store) {
    const key = header(init, 'idempotency-key');
    if (!key) return fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required for this request.');
    if (!UUID_RE.test(key)) return fail(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be a UUID.');
    const id = `${user.id}:${key}`;
    const seen = idem.get(id);
    if (seen) {
      if (seen.fingerprint !== fingerprint) return fail(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
      return { status: seen.status, body: seen.body, replayed: true };
    }
    return { key, id, fingerprint, store };
  }
  function rememberIdem(entry, result) {
    if (entry && entry.id && result.status >= 200 && result.status < 300) {
      idem.set(entry.id, { fingerprint: entry.fingerprint, status: result.status, body: result.body });
    }
    return result;
  }

  function reqState(task, requirement) {
    const loans = db.loans
      .filter(l => l.requirement_id === requirement.id)
      .slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const active = loans.find(l => ACTIVE.includes(l.status));
    if (active) {
      return { state: { pending: 'pending', accepted: 'confirmed', on_loan: 'in_use' }[active.status], active_loan_id: active.id };
    }
    if (loans.some(l => l.status === 'returned' && l.handed_over_at)) return { state: 'fulfilled', active_loan_id: null };
    if (requirement.self_supplied) return { state: 'self_supplied', active_loan_id: null };
    const candidates = db.tools.filter(t => t.category === requirement.category && !t.is_archived &&
      t.owner_id !== task.creator_id && t.availability === 'available');
    return { state: candidates.length ? 'match_available' : 'missing', active_loan_id: null, candidate_tool_ids: candidates.map(t => t.id) };
  }

  function requirementView(task, requirement) {
    const derived = reqState(task, requirement);
    return {
      id: requirement.id, category: requirement.category, quantity: 1,
      self_supplied: requirement.self_supplied, state: derived.state,
      active_loan_id: derived.active_loan_id, candidate_tool_ids: derived.candidate_tool_ids || []
    };
  }

  function placeOf(task) {
    return { name: task.place_name, latitude: task.place_latitude, longitude: task.place_longitude, source: task.place_source, source_id: null };
  }
  function outcomeOf(task) {
    if (task.status !== 'completed') return null;
    return { note: task.outcome_note || '', bags_collected: task.bags_collected, volunteer_minutes: task.volunteer_minutes, verification: 'self_reported' };
  }
  function taskView(task, full) {
    const requirements = full ? task.requirements.map(r => requirementView(task, r)) : undefined;
    const states = task.requirements.map(r => reqState(task, r).state);
    const coordination = states.every(s => ['self_supplied', 'confirmed', 'in_use', 'fulfilled'].includes(s));
    const eligible = states.every(s => ['self_supplied', 'in_use', 'fulfilled'].includes(s));
    const base = {
      id: task.id, title: task.title,
      creator: { id: users[task.creator_alias].id, display_name: users[task.creator_alias].display_name },
      community_id: community.id, template_id: task.template_id, place: placeOf(task),
      status: task.status, coordination_ready: coordination, completion_eligible: eligible,
      outcome: outcomeOf(task), created_at: task.created_at, completed_at: task.completed_at
    };
    if (full) base.requirements = requirements;
    return base;
  }
  function toolView(tool) {
    const where = registry.get(tool.community_id) || community;
    return {
      id: tool.id, name: tool.name, category: tool.category, description: tool.description,
      owner: { id: users[tool.owner_alias].id, display_name: users[tool.owner_alias].display_name },
      community: where, availability: tool.availability, is_archived: tool.is_archived,
      distance_m: tool.is_archived ? null : haversineMeters(community, where), created_at: tool.created_at, updated_at: tool.updated_at
    };
  }
  function loanView(loan) { return Object.assign({}, loan); }

  function environmentPayload(target) {
    const c = target || community;
    return {
      status: 'partial',
      postcode: { provider: 'postcode', status: 'ok', data: { postcode: c.postcode }, source_kind: 'fixture', source: 'postcodes.io', source_url: '', attribution: 'postcodes.io (fixture snapshot)', fetched_at: c.fetched_at },
      carbon_intensity: { provider: 'carbon_intensity', status: 'not_implemented', data: null, source_kind: null, source: '', source_url: '', attribution: '', fetched_at: null },
      air_quality: { provider: 'air_quality', status: 'not_implemented', data: null, source_kind: null, source: '', source_url: '', attribution: '', fetched_at: null },
      greenspace: { provider: 'greenspace', status: 'ok', data: { outcode: c.outcode }, source_kind: 'fixture', source: 'OpenStreetMap Overpass', source_url: '', attribution: `Greens near ${c.outcode} (fixture snapshot)`, fetched_at: c.fetched_at }
    };
  }
  function impactPayload() {
    return {
      active_tools_count: db.tools.filter(t => !t.is_archived).length,
      returned_loans_count: db.loans.filter(l => l.status === 'returned').length,
      completed_tasks_count: db.tasks.filter(t => t.status === 'completed').length,
      as_of: now()
    };
  }

  function transition(loan, action, actor) {
    const allow = {
      accept: { from: ['pending'], to: 'accepted', who: 'owner' },
      reject: { from: ['pending'], to: 'rejected', who: 'owner' },
      cancel: { from: ['pending', 'accepted'], to: 'cancelled', who: 'either' },
      'hand-over': { from: ['accepted'], to: 'on_loan', who: 'owner' },
      return: { from: ['on_loan'], to: 'returned', who: 'owner' }
    }[action];
    if (!allow) return fail(404, 'NOT_FOUND', 'No such loan action.');
    if (allow.who === 'owner' && loan.owner_id !== actor.id) return fail(403, 'FORBIDDEN', 'Only the tool owner can do that.');
    if (allow.who === 'either' && loan.owner_id !== actor.id && loan.borrower_id !== actor.id) return fail(403, 'FORBIDDEN', 'Only the parties to a loan can do that.');
    if (!allow.from.includes(loan.status)) return fail(409, 'INVALID_TRANSITION', 'The loan is not in a state that allows this action.');
    const tool = db.tools.find(t => t.id === loan.tool_id);
    loan.status = allow.to;
    loan.updated_at = now();
    if (action === 'accept') loan.accepted_at = now();
    if (action === 'reject') loan.rejected_at = now();
    if (action === 'cancel') loan.cancelled_at = now();
    if (action === 'hand-over') { loan.handed_over_at = now(); if (tool) tool.availability = 'on_loan'; }
    if (action === 'return') { loan.returned_at = now(); if (tool) tool.availability = 'available'; }
    if (action === 'reject' || action === 'cancel') { if (tool && tool.availability !== 'on_loan') tool.availability = 'available'; }
    db.events.push({ id: newId('e'), loan_id: loan.id, actor_id: actor.id, action, from_status: allow.from[0], to_status: loan.status, created_at: now() });
    return ok(loanView(loan));
  }

  async function handle(url, init) {
    await tick();
    const parsed = new URL(url, 'http://mock.local');
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const method = (init.method || 'GET').toUpperCase();
    const path = pathname.startsWith('/api/v1') ? pathname.slice('/api/v1'.length) : pathname;
    let body = null;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = null; } }

    const needAuth = !(path === '/demo/sessions' || path === '/sessions/logout');
    let viewer = null;
    if (needAuth) {
      const auth = userFor(init);
      if (auth.error) return auth.error;
      viewer = auth.user;
    }

    /* ---------------------------------------------------------- auth ---- */
    if (path === '/demo/sessions' && method === 'POST') {
      const alias = body && body.user_alias;
      /* Alias-only demo sign-in: the access code was removed by user decision.
         A stray access_code is accepted and ignored, like the real backend. */
      if (!users[alias]) return fail(401, 'UNAUTHENTICATED', 'Unknown demo account.');
      const token = `tok-${alias}-${++seq}`;
      sessions.set(token, { alias, valid: true });
      return created({ access_token: token, token_type: 'bearer', expires_at: now(), user: users[alias] });
    }
    if (path === '/sessions/logout' && method === 'POST') {
      const raw = header(init, 'authorization') || '';
      const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
      const session = sessions.get(token);
      if (!session || !session.valid) return fail(401, 'UNAUTHENTICATED', 'Authentication required.');
      session.valid = false;
      return ok({ revoked: true });
    }
    if (path === '/me' && method === 'GET') {
      return ok({ id: viewer.id, display_name: viewer.display_name, community, mode: 'demo' });
    }

    /* -------------------------------------------------------- templates -- */
    if (path === '/task-templates' && method === 'GET') {
      return ok(templates, { limit: 20, offset: 0, total: templates.length });
    }

    /* ----------------------------------------------------------- tasks --- */
    if (path === '/tasks' && method === 'GET') {
      const scope = parsed.searchParams.get('scope') || 'mine';
      let rows = db.tasks;
      if (scope === 'mine') rows = rows.filter(t => t.creator_alias === viewer.alias);
      else rows = rows.filter(t => t.community_id === community.id);
      return ok(rows.map(t => taskView(t, false)), { limit: 20, offset: 0, total: rows.length });
    }
    let m = path.match(/^\/tasks\/([^/]+)$/);
    if (m && method === 'GET') {
      const task = db.tasks.find(t => t.id === m[1]);
      if (!task) return fail(404, 'NOT_FOUND', 'Task not found.');
      return ok(taskView(task, true));
    }
    if (path === '/tasks' && method === 'POST') {
      const fp = JSON.stringify([method, path, body]);
      const entry = idempotent(init, viewer, fp);
      if (entry.body) return entry;
      const tpl = templates.find(t => t.id === (body && body.template_id));
      if (!tpl) return fail(422, 'VALIDATION_ERROR', 'Request validation failed.', { fields: [{ field: 'template_id', message: 'unknown template' }] });
      if (body.place) {
        const dLat = (body.place.latitude - community.latitude) * 111000;
        const dLon = (body.place.longitude - community.longitude) * 111000 * Math.cos(55.9 * Math.PI / 180);
        if (Math.hypot(dLat, dLon) > 2000) return fail(422, 'OUT_OF_RANGE', 'A value is outside the allowed range.', { fields: [{ field: 'place', message: 'place must be within 2000 m of the user\'s community' }] });
      }
      const task = {
        id: newId('k'), title: (body.title || tpl.title).slice(0, 120),
        creator_alias: viewer.alias, community_id: community.id, template_id: tpl.id,
        place_name: body.place ? body.place.name : 'Neighbourhood green space',
        place_latitude: body.place ? body.place.latitude : community.latitude,
        place_longitude: body.place ? body.place.longitude : community.longitude,
        place_source: body.place ? body.place.source : 'manual',
        status: 'open', outcome_note: '', bags_collected: null, volunteer_minutes: null,
        requirements: tpl.requirements.map(r => ({ id: newId('q'), category: r.category, quantity: r.quantity, self_supplied: false })),
        created_at: now(), completed_at: null
      };
      db.tasks.push(task);
      return rememberIdem(entry, created(taskView(task, true)));
    }
    m = path.match(/^\/tasks\/([^/]+)\/requirements\/([^/]+)\/self-supply$/);
    if (m && method === 'PUT') {
      const fp = JSON.stringify([method, path, body]);
      const entry = idempotent(init, viewer, fp);
      if (entry.body) return entry;
      const task = db.tasks.find(t => t.id === m[1]);
      if (!task) return fail(404, 'NOT_FOUND', 'Task not found.');
      if (task.creator_alias !== viewer.alias) return fail(403, 'FORBIDDEN', 'Only the organiser can change this.');
      const requirement = task.requirements.find(r => r.id === m[2]);
      if (!requirement) return fail(404, 'NOT_FOUND', 'Requirement not found.');
      if (task.status === 'completed') return fail(409, 'TASK_ALREADY_COMPLETED', 'The task is already completed.');
      const locked = db.loans.some(l => l.requirement_id === requirement.id && ACTIVE.includes(l.status)) ||
        db.loans.some(l => l.requirement_id === requirement.id && l.handed_over_at);
      if (locked && body && body.self_supplied) return fail(409, 'REQUIREMENT_LOCKED', 'This requirement cannot be changed in its current state.');
      requirement.self_supplied = !!(body && body.self_supplied);
      return rememberIdem(entry, ok(taskView(task, true)));
    }
    m = path.match(/^\/tasks\/([^/]+)\/complete$/);
    if (m && method === 'POST') {
      const fp = JSON.stringify([method, path, body]);
      const entry = idempotent(init, viewer, fp);
      if (entry.body) return entry;
      const task = db.tasks.find(t => t.id === m[1]);
      if (!task) return fail(404, 'NOT_FOUND', 'Task not found.');
      if (task.creator_alias !== viewer.alias) return fail(403, 'FORBIDDEN', 'Only the organiser can record this action.');
      const view = taskView(task, true);
      if (task.status === 'completed') {
        const same = task.outcome_note === (body && body.outcome_note) &&
          task.bags_collected === (body ? body.bags_collected : null) &&
          task.volunteer_minutes === (body ? body.volunteer_minutes : null);
        return same ? rememberIdem(entry, ok(view)) : fail(409, 'TASK_ALREADY_COMPLETED', 'This action has already been recorded.');
      }
      if (!view.completion_eligible) return fail(409, 'TASK_NOT_READY', 'The task does not meet its completion conditions.');
      task.status = 'completed';
      task.outcome_note = body.outcome_note;
      task.bags_collected = body.bags_collected ?? null;
      task.volunteer_minutes = body.volunteer_minutes ?? null;
      task.completed_at = now();
      return rememberIdem(entry, ok(taskView(task, true)));
    }

    /* ----------------------------------------------------------- tools --- */
    if (path === '/tools' && method === 'GET') {
      const category = parsed.searchParams.get('category');
      let rows = db.tools.filter(t => !t.is_archived);
      if (category) rows = rows.filter(t => t.category === category);
      // The list a caller sees is scoped to the community it asks for, within
      // radius_m of that community's centre — this is what makes browsing a
      // different postcode return a different set of tools.
      const cid = parsed.searchParams.get('community_id');
      if (cid) {
        const target = registry.get(cid);
        if (!target) return fail(404, 'NOT_FOUND', 'Community not found.');
        const radius = Number(parsed.searchParams.get('radius_m') || 2000);
        rows = rows.filter(t => haversineMeters(target, registry.get(t.community_id) || community) <= radius);
      }
      const limit = Number(parsed.searchParams.get('limit') || 20);
      return ok(rows.slice(0, limit).map(toolView), { limit, offset: 0, total: rows.length });
    }
    if (path === '/tools' && method === 'POST') {
      const fp = JSON.stringify([method, path, body]);
      const entry = idempotent(init, viewer, fp);
      if (entry.body) return entry;
      if (!body || !body.name || !body.category) return fail(422, 'VALIDATION_ERROR', 'Request validation failed.', { fields: [{ field: 'name', message: 'field required' }] });
      if (String(body.name).length > 80 || String(body.description || '').length > 500) {
        return fail(422, 'VALIDATION_ERROR', 'Request validation failed.', { fields: [{ field: 'name', message: 'string too long' }] });
      }
      if (!TOOL_CATEGORIES.includes(body.category)) {
        return fail(422, 'VALIDATION_ERROR', 'Request validation failed.', { fields: [{ field: 'category', message: `unexpected value; permitted: ${TOOL_CATEGORIES.join(', ')}` }] });
      }
      const tool = {
        id: newId('t'), name: body.name.slice(0, 80), category: body.category,
        description: (body.description || '').slice(0, 500), owner_alias: viewer.alias,
        community_id: users[viewer.alias].community_id,
        availability: 'available', is_archived: false, created_at: now(), updated_at: now()
      };
      db.tools.unshift(tool);
      return rememberIdem(entry, created(toolView(tool)));
    }
    m = path.match(/^\/tools\/([^/]+)\/archive$/);
    if (m && method === 'POST') {
      const fp = JSON.stringify([method, path, body]);
      const entry = idempotent(init, viewer, fp);
      if (entry.body) return entry;
      const tool = db.tools.find(t => t.id === m[1]);
      if (!tool) return fail(404, 'NOT_FOUND', 'Tool not found.');
      if (tool.owner_alias !== viewer.alias) return fail(403, 'FORBIDDEN', 'Only the owner can archive a tool.');
      if (db.loans.some(l => l.tool_id === tool.id && ACTIVE.includes(l.status))) return fail(409, 'ACTIVE_LOAN_EXISTS', 'This tool has an active loan.');
      tool.is_archived = true; tool.availability = 'archived'; tool.updated_at = now();
      return rememberIdem(entry, ok(toolView(tool)));
    }
    m = path.match(/^\/tools\/([^/]+)$/);
    if (m && method === 'GET') {
      const tool = db.tools.find(t => t.id === m[1]);
      if (!tool) return fail(404, 'NOT_FOUND', 'Tool not found.');
      return ok(toolView(tool));
    }

    /* ----------------------------------------------------------- loans --- */
    if (path === '/loans' && method === 'GET') {
      const role = parsed.searchParams.get('role') || 'borrower';
      const status = parsed.searchParams.get('status');
      let rows = db.loans.filter(l => role === 'owner' ? l.owner_id === viewer.id : l.borrower_id === viewer.id);
      if (status) rows = rows.filter(l => l.status === status);
      rows = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return ok(rows.map(loanView), { limit: 100, offset: 0, total: rows.length });
    }
    if (path === '/loans' && method === 'POST') {
      const fp = JSON.stringify([method, path, body]);
      const entry = idempotent(init, viewer, fp);
      if (entry.body) return entry;
      const tool = db.tools.find(t => t.id === (body && body.tool_id));
      if (!tool) return fail(404, 'NOT_FOUND', 'Tool not found.');
      if (tool.owner_alias === viewer.alias) return fail(403, 'SELF_BORROW_FORBIDDEN', 'You cannot borrow your own tool.');
      if (tool.is_archived) return fail(409, 'TOOL_ARCHIVED', 'This tool has been archived.');
      if (tool.availability !== 'available') return fail(409, 'TOOL_UNAVAILABLE', 'This tool is already reserved or on loan.');
      let task = null;
      if (body && body.requirement_id) {
        task = db.tasks.find(t => t.requirements.some(r => r.id === body.requirement_id));
        if (!task) return fail(404, 'NOT_FOUND', 'Requirement not found.');
        const occupied = db.loans.some(l => l.requirement_id === body.requirement_id && ACTIVE.includes(l.status));
        if (occupied) return fail(409, 'REQUIREMENT_OCCUPIED', 'That requirement already has an active loan.');
      }
      const loan = {
        id: newId('l'), tool_id: tool.id, tool_name: tool.name,
        owner_id: users[tool.owner_alias].id, borrower_id: viewer.id,
        requirement_id: (body && body.requirement_id) || null,
        task_id: task ? task.id : null, status: 'pending',
        note: (body && body.note) || '', created_at: now(), updated_at: now(),
        accepted_at: null, handed_over_at: null, returned_at: null, rejected_at: null, cancelled_at: null
      };
      db.loans.push(loan);
      tool.availability = 'reserved';
      db.events.push({ id: newId('e'), loan_id: loan.id, actor_id: viewer.id, action: 'create', from_status: null, to_status: 'pending', created_at: now() });
      return rememberIdem(entry, created(loanView(loan)));
    }
    m = path.match(/^\/loans\/([^/]+)\/(accept|reject|cancel|hand-over|return)$/);
    if (m && method === 'POST') {
      const fp = JSON.stringify([method, path, body]);
      const entry = idempotent(init, viewer, fp);
      if (entry.body) return entry;
      const loan = db.loans.find(l => l.id === m[1]);
      if (!loan) return fail(404, 'NOT_FOUND', 'Loan not found.');
      if (loan.owner_id !== viewer.id && loan.borrower_id !== viewer.id) return fail(404, 'NOT_FOUND', 'Loan not found.');
      return rememberIdem(entry, transition(loan, m[2], viewer));
    }
    m = path.match(/^\/loans\/([^/]+)$/);
    if (m && method === 'GET') {
      const loan = db.loans.find(l => l.id === m[1]);
      if (!loan || (loan.owner_id !== viewer.id && loan.borrower_id !== viewer.id)) return fail(404, 'NOT_FOUND', 'Loan not found.');
      return ok(loanView(loan));
    }
    m = path.match(/^\/loans\/([^/]+)\/events$/);
    if (m && method === 'GET') {
      const loan = db.loans.find(l => l.id === m[1]);
      if (!loan || (loan.owner_id !== viewer.id && loan.borrower_id !== viewer.id)) return fail(404, 'NOT_FOUND', 'Loan not found.');
      const rows = db.events.filter(e => e.loan_id === loan.id);
      return ok(rows, { limit: 20, offset: 0, total: rows.length });
    }

    /* ------------------------------------------------------- community --- */
    if (path === '/communities/resolve' && method === 'GET') {
      const value = (parsed.searchParams.get('postcode') || '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (!/^(GIR 0AA|[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2})$/.test(value)) return fail(422, 'INVALID_POSTCODE', 'That postcode could not be resolved.');
      let found = communities.find(c => c.postcode === value);
      if (!found) {
        // Any other valid UK postcode resolves to its own (fixture) community,
        // like postcodes.io would — never silently to the caller's home.
        const outcode = value.split(' ')[0];
        found = {
          id: 'c-' + outcode.toLowerCase(), postcode: value, outcode,
          latitude: 55.9000, longitude: -3.2500, country: 'Scotland',
          source: 'fixture', source_kind: 'fixture', fetched_at: now()
        };
        registry.set(found.id, found);
      }
      return ok(Object.assign({}, found));
    }
    m = path.match(/^\/communities\/([^/]+)\/environment$/);
    if (m && method === 'GET') {
      const target = registry.get(m[1]);
      if (!target) return fail(404, 'NOT_FOUND', 'Community not found.');
      return ok(environmentPayload(target));
    }
    m = path.match(/^\/communities\/([^/]+)\/impact$/);
    if (m && method === 'GET') {
      if (m[1] !== community.id) return fail(404, 'NOT_FOUND', 'Community not found.');
      return ok(impactPayload());
    }

    return fail(404, 'NOT_FOUND', `No route for ${method} ${path}.`);
  }

  let inflight = 0;
  async function fetchImpl(url, init) {
    inflight += 1;
    let result;
    try {
      result = await handle(url, init || {});
    } finally {
      inflight -= 1;
    }
    const key = header(init || {}, 'idempotency-key');
    calls.push({ method: (init && init.method) || 'GET', path: url, key, status: result.status });
    if (((init && init.method) || 'GET').toUpperCase() !== 'GET') writes.push({ path: url, key, status: result.status });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => JSON.stringify(result.body)
    };
  }

  return {
    fetch: fetchImpl,
    db, calls, writes, sessions, community, otherCommunity, registry,
    users,
    /** Invalidate every session so the next authenticated call is a 401. */
    expireSessions() { sessions.forEach(s => { s.valid = false; }); },
    get inflight() { return inflight; }
  };
}

/* ------------------------------------------------------------ DOM harness */
function classList() {
  const set = new Set();
  return {
    add: c => set.add(c),
    remove: c => set.delete(c),
    contains: c => set.has(c),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
    values: () => [...set]
  };
}

function matchesSelector(el, sel) {
  sel = String(sel).trim();
  let m;
  if ((m = sel.match(/^button\[type="([^"]+)"\]$/))) return (el.type || '').toLowerCase() === m[1].toLowerCase();
  if ((m = sel.match(/^\[data-([\w-]+)\]$/))) return !!(el.dataset && Object.prototype.hasOwnProperty.call(el.dataset, m[1]));
  if ((m = sel.match(/^\[data-([\w-]+)="([^"]*)"\]$/))) return !!(el.dataset && el.dataset[m[1]] === m[2]);
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  return false;
}

function createApp(options) {
  options = options || {};
  const elements = new Map();
  const listeners = {};
  const stored = new Map(Object.entries(options.storage || {}));
  const server = options.server || createMockBackend(options.backend || {});

  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        selector, innerHTML: '', textContent: '', value: '', checked: false, type: '', id: '',
        disabled: false, open: false, resetCount: 0,
        classList: classList(),
        setAttribute() {}, removeAttribute() {}, focus() {},
        showModal() { this.open = true; }, close() { this.open = false; },
        reset() { this.resetCount += 1; }
      });
    }
    return elements.get(selector);
  }

  function node(props) {
    return Object.assign({
      id: '', type: '', dataset: {}, value: '', checked: false, textContent: '', innerHTML: '',
      classList: classList(),
      setAttribute() {}, removeAttribute() {}, focus() {},
      matches(sel) { return matchesSelector(this, sel); },
      closest(sel) { return sel === 'button' || sel === 'dialog' ? this : this; },
      querySelector() { return null; },
      showModal() { this.open = true; }, close() { this.open = false; }, open: false,
      reset() {}
    }, props || {});
  }

  function fire(type, props) {
    const target = node(props);
    const event = { target, preventDefault() {} };
    (listeners[type] || []).slice().forEach(fn => fn(event));
    return target;
  }

  const sandbox = {
    console,
    URL,
    FormData: class FormDataStub {
      constructor(form) { this.fields = (form && form._fields) || {}; }
      get(name) { return this.fields[name]; }
    },
    location: { hash: '#community', href: 'http://localhost:5173' },
    crypto: require('node:crypto').webcrypto,
    localStorage: {
      getItem: k => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
      removeItem: k => stored.delete(k)
    },
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: server.fetch,
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }
    },
    window: {
      BND_INTEGRATIONS: options.integrations || {},
      BND_API_BASE: 'http://mock.api.test',
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      scrollTo() {}
    }
  };
  const context = vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/task-module.js'), 'utf8'), context);
  if (!context.BND_TASK) throw new Error('web/task-module.js did not publish BND_TASK');
  context.window.BND_TASK = context.BND_TASK;

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/map-module.js'), 'utf8'), context);
  if (!context.BND_MAP) throw new Error('web/map-module.js did not publish BND_MAP');
  context.window.BND_MAP = context.BND_MAP;

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/api.js'), 'utf8'), context);
  if (!context.BND_API) throw new Error('web/api.js did not publish BND_API');
  context.window.BND_API = context.BND_API;

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8'), context);

  /** Let every pending request + continuation run (mock I/O uses setImmediate). */
  async function flush(rounds) {
    const n = rounds || 40;
    for (let i = 0; i < n; i += 1) await new Promise(resolve => setImmediate(resolve));
  }

  return {
    run: source => vm.runInContext(source, context),
    element,
    stored,
    server,
    tokenKey: TOKEN_KEY,
    userKey: USER_KEY,
    flush,
    click: props => fire('click', props),
    change: props => fire('change', props),
    input: props => fire('input', props),
    submit: (selector, fields) => fire('submit', { id: String(selector).replace('#', ''), _fields: fields }),
    html: () => element('#main').innerHTML
  };
}

module.exports = { createApp, createMockBackend, TOKEN_KEY, USER_KEY };
