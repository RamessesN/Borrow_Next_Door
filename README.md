# Borrow Next Door · Integration & Run Guide

## About

A postcode-centred neighbourhood tool-sharing app: borrow a neighbour's tool, organise a park clean-up or flowerbed session, then record the return and the outcome of the action. This repository contains the frontend (`web/`), the backend (`backend/`, FastAPI + SQLite), the integration docs and the tests. Tools, tasks and loan records live in the backend — we do not fake multi-user collaboration in the browser.

This is a local competition demo, not a real resident-registration service. **No access code is required to sign in**: pick a demo account and you are in. There are no passwords and these are not verified residents. Demo login is rate-limited to 60 requests per minute per IP, and `APP_MODE=production` refuses to start until real authentication exists.

## How to use it (from scratch)

### 1. Open a terminal and run `./start.sh`

Install Python 3.11+ and Node.js first, then in a terminal go to the project folder (the one containing this file and `start.sh`):

```bash
cd /your/path/GREENER_BY_POSTCODE
./start.sh
```

The script creates `backend/.venv`, installs backend dependencies, initialises the demo database on first run, and starts the backend on :8000 together with the frontend on :5173. **You never generate, type or share an access code.** Keep this terminal window open; press `Ctrl+C` when the demo is over and both services stop together.

Windows users can run the script inside WSL / Git-Bash, or use the manual commands below.

### 2. Open the page in your browser

The script tries to open the browser automatically. If it does not, visit http://localhost:5173 manually. The backend API docs live at http://127.0.0.1:8000/docs. If the page does not load, check the terminal for errors and make sure the services are still running.

### 3. Sign in as Alice / Bob / Carol

Pick a **demo account** on the login panel and click sign in — no access code needed. All three live on home street `EH8 9AB`. A fresh seed ships 3 tools there (Alice's watering can and hand trowel, and Bob's reusable gloves) and 2 already-recorded street stories; `EH14 4AS` gets 2 more.

The second demo street with tools is `EH14 4AS`, where Dora / Eve hold 4 tools: a long-handled litter picker, a spare glove pair, a copper watering can and a wide garden trowel. Dora / Eve are not in the login picker — browse to their postcode to see their tools.

### 4. What the three tabs do

- **The neighbourhood (`#community`)**: environmental cards for the postcode, the `Postcode green context score`, and the tool list. `Stories from the street` (between the hero and the environment cards) rotates the latest recorded outcomes of this street — who did what, read straight from the shared task records. Filter or search tools, click `Lend a tool` to publish one, or request a borrow.
- **Make a difference (`#task`)**: choose the `Park cleanup` or `Flowerbed care` template, borrow each required tool, lend your own registered tool to the action, or mark it self-supplied, and watch the progress. Getting the tools together is optional — once the action is done, record the outcome note whether or not the checklist is complete; 03 keeps your latest story and the slot to record the next one.
- **My borrowing (`#loans`)**: `I’m borrowing` lists what you borrowed, `I’m lending` what others requested from you. The lender confirms in order: accept, hand over, return. Request sent, reservation accepted, hand-over and return are four separate facts.

### 5. Enter a postcode — you really move to that street

Type `EH14 4AS` into the postcode box on the home page and click `Check a postcode`. This time you **really move**: the frontend calls `POST /api/v1/me/community` to switch the demo account's home community to that postcode. The environment cards, tool list, tasks and lending then all refresh from this new home context — you should see the EH14 4AS tools (Dora / Eve's 4 tools), not the EH8 ones.

A notice appears under the postcode box: `You moved to EH14 4AS (EH14). Your previous street is EH8 9AB.` with a **`Back to my previous street`** button (clicking it reports `Back to your street: EH8 9AB.`). You can also simply type `EH8 9AB` again to go back.

**The move persists**: it writes the server-side account's home community (see `GET /api/v1/me`), so a page refresh stays on the new street. The "back to previous street" affordance also survives a refresh — the frontend keeps only the previous postcode as a UI hint in `localStorage` (key `bnd.previousHomePostcode`); the authoritative community always comes from the server /me. To restore the seeded `EH8 9AB`, run `./start.sh --reset`.

**Entering your current postcode is a no-op**: it does not change the account and does not call `POST /api/v1/me/community`; it simply reports `EH8 9AB is already your home street.`

Being able to see another street is not the same as borrowing there — the backend still enforces distance and permissions (borrow range is within 2 km of your current home street).

If the target street is missing from an old database, rebuild first with `./start.sh --reset` (this clears existing business records).

### 6. The two-window Alice / Bob demo story (7 steps)

Use **two independent browser sessions**: for example a normal window signed in as Alice and a private window as Bob, or two different browsers/profiles. Do not use two plain windows of the same browser — they share login storage. After each action, refresh the other window to see the new state (there is no live push yet).

> ⚠️ **Both windows must be on the same street**: entering a postcode really moves you, so if Alice previously visited `EH14 4AS` (or Bob moved away) the two are no longer in the same community. Before this story, bring both back to `EH8 9AB` — in particular **Alice must return to `EH8 9AB` first**: click `Back to my previous street`, type `EH8 9AB` again, or run `./start.sh --reset`. Otherwise Bob's tool ends up more than 2 km away, and at step 4 the button shows `Too far to borrow`; forcing the call fails with `That tool is in another neighbourhood. Borrowing works within 2 km of your street.` (error code `OUT_OF_RANGE`).

1. **Sign in on both**: window A as Alice, window B as Bob; both start on their `EH8 9AB` home page.
2. **Bob lends a tool**: on B's home page click `Lend a tool`, fill in a name (e.g. “Bob’s demo litter picker”), pick the `Litter picker` category and a description, then `Make it available`.
3. **Alice starts an action**: refresh A, open the action tab, choose `Park cleanup`. The template creates two requirements — litter picker and gloves. Mark gloves as self-supplied so the demo only needs one real borrow.
4. **Alice requests the tool**: on the litter-picker row pick Bob's new tool and click `Request from Bob`. It becomes a pending request and the tool is reserved — not yet handed over.
5. **Bob accepts and hands over**: refresh B, open `I’m lending`, find the request, click `Accept request`, then confirm the hand-over. States move through `accepted` and `on_loan`; refresh A to see the action progress update.
6. **Do the action and return**: assume the clean-up happened and Alice gives the tool back; Bob confirms the return on B. The tool is borrowable again, the loan records `returned`, and Alice's requirement becomes `fulfilled`.
7. **Alice records the outcome**: refresh A, go back to the action tab and submit the outcome note. The tool checklist does **not** gate this — an action can be recorded with requirements still unconfirmed (the panel keeps showing them as its own progress). Check the completed action and returned-loans metrics. Refresh either window's home page: the new story now rotates in `Stories from the street`, and Bob sees the same story because it is read from the shared task records. Outcomes are **self-reported** — not externally verified and never presented as proof of regional environmental improvement.

**Optional detour — lending your own tool to your own action**: Alice's seed account already owns a watering can and a hand trowel, which is exactly what `Flowerbed care` asks for. Choose that template instead and step 02 offers an optional `Lend my …` checkbox for each tool she owns *and* the action needs (no checkbox for tools she does not own). Ticking it creates a real loan record — the owner and the borrower are both Alice — so the tool shows as `Reserved` in the neighbourhood list and step 03 keeps a `borrowed` mark for it. Untick it before the hand-over to release the tool again; after that, confirm the booking, hand it over and return it from `I’m lending` like any other loan.

### 7. The map card and the nearest borrowable tool

The map module (`web/map-module.js`) plans a route to the nearest borrowable tool: it builds a grid graph, runs A* to each candidate and picks the lowest-cost one; the module also ships Dijkstra, which the unit tests use to cross-check A* path costs. The map card shows the candidates, highlights the nearest tool, and draws the route with an estimated distance. With no tools or no usable coordinates it shows an empty/degraded state instead of inventing a route.

This is an **algorithm demo on postcode-centre points and a synthetic grid** — not real roads, walking navigation or live GPS. Grid path length and straight-line distance are two different metrics. Borrowability, ownership and permission are still decided by the tool list and backend validation. The green-space list comes from environmental data sorted by straight-line distance from the postcode centre — a different dataset from the borrow route.

### 8. Common commands

Run these from the project root:

```bash
./start.sh              # start keeping the existing database; no access code
./start.sh --reset      # delete and rebuild demo data, then start (clears tasks/loans)
./start.sh --help       # start options
(cd backend && .venv/bin/pytest -q)  # backend tests
npm test               # frontend unit tests + attempts a real-backend smoke
npm run check          # frontend syntax check
```

Final measured run (2026-10-03): backend **210 passed**, frontend Node tests **89 passed**. The smoke against a real temporary backend passed. `npm test` explicitly **SKIP**s the smoke when nothing is on :8000 — that is not a pass; see `backend/docs/TEST_REPORT.md`.

Manual start (install dependencies per `backend/README.md` first):

```bash
(cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1)
# in another terminal, from the root
npm start
```

You can start directly only if the database already exists; rebuild with `(cd backend && .venv/bin/python scripts/reset_db.py)`. `backend/scripts/dev_server.sh` rebuilds the database every run — do not use it if you want to keep demo progress.

Development ports can be overridden with `BACKEND_PORT=8100 FRONTEND_PORT=5200 ./start.sh`; whether CORS/API base adapt to the new ports needs separate checking — the defaults 8000/5173 are the safest.

## Data sources and honest labelling

- Postcode and centre coordinates: [postcodes.io](https://postcodes.io/). Seed coordinates are fixtures — they are not anyone's exact address.
- Regional electricity and generation mix: [NESO Carbon Intensity API](https://carbonintensity.org.uk/). Regional data is not the carbon saved by this community's actions.
- Air quality: [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) — a model estimate, not a street sensor.
- Nearby green spaces: Overpass API / [OpenStreetMap](https://www.openstreetmap.org/), © OpenStreetMap contributors. At most 5 results; distances are straight-line estimates from the centre point, not full green coverage.
- Environment responses distinguish live / cache / stale / fixture. When external services are down we can serve offline demo snapshots (including `EH8 9AB`, `EH14 4AS`), clearly labelled as demo snapshots. No data shows pending/unavailable — we never fill zeros to fake a measurement.
- The `Postcode green context score` is a contextual estimate from public regional data. Without every required provider the total is withheld, and it is never mixed into loan/action outcome metrics.

## Scope and known limitations

**Done**: access-code-free demo login, tool publishing/browsing, the backend loan state machine, task templates with per-category requirements, optional self-lending of your own registered tool to your own action (owner == borrower, B's one self-loan exception), outcomes recorded independently of the tool checklist, the `Stories from the street` strip with seeded demo stories on both streets, self-reported outcomes, community environment adapters with cache/degradation, green-space list and context score card, home/postcode browsing, two demo streets with tools, the map algorithm module. Template switching reuses an existing open task and keeps its progress instead of creating duplicates.

**Not done / deferred**:

- Photo upload and outcome photo storage.
- Multiple tool slots per category / multi-quantity requirements (each template currently has one requirement per category, `quantity=1`).
- The `would_have_bought_new` survey and "purchases avoided" metric.
- The `Bags collected` / `Volunteer minutes` outcome fields still exist in the backend contract (`outcome.bags_collected` / `outcome.volunteer_minutes`, both optional) but no screen collects them any more, so the impact panel shows them as not collected rather than as 0.
- Real registration/resident verification, production auth, real road navigation, live multi-user push, load and long-run stability testing.

External network conditions affect environmental data; the borrow flow does not depend on external environment APIs succeeding. Map UI wiring was integrated in parallel — module unit tests and mock-DOM map tests were verified, real-browser map interaction was not acceptance-tested. We also keep an `EH16 5AA` fixture without tools for distance-boundary tests, so the seed database has 3 communities in total while the demo streets with tools are the 2 above.

## Repository layout and integration docs

```text
backend/       # FastAPI + SQLite, scripts, pytest, backend docs
web/           # app.js / api.js / task-module.js / map-module.js / integrations.js
test/          # Node unit tests, mock DOM/API flows, doc contract tests
services/      # teammate's original environment service (its logic now lives in the backend adapters)
docs/          # brief materials, plan document and handoff docs
docs/handoff/  # team interface and boundary notes
server.cjs     # npm start, frontend static server
start.sh       # one-command start of both backend and frontend
```

| Document | Contents |
|---|---|
| `backend/README.md` | Backend install, configuration, API boundaries, security notes |
| `backend/docs/API_SAMPLES.md` | curl examples (the live OpenAPI is authoritative) |
| `backend/docs/TEST_REPORT.md` | Real test commands, counts, pass/skip boundaries |
| `backend/docs/DECISIONS.md` | Technical choices and integration decisions |
| `docs/handoff/B-data-layer.md` | Fields, state machine, idempotency, permissions, concurrency contract |
| `docs/handoff/B-backend-contract.md` | Old model → B contract mapping |
| `docs/handoff/A-ui-boundary.md` | Frontend boundaries and test hooks |
| `docs/handoff/C-location-data.md` | Location data and adapter layer notes |

Business endpoints (everything except login/logout) require an `Idempotency-Key` (UUID) on write requests; the frontend sends one automatically. To call the login API directly, only `{"user_alias":"alice"}` is needed; the response contains a Bearer token, and subsequent business requests use `Authorization: Bearer <token>`.
