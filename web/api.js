/* =============================================================================
 * Borrow Next Door — Member A: browser client for member B's FastAPI backend.
 *
 * Plain browser script (no build step, no framework). Loaded with
 *   <script src="api.js"></script>   -> window.BND_API
 * and also require()-able from CommonJS tests.
 *
 * Contract (backend/docs/API_SAMPLES.md + backend/app/schemas_*.py):
 *   - base URL: window.BND_API_BASE, default http://127.0.0.1:8000
 *   - every business endpoint wants  Authorization: Bearer <access_token>
 *   - every business WRITE (POST/PUT) wants  Idempotency-Key: <uuid>
 *     one key per user intent; a network retry reuses the same key, a new
 *     intent takes a new key (`client.intent()` hands you exactly that)
 *   - success envelope  {data, meta}   -> the client returns `data`
 *     (or {data, meta} when you ask for `withMeta`)
 *   - error   envelope  {error:{code,message,details}, meta}
 *     -> thrown as ApiError with `.code`, `.status`, `.details`, `.requestId`
 * ========================================================================== */
(function (global, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  if (global) { global.BND_API = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
  var API_PREFIX = '/api/v1';
  var WRITE_METHODS = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };

  /* UUID v4 for Idempotency-Key headers. crypto.randomUUID when available
     (secure contexts / Node's webcrypto), otherwise a Math.random fallback. */
  function uuid() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    var hex = [];
    for (var i = 0; i < 32; i += 1) hex.push(Math.floor(Math.random() * 16).toString(16));
    return hex.join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  function ApiError(message, info) {
    Error.call(this, message);
    this.name = 'ApiError';
    this.message = message;
    info = info || {};
    this.code = info.code || 'UNKNOWN';
    this.status = info.status || 0;
    this.details = info.details || {};
    this.requestId = info.requestId || null;
    this.idempotencyKey = info.idempotencyKey || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function trimBase(url) { return String(url || '').replace(/\/+$/, ''); }

  function buildQuery(query) {
    if (!query) return '';
    var parts = [];
    Object.keys(query).forEach(function (key) {
      var value = query[key];
      if (value === undefined || value === null || value === '') return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  /**
   * Create one client instance.
   * options.baseUrl  override the API origin
   * options.token    initial bearer token
   * options.fetch    inject a fetch implementation (tests)
   */
  function createClient(options) {
    options = options || {};
    var g = typeof globalThis !== 'undefined' ? globalThis : {};
    var win = g.window || {};
    var baseUrl = trimBase(options.baseUrl || g.BND_API_BASE || win.BND_API_BASE || DEFAULT_BASE_URL);
    var token = options.token || null;
    var fetchImpl = options.fetch || g.fetch || win.fetch || null;

    function api(path) { return baseUrl + API_PREFIX + path; }

    function callFetch(url, init) {
      if (typeof fetchImpl !== 'function') {
        return Promise.reject(new ApiError('No fetch() implementation is available in this environment.', { code: 'NO_FETCH' }));
      }
      try {
        return Promise.resolve(fetchImpl(url, init));
      } catch (err) {
        return Promise.reject(err);
      }
    }

    /**
     * One HTTP round trip. Parses both envelopes, attaches Bearer + (for
     * writes) Idempotency-Key, and retries a *write* once when the network
     * itself fails — reusing the same Idempotency-Key so the server can
     * replay the original result instead of doing the work twice.
     */
    async function request(path, opts) {
      opts = opts || {};
      var method = (opts.method || 'GET').toUpperCase();
      var isWrite = !!WRITE_METHODS[method];
      var key = opts.idempotencyKey || null;
      if (isWrite && opts.idempotent !== false && !key) key = uuid();

      var headers = { 'Accept': 'application/json' };
      if (opts.auth !== false && token) headers['Authorization'] = 'Bearer ' + token;
      if (key) headers['Idempotency-Key'] = key;
      var hasBody = opts.body !== undefined && opts.body !== null;
      if (hasBody) headers['Content-Type'] = 'application/json';

      var url = api(path) + buildQuery(opts.query);
      var attempts = isWrite ? 2 : 1;
      var lastNetworkError = null;

      for (var attempt = 0; attempt < attempts; attempt += 1) {
        var res;
        try {
          res = await callFetch(url, {
            method: method,
            headers: headers,
            body: hasBody ? JSON.stringify(opts.body) : undefined
          });
        } catch (err) {
          lastNetworkError = err;
          continue; // network failure: retry writes once with the SAME key
        }

        var text = '';
        try { text = await res.text(); } catch (e) { text = ''; }
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }

        if (!res.ok) {
          var body = (payload && payload.error) || {};
          var message = body.message || ('Request failed with status ' + res.status + '.');
          throw new ApiError(message, {
            code: body.code || ('HTTP_' + res.status),
            status: res.status,
            details: body.details || {},
            requestId: payload && payload.meta ? payload.meta.request_id : null,
            idempotencyKey: key
          });
        }
        if (!payload || typeof payload !== 'object' || !('data' in payload)) {
          if (opts.raw) return payload;
          throw new ApiError('The server returned an unexpected (non-envelope) response.', {
            code: 'BAD_ENVELOPE', status: res.status, idempotencyKey: key
          });
        }
        if (opts.withMeta) return { data: payload.data, meta: payload.meta || {} };
        return payload.data;
      }

      throw new ApiError('Could not reach the Borrow Next Door API at ' + baseUrl + '. Is the backend running?', {
        code: 'NETWORK_ERROR',
        details: { cause: lastNetworkError ? String(lastNetworkError.message || lastNetworkError) : '' },
        idempotencyKey: key
      });
    }

    /**
     * One user intent = one Idempotency-Key. Build the intent, then reuse it
     * for every retry of *this* action; start a new intent for a new action.
     *   const it = client.intent();
     *   await it.post('/tools', body);   // fails on the network
     *   await it.post('/tools', body);   // retried with the same key
     */
    function intent(key) {
      var k = key || uuid();
      return {
        key: k,
        post: function (path, body, opts) {
          return request(path, Object.assign({ method: 'POST', body: body, idempotencyKey: k }, opts || {}));
        },
        put: function (path, body, opts) {
          return request(path, Object.assign({ method: 'PUT', body: body, idempotencyKey: k }, opts || {}));
        }
      };
    }

    var client = {
      baseUrl: baseUrl,
      intent: intent,
      newKey: uuid,
      request: request,
      get token() { return token; },
      setToken: function (value) { token = value || null; return token; },

      /* ---- auth ---- */
      // Login and logout do not take an Idempotency-Key (spec: auth routes are
      // outside the business idempotency store).
      login: function (userAlias, accessCode) {
        return request('/demo/sessions', {
          method: 'POST',
          body: { user_alias: userAlias, access_code: accessCode },
          auth: false,
          idempotent: false
        }).then(function (data) {
          token = data && data.access_token ? data.access_token : token;
          return data;
        });
      },
      logout: function () {
        return request('/sessions/logout', { method: 'POST', idempotent: false })
          .then(function (data) { token = null; return data; });
      },
      me: function () { return request('/me'); },

      /* ---- tasks ---- */
      taskTemplates: function () { return request('/task-templates'); },
      listTasks: function (query) { return request('/tasks', { query: query || { scope: 'mine' } }); },
      getTask: function (taskId) { return request('/tasks/' + encodeURIComponent(taskId)); },
      createTask: function (fields) { return intent().post('/tasks', fields); },
      setSelfSupply: function (taskId, requirementId, selfSupplied) {
        return intent().put(
          '/tasks/' + encodeURIComponent(taskId) + '/requirements/' + encodeURIComponent(requirementId) + '/self-supply',
          { self_supplied: !!selfSupplied }
        );
      },
      completeTask: function (taskId, outcome) { return intent().post('/tasks/' + encodeURIComponent(taskId) + '/complete', outcome); },

      /* ---- tools ---- */
      listTools: function (query) { return request('/tools', { query: query }); },
      getTool: function (toolId) { return request('/tools/' + encodeURIComponent(toolId)); },
      createTool: function (fields) { return intent().post('/tools', fields); },
      archiveTool: function (toolId) { return intent().post('/tools/' + encodeURIComponent(toolId) + '/archive', null); },

      /* ---- loans ---- */
      listLoans: function (query) { return request('/loans', { query: query || { role: 'borrower' } }); },
      getLoan: function (loanId) { return request('/loans/' + encodeURIComponent(loanId)); },
      loanEvents: function (loanId) { return request('/loans/' + encodeURIComponent(loanId) + '/events'); },
      createLoan: function (fields) { return intent().post('/loans', fields); },
      // action: accept | reject | cancel | hand-over | return (empty body)
      loanAction: function (loanId, action) {
        return intent().post('/loans/' + encodeURIComponent(loanId) + '/' + action, null);
      },

      /* ---- community ---- */
      resolveCommunity: function (postcode) {
        return request('/communities/resolve', { query: { postcode: postcode } });
      },
      communityEnvironment: function (communityId) {
        return request('/communities/' + encodeURIComponent(communityId) + '/environment');
      },
      communityImpact: function (communityId) {
        return request('/communities/' + encodeURIComponent(communityId) + '/impact');
      }
    };
    return client;
  }

  return {
    createClient: createClient,
    ApiError: ApiError,
    uuid: uuid,
    DEFAULT_BASE_URL: DEFAULT_BASE_URL
  };
});
