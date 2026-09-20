# Apple Health → Supabase

An iPhone app reads HealthKit and POSTs batches to the `healthsync` Edge Function,
which writes them into the `health` schema through one database function.

```
iPhone (HealthSync, self-built)
   │  POST /functions/v1/healthsync/api/apple-health/sync   Bearer fh_health_…
   ▼
supabase/functions/healthsync     validate size, shape, finite numbers, dates
   │  rpc public.health_ingest(token_hash, device, version, payload)
   ▼
health.metrics · health.workouts · health.sync_batches · health.tombstones
   └─ views: health.daily_totals · health.sleep_nights
```

The app is a patched private build of `megabyte0x/healthykit`, kept in
`~/projects/healthsync-ios` on the `finance-hub` branch. Upstream has no licence,
so that build is for personal use only and must not be redistributed. Nothing
from upstream's backend is used: its migrations revoke grants on `public` and
its function lets anyone mint a token. The why of each design choice is in the
header of `supabase/migrations/0009_health.sql`.

## Set up the backend (once)

1. Run `supabase/migrations/0009_health.sql` in the Supabase SQL editor. It is
   additive and safe to re-run; it changes no existing grant.
2. Mint the phone's token, in the same editor. It is shown once.
   ```sql
   select health.mint_ingest_token('iPhone');
   ```
3. Deploy the function. `--no-verify-jwt` is required: the phone sends its own
   token, not a Supabase JWT.
   ```bash
   npx supabase login
   npx supabase functions deploy healthsync --no-verify-jwt --project-ref <ref>
   ```
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
4. Check it is up, and that the browser roles are locked out.
   ```bash
   curl https://<ref>.supabase.co/functions/v1/healthsync/health        # {"ok":true}
   curl -X POST https://<ref>.supabase.co/rest/v1/rpc/health_ingest \
     -H "apikey: $VITE_SUPABASE_ANON_KEY" -H 'content-type: application/json' \
     -d '{"p_token_hash":"x","p_device_id":"d","p_app_version":"v","p_payload":{}}'
   # expect: permission denied for function health_ingest
   ```

Do not add `health` to the project's exposed schemas.

## Put the app on the phone

Needs full Xcode (the command line tools alone cannot build for iOS) and an
Apple ID. A free Apple ID works; the install then expires after 7 days and has
to be re-run from Xcode. Data and the token survive a re-run. A paid developer
account makes it a year.

1. Install Xcode from the App Store, then `sudo xcode-select -s /Applications/Xcode.app`.
2. `open ~/projects/healthsync-ios/HealthSync.xcodeproj`. In the HealthSync
   target → Signing & Capabilities, pick your team (add the Apple ID under
   Xcode → Settings → Accounts first).
3. On the iPhone: Settings → Privacy & Security → Developer Mode → on. Plug it
   in, trust the Mac, select it as the run destination, press Run.
4. First launch is blocked until you trust yourself: Settings → General →
   VPN & Device Management → your Apple ID → Trust.
5. In the app: Continue → allow the Health types → Settings → paste the token →
   Save → Dashboard → "Sync last 24 hours".

The first sync sends the last 90 days of raw samples. Use Backfill for older
history; it sends one HealthKit-deduplicated total per day.

## What the patched app changes

| Upstream | This build |
|---|---|
| Defaults to the author's server, hourly sync, all 189 types | Your function URL, manual sync, 15 types |
| Author's host hardcoded as the hosted destination | Empty, so hosted mode can only fail |
| First sync: whole history, one POST | Last 90 days, 1000 records per batch |
| Backfill chunks split days mid-way | Chunk edges on local midnight |
| Oldest failed batch retried first; one corrupt row blocks all | Fewest-attempts first; corrupt rows skipped |

## Reading the data

Nobody reads `health.metrics`. HealthKit stores a row every time a sensor
flushes — a minute or two of steps, once from the phone and again from the
Watch — so three months is about 120,000 rows and none of them is a number a
person wants. Everything reads **rollups**, from `0010_health_api.sql`:

| Function | Returns |
|---|---|
| `health_overview(from, to)` | One object per day: steps, energy, sleep, heart, weight, workouts |
| `health_series(type, from, to)` | One type per day. A total for cumulative types, min/avg/max/latest for readings |
| `health_intraday(type, day, minutes)` | One type across the hours of one day |
| `health_sleep(from, to)` | One object per night, with stage minutes and local bed and wake times |
| `health_workouts(from, to)` | The workouts |
| `health_catalog()` | Which types have data, and when the phone last synced |

Cumulative types are summed from **one source per day**, the one with the
largest total, so the Watch and the phone are never added together.

Three callers, one set of functions:

- **The dashboard** (`#health`, `src/views/health.js`) calls them with your
  login. Each function refuses a request for any user but the caller.
- **Hermes** gets them as MCP tools from `ledger/tools.js`:
  `get_health_overview`, `get_health_metric`, `get_health_day_detail`,
  `get_sleep`, `get_workouts`, `list_health_metrics`. The routing row is in
  `~/.hermes/SOUL.md`. After changing tools, restart the gateway.
- **You**, in the SQL editor:
  ```sql
  select public.health_series('step_count', current_date - 6, current_date,
                              (select id from auth.users limit 1));
  ```

### Joined with the rest of your life

`0011_life_api.sql` joins the three stores that used to be separate (finance
tables, the event ledger, Apple Health):

| Function | Returns |
|---|---|
| `life_days(from, to)` | One object per day: money, food, body, energy balance against the calorie target, activity |
| `life_activity(from, to)` | Watch workouts, plus ledger activities the Watch missed. A telling that matches a Watch workout is folded into it |
| `finance_net_worth(limit)` | Latest snapshot with breakdown, change, history |
| `finance_card_points(from, to)` | Points balance, period spend and earn rate, merchants, redemptions |
| `finance_settings()` | Saved settings only; defaults come from `src/settings-schema.js` |

Two rules worth knowing. **Weight** is written to the ledger and read as the
union of both stores, newest reading wins, so the Health page and Hermes agree.
**Energy balance** is only trusted on days marked `complete`: not today, no
unpriced meal, and food of at least 60% of the calorie target. A day with one
snack logged is a gap in the record, not a 2,500 kcal deficit.

Hermes tools over these: `get_day`, `get_net_worth`, `get_card_points`,
`get_targets`, and `get_workouts` (now the merged feed). The daily, weekly and
monthly summaries (`ledger/jobs/summarize.js`) carry a `body` section built from
`life_days`, and Edith's Sunday `weekly-review` cron reads all of it. Its prompt
is kept at `~/.hermes/cron/weekly-review.prompt.current.txt`; edit with
`hermes cron edit 612f8bb3123b --prompt "$(cat <file>)"`.

The `anon` key cannot call any of them, and the `health` schema stays
unexposed. After a large first sync or backfill, run `analyze health.metrics;`
once: until the planner has statistics, a 90-day overview takes seconds
instead of under half of one.

Known gap: percentage types (body fat, blood oxygen) may arrive as 0–1
fractions labelled `percent`. Check the first real rows before trusting them.

## Cutting a phone off

```sql
update health.ingest_tokens set revoked_at = now() where label = 'iPhone';
```
