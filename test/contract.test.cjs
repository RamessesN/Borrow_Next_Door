/* Member D — the public contract that docs/handoff/*.md promises to B, C and A.
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
    '#impact-minutes', '#impact-bought-new', '#place-name']
    .forEach(token => assert.ok(a.includes(token), `A-ui-boundary.md should mention ${token}`));

  const b = readDoc('B-data-layer.md');
  ['requirement_id', 'loan_request_id', 'slot_total', 'source_type', 'impact',
    'bags_collected', 'participant_minutes', 'would_have_bought_new', 'slotIsClaimed']
    .forEach(token => assert.ok(b.includes(token), `B-data-layer.md should mention ${token}`));

  const c = readDoc('C-location-data.md');
  ['latitude', 'longitude', 'nearbyPostcodes', 'outwardCode', 'straight line', 'Postcodes.io', 'Overpass']
    .forEach(token => assert.ok(c.includes(token), `C-location-data.md should mention ${token}`));
});

test('the documented vocabulary matches the code exactly', () => {
  assert.deepEqual(Object.keys(D.CATEGORIES).sort(),
    ['gloves', 'picker', 'rake', 'spade', 'watering'],
    'C-location-data.md and B-data-layer.md both list this category set');
  assert.deepEqual(D.TEMPLATE_LIST.map(t => t.id),
    ['cleanup', 'garden', 'street_trees', 'spring_bulbs'],
    'B-data-layer.md lists this template set');
  assert.deepEqual(D.TOOL_STATUS, ['available', 'reserved', 'on_loan']);
  assert.deepEqual(D.LOAN_ACTIVE, ['pending', 'accepted', 'on_loan']);
  assert.deepEqual(D.LOAN_CONFIRMED, ['accepted', 'on_loan'], 'B-data-layer.md: accepted and on_loan are separate facts');
  assert.deepEqual(D.LOAN_STAGES.accepted.stage, 'reserved');
  assert.deepEqual(D.LOAN_STAGES.on_loan.stage, 'handed_over');
});

test('the documented object shapes match the code', () => {
  const task = D.createTask({ id: 't', creatorId: 'alice', templateId: 'cleanup', postcode: 'EH8 9YL' });

  assert.deepEqual(Object.keys(task), ['id', 'creator_id', 'template_id', 'postcode', 'place_name',
    'latitude', 'longitude', 'status', 'outcome_note', 'impact', 'requirements', 'created_at', 'completed_at']);
  assert.deepEqual(Object.keys(task.requirements[0]), ['id', 'task_id', 'category', 'quantity',
    'slot', 'slot_total', 'source_type', 'loan_request_id']);
  assert.deepEqual(Object.keys(task.impact), ['bags_collected', 'participant_minutes', 'would_have_bought_new']);

  const tool = { id: 'p1', owner_id: 'bob', name: 'P', category: 'picker', status: 'available', postcode: 'EH8 9YL' };
  const made = D.createLoanRequest(tool, task, task.requirements[0], 'alice', () => 'L1').request;
  assert.deepEqual(Object.keys(made), ['id', 'tool_id', 'borrower_id', 'task_id', 'requirement_id',
    'status', 'created_at', 'returned_at']);

  // The fields C is asked to add.
  ['latitude', 'longitude'].forEach(field => {
    assert.ok(Object.prototype.hasOwnProperty.call(task, field), `C-location-data.md asks C for task.${field}`);
    assert.equal(task[field], null, 'and it must be optional');
  });

  // The row shape A is told to consume.
  const row = D.describeTask(task, { tools: [tool], loans: [], viewerId: 'alice', names: { bob: 'Bob' } })[0];
  ['requirementId', 'state', 'confirmed', 'pending', 'statusText', 'tools', 'loans', 'history', 'category', 'label']
    .forEach(key => assert.ok(key in row, `A-ui-boundary.md promises row.${key}`));
  ['state', 'confirmed', 'pending', 'statusText', 'tools'].forEach(key =>
    assert.ok(row[key] !== undefined, `row.${key} must always be present`));

  const progress = D.taskProgress(task, { tools: [tool], loans: [], viewerId: 'alice' });
  ['total', 'confirmed', 'pending', 'missing', 'percent', 'complete', 'rows', 'nextAction']
    .forEach(key => assert.ok(key in progress, `A-ui-boundary.md promises taskProgress().${key}`));

  const report = D.impactReport([task], [], {});
  assert.deepEqual(report.metrics.map(m => m.key), ['completed_loans', 'actions_with_tools_confirmed',
    'completed_actions', 'bags_collected', 'participant_minutes', 'potential_avoided_purchases'],
    'README and A-ui-boundary.md both list these six metrics');
  report.metrics.forEach(m => ['source', 'basis', 'scope', 'caveat', 'available'].forEach(key =>
    assert.ok(key in m, `metric ${m.key} must carry ${key}`)));
});

test('the module has no network, storage or DOM dependencies', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'task-module.js'), 'utf8');
  // Strip comments: the header legitimately explains how the file is loaded.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'document.', 'window.', 'http://', 'https://']
    .forEach(token => assert.ok(!code.includes(token), `task-module.js must stay pure (found ${token})`));
});
