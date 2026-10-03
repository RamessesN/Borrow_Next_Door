/* Member A — typing a postcode moves the viewing community.
 *
 * Drives the real web/app.js + web/api.js inside the harness's vm. The harness
 * mock backend serves two communities: the home community (Alice's account,
 * EH8 9AB) and a second one reachable through GET /communities/resolve
 * (EH16 5AA), each with its own environment/impact payload. Everything else is
 * the real client: Bearer tokens, envelopes, query strings.
 *
 * The rule under test: the environment, green spaces and impact follow the
 * viewed postcode; the demo account's tools, loans, actions and publishing stay
 * in the home community.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, ACCESS_CODE } = require('./harness.cjs');

const HOME_ID = 'c1111111-1111-4111-8111-111111111111';
const VIEW_ID = 'c2222222-2222-4222-8222-222222222222';
const VIEW_POSTCODE = 'EH16 5AA';

const HOME_AIR = { status: 'Good', aqi: 26, pm2_5: 5.2, pm10: 9.1, source: 'Open-Meteo Air Quality (11km regional grid forecast)', scope: 'Regional forecast (~11km grid)', timestamp: '2026-10-03T10:00:00Z' };
const HOME_CARBON = { index: 'low', forecast: 90, unit: 'gCO2/kWh', clean_energy_percentage: 46.6, top_source: 'Wind (40.1%)', source: 'NESO Carbon Intensity API', scope: 'Regional grid zone (EH8)', timestamp: '2026-10-03T10:00:00Z' };
const VIEW_AIR = Object.assign({}, HOME_AIR, { aqi: 32, pm2_5: 7.4, status: 'Moderate' });
const VIEW_CARBON = Object.assign({}, HOME_CARBON, { clean_energy_percentage: 83.9, scope: 'Regional grid zone (EH16)' });

const HOME_GREEN = [{ id: 'osm-home', name: 'The Meadows', type: 'Public Urban Park', distance_km: 0.5 }];
const VIEW_GREEN = [{ id: 'osm-view', name: 'Waverley Park', type: 'Public Urban Park', distance_km: 1.2 }];

const HOME_IMPACT = { active_tools_count: 3, returned_loans_count: 1, completed_tasks_count: 2, as_of: '2026-10-03T09:00:00Z' };
const VIEW_IMPACT = { active_tools_count: 7, returned_loans_count: 4, completed_tasks_count: 5, as_of: '2026-10-03T11:00:00Z' };

function environment(postcode, air, carbon, greenspace) {
  const provider = (name, source, attribution, data, status) => ({
    provider: name, status: status || 'ok', data, source_kind: 'fixture',
    source, attribution, source_url: '', fetched_at: '2026-10-03T10:00:00Z'
  });
  return {
    status: 'ok',
    postcode: provider('postcode', 'postcodes.io', 'postcodes.io (fixture snapshot)', { postcode }, 'ok'),
    greenspace: provider('greenspace', 'OpenStreetMap Overpass API', 'Green space data © OpenStreetMap contributors', greenspace),
    air_quality: provider('air_quality', 'Open-Meteo Air Quality', 'Open-Meteo Air Quality (11km regional grid forecast)', air),
    carbon_intensity: provider('carbon_intensity', 'NESO Carbon Intensity API', 'NESO Carbon Intensity API (National Grid ESO)', carbon)
  };
}

const HOME_ENV = environment('EH8 9AB', HOME_AIR, HOME_CARBON, HOME_GREEN);
const VIEW_ENV = environment(VIEW_POSTCODE, VIEW_AIR, VIEW_CARBON, VIEW_GREEN);

const VIEW_COMMUNITY = {
  id: VIEW_ID, postcode: VIEW_POSTCODE, outcode: 'EH16',
  latitude: 55.925180, longitude: -3.176690, country: 'Scotland',
  source: 'fixture', source_kind: 'fixture', fetched_at: '2026-10-03T09:00:00Z'
};

function backend() {
  return {
    environment: HOME_ENV,
    impact: HOME_IMPACT,
    viewCommunities: { [VIEW_POSTCODE]: { community: VIEW_COMMUNITY, environment: VIEW_ENV, impact: VIEW_IMPACT } }
  };
}

async function signIn(app, alias) {
  app.submit('#login-form', { user_alias: alias, access_code: ACCESS_CODE });
  await app.flush();
}

async function viewPostcode(app, value) {
  app.run("location.hash='#community';render()");
  app.element('#postcode').value = value;
  app.submit('#postcode-form', {});
  await app.flush();
}

const lastCall = (app, match) => app.server.calls.filter(c => match.test(c.path)).slice(-1)[0];

test('postcode submit re-fetches the environment for the resolved community and the AQI changes', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');

  app.run("location.hash='#community';render()");
  assert.match(app.html(), /<strong>26<\/strong> <span class="env-unit">AQI<\/span>/, 'home air card shows the home AQI');
  assert.match(app.html(), /The Meadows/, 'home green spaces are shown');
  assert.match(app.html(), /Regional grid zone \(EH8\)/, 'home electricity scope is shown');

  await viewPostcode(app, VIEW_POSTCODE);

  const envCall = lastCall(app, /\/communities\/[^/]+\/environment/);
  assert.equal(envCall.path, `http://mock.api.test/api/v1/communities/${VIEW_ID}/environment`,
    'the environment is re-fetched by the resolved community id');

  const html = app.html();
  assert.match(html, /<strong>32<\/strong> <span class="env-unit">AQI<\/span>/, 'the viewed AQI replaces the home one');
  assert.match(html, /Regional forecast \(~11km grid\)/, 'the regional forecast scope is shown');
  assert.match(html, /Regional grid zone \(EH16\)/, 'the viewed electricity scope is shown');
  assert.match(html, /Waverley Park/, 'the viewed green-space list is shown');
  assert.doesNotMatch(html, /The Meadows/, 'the home green-space list is replaced');
});

test('tools stay in the home community after a postcode submit while environment/impact follow the view', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');
  await viewPostcode(app, VIEW_POSTCODE);

  const toolsCall = lastCall(app, /\/tools\?/);
  assert.match(toolsCall.path, new RegExp(`community_id=${HOME_ID}`), 'publishing/borrowing tools stay on the home id');
  assert.doesNotMatch(toolsCall.path, new RegExp(VIEW_ID), 'the tool list is never retargeted at the viewed community');

  const mineCall = lastCall(app, /\/tasks\?scope=mine/);
  assert.ok(mineCall, 'my tasks are still fetched');
  // A scoping regression must fail here: my own tasks are never scoped to a
  // community id, so the viewed id could never leak into them.
  assert.ok(!/community_id=/.test(mineCall.path), 'my own tasks are fetched without any community scope');
  assert.doesNotMatch(mineCall.path, new RegExp(VIEW_ID), 'the viewed community id never scopes my own tasks');

  const communityTasks = app.server.calls.filter(c => /\/tasks\?scope=community/.test(c.path)).slice(-1)[0];
  assert.match(communityTasks.path, new RegExp(`community_id=${VIEW_ID}`), 'the community-scoped task list follows the view');

  const impactCall = lastCall(app, /\/communities\/[^/]+\/impact/);
  assert.equal(impactCall.path, `http://mock.api.test/api/v1/communities/${VIEW_ID}/impact`,
    'the impact counters come from the viewed community');

  assert.match(app.html(), /7 tools shared/, 'the banner shows the viewed community counters');
});

test('the viewing notice appears while viewing and the reset control returns home', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');

  app.run("location.hash='#community';render()");
  assert.doesNotMatch(app.html(), /view-notice/, 'no notice while on the home community');
  assert.match(app.html(), /Your community: EH8 9AB/, 'the home label is shown');

  await viewPostcode(app, VIEW_POSTCODE);

  const html = app.html();
  assert.match(html, /class="view-notice"/, 'a visible strip appears');
  assert.match(html, /Viewing <strong>EH16 5AA<\/strong>/, 'it names the viewed postcode');
  assert.match(html, /Your demo account’s tools, actions and loans stay in EH8 9AB/, 'it says identity stays home');
  assert.match(html, /<button type="button" class="view-reset" data-view-reset>Reset to EH8 9AB<\/button>/, 'a reset control is offered');
  assert.match(html, /Viewing EH16 5AA \(EH16\) · your tools stay in EH8 9AB/, 'the hero field message follows the view');

  // Any other re-render keeps the viewed community.
  app.click({ dataset: { loanTab: 'lent' } });
  app.run("location.hash='#community';render()");
  assert.match(app.html(), /class="view-notice"/, 'a re-render keeps the viewed community');

  app.click({ dataset: { viewReset: true } });
  await app.flush();

  assert.equal(app.run('state.viewCommunity'), null, 'the reset clears the viewed community');
  const resetEnv = lastCall(app, /\/communities\/[^/]+\/environment/);
  assert.equal(resetEnv.path, `http://mock.api.test/api/v1/communities/${HOME_ID}/environment`,
    'the reset re-fetches the home environment');
  const after = app.html();
  assert.doesNotMatch(after, /view-notice/, 'the strip disappears after reset');
  assert.match(after, /<strong>26<\/strong> <span class="env-unit">AQI<\/span>/, 'the home AQI is back');
  assert.doesNotMatch(after, /Waverley Park/, 'the viewed green spaces are gone');
});

test('envCard renders the real number with its scope and a pending dash when the value is missing', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');

  app.run(`state.viewCommunity = null; state.environment = ${JSON.stringify(VIEW_ENV)};`);
  const air = app.run("envCard('≋','The air around you','air_quality','Open-Meteo')");
  assert.match(air, /<strong>32<\/strong> <span class="env-unit">AQI<\/span>/, 'the AQI number is the headline, not the attribution');
  assert.match(air, /Regional forecast \(~11km grid\)/, 'the regional scope is rendered');
  assert.match(air, /Open-Meteo Air Quality \(11km regional grid forecast\)/, 'the provider attribution is the smaller line');
  assert.doesNotMatch(air, /Open-Meteo<\/strong>/, 'the attribution is no longer the headline');

  const electricity = app.run("envCard('ϟ','Your regional electricity','carbon_intensity','NESO Carbon Intensity')");
  assert.match(electricity, /<strong>83\.9<\/strong> <span class="env-unit">% clean electricity<\/span>/, 'the clean-energy share is rendered');
  assert.match(electricity, /Regional grid zone \(EH16\)/, 'the electricity scope is rendered');

  // A provider that answered with no number: floor is a dash, never 0.
  app.run(`state.environment = ${JSON.stringify(environment(VIEW_POSTCODE, Object.assign({}, VIEW_AIR, { aqi: null }), VIEW_CARBON, VIEW_GREEN))};`);
  const noNumber = app.run("envCard('≋','The air around you','air_quality','Open-Meteo')");
  assert.match(noNumber, /<strong class="pending">—<\/strong>/, 'a null reading shows a pending dash');
  assert.match(noNumber, /no number reported yet/, 'the missing number is disclosed');
  assert.doesNotMatch(noNumber, /<strong>0<\/strong>/, 'a missing reading is never rendered as 0');

  // A provider that never answered: pending, not connected, no number.
  app.run(`state.environment = ${JSON.stringify({ air_quality: { provider: 'air_quality', status: 'unavailable', data: null, source_kind: null, source: '', attribution: '', source_url: '', fetched_at: null } })};`);
  const pending = app.run("envCard('≋','The air around you','air_quality','Open-Meteo')");
  assert.match(pending, /<strong class="pending">—<\/strong>/, 'an unanswered provider shows a pending dash');
  assert.match(pending, /Open-Meteo · awaiting provider/, 'the pending provider is named');
  assert.match(pending, /Not connected/, 'the provider state is disclosed');
  assert.doesNotMatch(pending, /<strong>0<\/strong>/, 'no fabricated zero for a pending provider');
});

test('the old “stays in” copy is gone and the success message names the viewed postcode', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');
  await viewPostcode(app, VIEW_POSTCODE);

  const html = app.html();
  assert.doesNotMatch(html, /Your demo account stays in/, 'the misleading sentence is removed');
  assert.doesNotMatch(html, /resolves to a community/, 'the old resolve copy is gone');
  assert.equal(app.element('#toast').textContent, "Showing EH16 5AA. Your demo account's tools stay in EH8 9AB.",
    'the confirmation names the viewed postcode and where the tools stay');
});

test('an invalid postcode shows the error and leaves the current view unchanged', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');
  await viewPostcode(app, VIEW_POSTCODE);
  assert.equal(app.run('state.viewCommunity.postcode'), VIEW_POSTCODE);

  app.element('#postcode').value = 'NOT A POSTCODE';
  app.submit('#postcode-form', {});
  await app.flush();

  assert.equal(app.element('#postcode-message').textContent, 'That postcode could not be resolved.');
  assert.equal(app.run('state.viewCommunity.postcode'), VIEW_POSTCODE, 'the previous view is untouched');
  assert.match(app.html(), /class="view-notice"/, 'the strip is still there');
  assert.match(app.html(), /Waverley Park/, 'the viewed environment is still shown');
});

test('submitting the home postcode again does not enter viewing mode', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');

  app.run("location.hash='#community';render()");
  app.element('#postcode').value = 'EH8 9AB';
  app.submit('#postcode-form', {});
  await app.flush();

  assert.equal(app.run('state.viewCommunity'), null, 'typing your own postcode leaves you at home');
  const envCall = lastCall(app, /\/communities\/[^/]+\/environment/);
  assert.match(envCall.path, new RegExp(HOME_ID), 'the home environment is fetched, not a view');
  const html = app.html();
  assert.doesNotMatch(html, /view-notice/, 'no viewing strip appears for the home postcode');
  assert.match(html, /Your community: EH8 9AB/, 'the hero label reads as the home community');
  assert.equal(app.element('#toast').textContent, 'Back to your community: EH8 9AB.',
    'the confirmation reads as the home community, not a view');
});

test('the header identity keeps the home outcode while viewing another community', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');

  app.run("location.hash='#community';render()");
  assert.equal(app.element('#whoami').textContent, 'Alice · EH8', 'the identity label shows the home outcode');

  await viewPostcode(app, VIEW_POSTCODE);
  assert.equal(app.element('#whoami').textContent, 'Alice · EH8', 'the identity label still shows the home outcode');
  assert.match(app.html(), /Green spaces near EH16/, 'the environment label still follows the viewed outcode');
});

test('the task page names the viewed community on its impact counters', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');
  await viewPostcode(app, VIEW_POSTCODE);

  app.run("location.hash='#task';render()");
  const html = app.html();
  assert.match(html, /Tools shared in EH16/, 'the tools counter names the viewed outcode');
  assert.match(html, /Loans returned \(all EH16 neighbours\)/, 'the loans counter names the viewed outcode');
  assert.match(html, /Actions recorded \(all EH16 neighbours\)/, 'the actions counter names the viewed outcode');
  assert.doesNotMatch(html, /Tools shared in your community/, 'no counter reads as the viewer’s own community');
  assert.doesNotMatch(html, /Tools shared in EH8/, 'the home outcode never labels the viewed counters');
});

test('the wanted board only lists home-community gaps while viewing another community', async () => {
  const app = createApp({ backend: backend() });
  await app.flush();
  await signIn(app, 'alice');
  await viewPostcode(app, VIEW_POSTCODE);

  // The mock backend serves a single community, so hand the viewer the two
  // task summaries the real API returns when more than one community exists:
  // a gap in the home community and a gap in the community being viewed.
  const homeGap = { id: 'k-home', community_id: HOME_ID, status: 'open', title: 'Home cleanup', template_id: 'park_cleanup',
    creator: { id: 'u2222222-2222-4222-8222-222222222222', display_name: 'Bob' },
    requirements: [{ id: 'q-home', category: 'litter_picker', quantity: 1, self_supplied: false, state: 'missing' }] };
  const viewGap = { id: 'k-view', community_id: VIEW_ID, status: 'open', title: 'Viewed care', template_id: 'flowerbed_care',
    creator: { id: 'u2222222-2222-4222-8222-222222222222', display_name: 'Bob' },
    requirements: [{ id: 'q-view', category: 'watering_can', quantity: 1, self_supplied: false, state: 'missing' }] };
  app.run(`state.tasks = ${JSON.stringify([homeGap, viewGap])}; location.hash='#task'; render();`);

  const html = app.html();
  assert.match(html, /NEIGHBOURS NEEDED/, 'the wanted board rendered');
  assert.match(html, /Litter picker · 1/, 'the home community gap is offered');
  assert.doesNotMatch(html, /Watering can · 1/, 'the viewed community gap is not offered to a home neighbour');
});
