/* Member A — community page green spaces + postcode green context score.
 *
 * Drives the real web/app.js inside the harness's vm. The environment payload
 * is injected straight onto state.environment (the shape B's
 * GET /communities/{id}/environment returns, verified live): the greenspace
 * provider carries C's [{id,name,type,distance_km,latitude,longitude,source}]
 * list, air_quality carries a European AQI, carbon_intensity carries a
 * clean_energy_percentage. No network, no browser.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, createMockBackend } = require('./harness.cjs');

async function signIn(app, alias) {
  app.submit('#login-form', { user_alias: alias });
  await app.flush();
}

function providers(greenspaceData, airData, carbonData, attrs) {
  attrs = attrs || {};
  return {
    status: 'ok',
    greenspace: {
      provider: 'greenspace', status: 'ok', data: greenspaceData,
      source_kind: 'fixture', source: 'OpenStreetMap Overpass API',
      attribution: 'Green space data © OpenStreetMap contributors',
      fetched_at: '2026-10-03T10:00:00Z', ...(attrs.greenspace || {})
    },
    air_quality: {
      provider: 'air_quality', status: 'ok', data: airData,
      source_kind: 'fixture', source: 'Open-Meteo Air Quality',
      attribution: 'Open-Meteo Air Quality (11km regional grid forecast)',
      fetched_at: '2026-10-03T10:00:00Z', ...(attrs.air_quality || {})
    },
    carbon_intensity: {
      provider: 'carbon_intensity', status: 'ok', data: carbonData,
      source_kind: 'fixture', source: 'NESO Carbon Intensity API',
      attribution: 'NESO Carbon Intensity API (National Grid ESO)',
      fetched_at: '2026-10-03T10:00:00Z', ...(attrs.carbon_intensity || {})
    }
  };
}

const GREEN = [
  { id: 'osm-1', name: 'The Meadows', type: 'Community Green Space', distance_km: 0.5, latitude: 55.9412, longitude: -3.1925, source: 'OpenStreetMap Overpass API' },
  { id: 'osm-2', name: 'George Square Gardens', type: 'Public Urban Park', distance_km: 0.1, latitude: 55.9441, longitude: -3.1887, source: 'OpenStreetMap Overpass API' },
  { id: 'osm-3', name: 'Holyrood Park', type: 'Royal Natural Park', distance_km: 1.5, latitude: 55.9510, longitude: -3.1670, source: 'OpenStreetMap Overpass API' }
];
const AIR = { status: 'Good', aqi: 19, pm2_5: 4.1, pm10: 7.8, source: 'Open-Meteo Air Quality (11km regional grid forecast)', scope: 'Regional forecast (~11km grid)', timestamp: '2026-10-03T10:00:00Z' };
const CARBON = { index: 'very low', forecast: 38, unit: 'gCO2/kWh', clean_energy_percentage: 76.5, top_source: 'Wind (62.3%)', source: 'NESO Carbon Intensity API', scope: 'Regional grid zone (EH8)', timestamp: '2026-10-03T10:00:00Z' };

/* Expected score for GREEN + AIR + CARBON above, worked by hand:
   green = round(40 * (0.5 * min(3/5,1) + 0.5 * (1 - min(0.1,2)/2))) = round(31) = 31
   air   = aqi 19 -> <=20 -> 30
   elec  = round(30 * 76.5 / 100) = round(22.95) = 23
   total = 84 */
const EXPECTED_TOTAL = 84;

function inject(app, environment) {
  app.run(`state.environment = ${JSON.stringify(environment)}; location.hash='#community'; render();`);
}

test('the green-space list renders C’s real names, nearest first, with straight-line distance', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));

  const html = app.html();
  assert.match(html, /The Meadows/, 'a real park name from the provided data is shown');
  assert.match(html, /George Square Gardens/);
  assert.match(html, /Holyrood Park/);
  assert.match(html, /Public Urban Park/, 'the place type is shown');
  assert.match(html, /0\.10 km/, 'the straight-line distance is shown');
  assert.match(html, /Green space data © OpenStreetMap contributors/, 'the source attribution is shown');
  assert.match(html, /straight-line distance/, 'the distance is labelled honestly, not as a walk');
  assert.doesNotMatch(html, /walking/i, 'it never claims a walking route');
  const greenList = html.match(/<ul class="green-list">([\s\S]*?)<\/ul>/)[1];
  assert.ok(greenList.indexOf('George Square Gardens') < greenList.indexOf('The Meadows'), 'nearest place is listed first');
  assert.ok(greenList.indexOf('The Meadows') < greenList.indexOf('Holyrood Park'), 'then the next nearest');
  assert.match(html, /demo fixture/, 'the fixture/cached provenance is labelled');
  assert.match(html, /2026-10-03 10:00 UTC/, 'the fetched_at snapshot is shown');
});

test('the green-space list falls back to a pending state when the provider is unavailable', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  // Explicitly inject the not_implemented provider state (no data yet from C).
  inject(app, {
    status: 'unavailable',
    greenspace: {
      provider: 'greenspace', status: 'not_implemented', data: null,
      source: 'OpenStreetMap Overpass API', fetched_at: null
    },
    air_quality: {
      provider: 'air_quality', status: 'not_implemented', data: null,
      source: 'Open-Meteo Air Quality', fetched_at: null
    },
    carbon_intensity: {
      provider: 'carbon_intensity', status: 'not_implemented', data: null,
      source: 'NESO Carbon Intensity API', fetched_at: null
    }
  });

  const html = app.html();
  assert.match(html, /still waiting on OpenStreetMap Overpass API/, 'the pending provider is worded as still waiting');
  assert.match(html, /OpenStreetMap Overpass API/, 'the still-pending source is named');
  assert.match(html, /Green spaces near EH8/, 'the degraded state still names the area');
  assert.doesNotMatch(html, /The Meadows/, 'no parked name is invented');
  assert.doesNotMatch(html, /A space for your neighbourhood map/, 'the old placeholder is gone');
});

test('the score equals the expected number for a fixture environment', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));

  const score = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
  assert.equal(score.available, true);
  assert.equal(score.value, EXPECTED_TOTAL);
  assert.deepEqual(score.components.map(c => c.points), [31, 30, 23], 'each component matches the formula');

  const html = app.html();
  assert.match(html, new RegExp(`<strong>${EXPECTED_TOTAL}</strong>`), 'the total is rendered on the community page');
  assert.match(html, /31<\/strong>\/40/, 'the green-access component is shown');
  assert.match(html, /30<\/strong>\/30/, 'the air-quality component is shown');
  assert.match(html, /23<\/strong>\/30/, 'the electricity component is shown');
});

test('the total is withheld when a provider is missing (never treated as zero)', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  const env = providers(GREEN, AIR, null, {
    carbon_intensity: { status: 'unavailable', data: null, source_kind: null, attribution: '' }
  });
  inject(app, env);

  const score = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
  assert.equal(score.available, false);
  assert.equal(score.value, null, 'no total is invented');
  assert.deepEqual(score.missing, ['still waiting on NESO Carbon Intensity API'], 'the pending source is named honestly');
  assert.equal(score.components.find(c => c.key === 'carbon_intensity').points, null);
  assert.equal(score.components.find(c => c.key === 'greenspace').points, 31, 'available components still show');

  const html = app.html();
  assert.match(html, /score-total"><strong class="pending">—<\/strong>/, 'the total is shown as withheld');
  assert.match(html, /Total withheld until every source answers — still waiting on NESO Carbon Intensity API\./);
  assert.match(html, /31<\/strong>\/40/, 'the available green-space component is still shown');
  assert.doesNotMatch(html, new RegExp(`<strong>${EXPECTED_TOTAL}</strong>`), 'the full total is not shown');
});

test('the score is labelled as regional context and kept out of the impact panel', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));

  const html = app.html();
  assert.match(html, /id="green-context-score"/, 'the score card lives on the community page');
  assert.match(html, /REGIONAL PUBLIC-DATA CONTEXT/, 'it is explicitly labelled as regional context');
  assert.match(html, /Postcode green context score/);
  assert.match(html, /not a measurement of what this community’s actions have achieved/, 'it is not conflated with achieved impact');
  assert.match(html, /Regional forecast \(~11km grid\)/, 'the air provider scope is shown');
  assert.match(html, /Regional grid zone \(EH8\)/, 'the electricity provider scope is shown');

  // D's impact panel belongs to the task module and must not carry the score.
  app.run("location.hash='#task'; render();");
  const taskHtml = app.html();
  assert.match(taskHtml, /outcomes/, 'the impact panel is still rendered by D');
  assert.doesNotMatch(taskHtml, /green-context-score/, 'the score is not placed in the impact panel');
  assert.doesNotMatch(taskHtml, /Postcode green context score/);
});

test('the integrations.js iframe override still wins over the native green-space view', async () => {
  const app = createApp({ integrations: { map: 'https://maps.example.com/embed', air: '', electricity: '' } });
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));

  const html = app.html();
  assert.match(html, /<iframe class="embed" title="map module" src="https:\/\/maps\.example\.com\/embed"/, 'the trusted iframe wins');
  assert.doesNotMatch(html, /The Meadows/, 'the native list is not shown when the iframe is configured');
  assert.doesNotMatch(html, /green-list/, 'no duplicate native green-space view');
});

test('fixture-sourced data is visibly labelled as a demo snapshot, not a live query', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON)); // providers() defaults source_kind to 'fixture'

  const html = app.html();
  assert.match(html, /Demo fixture snapshot — sample data, not a live query\. Captured 2026-10-03 10:00 UTC\./,
    'the green-space list carries a visible fixture badge with its capture time');
  assert.match(html, /Includes demo fixture data — a labelled sample snapshot, not a live query\./,
    'the score card carries a visible fixture banner');
  assert.match(html, /class="fixture-tag">Demo fixture · 2026-10-03 10:00 UTC</,
    'each fixture-backed score component is tagged with its capture time');
});

test('live-sourced data is not labelled as a fixture', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON, {
    greenspace: { source_kind: 'live' },
    air_quality: { source_kind: 'live' },
    carbon_intensity: { source_kind: 'live' }
  }));

  const html = app.html();
  assert.doesNotMatch(html, /Demo fixture/, 'live answers are never labelled as a fixture');
  assert.match(html, /· live · 2026-10-03 10:00 UTC/, 'the live provenance is still shown');
});

/* -------------------------------------- nearest-tool route map integration */
function mapCardHTML(app) {
  return app.html().match(/<div class="map-card" id="project-map">([\s\S]*?)<\/aside>/)[1];
}

test('borrowable tools render a route SVG, highlighted closest pin and estimated distance', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  app.run(`state.tools = [
    { id: 'secateurs', name: 'Secateurs', category: 'hand_trowel', availability: 'available',
      owner: { id: 'bob', display_name: 'Bob' },
      community: { ...state.me.community, latitude: 55.946, longitude: -3.188 } },
    { id: 'own-tool', name: 'Own tool', category: 'hand_trowel', availability: 'available',
      owner: { id: state.me.id, display_name: 'Alice' }, community: state.me.community },
    { id: 'reserved-tool', name: 'Reserved tool', category: 'hand_trowel', availability: 'reserved',
      owner: { id: 'carol', display_name: 'Carol' }, community: state.me.community }
  ];`);
  const extraGreens = GREEN.concat(Array.from({ length: 3 }, (_, i) => ({
    id: `extra-${i}`, name: `Extra green ${i}`, latitude: 55.944, longitude: -3.189, distance_km: 0.2
  })));
  inject(app, providers(extraGreens, AIR, CARBON));

  const card = mapCardHTML(app);
  assert.match(card, /<h3>⌖ Your next little project<\/h3>/);
  assert.match(card, /<svg[^>]*role="img" aria-label="Neighbourhood map"/);
  assert.match(card, /<polyline class="route"/);
  assert.match(card, /class="tool-pin nearest" data-id="secateurs"/);
  assert.match(card, /class="nearest-halo"/);
  assert.match(card, /Closest: Secateurs — about \d+ m \(estimated route\)/);
  assert.doesNotMatch(card, /data-id="(?:own-tool|reserved-tool)"/, 'own and reserved tools are not map candidates');
  assert.equal((card.match(/class="greenspace" /g) || []).length, 5, 'the SVG includes only the first five green spaces');
  assert.match(card, /<h4>Green spaces nearby<\/h4>[\s\S]*class="green-list"/);
  assert.ok(card.indexOf('</svg>') < card.indexOf('route-summary'), 'description sits below the SVG');
  assert.ok(card.indexOf('route-summary') < card.indexOf('map-green-section'), 'the list stays below the route description');
  assert.match(card, /Estimated grid route · straight-line distances from postcode centres/);
});

test('no borrowable tools produces the no_tools message without a route or closest tool', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));
  assert.equal(app.run('M.planNearestRoute(homeCommunity(), []).message'), 'no_tools');
  assert.match(mapCardHTML(app), /No borrowable tools nearby yet\. Lend one and the route appears\./);

  // Owning an available tool or seeing a busy neighbour's tool is still empty.
  app.run(`state.tools = [
    { id: 'own', name: 'Own tool', category: 'hand_trowel', availability: 'available',
      owner: { id: state.me.id, display_name: 'Alice' }, community: state.me.community },
    { id: 'busy', name: 'Busy tool', category: 'hand_trowel', availability: 'on_loan',
      owner: { id: 'bob', display_name: 'Bob' }, community: state.me.community }
  ]; render();`);
  const card = mapCardHTML(app);
  assert.match(card, /No borrowable tools nearby yet\. Lend one and the route appears\./);
  assert.match(card, /<svg/, 'the map still shows You and green spaces');
  assert.match(card, /class="you-label"/);
  assert.doesNotMatch(card, /<polyline|class="tool-pin|Closest:/);
  assert.match(card, /class="green-list"/, 'the green-space section is preserved');
});

test('checking another postcode moves the account and recomputes the map, filters and honest UI copy', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));
  assert.match(mapCardHTML(app), /No borrowable tools nearby yet/);
  app.element('#postcode').value = 'EH14 4AS';
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH14 4AS', 'the account really moved');
  assert.equal(app.run('state.me.community.outcode'), 'EH14');
  assert.equal(app.run('state.tools.map(t => t.name).join(",")'), 'Colinton wheelbarrow',
    'the tool list is the moved-to community\'s, fetched after the move');
  const movedGreen = [{ id: 'colinton-green', name: 'Colinton Green', distance_km: 0.1,
    latitude: 55.9045, longitude: -3.249 }];
  app.run(`state.environment = ${JSON.stringify(providers(movedGreen, AIR, CARBON))}; render();`);
  const expected = app.run(`M.describeNearest(M.planNearestRoute(state.me.community,
    state.tools.map(t => ({ ...t, latitude: t.community.latitude, longitude: t.community.longitude }))))`);
  const card = mapCardHTML(app);
  assert.ok(card.includes(expected), 'the route starts at the moved-to home community');
  assert.match(card, /Closest: Colinton wheelbarrow/);
  assert.match(card, /<polyline class="route"/);
  assert.match(card, /Colinton Green/);
  assert.doesNotMatch(card, /The Meadows/, 'both the map and list use the moved-to community\'s environment');
  assert.match(app.html(), /id="back-home"/);
  assert.match(app.html(), /Back to my previous street/);
  assert.doesNotMatch(app.html(), /walk|navigat|导航/i, 'the UI never claims pedestrian or turn-by-turn guidance');

  app.click({ dataset: { filter: 'cleanup' } });
  assert.match(mapCardHTML(app), /No borrowable tools nearby yet/, 'category filters update map candidates');
  app.click({ dataset: { filter: 'all' } });
  assert.match(mapCardHTML(app), /Closest: Colinton wheelbarrow/);
  app.input({ id: 'tool-search', value: 'no matching tool' });
  assert.match(app.element('#project-map').innerHTML, /No borrowable tools nearby yet/, 'search repaints the map as well as the grid');
  app.input({ id: 'tool-search', value: '' });
  assert.match(app.element('#project-map').innerHTML, /Closest: Colinton wheelbarrow/);
  assert.doesNotMatch(app.element('#project-map').innerHTML, /walk|navigat|导航/i);

  app.click({ id: 'back-home' });
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH8 9AB', 'back restores the previous community');
  assert.match(mapCardHTML(app), /No borrowable tools nearby yet/, 'returning home recomputes the route');
  assert.doesNotMatch(mapCardHTML(app), /Colinton wheelbarrow|Colinton Green/);
  assert.doesNotMatch(app.html(), /walk|navigat|导航/i);
});

test('checking your own postcode is a confirmed no-op', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));
  const home = app.run('state.me.community.postcode');
  assert.equal(home, 'EH8 9AB');
  app.element('#postcode').value = home;
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), home, 'the account stays on its own street');
  assert.equal(app.run('state.previousHomePostcode'), null, 'no move means nothing to return to');
  assert.equal(app.element('#toast').textContent, `${home} is already your home street.`);
  assert.doesNotMatch(app.html(), /id="back-home"/, 'no back control for a no-op');
  assert.equal(app.server.writes.filter(w => w.path.endsWith('/api/v1/me/community')).length, 0,
    'the confirmed no-op never writes the move endpoint');
});

test('checking another postcode then the back control restores the previous street', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));
  app.element('#postcode').value = 'EH14 4AS';
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH14 4AS', 'the account moved to the checked street');
  assert.equal(app.run('state.previousHomePostcode'), 'EH8 9AB', 'the previous street is remembered');
  assert.equal(app.element('#toast').textContent, 'You are now in EH14 4AS.');
  assert.match(app.html(), /id="back-home"/);
  assert.match(app.html(), /Back to my previous street/);
  assert.equal(app.stored.get('bnd.previousHomePostcode'), 'EH8 9AB',
    'the previous street is persisted so the way back can survive a reload');

  app.click({ id: 'back-home' });
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH8 9AB', 'back restores the previous community');
  assert.equal(app.run('state.previousHomePostcode'), null, 'the reminder clears once used');
  assert.equal(app.stored.get('bnd.previousHomePostcode'), undefined, 'the persisted hint is dropped once used');
  assert.equal(app.element('#toast').textContent, 'Back to your street: EH8 9AB.');
  assert.doesNotMatch(app.html(), /id="back-home"/, 'the control is gone again');
});

test('the previous-street hint survives a reload and still moves through the API', async () => {
  const server = createMockBackend();
  const first = createApp({ server });
  await first.flush();
  await signIn(first, 'alice');
  first.element('#postcode').value = 'EH14 4AS';
  first.submit('#postcode-form', {});
  await first.flush();
  assert.equal(first.run('state.me.community.postcode'), 'EH14 4AS');
  const token = first.stored.get('bnd.token');
  assert.equal(first.stored.get('bnd.previousHomePostcode'), 'EH8 9AB',
    'the previous street is stored under the UI-prefs key');

  // A fresh page holding the same session token is a reload: /me stays the
  // authority (still EH14 4AS) and the way back is rebuilt from the stored hint.
  const reloaded = createApp({ server, storage: {
    'bnd.token': token, 'bnd.previousHomePostcode': 'EH8 9AB'
  } });
  await reloaded.flush();
  assert.equal(reloaded.run('state.me.community.postcode'), 'EH14 4AS', 'the server /me is the authority');
  assert.equal(reloaded.run('state.previousHomePostcode'), 'EH8 9AB', 'the way back survives a reload');
  assert.match(reloaded.html(), /Back to my previous street/);
  assert.match(reloaded.html(), /Your previous street is EH8 9AB/);

  reloaded.click({ id: 'back-home' });
  await reloaded.flush();
  assert.equal(reloaded.run('state.me.community.postcode'), 'EH8 9AB', 'the restored control still moves via the API');
  assert.equal(reloaded.stored.get('bnd.previousHomePostcode'), undefined, 'the hint is dropped once used');
  assert.doesNotMatch(reloaded.html(), /id="back-home"/);
});

test('a stored previous street that equals the current home is dropped, not offered', async () => {
  const server = createMockBackend();
  const first = createApp({ server });
  await first.flush();
  await signIn(first, 'alice');
  const token = first.stored.get('bnd.token');

  // Stale hint: the account never moved, so EH8 9AB is not somewhere to go back to.
  const app = createApp({ server, storage: { 'bnd.token': token, 'bnd.previousHomePostcode': 'EH8 9AB' } });
  await app.flush();
  assert.equal(app.run('state.previousHomePostcode'), null, 'a hint pointing at home is dropped');
  assert.equal(app.stored.get('bnd.previousHomePostcode'), undefined, 'the stale key is removed from storage');
  assert.doesNotMatch(app.html(), /id="back-home"/);
});

test('the context score follows the checked postcode instead of the old home community', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));
  const home = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
  assert.equal(home.value, EXPECTED_TOTAL);

  app.element('#postcode').value = 'EH14 4AS';
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.outcode'), 'EH14', 'the account moved to EH14');

  // The new community's own providers: a different AQI and clean share.
  const moved = providers(
    [{ id: 'colinton-green', name: 'Colinton Green', distance_km: 0.2, latitude: 55.9045, longitude: -3.249 }],
    { aqi: 81, source: 'Open-Meteo Air Quality', scope: 'Regional forecast (~11km grid)' },
    { clean_energy_percentage: 46.6, index: 'moderate', forecast: 150, unit: 'gCO2/kWh',
      top_source: 'Gas', source: 'NESO Carbon Intensity API', scope: 'Regional grid zone (EH14)' }
  );
  app.run(`state.environment = ${JSON.stringify(moved)}; render();`);

  const viewed = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
  assert.equal(viewed.components.find(c => c.key === 'air_quality').points, 3, 'AQI 81 falls in the lowest band');
  assert.equal(viewed.components.find(c => c.key === 'carbon_intensity').points, 14, '46.6% clean rounds to 14');
  assert.equal(viewed.value, 22 + 3 + 14, 'the total is recomputed from the moved-to providers');
  assert.notEqual(viewed.value, home.value, 'the score changes with the checked postcode');

  const html = app.html();
  assert.match(html, /score-total"><strong>39<\/strong>/, 'the moved-to total is rendered');
  assert.doesNotMatch(html, /score-total"><strong>84<\/strong>/, 'the old home total is gone');
  assert.match(html, /Regional grid zone \(EH14\)/, 'the moved-to electricity scope is shown');
  assert.doesNotMatch(html, /Regional grid zone \(EH8\)/, 'the old home electricity scope is gone');
});

test('browse-era plumbing is gone: one home context follows the checked postcode', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'app.js'), 'utf8');
  assert.doesNotMatch(source, /state\.browse|browseTools|browseEnvironment|currentCommunity|visibleEnvironment|visibleTools/,
    'no read-only browse context survives in app.js');
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  assert.equal(app.run('state.browse'), undefined, 'the account has no separate browse state');
  assert.equal(app.run('state.previousHomePostcode'), null, 'only the previous-street reminder is kept');

  // The one home context really follows a move: the account writes /me/community
  // and re-reads every surface from it, with no browse state anywhere.
  app.element('#postcode').value = 'EH14 4AS';
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH14 4AS', 'the one context follows the move');
  assert.ok(app.server.writes.some(w => w.status === 200 && w.path.endsWith('/api/v1/me/community')),
    'the move is a real 200 write to /api/v1/me/community, not a browse switch');
});

test('the header, tools request, environment and score all follow the moved community id', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));
  const otherId = app.server.otherCommunity.id;

  app.element('#postcode').value = 'EH14 4AS';
  app.submit('#postcode-form', {});
  await app.flush();

  assert.equal(app.run('state.me.community.id'), otherId, 'the account points at the new community');
  assert.equal(app.element('#whoami').textContent, 'Alice · EH14', 'the header identity follows the move');
  assert.ok(app.server.calls.some(c => c.path.includes(`community_id=${otherId}`)),
    'the tool list is requested for the new community');
  assert.ok(app.server.calls.some(c => c.path.endsWith(`/communities/${otherId}/environment`)),
    'the environment is fetched for the new community');
  assert.equal(app.run('state.environment.postcode.data.postcode'), 'EH14 4AS',
    'the shown environment is the new community\'s');
  assert.equal(app.run('state.tools.map(t => t.community.postcode).join(",")'), 'EH14 4AS',
    'every listed tool belongs to the new community');
  assert.equal(app.run('homePostcode()'), 'EH14 4AS');
  assert.match(app.html(), /Environmental context for EH14 4AS/, 'the environment copy follows too');
  app.click({ dataset: { publish: true } });
  assert.equal(app.element('#publish-postcode').textContent, 'EH14 4AS', 'publishing points at the new street');
  assert.equal(app.element('#publish-owner').textContent, 'Alice');
});

test('the impact banner follows the moved community counters, not the old home ones', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  // EH8 9AB has no shared tools in the fixture; EH14 4AS is seeded with one.
  assert.equal(app.run('state.impact.active_tools_count'), 0, 'the home street starts with no shared tools');
  assert.match(app.html(), /0 tools shared · 0 returned loans · 0 completed actions in EH8/);

  app.element('#postcode').value = 'EH14 4AS';
  app.submit('#postcode-form', {});
  await app.flush();

  assert.equal(app.run('state.impact.active_tools_count'), 1, 'impact is re-read for the moved-to community');
  assert.equal(app.run('state.impact.returned_loans_count'), 0);
  assert.equal(app.run('state.impact.completed_tasks_count'), 0);
  assert.match(app.html(), /1 tools shared · 0 returned loans · 0 completed actions in EH14/,
    'the banner shows the moved-to community counters');
  assert.doesNotMatch(app.html(), /0 tools shared · 0 returned loans · 0 completed actions in EH8/,
    'the old home counters are gone');
});

test('a failed move leaves the previous community intact and shows the error', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));
  assert.equal(app.run('state.me.community.postcode'), 'EH8 9AB');

  app.element('#postcode').value = 'not a postcode';
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH8 9AB', 'the failed move changes nothing');
  assert.equal(app.run('state.previousHomePostcode'), null, 'no move means nothing to return to');
  assert.equal(app.element('#postcode-message').textContent, 'That postcode could not be resolved.');
  assert.equal(app.element('#toast').textContent, 'That postcode could not be resolved.');
  assert.doesNotMatch(app.html(), /id="back-home"/, 'no back control after a failed move');
  const rejected = app.server.writes.filter(w => w.path.endsWith('/api/v1/me/community'));
  assert.ok(rejected.some(w => w.status === 422), 'the rejected postcode did reach the move endpoint');
  assert.ok(!rejected.some(w => w.status === 200), 'a rejected move records no successful write');

  // Having moved, a failure must keep the current street and its way back.
  app.element('#postcode').value = 'EH14 4AS';
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH14 4AS');
  app.element('#postcode').value = 'nope';
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH14 4AS', 'a failed move keeps the moved-to street');
  assert.equal(app.run('state.previousHomePostcode'), 'EH8 9AB', 'the way back survives a failed move');
  const moves = app.server.writes.filter(w => w.path.endsWith('/api/v1/me/community'));
  assert.equal(moves.filter(w => w.status === 200).length, 1, 'only the real move succeeded');
  assert.ok(moves.filter(w => w.status === 422).length >= 2, 'both rejected postcodes reached the endpoint');
});

/* -------------------------------------- boundary cases (reviewer findings) */

test('European AQI band boundaries map to 30/23/15/8/3 at 20/40/60/80/81', async () => {
  const cases = [[20, 30], [40, 23], [60, 15], [80, 8], [81, 3]];
  for (const [aqi, expected] of cases) {
    const app = createApp();
    await app.flush();
    await signIn(app, 'alice');
    inject(app, providers(GREEN, Object.assign({}, AIR, { aqi }), CARBON));
    const score = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
    const air = score.components.find(c => c.key === 'air_quality');
    assert.equal(air.points, expected, `aqi ${aqi} must score ${expected}, not another band`);
  }
});

test('a green space at exactly 2.0 km counts as within range; 2.01 km does not', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');

  // One space on the 2 km edge: within = 1, nearest = 2.0 -> round(40 * (0.1 + 0)) = 4
  inject(app, providers([{ id: 'edge', name: 'Edge Park', distance_km: 2.0 }], AIR, CARBON));
  let score = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
  assert.equal(score.components.find(c => c.key === 'greenspace').points, 4, 'exactly 2.0 km is inside the 2 km term');

  // Just outside: within = 0, nearest clamps to 2 -> round(40 * (0 + 0)) = 0
  inject(app, providers([{ id: 'edge', name: 'Edge Park', distance_km: 2.01 }], AIR, CARBON));
  score = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
  assert.equal(score.components.find(c => c.key === 'greenspace').points, 0, '2.01 km is outside the 2 km term');
});

test('a null AQI withholds the total and never scores the maximum', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, Object.assign({}, AIR, { aqi: null }), CARBON));

  const score = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
  assert.equal(score.available, false, 'the total is withheld while air is unavailable');
  assert.equal(score.value, null, 'no total is invented');
  const air = score.components.find(c => c.key === 'air_quality');
  assert.equal(air.points, null, 'a null AQI has no score');
  assert.notEqual(air.points, 30, 'null is never treated as the best possible air score');
  assert.ok(score.missing.some(m => /Open-Meteo/.test(m)), 'the air source is named as missing');

  assert.match(app.html(), /score-total"><strong class="pending">—<\/strong>/, 'the total is shown as withheld');
});

test('a green space with distance_km null is ignored, not counted as 0 km', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers([
    { id: 'no-distance', name: 'Unmeasured Green', distance_km: null },
    { id: 'far', name: 'Far Field', distance_km: 1.8 }
  ], AIR, CARBON));

  // Only the 1.8 km space counts: within = 1, nearest = 1.8 -> round(40 * (0.1 + 0.05)) = 6.
  const green = JSON.parse(app.run('JSON.stringify(greenContextScore())')).components.find(c => c.key === 'greenspace');
  assert.equal(green.points, 6, 'the null-distance space is dropped, not treated as 0 km');
  assert.notEqual(green.points, 28, 'it never lands at the 0 km end of the distance term');

  const html = app.html();
  assert.match(html, /Unmeasured Green/, 'the map list still names the place');
  assert.match(html, /distance pending/, 'its distance is shown as unknown');
  assert.doesNotMatch(html, /0\.00 km/, 'no 0 km distance is invented for it');
});

test('an answered-but-empty green-space provider is worded apart from a pending one', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');

  // Provider answers ok/cached with an empty list.
  inject(app, providers([], AIR, CARBON));
  let html = app.html();
  assert.match(html, /OpenStreetMap Overpass API answered with no named green spaces\./, 'an empty answer is named honestly');
  assert.doesNotMatch(html, /still waiting on OpenStreetMap Overpass API/, 'an empty answer is not called still-waiting');
  const emptyScore = JSON.parse(app.run('JSON.stringify(greenContextScore())'));
  assert.equal(emptyScore.available, false, 'no green places leaves the green term unavailable');
  assert.ok(emptyScore.missing.some(m => /answered with no named green spaces/.test(m)), 'the score missing list uses the same wording');
  assert.ok(!emptyScore.missing.some(m => /still waiting on OpenStreetMap/.test(m)), 'the score does not call an empty answer still-waiting');

  // A nameless list is the same 'answered but empty' state.
  inject(app, providers([{ id: 'x', distance_km: 0.3 }], AIR, CARBON));
  html = app.html();
  assert.match(html, /OpenStreetMap Overpass API answered with no named green spaces\./, 'a nameless list is an empty answer too');
  assert.doesNotMatch(html, /still waiting on OpenStreetMap Overpass API/, 'a nameless list is not called still-waiting');

  // Provider has not answered: status not ok/cached.
  inject(app, providers([], AIR, CARBON, { greenspace: { status: 'unavailable', data: null, source_kind: null, attribution: '', source: '' } }));
  html = app.html();
  assert.match(html, /still waiting on OpenStreetMap Overpass API/, 'a pending provider is called still-waiting');
  assert.doesNotMatch(html, /answered with no named green spaces/, 'a pending provider is not called an empty answer');
});

test('the green-access basis discloses the source cap of 5', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  inject(app, providers(GREEN, AIR, CARBON));

  const scope = JSON.parse(app.run('JSON.stringify(greenContextScore())'))
    .components.find(c => c.key === 'greenspace').scope;
  assert.match(scope, /capped at 5/, 'the component basis text states the source cap');
  assert.match(app.html(), /capped at 5/, 'the disclosed cap is rendered on the community page');
});

/* -------------------------------------- task meeting-point selection */
function createPlaceApp(rejection) {
  const server = createMockBackend();
  const fetch = server.fetch;
  const placesSent = [];
  // Observe the real API client's JSON and inject an HTTP error without changing
  // the shared harness (its task mock does not implement the OSM cache lookup).
  server.fetch = async (url, init) => {
    if (new URL(url).pathname === '/api/v1/tasks' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      placesSent.push(body.place);
      if (rejection && body.place.source === 'osm') return {
        ok: false, status: 422,
        text: async () => JSON.stringify({ error: { code: rejection.code, message: rejection.message, details: {} }, meta: {} })
      };
    }
    return fetch(url, init);
  };
  return { app: createApp({ server }), placesSent };
}
function injectTaskPlaces(app, greens, attrs) {
  inject(app, providers(greens, AIR, CARBON, attrs));
  app.run("location.hash='#task'; render();");
}
function placePanelHTML(app) {
  return app.html().match(/<fieldset class="place-panel" id="task-place-panel">[\s\S]*?<\/fieldset>/)[0];
}
function selectPlace(app, id) {
  app.change({ dataset: { taskPlace: id }, checked: true });
}

test('selecting a green space creates an OSM action with the provider name, coordinates and source id', async () => {
  const { app, placesSent } = createPlaceApp();
  await app.flush();
  await signIn(app, 'alice');
  injectTaskPlaces(app, GREEN);
  assert.match(placePanelHTML(app), /Where are we helping\?/);
  assert.match(placePanelHTML(app), /data-task-place="" value="" checked/);
  assert.match(placePanelHTML(app), /Community centre · EH8/);
  assert.match(placePanelHTML(app), /Public Urban Park · 0\.10 km · straight-line distance/);
  selectPlace(app, 'osm-2');
  assert.match(placePanelHTML(app), /data-task-place="osm-2" value="osm-2" checked/);
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  assert.deepEqual(placesSent[0], {
    name: 'George Square Gardens', latitude: 55.9441, longitude: -3.1887, source: 'osm', source_id: 'osm-2'
  });
  const place = JSON.parse(app.run('JSON.stringify(myOpenTask().place)'));
  assert.equal(place.name, 'George Square Gardens');
  assert.equal(place.source, 'osm');
  assert.equal(place.latitude, GREEN[1].latitude);
  assert.equal(place.longitude, GREEN[1].longitude);
  assert.match(app.html(), /id="place-name" value="George Square Gardens" maxlength="120" readonly/);
  assert.doesNotMatch(app.html(), /name="task-place"/, 'open actions expose no place editor');
  selectPlace(app, 'osm-1');
  assert.equal(app.run('myOpenTask().place.name'), 'George Square Gardens', 'a forged change cannot edit an open action');
  assert.equal(placesSent.length, 1);
});

test('the community-centre default remains selectable and sends the fixture home coordinates', async () => {
  const { app, placesSent } = createPlaceApp();
  await app.flush();
  await signIn(app, 'alice');
  injectTaskPlaces(app, GREEN);
  selectPlace(app, 'osm-1');
  selectPlace(app, '');
  assert.match(placePanelHTML(app), /data-task-place="" value="" checked/);
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  assert.deepEqual(placesSent[0], {
    name: 'Community centre · EH8', latitude: app.server.community.latitude,
    longitude: app.server.community.longitude, source: 'fixture', source_id: null
  });
  assert.equal(app.run('myOpenTask().place.source'), 'fixture');
  assert.equal(app.run('myOpenTask().place.name'), 'Community centre · EH8');
});

test('green spaces beyond 2 km are disabled using coordinates rather than the provider distance label', async () => {
  const { app, placesSent } = createPlaceApp();
  await app.flush();
  await signIn(app, 'alice');
  injectTaskPlaces(app, [{ ...GREEN[0], id: 'far', name: 'Distant Park', latitude: 56.1, distance_km: 0.1 }]);
  const panel = placePanelHTML(app);
  assert.match(panel, /data-task-place="far" value="far"\s+disabled/);
  assert.match(panel, /outside the 2 km action area/);
  selectPlace(app, 'far'); // Even a synthetic change event must not bypass it.
  assert.match(placePanelHTML(app), /data-task-place="" value="" checked/);
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  assert.equal(placesSent[0].source, 'fixture');
});

test('missing, pending and empty green-space data degrade to only the working default option', async () => {
  for (const [data, attrs] of [[null, {}], [[], {}], [{ outcode: 'EH8' }, {}], [GREEN, { greenspace: { status: 'unavailable' } }]]) {
    const { app, placesSent } = createPlaceApp();
    await app.flush();
    await signIn(app, 'alice');
    injectTaskPlaces(app, data, attrs);
    const panel = placePanelHTML(app);
    assert.equal((panel.match(/type="radio"/g) || []).length, 1);
    assert.match(panel, /Green spaces appear when the environment card has data/);
    assert.match(panel, /data-task-place="" value="" checked/);
    app.click({ dataset: { template: 'park_cleanup' } });
    await app.flush();
    assert.equal(placesSent[0].source, 'fixture');
    assert.equal(app.run('myOpenTask().place.name'), 'Community centre · EH8');
  }
});

test('a task HTTP 422 shows the original server message and resets the place for a default retry', async () => {
  // OUT_OF_RANGE also has a friendly tool-specific message in app.js; task 422s
  // must show the server text even for that code, not the borrowing explanation.
  for (const code of ['VALIDATION_ERROR', 'OUT_OF_RANGE']) {
    const message = 'Selected OSM source_id is not in this community’s green-space cache.';
    const { app, placesSent } = createPlaceApp({ code, message });
    await app.flush();
    await signIn(app, 'alice');
    injectTaskPlaces(app, GREEN);
    selectPlace(app, 'osm-2');
    app.click({ dataset: { template: 'park_cleanup' } });
    await app.flush();
    assert.equal(app.element('#toast').textContent, message);
    assert.equal(app.run('state.tasks.length'), 0);
    assert.equal(app.run('ui.busy'), false);
    assert.match(placePanelHTML(app), /data-task-place="" value="" checked/);
    assert.match(app.html(), /Pick your little project/, 'the page remains usable');
    app.click({ dataset: { template: 'park_cleanup' } });
    await app.flush();
    assert.deepEqual(placesSent.map(p => p.source), ['osm', 'fixture']);
    assert.equal(app.run('myOpenTask().place.source'), 'fixture');
  }
});

test('the task selector follows the moved community\'s environment and action area, clearing stale choices', async () => {
  const { app, placesSent } = createPlaceApp();
  await app.flush();
  await signIn(app, 'alice');
  injectTaskPlaces(app, GREEN);
  selectPlace(app, 'osm-2');
  assert.equal(app.run('ui.selectedPlaceId'), 'osm-2', 'a choice is recorded against the old community');

  app.element('#postcode').value = 'EH14 4AS';
  app.submit('#postcode-form', {});
  await app.flush();
  assert.equal(app.run('state.me.community.postcode'), 'EH14 4AS', 'the account moved');

  // The moved-to community's environment offers a place outside its own 2 km
  // action area, so the default meeting point is used instead.
  const movedPlaces = [{ id: 'far-park', name: 'Currie Park', type: 'Park', distance_km: 0.1,
    latitude: 55.9441, longitude: -3.1887 }];
  app.run(`state.environment = ${JSON.stringify(providers(movedPlaces, AIR, CARBON))}; location.hash='#task'; render();`);
  const panel = placePanelHTML(app);
  assert.match(panel, /Community centre · EH14/);
  assert.match(panel, /Currie Park/);
  assert.match(panel, /outside the 2 km action area/);
  assert.match(panel, /data-task-place="" value="" checked/);
  assert.equal(app.run('ui.selectedPlaceId'), null, 'the stale old-community choice is cleared');
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  assert.equal(placesSent[0].source, 'fixture');
  assert.equal(placesSent[0].latitude, app.server.otherCommunity.latitude);
});

test('a selected green space removed from the latest data falls back before the task write', async () => {
  const { app, placesSent } = createPlaceApp();
  await app.flush();
  await signIn(app, 'alice');
  injectTaskPlaces(app, GREEN);
  selectPlace(app, 'osm-2');
  // Change the data without rendering: the write itself must re-check it too.
  app.run(`state.environment = ${JSON.stringify(providers([], AIR, CARBON))};`);
  app.click({ dataset: { template: 'park_cleanup' } });
  await app.flush();
  assert.equal(placesSent[0].source, 'fixture');
});

test('invalid green coordinates cannot be selected and provider text stays HTML-escaped', async () => {
  const app = createApp();
  await app.flush();
  await signIn(app, 'alice');
  injectTaskPlaces(app, [{ ...GREEN[0], name: '<script>park</script>', type: '<b>Park</b>', latitude: null }]);
  const panel = placePanelHTML(app);
  assert.match(panel, /coordinates unavailable/);
  assert.match(panel, /data-task-place="osm-1" value="osm-1"\s+disabled/);
  assert.match(panel, /&lt;script&gt;park&lt;\/script&gt;/);
  assert.match(panel, /&lt;b&gt;Park&lt;\/b&gt;/);
  assert.doesNotMatch(panel, /<script>|<b>Park<\/b>/);
});
