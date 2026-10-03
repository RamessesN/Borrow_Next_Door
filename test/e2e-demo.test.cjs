/* End-to-end story of the demo through A's real UI wiring.
 *
 * Everything below drives the actual web/app.js + web/api.js code inside the
 * harness's vm. The only thing replaced is the network: test/harness.cjs runs
 * a mock backend that speaks member B's contract (envelopes, Bearer tokens,
 * Idempotency-Key, frozen error codes). No real server, no network.
 *
 * Story: Bob publishes a litter picker -> Alice creates an action and asks for
 * it -> Bob accepts, hands it over, takes it back -> Alice records the outcome.
 * Error paths covered: 409 TOOL_UNAVAILABLE, 401 UNAUTHENTICATED (expired).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Demo sign-in is alias-only: no access code is asked for or sent. */
async function signIn(app, alias) {
  app.submit('#login-form', { user_alias: alias });
  await app.flush();
}
async function signOut(app) {
  app.click({ id: 'logout' });
  await app.flush();
}

test('bob lends, alice borrows: the full story through the real API client', async () => {
  const app = createApp();
  await app.flush();

  /* ---- 0. signed out: the login panel is the whole app ---- */
  assert.match(app.html(), /DEMO ACCOUNTS/, 'no token means no data, only a sign-in form');
  assert.match(app.html(), /demo account/, 'the demo accounts are named');
  assert.ok(!app.html().includes('access_code'), 'no access-code field: the demo sign-in is alias-only');
  assert.equal(app.run('state.me'), null, 'viewing the page must not invent a session');

  /* ---- 1. an unknown alias -> the server message, form untouched ---- */
  await signIn(app, 'mallory');
  assert.match(app.html(), /DEMO ACCOUNTS/, 'a failed sign-in stays on the form');
  assert.equal(app.element('#login-message').textContent, 'Unknown demo account. Pick Alice, Bob or Carol.');
  assert.equal(app.stored.has('bnd.token'), false, 'nothing is stored for a failed sign-in');

  /* ---- 2. bob signs in ---- */
  await signIn(app, 'bob');
  assert.equal(app.run('state.me.display_name'), 'Bob');
  assert.equal(app.stored.get('bnd.token'), app.run('client.token'), 'only the token is persisted');
  assert.equal(app.stored.get('bnd.user'), '{"alias":"bob","display_name":"Bob"}');
  assert.ok(!app.stored.has('bnd-demo-v1'), 'no business data is written to storage');
  assert.equal(app.run('state.tools.length'), 0);

  /* ---- 3. bob publishes the litter picker ---- */
  app.run("location.hash='#community';render()");
  app.click({ dataset: { publish: true } });
  assert.equal(app.element('#publish-dialog').open, true, 'the lend dialog opens');
  app.submit('#publish-form', {
    name: 'My long-handled litter picker', category: 'litter_picker',
    description: 'Kept in the shed, works fine.'
  });
  await app.flush();
  assert.equal(app.element('#publish-dialog').open, false, 'a successful publish closes the dialog');
  assert.equal(app.run('state.tools.length'), 1);
  assert.equal(app.run("state.tools[0].category"), 'litter_picker', 'the frozen B slug round-trips');
  assert.equal(app.run("state.tools[0].availability"), 'available');
  assert.match(app.html(), /Ready to share/);
  assert.match(app.html(), /No borrowable tools nearby yet/, 'Bob’s own tool is not a route candidate');

  /* ---- 4. sign out, alice signs in ---- */
  await signOut(app);
  assert.match(app.html(), /DEMO ACCOUNTS/);
  assert.equal(app.stored.has('bnd.token'), false, 'signing out drops the token');
  await signIn(app, 'alice');
  assert.equal(app.run('state.me.display_name'), 'Alice');
  assert.equal(app.run('state.tools.length'), 1, 'Alice sees Bob\'s tool');
  assert.match(app.html(), /class="tool-pin nearest"/, 'API ToolResponse community coordinates become a map pin');
  assert.match(app.html(), /Closest: My long-handled litter picker — about \d+ m \(estimated route\)/);
  assert.match(app.html(), /<polyline class="route"/, 'the route is rendered even when postcode centres coincide');

  /* ---- 5. alice creates the action ---- */
  app.run("location.hash='#task';render()");
  assert.match(app.html(), /Your tool checklist appears here once you pick a project/, 'the checklist explains itself before an action exists');
  assert.match(app.html(), /requirement ghost/, 'template needs are previewed as ghost rows only');
  assert.equal(app.run('state.tasks.length'), 0, 'viewing the page invents nothing');
  assert.equal(app.run("state.templates.map(t=>t.id).join(',')"), 'park_cleanup,flowerbed_care', 'templates come from the API');
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  assert.equal(app.run('state.tasks.length'), 1);
  assert.equal(app.run('state.tasks[0].status'), 'open', 'B\'s status vocabulary, no local "planning"');
  assert.equal(app.run('state.tasks[0].requirements.length'), 2, 'the template expands into two requirements');
  assert.match(app.html(), /0 of 2 requirements confirmed/);
  assert.match(app.html(), /NEIGHBOURS NEEDED/, 'the wanted board names the gap');
  assert.match(app.html(), /Reusable gloves/, 'no gloves exist yet');
  assert.match(app.html(), /Not collected yet/, 'an uncollected figure never renders as 0');

  /* ---- 6. alice asks for bob's picker, requirement by requirement ---- */
  assert.match(app.html(), /Request from Bob/);
  const toolId = app.run("state.tools.find(t=>t.category==='litter_picker').id");
  const pickerReq = app.run("state.tasks[0].requirements.find(r=>r.category==='litter_picker').id");
  app.click({ dataset: { borrow: toolId, req: pickerReq } });
  await app.flush();
  assert.equal(app.run('state.loans.length'), 1);
  assert.equal(app.run("state.loans[0].status"), 'pending');
  assert.equal(app.run("state.loans[0].requirement_id"), pickerReq, 'the request remembers its requirement');
  assert.equal(app.run("state.tools.find(t=>t.id==='" + toolId + "').availability"), 'reserved');
  assert.equal(app.run("state.tasks[0].requirements.find(r=>r.category==='litter_picker').state"), 'pending',
    'the server-derived requirement state comes back over the API');
  assert.match(app.html(), /Awaiting Bob to respond/);
  assert.match(app.html(), /0 of 2 requirements confirmed/, 'a request is not a confirmed tool');

  /* ---- 7. the server refuses a second request (409 TOOL_UNAVAILABLE) ----
     The UI re-checks availability first, so rewind the local view to what a
     stale screen would show: only the backend can catch that. */
  const loansBefore = app.run('state.loans.length');
  app.run("state.tools.find(t=>t.id==='" + toolId + "').availability='available'");
  app.click({ dataset: { borrow: toolId, req: pickerReq } });
  await app.flush();
  assert.equal(app.run('state.loans.length'), loansBefore, 'the duplicate never lands');
  assert.equal(app.element('#toast').textContent, 'This tool is already reserved or on loan.',
    'the server error message is shown verbatim');

  /* ---- 8. alice brings her own gloves ---- */
  const glovesReq = app.run("state.tasks[0].requirements.find(r=>r.category==='reusable_gloves').id");
  app.change({ dataset: { self: glovesReq }, checked: true });
  await app.flush();
  assert.equal(app.run("state.tasks[0].requirements.find(r=>r.category==='reusable_gloves').self_supplied"), true);
  assert.equal(app.run("state.tasks[0].requirements.find(r=>r.category==='reusable_gloves').state"), 'self_supplied');
  assert.match(app.html(), /1 of 2 requirements confirmed/);

  /* ---- 9. bob accepts, hands over, takes it back ---- */
  await signOut(app);
  await signIn(app, 'bob');
  app.run("location.hash='#loans';render()");
  app.click({ dataset: { loanTab: 'lent' } });
  assert.match(app.html(), /My long-handled litter picker/);
  const loanId = app.run('state.loans[0].id');
  app.click({ dataset: { transition: 'accept', id: loanId } });
  await app.flush();
  assert.equal(app.run("state.loans[0].status"), 'accepted');
  assert.equal(app.run("state.tasks.find(t=>t.template_id==='park_cleanup').requirements.find(r=>r.category==='litter_picker').state"),
    'confirmed', 'an accepted reservation confirms the requirement (server-derived)');
  assert.equal(app.run("state.tasks.find(t=>t.template_id==='park_cleanup').coordination_ready"), true);
  app.click({ dataset: { transition: 'hand-over', id: loanId } });
  await app.flush();
  assert.equal(app.run("state.loans[0].status"), 'on_loan');
  app.click({ dataset: { transition: 'return', id: loanId } });
  await app.flush();
  assert.equal(app.run("state.loans[0].status"), 'returned');
  assert.ok(app.run("state.loans[0].returned_at"), 'returned_at is stamped by the server');
  assert.equal(app.run("state.tools.find(t=>t.id==='" + toolId + "').availability"), 'available', 'shareable again');

  /* ---- 10. alice records the outcome ---- */
  await signOut(app);
  await signIn(app, 'alice');
  app.run("location.hash='#task';render()");
  assert.match(app.html(), /2 of 2 requirements confirmed/, 'a returned loan still fulfils its requirement');
  assert.equal(app.run("state.tasks[0].requirements.find(r=>r.category==='litter_picker').state"), 'fulfilled');
  assert.equal(app.run("state.tasks[0].completion_eligible"), true, 'the backend now allows completion');
  app.element('#outcome-note').value = 'Cleared litter along the path with Bob.';
  app.click({ id: 'complete-task' });
  await app.flush();
  assert.equal(app.run('state.tasks[0].status'), 'completed');
  assert.equal(app.run('state.tasks[0].outcome.note'), 'Cleared litter along the path with Bob.');
  assert.equal(app.run('state.tasks[0].outcome.bags_collected'), null, 'bags are no longer collected');
  assert.equal(app.run('state.tasks[0].outcome.volunteer_minutes'), null, 'minutes are no longer collected');
  assert.equal(app.run('state.tasks[0].outcome.verification'), 'self_reported');
  assert.match(app.html(), /Cleared litter along the path with Bob\./, 'the recorded story stays readable');

  /* the recorded story is published on the home page for the street to read */
  app.run("location.hash='#community'; render();");
  assert.match(app.html(), /Stories from the street/, 'home page carries the stories strip');
  assert.match(app.html(), /Cleared litter along the path with Bob\./, 'the story text appears on the home page');
  assert.match(app.html(), /class="story-card"/, 'stories render as cards');

  /* impact maths still comes from D's pure functions, now over API data */
  const report = JSON.parse(app.run("JSON.stringify(D.impactReport(state.tasks, state.loans, {communityId: state.me.community.id, tools: state.tools, names: state.names}))"));
  const by = Object.fromEntries(report.metrics.map(m => [m.key, m]));
  assert.equal(by.completed_loans.value, 1);
  assert.equal(by.actions_with_tools_confirmed.value, 1);
  assert.equal(by.completed_actions.value, 1);
  assert.equal(by.bags_collected.available, false, 'bags metric is honestly not-collected');
  assert.equal(by.volunteer_minutes.available, false, 'minutes metric is honestly not-collected');
  assert.match(app.html(), /backend/, 'community counters from /impact are labelled as backend data');

  /* ---- 11. idempotency: every business write sent a fresh UUID key ---- */
  const businessWrites = app.server.writes.filter(w => !/demo\/sessions|sessions\/logout/.test(w.path));
  assert.ok(businessWrites.length >= 5, 'publish, create, self-supply, loan, transitions, complete');
  businessWrites.forEach(w => assert.match(w.key, UUID_RE, `${w.path} must carry an Idempotency-Key UUID`));
  const keys = businessWrites.map(w => w.key);
  assert.equal(new Set(keys).size, keys.length, 'one user intent = one key; no key is reused across intents');
  app.server.writes.filter(w => /demo\/sessions|sessions\/logout/.test(w.path))
    .forEach(w => assert.equal(w.key, null, 'auth routes must not send an Idempotency-Key'));
});

test('action templates switch both ways and preserve existing progress without duplicate tasks', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  app.run("location.hash='#task';render()");
  app.click({ dataset: { template: 'flowerbed_care' } });
  await app.flush();
  const flowerId = app.run('myOpenTask().id');
  const requirementId = app.run('myOpenTask().requirements[0].id');
  await app.run(`client.setSelfSupply('${flowerId}', '${requirementId}', true)`);
  await app.run('refresh()');

  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  assert.equal(app.run('myOpenTask().template_id'), 'park_cleanup');
  assert.equal(app.run('myOpenTask().requirements.map(r => r.category).join(",")'), 'litter_picker,reusable_gloves');
  assert.match(app.html(), /template-option active" data-template="park_cleanup"/);

  app.click({ dataset: { template: 'flowerbed_care' } });
  await app.flush();
  assert.equal(app.run('myOpenTask().id'), flowerId);
  assert.equal(app.run('myOpenTask().requirements[0].self_supplied'), true);
  assert.match(app.html(), /template-option active" data-template="flowerbed_care"/);
  await app.run('refresh();');
  assert.equal(app.run('myOpenTask().id'), flowerId, 'refresh preserves the selected activity');

  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  assert.equal(app.run('myOpenTask().template_id'), 'park_cleanup');
  assert.equal(app.server.db.tasks.length, 2, 'repeated switching reuses open tasks');
});

test('server errors keep the form open and show the backend message', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'bob');

  // A name over B's 80-character limit -> 422 VALIDATION_ERROR from the API.
  app.run("location.hash='#community';render()");
  app.click({ dataset: { publish: true } });
  app.submit('#publish-form', { name: 'x'.repeat(100), category: 'litter_picker', description: 'Fine description.' });
  await app.flush();
  assert.equal(app.run('state.tools.length'), 0, 'nothing was created');
  assert.equal(app.element('#publish-dialog').open, true, 'the dialog stays open so the input survives');
  assert.equal(app.element('#toast').textContent, 'Request validation failed.');
  assert.equal(app.element('#publish-form').resetCount, 0, 'the form is not reset on failure');
});

test('an expired session returns to the login panel with the server message', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');

  app.server.expireSessions(); // every token now answers 401 UNAUTHENTICATED
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();

  assert.match(app.html(), /DEMO ACCOUNTS/, 'the app falls back to sign-in');
  assert.match(app.html(), /Your session has expired/);
  assert.equal(app.stored.has('bnd.token'), false, 'the dead token is dropped');
  assert.equal(app.run('state.me'), null, 'no phantom session is kept in memory');

  // Signing in again works and the app recovers.
  await signIn(app, 'alice');
  assert.equal(app.run('state.me.display_name'), 'Alice');
  assert.equal(app.run("typeof client.token"), 'string', 'a fresh token is in place');
});

test('search still filters, and HTML is still escaped', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'bob');

  app.run("location.hash='#community';render()");
  app.input({ id: 'tool-search', value: '<script>alert(1)</script>' });
  assert.match(app.element('#tool-grid').innerHTML, /No tools match/, 'no tool name contains a script tag');
  app.input({ id: 'tool-search', value: '' });
  assert.equal(app.run("esc('<script>')"), '&lt;script&gt;');
});

/* The optional self-lend of 02: the organiser already owns a registered tool
   that the chosen action needs, so they can book it for their own action
   instead of asking a neighbour. B records a real loan (owner == borrower),
   the tool leaves the neighbourhood list as `reserved`, and 03 keeps a
   “borrowed” mark for it. */
test('alice lends her own registered tool to her own action and 03 marks it borrowed', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');

  /* ---- 1. alice registers the watering can she already owns ---- */
  app.run("location.hash='#community';render()");
  app.click({ dataset: { publish: true } });
  app.submit('#publish-form', {
    name: 'Bright watering can', category: 'watering_can',
    description: 'Five litres, lives by the back door.'
  });
  await app.flush();
  const toolId = app.run('state.tools[0].id');
  assert.equal(app.run('state.tools[0].availability'), 'available');

  /* ---- 2. no action yet: 02 cannot offer a loan it has nothing to attach to ---- */
  app.run("location.hash='#task';render()");
  assert.equal(app.run('state.loans.length'), 0, 'browsing 02 never invents a loan');
  assert.ok(!app.html().includes('data-lend'), 'the choice needs the action first');
  assert.match(app.html(), /requirement ghost/, 'template needs are previewed without offering a loan');

  /* ---- 3. the action has to need the tool: flowerbed care wants a can and a trowel ---- */
  app.click({ dataset: { template: 'flowerbed_care' } });
  await app.flush();
  const canId = app.run("state.tasks[0].requirements.find(r=>r.category==='watering_can').id");
  const trowelId = app.run("state.tasks[0].requirements.find(r=>r.category==='hand_trowel').id");
  assert.match(app.html(), new RegExp(`data-lend="${toolId}" data-req="${canId}"`),
    'alice owns the can the action needs, so the optional choice appears');
  assert.ok(!app.html().includes(`data-req="${trowelId}" data-lend`),
    'alice owns no trowel, and the action needs one — no choice is invented');
  assert.equal((app.html().match(/data-lend=/g) || []).length, 1);
  assert.match(app.html(), /Optional · your own registered tool, booked for this action/);

  /* ---- 4. ticking it creates a real loan, and the tool is reserved ---- */
  app.change({ dataset: { lend: toolId, req: canId }, checked: true });
  await app.flush();
  assert.equal(app.run("state.loans.filter(l=>l.status==='pending').length"), 1);
  assert.equal(app.run('state.loans[0].owner_id === state.loans[0].borrower_id'), true, 'a self-lend names the owner twice');
  assert.equal(app.run('state.loans[0].tool_id'), toolId);
  assert.equal(app.run('state.loans[0].requirement_id'), canId);
  assert.equal(app.run(`state.tools.find(t=>t.id==='${toolId}').availability`), 'reserved',
    'the tool leaves the neighbourhood list like any borrowed tool');
  assert.equal(app.run("state.tasks[0].requirements.find(r=>r.category==='watering_can').state"), 'pending');
  assert.match(app.html(), /Lent by you · Bright watering can/);
  assert.match(app.html(), /Awaiting your confirmation/, 'the self-lend reads as your own confirmation, not a neighbour’s');

  /* ---- 5. 03 / Tell the story carries the “borrowed” mark ---- */
  assert.match(app.html(), /id="lent-marks"/);
  assert.match(app.html(), /<span class="lent-tag">borrowed<\/span>/);
  assert.match(app.html(), /Lent by you to this action · Awaiting your confirmation/);

  /* ---- 6. unticking it releases the tool again (cancel while pending) ---- */
  app.change({ dataset: { lend: toolId, req: canId }, checked: false });
  await app.flush();
  assert.equal(app.run("state.loans.filter(l=>l.status==='cancelled').length"), 1);
  assert.equal(app.run(`state.tools.find(t=>t.id==='${toolId}').availability`), 'available');
  assert.equal(app.run("state.tasks[0].requirements.find(r=>r.category==='watering_can').state"), 'missing');
  assert.ok(!app.html().includes('id="lent-marks"'), 'a released tool leaves no borrowed mark in 03');

  /* ---- 7. lend it again and drive the record through the state machine ---- */
  app.change({ dataset: { lend: toolId, req: canId }, checked: true });
  await app.flush();
  const loanId = app.run("state.loans.find(l=>l.status==='pending').id");
  app.run("location.hash='#loans';render()");
  assert.match(app.html(), /Your own tool · lent to your community action/, 'no “Alice borrowing from Alice”');
  app.click({ dataset: { transition: 'accept', id: loanId } });
  await app.flush();
  app.run("location.hash='#task';render()");
  assert.match(app.html(), /Reservation accepted · hand it over on the day/);
  app.run("location.hash='#loans';render()");
  app.click({ dataset: { transition: 'hand-over', id: loanId } });
  await app.flush();
  assert.equal(app.run(`state.tools.find(t=>t.id==='${toolId}').availability`), 'on_loan');
  app.click({ dataset: { transition: 'return', id: loanId } });
  await app.flush();
  assert.equal(app.run("state.tasks[0].requirements.find(r=>r.category==='watering_can').state"), 'fulfilled',
    'a returned self-lend fulfils its requirement like any other loan');
  assert.equal(app.run(`state.tools.find(t=>t.id==='${toolId}').availability`), 'available');
  app.run("location.hash='#task';render()");
  assert.match(app.html(), /Lent by you to this action · Returned · ready to share again/);

  /* every self-lend write used a fresh Idempotency-Key UUID */
  const selfLendWrites = app.server.writes.filter(w => /\/loans$/.test(w.path));
  assert.equal(selfLendWrites.length, 2, 'two self-lends (one cancelled, one driven home)');
  selfLendWrites.forEach(w => assert.match(w.key, UUID_RE));
});

/* 02 is optional: getting the tools together never gates the report. The
   organiser can record an open action while every requirement is still
   missing, and the story then shows up on the street strip like any other. */
test('02 is optional: an action records even while its tools are unconfirmed', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  app.run("location.hash='#task';render()");
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();

  assert.match(app.html(), /0 of 2 requirements confirmed/);
  assert.equal(app.run('state.tasks[0].completion_eligible'), false);
  assert.equal(app.run('state.tasks[0].coordination_ready'), false);
  assert.match(app.html(), /checklist is optional/, 'the hint is shown, not a block');
  assert.ok(!/id="complete-task"[^>]*disabled/.test(app.html()), 'the checklist never disables the button');

  app.element('#outcome-note').value = 'Picked up litter along the path.';
  app.click({ id: 'complete-task' });
  await app.flush();

  assert.equal(app.run('state.tasks[0].status'), 'completed');
  assert.equal(app.run('state.tasks[0].outcome.note'), 'Picked up litter along the path.');
  assert.equal(app.run('state.tasks[0].outcome.bags_collected'), null);
  assert.equal(app.run('state.tasks[0].completion_eligible'), false,
    'the derived flag keeps reporting the checklist, it just no longer blocks');
  const states = app.run('state.tasks[0].requirements.map(r=>r.state).join(",")');
  assert.ok(states.split(',').every(s => s === 'missing' || s === 'match_available'), states);
  assert.equal(app.run("state.loans.length"), 0, 'recording an action never invents a loan');
  assert.match(app.html(), /Picked up litter along the path\./, 'the recorded story stays readable in 03');

  /* the same story flows into the street strip, tools or no tools */
  app.run("location.hash='#community';render()");
  assert.match(app.html(), /Stories from the street/);
  assert.match(app.html(), /Picked up litter along the path\./);
  assert.match(app.html(), /class="story-card"/);
});
