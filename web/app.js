/* Member A: UI shell + data layer.
   Data comes from member B's API through web/api.js — this file holds no
   business data of its own. localStorage/sessionStorage only ever store the
   bearer token and the signed-in display name; tools, loans and tasks live on
   the server and are re-fetched after every successful write.
   Member D's pure functions (window.BND_TASK) do the display maths, and they
   consume the same frozen B shapes the API returns (TaskResponse /
   ToolResponse / LoanResponse). */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* Member D's task module owns templates, tool matching and impact. Loaded first. */
const D = window.BND_TASK || globalThis.BND_TASK;
if (!D) throw new Error('web/task-module.js must be loaded before app.js');
const M = window.BND_MAP || globalThis.BND_MAP;
if (!M) throw new Error('web/map-module.js must be loaded before app.js');
const API = window.BND_API || globalThis.BND_API;
if (!API) throw new Error('web/api.js must be loaded before app.js');
const client = API.createClient({ baseUrl: window.BND_API_BASE || globalThis.BND_API_BASE });

/* ---------------------------------------------------------------- vocabulary */
/* B's frozen category slugs drive everything; SVG_KEY only picks the artwork. */
const SVG_KEY = { litter_picker: 'picker', reusable_gloves: 'gloves', hand_trowel: 'spade', watering_can: 'watering' };
const LOAN_PILL = {
  pending: 'Awaiting owner confirmation', accepted: 'Reservation confirmed · not handed over',
  on_loan: 'On loan · handover confirmed', returned: 'Returned · ready to share again',
  rejected: 'Request declined', cancelled: 'Request cancelled'
};
const TRANSITION_TOAST = {
  accept: 'Reservation accepted. Confirm handover when the tool is collected.',
  reject: 'Request declined. The tool is available again.',
  cancel: 'Request cancelled.',
  'hand-over': 'Handover recorded. The tool is now on loan.',
  return: 'Return confirmed. Ready to help another neighbour.'
};

/* ------------------------------------------------------------- session only */
const TOKEN_KEY = 'bnd.token';
const USER_KEY = 'bnd.user';
const readStore = k => { try { return localStorage.getItem(k); } catch { return null; } };
const writeStore = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const dropStore = k => { try { localStorage.removeItem(k); } catch { /* private mode */ } };

let token = readStore(TOKEN_KEY);
if (token) client.setToken(token);

function freshState() {
  return {
    me: null, templates: [], tools: [], tasks: [], loans: [],
    environment: null, impact: null, names: {},
    /* Browse context: null = looking at my own (home) community; otherwise the
       community resolved from the postcode the visitor typed. Only the
       community home page follows it — tasks and loans stay on the account. */
    browse: null, browseTools: null, browseEnvironment: null
  };
}
let state = freshState();
let ui = { filter: 'all', search: '', loanTab: 'borrowed', selectedTaskId: null, selectedPlaceId: null, selectedPlaceCommunityId: null, busy: false, loading: false, message: '' };
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5200); }

/* ---------------------------------------------------------------- helpers */
function buildNames() {
  const names = {};
  const add = (id, name) => { if (id && name) names[id] = name; };
  if (state.me) add(state.me.id, state.me.display_name);
  state.tools.forEach(t => add(t.owner.id, t.owner.display_name));
  (state.browseTools || []).forEach(t => add(t.owner.id, t.owner.display_name));
  state.tasks.forEach(t => add(t.creator.id, t.creator.display_name));
  state.names = names;
}
const nameOf = id => (state.me && state.me.id === id && state.me.display_name) || state.names[id] || 'A neighbour';
const soft = promise => promise.catch(err => { if (err && err.code === 'UNAUTHENTICATED') throw err; return null; });
const groupOf = category => (D.CATEGORIES[category] || {}).group || '';

/* ------------------------------------------------------------------- loading */
async function loadAll() {
  state.me = await client.me();
  await refresh();
}
async function refresh() {
  const me = state.me;
  const cid = me.community.id;
  const [templates, tools, mine, community, borrower, owner, environment, impact] = await Promise.all([
    client.taskTemplates(),
    client.listTools({ community_id: cid, radius_m: 2000, limit: 100 }),
    client.listTasks({ scope: 'mine', limit: 20 }),
    soft(client.listTasks({ scope: 'community', community_id: cid, limit: 10 })),
    client.listLoans({ role: 'borrower', limit: 100 }),
    client.listLoans({ role: 'owner', limit: 100 }),
    soft(client.communityEnvironment(cid)),
    soft(client.communityImpact(cid))
  ]);
  // Task summaries carry no requirements, so read the details we render.
  const ids = [...new Set([...mine, ...(community || [])].map(t => t.id))].slice(0, 12);
  const details = await Promise.all(ids.map(id => client.getTask(id).catch(err => { if (err && err.code === 'UNAUTHENTICATED') throw err; return null; })));

  state.templates = templates;
  state.tools = tools;
  state.tasks = details.filter(Boolean);
  const seen = new Set();
  state.loans = [...borrower, ...owner].filter(l => !seen.has(l.id) && seen.add(l.id));
  state.environment = environment;
  state.impact = impact;
  buildNames();
  await refreshBrowse();
}

/** While browsing another postcode, keep that community's environment card and
 *  tool list in step with the home data refreshed above. Failures keep the
 *  previous paint rather than blanking the page. */
async function refreshBrowse() {
  if (!state.browse) return;
  const bid = state.browse.id;
  const [environment, tools] = await Promise.all([
    soft(client.communityEnvironment(bid)),
    soft(client.listTools({ community_id: bid, radius_m: 2000, limit: 100 }))
  ]);
  if (state.browse && state.browse.id === bid) {
    if (environment) state.browseEnvironment = environment;
    if (tools) state.browseTools = tools;
    buildNames();
  }
}

/* ------------------------------------------------------------------ geometry */
function toolSVG(category){const content={
 spade:'<path d="M81 13v20" stroke="#bd8b56" stroke-width="13"/><path d="M66 8q15-12 30 0v16H66Z" fill="none" stroke="#52684c" stroke-width="7"/><path d="M72 34v34h19V34" fill="#bc8c54"/><path d="M64 64h35l-2 27q-16 26-31 0Z" fill="#9ba693"/><path d="M80 69v33" stroke="#cbd1c1" stroke-width="2"/>',
 gloves:'<g transform="rotate(-16 60 65)"><path d="M29 104V67l-10-16q-2-8 6-8l13 12V26q0-10 8-6v30-36q4-8 10-1v36-31q7-8 10 1v33-25q8-6 10 3v54l-8 20Z" fill="#caad73"/><path d="M28 88h43v22H28Z" fill="#6f805d"/><path d="M37 63h30" stroke="#e1c994" stroke-width="3"/></g><g transform="translate(48 0) rotate(13 60 65)"><path d="M29 104V67l-10-16q-2-8 6-8l13 12V26q0-10 8-6v30-36q4-8 10-1v36-31q7-8 10 1v33-25q8-6 10 3v54l-8 20Z" fill="#dfc08a"/><path d="M28 88h43v22H28Z" fill="#8d9a70"/></g>',
 watering:'<path d="M96 49q43-46 45-6t-37 35" fill="none" stroke="#6e8c78" stroke-width="8"/><path d="M43 66 19 46 9 52 46 90" fill="#7f9d88"/><path d="m12 45-9 7" stroke="#496d59" stroke-width="8"/><path d="M45 46h56l10 55q-34 15-68 0Z" fill="#75977e"/><ellipse cx="73" cy="46" rx="28" ry="7" fill="#547a62"/><path d="M62 62v30" stroke="#a6bca3" stroke-width="4" stroke-linecap="round"/>',
 rake:'<path d="M78 11v78" stroke="#ba9165" stroke-width="7"/><path d="m77 84-35 17m35-17 35 17" stroke="#697958" stroke-width="4"/><path d="M37 102h82M39 102v15m13-15v15m13-15v15m13-15v15m13-15v15m13-15v15m13-15v15" stroke="#738366" stroke-width="4"/>',
 picker:'<path d="m94 15-39 82" stroke="#a5ada0" stroke-width="6"/><path d="m83 23 9-18 15 8-9 20" fill="#718753"/><path d="m55 82-17 13 2 15m15-28 1 20-10 12" fill="none" stroke="#526749" stroke-width="7"/>'};return `<svg viewBox="0 0 160 130" aria-hidden="true"><ellipse cx="80" cy="116" rx="44" ry="5" fill="#243827" opacity=".07"/><g transform="rotate(15 80 65)">${content[category]||content.spade}</g></svg>`;}
function gardenArt(){return `<svg viewBox="0 0 560 385" role="img" aria-label="Illustration of neighbours sharing tools and tending a community garden"><defs><pattern id="grain" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".5" fill="#627e55" opacity=".15"/></pattern></defs><path d="M20 370V136Q20 12 144 12h282q116 0 116 126v232Z" fill="#e8eddd"/><circle cx="428" cy="76" r="29" fill="#eee6b5"/><path d="M20 265q91-56 169-18t169-3 184 20v106H20Z" fill="#d4debc"/><path d="M152 236V125l62-47 62 47v117" fill="#efe6ce"/><path d="m138 132 76-60 77 60" fill="none" stroke="#9aa78a" stroke-width="10"/><path d="M184 168h23v29h-23zm48 0h23v29h-23z" fill="#bccab3"/><path d="M219 209h25v34h-25z" fill="#8f9e7d"/><path d="M294 243V152l53-37 52 37v91" fill="#d6ddcc"/><path d="m284 157 63-47 62 47" stroke="#819772" stroke-width="8" fill="none"/><path d="M312 176h22v27h-22zm47 0h22v27h-22z" fill="#f6f3da"/><path d="M91 276V157M74 192q-30-12-23-47 30 2 37 32m4 40q42-4 43-37-34-4-42 18" stroke="#7e9663" stroke-width="7" fill="#a6b984"/><path d="M461 265V157m1 52q-39-10-37-39 31-3 37 25m1-8q32-5 36-30-25-9-35 14" stroke="#799368" stroke-width="6" fill="#95ad78"/><path d="M94 304 254 278l133 49-160 33Z" fill="#ab8663"/><path d="m94 304 133 44 160-30v22l-160 32-133-44Z" fill="#c09a73"/><path d="m107 304 147-16 105 34-132 24Z" fill="#6e7951"/><g stroke="#a6bd77" stroke-width="4"><path d="M154 317v-27m-1 20-13-10m15 4 12-17M196 329v-31m-1 17-14-10m16 2 13-14M245 330v-24m0 11-11-12m12 8 12-16M293 324v-24m0 8 12-13"/></g><g><path d="m334 265-8 56m33-59 12 54" stroke="#455d47" stroke-width="15" stroke-linecap="round"/><path d="m322 316-13 5m64-5 12 3" stroke="#d2ae78" stroke-width="12" stroke-linecap="round"/><path d="M323 214q23-14 40 3l4 56h-48Z" fill="#d1a15f"/><path d="m325 229-24 32-21-6m79-27 19 26" fill="none" stroke="#d1a15f" stroke-width="13" stroke-linecap="round"/><circle cx="342" cy="195" r="17" fill="#d7ab82"/><path d="M326 190q0-24 23-14l11 16-10-3-17-7" fill="#554c37"/><path d="m366 257 13 2 8 19-25 5-4-17Z" fill="#8b9b68"/></g><g><path d="m204 263-16 44m42-43 6 27" stroke="#708671" stroke-width="14" stroke-linecap="round"/><path d="m180 307 14 1m42-17 13 4" stroke="#62543e" stroke-width="10" stroke-linecap="round"/><path d="M207 205q20-6 28 12l6 51-39 1Z" fill="#8b9b71"/><path d="m231 223 25 27 30 5" stroke="#8b9b71" stroke-width="12" fill="none" stroke-linecap="round"/><circle cx="218" cy="188" r="16" fill="#bc865e"/><path d="M201 193q-11-29 18-28 20 0 16 25l-14-16-18 21Z" fill="#444e36"/><path d="m207 229-22 20" stroke="#8b9b71" stroke-width="12" stroke-linecap="round"/></g><g fill="#f4f4e0"><path d="m67 291 4-12 4 12 12 4-12 4-4 12-4-12-12-4Z"/><path d="m409 280 3-8 3 8 8 3-8 3-3 8-3-8-8-3Z"/></g><rect x="20" y="12" width="522" height="358" rx="100" fill="url(#grain)"/><path d="m405 97 8 4 7-5m-285 2 8 3 6-5" fill="none" stroke="#a5b197" stroke-width="2"/></svg>`;}

function slot(name, placeholder){const raw=window.BND_INTEGRATIONS?.[name];if(!raw)return placeholder;try{const url=new URL(raw,location.href);if(!['http:','https:'].includes(url.protocol))throw Error();return `<iframe class="embed" title="${esc(name)} module" src="${esc(url.href)}" sandbox="allow-scripts allow-forms allow-popups" loading="lazy" referrerpolicy="no-referrer"></iframe>`;}catch{return `<p class="notice">The ${esc(name)} embed URL is invalid.</p>`;}}

/* ------------------------------------------------------------------ routing */
function page(){return ['community','task','loans'].includes(location.hash.slice(1))?location.hash.slice(1):'community';}
/* The signed-in account's own community — what tasks, loans and lending use. */
const homeCommunity = () => (state.me ? state.me.community : null);
const homePostcode = () => (state.me ? state.me.community.postcode : '');
const homeOutcode = () => (state.me ? state.me.community.outcode : '');
/* What the community home page is showing: the browsed postcode's community,
   or the account's own when nothing has been checked. */
const currentCommunity = () => state.browse || homeCommunity();
const postcode = () => { const c = currentCommunity(); return c ? c.postcode : ''; };
const visibleTools = () => (state.browse ? (state.browseTools || []) : state.tools);
const visibleEnvironment = () => (state.browse ? state.browseEnvironment : state.environment);
const myTasks = () => state.tasks.filter(t => state.me && t.creator && t.creator.id === state.me.id);
const myOpenTask = () => myTasks().find(t => t.status === 'open' && t.id === ui.selectedTaskId) || myTasks().filter(t => t.status === 'open')
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
function taskContext(task) {
  return {
    tools: state.tools, loans: state.loans, names: state.names,
    viewerId: state.me ? state.me.id : null, task,
    nearbyPostcodes: state.me ? [state.me.community.postcode, state.me.community.outcode] : []
  };
}

/* ------------------------------------------------------------ login / boot */
function loginView(message) {
  return `<div class="login-shell"><section class="panel login-panel">
  <span class="eyebrow">DEMO ACCOUNTS</span>
  <h2>Sign in to your street.</h2>
  <p class="muted">Borrow Next Door runs in demo mode against the local API. Pick a demo account and sign in — no access code, no real registrations.</p>
  <form id="login-form">
    <label>Account<select name="user_alias"><option value="alice">Alice · demo account</option><option value="bob">Bob · demo account</option><option value="carol">Carol · demo account</option></select></label>
    <p class="field-message ${message ? 'error' : ''}" id="login-message">${esc(message || 'Demo accounts only — no real registrations.')}</p>
    <button class="btn primary" type="submit">Sign in <span>↗</span></button>
  </form>
  <p class="notice">The backend defaults to <code>http://127.0.0.1:8000</code> (override with <code>window.BND_API_BASE</code>).</p>
</section></div>`;
}
function renderLogin(message) {
  $('#main').innerHTML = loginView(message);
  document.querySelectorAll('[data-nav]').forEach(el => { el.classList.remove('active'); el.removeAttribute('aria-current'); });
  const lc = $('#loan-count'); if (lc) lc.textContent = '0';
  const av = $('#avatar'); if (av) av.textContent = '?';
  const who = $('#whoami'); if (who) who.textContent = 'Not signed in';
}
function loadingView() {
  return `<div class="empty"><h3>Loading your neighbourhood…</h3><p>Fetching your tools, actions and loans from the Borrow Next Door API.</p></div>`;
}
function bootErrorView(message) {
  return `<div class="login-shell"><section class="panel login-panel"><span class="eyebrow">CONNECTION</span>
  <h2>We cannot reach the API.</h2><p class="field-message error">${esc(message)}</p>
  <p class="muted">Start the backend, then try again:</p>
  <p class="notice"><code>backend/.venv/bin/uvicorn app.main:app --port 8000</code></p>
  <button class="btn primary" id="retry-boot">Try again <span>↗</span></button></section></div>`;
}
function setLoginMessage(message) {
  const el = $('#login-message');
  if (el && $('#login-form')) { el.textContent = message; el.classList.add('error'); }
  else renderLogin(message);
}
function clearSession() {
  ui.selectedTaskId = null;
  ui.selectedPlaceId = null; ui.selectedPlaceCommunityId = null;
  dropStore(TOKEN_KEY); dropStore(USER_KEY);
  token = null; client.setToken(null);
}
async function boot() {
  if (!token) { renderLogin(ui.message); return; }
  ui.loading = true;
  $('#main').innerHTML = loadingView();
  try {
    await loadAll();
    ui.loading = false; ui.message = '';
    render();
  } catch (err) {
    ui.loading = false;
    if (err && err.code === 'UNAUTHENTICATED') {
      clearSession(); state = freshState();
      renderLogin('Your session expired. Please sign in again.');
    } else {
      $('#main').innerHTML = bootErrorView(err && err.message ? err.message : 'Unexpected error.');
    }
  }
}

/* --------------------------------------------------------------- busy wrapper */
function setButtonsDisabled(off) { document.querySelectorAll('button').forEach(b => { b.disabled = off; }); }
function handleError(err, opts) {
  // A 401 while signing in means "unknown demo account", not "expired
  // session" — the caller opts out of the session-clearing path with
  // { ignoreAuth: true } and shows its own message instead.
  if (err && err.code === 'UNAUTHENTICATED' && !(opts && opts.ignoreAuth)) {
    clearSession(); state = freshState();
    renderLogin('Your session has expired. Please sign in again.');
    return;
  }
  const FRIENDLY = {
    OUT_OF_RANGE: 'That tool is in another neighbourhood. Borrowing works within 2 km — browsing is fine.',
    TOOL_UNAVAILABLE: 'This tool is already reserved or on loan.',
    TOOL_ARCHIVED: 'That tool is no longer listed.',
    SELF_BORROW_FORBIDDEN: 'That is your own tool — a neighbour has to borrow it.',
    REQUIREMENT_OCCUPIED: 'Another request already covers that slot.',
    REQUIREMENT_LOCKED: 'That slot is locked (already requested or used).',
    FORBIDDEN: 'You do not have permission for that action.'
  };
  if (opts && typeof opts.onError === 'function') opts.onError(err);
  const code = err && err.code;
  const verbatim = err && err.status === 422 && opts && opts.verbatim422;
  toast((verbatim ? err.message : code && FRIENDLY[code]) || (err && err.message) || 'Something went wrong. Please try again.');
}
/** Disable everything, run one user intent, surface server errors, then repaint
 *  only on success — so a failed form keeps what the user typed. */
async function action(btn, work, opts) {
  if (ui.busy) return;
  ui.busy = true;
  const label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  setButtonsDisabled(true);
  try {
    await work();
  } catch (err) {
    handleError(err, opts);
  } finally {
    ui.busy = false;
    setButtonsDisabled(false);
    if (btn) { btn.disabled = false; if (label !== null) btn.textContent = label; }
  }
}

/* ------------------------------------------------------------------ community */
function provider(env, key) {
  if (!env) return null;
  if (env.providers && env.providers[key]) return env.providers[key];
  return env[key] || null;
}
const ENV_READING = {
  air_quality: { field: 'aqi', unit: 'AQI', scope: 'Regional forecast (~11km grid)' },
  carbon_intensity: { field: 'clean_energy_percentage', unit: '% clean electricity', scope: 'Regional grid zone' }
};
function envCard(icon, title, providerKey, source) {
  const p = provider(visibleEnvironment(), providerKey);
  const spec = ENV_READING[providerKey] || { field: null, unit: '', scope: '' };
  const ok = isFreshProvider(p);
  const value = ok && p.data && spec.field ? finiteNumber(p.data[spec.field]) : null;
  let headline, detail, tag, subline;
  if (value !== null) {
    headline = `<strong>${esc(String(value))}</strong> <span class="env-unit">${esc(spec.unit)}</span>`;
    detail = (p.data && p.data.scope) || spec.scope;
    tag = 'Connected';
    subline = p.attribution || p.source || source;
  } else if (ok) {
    headline = '<strong class="pending">—</strong>';
    detail = `${(p.data && p.data.scope) || spec.scope} · no number reported yet`;
    tag = 'Connected';
    subline = p.attribution || p.source || source;
  } else {
    headline = '<strong class="pending">—</strong>';
    detail = `${source} · awaiting provider`;
    tag = 'Not connected';
    subline = '';
  }
  const inner = `<span class="env-icon">${icon}</span><div><h3>${title}</h3>${headline}<span class="status-tag">${tag}</span><p>${esc(detail)}</p>${subline ? `<p class="env-source">${esc(subline)}</p>` : ''}</div>`;
  return `<div class="env-card">${slot(title === 'The air around you' ? 'air' : 'electricity', inner)}</div>`;
}
function listedTools() {
  return visibleTools().filter(t => t.availability !== 'archived' &&
    String(t.name || '').toLowerCase().includes(ui.search.toLowerCase()) &&
    (ui.filter === 'all' || ui.filter === 'available' && t.availability === 'available' ||
     ui.filter === 'garden' && groupOf(t.category) === 'garden' ||
     ui.filter === 'cleanup' && groupOf(t.category) === 'cleanup'));
}
function toolCards() {
  const me = state.me;
  const tools = listedTools();
  if (!tools.length) {
    const where = esc(postcode());
    return state.browse
      ? `<div class="empty"><h3>Nothing listed in ${where} yet.</h3><p>No tools match this search in ${where}. Lending still happens in your home community, ${esc(homePostcode())}.</p><button class="btn secondary" data-publish>Lend a tool at home ↗</button></div>`
      : `<div class="empty"><h3>A little room for sharing.</h3><p>No tools match this search in ${where}.</p><button class="btn secondary" data-publish>Lend the first tool ↗</button></div>`;
  }
  return tools.map(t => {
    const own = me && t.owner.id === me.id;
    const statusLabel = { available: 'Ready to share', reserved: 'Reserved', on_loan: 'Out helping', archived: 'Archived' }[t.availability] || t.availability;
    const distance = typeof t.distance_m === 'number' ? `<span class="muted"> · about ${Math.round(t.distance_m)} m away</span>` : '';
    const far = typeof t.distance_m === 'number' && t.distance_m > 2000;
    return `<article class="tool-card"><div class="tool-art ${esc(SVG_KEY[t.category] || 'spade')}">${toolSVG(SVG_KEY[t.category])}<span class="tool-status ${t.availability === 'available' ? '' : 'busy'}"><i></i>${esc(statusLabel)}</span></div><div class="tool-body"><h3>${esc(t.name)}</h3><span class="tool-owner">${esc(t.owner.display_name)}’s tool · ${esc(t.community.postcode)}${distance}</span><div class="tool-bottom"><span>Free to borrow</span><button data-borrow="${esc(t.id)}" ${t.availability !== 'available' || own || far ? 'disabled' : ''}>${own ? 'Your tool' : far ? 'Too far to borrow' : t.availability === 'available' ? 'Borrow ↗' : 'Unavailable'}</button></div></div></article>`;
  }).join('');
}
/* The line under the postcode box: plain status at home, or the browse banner
   with the way back once another postcode has been checked. */
function postcodeMessage() {
  if (state.browse) {
    return `<span>Browsing ${esc(state.browse.postcode)} (${esc(state.browse.outcode)}). Your lending home stays ${esc(homePostcode())}.</span> <button type="button" id="back-home">Back to my street</button>`;
  }
  return `<span>Your community: ${esc(homePostcode())} · served by the backend</span>`;
}
function community() {
  const me = state.me;
  const banner = state.impact;
  const shown = currentCommunity();
  const shownOutcode = esc(shown ? shown.outcode : '');
  return `<section class="hero"><div class="hero-copy"><span class="location"><i></i> Small actions. Right on your doorstep.</span><h1>A little sharing.<br>A <em>greener</em><br>neighbourhood.</h1><p>The tools you need might be just next door.<br>Borrow, lend, and make your patch a little better.</p><form class="postcode-form" id="postcode-form"><span aria-hidden="true">⌖</span><input id="postcode" aria-label="Your UK postcode" value="${esc(postcode())}" maxlength="10" required><button type="submit">Check a postcode ↗</button></form><p class="field-message" id="postcode-message">${postcodeMessage()}</p></div><div class="hero-art">${gardenArt()}<span class="art-note">Good things grow together.</span><div class="art-label"><div class="mini-avatars"><span>A</span><span>B</span><span>♡</span></span><span>Less buying. More belonging.</span></div></div></section>
<section><div class="section-heading"><div><h2>A small look at your local patch</h2><p>Environmental context for ${esc(postcode())} — reported per provider by the API.</p></div><span class="eyebrow">${state.browse ? `BROWSING ${esc(state.browse.outcode)}` : 'YOUR POSTCODE, TOGETHER'}</span></div><div class="environment">${envCard('≋','The air around you','air_quality','Open-Meteo')}${envCard('ϟ','Your regional electricity','carbon_intensity','NESO Carbon Intensity')}<div class="env-card"><span class="env-icon">♧</span><div><h3>Room to grow</h3><strong>${esc(greenspaceLabel())}</strong><p>Green spaces near ${shownOutcode}</p></div></div></div>${contextScoreCard()}</section>
<div class="workspace"><section><div class="section-heading"><div><h2>Good tools. Great neighbours.</h2><p>Something sitting in your shed could start something good.</p></div><button class="btn secondary" data-publish>＋ Lend a tool</button></div><div class="filterbar"><div class="filters">${[['all','All tools'],['garden','Gardening'],['cleanup','Clean-up'],['available','Available']].map(([v,l])=>`<button class="chip ${ui.filter===v?'active':''}" data-filter="${v}">${l}</button>`).join('')}</div><input class="search-input" id="tool-search" value="${esc(ui.search)}" placeholder="Search tools…" aria-label="Search tools"></div><div class="tool-grid" id="tool-grid">${toolCards()}</div></section><aside><div class="action-card"><span class="eyebrow">LET’S DO SOME GOOD</span><span class="flower">✳</span><h2>A greener street<br>starts with us.</h2><p>Pick a small action. Find the tools.<br>Make a difference, together.</p><a class="btn primary" href="#task">Start a community action <span>↗</span></a></div><div class="map-card" id="project-map">${projectMapCard()}</div></aside></div><div class="bottom-banner"><span>✳</span><div><strong>The more we share, the more we can do.</strong><p>${banner ? `${banner.active_tools_count} tools shared · ${banner.returned_loans_count} returned loans · ${banner.completed_tasks_count} completed actions in ${esc(me.community.outcode)}.` : 'A missing litter picker today. A whole community clean-up tomorrow.'}</p></div><button class="text-button" data-publish>Be someone’s helpful neighbour ↗</button></div>`;
}
/* ToolResponse locates a tool at its community's postcode centre. The origin
   stays the signed-in user's home even when the visible postcode changes. */
function projectMapCard() {
  const you = homeCommunity();
  const tools = listedTools()
    .filter(t => t.availability === 'available' && t.owner.id !== state.me.id)
    .map(t => ({ ...t, latitude: t.community.latitude, longitude: t.community.longitude }));
  const green = provider(visibleEnvironment(), 'greenspace');
  const greenspaces = isFreshProvider(green) && Array.isArray(green.data) ? green.data.slice(0, 5) : [];
  const plan = M.planNearestRoute(you, tools);
  const map = M.renderMapSVG({ you, tools, greenspaces, path: plan.path, nearest: plan.nearest });
  const description = plan.message === 'no_tools'
    ? 'No borrowable tools nearby yet. Lend one and the route appears.'
    : M.describeNearest(plan);
  const native = `<div class="route-map">${map}</div><p class="route-summary" role="status">${esc(description)}</p><section class="map-green-section" aria-label="Green spaces nearby"><h4>Green spaces nearby</h4>${greenSpacePanel()}</section>`;
  return `<h3>⌖ Your next little project</h3>${slot('map', native)}`;
}
function greenspaceLabel() {
  const p = provider(visibleEnvironment(), 'greenspace');
  if (p && (p.status === 'ok' || p.status === 'cached')) return p.attribution || 'Connected';
  return 'Find a green space';
}

/* ------------------------------------------- C: green spaces & context score */
/* Everything below reads only C's three environment providers (greenspace,
   air_quality, carbon_intensity). The map card shows the real places C already
   returns, and the context score is a labelled regional public-data estimate —
   it never touches D's impact panel (state.impact / impactPanel). */
function isFreshProvider(p) { return !!p && (p.status === 'ok' || p.status === 'cached'); }
function finiteNumber(v) {
  // A provider that answers with null/undefined/'' must not become 0 via
  // Number() — that would score a missing value as the best possible.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function captureLabel(iso) { return iso ? `${String(iso).slice(0, 16).replace('T', ' ')} UTC` : 'time not reported'; }

/** Honest reason a provider contributes nothing: a provider that answered but
 *  returned no value is not the same as one still being waited on. */
function providerGap(p, source, emptyReason) {
  return isFreshProvider(p) ? `${source} ${emptyReason}` : `still waiting on ${source}`;
}

/** The green-space section below the route: C's real places, nearest first,
 *  with straight-line distance and an honest degraded state that tells an
 *  empty answer apart from a source still pending. */
function greenSpacePanel() {
  const p = provider(visibleEnvironment(), 'greenspace');
  const places = isFreshProvider(p) && Array.isArray(p.data)
    ? p.data.filter(pl => pl && typeof pl.name === 'string') : [];
  if (!places.length) {
    const source = (p && (p.source || p.attribution)) || 'OpenStreetMap Overpass API';
    const detail = providerGap(p, source, 'answered with no named green spaces');
    return `<div class="map-placeholder"><span class="map-symbol">⌑</span><b>Green spaces near ${esc(currentCommunity().outcode)}</b><small>${esc(detail)}.</small></div>`;
  }
  const nearestFirst = places.slice().sort((a, b) => (finiteNumber(a.distance_km) ?? Infinity) - (finiteNumber(b.distance_km) ?? Infinity));
  const rows = nearestFirst.map(pl => {
    const km = finiteNumber(pl.distance_km);
    const distance = km === null ? 'distance pending' : `${km.toFixed(2)} km`;
    return `<li class="green-place"><span class="green-name">${esc(pl.name)}</span><span class="green-type">${esc(pl.type || 'Green space')}</span><span class="green-distance">${esc(distance)}</span></li>`;
  }).join('');
  const kind = p.source_kind === 'fixture' ? 'demo fixture' : (p.status === 'cached' || p.source_kind === 'cached' ? 'cached' : 'live');
  const when = captureLabel(p.fetched_at);
  // A fixture snapshot must never be mistaken for a live query result.
  const badge = p.source_kind === 'fixture' ? `<p class="fixture-badge">Demo fixture snapshot — sample data, not a live query. Captured ${esc(when)}.</p>` : '';
  return `${badge}<ul class="green-list">${rows}</ul><p class="green-source">${esc(p.attribution || p.source || 'Green space data')} · straight-line distance · ${esc(kind)} · ${esc(when)}</p>`;
}

/** European AQI band -> 0-30 points (the score's air-quality component). */
function aqiBandPoints(aqi) {
  if (aqi <= 20) return 30;
  if (aqi <= 40) return 23;
  if (aqi <= 60) return 15;
  if (aqi <= 80) return 8;
  return 3;
}

/** Postcode green context score, computed ONLY from C's three providers.
 *  green access 0-40 = round(40 * (0.5 * min(count_within_2km / 5, 1) +
 *                                     0.5 * (1 - min(nearest_distance_km, 2) / 2)))
 *  where count_within_2km only counts the spaces the source actually returns —
 *  the backend adapter caps that list at 5 (greenspace.MAX_RESULTS), so for
 *  live data the count term is effectively constant; the component's scope
 *  text states the cap. air quality 0-30 from the European AQI band,
 *  electricity 0-30 = round(30 * clean_energy_percentage / 100). A total
 *  appears only when all three providers answer; a missing provider is never
 *  treated as zero. */
function greenContextScore() {
  const green = provider(state.environment, 'greenspace');
  const air = provider(state.environment, 'air_quality');
  const carbon = provider(state.environment, 'carbon_intensity');
  const missing = [];

  const distances = isFreshProvider(green) && Array.isArray(green.data)
    ? green.data.map(pl => pl && finiteNumber(pl.distance_km)).filter(n => n !== null) : [];
  let greenPoints = null;
  if (distances.length) {
    const within = distances.filter(km => km <= 2).length;
    const nearest = Math.min(...distances);
    greenPoints = Math.round(40 * (0.5 * Math.min(within / 5, 1) + 0.5 * (1 - Math.min(nearest, 2) / 2)));
  } else {
    const greenSource = (green && (green.source || green.attribution)) || 'OpenStreetMap Overpass API';
    missing.push(providerGap(green, greenSource, 'answered with no named green spaces'));
  }

  const aqi = isFreshProvider(air) && air.data ? finiteNumber(air.data.aqi) : null;
  if (aqi === null) {
    const airSource = (air && (air.source || air.attribution)) || 'Open-Meteo Air Quality';
    missing.push(providerGap(air, airSource, 'did not report an air-quality index'));
  }

  const clean = isFreshProvider(carbon) && carbon.data ? finiteNumber(carbon.data.clean_energy_percentage) : null;
  if (clean === null) {
    const carbonSource = (carbon && (carbon.source || carbon.attribution)) || 'NESO Carbon Intensity API';
    missing.push(providerGap(carbon, carbonSource, 'did not report a clean-energy share'));
  }

  const components = [
    {
      key: 'greenspace', label: 'Green access', points: greenPoints, max: 40,
      source: (green && (green.source || green.attribution)) || 'OpenStreetMap Overpass API',
      scope: 'Mapped green spaces returned by the source (capped at 5) and distance to the nearest',
      fixture: !!(green && green.source_kind === 'fixture'), capturedAt: green ? captureLabel(green.fetched_at) : null
    },
    {
      key: 'air_quality', label: 'Air quality', points: aqi === null ? null : aqiBandPoints(aqi), max: 30,
      source: (air && air.data && air.data.source) || (air && air.attribution) || 'Open-Meteo Air Quality',
      scope: (air && air.data && air.data.scope) || 'Regional air-quality forecast',
      fixture: !!(air && air.source_kind === 'fixture'), capturedAt: air ? captureLabel(air.fetched_at) : null
    },
    {
      key: 'carbon_intensity', label: 'Clean electricity', points: clean === null ? null : Math.round(30 * clean / 100), max: 30,
      source: (carbon && carbon.data && carbon.data.source) || (carbon && carbon.attribution) || 'NESO Carbon Intensity API',
      scope: (carbon && carbon.data && carbon.data.scope) || 'Regional grid zone',
      fixture: !!(carbon && carbon.source_kind === 'fixture'), capturedAt: carbon ? captureLabel(carbon.fetched_at) : null
    }
  ];
  const available = components.every(c => c.points !== null);
  const value = available ? components.reduce((sum, c) => sum + c.points, 0) : null;
  return {
    available, value, components, missing,
    caveat: 'Regional public-data context for this postcode — a modelled estimate from public datasets, not a measurement of what this community’s actions have achieved.'
  };
}

function contextScoreCard() {
  const score = greenContextScore();
  const rows = score.components.map(c => {
    const points = c.points === null ? '—' : `<strong>${c.points}</strong>/${c.max}`;
    const fixtureTag = c.fixture ? `<small class="fixture-tag">Demo fixture · ${esc(c.capturedAt || 'time not reported')}</small>` : '';
    return `<li class="score-component ${c.points === null ? 'pending' : ''}"><div class="score-points">${points}</div><div class="score-detail"><b>${esc(c.label)}</b><small>${esc(c.source)}</small><small>${esc(c.scope)}</small>${fixtureTag}</div></li>`;
  }).join('');
  const total = score.available
    ? `<strong>${score.value}</strong><span>/ 100</span>`
    : '<strong class="pending">—</strong><span>/ 100</span>';
  const pendingLine = score.available ? ''
    : `<p class="score-pending">Total withheld until every source answers — ${esc(score.missing.join(' and '))}.</p>`;
  const fixtureBanner = score.components.some(c => c.fixture)
    ? '<p class="fixture-badge">Includes demo fixture data — a labelled sample snapshot, not a live query.</p>' : '';
  return `<div class="context-score" id="green-context-score"><div class="score-heading"><span class="eyebrow">REGIONAL PUBLIC-DATA CONTEXT</span><h3>Postcode green context score</h3><div class="score-total">${total}</div></div><p class="score-caveat">${esc(score.caveat)}</p>${fixtureBanner}<ul class="score-components">${rows}</ul>${pendingLine}</div>`;
}

/* ------------------------------------------------------------------ task page */
function defaultTaskPlace() {
  const c = homeCommunity();
  return { name: `Community centre · ${c.outcode}`, latitude: c.latitude, longitude: c.longitude, source: 'fixture', source_id: null };
}
function taskPlaceOptions() {
  const green = provider(visibleEnvironment(), 'greenspace');
  const places = isFreshProvider(green) && Array.isArray(green.data)
    ? green.data.filter(p => p && typeof p.name === 'string' && p.name.trim() && p.id !== null && p.id !== undefined) : [];
  return places.map(p => {
    const latitude = finiteNumber(p.latitude), longitude = finiteNumber(p.longitude);
    const valid = latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
    // Provider distance_km describes its visible postcode, not necessarily the
    // account's home. The backend always creates actions in the home community.
    const metres = valid ? M.haversineMeters(homeCommunity(), { latitude, longitude }) : Infinity;
    const reason = !valid ? 'coordinates unavailable' : metres > 2000 ? 'outside the 2 km action area' : '';
    return { id: String(p.id), type: p.type || 'Green space', distance: finiteNumber(p.distance_km), disabled: !!reason, reason,
      place: { name: p.name, latitude, longitude, source: 'osm', source_id: String(p.id) } };
  });
}
function selectedTaskPlace(options = taskPlaceOptions()) {
  const contextId = currentCommunity().id;
  const selected = ui.selectedPlaceCommunityId === contextId
    ? options.find(p => p.id === ui.selectedPlaceId && !p.disabled) : null;
  if (!selected) { ui.selectedPlaceId = null; ui.selectedPlaceCommunityId = contextId; }
  return selected ? selected.place : defaultTaskPlace();
}
function taskPlacePanel(task) {
  if (task) return `<label>Where are we helping?<input id="place-name" value="${esc(task.place.name)}" maxlength="120" readonly></label><p class="notice">Meeting point saved with the action by the backend (within 2 km of ${esc(homePostcode())}).</p>`;
  const options = taskPlaceOptions();
  const selected = selectedTaskPlace(options);
  const rows = options.map(p => `<label class="place-option"><input type="radio" name="task-place" data-task-place="${esc(p.id)}" value="${esc(p.id)}" ${selected.source === 'osm' && selected.source_id === p.id ? 'checked' : ''} ${p.disabled ? 'disabled' : ''}><span><b>${esc(p.place.name)}</b><small>${esc(p.type)} · ${p.distance === null ? 'distance pending' : `${p.distance.toFixed(2)} km · straight-line distance`}${p.reason ? ` · ${esc(p.reason)}` : ''}</small></span></label>`).join('');
  return `<fieldset class="place-panel" id="task-place-panel"><legend>Where are we helping?</legend><label class="place-option"><input type="radio" name="task-place" data-task-place="" value="" ${selected.source === 'fixture' ? 'checked' : ''}><span><b>${esc(defaultTaskPlace().name)}</b><small>Community centre · default meeting point</small></span></label>${rows}${options.length ? '' : '<small class="muted">Green spaces appear when the environment card has data</small>'}</fieldset><p class="notice">Choose a meeting point, then pick an action. Nothing is saved until you pick an action. Actions stay within 2 km of ${esc(homePostcode())}.</p>`;
}
const LOCKED_STATES = ['pending', 'confirmed', 'in_use', 'fulfilled'];
function requirementRow(row, task) {
  const own = row.loans.slice().sort((a, b) => b.stageOrder - a.stageOrder)[0];
  const viewerIsOrganiser = !!(task && state.me && task.creator && task.creator.id === state.me.id);
  const locked = task.status !== 'open' || LOCKED_STATES.includes(row.state) || !viewerIsOrganiser;
  const request = row.state === 'match_available' && row.tools.length
    ? `<button class="btn secondary small" data-borrow="${esc(row.tools[0].toolId)}" data-req="${esc(row.requirementId)}">Request from ${esc(row.tools[0].ownerName)}</button>`
    : '';
  const top = row.tools[0];
  const notes = [];
  if (top && top.distanceKm !== null && top.distanceKm !== undefined) notes.push(`about ${top.distanceKm} km away, straight line`);
  if (row.state === 'match_available' && row.tools.length > 1) notes.push(`${row.tools.length} neighbours could help`);
  const note = notes.length ? `<small class="muted">${esc(notes.join(' · '))}</small>` : '';
  const mark = row.confirmed ? '✓ ' : row.pending ? '⋯ ' : row.state === 'match_available' ? '↗ ' : '○ ';
  return `<div class="requirement state-${row.state}"><div><b>${esc(row.label)}</b><small>${mark}${esc(row.statusText)}</small>${own ? `<span class="pill">${esc(own.stageLabel)} · ${esc(own.toolName)}</span>` : ''}${note}</div><div class="req-actions">${request}<label><input type="checkbox" data-self="${esc(row.requirementId)}" ${row.selfSupplied ? 'checked' : ''} ${locked ? 'disabled' : ''}> I'll bring my own</label></div></div>`;
}
function wantedStrip(board) {
  if (!board.length) return '';
  return `<div class="wanted-strip"><span class="eyebrow">NEIGHBOURS NEEDED</span><div class="wanted-tags">${board.map(e => `<span class="chip">${esc(e.label)} · ${e.slots}</span>`).join('')}</div><small>Each of these is a slot a neighbour could fill today. Publishing one tool can unlock an action for everyone.</small></div>`;
}
function impactPanel(report) {
  const cells = report.metrics.map(m => `<div class="impact-metric ${m.available ? '' : 'pending'}"><strong>${m.available ? m.value : '—'}</strong><small>${esc(m.label)}</small><span class="status-tag">${m.available ? esc(m.basis) : 'Not collected yet'}</span></div>`).join('');
  const comm = state.impact ? `
    <div class="impact-metric"><strong>${state.impact.active_tools_count}</strong><small>Tools shared in your community</small><span class="status-tag">backend</span></div>
    <div class="impact-metric"><strong>${state.impact.returned_loans_count}</strong><small>Loans returned (all neighbours)</small><span class="status-tag">backend</span></div>
    <div class="impact-metric"><strong>${state.impact.completed_tasks_count}</strong><small>Actions recorded (all neighbours)</small><span class="status-tag">backend</span></div>` : '';
  const asOf = state.impact ? `<p class="muted">Community counters as of ${esc(state.impact.as_of)}.</p>` : '';
  return `<div class="outcomes">${cells}${comm}</div><p class="notice">${esc(report.disclaimer)}</p><p class="muted">Scope: ${esc(report.scope)}.</p>${asOf}`;
}
function taskPage() {
  const task = myOpenTask();
  // The story panel also shows the most recent finished action, so the
  // numbers the organiser typed are still readable after completion.
  const storyTask = task || myTasks().filter(t => t.status === 'completed')
    .sort((a, b) => String(b.completed_at || b.created_at).localeCompare(String(a.completed_at || a.created_at)))[0] || null;
  const ctx = task ? taskContext(task) : { tools: state.tools, loans: state.loans, names: state.names, viewerId: state.me ? state.me.id : null };
  const progress = task ? D.taskProgress(task, ctx) : null;
  const readiness = task ? D.outcomeReadiness(task, ctx) : null;
  const report = D.impactReport(state.tasks, state.loans, { communityId: state.me.community.id, tools: state.tools, names: state.names });
  const board = D.wantedBoard(state.tasks, ctx);
  const recorded = storyTask && storyTask.outcome;
  const templateButtons = state.templates.length
    ? state.templates.map(t => {
        const info = D.TEMPLATES[t.id] || {};
        return `<button class="template-option ${task && task.template_id === t.id ? 'active' : ''}" data-template="${esc(t.id)}"><span>${info.icon || '✳'}</span><strong>${esc(t.title || info.title || t.id)}</strong><small>${esc(t.description || info.blurb || '')}</small></button>`;
      }).join('')
    : `<p class="notice">No action templates came back from the backend.</p>`;
  const checklist = (task
    ? `<p class="muted">${progress.confirmed} of ${progress.total} requirements confirmed. Finding a tool is only the first step.</p><div class="progress-track"><span style="width:${progress.percent}%"></span></div><p class="muted">${esc(progress.nextAction)}</p>${progress.rows.map(row => requirementRow(row, task)).join('')}${((D.TEMPLATES[task.template_id] || {}).consumables || []).map(c => `<div class="requirement"><div><b>${esc(c.label)}</b><small>Consumable · bring your own, not part of tool loans</small></div><span>↗</span></div>`).join('')}`
    : `<p class="muted">Pick an action above. The checklist builds itself from the tools your neighbours already have.</p><div class="progress-track"><span style="width:0%"></span></div>`
  ) + wantedStrip(board);
  const story = !storyTask
    ? `<p class="muted">Choose an action first. You can record what you did once the action is under way.</p>`
    : storyTask.status === 'completed'
      ? `<p class="muted">Recorded ${esc(String(storyTask.completed_at || '').slice(0, 16).replace('T', ' '))} UTC.</p><label>Your outcome<textarea id="outcome-note" readonly>${esc(recorded ? recorded.note : '')}</textarea></label><div class="impact-fields"><label>Bags collected<input id="impact-bags" type="number" value="${recorded && recorded.bags_collected !== null ? recorded.bags_collected : ''}" readonly></label><label>Volunteer minutes<input id="impact-minutes" type="number" value="${recorded && recorded.volunteer_minutes !== null ? recorded.volunteer_minutes : ''}" readonly></label></div><p class="notice">Self-reported by the organiser. Returns are counted separately from this report.</p>`
      : `<p class="muted">Finished your action? Record what you did. A returned tool does not complete an action.</p><label>Your outcome<textarea id="outcome-note" maxlength="500" placeholder="What did you do for your neighbourhood?"></textarea></label><div class="impact-fields"><label>Bags collected<input id="impact-bags" type="number" min="0" step="1" value=""></label><label>Volunteer minutes<input id="impact-minutes" type="number" min="0" step="5" value=""></label></div>${readiness && readiness.warning ? `<p class="notice">${esc(readiness.warning)}</p>` : ''}<button class="btn primary" id="complete-task" ${readiness && !readiness.canSubmit ? 'disabled' : ''}>Record completed action ↗</button><p class="muted">Completion is self-reported by the organiser.</p>`;
  const place = taskPlacePanel(task);
  return `<div class="page-heading"><span class="eyebrow">SMALL ACTIONS, SHARED POSSIBILITIES</span><h1>Let's make something <em>good.</em></h1><p>Choose an action and bring the right tools together.</p></div><div class="task-layout"><div><section class="panel"><h2>01 / Pick your little project</h2>${place}<div class="template-options">${templateButtons}</div></section><section class="panel"><h2>02 / Bring the tools together</h2>${slot('tasks', checklist)}</section></div><aside><section class="panel"><span class="eyebrow">EVERY STEP COUNTS</span><h2 style="margin-top:15px">03 / Tell the story</h2>${story}</section><section class="panel"><h2>Little actions, adding up.</h2>${slot('outcomes', impactPanel(report))}</section></aside></div>`;
}

/* ------------------------------------------------------------------ loans page */
function loansPage() {
  const me = state.me;
  const loans = ui.loanTab === 'borrowed'
    ? state.loans.filter(l => l.borrower_id === me.id)
    : state.loans.filter(l => l.owner_id === me.id);
  const toolOf = id => state.tools.find(t => t.id === id);
  return `<div class="page-heading"><span class="eyebrow">SHARED TOOLS. SHARED TRUST.</span><h1>A little give. A little <em>borrow.</em></h1><p>Keep track of the tools making good things happen.</p></div><div class="filters">${[['borrowed','I’m borrowing'],['lent','I’m lending']].map(([v,l])=>`<button class="chip ${ui.loanTab===v?'active':''}" data-loan-tab="${v}">${l}</button>`).join('')}</div><div class="timeline"><span>01 Request sent</span>→<span>02 Reservation accepted</span>→<span>03 Handed over</span>→<span>04 Return confirmed</span></div>${loans.length ? loans.map(l => {
    const isOwner = l.owner_id === me.id;
    const tool = toolOf(l.tool_id);
    const postcodeOf = tool ? tool.community.postcode : homePostcode();
    const btn = (action, cls, label) => `<button class="btn ${cls} small" data-transition="${action}" data-id="${esc(l.id)}">${label}</button>`;
    let actions = '';
    if (l.status === 'pending') actions = isOwner
      ? btn('reject', 'secondary', 'Decline') + btn('accept', 'primary', 'Accept request')
      : btn('cancel', 'secondary', 'Cancel request');
    if (l.status === 'accepted') actions = isOwner
      ? btn('hand-over', 'primary', 'Confirm handover')
      : btn('cancel', 'secondary', 'Cancel request');
    if (l.status === 'on_loan' && isOwner) actions = btn('return', 'primary', 'Confirm returned');
    return `<article class="loan-card"><div><h3>${esc(l.tool_name)}</h3><p>${esc(nameOf(l.borrower_id))} borrowing from ${esc(nameOf(l.owner_id))} · ${esc(postcodeOf)}</p><span class="pill">${esc(LOAN_PILL[l.status] || l.status)}</span></div><div class="loan-actions">${actions}</div></article>`;
  }).join('') : `<div class="empty"><h3>${ui.loanTab === 'borrowed' ? 'Your next project starts next door.' : 'A spare tool can make someone’s day.'}</h3><p>${ui.loanTab === 'borrowed' ? 'Your borrowing requests will appear here.' : 'Requests for your tools will appear here.'}</p><a class="btn secondary" href="#community">Explore the neighbourhood ↗</a></div>`}<p class="notice">Only the tool’s owner can accept, hand over and confirm a return. Sign out and switch demo accounts to respond as your neighbour.</p>`;
}

/* -------------------------------------------------------------------- render */
function render() {
  if (!state.me) { renderLogin(ui.message); return; }
  const p = page();
  $('#main').innerHTML = ui.loading ? loadingView() : p === 'community' ? community() : p === 'task' ? taskPage() : loansPage();
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.classList.toggle('active', el.dataset.nav === p);
    if (el.dataset.nav === p) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  const active = state.loans.filter(l => ['pending', 'accepted', 'on_loan'].includes(l.status) && (l.borrower_id === state.me.id || l.owner_id === state.me.id)).length;
  const lc = $('#loan-count'); if (lc) lc.textContent = String(active);
  const av = $('#avatar'); if (av) av.textContent = (state.me.display_name || '?')[0];
  const who = $('#whoami'); if (who) who.textContent = `${state.me.display_name} · ${state.me.community.outcode}`;
}

/* ----------------------------------------------------------------- actions */
async function loginSubmit(form, btn) {
  const data = new FormData(form);
  const alias = String(data.get('user_alias') || '').trim();
  if (!alias) { setLoginMessage('Choose a demo account.'); return; }
  await action(btn, async () => {
    const session = await client.login(alias);
    token = session.access_token;
    writeStore(TOKEN_KEY, token);
    writeStore(USER_KEY, JSON.stringify({ alias: session.user.alias, display_name: session.user.display_name }));
    state = freshState();
    ui.loading = true; ui.message = '';
    $('#main').innerHTML = loadingView();
    await loadAll();
    ui.loading = false;
    render();
    toast(`Signed in as ${session.user.display_name}.`);
  }, { ignoreAuth: true, onError: err => setLoginMessage(
    err && err.code === 'UNAUTHENTICATED'
      ? 'Unknown demo account. Pick Alice, Bob or Carol.'
      : (err && err.message ? err.message : 'Sign-in failed.')
  ) });
}
async function publishSubmit(form, btn) {
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  const description = String(data.get('description') || '').trim();
  const category = String(data.get('category') || 'litter_picker');
  if (!name || !description) { toast('Add a tool name and a short description.'); return; }
  await action(btn, async () => {
    await client.createTool({ name, category, description });
    await refresh();
    $('#publish-dialog').close();
    form.reset();
    render();
    toast('Your tool is ready to help a neighbour.');
  });
}
async function postcodeSubmit(form, btn) {
  const input = $('#postcode');
  const value = String(input ? input.value : '').trim();
  if (!value) return;
  await action(btn, async () => {
    const community = await client.resolveCommunity(value);
    const home = homeCommunity();
    // Checking the postcode you already live in just returns to home context.
    if (home && community.id === home.id && community.postcode === home.postcode) {
      const wasBrowsing = !!state.browse;
      state.browse = null; state.browseTools = null; state.browseEnvironment = null;
      if (wasBrowsing) await refresh();
      render();
      toast(wasBrowsing ? `Back to your street: ${home.postcode}.` : `${home.postcode} is already your home street.`);
      return;
    }
    // Browse that community: pull ITS environment card and tool list, then
    // repaint the community home page from them.
    const [environment, tools] = await Promise.all([
      client.communityEnvironment(community.id),
      client.listTools({ community_id: community.id, radius_m: 2000, limit: 100 })
    ]);
    state.browse = community;
    state.browseEnvironment = environment;
    state.browseTools = tools;
    buildNames();
    render();
    toast(`Browsing ${community.postcode}. Your lending home stays ${homePostcode()}.`);
  }, { onError: err => {
    // 422 INVALID_POSTCODE (or a network failure): keep the message verbatim
    // under the box and leave the current browse context alone.
    const msg = $('#postcode-message');
    if (msg) { msg.textContent = err.message; msg.classList.add('error'); }
  } });
}
async function backToHome(btn) {
  await action(btn, async () => {
    state.browse = null; state.browseTools = null; state.browseEnvironment = null;
    await refresh();   // re-pull the home community's environment + tools
    render();
    toast(`Back to your street: ${homePostcode()}.`);
  });
}
async function chooseTemplate(templateId, btn) {
  if (ui.busy) return;
  const existing = myTasks().filter(t => t.status === 'open' && t.template_id === templateId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (existing) {
    ui.selectedTaskId = existing.id;
    render();
    return;
  }
  await action(btn, async () => {
    const tpl = state.templates.find(t => t.id === templateId);
    const open = myOpenTask();
    const created = await client.createTask({
      template_id: templateId,
      title: tpl ? tpl.title : templateId,
      // Template switches retain the read-only meeting point of the open action.
      place: open ? open.place : selectedTaskPlace()
    });
    ui.selectedTaskId = created.id;
    ui.selectedPlaceId = null;
    await refresh();
    render();
    toast('Action started. Now bring the tools together.');
  }, { verbatim422: true, onError: err => {
    if (err && err.status === 422) {
      ui.selectedPlaceId = null;
      render();
    }
  } });
}
async function borrow(toolId, requirementId, btn) {
  const tool = visibleTools().find(t => t.id === toolId) || state.tools.find(t => t.id === toolId);
  if (!tool || tool.availability !== 'available') { toast('This tool is no longer available to request.'); render(); return; }
  if (state.me && tool.owner.id === state.me.id) { toast('That is your own tool — a neighbour has to borrow it.'); return; }
  const tooFar = typeof tool.distance_m === 'number' && tool.distance_m > 2000;
  if (tooFar) { toast('That tool is in another neighbourhood. Borrowing works within 2 km — browsing is fine.'); return; }
  await action(btn, async () => {
    const fields = { tool_id: toolId };
    if (requirementId) fields.requirement_id = String(requirementId).split('#')[0];
    await client.createLoan(fields);
    await refresh();
    render();
    toast(`Request sent to ${nameOf(tool.owner.id)}. They need to accept it.`);
  });
}
async function transition(loanId, name, btn) {
  await action(btn, async () => {
    await client.loanAction(loanId, name);
    await refresh();
    render();
    toast(TRANSITION_TOAST[name] || 'Loan updated.');
  });
}
async function selfSupply(requirementId, checked, input) {
  const task = myOpenTask();
  if (!task) return;
  await action(null, async () => {
    await client.setSelfSupply(task.id, String(requirementId).split('#')[0], checked);
    await refresh();
    render();
    toast(checked ? 'Marked as “I’ll bring my own”.' : 'Back to borrowing from a neighbour.');
  }, { onError: () => { if (input) input.checked = !checked; } });
}
async function completeTask(btn) {
  const task = myOpenTask();
  if (!task) return;
  const readiness = D.outcomeReadiness(task, taskContext(task));
  if (!readiness.canSubmit) { toast(readiness.warning || 'This action cannot be recorded yet.'); return; }
  const noteEl = $('#outcome-note');
  const note = String(noteEl && noteEl.value || '').trim();
  if (!note) { toast('Add a short outcome before recording your action.'); if (noteEl && noteEl.focus) noteEl.focus(); return; }
  const toInt = v => { const s = String(v ?? '').trim(); return /^\d+$/.test(s) ? Number(s) : null; };
  const body = {
    outcome_note: note,
    bags_collected: toInt($('#impact-bags') && $('#impact-bags').value),
    volunteer_minutes: toInt($('#impact-minutes') && $('#impact-minutes').value)
  };
  await action(btn, async () => {
    await client.completeTask(task.id, body);
    await refresh();
    render();
    toast(readiness.warning || 'Action recorded. Returns are counted separately from this report.');
  });
}
async function signOut(btn) {
  await action(btn, async () => {
    let failure = null;
    try { await client.logout(); } catch (err) { failure = err; }
    clearSession();
    state = freshState();
    ui.message = failure && failure.code === 'NETWORK_ERROR' ? failure.message : '';
    renderLogin(ui.message);
    if (!ui.message) toast('Signed out.');
  });
}

/* ---------------------------------------------------------------- listeners */
document.addEventListener('click', e => {
  const el = e.target.closest('button');
  if (!el) return;
  if (el.matches('[data-close]')) { el.closest('dialog').close(); return; }
  if (el.matches('[data-publish]')) {
    const owner = $('#publish-owner'), pc = $('#publish-postcode');
    if (owner) owner.textContent = state.me ? nameOf(state.me.id) : '';
    if (pc) pc.textContent = homePostcode();
    const dlg = $('#publish-dialog'); if (dlg) dlg.showModal();
    return;
  }
  if (el.dataset.filter) { ui.filter = el.dataset.filter; render(); return; }
  if (el.dataset.borrow) { borrow(el.dataset.borrow, el.dataset.req, el); return; }
  if (el.dataset.transition) { transition(el.dataset.id, el.dataset.transition, el); return; }
  if (el.dataset.loanTab) { ui.loanTab = el.dataset.loanTab; render(); return; }
  if (el.dataset.template) { chooseTemplate(el.dataset.template, el); return; }
  if (el.id === 'integration-open') { const d = $('#integration-dialog'); if (d) d.showModal(); return; }
  if (el.id === 'retry-boot') { boot(); return; }
  if (el.id === 'back-home') { backToHome(el); return; }
  if (el.id === 'logout') { signOut(el); return; }
  if (el.id === 'complete-task') { completeTask(el); return; }
});
document.addEventListener('input', e => {
  if (e.target.id === 'tool-search') {
    ui.search = e.target.value;
    const grid = $('#tool-grid');
    if (grid) grid.innerHTML = toolCards();
    const map = $('#project-map');
    if (map) map.innerHTML = projectMapCard();
  }
});
document.addEventListener('change', e => {
  if (e.target.dataset && Object.prototype.hasOwnProperty.call(e.target.dataset, 'taskPlace')) {
    if (ui.busy || myOpenTask() || !e.target.checked) return;
    const id = e.target.dataset.taskPlace;
    const option = taskPlaceOptions().find(p => p.id === id && !p.disabled);
    ui.selectedPlaceId = option ? option.id : null;
    ui.selectedPlaceCommunityId = currentCommunity().id;
    render();
    return;
  }
  if (e.target.dataset && e.target.dataset.self) selfSupply(e.target.dataset.self, e.target.checked, e.target);
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const btn = e.target.querySelector ? e.target.querySelector('button[type="submit"]') : null;
  if (e.target.id === 'login-form') return loginSubmit(e.target, btn);
  if (e.target.id === 'publish-form') return publishSubmit(e.target, btn);
  if (e.target.id === 'postcode-form') return postcodeSubmit(e.target, btn);
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

boot();
