/* =============================================================================
 * Borrow Next Door — neighbourhood map & nearest-tool route planning.
 *
 * Pure domain/geometry logic. No DOM, no storage, no network, no globals
 * besides the single `BND_MAP` namespace this file publishes. Everything here
 * is a plain function over plain data (SVG output is just a string), so it can
 * be unit tested with `node --test` and rendered by web/app.js whenever the
 * homepage "Your next little project" card is on screen.
 *
 * Loaded two ways:
 *   <script src="map-module.js">            -> window.BND_MAP
 *   require('./map-module.js')              -> CommonJS export (tests)
 *
 * ---------------------------------------------------------------------------
 * DATA SHAPES (all latitudes/longitudes are WGS84 decimal degrees, same as
 * the frozen B backend vocabulary used by web/task-module.js):
 *
 *   you        { latitude, longitude, label? }
 *   tool point { id, name, latitude, longitude, distance_m?, category?,
 *                owner_name? }
 *   greenspace { id, name, latitude, longitude, distance_km? }
 *
 * ALGORITHM (product copy rules below are a hard requirement):
 *   The neighbourhood is approximated by a regular street grid laid over the
 *   bounding box of the points in play. Every business point is snapped to the
 *   nearest grid cell centre; a route is then the shortest path on that grid
 *   (Dijkstra, or A* with a Haversine heuristic), plus the two short access
 *   segments from the real point to its cell centre. Because every segment is
 *   a great-circle length, the resulting cost always obeys the triangle
 *   inequality against the straight-line distance.
 *
 *   Product red line: user-facing map copy must never claim turn-by-turn
 *   guidance. The SVG always carries the fixed footer
 *   "Estimated grid route · straight-line distances from postcode centres".
 * ========================================================================== */
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  else if (global) { global.BND_MAP = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Fixed footer shown on every rendered map (product red line). */
  var ROUTE_NOTE = 'Estimated grid route · straight-line distances from postcode centres';

  /* --------------------------------------------------------------- geometry */

  /** Great-circle distance in metres between two {latitude, longitude} points. */
  function haversineMeters(a, b) {
    if (!a || !b) return Infinity;
    var R = 6371000, rad = function (d) { return d * Math.PI / 180; };
    var lat1 = rad(a.latitude), lat2 = rad(b.latitude);
    var dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function isPoint(p) {
    return !!p && typeof p.latitude === 'number' && typeof p.longitude === 'number' &&
      isFinite(p.latitude) && isFinite(p.longitude);
  }

  /* ------------------------------------------------------------ binary heap */

  function MinHeap() { this.items = []; }

  MinHeap.prototype.push = function (key, id) {
    var a = this.items, i = a.length;
    a.push({ k: key, id: id });
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      var t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  };

  MinHeap.prototype.pop = function () {
    var a = this.items;
    if (!a.length) return null;
    var top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        var t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  };

  /* ------------------------------------------------------------------ grid */

  /** Build the street-grid graph over the bounding box of `points`.
   *
   *   nodes  : { id -> { id, latitude, longitude, col, row } }  (cell centres)
   *   adj    : { id -> [{ id, w }] }   four-neighbours, plus diagonals when
   *            `opts.diagonal` is true; `w` is the Haversine length in metres
   *   mapping: input point index -> nearest cell-centre id (the "snap")
   *   snap   : (point) -> node | null
   *
   * Degenerate point sets (one point, or a whole community sharing one
   * coordinate) get a small synthetic bounding box so a grid still exists. */
  function buildGrid(points, opts) {
    opts = opts || {};
    var cols = Math.max(1, Math.floor(opts.cols || 8));
    var rows = Math.max(1, Math.floor(opts.rows || 8));
    var diagonal = !!opts.diagonal;
    points = Array.isArray(points) ? points : [];

    var nodes = {}, nodeList = [], adj = {};
    var mapping = points.map(function () { return null; });

    var valid = [];
    for (var i = 0; i < points.length; i++) if (isPoint(points[i])) valid.push(i);

    if (!valid.length) {
      return {
        cols: cols, rows: rows, bounds: null, nodes: nodes, nodeList: nodeList,
        adj: adj, mapping: mapping, snap: function () { return null; }
      };
    }

    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    valid.forEach(function (i) {
      var p = points[i];
      if (p.latitude < minLat) minLat = p.latitude;
      if (p.latitude > maxLat) maxLat = p.latitude;
      if (p.longitude < minLon) minLon = p.longitude;
      if (p.longitude > maxLon) maxLon = p.longitude;
    });
    // Degenerate axes (all points collinear in one axis, or identical) get a
    // tiny synthetic span so cell centres do not all collapse onto one point.
    if (maxLat - minLat < 1e-7) { minLat -= 0.002; maxLat += 0.002; }
    if (maxLon - minLon < 1e-7) { minLon -= 0.002; maxLon += 0.002; }

    var cellH = (maxLat - minLat) / rows;
    var cellW = (maxLon - minLon) / cols;

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var id = 'c' + c + 'r' + r;
        var node = {
          id: id,
          latitude: minLat + (r + 0.5) * cellH,
          longitude: minLon + (c + 0.5) * cellW,
          col: c, row: r
        };
        nodes[id] = node;
        nodeList.push(node);
        adj[id] = [];
      }
    }

    function link(a, b) {
      var w = haversineMeters(nodes[a], nodes[b]);
      adj[a].push({ id: b, w: w });
      adj[b].push({ id: a, w: w });
    }
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        var here = 'c' + c + 'r' + r;
        if (c + 1 < cols) link(here, 'c' + (c + 1) + 'r' + r);
        if (r + 1 < rows) link(here, 'c' + c + 'r' + (r + 1));
        if (diagonal) {
          if (c + 1 < cols && r + 1 < rows) link(here, 'c' + (c + 1) + 'r' + (r + 1));
          if (c + 1 < cols && r - 1 >= 0) link(here, 'c' + (c + 1) + 'r' + (r - 1));
        }
      }
    }

    function snap(point) {
      if (!isPoint(point)) return null;
      var best = null, bestD = Infinity;
      for (var i = 0; i < nodeList.length; i++) {   // nodeList order => ties break
        var d = haversineMeters(point, nodeList[i]); // deterministically on (col,row)
        if (d < bestD) { bestD = d; best = nodeList[i]; }
      }
      return best;
    }
    valid.forEach(function (i) {
      var n = snap(points[i]);
      mapping[i] = n ? n.id : null;
    });

    return {
      cols: cols, rows: rows,
      bounds: { minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon },
      nodes: nodes, nodeList: nodeList, adj: adj,
      mapping: mapping, snap: snap
    };
  }

  /* -------------------------------------------------------------- algorithms */

  /** Dijkstra from `startId`. Returns { dist: {id: m}, prev: {id: id|null} };
   *  unreachable nodes keep dist = Infinity and no `prev` entry. */
  function dijkstra(graph, startId) {
    var dist = {}, prev = {};
    if (!graph || !graph.nodes || !graph.nodes[startId]) return { dist: dist, prev: prev };
    var ids = Object.keys(graph.nodes);
    ids.forEach(function (id) { dist[id] = Infinity; });
    dist[startId] = 0;
    prev[startId] = null;

    var done = {};
    var heap = new MinHeap();
    heap.push(0, startId);
    var item;
    while ((item = heap.pop())) {
      var id = item.id;
      if (done[id]) continue;
      if (item.k > dist[id]) continue;
      done[id] = true;
      var edges = graph.adj[id] || [];
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        var nd = dist[id] + e.w;
        if (nd < dist[e.id]) {
          dist[e.id] = nd;
          prev[e.id] = id;
          heap.push(nd, e.id);
        }
      }
    }
    return { dist: dist, prev: prev };
  }

  /** Walk `prev` back from `targetId` -> node id array (start..goal), or []
   *  when the target was never reached. */
  function shortestPath(graph, prev, targetId) {
    if (!prev || !(targetId in prev)) return [];
    var path = [], cur = targetId, guard = 0;
    while (cur !== null && cur !== undefined && guard++ < 1e6) {
      path.push(cur);
      cur = prev[cur];
    }
    path.reverse();
    return path;
  }

  /** A* with the Haversine distance-to-goal heuristic (admissible & consistent,
   *  so the cost matches Dijkstra exactly on the same graph). */
  function aStar(graph, startId, goalId) {
    if (!graph || !graph.nodes || !graph.nodes[startId] || !graph.nodes[goalId]) {
      return { path: [], cost: Infinity };
    }
    if (startId === goalId) return { path: [startId], cost: 0 };

    var goal = graph.nodes[goalId];
    var g = {}, prev = {}, done = {};
    Object.keys(graph.nodes).forEach(function (id) { g[id] = Infinity; });
    g[startId] = 0;
    prev[startId] = null;

    var heap = new MinHeap();
    heap.push(haversineMeters(graph.nodes[startId], goal), startId);
    var item;
    while ((item = heap.pop())) {
      var id = item.id;
      if (done[id]) continue;
      done[id] = true;
      if (id === goalId) break;
      var edges = graph.adj[id] || [];
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        var ng = g[id] + e.w;
        if (ng < g[e.id]) {
          g[e.id] = ng;
          prev[e.id] = id;
          heap.push(ng + haversineMeters(graph.nodes[e.id], goal), e.id);
        }
      }
    }
    if (!isFinite(g[goalId])) return { path: [], cost: Infinity };
    return { path: shortestPath(graph, prev, goalId), cost: g[goalId] };
  }

  /* -------------------------------------------------------- route planning */

  function coordOf(node) {
    return { latitude: node.latitude, longitude: node.longitude };
  }

  /** Core: which tool is nearest to `you` when travel follows the grid?
   *
   *  1. no usable tool -> { nearest: null, path: [], message: 'no_tools' }
   *  2. snap you + every tool into one grid
   *  3. A* per tool, cost = access(you) + grid path + access(tool)
   *  4. rank by cost; ties break on String(tool.id) so results are stable
   *  5. every ranked entry carries its full point path; `path` repeats the
   *     winning one for convenience.
   */
  function planNearestRoute(you, tools, opts) {
    opts = opts || {};
    tools = Array.isArray(tools) ? tools : [];
    var usable = tools.filter(isPoint);

    if (!usable.length) return { nearest: null, path: [], message: 'no_tools' };
    if (!isPoint(you)) return { nearest: null, path: [], message: 'no_you' };

    var points = [you].concat(usable);
    var grid = buildGrid(points, opts);
    var startId = grid.mapping[0];
    var startNode = grid.nodes[startId];

    // Real point -> snapped cell centre -> ...grid... -> snapped cell centre
    // -> real point. Consecutive duplicates (within a centimetre) collapse.
    function pushCoord(coords, p) {
      if (!p) return;
      var last = coords[coords.length - 1];
      if (last && haversineMeters(last, p) < 0.01) return;
      coords.push({ latitude: p.latitude, longitude: p.longitude });
    }

    var ranked = [];
    for (var i = 1; i < points.length; i++) {
      var tool = usable[i - 1];
      var endId = grid.mapping[i];
      var endNode = grid.nodes[endId];
      var res = aStar(grid, startId, endId);

      var accessStart = haversineMeters(you, startNode);
      var accessEnd = haversineMeters(endNode, tool);
      var cost = (isFinite(res.cost) ? res.cost : Infinity);
      var costM = isFinite(cost) ? accessStart + cost + accessEnd : Infinity;

      var coords = [];
      pushCoord(coords, you);
      for (var k = 0; k < res.path.length; k++) pushCoord(coords, grid.nodes[res.path[k]]);
      pushCoord(coords, tool);

      ranked.push({
        tool: tool,
        cost_m: costM,
        straight_line_m: haversineMeters(you, tool),
        path: coords,
        node_path: res.path
      });
    }

    ranked.sort(function (a, b) {
      if (a.cost_m !== b.cost_m) return a.cost_m - b.cost_m;
      var ka = String(a.tool && a.tool.id !== undefined ? a.tool.id : '');
      var kb = String(b.tool && b.tool.id !== undefined ? b.tool.id : '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    ranked.forEach(function (entry, idx) { entry.rank = idx + 1; });

    var nearest = ranked[0];
    return {
      nearest: nearest,
      path: nearest.path,
      ranked: ranked,
      message: 'ok',
      grid: { cols: grid.cols, rows: grid.rows, node_count: grid.nodeList.length }
    };
  }

  /* ---------------------------------------------------------------- SVG map */

  var DEFAULT_W = 320, DEFAULT_H = 220;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Strip any wording the product forbids out of optional caller captions. */
  function safeCaption(s) {
    return String(s)
      .replace(/walk(?:ing|s|er|ed)?|navigat(?:e|ion|ing)|导航/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Deterministic 32-bit FNV-1a hash -> [0, 360) degrees for pin scatter. */
  function hashAngle(str) {
    var h = 2166136261 >>> 0;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return (h % 3600) / 10;   // tenth-of-a-degree resolution, fully repeatable
  }

  function fmt(n) { return (Math.round(n * 100) / 100).toFixed(2); }

  /** Pure SVG string. No DOM access — app.js decides where it goes. */
  function renderMapSVG(o) {
    o = o || {};
    var width = o.width || DEFAULT_W, height = o.height || DEFAULT_H;
    var you = isPoint(o.you) ? o.you : null;
    var tools = (Array.isArray(o.tools) ? o.tools : []).filter(isPoint);
    var greens = (Array.isArray(o.greenspaces) ? o.greenspaces : []).filter(isPoint);
    var path = (Array.isArray(o.path) ? o.path : []).filter(isPoint);
    var nearest = o.nearest || null;
    var nearestId = nearest && nearest.tool ? nearest.tool.id
      : (nearest && nearest.id !== undefined ? nearest.id : null);

    // --- projection -------------------------------------------------------
    var lats = [], lons = [];
    function seed(p) { lats.push(p.latitude); lons.push(p.longitude); }
    if (you) seed(you);
    tools.forEach(seed);
    greens.forEach(seed);
    path.forEach(seed);
    if (!lats.length) { lats = [55.9476]; lons = [-3.1873]; }   // neutral fallback

    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
    var padLat = Math.max((maxLat - minLat) * 0.12, 0.0006);
    var padLon = Math.max((maxLon - minLon) * 0.12, 0.0006);
    minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;
    if (maxLat - minLat < 1e-6) { minLat -= 0.001; maxLat += 0.001; }
    if (maxLon - minLon < 1e-6) { minLon -= 0.001; maxLon += 0.001; }

    var mL = 14, mR = 14, mT = 14;
    var legendH = 30, noteH = 16;
    var mapW = width - mL - mR;
    var mapH = height - mT - legendH - noteH;
    var caption = safeCaption(o.caption || '');

    function px(p) {
      return {
        x: mL + (p.longitude - minLon) / (maxLon - minLon) * mapW,
        y: mT + (maxLat - p.latitude) / (maxLat - minLat) * mapH
      };
    }

    var svg = [];
    svg.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height +
      '" width="' + width + '" height="' + height + '" role="img" aria-label="Neighbourhood map">');
    svg.push('<rect class="map-bg" x="0" y="0" width="' + width + '" height="' + height +
      '" rx="8" fill="#f3f8f4"/>');

    // --- schematic street grid (illustrative, not a real road network) ----
    var i, x, y;
    svg.push('<g class="street-grid" stroke="#e1ebe3" stroke-width="1" fill="none">');
    for (i = 1; i < 6; i++) { x = mL + mapW * i / 6; svg.push('<line x1="' + fmt(x) + '" y1="' + mT + '" x2="' + fmt(x) + '" y2="' + fmt(mT + mapH) + '"/>'); }
    for (i = 1; i < 4; i++) { y = mT + mapH * i / 4; svg.push('<line x1="' + mL + '" y1="' + fmt(y) + '" x2="' + fmt(mL + mapW) + '" y2="' + fmt(y) + '"/>'); }
    svg.push('</g>');
    svg.push('<g class="street-grid-fine" stroke="#e9f1ea" stroke-width="0.6" fill="none">');
    for (i = 1; i < 12; i++) { x = mL + mapW * i / 12; svg.push('<line x1="' + fmt(x) + '" y1="' + mT + '" x2="' + fmt(x) + '" y2="' + fmt(mT + mapH) + '"/>'); }
    for (i = 1; i < 8; i++) { y = mT + mapH * i / 8; svg.push('<line x1="' + mL + '" y1="' + fmt(y) + '" x2="' + fmt(mL + mapW) + '" y2="' + fmt(y) + '"/>'); }
    svg.push('</g>');
    svg.push('<rect class="map-frame" x="' + mL + '" y="' + mT + '" width="' + mapW +
      '" height="' + mapH + '" fill="none" stroke="#d3e2d7" stroke-width="1" rx="4"/>');

    if (caption) {
      svg.push('<text class="map-caption" x="' + (mL + 6) + '" y="' + (mT + 12) +
        '" font-size="8" fill="#4c6b5b" font-family="system-ui, sans-serif">' + esc(caption) + '</text>');
    }

    // --- green spaces -----------------------------------------------------
    greens.forEach(function (g) {
      var p = px(g);
      svg.push('<circle class="greenspace" data-id="' + esc(g.id) + '" cx="' + fmt(p.x) + '" cy="' + fmt(p.y) +
        '" r="7" fill="none" stroke="#7cc48f" stroke-width="1.6"/>');
      if (g.name) {
        svg.push('<text class="greenspace-label" x="' + fmt(p.x) + '" y="' + fmt(p.y + 17) +
          '" font-size="6.5" fill="#4f9165" text-anchor="middle" font-family="system-ui, sans-serif">' +
          esc(g.name) + '</text>');
      }
    });

    // --- route polyline (you -> closest tool) -----------------------------
    if (path.length >= 2) {
      var pts = path.map(function (p) { var q = px(p); return fmt(q.x) + ',' + fmt(q.y); }).join(' ');
      svg.push('<polyline class="route" points="' + pts + '" fill="none" stroke="#1f6b45" ' +
        'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>');
    }

    // --- tool pins (deterministic ring scatter so pins never fully stack) --
    var scatter = tools.length > 1;
    tools.forEach(function (t) {
      var p = px(t);
      var isNearest = nearestId !== null && String(t.id) === String(nearestId);
      if (scatter && !isNearest) {
        var a = hashAngle(t.id) * Math.PI / 180;
        var rad = 5 + (Math.floor(hashAngle(t.id) * 7) % 4);
        p = { x: p.x + Math.cos(a) * rad, y: p.y + Math.sin(a) * rad };
      }
      if (isNearest) {
        svg.push('<circle class="tool-pin nearest" data-id="' + esc(t.id) + '" cx="' + fmt(p.x) + '" cy="' +
          fmt(p.y) + '" r="7" fill="#0f3d2e" stroke="#ffffff" stroke-width="1.6"/>');
        svg.push('<circle class="nearest-halo" data-id="' + esc(t.id) + '" cx="' + fmt(p.x) + '" cy="' +
          fmt(p.y) + '" r="10.5" fill="none" stroke="#0f3d2e" stroke-width="1" opacity="0.35"/>');
      } else {
        svg.push('<circle class="tool-pin" data-id="' + esc(t.id) + '" cx="' + fmt(p.x) + '" cy="' +
          fmt(p.y) + '" r="4" fill="#3f8f63" stroke="#ffffff" stroke-width="1"/>');
      }
    });

    // --- you --------------------------------------------------------------
    if (you) {
      var yp = px(you);
      svg.push('<circle class="you-dot" cx="' + fmt(yp.x) + '" cy="' + fmt(yp.y) +
        '" r="5.5" fill="#0b3d2c" stroke="#ffffff" stroke-width="1.6"/>');
      svg.push('<text class="you-label" x="' + fmt(yp.x + 9) + '" y="' + fmt(yp.y - 9) +
        '" font-size="9" font-weight="600" fill="#0b3d2c" font-family="system-ui, sans-serif">You</text>');
    }

    // --- legend -----------------------------------------------------------
    var legend = [
      { label: 'You', kind: 'you' },
      { label: 'Tools', kind: 'tool' },
      { label: 'Closest', kind: 'closest' },
      { label: 'Green space', kind: 'green' }
    ];
    var ly = height - legendH + 16;
    var lx = mL;
    svg.push('<g class="legend" font-family="system-ui, sans-serif" font-size="8" fill="#41564b">');
    legend.forEach(function (item) {
      if (item.kind === 'you') {
        svg.push('<circle cx="' + (lx + 4) + '" cy="' + (ly - 3) + '" r="4" fill="#0b3d2c"/>');
      } else if (item.kind === 'tool') {
        svg.push('<circle cx="' + (lx + 4) + '" cy="' + (ly - 3) + '" r="3.4" fill="#3f8f63" stroke="#ffffff" stroke-width="0.8"/>');
      } else if (item.kind === 'closest') {
        svg.push('<circle cx="' + (lx + 4) + '" cy="' + (ly - 3) + '" r="4.6" fill="#0f3d2e" stroke="#ffffff" stroke-width="1.2"/>');
      } else {
        svg.push('<circle cx="' + (lx + 4) + '" cy="' + (ly - 3) + '" r="4" fill="none" stroke="#7cc48f" stroke-width="1.4"/>');
      }
      svg.push('<text x="' + (lx + 12) + '" y="' + ly + '">' + esc(item.label) + '</text>');
      lx += 12 + item.label.length * 4.4 + 12;
    });
    svg.push('</g>');

    // --- fixed disclaimer (product red line) ------------------------------
    svg.push('<text class="disclaimer" x="' + mL + '" y="' + (height - 5) +
      '" font-size="6.8" fill="#6d8177" font-family="system-ui, sans-serif">' + esc(ROUTE_NOTE) + '</text>');
    svg.push('</svg>');
    return svg.join('');
  }

  /* -------------------------------------------------------------- copy bits */

  /** "120 m" below a kilometre, otherwise "1.2 km". */
  function formatDistance(m) {
    if (!isFinite(m)) return '—';
    if (m < 1000) return Math.round(m) + ' m';
    return (Math.round(m / 100) / 10) + ' km';
  }

  function resolveName(tool, names) {
    if (typeof names === 'function') return names(tool) || tool.name || 'Tool';
    if (names && typeof names === 'object' && names[tool.id] !== undefined) return names[tool.id];
    return tool.name || 'Tool';
  }

  /** UI line, e.g. "Closest: Galvanised watering can — about 120 m (estimated route)".
   *  `metric` picks which number is quoted: 'route' (grid cost, default) or
   *  'straight' (as-the-crow-flies); the label always says which one it is. */
  function describeNearest(result, names, metric) {
    if (!result || !result.nearest) {
      if (result && result.message === 'no_you') return 'Where are you? We need your location first.';
      return 'No tools available yet — nothing to show on the route map.';
    }
    var n = result.nearest;
    var name = resolveName(n.tool, names);
    if (metric === 'straight') {
      return 'Closest: ' + name + ' — about ' + formatDistance(n.straight_line_m) + ' (straight-line)';
    }
    return 'Closest: ' + name + ' — about ' + formatDistance(n.cost_m) + ' (estimated route)';
  }

  return {
    // constants
    ROUTE_NOTE: ROUTE_NOTE,
    // geometry
    haversineMeters: haversineMeters,
    buildGrid: buildGrid,
    // graph algorithms
    dijkstra: dijkstra,
    shortestPath: shortestPath,
    aStar: aStar,
    // core feature
    planNearestRoute: planNearestRoute,
    // presentation (pure strings)
    renderMapSVG: renderMapSVG,
    describeNearest: describeNearest,
    formatDistance: formatDistance
  };
});
