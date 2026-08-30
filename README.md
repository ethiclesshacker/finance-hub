# FinanceHub — Personal Finance Command Centre

FinanceHub is a single-page personal finance app: net worth snapshots, asset allocation, emergency runway, financial-independence projections, a full HSBC TravelOne points and redemptions ledger, and a **Personal Event Ledger** that records what actually happens in your life — backed by Supabase and deployed to Cloudflare Pages.

---

## Screens

| Route | What it does |
| --- | --- |
| `#dashboard` | Net worth, total assets, savings rate, FI progress, emergency runway, and a points summary strip. |
| `#networth` | Snapshot history with KPIs, accumulation and allocation charts, filtering and CSV export. |
| `#fi` | Savings rate (actual vs budgeted), time to FI, Coast FI, and a projection chart with live scenario sliders. |
| `#points` | Transactions and redemptions, multiplier tracking, spend-by-merchant, value-per-point, CSV export. |
| `#ledger` | **Life** — a chronological record of purchases, meals, travel, meetings and deliveries, filled in automatically from email. Filters, search, provenance on every event, a review queue and export. |
| `#food` | **Food** — what you actually ate. Days split into breakfast, lunch, snacks and dinner, every order's dishes listed under it, and a ranking of what you eat most. Meals with no receipt behind them — a grocery packet opened on Tuesday, a plate at a friend's — are added by hand, picking from the dishes you have eaten before. |
| `#settings` | Every personal number the other screens derive from. |

---

## Settings, not constants

Personal numbers — income, expenses, FI multiplier, expected return, targets — live per user in the `user_settings` table as key/value pairs, **not** as one column per setting. Adding a knob is a single object literal in `src/settings.js`; no migration, no rebuild, no redeploy.

- `value` is `jsonb`, so numbers stay numbers and booleans stay booleans.
- `SETTINGS_SCHEMA` in `src/settings.js` is the source of truth for each key's type, default, bounds and label — and it generates the settings screen automatically.
- A key with no stored row falls back to its schema default, so nothing needs seeding.

`src/constants.js` keeps only what describes the app and the card itself (multiplier tiers, transfer partners) — things a user should not be able to diverge from.

---

## The Personal Event Ledger

A structured record of things that happened, populated mostly by itself. Email
arrives, is parsed into events, deduplicated against everything already known,
and lands on the timeline with its source attached. Full reference:
**[docs/ledger.md](docs/ledger.md)**.

Four properties it is built around:

- **Provenance is never lost.** Every automatic event points at the source it
  came from, and keeps *all* sources when several describe the same thing — an
  order email and its card alert become one purchase with two references.
- **Facts and interpretation are separate columns.** `events.data` holds what a
  source stated; `events.inference` holds what a model made of it. The second
  can never overwrite the first.
- **The receipt says what was in the order, so the ledger does too.** Zomato,
  Swiggy, Instamart and Domino's all print the basket in the plain text of
  their mail, so `data.items` carries the dishes — with quantities, options and
  per-item prices where the sender states them — for no extra cost. Across a
  year of real mail: 342 order receipts, 342 baskets read, 0 model calls.
- **The model is the last resort, not the first.** Header triage, embedded
  schema.org markup, `.ics` attachments and per-sender rules run first and are
  free. Against a real 30-day inbox: 621 message bodies read, 156 events
  extracted, **3 model calls** — and every billable call is recorded locally.

```bash
npm run ledger:probe -- --days 7      # dry run against your mail: no database, no model calls
npm run ledger:ingest                 # the real thing
npm run ledger:ingest -- --backfill-days 30   # rescan a window, ignoring the checkpoint
npm run ledger:summarize -- --period day
npm run ledger:costs                  # what the model has cost, from a local ledger
npm run ledger:tool -- search_events '{"query":"amazon","date_range":"last 30 days"}'
```

Every billable call is recorded locally before its result is used — failures
included, since a call that timed out was still billed. `ledger/pricing.json`
turns tokens into money at read time, so a corrected rate re-values the history
rather than leaving old rows wrong.

Ingestion runs locally under launchd (`ledger/launchd/`), so your mailbox
credentials and the Supabase service-role key never leave your machine.

---

## Tech stack

- **Frontend:** vanilla ES modules, HTML5, CSS3 (glassmorphic dark theme)
- **Routing:** hash-based client-side router (`src/router.js`)
- **Bundler:** [Vite](https://vite.dev/)
- **Charts:** [Chart.js](https://www.chartjs.org/) + `chartjs-adapter-date-fns`
- **Tables:** [Grid.js](https://gridjs.io/)
- **Backend:** [Supabase](https://supabase.com/) — magic-link auth, Postgres, RLS
- **Hosting:** Cloudflare Pages (direct upload via Wrangler)

Chart.js, Grid.js, Font Awesome and Inter are all npm dependencies bundled through `src/vendor.js` — nothing loads from a CDN, which is what lets the production CSP stay at `default-src 'self'`.

---

## Getting started

### 1. Environment

```bash
cp .env.example .env
```

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-project-publishable-anon-key
```

These are inlined at **build** time, not read at runtime.

### 2. Database

Run the migrations in `supabase/migrations/` in order, via the Supabase SQL editor or `supabase db push`:

- `0001_user_settings.sql` — the settings table, its RLS policies and an `updated_at` trigger.
- `0002_harden_rls.sql` — `NOT NULL` on `user_id` for the three data tables. A null `user_id` can never satisfy `auth.uid() = user_id`, so such a row is invisible to everyone, owner included.
- `0003_event_ledger.sql` — the event ledger: tables, indexes, triggers, RLS and grants.
- `0004_ledger_api.sql` — the ledger's function layer. Ingestion, deduplication, search, summaries and export. The browser, the jobs and Hermes all call these same functions.

`supabase/checks/rls_audit.sql` is a read-only audit: it reports whether RLS is enabled, whether every command is owner-scoped, which commands have no policy, and whether any row has a null `user_id`. Run it after any policy change.

### 3. Auth configuration

In **Supabase → Authentication → URL Configuration**:

- **Site URL:** your production origin
- **Redirect URLs:** every origin the app is served from, each with a trailing slash, plus `http://localhost:5173/`

The app sends a bare origin as `emailRedirectTo`. If it is not allow-listed, Supabase silently falls back to the Site URL and sign-in appears to do nothing.

### 4. Run

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # pure maths, and the ledger's extraction / dedupe / summary core
npm run build
npm run preview
```

### 5. The event ledger (optional, but it is the point of `#ledger`)

The ingestion jobs run on **your machine**, not on Cloudflare or in Supabase.
That is deliberate: your mailbox password and the Supabase service-role key
never leave the laptop. The cost is that mail is only ingested while it is
awake, which idempotent ingestion makes harmless.

```bash
cp .env.ledger.example .env.ledger && chmod 600 .env.ledger
cp ledger/accounts.example.json ledger/accounts.json && chmod 600 ledger/accounts.json
```

`.env.ledger` needs exactly **one** value: `SUPABASE_SERVICE_ROLE_KEY`. The
project URL is read from `VITE_SUPABASE_URL` in `.env`, and the user id is
resolved automatically when the project has a single user (`npm run
ledger:users` lists them if it has more).

The service-role key is *not* a duplicate of the anon key. The anon key is
subject to RLS and carries no session, so `auth.uid()` is null for a background
job and every write is refused. The jobs write on your behalf with nobody
signed in, which only the service role can do. It is deliberately not
`VITE_`-prefixed — Vite only inlines `VITE_*` — and it lives in a separate
gitignored file because it bypasses RLS entirely.

Mail accounts go in `ledger/accounts.json` — any number of them, any IMAP
provider. Passwords are read from the macOS Keychain or an environment
variable, never from the file:

```bash
# Gmail and Zoho both need an app-specific password, not your login password.
security add-generic-password -s finance-hub-ledger -a you@gmail.com -w
```

Then look before you leap. `probe` connects, reads and extracts, but writes
nothing, spends no model calls, and does not mark anything as read:

```bash
npm run ledger:probe -- --days 7 --limit 100
```

It prints what each layer extracted, how much would reach the model, and which
senders the rules missed — which is the to-do list for new rules. When it looks
right:

```bash
npm run ledger:ingest
```

To run it on a schedule, edit the paths in `ledger/launchd/*.plist`, copy them
to `~/Library/LaunchAgents/` and `launchctl load` each one. Ingestion every 15
minutes, daily summary at 23:40, retrospectives weekly and monthly.

`OPENAI_API_KEY` and `OPENAI_MODEL` are optional. Without them the deterministic
layers still produce a ledger and genuinely ambiguous mail lands in the review
queue instead of being guessed at.

---

## Deploying

The Cloudflare Pages project is **direct upload** — it does not build from Git.

```bash
npm run deploy          # build + push to production
npm run deploy:preview  # build + push to a preview URL
```

Because the build happens locally, setting `VITE_SUPABASE_*` in the Cloudflare dashboard does nothing — those variables only reach a Cloudflare-side build. The keys come from your local `.env`.

`public/_headers` carries the CSP, HSTS and cache rules; `public/_redirects` is the SPA fallback. Both are copied into `dist/` by Vite. Add a new external API and you must extend `connect-src`, or it will work in `npm run dev` and be blocked in production.

---

## Project layout

```
src/
  main.js            entry point; auth state → render
  auth-callback.js   snapshots magic-link params before supabase-js clears them
  supabase.js        client + getCurrentUserId
  settings.js        SETTINGS_SCHEMA, load/save, derived values
  constants.js       app-level config (card tiers, transfer partners)
  networth-math.js   pure net worth computations
  finance.js         pure savings-rate and FI projection maths
  utils.js           formatting, charts, modals, CSV, escaping
  vendor.js          bundled Chart.js / Grid.js / Font Awesome / Inter
  router.js          hash router
  views/             dashboard, networth, fi, points, ledger, settings, login, app shell
  ledger/            pure event-ledger core — taxonomy, normalization, dedupe keys,
                     email extraction, natural-language parsing, summaries.
                     Imported unchanged by the browser, the jobs and the tests.
ledger/              the ingestion jobs (Node, run locally under launchd)
  cli.js             probe / ingest / summarize / tool / users / purge
  connectors/        IMAP today; the interface any future source implements
  extract/llm.js     the last rung of the extraction ladder
  pipeline.js        extraction → dedupe → storage
  tools.js           the Hermes tool layer
supabase/migrations/ SQL
docs/ledger.md       how the ledger works, end to end
test/                node:test suites for the pure maths and the ledger core
```
