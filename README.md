# FinanceHub — Personal Finance Command Centre

FinanceHub is a single-page personal finance app: net worth snapshots, asset allocation, emergency runway, financial-independence projections, and a full HSBC TravelOne points and redemptions ledger — backed by Supabase and deployed to Cloudflare Pages.

---

## Screens

| Route | What it does |
| --- | --- |
| `#dashboard` | Net worth, total assets, savings rate, FI progress, emergency runway, and a points summary strip. |
| `#networth` | Snapshot history with KPIs, accumulation and allocation charts, filtering and CSV export. |
| `#fi` | Savings rate (actual vs budgeted), time to FI, Coast FI, and a projection chart with live scenario sliders. |
| `#points` | Transactions and redemptions, multiplier tracking, spend-by-merchant, value-per-point, CSV export. |
| `#settings` | Every personal number the other screens derive from. |

---

## Settings, not constants

Personal numbers — income, expenses, FI multiplier, expected return, targets — live per user in the `user_settings` table as key/value pairs, **not** as one column per setting. Adding a knob is a single object literal in `src/settings.js`; no migration, no rebuild, no redeploy.

- `value` is `jsonb`, so numbers stay numbers and booleans stay booleans.
- `SETTINGS_SCHEMA` in `src/settings.js` is the source of truth for each key's type, default, bounds and label — and it generates the settings screen automatically.
- A key with no stored row falls back to its schema default, so nothing needs seeding.

`src/constants.js` keeps only what describes the app and the card itself (multiplier tiers, transfer partners) — things a user should not be able to diverge from.

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
npm test         # pure maths: net worth, savings rate, projections
npm run build
npm run preview
```

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
  views/             dashboard, networth, fi, points, settings, login, app shell
supabase/migrations/ SQL
test/                node:test suites for the pure maths
```
