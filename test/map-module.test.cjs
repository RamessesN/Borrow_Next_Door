/* Unit tests for web/map-module.js — neighbourhood grid, shortest-path route
   planning and the pure SVG map renderer.
   Run with: node --test test/map-module.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../web/map-module.js');

/* --------------------------------------------------------------- fixtures */

const YOU = { latitude: 55.9476, longitude: -3.1873, label: 'You' };

function tool(id, lat, lon, extra) {
  return Object.assign({
    id, name: 'Tool ' + id, latitude: lat, longitude: lon
  }, extra || {});
}

// ~550 m north, ~800 m east, etc. All within one neighbourhood bbox.
const NEAR = tool('t1', 55.9490, -3.1860, { name: 'Galvanised watering can' });
const MID = tool('t2', 55.9520, -3.1840, { name: 'Hand trowel' });
const FAR = tool('t3', 55.9600, -3.1750, { name: 'Litter picker' });
const WEST = tool('t4', 55.9470, -3.2000, { name: 'Reusable gloves' });
const CLOSE = tool('t5', 55.9482, -3.1870, { name: 'Secateurs' });

const GREENS = [
  { id: 'g1', name: 'Meadow Park', latitude: 55.9500, longitude: -3.1900, distance_km: 0.4 },
  { id: 'g2', name: 'Canal Side Green', latitude: 55.9460, longitude: -3.1830, distance_km: 0.6 }
];

/* ------------------------------------------------------------------ basic */

test('exports the full frozen API surface', () => {
  for (const name of [
    'haversineMeters', 'buildGrid', 'dijkstra', 'shortestPath', 'aStar',
    'planNearestRoute', 'renderMapSVG', 'describeNearest'
  ]) {
    assert.equal(typeof M[name], 'function', name);
  }
  assert.equal(typeof M.ROUTE_NOTE, 'string');
});

test('haversineMeters: zero for identical points, sane for known pairs', () => {
  assert.equal(M.haversineMeters(YOU, YOU), 0);
  const edinburghToLondon = M.haversineMeters(
    { latitude: 55.9533, longitude: -3.1883 },
    { latitude: 51.5074, longitude: -0.1278 }
  );
  assert.ok(Math.abs(edinburghToLondon - 534000) < 6000, 'got ' + edinburghToLondon);
  // 0.001 deg of latitude is ~111 m
  const d = M.haversineMeters(YOU, { latitude: YOU.latitude + 0.001, longitude: YOU.longitude });
  assert.ok(Math.abs(d - 111.2) < 2, 'got ' + d);
});

/* ------------------------------------------------- 1. two-point straight case */

test('two-point scenario picks the genuinely closest tool', () => {
  const res = M.planNearestRoute(YOU, [FAR, NEAR]);
  assert.equal(res.message, 'ok');
  assert.equal(res.nearest.tool.id, 't1');
  assert.equal(res.ranked[0].tool.id, 't1');
  assert.equal(res.ranked[1].tool.id, 't3');
  assert.equal(res.nearest.rank, 1);
  // straight-line ordering must agree with grid-cost ordering here
  assert.ok(res.ranked[0].straight_line_m < res.ranked[1].straight_line_m);
});

/* ------------------------------------------- 2. >=5 tools vs per-tool Dijkstra */

test('five tools: ranked matches per-tool Dijkstra exactly', () => {
  const tools = [NEAR, MID, FAR, WEST, CLOSE];
  const res = M.planNearestRoute(YOU, tools);

  // re-run the pipeline manually: same points, same grid, plain Dijkstra
  const points = [YOU].concat(tools);
  const grid = M.buildGrid(points, { cols: 8, rows: 8 });
  const startId = grid.mapping[0];
  const manual = tools.map((t, idx) => {
    const endId = grid.mapping[idx + 1];
    const { dist } = M.dijkstra(grid, startId);
    const cost = M.haversineMeters(YOU, grid.nodes[startId]) +
      dist[endId] +
      M.haversineMeters(grid.nodes[endId], t);
    return { id: t.id, cost };
  }).sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));

  assert.deepEqual(res.ranked.map(r => r.tool.id), manual.map(m => m.id));
  res.ranked.forEach((r, i) => {
    assert.ok(Math.abs(r.cost_m - manual[i].cost) < 1e-6,
      `${r.tool.id}: ${r.cost_m} vs ${manual[i].cost}`);
  });
  // nearest really is the minimum-cost entry
  const min = Math.min(...res.ranked.map(r => r.cost_m));
  assert.equal(res.nearest.cost_m, min);
});

/* --------------------------------------------- 3. A* == Dijkstra on same graph */

test('A* and Dijkstra agree on cost for every pair in the grid', () => {
  const points = [YOU, NEAR, MID, FAR, WEST, CLOSE];
  const grid = M.buildGrid(points, { cols: 8, rows: 8 });
  const ids = grid.nodeList.map(n => n.id);
  for (const a of ids) {
    const { dist } = M.dijkstra(grid, a);
    for (const b of ids) {
      const astar = M.aStar(grid, a, b);
      assert.ok(Math.abs(astar.cost - dist[b]) < 1e-9, `${a} -> ${b}`);
      if (a !== b) assert.ok(astar.path.length >= 2);
      assert.equal(astar.path[0], a);
      assert.equal(astar.path[astar.path.length - 1], b);
    }
  }
});

test('planNearestRoute (A*) cost equals a Dijkstra-built plan', () => {
  const tools = [NEAR, MID, FAR, WEST, CLOSE];
  const res = M.planNearestRoute(YOU, tools);
  const grid = M.buildGrid([YOU].concat(tools), { cols: 8, rows: 8 });
  const { dist } = M.dijkstra(grid, grid.mapping[0]);
  res.ranked.forEach(r => {
    const endId = grid.mapping[tools.findIndex(t => t.id === r.tool.id) + 1];
    const cost = M.haversineMeters(YOU, grid.nodes[grid.mapping[0]]) +
      dist[endId] + M.haversineMeters(grid.nodes[endId], r.tool);
    assert.ok(Math.abs(cost - r.cost_m) < 1e-6, r.tool.id);
  });
});

/* ------------------------ 4. triangle inequality + endpoint snapping correct */

test('grid cost is never shorter than the straight line; path ends are exact', () => {
  const tools = [NEAR, MID, FAR, WEST, CLOSE];
  const res = M.planNearestRoute(YOU, tools);
  for (const r of res.ranked) {
    assert.ok(r.cost_m + 1e-6 >= r.straight_line_m,
      `${r.tool.id}: cost ${r.cost_m} < straight ${r.straight_line_m}`);
    assert.ok(r.path.length >= 2, 'path has at least you + tool');
    assert.ok(M.haversineMeters(r.path[0], YOU) < 0.01, 'path starts at you');
    assert.ok(M.haversineMeters(r.path[r.path.length - 1], r.tool) < 0.01,
      'path ends at the tool');
    // interior points are real grid cell centres: consecutive hops must obey
    // the same inequality against the straight-line span of the hop
    for (let i = 1; i < r.path.length; i++) {
      const hop = M.haversineMeters(r.path[i - 1], r.path[i]);
      assert.ok(isFinite(hop) && hop >= 0);
    }
  }
  assert.deepEqual(res.path, res.nearest.path);
});

test('buildGrid snaps every point to its nearest cell centre', () => {
  const points = [YOU, NEAR, MID, FAR, WEST, CLOSE];
  const grid = M.buildGrid(points, { cols: 8, rows: 8 });
  assert.equal(grid.nodeList.length, 64);
  grid.mapping.forEach((id, i) => {
    assert.ok(grid.nodes[id], 'mapping ' + i);
    const node = grid.nodes[id];
    // no other cell centre is closer than the one we picked
    for (const n of grid.nodeList) {
      assert.ok(M.haversineMeters(points[i], node) <=
        M.haversineMeters(points[i], n) + 1e-9);
    }
  });
  // adjacency: 4-neighbour interior node has degree 4, corners degree 2
  assert.equal(grid.adj['c0r0'].length, 2);
  assert.equal(grid.adj['c4r4'].length, 4);
  assert.equal(Object.keys(grid.nodes).length, 64);
});

/* ------------------------------------------------------------- 5. edge cases */

test('no tools -> clean no_tools result', () => {
  const res = M.planNearestRoute(YOU, []);
  assert.deepEqual(res, { nearest: null, path: [], message: 'no_tools' });
  assert.ok(M.describeNearest(res).length > 0, 'copy still produced');
});

test('single tool works', () => {
  const res = M.planNearestRoute(YOU, [NEAR]);
  assert.equal(res.message, 'ok');
  assert.equal(res.nearest.tool.id, 't1');
  assert.equal(res.nearest.rank, 1);
  assert.ok(res.nearest.cost_m >= res.nearest.straight_line_m - 1e-6);
});

test('identical coordinates: no crash, all tied, stable id ordering', () => {
  const twins = [
    tool('b-tool', 55.9500, -3.1850),
    tool('a-tool', 55.9500, -3.1850),
    tool('c-tool', 55.9500, -3.1850)
  ];
  const youHere = { latitude: 55.9500, longitude: -3.1850 };
  const res = M.planNearestRoute(youHere, twins);
  assert.equal(res.message, 'ok');
  assert.deepEqual(res.ranked.map(r => r.tool.id), ['a-tool', 'b-tool', 'c-tool']);
  const costs = new Set(res.ranked.map(r => r.cost_m));
  assert.equal(costs.size, 1, 'all costs tied');
  assert.equal(res.nearest.tool.id, 'a-tool');
  // run again with shuffled input -> identical order (deterministic)
  const res2 = M.planNearestRoute(youHere, [twins[2], twins[0], twins[1]]);
  assert.deepEqual(res2.ranked.map(r => r.tool.id), ['a-tool', 'b-tool', 'c-tool']);
});

test('invalid inputs degrade instead of throwing', () => {
  assert.equal(M.planNearestRoute(YOU, null).message, 'no_tools');
  assert.equal(M.planNearestRoute(YOU, [{ id: 'broken' }]).message, 'no_tools');
  assert.equal(M.planNearestRoute(null, [NEAR]).message, 'no_you');
  assert.equal(M.planNearestRoute(YOU, [NEAR, { id: 'x', latitude: 'NaN', longitude: 1 }])
    .ranked.length, 1, 'bad tool filtered out');
  const grid = M.buildGrid([], {});
  assert.equal(grid.nodeList.length, 0);
  assert.equal(M.aStar(grid, 'c0r0', 'c1r1').cost, Infinity);
  assert.deepEqual(M.shortestPath(grid, {}, 'c0r0'), []);
});

/* ------------------------------------------------------------------ 6. SVG */

test('renderMapSVG: highlight, route polyline, disclaimer, counts, no banned words', () => {
  const res = M.planNearestRoute(YOU, [NEAR, MID, FAR, CLOSE]);
  const svg = M.renderMapSVG({
    you: YOU,
    tools: [NEAR, MID, FAR, CLOSE],
    greenspaces: GREENS,
    path: res.path,
    nearest: res.nearest,
    caption: 'Neighbourhood sharing'
  });

  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  // route: a multi-segment polyline from you to the closest pin
  const poly = svg.match(/<polyline class="route" points="([^"]+)"/);
  assert.ok(poly, 'route polyline present');
  const points = poly[1].trim().split(/\s+/);
  assert.ok(points.length >= 2, 'polyline has segments, got ' + points.length);
  // highlight
  assert.ok(svg.includes('<circle class="tool-pin nearest" data-id="' + res.nearest.tool.id + '"'),
    'nearest pin highlighted');
  assert.equal((svg.match(/class="tool-pin(?! nearest)/g) || []).length, 3, 'other three pins');
  assert.equal((svg.match(/class="tool-pin(?: nearest)?"/g) || []).length, 4, 'every borrowable tool has a pin');
  const nearestPin = svg.match(/<circle class="tool-pin nearest"[^>]+/)[0];
  const ordinaryPins = [...svg.matchAll(/<circle class="tool-pin"[^>]+/g)].map(m => m[0]);
  assert.match(nearestPin, /fill="#c9a24a"/);
  ordinaryPins.forEach(pin => assert.match(pin, /fill="#dd885c"/));
  assert.notEqual(nearestPin.match(/fill="([^"]+)"/)[1], ordinaryPins[0].match(/fill="([^"]+)"/)[1]);
  assert.equal(Number(nearestPin.match(/ r="([^"]+)"/)[1]),
    Number(ordinaryPins[0].match(/ r="([^"]+)"/)[1]) * 1.2, 'highlight is 20% larger');
  assert.equal((svg.match(/class="nearest-halo"/g) || []).length, 2, 'two halo layers');
  assert.match(svg, /class="nearest-halo" data-layer="outer"[^>]*opacity="0.15"/);
  assert.match(svg, /class="nearest-halo" data-layer="inner"/);
  assert.match(svg, /class="nearest-label"[^>]*>Secateurs</);
  assert.match(svg, /class="route"[^>]*stroke-dasharray="4 4"/);
  assert.equal((svg.match(/class="route-endpoint"/g) || []).length, 2);
  assert.match(svg, /class="you-dot"[^>]*fill="#284e3c"[^>]*stroke="#ffffff"/);
  const legend = svg.match(/<g class="legend"[\s\S]*?<\/g>/)[0];
  for (const [kind, color] of Object.entries({ you: '#284e3c', tool: '#dd885c', closest: '#c9a24a', green: '#9db88a' })) {
    assert.match(legend, new RegExp(`data-kind="${kind}"[^>]*fill="${color}"`));
  }
  // greenspaces
  assert.equal((svg.match(/class="greenspace"/g) || []).length, 2);
  assert.equal((svg.match(/class="greenspace"/g) || []).length, GREENS.length);
  // disclaimer + legend + You label
  assert.ok(svg.includes(M.ROUTE_NOTE));
  assert.ok(svg.includes('Estimated grid route'));
  for (const item of ['>You<', 'Borrowable', 'Closest', 'Green space']) {
    assert.ok(svg.includes(item), 'legend/item missing: ' + item);
  }
  // product red line: no forbidden wording anywhere in the output
  assert.ok(!/walk|navigat|导航/i.test(svg), 'banned wording leaked into SVG');
  // robust even if a caller passes banned words in the caption
  const dirty = M.renderMapSVG({ you: YOU, tools: [NEAR], caption: 'Walking directions now' });
  assert.ok(!/walk|navigat|导航/i.test(dirty), 'caption sanitiser failed');
  assert.ok(dirty.includes(M.ROUTE_NOTE));
});

test('renderMapSVG survives empty/partial input', () => {
  const empty = M.renderMapSVG({});
  assert.ok(empty.startsWith('<svg') && empty.includes(M.ROUTE_NOTE));
  const partial = M.renderMapSVG({ you: YOU, tools: [NEAR] });
  assert.ok(!/walk|navigat|导航/i.test(partial));
  assert.equal((partial.match(/class="tool-pin/g) || []).length, 1);
  // IDs and tooltip names are XML-escaped inside the SVG.
  const tricky = M.renderMapSVG({
    you: YOU,
    tools: [tool('a&b"><x', 55.95, -3.18, { name: 'Rake & <spade>"' })]
  });
  assert.ok(tricky.includes('data-id="a&amp;b&quot;&gt;&lt;x"'), tricky);
  assert.ok(!tricky.includes('<x'));
  assert.ok(!tricky.includes('<spade>'));
});

function pinCoordinates(svg) {
  return [...svg.matchAll(/<circle class="tool-pin(?: nearest)?"[^>]*data-id="([^"]+)"[^>]*cx="([^"]+)" cy="([^"]+)"/g)]
    .map(m => ({ id: m[1], x: Number(m[2]), y: Number(m[3]) }));
}

function assertSeparated(points, minimum = 14) {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const distance = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      assert.ok(distance >= minimum - 0.02, `${points[i].id}/${points[j].id}: ${distance.toFixed(2)} px`);
    }
  }
}

test('screen-space separation survives shared coordinates and a 10km+ extent', () => {
  const cluster = Array.from({ length: 30 }, (_, i) => tool(`cluster-${i}`, YOU.latitude, YOU.longitude));
  const tools = cluster.concat(tool('distant', YOU.latitude + 0.2, YOU.longitude + 0.3));
  const result = M.planNearestRoute(YOU, tools);
  assert.ok(M.haversineMeters(YOU, tools.at(-1)) > 10000);
  const options = { you: YOU, tools, nearest: result.nearest, path: result.path };
  const svg = M.renderMapSVG(options);
  const pins = pinCoordinates(svg);
  assert.equal(pins.length, tools.length);
  assert.deepEqual(new Set(pins.map(p => p.id)), new Set(tools.map(t => t.id)));
  const origin = svg.match(/class="you-dot" cx="([^"]+)" cy="([^"]+)"/);
  assertSeparated(pins.concat({ id: 'You', x: Number(origin[1]), y: Number(origin[2]) }));
  pins.forEach(p => {
    assert.ok(p.x >= 28 && p.x <= 292, 'pin stays inside horizontal padding');
    assert.ok(p.y >= 28 && p.y <= 156, 'pin stays inside vertical padding');
  });
  assert.equal(svg, M.renderMapSVG(options), 'repeatable layout');
  const reordered = pinCoordinates(M.renderMapSVG({ ...options, tools: tools.slice().reverse() }));
  assertSeparated(reordered);
  assert.ok(svg.includes('pin-leader'), 'displaced points retain geographic connectors');
});

test('green-space labels are capped and label pills do not collide with pins or each other', () => {
  const greenspaces = Array.from({ length: 7 }, (_, i) => ({
    id: `green-${i}`, name: `Neighbourhood green ${i}`, latitude: YOU.latitude, longitude: YOU.longitude
  }));
  const result = M.planNearestRoute(YOU, [NEAR, MID, FAR, CLOSE]);
  const svg = M.renderMapSVG({ you: YOU, tools: [NEAR, MID, FAR, CLOSE], greenspaces,
    nearest: result.nearest, path: result.path });
  assert.equal((svg.match(/class="greenspace"/g) || []).length, 7, 'all green-space marks retained');
  const count = (svg.match(/class="greenspace-label"/g) || []).length;
  assert.equal(count, 3, 'only nearest three receive names');
  assert.match(svg, />\+4 green spaces</);
  const boxes = [...svg.matchAll(/class="map-label-bg" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)]
    .map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    assert.ok(a.x >= 16 && a.x + a.w <= 304 && a.y >= 16 && a.y + a.h <= 168);
    for (const b of boxes.slice(i + 1)) {
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
        'label boxes do not overlap');
    }
    for (const pin of pinCoordinates(svg)) {
      const dx = pin.x - Math.max(a.x, Math.min(a.x + a.w, pin.x));
      const dy = pin.y - Math.max(a.y, Math.min(a.y + a.h, pin.y));
      assert.ok(Math.hypot(dx, dy) >= 9.98, 'label does not cover a pin');
    }
  }
});

test('names, captions and tooltip copy are escaped and forbidden wording is stripped', () => {
  const t = tool('special', 55.95, -3.18, { name: 'Walking <spade> & navigation 导航' });
  const svg = M.renderMapSVG({ you: YOU, tools: [t], nearest: t,
    greenspaces: [{ id: 'green', name: 'Walker & <green>', latitude: 55.951, longitude: -3.19 }],
    caption: 'Walking navigation 导航' });
  assert.doesNotMatch(svg, /walk|navigat|导航/i);
  assert.doesNotMatch(svg, /<spade>|<green>/);
  assert.match(svg, /&lt;spade&gt;/);
  assert.match(svg, /&amp;/);
  assert.match(svg, /class="nearest-label"/);
});

/* -------------------------------------------------- describeNearest copy */

test('describeNearest wording, distance units and metric labels', () => {
  const res = M.planNearestRoute(YOU, [NEAR, FAR]);
  const line = M.describeNearest(res, { t1: 'Galvanised watering can' });
  assert.match(line, /^Closest: Galvanised watering can — about \d+ m \(estimated route\)$/);

  const straight = M.describeNearest(res, null, 'straight');
  assert.match(straight, /\(straight-line\)$/);
  assert.notEqual(line, straight);

  // km adaptive: a far-away tool
  const farRes = M.planNearestRoute(
    { latitude: 55.95, longitude: -3.18 },
    [tool('faraway', 56.15, -3.18)]
  );
  assert.match(M.describeNearest(farRes, null, 'straight'), /about \d+\.\d km \(straight-line\)/);
  assert.equal(M.formatDistance(999), '999 m');
  assert.equal(M.formatDistance(1000), '1 km');
  assert.equal(M.formatDistance(1234), '1.2 km');
});

/* ------------------------------------------------------- 7. performance */

test('50 tools plan in well under 500 ms', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const tools = [];
  for (let i = 0; i < 50; i++) {
    tools.push(tool('t' + String(i).padStart(2, '0'),
      55.94 + rand() * 0.03, -3.21 + rand() * 0.05));
  }
  const t0 = process.hrtime.bigint();
  const res = M.planNearestRoute(YOU, tools);
  const svg = M.renderMapSVG({ you: YOU, tools, path: res.path, nearest: res.nearest });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(res.ranked.length, 50);
  assert.equal(res.nearest.rank, 1);
  assert.ok(!/walk|navigat|导航/i.test(svg));
  assert.ok(ms < 500, 'took ' + ms.toFixed(1) + ' ms');
});

/* ------------------------------------------------------ buildGrid options */

test('buildGrid honours cols/rows and the diagonal option', () => {
  const small = M.buildGrid([YOU, NEAR], { cols: 3, rows: 2 });
  assert.equal(small.nodeList.length, 6);
  assert.equal(small.cols, 3);
  const deg4 = M.buildGrid([YOU, NEAR], { cols: 4, rows: 4 });
  const deg8 = M.buildGrid([YOU, NEAR], { cols: 4, rows: 4, diagonal: true });
  assert.equal(deg4.adj['c1r1'].length, 4);
  assert.equal(deg8.adj['c1r1'].length, 8);
  // diagonals are longer than orthogonal steps but shorter than the detour
  const ortho = deg8.adj['c1r1'].find(e => e.id === 'c2r1').w;
  const diag = deg8.adj['c1r1'].find(e => e.id === 'c2r2').w;
  assert.ok(diag > ortho && diag < ortho * 2.5, `${diag} vs ${ortho}`);
});
