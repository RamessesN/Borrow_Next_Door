/* =============================================================================
 * Borrow Next Door — Member D: task templates, tool matching, gap & impact.
 *
 * Pure domain logic. No DOM, no storage, no network, no globals besides the
 * single `BND_TASK` namespace this file publishes. Everything here is a plain
 * function over plain data, so it can be unit tested and so member B can swap
 * the data source without touching any of it.
 *
 * Loaded two ways:
 *   <script src="task-module.js">            -> window.BND_TASK
 *   require('./task-module.js')              -> CommonJS export (tests)
 *
 * Owner: D.  Renderer: A (web/app.js).  Persistence: B.
 * ---------------------------------------------------------------------------
 * DATA CONTRACT (superset of the team plan's "minimum data objects")
 *
 *   Task {
 *     id, creator_id, template_id, postcode, place_name,
 *     latitude, longitude, status: 'planning'|'completed',
 *     outcome_note,                       // narrative, organiser submitted
 *     impact: {                           // self-reported figures, nullable
 *       bags_collected, participant_minutes, would_have_bought_new
 *     },
 *     requirements: TaskRequirement[],
 *     completed_at
 *   }
 *
 *   TaskRequirement {
 *     id, task_id, category, quantity, slot, slot_total,
 *     source_type: 'loan'|'self',         // how this slot will be covered
 *     loan_request_id                     // denormalised pointer (see note)
 *   }
 *
 *   LoanRequest {
 *     id, tool_id, borrower_id, task_id, requirement_id, status, created_at,
 *     returned_at
 *   }
 *
 * NOTE ON LINKING. A requirement slot is the unit of need; a loan request is
 * the unit of action. The authoritative link is `LoanRequest.requirement_id`,
 * because the borrower is the one who picks the slot. `TaskRequirement.
 * loan_request_id` is written at the same time for schema alignment with the
 * team plan. `claimLoans()` reads `requirement_id` first and falls back to
 * deterministic slot assignment by (created_at, id) for requests created
 * before this module existed.
 *
 * `quantity` is always 1 on a stored requirement: `buildRequirements()`
 * expands a template's `quantity: 2` into two slots so that "1 of 2 confirmed"
 * is visible in the UI. The field is kept for schema alignment.
 * ========================================================================== */
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  else if (global) { global.BND_TASK = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- aliases */

  /** Tool vocabulary. `group` drives the community-page filter chips. */
  var CATEGORIES = {
    picker:   { id: 'picker',   label: 'Litter picker',        group: 'cleanup' },
    gloves:   { id: 'gloves',   label: 'Gardening gloves',     group: 'garden'  },
    spade:    { id: 'spade',    label: 'Hand trowel / spade',  group: 'garden'  },
    watering: { id: 'watering', label: 'Watering can',         group: 'garden'  },
    rake:     { id: 'rake',     label: 'Garden rake',          group: 'garden'  }
  };

  /** Loan request lifecycle. Kept in sync with member B's server state machine. */
  var LOAN_ACTIVE    = ['pending', 'accepted', 'on_loan'];
  var LOAN_CONFIRMED = ['accepted', 'on_loan'];   // "已落实": reservation confirmed
  var LOAN_CLOSED    = ['rejected', 'cancelled']; // never counts, never blocks

  /** The four separate facts the brief asks us to record distinctly. */
  var LOAN_STAGES = {
    pending:  { stage: 'requested',   order: 1, label: 'Request sent'          },
    accepted: { stage: 'reserved',    order: 2, label: 'Reservation accepted'  },
    on_loan:  { stage: 'handed_over', order: 3, label: 'Handed over'           },
    returned: { stage: 'returned',    order: 4, label: 'Returned'              }
  };

  var TOOL_STATUS = ['available', 'reserved', 'on_loan'];

  /**
   * Task templates. Two MVP templates from the brief plus two optional ones so
   * the "a new neighbour unlocks an action" story has somewhere to go.
   * `consumables` are give-aways, not loans: they are displayed but never enter
   * the request state machine.
   */
  var TEMPLATES = {
    cleanup: {
      id: 'cleanup',
      name: 'Clean up a green space',
      blurb: 'Litter pickers, gloves & a helping hand',
      icon: '♧',
      requirements: [{ category: 'picker', quantity: 1 }, { category: 'gloves', quantity: 1 }],
      consumables: [{ category: 'bags', label: 'Rubbish bags' }]
    },
    garden: {
      id: 'garden',
      name: 'Care for a community garden',
      blurb: 'A little planting. A little watering.',
      icon: '✳',
      requirements: [{ category: 'spade', quantity: 1 }, { category: 'gloves', quantity: 1 }, { category: 'watering', quantity: 1 }],
      consumables: [{ category: 'seeds', label: 'Seeds or plants' }]
    },
    street_trees: {
      id: 'street_trees',
      name: 'Water young street trees',
      blurb: 'Two cans, one dry week, cooler pavement',
      icon: '⌇',
      requirements: [{ category: 'watering', quantity: 2 }, { category: 'gloves', quantity: 1 }],
      consumables: []
    },
    spring_bulbs: {
      id: 'spring_bulbs',
      name: 'Plant spring bulbs by the path',
      blurb: 'Trowels, a rake and something to come back to',
      icon: '❋',
      requirements: [{ category: 'spade', quantity: 1 }, { category: 'rake', quantity: 1 }, { category: 'gloves', quantity: 1 }],
      consumables: [{ category: 'bulbs', label: 'Bulbs' }]
    }
  };

  var TEMPLATE_LIST = ['cleanup', 'garden', 'street_trees', 'spring_bulbs'].map(function (id) { return TEMPLATES[id]; });

  /* ---------------------------------------------------------------- helpers */

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

  function categoryLabel(id) {
    return (CATEGORIES[id] && CATEGORIES[id].label) || String(id || 'Unknown tool');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function indexById(rows) {
    var map = new Map();
    (rows || []).forEach(function (row) { if (row && row.id !== undefined && row.id !== null) map.set(row.id, row); });
    return map;
  }

  /* ------------------------------------------------------- task construction */

  /**
   * Expand one template into its requirement slots. A template entry with
   * `quantity: 2` becomes two slots so partial coverage is visible.
   */
  function buildRequirements(templateId, taskId, makeId) {
    var template = TEMPLATES[templateId];
    if (!template) throw new Error('Unknown task template: ' + templateId);
    if (taskId === undefined || taskId === null) throw new Error('buildRequirements() needs a task id');
    var nextId = makeId || defaultId;
    var rows = [];
    template.requirements.forEach(function (entry) {
      var quantity = Math.max(1, Math.floor(entry.quantity || 1));
      for (var slot = 1; slot <= quantity; slot += 1) {
        rows.push({
          id: nextId(),
          task_id: taskId,
          category: entry.category,
          quantity: 1,
          slot: slot,
          slot_total: quantity,
          source_type: 'loan',
          loan_request_id: null
        });
      }
    });
    return rows;
  }

  function emptyImpact() {
    return { bags_collected: null, participant_minutes: null, would_have_bought_new: null };
  }

  /** Build a brand new planning task. Used by the UI and by tests. */
  function createTask(input) {
    input = input || {};
    var templateId = input.templateId || 'cleanup';
    if (!TEMPLATES[templateId]) throw new Error('Unknown task template: ' + templateId);
    var id = input.id || (input.nextId ? input.nextId() : defaultId());
    var task = {
      id: id,
      creator_id: input.creatorId,
      template_id: templateId,
      postcode: normalisePostcode(input.postcode),
      place_name: input.placeName || 'Neighbourhood green space (sample)',
      latitude: numOrNull(input.latitude),
      longitude: numOrNull(input.longitude),
      status: 'planning',
      outcome_note: '',
      impact: emptyImpact(),
      requirements: buildRequirements(templateId, id, input.nextId),
      created_at: input.createdAt || new Date().toISOString(),
      completed_at: null
    };
    return task;
  }

  /**
   * Bring a task loaded from storage up to the current contract.
   * Legacy tasks stored a bare `self: ['gloves']` array and no requirements.
   * Returns the same object; `migrated` says whether anything changed.
   */
  function ensureRequirements(task, options) {
    options = options || {};
    if (!task || typeof task !== 'object') throw new Error('ensureRequirements() needs a task');
    if (!task.template_id || !TEMPLATES[task.template_id]) task.template_id = 'cleanup';

    var migrated = false;
    if (!Array.isArray(task.requirements) || task.requirements.length === 0) {
      task.requirements = buildRequirements(task.template_id, task.id, options.nextId);
      migrated = true;
    }
    if (!task.impact || typeof task.impact !== 'object') { task.impact = emptyImpact(); migrated = true; }
    else {
      var clean = emptyImpact();
      Object.keys(clean).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(task.impact, key)) clean[key] = numOrNull(task.impact[key]);
      });
      if (task.impact.would_have_bought_new === true || task.impact.would_have_bought_new === false) {
        clean.would_have_bought_new = task.impact.would_have_bought_new;
      } else { clean.would_have_bought_new = null; }
      task.impact = clean;
    }
    if (typeof task.outcome_note !== 'string') { task.outcome_note = ''; migrated = true; }

    // Legacy `self: []` -> flip the matching slot's source_type.
    if (Array.isArray(task.self)) {
      task.self.forEach(function (category) {
        var slot = task.requirements.find(function (r) { return r.category === category && r.source_type === 'loan'; });
        if (slot) slot.source_type = 'self';
        else task.requirements.push({
          id: (options.nextId || defaultId)(), task_id: task.id, category: category, quantity: 1,
          slot: 1, slot_total: 1, source_type: 'self', loan_request_id: null
        });
      });
      delete task.self;
      migrated = true;
    }
    return { task: task, migrated: migrated };
  }

  /** A slot claim means "this unit of need is already being handled". */
  function hasActiveClaim(requirements) {
    return (requirements || []).some(function (r) { return r.source_type === 'loan' && r.loan_request_id; });
  }

  function canChangeTemplate(task, ctx) {
    var loans = ((ctx && ctx.loans) || []).filter(function (l) {
      return l.task_id === task.id && LOAN_ACTIVE.indexOf(l.status) !== -1;
    });
    return loans.length === 0;
  }

  /**
   * Switch template in place. Bring-your-own choices survive when the new
   * template still needs that category. Refuses while a request is in flight.
   */
  function setTemplate(task, templateId, options) {
    options = options || {};
    if (!TEMPLATES[templateId]) return { ok: false, reason: 'unknown_template' };
    if (!canChangeTemplate(task, options)) return { ok: false, reason: 'active_requests' };
    ensureRequirements(task, options);
    var keepSelf = [];
    task.requirements.forEach(function (r) {
      if (r.source_type === 'self' && keepSelf.indexOf(r.category) === -1) keepSelf.push(r.category);
    });
    task.template_id = templateId;
    task.requirements = buildRequirements(templateId, task.id, options.nextId);
    keepSelf.forEach(function (category) {
      var slot = task.requirements.find(function (r) { return r.category === category && r.source_type === 'loan'; });
      if (slot) slot.source_type = 'self';
    });
    return { ok: true };
  }

  /** Flip one slot between "borrow it" and "bring my own". */
  function setSlotSource(task, requirementId, sourceType) {
    ensureRequirements(task);
    var slot = task.requirements.find(function (r) { return r.id === requirementId; });
    if (!slot) return { ok: false, reason: 'unknown_slot' };
    if (sourceType !== 'loan' && sourceType !== 'self') return { ok: false, reason: 'unknown_source' };
    slot.source_type = sourceType;
    return { ok: true, requirement: slot };
  }

  /* --------------------------------------------------------------- matching */

  /**
   * Candidate tools for one category, best tier only.
   *
   * Rules, in order:
   *   1. right category, status `available` (reserved / on_loan are never offered)
   *   2. never the viewer's own tool
   *   3. neighbours first: same postcode wins outright; if none, accept the
   *      explicitly supplied `nearbyPostcodes` (a full postcode or an outcode
   *      such as "EH7"); other postcodes never surface, because "nearby" must
   *      be a decision member C's data makes for us.
   *
   * Returns descriptors, not tools, so the UI can label the tier and the
   * (approximate, straight-line) distance honestly.
   */
  function matchTools(category, ctx) {
    ctx = ctx || {};
    var task = ctx.task || {};
    var taskPostcode = normalisePostcode(task.postcode);
    var nearby = (ctx.nearbyPostcodes || []).map(normalisePostcode);
    var ownTools = new Map();
    var pools = { same_postcode: [], nearby: [], elsewhere: [] };

    (ctx.tools || []).forEach(function (tool) {
      if (!tool || tool.category !== category) return;
      if (tool.status !== 'available') return;
      if (ctx.viewerId && tool.owner_id === ctx.viewerId) return;
      var postcode = normalisePostcode(tool.postcode);
      var tier = 'elsewhere';
      if (taskPostcode && postcode === taskPostcode) tier = 'same_postcode';
      else if (nearby.indexOf(postcode) !== -1 || nearby.indexOf(outwardCode(postcode)) !== -1) tier = 'nearby';

      var distanceKm = null;
      if (isNumber(tool.latitude) && isNumber(tool.longitude) &&
          isNumber(task.latitude) && isNumber(task.longitude)) {
        distanceKm = Math.round(haversineKm(task.latitude, task.longitude, tool.latitude, tool.longitude) * 10) / 10;
      }
      ownTools.set(tool.id, true);
      pools[tier].push({
        tool: tool,
        toolId: tool.id,
        toolName: tool.name,
        category: tool.category,
        ownerId: tool.owner_id,
        ownerName: (ctx.names && ctx.names[tool.owner_id]) || tool.owner_id,
        postcode: postcode,
        scope: tier,
        distanceKm: distanceKm
      });
    });

    var tierUsed = pools.same_postcode.length ? 'same_postcode'
                 : pools.nearby.length ? 'nearby'
                 : 'elsewhere';
    // An "elsewhere" tool is not a neighbourhood match; only offer it when the
    // caller explicitly opted into a wider radius.
    if (tierUsed === 'elsewhere' && !ctx.allowElsewhere) return [];

    return pools[tierUsed].sort(function (a, b) {
      if (a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      if (a.distanceKm !== null && b.distanceKm === null) return -1;
      if (a.distanceKm === null && b.distanceKm !== null) return 1;
      return String(a.toolName).localeCompare(String(b.toolName));
    });
  }

  /**
   * Assign every live loan request to a requirement slot, once, deterministically.
   * Requests that already carry `requirement_id` go straight to their slot;
   * anything else is assigned oldest-first to the first free slot of the same
   * category. Rooms are never double-booked.
   */
  function claimLoans(requirements, loans, toolById) {
    var claims = new Map();
    (requirements || []).forEach(function (r) { claims.set(r.id, []); });
    var orphans = [];

    (loans || []).forEach(function (loan) {
      if (!loan || LOAN_CLOSED.indexOf(loan.status) !== -1) return;
      var tool = toolById.get(loan.tool_id);
      if (!tool) return;
      var item = { request: loan, tool: tool };
      if (loan.requirement_id && claims.has(loan.requirement_id)) {
        claims.get(loan.requirement_id).push(item);
      } else if (loan.task_id) {
        // fall through to deterministic assignment
        var slot = (requirements || []).find(function (r) { return r.loan_request_id === loan.id; });
        if (slot) claims.get(slot.id).push(item);
        else orphans.push(item);
      }
    });

    orphans.sort(function (a, b) {
      var ca = String(a.request.created_at || ''), cb = String(b.request.created_at || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      return String(a.request.id) < String(b.request.id) ? -1 : 1;
    });
    orphans.forEach(function (item) {
      var slot = (requirements || []).find(function (r) {
        return r.category === item.tool.category && r.source_type === 'loan' && claims.get(r.id).length === 0;
      });
      if (slot) claims.get(slot.id).push(item);
    });
    return claims;
  }

  /**
   * Describe one requirement slot. This is the single place that decides what
   * "可申请" vs "已落实" means, so the renderer never guesses.
   *
   * state: 'confirmed' | 'pending' | 'available' | 'missing'
   *   confirmed  the unit of need is covered (reservation accepted, handed
   *              over, or the neighbour brings their own)
   *   pending    a request exists and is awaiting the owner
   *   available  a neighbour's tool could be requested right now
   *   missing    nothing yet
   */
  function describeRequirement(requirement, ctx, claims) {
    ctx = ctx || {};
    var items = (claims && claims.get(requirement.id)) || [];
    var confirmedItems = items.filter(function (i) { return LOAN_CONFIRMED.indexOf(i.request.status) !== -1; });
    var pendingItems = items.filter(function (i) { return i.request.status === 'pending'; });
    var historyItems = items.filter(function (i) { return i.request.status === 'returned'; });

    var descriptor = {
      requirement: requirement,
      requirementId: requirement.id,
      category: requirement.category,
      label: categoryLabel(requirement.category),
      slot: requirement.slot,
      slotTotal: requirement.slot_total,
      sourceType: requirement.source_type,
      state: 'missing',
      confirmed: false,
      pending: false,
      stage: null,
      statusText: '',
      loans: items.map(function (i) { return describeLoan(i, ctx); }),
      history: historyItems.map(function (i) { return describeLoan(i, ctx); }),
      tools: []
    };

    if (requirement.source_type === 'self') {
      descriptor.state = 'confirmed';
      descriptor.confirmed = true;
      descriptor.stage = 'self';
      descriptor.statusText = 'Confirmed · you are bringing your own';
      return descriptor;
    }

    if (confirmedItems.length) {
      var live = confirmedItems[confirmedItems.length - 1];
      descriptor.state = 'confirmed';
      descriptor.confirmed = true;
      descriptor.stage = LOAN_STAGES[live.request.status].stage;
      descriptor.statusText = live.request.status === 'on_loan'
        ? 'Confirmed · handed over by ' + displayOwner(live, ctx)
        : 'Confirmed · reservation accepted by ' + displayOwner(live, ctx);
      return descriptor;
    }

    if (pendingItems.length) {
      descriptor.state = 'pending';
      descriptor.pending = true;
      descriptor.stage = 'requested';
      descriptor.statusText = 'Awaiting ' + displayOwner(pendingItems[0], ctx) + ' to respond';
      return descriptor;
    }

    descriptor.tools = matchTools(requirement.category, ctx);
    if (descriptor.tools.length) {
      descriptor.state = 'available';
      descriptor.statusText = 'Available to request from ' + descriptor.tools[0].ownerName +
        (descriptor.tools[0].scope === 'nearby' ? ' (nearby postcode)' : '');
    } else {
      descriptor.state = 'missing';
      descriptor.statusText = historyItems.length
        ? 'Returned · this tool would need to be borrowed again'
        : 'Still looking for a neighbour’s tool';
    }
    return descriptor;
  }

  function displayOwner(item, ctx) {
    return (ctx && ctx.names && ctx.names[item.tool.owner_id]) || item.tool.owner_id;
  }

  function describeLoan(item, ctx) {
    var stage = LOAN_STAGES[item.request.status] || { stage: item.request.status, order: 9, label: item.request.status };
    return {
      requestId: item.request.id,
      requirementId: item.request.requirement_id || null,
      toolId: item.tool.id,
      toolName: item.tool.name,
      ownerId: item.tool.owner_id,
      ownerName: displayOwner(item, ctx),
      status: item.request.status,
      stage: stage.stage,
      stageOrder: stage.order,
      stageLabel: stage.label,
      createdAt: item.request.created_at,
      returnedAt: item.request.returned_at || null
    };
  }

  /** Describe every slot on a task, sharing one claim pass. */
  function describeTask(task, ctx) {
    ctx = ctx || {};
    // Match against this task's own postcode, even when the caller passes one
    // context for a whole list of tasks (see wantedBoard).
    var local = {};
    Object.keys(ctx).forEach(function (key) { local[key] = ctx[key]; });
    local.task = task;
    var toolById = indexById(local.tools);
    var loans = (local.loans || []).filter(function (l) { return l.task_id === task.id; });
    var claims = claimLoans(task.requirements || [], loans, toolById);
    return (task.requirements || []).map(function (r) {
      var row = describeRequirement(r, local, claims);
      row.taskId = task.id;
      return row;
    });
  }

  /**
   * Roll a task's slots into one progress figure for the header and the
   * "gap changed" story. `nextAction` is deliberately one sentence, so the
   * renderer cannot invent a stronger claim than the data supports.
   */
  function taskProgress(task, ctx) {
    var rows = describeTask(task, ctx);
    var total = rows.length;
    var confirmed = rows.filter(function (r) { return r.state === 'confirmed'; }).length;
    var pending = rows.filter(function (r) { return r.state === 'pending'; }).length;
    var missing = total - confirmed;
    var missingCategories = unique(rows.filter(function (r) { return !r.confirmed; }).map(function (r) { return r.category; }));
    var confirmedCategories = unique(rows.filter(function (r) { return r.confirmed; }).map(function (r) { return r.category; }));

    var nextAction;
    if (task.status === 'completed') nextAction = 'Action recorded. Outstanding returns are tracked separately.';
    else if (confirmed === 0 && pending === 0) nextAction = 'Find a neighbour with the first tool.';
    else if (missing > 0) nextAction = missing + (missing === 1 ? ' tool' : ' tools') + ' still to confirm.';
    else nextAction = 'Every tool is confirmed. Arrange the handover.';

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
      nextAction: nextAction
    };
  }

  /**
   * The "missing tool" board: what the neighbourhood as a whole is still
   * short of. This is the direct product answer to "more neighbours makes
   * this more useful", so it counts *slots*, not tasks.
   */
  function wantedBoard(tasks, ctx) {
    ctx = ctx || {};
    var board = new Map();
    (tasks || []).forEach(function (task) {
      if (task.status === 'completed') return;
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

  function unique(values) {
    var seen = [], out = [];
    values.forEach(function (v) { if (seen.indexOf(v) === -1) { seen.push(v); out.push(v); } });
    return out;
  }

  /* ---------------------------------------------------------------- impact */

  /**
   * Coverage counts a slot as covered if it will be brought, or if a
   * reservation was accepted / handed over / has already come back. This is
   * deliberately wider than `taskProgress`, which only counts what is in the
   * neighbour's hands right now.
   */
  function coveredSlots(task, ctx) {
    var toolById = indexById((ctx && ctx.tools) || []);
    var loans = ((ctx && ctx.loans) || []).filter(function (l) { return l.task_id === task.id; });
    var claims = claimLoans(task.requirements || [], loans, toolById);
    return (task.requirements || []).filter(function (r) {
      if (r.source_type === 'self') return true;
      return (claims.get(r.id) || []).some(function (i) {
        return i.request.status === 'accepted' || i.request.status === 'on_loan' || i.request.status === 'returned';
      });
    }).length;
  }

  function loanCoveredSlots(task, ctx) {
    var toolById = indexById((ctx && ctx.tools) || []);
    var loans = ((ctx && ctx.loans) || []).filter(function (l) { return l.task_id === task.id; });
    var claims = claimLoans(task.requirements || [], loans, toolById);
    return (task.requirements || []).filter(function (r) {
      return (claims.get(r.id) || []).some(function (i) {
        return i.request.status === 'accepted' || i.request.status === 'on_loan' || i.request.status === 'returned';
      });
    }).length;
  }

  var DISCLAIMER = 'Each figure is counted separately. Borrowing the same tool more than once is not ' +
    'the same as avoiding that many new products, borrowing is not the same as completing an action, ' +
    'and regional air or electricity predictions are not measured outcomes of these actions.';

  /**
   * Structured impact panel. Every metric carries its own source, basis and
   * caveat, and `available: false` means "never collected" rather than a
   * quietly misleading zero.
   */
  function impactReport(tasks, loans, options) {
    options = options || {};
    var scopePostcode = options.postcode ? normalisePostcode(options.postcode) : null;
    var scopeLabel = scopePostcode ? 'this postcode' : 'all recorded data';
    var allTasks = (tasks || []).filter(function (t) {
      return !scopePostcode || normalisePostcode(t.postcode) === scopePostcode;
    });
    var taskIds = new Set(allTasks.map(function (t) { return t.id; }));
    var allLoans = (loans || []).filter(function (l) { return taskIds.has(l.task_id); });
    var ctx = { tools: options.tools || [], loans: allLoans, names: options.names };

    var returned = allLoans.filter(function (l) { return l.status === 'returned'; });
    var fullyCovered = allTasks.filter(function (t) {
      var total = (t.requirements || []).length;
      return total > 0 && coveredSlots(t, ctx) === total;
    });
    var completed = allTasks.filter(function (t) { return t.status === 'completed'; });

    var bagValues = allTasks.map(function (t) { return numOrNull(t.impact && t.impact.bags_collected); })
      .filter(function (v) { return v !== null; });
    var minuteValues = allTasks.map(function (t) { return numOrNull(t.impact && t.impact.participant_minutes); })
      .filter(function (v) { return v !== null; });
    var surveyAnswers = allTasks.map(function (t) {
      return (t.impact && typeof t.impact.would_have_bought_new === 'boolean') ? t.impact : null;
    }).filter(Boolean);
    var avoided = allTasks.filter(function (t) {
      return t.impact && t.impact.would_have_bought_new === true && loanCoveredSlots(t, ctx) > 0;
    });

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
        source: 'Accepted reservations and bring-your-own confirmations',
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
        source: 'Reported by participants',
        basis: 'self-reported',
        scope: scopeLabel,
        available: bagValues.length > 0,
        caveat: 'Self-reported. No waste is weighed or audited.'
      },
      {
        key: 'participant_minutes',
        value: minuteValues.reduce(function (sum, v) { return sum + v; }, 0),
        label: 'Minutes of neighbour time',
        source: 'Reported by participants',
        basis: 'self-reported',
        scope: scopeLabel,
        available: minuteValues.length > 0,
        caveat: 'Self-reported and rounded by whoever filled the form in.'
      },
      {
        key: 'potential_avoided_purchases',
        value: avoided.length,
        label: 'Potential new purchases avoided',
        source: 'Optional survey answer, cross-checked against a borrowed tool',
        basis: 'self-reported',
        scope: scopeLabel,
        available: surveyAnswers.length > 0,
        caveat: 'Only counted when the participant said they would otherwise have bought new. Intention, not a measurement.'
      }
    ];

    return {
      scope: scopeLabel,
      postcode: scopePostcode,
      reportedActions: completed.length,
      metrics: metrics,
      disclaimer: DISCLAIMER
    };
  }

  /** Narrative + figures written back onto a task when the organiser submits. */
  function applyOutcome(task, input) {
    input = input || {};
    ensureRequirements(task);
    task.outcome_note = typeof input.note === 'string' ? input.note : (task.outcome_note || '');
    var impact = task.impact || emptyImpact();
    if (Object.prototype.hasOwnProperty.call(input, 'bags_collected')) impact.bags_collected = numOrNull(input.bags_collected);
    if (Object.prototype.hasOwnProperty.call(input, 'participant_minutes')) impact.participant_minutes = numOrNull(input.participant_minutes);
    if (Object.prototype.hasOwnProperty.call(input, 'would_have_bought_new')) {
      impact.would_have_bought_new = typeof input.would_have_bought_new === 'boolean' ? input.would_have_bought_new : null;
    }
    task.impact = impact;
    task.status = 'completed';
    task.completed_at = input.completedAt || new Date().toISOString();
    return task;
  }

  /**
   * Whether the organiser may record the action yet. Borrowing and completing
   * are separate facts, so this never blocks on unmatched slots — it only
   * reports what is outstanding so the UI can warn instead of hide.
   */
  function outcomeReadiness(task, ctx) {
    var progress = taskProgress(task, ctx);
    var outstandingReturns = ((ctx && ctx.loans) || []).filter(function (l) {
      return l.task_id === task.id && (l.status === 'accepted' || l.status === 'on_loan');
    }).length;
    return {
      canSubmit: true,
      unconfirmedSlots: progress.missing,
      outstandingReturns: outstandingReturns,
      warning: outstandingReturns > 0
        ? outstandingReturns + (outstandingReturns === 1 ? ' tool is' : ' tools are') + ' still with you or your neighbour. Returns are tracked separately from this report.'
        : null
    };
  }

  /* ------------------------------------------------------------------ loans */

  /**
   * Whether a slot already has a live (pending / accepted / on_loan) request.
   *
   * Runs the same claim pass as the checklist, so the guard and the UI can never
   * disagree. Critically, a *returned* or *rejected* request must NOT keep
   * locking the slot: borrowing the same tool twice is a first-class case in the
   * brief, so the historical pointer on the slot is not proof of a live claim.
   *
   * Without loan data this falls back to trusting the stored pointer, which is
   * the conservative answer.
   */
  function slotIsClaimed(task, requirement, context) {
    if (!requirement) return false;
    var loans = context && context.loans;
    if (!Array.isArray(loans)) return !!requirement.loan_request_id;
    var toolById = indexById((context && context.tools) || []);
    var taskLoans = loans.filter(function (l) { return l.task_id === task.id; });
    var claims = claimLoans(task.requirements || [], taskLoans, toolById);
    return (claims.get(requirement.id) || []).some(function (i) {
      return LOAN_ACTIVE.indexOf(i.request.status) !== -1;
    });
  }

  /**
   * Build a loan request for one slot. Member B owns the server-side
   * atomicity; this mirrors the same guard client-side so the button can be
   * disabled honestly before the round trip. Pass `context` ({tools, loans}) so
   * the slot guard can tell a live claim from a finished one.
   */
  function createLoanRequest(tool, task, requirement, borrowerId, makeId, context) {
    if (!tool || tool.status !== 'available') return { ok: false, reason: 'tool_unavailable' };
    if (requirement && requirement.source_type === 'self') return { ok: false, reason: 'slot_is_self_provided' };
    if (slotIsClaimed(task, requirement, context)) return { ok: false, reason: 'slot_already_claimed' };
    var id = makeId || defaultId;
    var request = {
      id: id(),
      tool_id: tool.id,
      borrower_id: borrowerId,
      task_id: task.id,
      requirement_id: requirement ? requirement.id : null,
      status: 'pending',
      created_at: new Date().toISOString(),
      returned_at: null
    };
    if (requirement) requirement.loan_request_id = request.id;
    return { ok: true, request: request };
  }

  /* -------------------------------------------------------------- factories */

  return {
    // vocabulary
    CATEGORIES: CATEGORIES,
    TEMPLATES: TEMPLATES,
    TEMPLATE_LIST: TEMPLATE_LIST,
    TOOL_STATUS: TOOL_STATUS,
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
    emptyImpact: emptyImpact,
    // tasks
    buildRequirements: buildRequirements,
    createTask: createTask,
    ensureRequirements: ensureRequirements,
    setTemplate: setTemplate,
    canChangeTemplate: canChangeTemplate,
    setSlotSource: setSlotSource,
    hasActiveClaim: hasActiveClaim,
    // matching
    matchTools: matchTools,
    claimLoans: claimLoans,
    describeRequirement: describeRequirement,
    describeTask: describeTask,
    taskProgress: taskProgress,
    wantedBoard: wantedBoard,
    // impact
    coveredSlots: coveredSlots,
    loanCoveredSlots: loanCoveredSlots,
    impactReport: impactReport,
    applyOutcome: applyOutcome,
    outcomeReadiness: outcomeReadiness,
    // loans
    createLoanRequest: createLoanRequest,
    slotIsClaimed: slotIsClaimed,
    // used by tests that want a stable clone
    clone: clone
  };
});
