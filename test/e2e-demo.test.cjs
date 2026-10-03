/* Member D — end-to-end check of the demo story through A's real UI wiring.
 *
 * Story: Alice plans a clean-up and is missing a litter picker. Bob publishes
 * one. Alice requests it, Bob accepts, hands over, takes it back, and only
 * then does Alice record the action. Every step is asserted against the state
 * the UI actually produced, not against a re-implementation of the rules.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness.cjs');

test('publishing a missing tool turns a gap into a request, and borrowing is not completing', () => {
  const app = createApp();
  const { run, click, change, submit, element } = app;

  /* ---- 1. Alice plans a clean-up and is short of a picker ---------------- */
  run("location.hash='#task';render()");
  assert.match(app.html(), /Pick an action above/, 'nothing exists until an action is chosen');
  assert.equal(run('state.tasks.length'), 0, 'viewing the page must not invent work for the neighbourhood');

  click({ dataset: { template: 'cleanup' } });
  assert.equal(run('state.tasks.length'), 1);
  assert.match(app.html(), /0 of 2 tool slots confirmed/);
  assert.match(app.html(), /Still looking for a neighbour’s tool/);
  assert.match(app.html(), /NEIGHBOURS NEEDED/, 'the wanted board names the gap');
  assert.match(app.html(), /Litter picker/);
  assert.equal(run("state.tasks[0].status"), 'planning');

  const taskId = run('state.tasks[0].id');
  const requirements = run('state.tasks[0].requirements');
  assert.equal(requirements.length, 2, 'cleanup expands into two slots');
  assert.equal(run("state.tasks[0].requirements.every(r=>r.source_type==='loan')"), true);

  /* ---- 2. Bob publishes the missing litter picker ------------------------ */
  run("user='bob'");
  submit('#publish-form', { name: 'My long-handled litter picker', category: 'picker', description: 'Kept in the shed, works fine.' });
  assert.equal(run("state.tools.filter(t=>t.category==='picker').length"), 1);
  assert.equal(run("state.tools.find(t=>t.category==='picker').owner_id"), 'bob');
  assert.equal(run("state.tools.find(t=>t.category==='picker').postcode"), 'EH8 9YL');

  /* ---- 3. Alice sees it, but finding a tool is not confirming it -------- */
  run("user='alice';location.hash='#task';render()");
  assert.equal(run('state.tasks.length'), 1, 'Bob browsing the action page created nothing');
  assert.match(app.html(), /Request from Bob/);
  assert.match(app.html(), /0 of 2 tool slots confirmed/, 'a neighbour owning it is not a confirmed tool');
  assert.doesNotMatch(app.html(), /NEIGHBOURS NEEDED/, 'the gap closed as soon as the tool appeared');

  const pickerSlot = run("state.tasks[0].requirements.find(r=>r.category==='picker').id");
  const toolId = run("state.tools.find(t=>t.category==='picker').id");

  /* ---- 4. Alice requests that exact slot --------------------------------- */
  click({ dataset: { borrow: toolId, req: pickerSlot } });
  assert.equal(run('state.loans.length'), 1);
  assert.equal(run('state.loans[0].status'), 'pending');
  assert.equal(run('state.loans[0].requirement_id'), pickerSlot, 'the request remembers which slot it fills');
  assert.equal(run("state.tasks[0].requirements.find(r=>r.category==='picker').loan_request_id"), run('state.loans[0].id'));
  assert.equal(run("state.tools.find(t=>t.category==='picker').status"), 'reserved');
  assert.match(app.html(), /Awaiting Bob to respond/);
  assert.match(app.html(), /0 of 2 tool slots confirmed/, 'a request is still not a confirmed tool');

  /* ---- 5. Second request for the same slot is refused ------------------- */
  const before = run('state.loans.length');
  click({ dataset: { borrow: toolId, req: pickerSlot } });
  assert.equal(run('state.loans.length'), before, 'the same slot cannot hold two requests');

  /* ---- 6. Bob accepts: now it is "已落实" but not yet handed over -------- */
  const loanId = run('state.loans[0].id');
  run("user='bob'");
  click({ dataset: { transition: 'accepted', id: loanId } });
  assert.equal(run('state.loans[0].status'), 'accepted');
  run("user='alice';location.hash='#task';render()");
  assert.match(app.html(), /1 of 2 tool slots confirmed/);
  assert.match(app.html(), /reservation accepted by Bob/);
  assert.match(app.html(), /Reservation accepted · My long-handled litter picker/, 'the stage is shown by name');

  /* ---- 7. Alice brings her own gloves, closing the second slot ---------- */
  const glovesSlot = run("state.tasks[0].requirements.find(r=>r.category==='gloves').id");
  change({ dataset: { self: glovesSlot }, checked: true });
  assert.equal(run("state.tasks[0].requirements.find(r=>r.category==='gloves').source_type"), 'self');
  assert.match(app.html(), /2 of 2 tool slots confirmed/);
  assert.match(app.html(), /Every tool is confirmed/);

  /* ---- 8. Handover, then return ---------------------------------------- */
  run("user='bob'");
  click({ dataset: { transition: 'on_loan', id: loanId } });
  assert.equal(run('state.loans[0].status'), 'on_loan');
  assert.equal(run('state.loans[0].returned_at'), null);
  run("loanTab='lent'");
  assert.match(run('loansPage()'), /On loan · handover confirmed/);

  click({ dataset: { transition: 'returned', id: loanId } });
  assert.equal(run('state.loans[0].status'), 'returned');
  assert.ok(run('state.loans[0].returned_at'), 'returned_at is stamped');
  assert.equal(run("state.tools.find(t=>t.category==='picker').status"), 'available', 'the tool is shareable again');
  assert.equal(run("state.tasks[0].status"), 'planning', 'a returned tool does NOT complete the action');

  run("user='alice';location.hash='#task';render()");
  assert.match(app.html(), /1 of 2 tool slots confirmed/, 'the returned picker is no longer in the slot');
  assert.match(app.html(), /1 tool still to confirm/);

  /* ---- 9. Only now does Alice record the action, with self-reported figures */
  element('#outcome-note').value = 'Cleared litter along the path with Bob.';
  element('#impact-bags').value = '3';
  element('#impact-minutes').value = '90';
  element('#impact-bought-new').value = 'true';
  click({ id: 'complete-task' });

  assert.equal(run("state.tasks[0].status"), 'completed');
  assert.ok(run('state.tasks[0].completed_at'));
  assert.equal(run('state.tasks[0].outcome_note'), 'Cleared litter along the path with Bob.');
  assert.deepEqual(
    JSON.parse(run('JSON.stringify(state.tasks[0].impact)')),
    { bags_collected: 3, participant_minutes: 90, would_have_bought_new: true }
  );

  const report = run("JSON.stringify(D.impactReport(state.tasks,state.loans,{postcode,tools:state.tools,names}))");
  const by = Object.fromEntries(JSON.parse(report).metrics.map(m => [m.key, m]));
  assert.equal(by.completed_loans.value, 1);
  assert.equal(by.actions_with_tools_confirmed.value, 1);
  assert.equal(by.completed_actions.value, 1);
  assert.equal(by.bags_collected.value, 3);
  assert.equal(by.bags_collected.basis, 'self-reported');
  assert.equal(by.participant_minutes.value, 90);
  assert.equal(by.potential_avoided_purchases.value, 1, 'said they would have bought new and did borrow');
  assert.match(app.html(), /Not measured|Each figure is counted separately/);

  /* ---- 10. Everything survived a reload --------------------------------- */
  const persisted = JSON.parse(app.stored.get(app.key));
  assert.equal(persisted.tasks.length, 1);
  assert.equal(persisted.tasks[0].status, 'completed');
  assert.equal(persisted.tasks[0].requirements.length, 2, 'slots are persisted, not derived');
  assert.equal(persisted.loans.length, 1);
  assert.equal(persisted.loans[0].requirement_id, pickerSlot);
  assert.equal(persisted.tasks[0].id, taskId);
});

test('a legacy browser demo store is migrated instead of crashing', () => {
  // State written by the previous version of app.js: a bare self[] and no slots.
  const legacy = {
    tools: [{ id: 't1', owner_id: 'bob', name: 'Garden leaf rake', category: 'rake', description: 'x', status: 'available', postcode: 'EH8 9YL' }],
    loans: [],
    tasks: [{
      id: 'old1', creator_id: 'alice', template_id: 'cleanup', postcode: 'EH8 9YL',
      place_name: 'Meadow', status: 'planning', self: ['gloves'], outcome_note: 'old note'
    }]
  };
  const app = createApp({ storage: { 'bnd-demo-v1': JSON.stringify(legacy) } });

  assert.equal(app.run('state.tasks[0].self'), undefined, 'the legacy field is gone');
  assert.equal(app.run('state.tasks[0].requirements.length'), 2);
  assert.equal(app.run("state.tasks[0].requirements.find(r=>r.category==='gloves').source_type"), 'self', 'the old choice survives');
  assert.equal(app.run('state.tasks[0].outcome_note'), 'old note');
  assert.deepEqual(
    JSON.parse(app.run('JSON.stringify(state.tasks[0].impact)')),
    { bags_collected: null, participant_minutes: null, would_have_bought_new: null }
  );

  app.run("location.hash='#task';render()");
  assert.match(app.html(), /1 of 2 tool slots confirmed/);
  assert.match(app.html(), /bringing your own/);

  const saved = JSON.parse(app.stored.get(app.key));
  assert.equal(saved.tasks[0].self, undefined, 'the migration is written back, so it only happens once');
  assert.equal(saved.tasks[0].requirements.length, 2);
});
