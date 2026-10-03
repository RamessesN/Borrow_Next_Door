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

  /* ---- 4. sign out, alice signs in ---- */
  await signOut(app);
  assert.match(app.html(), /DEMO ACCOUNTS/);
  assert.equal(app.stored.has('bnd.token'), false, 'signing out drops the token');
  await signIn(app, 'alice');
  assert.equal(app.run('state.me.display_name'), 'Alice');
  assert.equal(app.run('state.tools.length'), 1, 'Alice sees Bob\'s tool');

  /* ---- 5. alice creates the action ---- */
  app.run("location.hash='#task';render()");
  assert.match(app.html(), /Pick an action above/, 'nothing exists until an action is chosen');
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
  app.element('#impact-bags').value = '3';
  app.element('#impact-minutes').value = '90';
  app.click({ id: 'complete-task' });
  await app.flush();
  assert.equal(app.run('state.tasks[0].status'), 'completed');
  assert.equal(app.run('state.tasks[0].outcome.note'), 'Cleared litter along the path with Bob.');
  assert.equal(app.run('state.tasks[0].outcome.bags_collected'), 3);
  assert.equal(app.run('state.tasks[0].outcome.volunteer_minutes'), 90);
  assert.equal(app.run('state.tasks[0].outcome.verification'), 'self_reported');
  assert.match(app.html(), /Cleared litter along the path with Bob\./, 'the recorded story stays readable');

  /* impact maths still comes from D's pure functions, now over API data */
  const report = JSON.parse(app.run("JSON.stringify(D.impactReport(state.tasks, state.loans, {communityId: state.me.community.id, tools: state.tools, names: state.names}))"));
  const by = Object.fromEntries(report.metrics.map(m => [m.key, m]));
  assert.equal(by.completed_loans.value, 1);
  assert.equal(by.actions_with_tools_confirmed.value, 1);
  assert.equal(by.completed_actions.value, 1);
  assert.equal(by.bags_collected.value, 3);
  assert.equal(by.bags_collected.basis, 'self-reported');
  assert.equal(by.volunteer_minutes.value, 90);
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
