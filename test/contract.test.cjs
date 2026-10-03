/* Member D — the public contract that docs/handoff/*.md promises to B, C and A,
 * locked to the frozen B backend vocabulary (backend/app/schemas_*.py +
 * backend/docs/API_SAMPLES.md).
 *
 * These tests exist so the handoff documents cannot silently rot: if a rename
 * happens here, the doc that promised the old name fails loudly instead of
 * misleading whoever is integrating.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../web/task-module.js');

const DOCS = path.resolve(__dirname, '..', 'docs', 'handoff');
const readDoc = name => fs.readFileSync(path.join(DOCS, name), 'utf8');

test('every function the handoff docs tell B/C/A to call is exported', () => {
  const promised = [
    'createTask', 'ensureRequirements', 'setTemplate', 'setSlotSource',
    'matchTools', 'claimLoans', 'describeTask', 'describeRequirement',
    'taskProgress', 'wantedBoard', 'slotIsClaimed', 'createLoanRequest',
    'impactReport', 'applyOutcome', 'outcomeReadiness',
    'normalisePostcode', 'outwardCode', 'categoryLabel', 'haversineKm'
  ];
  promised.forEach(name => assert.equal(typeof D[name], 'function', `${name}() is promised to integrators`));

  ['CATEGORIES', 'TEMPLATES', 'TEMPLATE_LIST', 'TOOL_STATUS', 'LOAN_ACTIVE',
    'LOAN_CONFIRMED', 'LOAN_CLOSED', 'LOAN_STAGES', 'DISCLAIMER']
    .forEach(name => assert.ok(D[name], `${name} is promised to integrators`));
});

test('every name the docs quote appears in the docs it belongs to', () => {
  const a = readDoc('A-ui-boundary.md');
  ['D.describeTask', 'D.taskProgress', 'D.wantedBoard', 'D.impactReport',
    'requirementId', 'statusText', 'nextAction', 'data-req', 'data-self',
    'data-template', '#complete-task', '#outcome-note', '#impact-bags',
    '#impact-minutes', '#place-name']
    .forEach(token => assert.ok(a.includes(token), `A-ui-boundary.md should mention ${token}`));
  assert.ok(!a.includes('#impact-bought-new'), 'A-ui-boundary.md must not resurrect the dropped bought-new field');

  const b = readDoc('B-data-layer.md');
  ['requirement_id', 'self_supplied', 'availability', 'outcome',
    'bags_collected', 'volunteer_minutes', 'coordination_ready',
    'completion_eligible', 'candidate_tool_ids', 'Idempotency-Key', '/api/v1']
    .forEach(token => assert.ok(b.includes(token), `B-data-layer.md should mention ${token}`));

  const c = readDoc('C-location-data.md');
  ['latitude', 'longitude', 'nearbyPostcodes', 'outwardCode', 'straight line', 'Postcodes.io', 'Overpass']
    .forEach(token => assert.ok(c.includes(token), `C-location-data.md should mention ${token}`));
});

test('the documented vocabulary matches the code exactly', () => {
  assert.deepEqual(Object.keys(D.CATEGORIES).sort(),
    ['hand_trowel', 'litter_picker', 'reusable_gloves', 'watering_can'],
    'B-data-layer.md and C-location-data.md both list this category set (no rake)');
  assert.equal(D.CATEGORIES.litter_picker.label, 'Litter picker');
  assert.equal(D.CATEGORIES.reusable_gloves.label, 'Reusable gloves');
  assert.equal(D.CATEGORIES.watering_can.label, 'Watering can');
  assert.equal(D.CATEGORIES.hand_trowel.label, 'Hand trowel');

  assert.deepEqual(D.TEMPLATE_LIST.map(t => t.id), ['park_cleanup', 'flowerbed_care'],
    'B-data-layer.md lists this template set (no street_trees / spring_bulbs)');
  assert.deepEqual(D.TEMPLATES.park_cleanup.requirements.map(r => r.category),
    ['litter_picker', 'reusable_gloves']);
  assert.deepEqual(D.TEMPLATES.flowerbed_care.requirements.map(r => r.category),
    ['watering_can', 'hand_trowel']);
  D.TEMPLATE_LIST.forEach(t => {
    assert.ok(t.title && t.description, `${t.id} carries title + description`);
    t.requirements.forEach(r => {
      assert.ok(D.CATEGORIES[r.category], `${t.id} -> unknown category ${r.category}`);
      assert.equal(r.quantity, 1, 'B keeps quantity 1 on every requirement row');
    });
  });

  assert.deepEqual(D.TOOL_STATUS, ['available', 'reserved', 'on_loan', 'archived'],
    'availability is the four-state computed field; there is no tool.status');
  assert.deepEqual(D.TASK_STATUSES, ['open', 'completed']);
  assert.deepEqual(D.REQUIREMENT_STATES,
    ['self_supplied', 'pending', 'confirmed', 'in_use', 'fulfilled', 'match_available', 'missing']);
  assert.deepEqual(D.LOAN_STATUSES,
    ['pending', 'accepted', 'on_loan', 'returned', 'rejected', 'cancelled']);
  assert.deepEqual(D.LOAN_ACTIVE, ['pending', 'accepted', 'on_loan']);
  assert.deepEqual(D.LOAN_CONFIRMED, ['accepted', 'on_loan'], 'B-data-layer.md: accepted and on_loan are separate facts');
  assert.deepEqual(D.LOAN_CLOSED, ['returned', 'rejected', 'cancelled'], 'a returned loan is closed too');
  assert.deepEqual(D.LOAN_STAGES.accepted.stage, 'reserved');
  assert.deepEqual(D.LOAN_STAGES.on_loan.stage, 'handed_over');
  assert.equal(D.LOAN_STAGES.pending.availability, 'reserved', 'a live request reserves the tool');
  assert.equal(D.LOAN_STAGES.accepted.availability, 'reserved');
  assert.equal(D.LOAN_STAGES.on_loan.availability, 'on_loan');
  assert.equal(D.LOAN_STAGES.returned.availability, 'available', 'closing a loan releases the tool');
});

test('the documented object shapes match the code', () => {
  const task = D.createTask({ id: 't', creatorId: 'alice', creatorName: 'Alice', templateId: 'park_cleanup', communityId: 'c1', place: { name: 'Meadow', latitude: 55.95, longitude: -3.19, source: 'manual' } });

  assert.deepEqual(Object.keys(task).sort(),
    ['completed_at', 'completion_eligible', 'community_id', 'coordination_ready',
      'created_at', 'creator', 'id', 'outcome', 'place', 'requirements', 'status',
      'template_id', 'title'].sort(),
    'TaskResponse.data shape (backend/app/schemas_tasks.py)');
  assert.deepEqual(Object.keys(task.place), ['name', 'latitude', 'longitude', 'source', 'source_id']);
  assert.deepEqual(Object.keys(task.creator), ['id', 'display_name']);
  assert.equal(task.status, 'open');
  assert.equal(task.outcome, null, 'outcome is null until the organiser submits');

  assert.deepEqual(Object.keys(task.requirements[0]),
    ['id', 'category', 'quantity', 'self_supplied', 'state', 'active_loan_id', 'candidate_tool_ids'],
    'RequirementView shape: no slot / slot_total / source_type / loan_request_id');
  assert.equal(task.requirements[0].quantity, 1);
  assert.equal(task.requirements.length, 2, 'one row per category, never expanded into slots');

  const tool = {
    id: 'p1', name: 'Picker', category: 'litter_picker', description: '',
    owner: { id: 'bob', display_name: 'Bob' },
    community: { id: 'c1', postcode: 'EH8 9YL', outcode: 'EH8', latitude: 55.95, longitude: -3.19, country: 'Scotland', source: 'fixture', source_kind: 'fixture', fetched_at: '2026-10-03T09:00:00Z' },
    availability: 'available', is_archived: false, distance_m: null,
    created_at: '2026-10-03T09:00:00Z', updated_at: '2026-10-03T09:00:00Z'
  };
  const made = D.createLoanRequest(tool, task, task.requirements[0], 'alice', () => 'L1').request;
  assert.deepEqual(Object.keys(made),
    ['id', 'tool_id', 'tool_name', 'owner_id', 'borrower_id', 'requirement_id', 'task_id',
      'status', 'note', 'created_at', 'updated_at', 'accepted_at', 'handed_over_at',
      'returned_at', 'rejected_at', 'cancelled_at'],
    'LoanResponse shape (backend/app/schemas_loans.py)');
  assert.equal(made.status, 'pending');
  ['created_at', 'updated_at'].forEach(key => assert.match(made[key], /^\d{4}-\d{2}-\d{2}T.*Z$/, `${key} is ISO 8601 UTC`));
  ['accepted_at', 'handed_over_at', 'returned_at', 'rejected_at', 'cancelled_at'].forEach(key => assert.equal(made[key], null));
  assert.equal(task.requirements[0].active_loan_id, 'L1', 'the requirement points at its active loan');
  assert.equal(task.requirements[0].state, 'pending');

  // The row shape A is told to consume.
  const ctx = { task, tools: [tool], loans: [], viewerId: 'alice', names: { bob: 'Bob' } };
  const row = D.describeTask(task, ctx)[0];
  ['requirementId', 'state', 'confirmed', 'pending', 'statusText', 'tools', 'loans', 'history', 'category', 'label']
    .forEach(key => assert.ok(key in row, `A-ui-boundary.md promises row.${key}`));
  ['state', 'confirmed', 'pending', 'statusText', 'tools'].forEach(key =>
    assert.ok(row[key] !== undefined, `row.${key} must always be present`));
  assert.ok(D.REQUIREMENT_STATES.includes(row.state), 'row.state is a frozen requirement state');

  const progress = D.taskProgress(task, ctx);
  ['total', 'confirmed', 'pending', 'missing', 'percent', 'complete', 'rows', 'nextAction']
    .forEach(key => assert.ok(key in progress, `A-ui-boundary.md promises taskProgress().${key}`));

  const report = D.impactReport([task], [], { tools: [tool], names: { bob: 'Bob' } });
  assert.deepEqual(report.metrics.map(m => m.key),
    ['completed_loans', 'actions_with_tools_confirmed', 'completed_actions',
      'bags_collected', 'volunteer_minutes'],
    'five metrics: the would_have_bought_new / participant_minutes wording is gone');
  report.metrics.forEach(m => ['source', 'basis', 'scope', 'caveat', 'available'].forEach(key =>
    assert.ok(key in m, `metric ${m.key} must carry ${key}`)));

  // The outcome block, and the figure B deleted.
  D.applyOutcome(task, { note: 'Cleared the path.', bags_collected: 2, volunteer_minutes: 45, would_have_bought_new: true, completedAt: '2026-10-03T12:00:00Z' });
  assert.deepEqual(Object.keys(task.outcome), ['note', 'bags_collected', 'volunteer_minutes', 'verification']);
  assert.equal(task.outcome.verification, 'self_reported');
  assert.equal('would_have_bought_new' in task.outcome, false, 'B dropped that figure');
  assert.equal('impact' in task, false, 'impact / outcome_note are not part of TaskResponse');
  assert.equal(task.status, 'completed');
});

test('the module has no network, storage or DOM dependencies', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'task-module.js'), 'utf8');
  // Strip comments: the header legitimately explains how the file is loaded.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'document.', 'window.', 'http://', 'https://']
    .forEach(token => assert.ok(!code.includes(token), `task-module.js must stay pure (found ${token})`));
});
