/* Member D — unit tests for web/task-module.js.
   Run with: npm test   (node --test) */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../web/task-module.js');

/* --------------------------------------------------------------- fixtures */

const OWNERS = { alice: 'Alice', bob: 'Bob', cara: 'Cara' };
const POSTCODE = 'EH8 9YL';

function tool(id, owner, category, status, extra) {
  return Object.assign({
    id, owner_id: owner, name: id + ' ' + category, category,
    description: 'fixture', status: status || 'available', postcode: POSTCODE
  }, extra || {});
}

function makeTask(overrides) {
  return Object.assign(D.createTask({
    id: 'task1', creatorId: 'alice', templateId: 'cleanup',
    postcode: POSTCODE, placeName: 'Meadow spot'
  }), overrides || {});
}

function ctx(task, tools, loans, extra) {
  return Object.assign({ tools, loans, names: OWNERS, viewerId: 'alice', task }, extra || {});
}

/* ----------------------------------------------------------------- layout */

test('buildRequirements expands a quantity into one slot per item', () => {
  const rows = D.buildRequirements('cleanup', 't1', () => 'r');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.category), ['picker', 'gloves']);
  assert.ok(rows.every(r => r.quantity === 1 && r.slot_total === 1 && r.source_type === 'loan' && r.loan_request_id === null));

  const trees = D.buildRequirements('street_trees', 't2', (() => { let n = 0; return () => 'r' + (n += 1); })());
  const watering = trees.filter(r => r.category === 'watering');
  assert.equal(watering.length, 2, 'quantity 2 becomes two slots');
  assert.deepEqual(watering.map(r => r.slot), [1, 2]);
  assert.ok(watering.every(r => r.slot_total === 2));
});

test('every template only asks for tools the vocabulary knows', () => {
  D.TEMPLATE_LIST.forEach(t => {
    assert.ok(t.name && t.blurb && t.icon, t.id + ' needs display copy');
    t.requirements.forEach(r => assert.ok(D.CATEGORIES[r.category], t.id + ' -> unknown category ' + r.category));
  });
});

test('createTask normalises the postcode and starts empty', () => {
  const task = D.createTask({ id: 't', creatorId: 'alice', templateId: 'garden', postcode: 'eh89yl' });
  assert.equal(task.postcode, 'EH8 9YL');
  assert.equal(task.status, 'planning');
  assert.deepEqual(task.impact, { bags_collected: null, participant_minutes: null, would_have_bought_new: null });
  assert.equal(task.requirements.length, 3);
});

test('createTask rejects an unknown template', () => {
  assert.throws(() => D.createTask({ templateId: 'nope' }), /Unknown task template/);
});

test('ensureRequirements migrates a legacy self[] task in place', () => {
  const legacy = { id: 'old', creator_id: 'alice', template_id: 'cleanup', postcode: POSTCODE, self: ['gloves'], outcome_note: 'x', status: 'planning' };
  const result = D.ensureRequirements(legacy);
  assert.equal(result.migrated, true);
  assert.equal(legacy.self, undefined, 'legacy field is removed');
  assert.equal(legacy.requirements.length, 2);
  assert.equal(legacy.requirements.find(r => r.category === 'gloves').source_type, 'self');
  assert.equal(legacy.requirements.find(r => r.category === 'picker').source_type, 'loan');
  assert.ok(legacy.impact, 'impact block is added');
  // second pass is a no-op
  assert.equal(D.ensureRequirements(legacy).migrated, false);
});

/* --------------------------------------------------------------- matching */

test('matchTools only offers available tools and never your own', () => {
  const task = makeTask();
  const tools = [
    tool('mine', 'alice', 'picker', 'available'),
    tool('bobs', 'bob', 'picker', 'available'),
    tool('taken', 'cara', 'picker', 'reserved'),
    tool('out', 'cara', 'picker', 'on_loan')
  ];
  const found = D.matchTools('picker', ctx(task, tools, []));
  assert.deepEqual(found.map(f => f.toolId), ['bobs']);
  assert.equal(found[0].ownerName, 'Bob');
  assert.equal(found[0].scope, 'same_postcode');
});

test('matchTools prefers the same postcode over nearby, and hides unrelated postcodes', () => {
  const task = makeTask();
  const far = tool('far', 'cara', 'picker', 'available', { postcode: 'AB1 2CD' });
  const near = tool('near', 'cara', 'picker', 'available', { postcode: 'EH1 1AA' });
  const same = tool('same', 'bob', 'picker', 'available');

  const tiered = D.matchTools('picker', ctx(task, [far, near, same], [], { nearbyPostcodes: ['EH1 1AA'] }));
  assert.deepEqual(tiered.map(f => f.toolId), ['same'], 'same postcode wins outright');

  const nearby = D.matchTools('picker', ctx(task, [far, near], [], { nearbyPostcodes: ['EH1 1AA'] }));
  assert.deepEqual(nearby.map(f => f.toolId), ['near']);
  assert.equal(nearby[0].scope, 'nearby');

  assert.deepEqual(D.matchTools('picker', ctx(task, [far], [])), [], 'an unrelated postcode is not "nearby"');
  assert.deepEqual(D.matchTools('picker', ctx(task, [far], [], { allowElsewhere: true })).map(f => f.toolId), ['far'],
    'a wider radius is opt-in only');
});

test('nearbyPostcodes accepts an outcode as well as a full postcode', () => {
  const task = makeTask();
  const inDistrict = tool('eh7', 'cara', 'picker', 'available', { postcode: 'EH7 4AB' });
  const nextDistrict = tool('eh9', 'cara', 'picker', 'available', { postcode: 'EH9 1AA' });
  const far = tool('far', 'cara', 'picker', 'available', { postcode: 'AB1 2CD' });

  // Member C holds outcodes from Postcodes.io /outcodes/{outcode}/nearest.
  const found = D.matchTools('picker', ctx(task, [nextDistrict, inDistrict, far], [], { nearbyPostcodes: ['EH7'] }));
  assert.deepEqual(found.map(f => f.toolId), ['eh7'], 'an outcode covers every postcode inside it');
  assert.equal(found[0].scope, 'nearby');

  // A full postcode still works, and an outcode must not leak into other districts.
  assert.deepEqual(D.matchTools('picker', ctx(task, [inDistrict], [], { nearbyPostcodes: ['EH7 4AB'] })).map(f => f.toolId), ['eh7']);
  assert.deepEqual(D.matchTools('picker', ctx(task, [nextDistrict], [], { nearbyPostcodes: ['EH7'] })), []);

  assert.equal(D.outwardCode('eh89yl'), 'EH8');
  assert.equal(D.outwardCode('EH7 4AB'), 'EH7');
  assert.equal(D.outwardCode('EH7'), 'EH7');
  assert.equal(D.outwardCode(''), '');
});

test('matchTools adds an approximate straight-line distance only when coordinates exist', () => {  const task = makeTask({ latitude: 55.9445, longitude: -3.1883 });
  const withCoords = tool('near', 'bob', 'picker', 'available', { latitude: 55.9545, longitude: -3.1883 });
  const without = tool('flat', 'cara', 'picker', 'available');
  const found = D.matchTools('picker', ctx(task, [without, withCoords], []));
  assert.equal(found.find(f => f.toolId === 'near').distanceKm, 1.1);
  assert.equal(found.find(f => f.toolId === 'flat').distanceKm, null);
  assert.equal(D.matchTools('picker', ctx(makeTask(), [withCoords], []))[0].distanceKm, null,
    'no distance is invented when the task has no coordinates');
});

/* ------------------------------------------------------------- slot states */

test('a slot walks requested -> reserved -> handed over -> returned', () => {
  const tools = [tool('p1', 'bob', 'picker')];
  const task = makeTask();
  const slot = task.requirements.find(r => r.category === 'picker');
  const other = task.requirements.find(r => r.category === 'gloves');

  const loans = [];
  const step = () => {
    const c = ctx(task, tools, loans);
    return {
      picker: D.describeTask(task, c).find(r => r.requirementId === slot.id),
      gloves: D.describeTask(task, c).find(r => r.requirementId === other.id)
    };
  };

  // 1. found, not reserved
  let s = step();
  assert.equal(s.picker.state, 'available');
  assert.equal(s.picker.confirmed, false);
  assert.deepEqual(s.picker.tools.map(t => t.toolId), ['p1']);
  assert.match(s.picker.statusText, /Available to request from Bob/);
  assert.equal(s.gloves.state, 'missing', 'the gloves slot stays missing');

  // 2. request sent
  const created = D.createLoanRequest(tools[0], task, slot, 'alice', () => 'loanA');
  assert.equal(created.ok, true);
  loans.push(created.request);
  s = step();
  assert.equal(s.picker.state, 'pending');
  assert.equal(s.picker.pending, true);
  assert.equal(s.picker.stage, 'requested');
  assert.deepEqual(s.picker.tools, [], 'a pending slot offers no second request');

  // 3. reservation accepted
  loans[0].status = 'accepted';
  s = step();
  assert.equal(s.picker.state, 'confirmed');
  assert.equal(s.picker.confirmed, true);
  assert.equal(s.picker.stage, 'reserved');
  assert.match(s.picker.statusText, /reservation accepted by Bob/);

  // 4. handed over
  loans[0].status = 'on_loan';
  s = step();
  assert.equal(s.picker.stage, 'handed_over');
  assert.match(s.picker.statusText, /handed over by Bob/);

  // 5. returned: no longer held, so the slot reopens but keeps its history
  loans[0].status = 'returned';
  loans[0].returned_at = '2026-10-03T12:00:00Z';
  s = step();
  assert.equal(s.picker.state, 'available');
  assert.equal(s.picker.confirmed, false);
  assert.equal(s.picker.history.length, 1);
  assert.match(s.picker.statusText, /Available to request/);
});

test('bringing your own confirms a slot without any tool', () => {
  const task = makeTask();
  const slot = task.requirements.find(r => r.category === 'gloves');
  D.setSlotSource(task, slot.id, 'self');
  const row = D.describeTask(task, ctx(task, [], [])).find(r => r.requirementId === slot.id);
  assert.equal(row.state, 'confirmed');
  assert.equal(row.sourceType, 'self');
  assert.equal(row.stage, 'self');
  assert.match(row.statusText, /bringing your own/);
});

test('a declined or cancelled request is forgotten and reopens the slot', () => {
  const tools = [tool('p1', 'bob', 'picker')];
  const task = makeTask();
  const slot = task.requirements.find(r => r.category === 'picker');
  const created = D.createLoanRequest(tools[0], task, slot, 'alice', () => 'loanA');
  const loans = [created.request];

  loans[0].status = 'rejected';
  let row = D.describeTask(task, ctx(task, tools, loans)).find(r => r.requirementId === slot.id);
  assert.equal(row.state, 'available');
  assert.deepEqual(row.loans, [], 'rejected requests are not carried');
  assert.deepEqual(row.history, []);

  loans[0].status = 'cancelled';
  row = D.describeTask(task, ctx(task, tools, loans)).find(r => r.requirementId === slot.id);
  assert.equal(row.state, 'available');
});

test('claimLoans never double-books a slot and is deterministic', () => {
  const tools = [tool('c1', 'bob', 'watering'), tool('c2', 'cara', 'watering')];
  const task = makeTask({ template_id: 'street_trees' });
  D.setTemplate(task, 'street_trees', {});
  const slots = task.requirements.filter(r => r.category === 'watering');
  assert.equal(slots.length, 2);

  // Two undirected requests (as the community page creates them), oldest first.
  const loans = [
    { id: 'L2', tool_id: 'c2', borrower_id: 'alice', task_id: task.id, status: 'pending', created_at: '2026-01-02T00:00:00Z' },
    { id: 'L1', tool_id: 'c1', borrower_id: 'alice', task_id: task.id, status: 'pending', created_at: '2026-01-01T00:00:00Z' }
  ];
  const claims = D.claimLoans(slots, loans, new Map(tools.map(t => [t.id, t])));
  assert.equal(claims.get(slots[0].id)[0].request.id, 'L1', 'oldest request takes the first slot');
  assert.equal(claims.get(slots[1].id)[0].request.id, 'L2');

  // A third request has nowhere to go and must not steal a slot.
  loans.push({ id: 'L3', tool_id: 'c3', borrower_id: 'alice', task_id: task.id, status: 'pending', created_at: '2026-01-03T00:00:00Z' });
  const claims3 = D.claimLoans(slots, loans, new Map(tools.map(t => [t.id, t])));
  assert.equal(claims3.get(slots[0].id).length, 1);
  assert.equal(claims3.get(slots[1].id).length, 1);
});

test('createLoanRequest refuses a taken tool and a self-provided slot', () => {
  const task = makeTask();
  const slot = task.requirements.find(r => r.category === 'picker');
  const reserved = tool('p1', 'bob', 'picker', 'reserved');
  assert.deepEqual(D.createLoanRequest(reserved, task, slot, 'alice', () => 'x'), { ok: false, reason: 'tool_unavailable' });

  D.setSlotSource(task, slot.id, 'self');
  assert.deepEqual(D.createLoanRequest(tool('p2', 'bob', 'picker'), task, slot, 'alice', () => 'x'), { ok: false, reason: 'slot_is_self_provided' });

  D.setSlotSource(task, slot.id, 'loan');
  assert.equal(D.createLoanRequest(tool('p3', 'bob', 'picker'), task, slot, 'alice', () => 'x').ok, true);
  assert.equal(slot.loan_request_id, 'x', 'the slot is stamped on creation');
  assert.equal(D.createLoanRequest(tool('p4', 'cara', 'picker'), task, slot, 'alice', () => 'y').reason, 'slot_already_claimed');
});

/* ---------------------------------------------------------------- progress */

test('taskProgress rolls slots into one honest figure', () => {
  const tools = [tool('p1', 'bob', 'picker'), tool('g1', 'bob', 'gloves')];
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'picker');
  const gloves = task.requirements.find(r => r.category === 'gloves');
  const loans = [];

  let p = D.taskProgress(task, ctx(task, tools, loans));
  assert.deepEqual([p.total, p.confirmed, p.pending, p.missing, p.percent], [2, 0, 0, 2, 0]);
  assert.equal(p.complete, false);
  assert.deepEqual(p.missingCategories, ['picker', 'gloves']);
  assert.match(p.nextAction, /Find a neighbour with the first tool/);

  const created = D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1');
  loans.push(created.request);
  p = D.taskProgress(task, ctx(task, tools, loans));
  assert.equal(p.pending, 1);
  assert.equal(p.missing, 2, 'pending is not confirmed');
  assert.match(p.nextAction, /2 tools still to confirm/);

  loans[0].status = 'accepted';
  D.setSlotSource(task, gloves.id, 'self');
  p = D.taskProgress(task, ctx(task, tools, loans));
  assert.deepEqual([p.confirmed, p.missing, p.percent, p.complete], [2, 0, 100, true]);
  assert.match(p.nextAction, /Every tool is confirmed/);
});

/* ------------------------------------------------------------ wanted board */

test('the wanted board counts unclaimed slots across tasks, not tools', () => {
  const a = makeTask({ id: 'a' });
  const b = makeTask({ id: 'b', creator_id: 'cara' });
  b.requirements.find(r => r.category === 'gloves').source_type = 'self';
  const done = makeTask({ id: 'c', status: 'completed' });

  const board = D.wantedBoard([a, b, done], ctx(a, [], []));
  const picker = board.find(e => e.category === 'picker');
  assert.equal(picker.slots, 2, 'two neighbours both need a picker, so the demand is counted twice');
  assert.equal(picker.taskCount, 2);
  assert.equal(board.find(e => e.category === 'gloves').slots, 1, 'only task a still needs gloves');
  assert.ok(!board.some(e => e.taskIds.includes('c')), 'completed actions leave the board');

  // Publishing one tool closes the gap before anybody has even borrowed it.
  const after = D.wantedBoard([a, b, done], ctx(a, [tool('p1', 'bob', 'picker')], []));
  assert.equal(after.find(e => e.category === 'picker'), undefined);
});

/* ------------------------------------------------------------------ impact */

test('impactReport counts each metric separately and labels its basis', () => {
  const tools = [tool('p1', 'bob', 'picker')];
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'picker');
  const gloves = task.requirements.find(r => r.category === 'gloves');
  D.setSlotSource(task, gloves.id, 'self');
  const loans = [D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1').request];
  const ctxOf = () => ({ tools, loans, names: OWNERS });

  let report = D.impactReport([task], loans, ctxOf());
  let by = Object.fromEntries(report.metrics.map(m => [m.key, m]));
  assert.equal(by.completed_loans.value, 0);
  assert.equal(by.actions_with_tools_confirmed.value, 0, 'the picker is only pending, so no action has every tool confirmed yet');
  assert.equal(by.completed_actions.value, 0);
  assert.equal(by.potential_avoided_purchases.available, false, 'unasked survey questions are not reported as zero');
  assert.equal(by.bags_collected.available, false, 'unreported figures show "not collected yet"');
  assert.ok(report.metrics.every(m => m.caveat && m.source && m.basis && m.scope === report.scope));
  assert.equal(report.scope, 'all recorded data', 'an unscoped report says so instead of implying one postcode');

  loans[0].status = 'returned';
  D.applyOutcome(task, { note: 'Cleared two bin bags by the path.', bags_collected: '2', participant_minutes: '45', would_have_bought_new: true, completedAt: '2026-10-03T12:00:00Z' });

  report = D.impactReport([task], loans, ctxOf());
  by = Object.fromEntries(report.metrics.map(m => [m.key, m]));
  assert.equal(by.completed_loans.value, 1);
  assert.equal(by.actions_with_tools_confirmed.value, 1, 'a returned loan still counts as a tool that was confirmed');
  assert.equal(by.completed_actions.value, 1);
  assert.equal(by.bags_collected.value, 2);
  assert.equal(by.bags_collected.available, true);
  assert.equal(by.participant_minutes.value, 45);
  assert.equal(by.potential_avoided_purchases.value, 1, 'said they would have bought new, and did borrow');
  assert.equal(task.status, 'completed');
  assert.equal(task.completed_at, '2026-10-03T12:00:00Z');

  // Scoping by postcode must not leak other neighbourhoods in.
  const elsewhere = makeTask({ id: 'other', postcode: 'AB1 2CD', status: 'completed' });
  elsewhere.impact.bags_collected = 99;
  const scoped = D.impactReport([task, elsewhere], loans, { tools, loans, names: OWNERS, postcode: POSTCODE });
  assert.equal(Object.fromEntries(scoped.metrics.map(m => [m.key, m])).bags_collected.value, 2);
});

test('an avoided purchase needs a returned-or-confirmed loan, not just an answer', () => {
  const tools = [tool('p1', 'bob', 'picker')];
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'picker');
  task.requirements.find(r => r.category === 'gloves').source_type = 'self';

  // Answered "yes I would have bought new", but nothing was borrowed.
  D.applyOutcome(task, { note: 'done', would_have_bought_new: true });
  let report = D.impactReport([task], [], { tools, loans: [], names: OWNERS });
  let by = Object.fromEntries(report.metrics.map(m => [m.key, m]));
  assert.equal(by.potential_avoided_purchases.available, true);
  assert.equal(by.potential_avoided_purchases.value, 0);

  const loan = D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1').request;
  loan.status = 'returned';
  report = D.impactReport([task], [loan], { tools, loans: [loan], names: OWNERS });
  by = Object.fromEntries(report.metrics.map(m => [m.key, m]));
  assert.equal(by.potential_avoided_purchases.value, 1);
});

/* -------------------------------------------------------------- templates */

test('setTemplate refuses while a request is live and keeps bring-your-own choices', () => {
  const tools = [tool('p1', 'bob', 'picker'), tool('s1', 'bob', 'spade')];
  const task = makeTask();
  const gloves = task.requirements.find(r => r.category === 'gloves');
  D.setSlotSource(task, gloves.id, 'self');

  const switched = D.setTemplate(task, 'garden', {});
  assert.equal(switched.ok, true);
  assert.equal(task.template_id, 'garden');
  assert.deepEqual(task.requirements.map(r => r.category), ['spade', 'gloves', 'watering']);
  assert.equal(task.requirements.find(r => r.category === 'gloves').source_type, 'self', 'the choice survived');

  const pickerless = task.requirements.find(r => r.category === 'spade');
  const loans = [D.createLoanRequest(tools[1], task, pickerless, 'alice', () => 'L1').request];
  const blocked = D.setTemplate(task, 'cleanup', { loans });
  assert.deepEqual(blocked, { ok: false, reason: 'active_requests' });
  assert.equal(task.template_id, 'garden', 'the task is untouched when the switch is refused');

  loans[0].status = 'returned';
  assert.equal(D.setTemplate(task, 'cleanup', { loans }).ok, true);
  assert.deepEqual(task.requirements.map(r => r.category), ['picker', 'gloves']);
});

test('outcomeReadiness never blocks the report, only warns about outstanding tools', () => {
  const tools = [tool('p1', 'bob', 'picker')];
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'picker');
  const loans = [D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1').request];
  loans[0].status = 'on_loan';

  const readiness = D.outcomeReadiness(task, ctx(task, tools, loans));
  assert.equal(readiness.canSubmit, true);
  assert.equal(readiness.outstandingReturns, 1);
  assert.equal(readiness.unconfirmedSlots, 1, 'the gloves slot is still open');
  assert.match(readiness.warning, /Returns are tracked separately/);
});

/* ----------------------------------------------------------------- helpers */

test('normalisePostcode is forgiving about spacing and case', () => {
  assert.equal(D.normalisePostcode('eh89yl'), 'EH8 9YL');
  assert.equal(D.normalisePostcode('EH8  9YL'), 'EH8 9YL');
  assert.equal(D.normalisePostcode('  eh8-9yl '), 'EH8 9YL');
  assert.equal(D.normalisePostcode('GIR0AA'), 'GIR 0AA');
  assert.equal(D.normalisePostcode(''), '');
  assert.equal(D.normalisePostcode(null), '');
  assert.equal(D.normalisePostcode('AB1'), 'AB1');
});

test('haversineKm returns a plausible straight-line distance', () => {
  const d = D.haversineKm(55.9445, -3.1883, 51.5074, -0.1278); // Edinburgh -> London
  assert.ok(d > 520 && d < 545, 'expected ~534 km, got ' + d);
  assert.equal(D.haversineKm(55.9445, -3.1883, 55.9445, -3.1883), 0);
});

test('a finished request does not lock its slot forever', () => {
  const tools = [tool('p1', 'bob', 'picker'), tool('p2', 'cara', 'picker')];
  const task = makeTask();
  const slot = task.requirements.find(r => r.category === 'picker');
  const loans = [];
  const context = () => ({ tools, loans });

  // pending -> the slot is claimed
  const first = D.createLoanRequest(tools[0], task, slot, 'alice', () => 'L1', context());
  assert.equal(first.ok, true);
  loans.push(first.request);
  assert.equal(D.slotIsClaimed(task, slot, context()), true);
  assert.equal(D.createLoanRequest(tools[1], task, slot, 'alice', () => 'L2', context()).reason, 'slot_already_claimed');

  // handed over -> still claimed
  loans[0].status = 'on_loan';
  assert.equal(D.slotIsClaimed(task, slot, context()), true);

  // returned -> the tool is back on the shelf, so the slot must reopen
  loans[0].status = 'returned';
  loans[0].returned_at = '2026-10-03T12:00:00Z';
  assert.equal(D.slotIsClaimed(task, slot, context()), false, 'a returned loan is history, not a claim');
  const again = D.createLoanRequest(tools[1], task, slot, 'alice', () => 'L2', context());
  assert.equal(again.ok, true, 'the same slot can be borrowed again, which the impact panel counts');

  // rejected / cancelled -> also reopen
  loans[1] = again.request;
  loans[1].status = 'rejected';
  assert.equal(D.slotIsClaimed(task, slot, context()), false);
  loans[1].status = 'cancelled';
  assert.equal(D.slotIsClaimed(task, slot, context()), false);

  // without loan data the guard stays conservative
  assert.equal(D.slotIsClaimed(task, slot, {}), true, 'no data -> trust the stored pointer');
});
