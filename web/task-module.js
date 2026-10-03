/* =============================================================================
 * Borrow Next Door — Member D: task templates, tool matching, requirements,
 * loans, progress, gap board & outcome reporting.
 *
 * Pure domain logic. No DOM, no storage, no network, no globals besides the
 * single `BND_TASK` namespace this file publishes. Everything here is a plain
 * function over plain data, so it can be unit tested and so member B's backend
 * can be swapped in without touching any of it.
 *
 * Loaded two ways:
 *   <script src="task-module.js">            -> window.BND_TASK
 *   require('./task-module.js')              -> CommonJS export (tests)
 *
 * Owner: D.  Renderer: A (web/app.js).  Persistence: B (FastAPI backend).
 * ---------------------------------------------------------------------------
 * DATA CONTRACT — the frozen B vocabulary (backend/app/schemas_*.py and
 * backend/docs/API_SAMPLES.md are the single source of truth).
 *
 *   CATEGORIES (4)   litter_picker / reusable_gloves / watering_can / hand_trowel
 *   TEMPLATES  (2)   park_cleanup  -> litter_picker + reusable_gloves
 *                    flowerbed_care -> watering_can + hand_trowel
 *   TASK_STATUSES    open | completed            (legacy 'planning' -> 'open')
 *   TOOL availability available | reserved | on_loan | archived
 *                    (a computed field; there is no tool.status storage column)
 *   LOAN_STATUSES    pending / accepted / on_loan / returned / rejected / cancelled
 *   REQUIREMENT_STATES
 *                    self_supplied / pending / confirmed / in_use / fulfilled /
 *                    match_available / missing     (server-derived)
 *
 *   Task (TaskResponse.data shape, plus an optional local-only `postcode`):
 *     id, title, creator {id, display_name}, community_id, template_id,
 *     place {name, latitude, longitude, source, source_id}, status,
 *     requirements[], coordination_ready, completion_eligible,
 *     outcome {note, bags_collected, volunteer_minutes,
 *              verification:'self_reported'} | null,
 *     created_at, completed_at
 *
 *   TaskRequirement (RequirementView shape, exactly seven keys):
 *     id, category, quantity (=1, one row per category per task),
 *     self_supplied (bool), state (derived, see above),
 *     active_loan_id (string|null), candidate_tool_ids (string[], max 5)
 *
 *   Loan (LoanResponse shape):
 *     id, tool_id, tool_name, owner_id, borrower_id, requirement_id, task_id,
 *     status, note, created_at, updated_at, accepted_at, handed_over_at,
 *     returned_at, rejected_at, cancelled_at
 *
 *   Tool (ToolResponse shape):
 *     id, name, category, description, owner {id, display_name},
 *     community {id, postcode, outcode, latitude, longitude, country, source,
 *                source_kind, fetched_at}, availability, is_archived,
 *     distance_m (number|null), created_at, updated_at
 *
 * All timestamps are ISO 8601 UTC strings; numbers are JSON numbers; anything
 * unfilled is `null`, never `""` or `0`.
 *
 * DERIVATION mirrors backend/app/services/tasks.py exactly:
 *   pending -> 'pending', accepted -> 'confirmed', on_loan -> 'in_use',
 *   a handed-over loan that came back -> 'fulfilled',
 *   else self_supplied -> 'self_supplied',
 *   else candidates -> 'match_available', otherwise -> 'missing'.
 *   coordination_ready  = every requirement in {self_supplied, confirmed,
 *                         in_use, fulfilled}
 *   completion_eligible = every requirement in {self_supplied, in_use,
 *                         fulfilled}   (an accepted reservation still has to
 *                         be handed over, and a bare "missing" never counts).
 * ========================================================================== */
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  else if (global) { global.BND_TASK = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ----------------------------------------------------------- vocabulary */

  /** Frozen tool categories (spec 5.1). `group` only drives filter chips. */
  var CATEGORIES = {
    litter_picker:   { id: 'litter_picker',   label: 'Litter picker',   group: 'cleanup' },
    reusable_gloves: { id: 'reusable_gloves', label: 'Reusable gloves', group: 'cleanup' },
    watering_can:    { id: 'watering_can',    label: 'Watering can',    group: 'garden'  },
    hand_trowel:     { id: 'hand_trowel',     label: 'Hand trowel',     group: 'garden'  }
  };

  /** Pre-B slugs, accepted only while migrating stored data. `rake` is gone. */
  var CATEGORY_ALIASES = {
    picker: 'litter_picker',
    gloves: 'reusable_gloves',
    watering: 'watering_can',
    spade: 'hand_trowel'
  };

  /** Frozen loan statuses (spec 6.1). */
  var LOAN_STATUSES = ['pending', 'accepted', 'on_loan', 'returned', 'rejected', 'cancelled'];
  var LOAN_ACTIVE = ['pending', 'accepted', 'on_loan'];       // still in flight
  var LOAN_CONFIRMED = ['accepted', 'on_loan'];               // "落实": reservation stands
  var LOAN_CLOSED = ['returned', 'rejected', 'cancelled'];    // finished, never blocks

  /** Transitions that are forgotten entirely: they never claim anything and
   *  never become history. `returned` stays visible so it can fulfil a
   *  requirement — the backend locks a requirement once it has been borrowed
   *  (REQUIREMENT_ALREADY_FULFILLED), so "returned" is a fact, not a reset. */
  var FORGOTTEN = ['rejected', 'cancelled'];

  /**
   * The four separate facts the brief asks us to record distinctly, each
   * linked to the tool availability that accompanies it (spec 6.1 state
   * machine): pending/accepted reserve the tool, on_loan hands it over, and
   * every closing transition releases it back to `available`.
   */
  var LOAN_STAGES = {
    pending:   { stage: 'requested',   order: 1, label: 'Request sent',         availability: 'reserved'  },
    accepted:  { stage: 'reserved',    order: 2, label: 'Reservation accepted', availability: 'reserved'  },
    on_loan:   { stage: 'handed_over', order: 3, label: 'Handed over',          availability: 'on_loan'   },
    returned:  { stage: 'returned',    order: 4, label: 'Returned',             availability: 'available' },
    rejected:  { stage: 'rejected',    order: 5, label: 'Request declined',     availability: 'available' },
    cancelled: { stage: 'cancelled',   order: 6, label: 'Request cancelled',    availability: 'available' }
  };

  /** The four values Tool.availability can ever carry (no `tool.status`). */
  var TOOL_STATUS = ['available', 'reserved', 'on_loan', 'archived'];
  var TASK_STATUSES = ['open', 'completed'];
  var REQUIREMENT_STATES = ['self_supplied', 'pending', 'confirmed', 'in_use',
    'fulfilled', 'match_available', 'missing'];

  /** Loan status -> requirement state (spec 7.1). */
  var ACTIVE_STATE = { pending: 'pending', accepted: 'confirmed', on_loan: 'in_use' };
  var ACTIVE_STATES = ['pending', 'confirmed', 'in_use'];
  /** Satisfied enough to coordinate around. */
  var COORDINATION_STATES = ['self_supplied', 'confirmed', 'in_use', 'fulfilled'];
  /** Satisfied enough to record the outcome (an accepted loan is not). */
  var COMPLETION_STATES = ['self_supplied', 'in_use', 'fulfilled'];

  var PLACE_SOURCES = ['osm', 'manual', 'fixture'];
  var DEFAULT_MATCH_RADIUS_KM = 2;   // backend MATCH_RADIUS_M = 2000
  var CANDIDATE_LIMIT = 5;           // backend CANDIDATE_LIMIT = 5

  /**
   * The two frozen templates (spec 5.1). `title` / `description` are the
   * backend's exact strings; `name` / `blurb` / `icon` are display aliases the
   * renderer reads, and `consumables` are give-aways shown next to the
   * checklist — they are never loans and never requirements.
   */
  var TEMPLATES = {
    park_cleanup: {
      id: 'park_cleanup',
      title: 'Park cleanup',
      description: 'Collect litter at a local park. Bring bags; litter pickers and reusable gloves are borrowed from neighbours.',
      name: 'Park cleanup',
      blurb: 'Litter pickers, gloves & a helping hand',
      icon: '♧',
      requirements: [{ category: 'litter_picker', quantity: 1 }, { category: 'reusable_gloves', quantity: 1 }],
      consumables: [{ category: 'bags', label: 'Rubbish bags' }]
    },
    flowerbed_care: {
      id: 'flowerbed_care',
      title: 'Flowerbed care',
      description: 'Water and weed a neighbourhood flowerbed. Borrow a watering can and hand trowel from nearby helpers.',
      name: 'Flowerbed care',
      blurb: 'A little planting. A little watering.',
      icon: '✳',
      requirements: [{ category: 'watering_can', quantity: 1 }, { category: 'hand_trowel', quantity: 1 }],
      consumables: [{ category: 'seeds', label: 'Seeds or plants' }]
    }
  };

  var TEMPLATE_LIST = ['park_cleanup', 'flowerbed_care'].map(function (id) { return TEMPLATES[id]; });

  /** Pre-B template ids, accepted only by the migration path. */
  var TEMPLATE_ALIASES = {
    cleanup: 'park_cleanup',
    garden: 'flowerbed_care',
    street_trees: 'flowerbed_care',
    spring_bulbs: 'flowerbed_care'
  };

  /* -------------------------------------------------------------- helpers */

  var _counter = 0;
  function defaultId() {
    _counter += 1;
    return 'req_' + _counter.toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** "eh8 9yl" | "EH89YL" -> "EH8 9YL". Unknown shapes are upper-cased as-is. */
  function normalisePostcode(value) {
    var raw = String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (raw.length > 3) return raw.slice(0, -3) + ' ' + raw.slice(-3);
    return raw;
  }

  /** "EH8 9YL" -> "EH8". Member C naturally holds outcodes, not full postcodes,
   *  so `nearbyPostcodes` accepts either and this makes both work. */
  function outwardCode(value) {
    return normalisePostcode(value).split(' ')[0];
  }

  function isNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function numOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  /** Great-circle distance. Always presented to users as an approximate
   *  straight-line distance, never as a walking route. */
  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, rad = function (d) { return d * Math.PI / 180; };
    var dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Map a (possibly pre-B) category slug onto the frozen vocabulary.
   *  `rake` and anything else unknown come back as null: they were removed. */
  function normaliseCategory(id) {
    if (!id) return null;
    if (Object.prototype.hasOwnProperty.call(CATEGORIES, id)) return id;
    return CATEGORY_ALIASES[id] || null;
  }

  function categoryLabel(id) {
    var norm = normaliseCategory(id);
    if (norm) return CATEGORIES[norm].label;
    return String(id || 'Unknown tool');
  }

  function has(value, key) {
    return !!value && Object.prototype.hasOwnProperty.call(value, key);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function indexById(rows) {
    var map = new Map();
    (rows || []).forEach(function (row) { if (row && row.id !== undefined && row.id !== null) map.set(row.id, row); });
    return map;
  }

  function copyObject(source) {
    var out = {};
    if (source) Object.keys(source).forEach(function (key) { out[key] = source[key]; });
    return out;
  }

  function unique(values) {
    var seen = [], out = [];
    values.forEach(function (v) { if (seen.indexOf(v) === -1) { seen.push(v); out.push(v); } });
    return out;
  }

  function inList(list, value) { return list.indexOf(value) !== -1; }

  function round1(value) { return Math.round(value * 10) / 10; }

  /* ------------------------------------------------- reading B-shaped rows */

  function toolOwnerId(tool) {
    if (!tool) return null;
    if (tool.owner && tool.owner.id !== undefined && tool.owner.id !== null) return tool.owner.id;
    return tool.owner_id !== undefined ? tool.owner_id : null;
  }

  function toolOwnerName(tool, ctx) {
    var id = toolOwnerId(tool);
    if (tool && tool.owner && tool.owner.display_name) return tool.owner.display_name;
    if (ctx && ctx.names && id !== null && ctx.names[id]) return ctx.names[id];
    return id !== null ? id : null;
  }

  /** `availability` is the B field; `status` is only tolerated on legacy rows. */
  function toolAvailability(tool) {
    if (!tool) return null;
    if (tool.availability) return tool.availability;
    if (tool.status) return tool.status;
    return null;
  }

  function toolPostcode(tool) {
    if (!tool) return null;
    if (tool.community && tool.community.postcode) return normalisePostcode(tool.community.postcode);
    if (tool.postcode) return normalisePostcode(tool.postcode);
    return null;
  }

  function toolCommunityId(tool) {
    if (!tool) return null;
    if (tool.community && tool.community.id) return tool.community.id;
    return tool.community_id || null;
  }

  function toolCoords(tool) {
    var source = (tool && tool.community) || tool || {};
    var lat = numOrNull(source.latitude);
    var lon = numOrNull(source.longitude);
    if (lat === null || lon === null) return null;
    return { latitude: lat, longitude: lon };
  }

  function taskCoords(task) {
    if (!task) return null;
    var place = task.place || task;
    var lat = numOrNull(place.latitude);
    var lon = numOrNull(place.longitude);
    if (lat === null || lon === null) return null;
    return { latitude: lat, longitude: lon };
  }

  function taskCommunityId(task) {
    return (task && task.community_id) || null;
  }

  function creatorId(task) {
    if (!task) return null;
    if (task.creator && task.creator.id !== undefined && task.creator.id !== null) return task.creator.id;
    return task.creator_id !== undefined ? task.creator_id : null;
  }

  /** Distance between the task's meeting point and a tool's community centre.
   *  Uses the coordinates we have: haversine first, the server's `distance_m`
   *  (metres, straight line from the query reference) as the fallback. */
  function distanceKmBetween(task, tool) {
    var t = taskCoords(task);
    var u = toolCoords(tool);
    if (t && u) return round1(haversineKm(t.latitude, t.longitude, u.latitude, u.longitude));
    if (tool && isNumber(tool.distance_m)) return round1(tool.distance_m / 1000);
    return null;
  }

  /* ------------------------------------------------------- task construction */

  /**
   * Expand one template into its requirement rows. B keeps exactly one row
   * per category per task with `quantity: 1` — the old slot/slot_total
   * mechanism is gone, so a multi-quantity entry can no longer occur (the two
   * frozen templates do not use one).
   */
  function buildRequirements(templateId, taskId, makeId) {
    var template = TEMPLATES[templateId];
    if (!template) throw new Error('Unknown task template: ' + templateId);
    if (taskId === undefined || taskId === null) throw new Error('buildRequirements() needs a task id');
    var nextId = makeId || defaultId;
    return template.requirements.map(function (entry) {
      return {
        id: nextId(),
        category: entry.category,
        quantity: 1,
        self_supplied: false,
        state: 'missing',
        active_loan_id: null,
        candidate_tool_ids: []
      };
    });
  }

  /** `outcome` on a task that has not been completed yet. */
  function emptyOutcome() {
    return null;
  }

  /** DEPRECATED — older renderer code asked for an "empty impact block".
   *  Kept as a render-safe outcome record; `outcome` itself stays `null`
   *  until the organiser submits (see emptyOutcome). */
  function emptyImpact() {
    return { note: '', bags_collected: null, volunteer_minutes: null, verification: 'self_reported' };
  }

  function validState(value) {
    return inList(REQUIREMENT_STATES, value);
  }

  /** Build a brand-new `open` task in the TaskResponse shape. */
  function createTask(input) {
    input = input || {};
    var templateId = input.templateId || 'park_cleanup';
    if (!TEMPLATES[templateId]) throw new Error('Unknown task template: ' + templateId);
    var id = input.id || (input.nextId ? input.nextId() : defaultId());

    var place;
    if (input.place && typeof input.place === 'object') {
      place = {
        name: input.place.name || input.placeName || 'Neighbourhood green space (sample)',
        latitude: numOrNull(input.place.latitude),
        longitude: numOrNull(input.place.longitude),
        source: inList(PLACE_SOURCES, input.place.source) ? input.place.source : 'manual',
        source_id: input.place.source_id === undefined ? null : input.place.source_id
      };
    } else {
      place = {
        name: input.placeName || 'Neighbourhood green space (sample)',
        latitude: numOrNull(input.latitude),
        longitude: numOrNull(input.longitude),
        source: inList(PLACE_SOURCES, input.placeSource) ? input.placeSource : 'manual',
        source_id: has(input, 'placeSourceId') ? input.placeSourceId : null
      };
    }

    var creatorIdValue = input.creatorId === undefined || input.creatorId === null ? '' : String(input.creatorId);

    return {
      id: id,
      title: input.title || TEMPLATES[templateId].title,
      creator: { id: creatorIdValue, display_name: input.creatorName || creatorIdValue },
      community_id: input.communityId || null,
      template_id: templateId,
      place: place,
      status: 'open',
      requirements: buildRequirements(templateId, id, input.nextId),
      coordination_ready: false,
      completion_eligible: false,
      outcome: null,
      created_at: input.createdAt || new Date().toISOString(),
      completed_at: null
    };
  }

  /**
   * Recompute the two server-derived booleans from the requirement states
   * currently stored on the task (spec 7.1).
   */
  function refreshFlags(task) {
    if (!task || !Array.isArray(task.requirements)) return task;
    var states = task.requirements.map(function (row) { return row && row.state; });
    task.coordination_ready = states.length > 0 && states.every(function (s) { return inList(COORDINATION_STATES, s); });
    task.completion_eligible = states.length > 0 && states.every(function (s) { return inList(COMPLETION_STATES, s); });
    return task;
  }

  function freshRequirement(category, makeId) {
    return {
      id: (makeId || defaultId)(),
      category: category,
      quantity: 1,
      self_supplied: false,
      state: 'missing',
      active_loan_id: null,
      candidate_tool_ids: []
    };
  }

  /**
   * Bring a task loaded from storage up to the B contract, in place.
   * Handles the whole pre-B shape: `status: 'planning'`, `creator_id`,
   * `postcode` / `place_name` / `latitude` / `longitude`, slot-style
   * requirements (source_type, slot, slot_total, loan_request_id), the legacy
   * `self: [...]` array, old category and template slugs, and
   * `outcome_note` + `impact` (would_have_bought_new is dropped: B has no
   * such figure). Returns the same object; `migrated` says whether anything
   * changed. Pass `options.ctx` ({tools, loans, names, viewerId}) to also
   * refresh the derived requirement states and flags.
   */
  function ensureRequirements(task, options) {
    options = options || {};
    if (!task || typeof task !== 'object') throw new Error('ensureRequirements() needs a task');
    var nextId = options.nextId || defaultId;
    var migrated = false;

    var templateId = task.template_id;
    if (!TEMPLATES[templateId]) {
      templateId = TEMPLATE_ALIASES[templateId] || 'park_cleanup';
      task.template_id = templateId;
      migrated = true;
    }

    if (task.status !== 'open' && task.status !== 'completed') {
      task.status = 'open';   // legacy 'planning'
      migrated = true;
    }

    if (!task.creator || typeof task.creator !== 'object') {
      var rawCreator = task.creator_id === undefined || task.creator_id === null ? '' : String(task.creator_id);
      task.creator = { id: rawCreator, display_name: rawCreator };
      migrated = true;
    }
    if (task.creator_id !== undefined) { delete task.creator_id; migrated = true; }
    if (typeof task.title !== 'string' || !task.title) {
      task.title = TEMPLATES[templateId].title;
      migrated = true;
    }
    if (task.community_id === undefined) { task.community_id = null; migrated = true; }

    if (!task.place || typeof task.place !== 'object') {
      task.place = {
        name: task.place_name || 'Neighbourhood green space (sample)',
        latitude: numOrNull(task.latitude),
        longitude: numOrNull(task.longitude),
        source: 'manual',
        source_id: null
      };
      migrated = true;
    }
    ['place_name', 'latitude', 'longitude', 'postcode'].forEach(function (key) {
      if (task[key] !== undefined) { delete task[key]; migrated = true; }
    });

    var templateCategories = TEMPLATES[templateId].requirements.map(function (entry) { return entry.category; });

    if (!Array.isArray(task.requirements) || task.requirements.length === 0) {
      task.requirements = buildRequirements(templateId, task.id, nextId);
      migrated = true;
    } else {
      var seen = {};
      var rows = [];
      task.requirements.forEach(function (row) {
        var category = normaliseCategory(row && row.category);
        // Unmapped slugs (rake, unknowns), duplicates and out-of-template
        // categories are dropped: a B task has exactly the template's rows.
        if (!category || seen[category] || templateCategories.indexOf(category) === -1) return;
        seen[category] = true;
        var selfSupplied = row.self_supplied === true || row.source_type === 'self';
        var activeLoanId = has(row, 'active_loan_id') ? row.active_loan_id
          : (row.loan_request_id || null);
        var state = validState(row.state) ? row.state
          : (selfSupplied ? 'self_supplied' : (activeLoanId ? 'pending' : 'missing'));
        rows.push({
          id: row.id || nextId(),
          category: category,
          quantity: 1,
          self_supplied: !!selfSupplied,
          state: state,
          active_loan_id: activeLoanId,
          candidate_tool_ids: Array.isArray(row.candidate_tool_ids) ? row.candidate_tool_ids.slice(0, CANDIDATE_LIMIT) : []
        });
      });
      templateCategories.forEach(function (category) {
        if (!seen[category]) { rows.push(freshRequirement(category, nextId)); migrated = true; }
      });
      if (JSON.stringify(rows) !== JSON.stringify(task.requirements)) {
        task.requirements = rows;
        migrated = true;
      }
    }

    // Legacy `self: ['gloves']` -> flip the matching row.
    if (Array.isArray(task.self)) {
      task.self.forEach(function (category) {
        var norm = normaliseCategory(category);
        if (!norm) return;   // rake and friends are gone
        var row = task.requirements.find(function (r) { return r.category === norm; });
        if (!row) {
          row = freshRequirement(norm, nextId);
          task.requirements.push(row);
        }
        row.self_supplied = true;
        row.state = 'self_supplied';
        row.active_loan_id = null;
        row.candidate_tool_ids = [];
      });
      delete task.self;
      migrated = true;
    }

    if (task.impact !== undefined || task.outcome_note !== undefined) {
      var note = typeof task.outcome_note === 'string' ? task.outcome_note : '';
      var impact = (task.impact && typeof task.impact === 'object') ? task.impact : {};
      if (task.status === 'completed') {
        var minutes = has(impact, 'volunteer_minutes') ? impact.volunteer_minutes : impact.participant_minutes;
        task.outcome = {
          note: note,
          bags_collected: numOrNull(impact.bags_collected),
          volunteer_minutes: numOrNull(minutes),
          verification: 'self_reported'
        };
      } else {
        task.outcome = task.outcome || null;
      }
      delete task.impact;
      delete task.outcome_note;
      migrated = true;
    }

    if (task.outcome === undefined) { task.outcome = null; migrated = true; }
    else if (task.outcome && typeof task.outcome === 'object') {
      var clean = {
        note: typeof task.outcome.note === 'string' ? task.outcome.note : '',
        bags_collected: numOrNull(task.outcome.bags_collected),
        volunteer_minutes: numOrNull(task.outcome.volunteer_minutes),
        verification: 'self_reported'
      };
      if (JSON.stringify(clean) !== JSON.stringify(task.outcome)) {
        task.outcome = clean;
        migrated = true;
      }
    } else if (task.outcome !== null) {
      task.outcome = null;
      migrated = true;
    }

    if (typeof task.coordination_ready !== 'boolean') { task.coordination_ready = false; migrated = true; }
    if (typeof task.completion_eligible !== 'boolean') { task.completion_eligible = false; migrated = true; }
    if (typeof task.created_at !== 'string') { task.created_at = new Date().toISOString(); migrated = true; }
    if (task.completed_at === undefined) { task.completed_at = null; migrated = true; }

    if (options.ctx) { syncRequirements(task, options.ctx); }
    else { refreshFlags(task); }
    return { task: task, migrated: migrated };
  }

  /** True when any requirement still carries a live loan pointer. */
  function hasActiveClaim(requirements) {
    return (requirements || []).some(function (r) { return !!(r && r.active_loan_id); });
  }

  /** Template switches are local-only; the backend freezes templates at
   *  creation time. Refuse while the task has a loan in flight or is done. */
  function canChangeTemplate(task, ctx) {
    if (!task || task.status === 'completed') return false;
    var loans = ((ctx && ctx.loans) || []).filter(function (l) {
      return l && l.task_id === task.id && inList(LOAN_ACTIVE, l.status);
    });
    return loans.length === 0;
  }

  /**
   * Switch template in place. `self_supplied` choices survive only for
   * categories the new template still asks for (the two frozen templates
   * share none, so a switch starts from a clean set). Refuses while a
   * request is in flight or after the task is completed.
   */
  function setTemplate(task, templateId, options) {
    options = options || {};
    if (!TEMPLATES[templateId]) return { ok: false, reason: 'unknown_template' };
    if (task && task.status === 'completed') return { ok: false, reason: 'task_completed' };
    if (!canChangeTemplate(task, options)) return { ok: false, reason: 'active_requests' };
    ensureRequirements(task, options);
    var keepSelf = {};
    task.requirements.forEach(function (r) {
      if (r.self_supplied) keepSelf[r.category] = true;
    });
    task.template_id = templateId;
    task.requirements = buildRequirements(templateId, task.id, options.nextId);
    task.requirements.forEach(function (r) {
      if (keepSelf[r.category]) { r.self_supplied = true; r.state = 'self_supplied'; }
    });
    refreshFlags(task);
    return { ok: true };
  }

  /**
   * Flip one requirement between "borrow it" and "bring my own"
   * (the local mirror of PUT .../requirements/:id/self-supply).
   * Locked exactly where the backend locks it (REQUIREMENT_LOCKED): a live
   * request or an actual borrowing history.
   */
  function setSlotSource(task, requirementId, sourceType) {
    ensureRequirements(task);
    var requirement = task.requirements.find(function (r) { return r.id === requirementId; });
    if (!requirement) return { ok: false, reason: 'unknown_slot' };
    if (sourceType !== 'self' && sourceType !== 'loan') return { ok: false, reason: 'unknown_source' };
    if (requirement.active_loan_id || (validState(requirement.state) &&
        (inList(ACTIVE_STATES, requirement.state) || requirement.state === 'fulfilled'))) {
      return { ok: false, reason: 'requirement_locked' };
    }
    if (sourceType === 'self') {
      requirement.self_supplied = true;
      requirement.state = 'self_supplied';
      requirement.candidate_tool_ids = [];
    } else {
      requirement.self_supplied = false;
      requirement.state = requirement.active_loan_id && inList(ACTIVE_STATES, requirement.state)
        ? requirement.state : 'missing';
      requirement.candidate_tool_ids = [];
    }
    refreshFlags(task);
    return { ok: true, requirement: requirement };
  }

  /* --------------------------------------------------------------- matching */

  /**
   * Candidate tools for one category — the local mirror of the backend's
   * `_candidate_tools` (spec 8.3).
   *
   * Rules, in order:
   *   1. right category, `availability === 'available'` (reserved / on_loan /
   *      archived are never offered) and not archived;
   *   2. never owned by the task's creator, and never the viewer's own tool
   *      (borrowing your own tool is 403 SELF_BORROW_FORBIDDEN);
   *   3. proximity: same community wins outright; otherwise the tool must be
   *      within `radiusKm` (default 2 km, the backend's MATCH_RADIUS_M) or
   *      named by member C's `nearbyPostcodes` (a full postcode or an
   *      outcode). Anything else is `elsewhere` and is only returned when the
   *      caller opts in with `allowElsewhere`.
   *
   * Distance comes from `tool.distance_m` or haversine between the task's
   * place and the tool's community centre — whichever we can compute.
   * Returns descriptors, not tools, so the UI can label the tier and the
   * (approximate, straight-line) distance honestly.
   */
  function matchTools(category, ctx) {
    ctx = ctx || {};
    var task = ctx.task || {};
    var wanted = normaliseCategory(category);
    if (!wanted) return [];
    var taskCommunity = taskCommunityId(task);
    var nearby = (ctx.nearbyPostcodes || []).map(normalisePostcode);
    var nearbyOutcodes = (ctx.nearbyPostcodes || []).map(function (value) { return outwardCode(value); });
    var radiusKm = isNumber(ctx.radiusKm) ? ctx.radiusKm : DEFAULT_MATCH_RADIUS_KM;
    var owner = creatorId(task);
    var pools = { same_community: [], nearby: [], elsewhere: [] };

    (ctx.tools || []).forEach(function (tool) {
      if (!tool) return;
      if (normaliseCategory(tool.category) !== wanted) return;
      if (toolAvailability(tool) !== 'available') return;
      if (tool.is_archived) return;
      var ownerId = toolOwnerId(tool);
      if (owner !== null && owner !== '' && ownerId === owner) return;
      if (ctx.viewerId && ownerId === ctx.viewerId) return;

      var communityId = toolCommunityId(tool);
      var postcode = toolPostcode(tool);
      var outcode = postcode ? outwardCode(postcode) : null;
      var distanceKm = distanceKmBetween(task, tool);

      var scope;
      if (taskCommunity && communityId && communityId === taskCommunity) scope = 'same_community';
      else if ((postcode && nearby.indexOf(postcode) !== -1) ||
               (outcode && nearbyOutcodes.indexOf(outcode) !== -1)) scope = 'nearby';
      else if (distanceKm !== null && distanceKm <= radiusKm) scope = 'nearby';
      else scope = 'elsewhere';

      pools[scope].push({
        tool: tool,
        toolId: tool.id,
        toolName: tool.name,
        category: wanted,
        ownerId: ownerId,
        ownerName: toolOwnerName(tool, ctx),
        communityId: communityId,
        postcode: postcode,
        scope: scope,
        distanceKm: distanceKm,
        createdAt: tool.created_at || null
      });
    });

    var tierUsed = pools.same_community.length ? 'same_community'
                 : pools.nearby.length ? 'nearby'
                 : 'elsewhere';
    // An "elsewhere" tool is not a neighbourhood match; only offer it when the
    // caller explicitly opted into a wider radius.
    if (tierUsed === 'elsewhere' && !ctx.allowElsewhere) return [];

    return pools[tierUsed].sort(function (a, b) {
      if (a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      if (a.distanceKm !== null && b.distanceKm === null) return -1;
      if (a.distanceKm === null && b.distanceKm !== null) return 1;
      var ca = String(a.createdAt || ''), cb = String(b.createdAt || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      return String(a.toolId) < String(b.toolId) ? -1 : 1;
    });
  }

  /**
   * Group a task's loans under the requirement they fill.
   *
   * Only `requirement_id` decides membership — the backend allows a null
   * `requirement_id` (a standalone loan, spec 8.4) and such loans never
   * change a requirement's state, so orphans are not auto-assigned.
   * `rejected` / `cancelled` are forgotten; `returned` is kept because it is
   * what fulfils a requirement. `toolById` may be a Map, an array or missing:
   * B's LoanResponse already carries `tool_name` / `owner_id`.
   */
  function claimLoans(requirements, loans, toolById) {
    var claims = new Map();
    (requirements || []).forEach(function (r) { if (r) claims.set(r.id, []); });
    var byId = toolById instanceof Map ? toolById : indexById(toolById || []);
    (loans || []).forEach(function (loan) {
      if (!loan) return;
      if (inList(FORGOTTEN, loan.status)) return;
      if (loan.requirement_id === undefined || loan.requirement_id === null) return;
      if (!claims.has(loan.requirement_id)) return;
      claims.get(loan.requirement_id).push({ request: loan, tool: byId.get(loan.tool_id) || null });
    });
    return claims;
  }

  function newestFirst(a, b) {
    var ca = String(a.created_at || ''), cb = String(b.created_at || '');
    if (ca !== cb) return ca < cb ? 1 : -1;
    return String(a.id) < String(b.id) ? 1 : -1;
  }

  /**
   * Derive one requirement's B state. Mirrors `_requirement_state` in the
   * backend service:
   *
   *   1. a visible active loan wins  -> pending / confirmed / in_use
   *   2. a visible handed-over loan that came back -> fulfilled
   *   3. with no decisive loan record, trust the server's stored row
   *      (its `state` / `active_loan_id` are authoritative, and a stranger's
   *      response hides `active_loan_id` but keeps the state);
   *   4. otherwise recompute: self_supplied, then candidates
   *      (match_available) or missing.
   *
   * Returns {state, activeLoanId, candidateToolIds, activeLoan}.
   */
  function deriveRequirement(requirement, ctx) {
    ctx = ctx || {};
    var req = requirement || {};
    var rawLoans = Array.isArray(ctx.loans) ? ctx.loans : null;
    var seen = rawLoans === null ? null : rawLoans.filter(function (l) {
      return l && l.requirement_id === req.id;
    });

    if (seen) {
      var active = seen.filter(function (l) { return inList(LOAN_ACTIVE, l.status); }).sort(newestFirst);
      if (active.length) {
        return {
          state: ACTIVE_STATE[active[0].status],
          activeLoanId: active[0].id,
          activeLoan: active[0],
          candidateToolIds: []
        };
      }
      var returned = seen.filter(function (l) {
        return l.status === 'returned' && (l.handed_over_at || l.returned_at);
      });
      if (returned.length) return { state: 'fulfilled', activeLoanId: null, activeLoan: null, candidateToolIds: [] };
    }

    if (req.state === 'fulfilled') return { state: 'fulfilled', activeLoanId: null, activeLoan: null, candidateToolIds: [] };
    if (req.self_supplied) return { state: 'self_supplied', activeLoanId: null, activeLoan: null, candidateToolIds: [] };

    // No loan record contradicts the stored row: believe the server.
    if (seen === null || seen.length === 0) {
      if (inList(ACTIVE_STATES, req.state)) {
        return { state: req.state, activeLoanId: req.active_loan_id || null, activeLoan: null, candidateToolIds: [] };
      }
      if (req.active_loan_id) {
        return { state: 'pending', activeLoanId: req.active_loan_id, activeLoan: null, candidateToolIds: [] };
      }
    }

    var candidates = matchTools(req.category, ctx);
    if (candidates.length) {
      return {
        state: 'match_available',
        activeLoanId: null,
        activeLoan: null,
        candidateToolIds: candidates.slice(0, CANDIDATE_LIMIT).map(function (c) { return c.toolId; })
      };
    }
    if (req.state === 'match_available') {
      return {
        state: 'match_available',
        activeLoanId: null,
        activeLoan: null,
        candidateToolIds: Array.isArray(req.candidate_tool_ids) ? req.candidate_tool_ids.slice(0, CANDIDATE_LIMIT) : []
      };
    }
    return { state: 'missing', activeLoanId: null, activeLoan: null, candidateToolIds: [] };
  }

  function displayOwner(loan, tool, ctx) {
    var id = loan && loan.owner_id !== undefined && loan.owner_id !== null
      ? loan.owner_id
      : (tool ? toolOwnerId(tool) : null);
    if (loan && loan.owner_name) return loan.owner_name;
    if (ctx && ctx.names && id !== null && ctx.names[id]) return ctx.names[id];
    if (tool && tool.owner && tool.owner.display_name) return tool.owner.display_name;
    return id !== null ? id : 'a neighbour';
  }

  function describeLoan(item, ctx) {
    var loan = item.request || {};
    var tool = item.tool || null;
    var stage = LOAN_STAGES[loan.status] ||
      { stage: loan.status, order: 9, label: loan.status, availability: null };
    return {
      requestId: loan.id,
      requirementId: loan.requirement_id || null,
      toolId: loan.tool_id,
      toolName: loan.tool_name || (tool ? tool.name : null),
      ownerId: loan.owner_id !== undefined && loan.owner_id !== null ? loan.owner_id : (tool ? toolOwnerId(tool) : null),
      ownerName: displayOwner(loan, tool, ctx),
      borrowerId: loan.borrower_id !== undefined ? loan.borrower_id : null,
      status: loan.status,
      stage: stage.stage,
      stageOrder: stage.order,
      stageLabel: stage.label,
      toolAvailability: stage.availability,
      createdAt: loan.created_at || null,
      updatedAt: loan.updated_at || null,
      acceptedAt: loan.accepted_at || null,
      handedOverAt: loan.handed_over_at || null,
      returnedAt: loan.returned_at || null,
      rejectedAt: loan.rejected_at || null,
      cancelledAt: loan.cancelled_at || null
    };
  }

  /**
   * Describe one requirement row. This is the single place that decides what
   * "match available" vs "already handled" means, so the renderer never
   * guesses. `state` is always one of REQUIREMENT_STATES.
   *
   *   self_supplied  the participant brings their own
   *   pending        a request exists, awaiting the owner
   *   confirmed      reservation accepted (not handed over yet)
   *   in_use         handed over and still out
   *   fulfilled      borrowed, used and returned
   *   match_available a neighbour's tool could be requested right now
   *   missing        nothing yet
   */
  function describeRequirement(requirement, ctx, claims) {
    ctx = ctx || {};
    var req = requirement || {};
    var derived = deriveRequirement(req, ctx);

    if (!claims) {
      claims = claimLoans([req], Array.isArray(ctx.loans) ? ctx.loans : [], indexById(ctx.tools));
    }
    var items = claims.get(req.id) || [];
    var history = items.filter(function (i) { return i.request.status === 'returned'; });

    var stage;
    if (derived.state === 'self_supplied') stage = 'self';
    else if (derived.activeLoan) stage = (LOAN_STAGES[derived.activeLoan.status] || {}).stage || null;
    else if (derived.state === 'fulfilled') stage = 'fulfilled';
    else stage = null;

    var category = normaliseCategory(req.category) || req.category || null;
    var tools = [];
    if (derived.state === 'match_available') tools = matchTools(category, ctx);

    var descriptor = {
      requirement: req,
      requirementId: req.id !== undefined ? req.id : null,
      category: category,
      label: categoryLabel(category),
      selfSupplied: derived.state === 'self_supplied' || !!req.self_supplied,
      state: derived.state,
      confirmed: inList(COORDINATION_STATES, derived.state),
      pending: derived.state === 'pending',
      stage: stage,
      statusText: '',
      activeLoanId: derived.activeLoanId || null,
      candidateToolIds: derived.candidateToolIds || [],
      loans: items.map(function (i) { return describeLoan(i, ctx); }),
      history: history.map(function (i) { return describeLoan(i, ctx); }),
      tools: tools
    };

    var ownerText = '';
    if (derived.activeLoan) {
      var activeItem = items.filter(function (i) { return i.request.id === derived.activeLoanId; })[0];
      ownerText = displayOwner(derived.activeLoan, activeItem ? activeItem.tool : null, ctx);
    } else if (derived.state === 'fulfilled') {
      var lastReturned = history.length ? history[history.length - 1] : null;
      if (lastReturned) ownerText = displayOwner(lastReturned.request, lastReturned.tool, ctx);
    }

    switch (derived.state) {
      case 'self_supplied':
        descriptor.statusText = 'Confirmed · you are bringing your own';
        break;
      case 'pending':
        descriptor.statusText = 'Awaiting ' + ownerText + ' to respond';
        break;
      case 'confirmed':
        descriptor.statusText = 'Confirmed · reservation accepted by ' + ownerText;
        break;
      case 'in_use':
        descriptor.statusText = 'In use · handed over by ' + ownerText;
        break;
      case 'fulfilled':
        descriptor.statusText = ownerText
          ? 'Fulfilled · borrowed from ' + ownerText + ' and returned'
          : 'Fulfilled · borrowed and returned';
        break;
      case 'match_available':
        descriptor.statusText = tools.length
          ? 'Available to request from ' + tools[0].ownerName +
            (tools[0].scope === 'nearby' ? ' (nearby)' : '')
          : 'A neighbour has a matching tool available';
        break;
      default:
        descriptor.statusText = 'Still looking for a neighbour’s tool';
    }
    return descriptor;
  }

  /** Describe every requirement on a task, sharing one claim pass. */
  function describeTask(task, ctx) {
    ctx = ctx || {};
    // Match against this task's own place, even when the caller passes one
    // context for a whole list of tasks (see wantedBoard).
    var local = copyObject(ctx);
    local.task = task;
    var toolById = indexById(local.tools);
    var claims = claimLoans(task.requirements || [], Array.isArray(local.loans) ? local.loans : [], toolById);
    return (task.requirements || []).map(function (r) {
      var row = describeRequirement(r, local, claims);
      row.taskId = task.id;
      return row;
    });
  }

  /**
   * Recompute and store the derived requirement fields (state,
   * active_loan_id, candidate_tool_ids) plus the two task flags — the local
   * equivalent of what the backend does on every task read. Call before
   * persisting a locally changed task.
   */
  function syncRequirements(task, ctx) {
    if (!task || !Array.isArray(task.requirements)) return task;
    var local = copyObject(ctx);
    local.task = task;
    task.requirements.forEach(function (row) {
      var derived = deriveRequirement(row, local);
      row.state = derived.state;
      row.active_loan_id = derived.activeLoanId || null;
      row.candidate_tool_ids = derived.candidateToolIds || [];
    });
    return refreshFlags(task);
  }

  /**
   * The two TaskResponse flags without writing anything. Uses `ctx`
   * (tools + loans) when given, otherwise the states already stored on the
   * task — which is exactly what the server would have sent.
   */
  function taskFlags(task, ctx) {
    if (!task) return { coordination_ready: false, completion_eligible: false };
    var states;
    if (ctx && (Array.isArray(ctx.loans) || Array.isArray(ctx.tools))) {
      var local = copyObject(ctx);
      local.task = task;
      states = (task.requirements || []).map(function (row) { return deriveRequirement(row, local).state; });
    } else {
      states = (task.requirements || []).map(function (row) { return row && row.state; });
    }
    return {
      coordination_ready: states.length > 0 && states.every(function (s) { return inList(COORDINATION_STATES, s); }),
      completion_eligible: states.length > 0 && states.every(function (s) { return inList(COMPLETION_STATES, s); })
    };
  }

  /**
   * Roll a task's requirements into one progress figure for the header and
   * the "gap changed" story. `nextAction` is deliberately one sentence, so
   * the renderer cannot invent a stronger claim than the data supports.
   */
  function taskProgress(task, ctx) {
    var rows = describeTask(task, ctx);
    var total = rows.length;
    var confirmed = rows.filter(function (r) { return r.confirmed; }).length;
    var pending = rows.filter(function (r) { return r.pending; }).length;
    var missing = total - confirmed;
    var missingCategories = unique(rows.filter(function (r) { return !r.confirmed; }).map(function (r) { return r.category; }));
    var confirmedCategories = unique(rows.filter(function (r) { return r.confirmed; }).map(function (r) { return r.category; }));
    var coordinationReady = total > 0 && confirmed === total;
    var completionEligible = total > 0 && rows.every(function (r) { return inList(COMPLETION_STATES, r.state); });

    var nextAction;
    if (task.status === 'completed') nextAction = 'Action recorded. Outstanding returns are tracked separately.';
    else if (confirmed === 0 && pending === 0) nextAction = 'Find a neighbour with the first tool.';
    else if (missing > 0) nextAction = missing + (missing === 1 ? ' tool' : ' tools') + ' still to confirm.';
    else if (!completionEligible) nextAction = 'Every tool is confirmed. Arrange the handover.';
    else nextAction = 'Everything is in place. Record the outcome.';

    return {
      total: total,
      confirmed: confirmed,
      pending: pending,
      missing: missing,
      percent: total ? Math.round(confirmed / total * 100) : 0,
      complete: total > 0 && confirmed === total,
      rows: rows,
      missingCategories: missingCategories,
      confirmedCategories: confirmedCategories,
      coordinationReady: coordinationReady,
      completionEligible: completionEligible,
      nextAction: nextAction
    };
  }

  /**
   * The "missing tool" board: what the neighbourhood as a whole still has no
   * candidate for. This is the direct product answer to "more neighbours
   * makes this more useful", so it counts requirements, not tasks, and only
   * counts `missing` — publishing a matching tool closes the gap before
   * anybody has borrowed it.
   */
  function wantedBoard(tasks, ctx) {
    ctx = ctx || {};
    var board = new Map();
    (tasks || []).forEach(function (task) {
      if (!task || task.status === 'completed') return;
      describeTask(task, ctx).forEach(function (row) {
        if (row.state !== 'missing') return;
        var entry = board.get(row.category) || { category: row.category, label: row.label, slots: 0, taskIds: [] };
        entry.slots += 1;
        if (entry.taskIds.indexOf(task.id) === -1) entry.taskIds.push(task.id);
        board.set(row.category, entry);
      });
    });
    return Array.from(board.values()).map(function (e) {
      return { category: e.category, label: e.label, slots: e.slots, taskCount: e.taskIds.length, taskIds: e.taskIds };
    }).sort(function (a, b) { return b.slots - a.slots || a.label.localeCompare(b.label); });
  }

  /* ---------------------------------------------------------------- impact */

  function ctxFor(task, ctx) {
    var local = copyObject(ctx);
    local.task = task;
    return local;
  }

  /**
   * Requirements satisfied by a reservation or by bringing your own —
   * deliberately wider than "in your hands right now".
   */
  function coveredSlots(task, ctx) {
    if (!task || !Array.isArray(task.requirements)) return 0;
    var local = ctxFor(task, ctx);
    return task.requirements.filter(function (r) {
      return inList(COORDINATION_STATES, deriveRequirement(r, local).state);
    }).length;
  }

  /** ...but only the ones covered by an actual borrow, not by self-supply. */
  function loanCoveredSlots(task, ctx) {
    if (!task || !Array.isArray(task.requirements)) return 0;
    var local = ctxFor(task, ctx);
    return task.requirements.filter(function (r) {
      var state = deriveRequirement(r, local).state;
      return state === 'confirmed' || state === 'in_use' || state === 'fulfilled';
    }).length;
  }

  var DISCLAIMER = 'Each figure is counted separately: borrowing the same tool more than once is ' +
    'still one tool, a confirmed tool is not a completed action, and every figure here is ' +
    'self-reported by participants rather than measured by us.';

  function taskOutcomeFigures(task) {
    if (task && task.outcome && typeof task.outcome === 'object') {
      return {
        bags: numOrNull(task.outcome.bags_collected),
        minutes: numOrNull(task.outcome.volunteer_minutes)
      };
    }
    // Tolerate an unmigrated row rather than silently reporting zero.
    var legacy = task && task.impact;
    if (legacy && typeof legacy === 'object') {
      return {
        bags: numOrNull(legacy.bags_collected),
        minutes: numOrNull(has(legacy, 'volunteer_minutes') ? legacy.volunteer_minutes : legacy.participant_minutes)
      };
    }
    return { bags: null, minutes: null };
  }

  /**
   * Structured impact panel. Every metric carries its own source, basis and
   * caveat, and `available: false` means "never collected" rather than a
   * quietly misleading zero. Scope is the B locality: pass `communityId`
   * (a TaskResponse field), or `postcode` for pre-B rows that still carry
   * one. There is no "would have bought new" figure in B, so there is no
   * metric for it either.
   */
  function impactReport(tasks, loans, options) {
    options = options || {};
    var scopeLabel, scopePostcode = null, scopeCommunity = null, filter;
    if (options.communityId) {
      scopeCommunity = options.communityId;
      scopeLabel = 'this community';
      filter = function (t) { return t && t.community_id === scopeCommunity; };
    } else if (options.postcode) {
      scopePostcode = normalisePostcode(options.postcode);
      var anyPostcode = (tasks || []).some(function (t) { return !!(t && t.postcode); });
      // B tasks carry `community_id`, not `postcode`; only scope when at least
      // one row actually has one, otherwise "this postcode" would silently
      // report nothing (an uncollected figure must not read as zero).
      if (anyPostcode) {
        scopeLabel = 'this postcode';
        filter = function (t) { return !!(t && t.postcode) && normalisePostcode(t.postcode) === scopePostcode; };
      } else {
        scopeLabel = 'all recorded data';
        filter = function () { return true; };
      }
    } else {
      scopeLabel = 'all recorded data';
      filter = function () { return true; };
    }

    var allTasks = (tasks || []).filter(filter);
    var taskIds = new Set(allTasks.map(function (t) { return t.id; }));
    var allLoans = (loans || []).filter(function (l) { return l && taskIds.has(l.task_id); });
    var ctx = { tools: options.tools || [], loans: allLoans, names: options.names };

    var returned = allLoans.filter(function (l) { return l.status === 'returned'; });
    var fullyCovered = allTasks.filter(function (t) {
      var total = (t.requirements || []).length;
      return total > 0 && coveredSlots(t, ctx) === total;
    });
    var completed = allTasks.filter(function (t) { return t.status === 'completed'; });

    var bagValues = allTasks.map(function (t) { return taskOutcomeFigures(t).bags; })
      .filter(function (v) { return v !== null; });
    var minuteValues = allTasks.map(function (t) { return taskOutcomeFigures(t).minutes; })
      .filter(function (v) { return v !== null; });

    var metrics = [
      {
        key: 'completed_loans',
        value: returned.length,
        label: 'Completed loans',
        source: 'Loan records with status "returned"',
        basis: 'recorded',
        scope: scopeLabel,
        available: true,
        caveat: 'One tool borrowed many times is still one tool.'
      },
      {
        key: 'actions_with_tools_confirmed',
        value: fullyCovered.length,
        label: 'Actions with every tool confirmed',
        source: 'Accepted reservations, self-supplied requirements and returned loans',
        basis: 'recorded',
        scope: scopeLabel,
        available: true,
        caveat: 'A confirmed tool is not a completed action.'
      },
      {
        key: 'completed_actions',
        value: completed.length,
        label: 'Community actions reported',
        source: 'Task records submitted by the organiser',
        basis: 'self-reported',
        scope: scopeLabel,
        available: true,
        caveat: 'Reported by the organiser, not verified on site.'
      },
      {
        key: 'bags_collected',
        value: bagValues.reduce(function (sum, v) { return sum + v; }, 0),
        label: 'Bags collected',
        source: 'Outcome figures reported by the organiser',
        basis: 'self-reported',
        scope: scopeLabel,
        available: bagValues.length > 0,
        caveat: 'Self-reported. No waste is weighed or audited.'
      },
      {
        key: 'volunteer_minutes',
        value: minuteValues.reduce(function (sum, v) { return sum + v; }, 0),
        label: 'Minutes of volunteer time',
        source: 'Outcome figures reported by the organiser',
        basis: 'self-reported',
        scope: scopeLabel,
        available: minuteValues.length > 0,
        caveat: 'Self-reported and rounded by whoever filled the form in.'
      }
    ];

    return {
      scope: scopeLabel,
      communityId: scopeCommunity,
      postcode: scopePostcode,
      reportedActions: completed.length,
      metrics: metrics,
      disclaimer: DISCLAIMER
    };
  }

  /**
   * Narrative + figures written onto the task when the organiser submits
   * (the local mirror of POST /tasks/:id/complete). `would_have_bought_new`
   * is ignored: B dropped that figure. `participant_minutes` is still
   * accepted as an alias for `volunteer_minutes`.
   */
  function applyOutcome(task, input) {
    input = input || {};
    ensureRequirements(task, { nextId: input.nextId });
    var previous = (task.outcome && typeof task.outcome === 'object') ? task.outcome : emptyImpact();
    var outcome = {
      note: typeof input.note === 'string' ? input.note
          : (typeof previous.note === 'string' ? previous.note : ''),
      bags_collected: has(input, 'bags_collected') ? numOrNull(input.bags_collected) : numOrNull(previous.bags_collected),
      volunteer_minutes: has(input, 'volunteer_minutes') ? numOrNull(input.volunteer_minutes)
        : (has(input, 'participant_minutes') ? numOrNull(input.participant_minutes)
          : numOrNull(previous.volunteer_minutes)),
      verification: 'self_reported'
    };
    task.outcome = outcome;
    task.status = 'completed';
    task.completed_at = input.completedAt || new Date().toISOString();
    refreshFlags(task);
    return task;
  }

  /**
   * Whether the organiser may record the outcome yet, mirroring the
   * backend's completion gate (TASK_NOT_READY): every requirement must be
   * self_supplied, in_use or fulfilled — an accepted reservation still needs
   * the handover. Outstanding returns are only warned about, never blocking,
   * because borrowing and completing stay separate facts.
   */
  function outcomeReadiness(task, ctx) {
    var progress = taskProgress(task, ctx);
    var outstandingReturns = ((ctx && ctx.loans) || []).filter(function (l) {
      return l && l.task_id === task.id && (l.status === 'accepted' || l.status === 'on_loan');
    }).length;
    var canSubmit = task.status !== 'completed' && progress.completionEligible;
    var parts = [];
    if (task.status !== 'completed' && !progress.completionEligible) {
      parts.push('This action can be recorded once every requirement is self-supplied, in use or fulfilled.');
    }
    if (outstandingReturns > 0) {
      parts.push(outstandingReturns + (outstandingReturns === 1 ? ' tool is' : ' tools are') +
        ' still with you or your neighbour. Returns are tracked separately from this report.');
    }
    return {
      canSubmit: canSubmit,
      coordinationReady: progress.coordinationReady,
      completionEligible: progress.completionEligible && task.status !== 'completed',
      unconfirmedRequirements: progress.missing,
      outstandingReturns: outstandingReturns,
      warning: parts.length ? parts.join(' ') : null
    };
  }

  /* ------------------------------------------------------------------ loans */

  /**
   * Is this requirement already handled / occupied — i.e. in one of
   * pending / confirmed / in_use / fulfilled?
   *
   * Runs the same derivation as the checklist, so the guard and the UI can
   * never disagree. `self_supplied` is *not* a claim on a neighbour's tool
   * (createLoanRequest refuses it separately), and `rejected` / `cancelled`
   * requests never lock anything. Without loan data this falls back to the
   * stored `active_loan_id`, which is the conservative answer.
   */
  function slotIsClaimed(task, requirement, context) {
    if (!requirement) return false;
    var ctx = context || {};
    if (!Array.isArray(ctx.loans)) return !!requirement.active_loan_id;
    var local = copyObject(ctx);
    local.task = task || ctx.task || null;
    var state = deriveRequirement(requirement, local).state;
    return state === 'pending' || state === 'confirmed' || state === 'in_use' || state === 'fulfilled';
  }

  /**
   * Build a loan request for one requirement. Member B owns the server-side
   * atomicity (TOOL_UNAVAILABLE / REQUIREMENT_OCCUPIED / SELF_BORROW_
   * FORBIDDEN); this mirrors the same guards client-side so the button can be
   * disabled honestly before the round trip. Pass `context` ({tools, loans})
   * so the requirement guard can tell a live claim from a finished one.
   */
  function createLoanRequest(tool, task, requirement, borrowerId, makeId, context) {
    if (!tool || toolAvailability(tool) !== 'available' || tool.is_archived) {
      return { ok: false, reason: 'tool_unavailable' };
    }
    if (requirement) {
      if (requirement.self_supplied) return { ok: false, reason: 'slot_is_self_provided' };
      if (slotIsClaimed(task, requirement, context)) return { ok: false, reason: 'slot_already_claimed' };
    }
    var ownerId = toolOwnerId(tool);
    if (ownerId !== null && ownerId !== undefined && borrowerId !== null && borrowerId !== undefined &&
        String(ownerId) === String(borrowerId)) {
      return { ok: false, reason: 'self_borrow_forbidden' };
    }
    var idfn = makeId || defaultId;
    var now = new Date().toISOString();
    var request = {
      id: idfn(),
      tool_id: tool.id,
      tool_name: tool.name !== undefined ? tool.name : null,
      owner_id: ownerId,
      borrower_id: borrowerId,
      requirement_id: requirement ? requirement.id : null,
      task_id: task ? task.id : null,
      status: 'pending',
      note: '',
      created_at: now,
      updated_at: now,
      accepted_at: null,
      handed_over_at: null,
      returned_at: null,
      rejected_at: null,
      cancelled_at: null
    };
    if (requirement) {
      requirement.active_loan_id = request.id;
      requirement.state = 'pending';
      requirement.candidate_tool_ids = [];
      if (task) refreshFlags(task);
    }
    return { ok: true, request: request };
  }

  /* -------------------------------------------------------------- factories */

  return {
    // vocabulary
    CATEGORIES: CATEGORIES,
    TEMPLATES: TEMPLATES,
    TEMPLATE_LIST: TEMPLATE_LIST,
    TOOL_STATUS: TOOL_STATUS,
    TASK_STATUSES: TASK_STATUSES,
    REQUIREMENT_STATES: REQUIREMENT_STATES,
    LOAN_STATUSES: LOAN_STATUSES,
    LOAN_ACTIVE: LOAN_ACTIVE,
    LOAN_CONFIRMED: LOAN_CONFIRMED,
    LOAN_CLOSED: LOAN_CLOSED,
    LOAN_STAGES: LOAN_STAGES,
    DISCLAIMER: DISCLAIMER,
    // helpers
    normalisePostcode: normalisePostcode,
    outwardCode: outwardCode,
    categoryLabel: categoryLabel,
    haversineKm: haversineKm,
    emptyOutcome: emptyOutcome,
    emptyImpact: emptyImpact,
    clone: clone,
    // tasks
    buildRequirements: buildRequirements,
    createTask: createTask,
    ensureRequirements: ensureRequirements,
    setTemplate: setTemplate,
    canChangeTemplate: canChangeTemplate,
    setSlotSource: setSlotSource,
    hasActiveClaim: hasActiveClaim,
    // matching & derivation
    matchTools: matchTools,
    claimLoans: claimLoans,
    deriveRequirement: deriveRequirement,
    describeRequirement: describeRequirement,
    describeTask: describeTask,
    taskProgress: taskProgress,
    taskFlags: taskFlags,
    syncRequirements: syncRequirements,
    wantedBoard: wantedBoard,
    // impact
    coveredSlots: coveredSlots,
    loanCoveredSlots: loanCoveredSlots,
    impactReport: impactReport,
    applyOutcome: applyOutcome,
    outcomeReadiness: outcomeReadiness,
    // loans
    createLoanRequest: createLoanRequest,
    slotIsClaimed: slotIsClaimed
  };
});
