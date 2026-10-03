/* Member D — unit tests for web/task-module.js, locked to the frozen B
   backend vocabulary (backend/app/schemas_*.py + backend/docs/API_SAMPLES.md).
   Run with: npm test   (node --test) */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../web/task-module.js');

/* --------------------------------------------------------------- fixtures */

const OWNERS = { alice: 'Alice', bob: 'Bob', cara: 'Cara' };

function community(id, postcode, latitude, longitude) {
  return {
    id, postcode, outcode: D.outwardCode(postcode), latitude, longitude,
    country: 'Scotland', source: 'fixture', source_kind: 'fixture',
    fetched_at: '2026-10-03T09:00:00Z'
  };
}

const C1 = community('c1', 'EH8 9YL', 55.9476, -3.1873);   // the task's community
const C2 = community('c2', 'EH7 4AB', 55.9545, -3.18);     // ~0.9 km away
const FAR = community('c3', 'AB1 2CD', 57.15, -2.1);       // another region

function tool(id, owner, category, availability, extra) {
  return Object.assign({
    id,
    name: id + ' tool',
    category,
    description: 'fixture',
    owner: { id: owner, display_name: OWNERS[owner] || owner },
    community: C1,
    availability: availability || 'available',
    is_archived: false,
    distance_m: null,
    created_at: '2026-10-03T09:00:00Z',
    updated_at: '2026-10-03T09:00:00Z'
  }, extra || {});
}

function loan(id, extra) {
  return Object.assign({
    id,
    tool_id: 'p1', tool_name: 'p1 tool', owner_id: 'bob', borrower_id: 'alice',
    requirement_id: null, task_id: 'task1', status: 'pending', note: '',
    created_at: '2026-10-03T10:00:00Z', updated_at: '2026-10-03T10:00:00Z',
    accepted_at: null, handed_over_at: null, returned_at: null,
    rejected_at: null, cancelled_at: null
  }, extra || {});
}

function makeTask(overrides) {
  return Object.assign(D.createTask({
    id: 'task1', creatorId: 'alice', creatorName: 'Alice', templateId: 'park_cleanup',
    communityId: 'c1',
    place: { name: 'Meadow spot', latitude: 55.9476, longitude: -3.1873, source: 'manual' }
  }), overrides || {});
}

function ctx(task, tools, loans, extra) {
  return Object.assign({ task, tools, loans, names: OWNERS, viewerId: 'zoe' }, extra || {});
}

/* ----------------------------------------------------------------- layout */

test('the frozen category, template and status vocabulary matches the backend', () => {
  assert.deepEqual(Object.keys(D.CATEGORIES).sort(),
    ['hand_trowel', 'litter_picker', 'reusable_gloves', 'watering_can']);
  ['rake', 'picker', 'gloves', 'spade', 'watering'].forEach(slug =>
    assert.equal(slug in D.CATEGORIES, false, slug + ' is not in the frozen set'));
  assert.equal(D.CATEGORIES.litter_picker.label, 'Litter picker');
  assert.equal(D.CATEGORIES.reusable_gloves.label, 'Reusable gloves');
  assert.equal(D.CATEGORIES.watering_can.label, 'Watering can');
  assert.equal(D.CATEGORIES.hand_trowel.label, 'Hand trowel');

  assert.deepEqual(D.TEMPLATE_LIST.map(t => t.id), ['park_cleanup', 'flowerbed_care']);
  ['cleanup', 'garden', 'street_trees', 'spring_bulbs'].forEach(id =>
    assert.equal(id in D.TEMPLATES, false, id + ' was removed'));
  assert.deepEqual(D.TEMPLATES.park_cleanup.requirements.map(r => r.category),
    ['litter_picker', 'reusable_gloves']);
  assert.deepEqual(D.TEMPLATES.flowerbed_care.requirements.map(r => r.category),
    ['watering_can', 'hand_trowel']);
  D.TEMPLATE_LIST.forEach(t => {
    assert.ok(t.title && t.description && t.name && t.blurb && t.icon, t.id + ' needs display copy');
    t.requirements.forEach(r => {
      assert.ok(D.CATEGORIES[r.category], t.id + ' -> unknown category ' + r.category);
      assert.equal(r.quantity, 1);
    });
  });
  assert.equal(D.TEMPLATES.park_cleanup.title, 'Park cleanup');
  assert.equal(D.TEMPLATES.flowerbed_care.title, 'Flowerbed care');

  assert.deepEqual(D.TOOL_STATUS, ['available', 'reserved', 'on_loan', 'archived']);
  assert.deepEqual(D.TASK_STATUSES, ['open', 'completed']);
  assert.deepEqual(D.REQUIREMENT_STATES,
    ['self_supplied', 'pending', 'confirmed', 'in_use', 'fulfilled', 'match_available', 'missing']);
  assert.deepEqual(D.LOAN_STATUSES,
    ['pending', 'accepted', 'on_loan', 'returned', 'rejected', 'cancelled']);
  assert.deepEqual(D.LOAN_ACTIVE, ['pending', 'accepted', 'on_loan']);
  assert.deepEqual(D.LOAN_CONFIRMED, ['accepted', 'on_loan']);
  assert.deepEqual(D.LOAN_CLOSED, ['returned', 'rejected', 'cancelled']);

  // Every stage maps onto the state machine AND the tool availability it implies.
  const expected = {
    pending: ['requested', 'reserved'],
    accepted: ['reserved', 'reserved'],
    on_loan: ['handed_over', 'on_loan'],
    returned: ['returned', 'available'],
    rejected: ['rejected', 'available'],
    cancelled: ['cancelled', 'available']
  };
  Object.keys(expected).forEach(status => {
    assert.equal(D.LOAN_STAGES[status].stage, expected[status][0], status + ' stage');
    assert.equal(D.LOAN_STAGES[status].availability, expected[status][1], status + ' availability');
    assert.ok(D.LOAN_STAGES[status].label);
  });
});

test('buildRequirements makes exactly one row per category with quantity 1', () => {
  let n = 0;
  const rows = D.buildRequirements('park_cleanup', 't1', () => 'r' + (n += 1));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.category), ['litter_picker', 'reusable_gloves']);
  rows.forEach(r => {
    assert.deepEqual(Object.keys(r),
      ['id', 'category', 'quantity', 'self_supplied', 'state', 'active_loan_id', 'candidate_tool_ids'],
      'RequirementView shape — the slot mechanism is gone');
    assert.equal(r.quantity, 1);
    assert.equal(r.state, 'missing');
    assert.equal(r.self_supplied, false);
    assert.equal(r.active_loan_id, null);
    assert.deepEqual(r.candidate_tool_ids, []);
    ['slot', 'slot_total', 'source_type', 'loan_request_id', 'task_id'].forEach(key =>
      assert.equal(key in r, false, key + ' must not come back'));
  });
  assert.throws(() => D.buildRequirements('street_trees', 't2', () => 'r'), /Unknown task template/);
  assert.throws(() => D.buildRequirements('park_cleanup', null, () => 'r'), /needs a task id/);
});

test('createTask builds an open task in the TaskResponse shape', () => {
  const task = D.createTask({
    id: 't', creatorId: 'alice', creatorName: 'Alice', templateId: 'flowerbed_care',
    communityId: 'c1', title: 'Saturday clean-up',
    place: { name: 'Meadow', latitude: '55.95', longitude: -3.19, source: 'manual' }
  });
  assert.deepEqual(Object.keys(task),
    ['id', 'title', 'creator', 'community_id', 'template_id', 'place', 'status',
      'requirements', 'coordination_ready', 'completion_eligible', 'outcome',
      'created_at', 'completed_at']);
  assert.equal(task.title, 'Saturday clean-up');
  assert.equal(task.status, 'open', "B's task status is open, not planning");
  assert.equal(task.community_id, 'c1');
  assert.deepEqual(task.creator, { id: 'alice', display_name: 'Alice' });
  assert.deepEqual(Object.keys(task.place),
    ['name', 'latitude', 'longitude', 'source', 'source_id']);
  assert.equal(task.place.latitude, 55.95, 'coordinates are JSON numbers, not strings');
  assert.equal(task.place.source, 'manual');
  assert.equal(task.place.source_id, null, 'unfilled values are null, not "" or 0');
  assert.equal(task.outcome, null, 'outcome is null until the organiser submits');
  assert.equal(task.coordination_ready, false);
  assert.equal(task.completion_eligible, false);
  assert.equal(task.completed_at, null);
  assert.match(task.created_at, /Z$/, 'timestamps are ISO 8601 UTC');
  assert.equal(task.requirements.length, 2);

  const bare = D.createTask({});
  assert.equal(bare.template_id, 'park_cleanup');
  assert.equal(bare.title, 'Park cleanup');
  assert.equal(bare.status, 'open');
  assert.deepEqual(bare.creator, { id: '', display_name: '' });
  assert.equal(bare.community_id, null);
  assert.equal(bare.place.source, 'manual');

  assert.throws(() => D.createTask({ templateId: 'cleanup' }), /Unknown task template/,
    'legacy template ids are not part of the vocabulary');
  assert.throws(() => D.createTask({ templateId: 'street_trees' }), /Unknown task template/);
  assert.throws(() => D.createTask({ templateId: 'nope' }), /Unknown task template/);
});

test('ensureRequirements migrates a pre-B task in place', () => {
  const legacy = {
    id: 'old', creator_id: 'alice', template_id: 'cleanup', postcode: 'EH8 9YL',
    place_name: 'Meadow', latitude: 55.94, longitude: -3.18, status: 'planning',
    self: ['gloves'], outcome_note: '',
    requirements: [
      { id: 'r1', task_id: 'old', category: 'picker', quantity: 1, slot: 1, slot_total: 1, source_type: 'loan', loan_request_id: null },
      { id: 'r2', task_id: 'old', category: 'rake', quantity: 1, slot: 1, slot_total: 1, source_type: 'loan', loan_request_id: null },
      { id: 'r3', task_id: 'old', category: 'gloves', quantity: 1, slot: 1, slot_total: 1, source_type: 'loan', loan_request_id: null }
    ],
    created_at: '2026-10-01T00:00:00Z'
  };
  assert.throws(() => D.ensureRequirements(null), /needs a task/);

  const result = D.ensureRequirements(legacy);
  assert.equal(result.migrated, true);
  assert.equal(result.task, legacy, 'the same object comes back');
  assert.equal(legacy.template_id, 'park_cleanup', 'cleanup maps onto the frozen template');
  assert.equal(legacy.status, 'open', 'planning is not a B status');
  assert.deepEqual(legacy.creator, { id: 'alice', display_name: 'alice' });
  assert.equal(legacy.title, 'Park cleanup');
  assert.equal(legacy.community_id, null);
  assert.deepEqual(legacy.place,
    { name: 'Meadow', latitude: 55.94, longitude: -3.18, source: 'manual', source_id: null });
  ['postcode', 'place_name', 'latitude', 'longitude', 'creator_id', 'self',
    'impact', 'outcome_note'].forEach(key =>
      assert.equal(key in legacy, false, key + ' is not part of TaskResponse'));
  assert.equal(legacy.outcome, null);

  assert.equal(legacy.requirements.length, 2, 'one row per template category');
  assert.deepEqual(legacy.requirements.map(r => r.category),
    ['litter_picker', 'reusable_gloves'], 'rake is gone, the rest are remapped');
  legacy.requirements.forEach(r => {
    assert.deepEqual(Object.keys(r),
      ['id', 'category', 'quantity', 'self_supplied', 'state', 'active_loan_id', 'candidate_tool_ids']);
    assert.equal(r.quantity, 1);
    ['slot', 'slot_total', 'source_type', 'task_id', 'loan_request_id'].forEach(key =>
      assert.equal(key in r, false, key + ' must not come back'));
  });
  const gloves = legacy.requirements.find(r => r.category === 'reusable_gloves');
  assert.equal(gloves.self_supplied, true, 'the old self: ["gloves"] choice survives');
  assert.equal(gloves.state, 'self_supplied');
  assert.equal(legacy.requirements.find(r => r.category === 'litter_picker').state, 'missing');
  assert.equal(legacy.coordination_ready, false);
  assert.equal(legacy.completion_eligible, true, 'missing does not block recording');

  assert.equal(D.ensureRequirements(legacy).migrated, false, 'a second pass is a no-op');
});

test('ensureRequirements converts legacy outcome figures into the B outcome block', () => {
  const legacy = {
    id: 'd', creator_id: 'alice', template_id: 'garden', status: 'completed',
    place_name: 'X', latitude: 1, longitude: 2,
    outcome_note: 'Nice work.',
    impact: { bags_collected: 3, participant_minutes: 90, would_have_bought_new: true },
    created_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-02T00:00:00Z',
    requirements: [
      { id: 'q1', category: 'spade', quantity: 1, slot: 1, slot_total: 1, source_type: 'loan', loan_request_id: null },
      { id: 'q2', category: 'gloves', quantity: 1, slot: 1, slot_total: 1, source_type: 'loan', loan_request_id: null },
      { id: 'q3', category: 'watering', quantity: 1, slot: 1, slot_total: 1, source_type: 'loan', loan_request_id: null }
    ]
  };
  const result = D.ensureRequirements(legacy);
  assert.equal(result.migrated, true);
  assert.equal(legacy.template_id, 'flowerbed_care', 'garden maps onto flowerbed_care');
  assert.deepEqual(legacy.requirements.map(r => r.category),
    ['hand_trowel', 'watering_can'],
    'categories are remapped and rows outside the frozen template are dropped');
  assert.equal(legacy.status, 'completed');
  assert.equal(legacy.completed_at, '2026-10-02T00:00:00Z');
  assert.deepEqual(legacy.outcome,
    { note: 'Nice work.', bags_collected: 3, volunteer_minutes: 90, verification: 'self_reported' });
  assert.equal('would_have_bought_new' in legacy.outcome, false, 'B dropped that figure');
  assert.equal('impact' in legacy, false);
  assert.equal('outcome_note' in legacy, false);
  assert.equal(D.ensureRequirements(legacy).migrated, false);
});

test('setTemplate switches between the two frozen templates and refuses while a loan is live', () => {
  const task = makeTask();
  assert.equal(D.setSlotSource(task, task.requirements[1].id, 'self').ok, true);

  const switched = D.setTemplate(task, 'flowerbed_care', {});
  assert.equal(switched.ok, true);
  assert.equal(task.template_id, 'flowerbed_care');
  assert.deepEqual(task.requirements.map(r => r.category), ['watering_can', 'hand_trowel']);
  assert.ok(task.requirements.every(r => !r.self_supplied),
    'the two templates share no category, so the old choice does not carry over');
  assert.deepEqual(D.setTemplate(task, 'cleanup', {}),
    { ok: false, reason: 'unknown_template' });

  // A live request blocks the switch...
  const t2 = makeTask({ id: 'task2' });
  assert.equal(D.setTemplate(t2, 'flowerbed_care', {}).ok, true);
  const created = D.createLoanRequest(tool('w1', 'bob', 'watering_can'), t2, t2.requirements[0],
    'alice', () => 'L1', { loans: [], tools: [] });
  assert.equal(created.ok, true);
  const active = [created.request];
  assert.deepEqual(D.setTemplate(t2, 'park_cleanup', { loans: active }),
    { ok: false, reason: 'active_requests' });
  assert.equal(t2.template_id, 'flowerbed_care', 'the task is untouched when the switch is refused');

  // ...but a finished one does not.
  active[0].status = 'returned';
  active[0].handed_over_at = '2026-10-03T11:00:00Z';
  active[0].returned_at = '2026-10-03T11:00:00Z';
  assert.equal(D.setTemplate(t2, 'park_cleanup', { loans: active }).ok, true);
  assert.deepEqual(t2.requirements.map(r => r.category), ['litter_picker', 'reusable_gloves']);

  t2.status = 'completed';
  assert.deepEqual(D.setTemplate(t2, 'flowerbed_care', { loans: [] }),
    { ok: false, reason: 'task_completed' });
});

test('setSlotSource flips self_supplied and refuses locked requirements', () => {
  const task = makeTask();
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');
  const picker = task.requirements.find(r => r.category === 'litter_picker');

  assert.deepEqual(D.setSlotSource(task, 'nope', 'self'), { ok: false, reason: 'unknown_slot' });
  assert.deepEqual(D.setSlotSource(task, gloves.id, 'maybe'),
    { ok: false, reason: 'unknown_source' });

  assert.deepEqual(D.setSlotSource(task, gloves.id, 'self'), { ok: true, requirement: gloves });
  assert.equal(gloves.self_supplied, true);
  assert.equal(gloves.state, 'self_supplied');
  assert.deepEqual(gloves.candidate_tool_ids, [], 'a self-supplied row carries no candidates');
  assert.equal(task.coordination_ready, false, 'the picker requirement is still missing');

  assert.equal(D.setSlotSource(task, gloves.id, 'loan').ok, true);
  assert.equal(gloves.self_supplied, false);
  assert.equal(gloves.state, 'missing');

  // A live request locks it (REQUIREMENT_LOCKED)...
  picker.active_loan_id = 'L1';
  picker.state = 'pending';
  assert.deepEqual(D.setSlotSource(task, picker.id, 'self'),
    { ok: false, reason: 'requirement_locked' });
  // ...and so does an actual borrowing history.
  picker.active_loan_id = null;
  picker.state = 'fulfilled';
  assert.deepEqual(D.setSlotSource(task, picker.id, 'self'),
    { ok: false, reason: 'requirement_locked' });
});

/* --------------------------------------------------------------- matching */

test('matchTools only offers available tools owned by someone else', () => {
  const task = makeTask();
  const tools = [
    tool('mine', 'alice', 'litter_picker'),        // the creator's own tool
    tool('bobs', 'bob', 'litter_picker'),
    tool('taken', 'cara', 'litter_picker', 'reserved'),
    tool('out', 'dan', 'litter_picker', 'on_loan'),
    tool('arch', 'eve', 'litter_picker', 'available', { is_archived: true }),
    tool('legacy', 'fred', 'picker'),              // pre-B slug, tolerated for display
    tool('gloves', 'bob', 'reusable_gloves'),
    tool('rake', 'bob', 'rake')                    // category removed in B
  ];
  const found = D.matchTools('litter_picker', ctx(task, tools, []));
  assert.deepEqual(found.map(f => f.toolId), ['bobs', 'legacy'],
    'only available, in-community tools from other people; closer/older first');
  assert.equal(found[0].ownerName, 'Bob');
  assert.equal(found[0].scope, 'same_community');
  assert.equal(found[0].category, 'litter_picker');
  assert.equal(found[0].communityId, 'c1');
  assert.equal(found[0].postcode, 'EH8 9YL');
  assert.equal(found[0].toolId, 'bobs');

  // The viewer's own tool never comes back either (SELF_BORROW_FORBIDDEN).
  assert.deepEqual(
    D.matchTools('litter_picker', ctx(task, [tool('caras', 'cara', 'litter_picker')], [], { viewerId: 'cara' })),
    []);
  // An unknown category matches nothing.
  assert.deepEqual(D.matchTools('rake', ctx(task, tools, [])), []);
});

test('matchTools prefers the same community, then distance, and hides far-away tools', () => {
  const task = makeTask();
  const same = tool('same', 'bob', 'litter_picker');
  const near = tool('near', 'cara', 'litter_picker', 'available', { community: C2 });
  const far = tool('far', 'dan', 'litter_picker', 'available', { community: FAR });

  assert.deepEqual(D.matchTools('litter_picker', ctx(task, [far, near, same], [])).map(f => f.toolId),
    ['same'], 'the same community wins outright');

  const noSame = D.matchTools('litter_picker', ctx(task, [far, near], []));
  assert.deepEqual(noSame.map(f => f.toolId), ['near'], 'the 1 km neighbour beats the distant one');
  assert.equal(noSame[0].scope, 'nearby');
  assert.ok(noSame[0].distanceKm > 0.8 && noSame[0].distanceKm < 1.1,
    'straight-line haversine distance, got ' + noSame[0].distanceKm);

  assert.deepEqual(D.matchTools('litter_picker', ctx(task, [far], [])), [],
    'out of range is not a neighbourhood match');
  const optIn = D.matchTools('litter_picker', ctx(task, [far], [], { allowElsewhere: true }));
  assert.deepEqual(optIn.map(f => f.toolId), ['far'], 'a wider radius is opt-in only');
  assert.equal(optIn[0].scope, 'elsewhere');

  // Without coordinates the server's distance_m decides.
  const noCoords = tool('d1', 'bob', 'litter_picker', 'available',
    { community: community('c4', 'ZZ1 1ZZ', null, null), distance_m: 1500 });
  assert.deepEqual(
    D.matchTools('litter_picker', ctx(task, [noCoords], [])).map(f => [f.toolId, f.scope, f.distanceKm]),
    [['d1', 'nearby', 1.5]]);

  // Sorted closest first within the tier.
  const near2 = tool('near2', 'dan', 'litter_picker', 'available',
    { community: community('c5', 'EH9 1AA', 55.95, -3.185) });
  assert.deepEqual(D.matchTools('litter_picker', ctx(task, [near, near2], [])).map(f => f.toolId),
    ['near2', 'near'], 'closer neighbour first');
});

test('nearbyPostcodes accepts an outcode as well as a full postcode', () => {
  const task = makeTask();
  const inDistrict = tool('eh7', 'cara', 'litter_picker', 'available',
    { community: community('c7', 'EH7 4AB', null, null) });
  const nextDistrict = tool('eh9', 'dan', 'litter_picker', 'available',
    { community: community('c9', 'EH9 1AA', null, null) });

  // Member C holds outcodes from Postcodes.io /outcodes/{outcode}/nearest.
  const found = D.matchTools('litter_picker', ctx(task, [nextDistrict, inDistrict], [],
    { nearbyPostcodes: ['EH7'] }));
  assert.deepEqual(found.map(f => f.toolId), ['eh7'], 'an outcode covers every postcode inside it');
  assert.equal(found[0].scope, 'nearby');

  assert.deepEqual(
    D.matchTools('litter_picker', ctx(task, [inDistrict], [], { nearbyPostcodes: ['EH7 4AB'] })).map(f => f.toolId),
    ['eh7'], 'a full postcode works too');
  assert.deepEqual(
    D.matchTools('litter_picker', ctx(task, [nextDistrict], [], { nearbyPostcodes: ['EH7'] })),
    [], 'an outcode must not leak into other districts');

  assert.equal(D.outwardCode('eh89yl'), 'EH8');
  assert.equal(D.outwardCode('EH7 4AB'), 'EH7');
  assert.equal(D.outwardCode('EH7'), 'EH7');
  assert.equal(D.outwardCode(''), '');
});

test('candidateToolIds carries at most five ids, like the backend', () => {
  const task = makeTask();
  const tools = [];
  for (let i = 0; i < 7; i += 1) tools.push(tool('g' + i, 'owner' + i, 'reusable_gloves'));
  const row = D.describeTask(task, ctx(task, tools, []))
    .find(r => r.category === 'reusable_gloves');
  assert.equal(row.state, 'match_available');
  assert.equal(row.candidateToolIds.length, 5, 'CANDIDATE_LIMIT is 5');
  row.candidateToolIds.forEach(id => assert.ok(tools.some(t => t.id === id)));
  assert.deepEqual(task.requirements.find(r => r.category === 'reusable_gloves').candidate_tool_ids,
    [], 'describing never writes back; syncRequirements does that');
});

/* -------------------------------------------------------- requirement states */

test('a requirement walks pending -> confirmed -> in_use -> fulfilled', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');
  const tools = [tool('p1', 'bob', 'litter_picker')];
  const loans = [];
  const context = () => ctx(task, tools, loans);
  const row = () => D.describeTask(task, context()).find(r => r.requirementId === picker.id);

  // 0. no claim yet, but a neighbour's tool exists
  assert.equal(row().state, 'match_available');
  assert.equal(row().confirmed, false);
  assert.equal(row().pending, false);
  assert.match(row().statusText, /Available to request from Bob/);
  assert.deepEqual(row().tools.map(t => t.toolId), ['p1']);
  assert.equal(D.describeTask(task, context()).find(r => r.requirementId === gloves.id).state,
    'missing');

  // 1. request sent
  const created = D.createLoanRequest(tools[0], task, picker, 'alice', () => 'loanA', context());
  assert.equal(created.ok, true);
  loans.push(created.request);
  assert.equal(row().state, 'pending');
  assert.equal(row().pending, true);
  assert.equal(row().confirmed, false);
  assert.equal(row().stage, 'requested');
  assert.equal(row().activeLoanId, 'loanA');
  assert.equal(D.LOAN_STAGES.pending.availability, 'reserved');
  assert.deepEqual(row().tools, [], 'a pending requirement offers no second request');
  assert.match(row().statusText, /Awaiting Bob to respond/);

  // 2. reservation accepted
  loans[0].status = 'accepted';
  loans[0].accepted_at = '2026-10-03T10:12:00Z';
  assert.equal(row().state, 'confirmed');
  assert.equal(row().confirmed, true);
  assert.equal(row().stage, 'reserved');
  assert.equal(D.LOAN_STAGES.accepted.availability, 'reserved');
  assert.match(row().statusText, /reservation accepted by Bob/);

  // 3. handed over
  loans[0].status = 'on_loan';
  loans[0].handed_over_at = '2026-10-03T10:20:00Z';
  assert.equal(row().state, 'in_use');
  assert.equal(row().stage, 'handed_over');
  assert.equal(D.LOAN_STAGES.on_loan.availability, 'on_loan');
  assert.match(row().statusText, /handed over by Bob/);

  // 4. returned -> fulfilled (B keeps the history as fulfilment, not a reset)
  loans[0].status = 'returned';
  loans[0].returned_at = '2026-10-03T11:00:00Z';
  const done = row();
  assert.equal(done.state, 'fulfilled');
  assert.equal(done.confirmed, true);
  assert.equal(done.stage, 'fulfilled');
  assert.equal(done.history.length, 1);
  assert.equal(done.loans.length, 1);
  assert.equal(D.LOAN_STAGES.returned.availability, 'available');
  assert.match(done.statusText, /Fulfilled/);
  assert.equal(D.slotIsClaimed(task, picker, context()), true,
    'a fulfilled requirement stays occupied — REQUIREMENT_ALREADY_FULFILLED');

  // describeRequirement can also be driven directly, sharing one claim pass.
  const claims = D.claimLoans(task.requirements, loans, tools);
  const direct = D.describeRequirement(picker, context(), claims);
  assert.equal(direct.state, 'fulfilled');
  assert.equal(direct.requirement, picker);
  assert.equal(direct.label, 'Litter picker');
  assert.equal(direct.taskId, undefined, 'taskId is added by describeTask');
});

test('a server-sent requirement row is trusted when no loan records are available', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');

  // The API hides active_loan_id from strangers but keeps the derived state.
  picker.state = 'confirmed';
  picker.active_loan_id = null;
  const withoutLoans = D.describeTask(task, { task, tools: [], names: OWNERS });
  assert.equal(withoutLoans.find(r => r.requirementId === picker.id).state, 'confirmed');
  assert.equal(withoutLoans.find(r => r.requirementId === picker.id).confirmed, true);
  const withEmptyLoans = D.describeTask(task, { task, tools: [], loans: [], names: OWNERS });
  assert.equal(withEmptyLoans.find(r => r.requirementId === picker.id).state, 'confirmed',
    'an empty loan list does not override the server row either');

  // ...and stored candidates survive when we cannot see the tools ourselves.
  gloves.state = 'match_available';
  gloves.candidate_tool_ids = ['t9'];
  const row = D.describeTask(task, { task, tools: [], loans: [], names: OWNERS })
    .find(r => r.requirementId === gloves.id);
  assert.equal(row.state, 'match_available');
  assert.deepEqual(row.candidateToolIds, ['t9']);
});

test('bringing your own is self_supplied and never a claim on a neighbour', () => {
  const task = makeTask();
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');
  assert.equal(D.setSlotSource(task, gloves.id, 'self').ok, true);

  const row = D.describeTask(task, ctx(task, [], [])).find(r => r.requirementId === gloves.id);
  assert.equal(row.state, 'self_supplied');
  assert.equal(row.selfSupplied, true);
  assert.equal(row.confirmed, true, 'self-supplied counts as coordination-ready');
  assert.equal(row.stage, 'self');
  assert.match(row.statusText, /bringing your own/);

  assert.equal(D.slotIsClaimed(task, gloves, ctx(task, [], [])), false,
    'it occupies no neighbour tool, so it is not a claim');
  assert.deepEqual(
    D.createLoanRequest(tool('p1', 'bob', 'reusable_gloves'), task, gloves, 'alice', () => 'L1', ctx(task, [], [])),
    { ok: false, reason: 'slot_is_self_provided' });

  const flags = D.taskFlags(task, ctx(task, [], []));
  assert.deepEqual(flags, { coordination_ready: false, completion_eligible: true },
    'a missing requirement never blocks recording');
});

test('slotIsClaimed follows the frozen states and a declined request releases the requirement', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  const tools = [tool('p1', 'bob', 'litter_picker'), tool('p2', 'cara', 'litter_picker')];
  const loans = [];
  const context = () => ctx(task, tools, loans);

  // No loan data at all -> the conservative pointer answer.
  assert.equal(D.slotIsClaimed(task, picker, {}), false);
  picker.active_loan_id = 'L9';
  picker.state = 'pending';
  assert.equal(D.slotIsClaimed(task, picker, {}), true, 'trust the stored active_loan_id');
  picker.active_loan_id = null;
  picker.state = 'missing';

  const first = D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1', context());
  assert.equal(first.ok, true);
  loans.push(first.request);
  assert.equal(D.slotIsClaimed(task, picker, context()), true, 'pending claims it');
  assert.equal(D.createLoanRequest(tools[1], task, picker, 'alice', () => 'L2', context()).reason,
    'slot_already_claimed');

  loans[0].status = 'accepted';
  assert.equal(D.slotIsClaimed(task, picker, context()), true, 'accepted counts');
  loans[0].status = 'on_loan';
  assert.equal(D.slotIsClaimed(task, picker, context()), true, 'in_use counts');

  loans[0].status = 'rejected';
  loans[0].rejected_at = '2026-10-03T10:30:00Z';
  assert.equal(D.slotIsClaimed(task, picker, context()), false,
    'a declined request releases it, pointer or not');
  const again = D.createLoanRequest(tools[1], task, picker, 'alice', () => 'L2', context());
  assert.equal(again.ok, true, 'a second request can take over');
  loans.push(again.request);
  loans[1].status = 'cancelled';
  loans[1].cancelled_at = '2026-10-03T10:40:00Z';
  assert.equal(D.slotIsClaimed(task, picker, context()), false, 'and so does a cancelled one');
  assert.deepEqual(
    D.describeTask(task, context()).find(r => r.requirementId === picker.id).loans, [],
    'rejected / cancelled requests are never carried');
});

test('claimLoans groups loans by requirement_id and forgets declined ones', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');
  const tools = [tool('p1', 'bob', 'litter_picker')];
  const loans = [
    loan('L1', { requirement_id: picker.id, status: 'pending', created_at: '2026-01-01T00:00:00Z' }),
    loan('L2', { requirement_id: picker.id, status: 'accepted', created_at: '2026-01-02T00:00:00Z' }),
    loan('L3', { requirement_id: picker.id, status: 'rejected' }),
    loan('L4', { requirement_id: gloves.id, status: 'returned', handed_over_at: '2026-01-03T00:00:00Z', returned_at: '2026-01-03T01:00:00Z' }),
    loan('L5', { requirement_id: null, status: 'pending' }),   // standalone loan (spec 8.4)
    loan('L6', { requirement_id: 'ghost', status: 'pending' }) // another task's requirement
  ];
  const claims = D.claimLoans(task.requirements, loans, tools); // an array works, not just a Map
  assert.deepEqual(claims.get(picker.id).map(i => i.request.id), ['L1', 'L2']);
  assert.deepEqual(claims.get(gloves.id).map(i => i.request.id), ['L4'],
    'returned stays: it is what fulfils the requirement');
  assert.equal(claims.get(picker.id)[0].tool.id, 'p1');
  assert.ok(!Array.from(claims.keys()).includes('ghost'));

  // requirement_id decides membership; orphans are never auto-assigned to a slot.
  const empty = D.claimLoans(task.requirements, [loan('L7', { requirement_id: null })], new Map());
  assert.deepEqual(empty.get(picker.id), []);
  assert.deepEqual(D.claimLoans(task.requirements, [], undefined).get(picker.id), []);
});

/* ---------------------------------------------------------------- progress */

test('taskProgress rolls requirements into one honest figure', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');
  const tools = [tool('p1', 'bob', 'litter_picker')];
  const loans = [];

  let p = D.taskProgress(task, ctx(task, tools, loans));
  assert.deepEqual([p.total, p.confirmed, p.pending, p.missing, p.percent],
    [2, 0, 0, 2, 0]);
  assert.equal(p.complete, false);
  assert.equal(p.coordinationReady, false);
  assert.equal(p.completionEligible, true, 'two missing requirements are still recordable');
  assert.deepEqual(p.missingCategories, ['litter_picker', 'reusable_gloves']);
  assert.match(p.nextAction, /Find a neighbour with the first tool/);

  loans.push(D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1',
    ctx(task, tools, loans)).request);
  p = D.taskProgress(task, ctx(task, tools, loans));
  assert.deepEqual([p.pending, p.missing], [1, 2], 'pending is not confirmed');
  assert.match(p.nextAction, /2 tools still to confirm/);

  assert.equal(D.setSlotSource(task, gloves.id, 'self').ok, true);
  p = D.taskProgress(task, ctx(task, tools, loans));
  assert.deepEqual([p.confirmed, p.missing, p.percent], [1, 1, 50]);
  assert.match(p.nextAction, /1 tool still to confirm/);

  loans[0].status = 'accepted';
  loans[0].accepted_at = '2026-10-03T10:12:00Z';
  p = D.taskProgress(task, ctx(task, tools, loans));
  assert.deepEqual([p.confirmed, p.missing, p.percent, p.complete], [2, 0, 100, true]);
  assert.equal(p.coordinationReady, true);
  assert.equal(p.completionEligible, false,
    'an accepted reservation still has to be handed over before the outcome can be recorded');
  assert.match(p.nextAction, /Arrange the handover/);

  loans[0].status = 'on_loan';
  loans[0].handed_over_at = '2026-10-03T10:20:00Z';
  p = D.taskProgress(task, ctx(task, tools, loans));
  assert.equal(p.completionEligible, true);
  assert.match(p.nextAction, /Record the outcome/);

  task.status = 'completed';
  p = D.taskProgress(task, ctx(task, tools, loans));
  assert.match(p.nextAction, /Action recorded/);
});

test('the wanted board counts requirements nobody can cover yet', () => {
  const a = makeTask({ id: 'a' });
  const b = makeTask({ id: 'b' });
  assert.equal(D.setSlotSource(b, b.requirements.find(r => r.category === 'reusable_gloves').id, 'self').ok, true);
  const done = makeTask({ id: 'c', status: 'completed' });
  const context = tools => ({ task: a, tools, loans: [], names: OWNERS, viewerId: 'zoe' });

  const board = D.wantedBoard([a, b, done], context([]));
  assert.equal(board.find(e => e.category === 'litter_picker').slots, 2,
    'two neighbours both still need a picker');
  assert.equal(board.find(e => e.category === 'litter_picker').taskCount, 2);
  assert.equal(board.find(e => e.category === 'reusable_gloves').slots, 1,
    'task b brings its own gloves');
  assert.ok(!board.some(e => e.taskIds.includes('c')), 'completed actions leave the board');

  // Publishing matching tools closes the gaps before anybody has borrowed them.
  const after = D.wantedBoard([a, b, done],
    context([tool('p1', 'bob', 'litter_picker'), tool('g1', 'bob', 'reusable_gloves')]));
  assert.deepEqual(after, []);
});

/* ------------------------------------------------------------------ impact */

test('impactReport counts each metric separately and drops the bought-new figure', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');
  assert.equal(D.setSlotSource(task, gloves.id, 'self').ok, true);
  const tools = [tool('p1', 'bob', 'litter_picker')];
  const loans = [D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1',
    { tools, loans: [], names: OWNERS }).request];
  const opts = () => ({ tools, loans, names: OWNERS });

  let report = D.impactReport([task], loans, opts());
  let by = Object.fromEntries(report.metrics.map(m => [m.key, m]));
  assert.deepEqual(Object.keys(by).sort(),
    ['actions_with_tools_confirmed', 'bags_collected', 'completed_actions',
      'completed_loans', 'volunteer_minutes'],
    'five metrics; participant_minutes and would_have_bought_new are gone');
  assert.equal(by.completed_loans.value, 0);
  assert.equal(by.actions_with_tools_confirmed.value, 0,
    'a pending request has not confirmed anything');
  assert.equal(by.completed_actions.value, 0);
  assert.equal(by.bags_collected.available, false,
    'unreported figures show "not collected yet", never 0');
  assert.equal(by.volunteer_minutes.available, false);
  assert.ok(report.metrics.every(m => m.caveat && m.source && m.basis && m.scope === report.scope));
  assert.equal(report.scope, 'all recorded data');
  assert.equal(typeof report.disclaimer, 'string');
  assert.ok(!/bought/i.test(report.disclaimer), 'no bought-new wording anywhere');

  loans[0].status = 'returned';
  loans[0].handed_over_at = '2026-10-03T11:00:00Z';
  loans[0].returned_at = '2026-10-03T11:00:00Z';
  D.applyOutcome(task, {
    note: 'Cleared two bin bags by the path.',
    bags_collected: '2', volunteer_minutes: '45',
    completedAt: '2026-10-03T12:00:00Z'
  });

  report = D.impactReport([task], loans, opts());
  by = Object.fromEntries(report.metrics.map(m => [m.key, m]));
  assert.equal(by.completed_loans.value, 1);
  assert.equal(by.actions_with_tools_confirmed.value, 1,
    'self-supplied gloves plus a returned loan cover everything');
  assert.equal(by.completed_actions.value, 1);
  assert.equal(by.bags_collected.value, 2);
  assert.equal(by.bags_collected.available, true);
  assert.equal(by.volunteer_minutes.value, 45);
  assert.equal(task.status, 'completed');
  assert.equal(task.completed_at, '2026-10-03T12:00:00Z');

  // Scoping by community keeps other neighbourhoods out.
  const elsewhere = makeTask({ id: 'other', community_id: 'c2', status: 'completed' });
  D.applyOutcome(elsewhere, { note: 'Elsewhere.', bags_collected: 99, completedAt: '2026-10-03T12:00:00Z' });
  const scoped = D.impactReport([task, elsewhere], loans, Object.assign(opts(), { communityId: 'c1' }));
  const scopedBy = Object.fromEntries(scoped.metrics.map(m => [m.key, m]));
  assert.equal(scopedBy.bags_collected.value, 2, "c2's 99 bags stay out of c1's report");
  assert.equal(scopedBy.completed_actions.value, 1);
  assert.equal(scoped.scope, 'this community');
  assert.equal(scoped.communityId, 'c1');
});

test('applyOutcome writes the B outcome block and ignores bought-new', () => {
  const task = makeTask();
  D.applyOutcome(task, {
    note: 'Done.', bags_collected: '3', volunteer_minutes: '90',
    would_have_bought_new: true, completedAt: '2026-10-03T11:30:00Z'
  });
  assert.equal(task.status, 'completed');
  assert.equal(task.completed_at, '2026-10-03T11:30:00Z');
  assert.deepEqual(task.outcome,
    { note: 'Done.', bags_collected: 3, volunteer_minutes: 90, verification: 'self_reported' });
  assert.equal('would_have_bought_new' in task.outcome, false, 'B dropped that figure');
  assert.equal('impact' in task, false);
  assert.equal('outcome_note' in task, false);

  // The legacy field name still lands on the new one.
  const t2 = makeTask({ id: 'task2' });
  D.applyOutcome(t2, { note: 'Second run.', participant_minutes: '30' });
  assert.equal(t2.outcome.volunteer_minutes, 30);
  assert.equal(t2.outcome.bags_collected, null, 'unfilled stays null, not 0');

  // Re-submitting keeps figures the organiser did not change.
  D.applyOutcome(t2, { note: 'Corrected.' });
  assert.deepEqual(t2.outcome,
    { note: 'Corrected.', bags_collected: null, volunteer_minutes: 30, verification: 'self_reported' });
});

test('outcomeReadiness mirrors the backend completion gate and only warns about returns', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');
  const tools = [tool('p1', 'bob', 'litter_picker')];
  const loans = [];
  const context = () => ctx(task, tools, loans);

  let ready = D.outcomeReadiness(task, context());
  assert.equal(ready.canSubmit, true, 'missing tools never block recording');
  assert.equal(ready.unconfirmedRequirements, 2);
  assert.equal(ready.warning, null, 'no unresolved request, no gate warning');

  loans.push(D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1', context()).request);
  assert.equal(D.setSlotSource(task, gloves.id, 'self').ok, true);
  loans[0].status = 'accepted';
  loans[0].accepted_at = '2026-10-03T10:12:00Z';
  ready = D.outcomeReadiness(task, context());
  assert.equal(ready.coordinationReady, true, 'accepted counts for coordination');
  assert.equal(ready.completionEligible, false,
    'but not for completion: the handover has not happened');
  assert.equal(ready.canSubmit, false);
  assert.equal(ready.unconfirmedRequirements, 0);

  loans[0].status = 'on_loan';
  loans[0].handed_over_at = '2026-10-03T10:20:00Z';
  ready = D.outcomeReadiness(task, context());
  assert.equal(ready.canSubmit, true);
  assert.equal(ready.outstandingReturns, 1);
  assert.match(ready.warning, /Returns are tracked separately/);

  D.applyOutcome(task, { note: 'Recorded.', completedAt: '2026-10-03T12:00:00Z' });
  ready = D.outcomeReadiness(task, context());
  assert.equal(ready.canSubmit, false, 'a completed task cannot be submitted again');
});

/* ------------------------------------------------------------------ loans */

test('createLoanRequest mirrors the backend guards and stamps the requirement', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');

  assert.deepEqual(D.createLoanRequest(tool('p1', 'bob', 'litter_picker', 'reserved'),
    task, picker, 'alice', () => 'x', { loans: [], tools: [] }),
    { ok: false, reason: 'tool_unavailable' });
  assert.deepEqual(D.createLoanRequest(tool('p2', 'bob', 'litter_picker', 'on_loan'),
    task, picker, 'alice', () => 'x', { loans: [], tools: [] }),
    { ok: false, reason: 'tool_unavailable' });
  assert.deepEqual(D.createLoanRequest(tool('p3', 'bob', 'litter_picker', 'available', { is_archived: true }),
    task, picker, 'alice', () => 'x', { loans: [], tools: [] }),
    { ok: false, reason: 'tool_unavailable' });
  assert.deepEqual(D.createLoanRequest(tool('p4', 'alice', 'litter_picker'),
    task, picker, 'alice', () => 'x', { loans: [], tools: [] }),
    { ok: false, reason: 'self_borrow_forbidden' }, 'SELF_BORROW_FORBIDDEN, mirrored');

  assert.equal(D.setSlotSource(task, gloves.id, 'self').ok, true);
  assert.deepEqual(D.createLoanRequest(tool('p5', 'bob', 'reusable_gloves'),
    task, gloves, 'alice', () => 'x', { loans: [], tools: [] }),
    { ok: false, reason: 'slot_is_self_provided' });

  const context = { loans: [], tools: [] };
  const created = D.createLoanRequest(tool('p6', 'bob', 'litter_picker'),
    task, picker, 'alice', () => 'L1', context);
  assert.equal(created.ok, true);
  const l = created.request;
  assert.deepEqual(Object.keys(l),
    ['id', 'tool_id', 'tool_name', 'owner_id', 'borrower_id', 'requirement_id', 'task_id',
      'status', 'note', 'created_at', 'updated_at', 'accepted_at', 'handed_over_at',
      'returned_at', 'rejected_at', 'cancelled_at'], 'LoanResponse shape');
  assert.equal(l.tool_name, 'p6 tool');
  assert.equal(l.owner_id, 'bob');
  assert.equal(l.borrower_id, 'alice');
  assert.equal(l.requirement_id, picker.id);
  assert.equal(l.task_id, task.id);
  assert.equal(l.status, 'pending');
  assert.equal(l.note, '');
  assert.match(l.created_at, /Z$/);
  assert.equal(l.accepted_at, null);
  assert.equal(picker.active_loan_id, 'L1', 'the requirement is stamped');
  assert.equal(picker.state, 'pending');
  assert.deepEqual(picker.candidate_tool_ids, []);

  context.loans.push(l);
  assert.equal(D.createLoanRequest(tool('p7', 'cara', 'litter_picker'),
    task, picker, 'alice', () => 'L2', context).reason, 'slot_already_claimed');

  // A standalone loan (no requirement) is allowed by design (spec 8.4).
  const solo = D.createLoanRequest(tool('p8', 'cara', 'litter_picker'),
    task, null, 'alice', () => 'L3', context);
  assert.equal(solo.ok, true);
  assert.equal(solo.request.requirement_id, null);
});

/* -------------------------------------------------------- derived bookkeeping */

test('syncRequirements stores the derived state the backend would send', () => {
  const task = makeTask();
  const tools = [tool('p1', 'bob', 'litter_picker')];
  const gloves = task.requirements.find(r => r.category === 'reusable_gloves');
  const picker = task.requirements.find(r => r.category === 'litter_picker');
  assert.equal(D.setSlotSource(task, gloves.id, 'self').ok, true);

  D.syncRequirements(task, { task, tools, loans: [], names: OWNERS });
  assert.equal(picker.state, 'match_available');
  assert.deepEqual(picker.candidate_tool_ids, ['p1']);
  assert.equal(gloves.state, 'self_supplied');
  assert.deepEqual(D.taskFlags(task, { task, tools, loans: [], names: OWNERS }),
    { coordination_ready: false, completion_eligible: true });

  const loans = [D.createLoanRequest(tools[0], task, picker, 'alice', () => 'L1',
    { task, tools, loans: [], names: OWNERS }).request];
  loans[0].status = 'returned';
  loans[0].handed_over_at = '2026-10-03T11:00:00Z';
  loans[0].returned_at = '2026-10-03T11:00:00Z';
  D.syncRequirements(task, { task, tools, loans, names: OWNERS });
  assert.equal(picker.state, 'fulfilled');
  assert.equal(picker.active_loan_id, null, 'a returned loan is history, not a pointer');
  assert.deepEqual(D.taskFlags(task, {}),
    { coordination_ready: true, completion_eligible: true });
  assert.equal(task.coordination_ready, true, 'the flags are written back');
  assert.equal(task.completion_eligible, true);
});

/* ----------------------------------------------------------------- helpers */

test('the small exported helpers agree with the states they summarise', () => {
  const task = makeTask();
  const picker = task.requirements.find(r => r.category === 'litter_picker');

  assert.equal(D.hasActiveClaim(task.requirements), false);
  picker.active_loan_id = 'L1';
  picker.state = 'pending';
  assert.equal(D.hasActiveClaim(task.requirements), true);

  assert.equal(D.coveredSlots(task, { task, tools: [], loans: [] }), 0,
    'a pending request is not yet covered');
  assert.equal(D.loanCoveredSlots(task, { task, tools: [], loans: [] }), 0);

  assert.equal(D.canChangeTemplate(task, { loans: [] }), true);
  assert.equal(D.canChangeTemplate({ id: 'x', status: 'completed' }, { loans: [] }), false);
  assert.equal(D.canChangeTemplate(task, { loans: [{ task_id: 'task1', status: 'pending' }] }), false);
  assert.equal(D.canChangeTemplate(task, { loans: [{ task_id: 'task1', status: 'returned' }] }), true);

  assert.equal(D.emptyOutcome(), null, 'TaskResponse.outcome is null before submission');
  assert.deepEqual(D.emptyImpact(),
    { note: '', bags_collected: null, volunteer_minutes: null, verification: 'self_reported' });
  assert.deepEqual(D.clone({ a: [1] }), { a: [1] });
  assert.deepEqual(D.deriveRequirement({ id: 'r', category: 'litter_picker', state: 'missing' }, { tools: [], loans: [] }),
    { state: 'missing', activeLoanId: null, activeLoan: null, candidateToolIds: [] });
});

test('postcode, distance and label helpers behave', () => {
  assert.equal(D.normalisePostcode('eh89yl'), 'EH8 9YL');
  assert.equal(D.normalisePostcode('EH8  9YL'), 'EH8 9YL');
  assert.equal(D.normalisePostcode('  eh8-9yl '), 'EH8 9YL');
  assert.equal(D.normalisePostcode('GIR0AA'), 'GIR 0AA');
  assert.equal(D.normalisePostcode(''), '');
  assert.equal(D.normalisePostcode(null), '');
  assert.equal(D.normalisePostcode('AB1'), 'AB1');
  assert.equal(D.outwardCode('EH8 9YL'), 'EH8');

  const d = D.haversineKm(55.9445, -3.1883, 51.5074, -0.1278); // Edinburgh -> London
  assert.ok(d > 520 && d < 545, 'expected ~534 km, got ' + d);
  assert.equal(D.haversineKm(55.9445, -3.1883, 55.9445, -3.1883), 0);

  assert.equal(D.categoryLabel('watering_can'), 'Watering can');
  assert.equal(D.categoryLabel('watering'), 'Watering can', 'legacy slugs still get a label');
  assert.equal(D.categoryLabel('litter_picker'), 'Litter picker');
  assert.equal(D.categoryLabel(''), 'Unknown tool');

  assert.ok(D.DISCLAIMER.length > 0);
  assert.ok(!/bought/i.test(D.DISCLAIMER), 'the bought-new phrasing is gone');
});
