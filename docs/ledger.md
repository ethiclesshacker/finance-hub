# Personal Event Ledger

A structured, searchable record of things that happened, populated mostly by
itself from email and interpreted — carefully — by an assistant.

The database is the product. The UI is a window onto it, and Hermes is one
caller among several. Delete the UI and the ledger is intact; remove Hermes and
every question it answers is still a SQL function away.

---

## The three rules everything else follows from

1. **Provenance is never lost.** Every automatically created event points at the
   source it came from, and `event_sources` keeps *all* of them when several
   sources describe one event.
2. **Facts and interpretation live in different columns.** `events.data` is what
   a source stated. `events.inference` is what a model thinks it means. The
   merge logic will not let the second overwrite the first.
3. **Ingestion is idempotent.** `sources (user_id, source_type, external_id)` and
   `event_keys (user_id, key)` are both unique, so replaying a run updates rows
   instead of multiplying them.

---

## Shape of the data

| Table | What it holds |
| --- | --- |
| `events` | The ledger. One row per real-world happening. |
| `sources` | Where an event came from — a pointer, not a copy of your mail. |
| `event_sources` | Every piece of evidence for an event. Many per event. |
| `event_keys` | Every deterministic identifier an event is known by. |
| `entities` | Recurring merchants, people, places, projects. |
| `event_entities` | Which entities an event involves, and how. |
| `event_relations` | Distinct-but-connected events (a trip and its hotel booking). |
| `daily_summaries` / `period_summaries` | Derived write-ups. Regenerable. |
| `derived_insights` | Model observations *about* the ledger, kept apart from it. |
| `ingestion_runs` / `ingestion_checkpoints` | Observability, and where to resume. |
| `ledger_audit_log` | Append-only record of deletions, dismissals and edits. |

`data` is JSONB rather than a table per event type. A purchase carries
`{merchant, amount, currency, order_id, category}`, a flight carries
`{provider, origin, destination, booking_reference, departure}`. Adding a kind
of event needs no migration.

### Types

`type` is open text with a lookup table (`ledger_event_types`) for labels. A
trigger registers anything it has not seen, so an unknown type can never fail a
write. The catalogue exists for the UI, not to gate ingestion.

`transfer` deserves a note: refunds, salary credits and card bill payments are
money moving *in*. They are not purchases, and keeping them out of `purchase`
is what makes every spend total correct without a caller having to remember to
exclude them.

### Status and confidence

| Status | Meaning |
| --- | --- |
| `confirmed` | Stated by a trusted source, or entered by you. |
| `inferred` | Extracted with reasonable but not certain confidence. |
| `scheduled` | On the calendar. Not yet reconciled against evidence it happened. |
| `needs_review` | Low confidence. Sits in the review queue. |
| `dismissed` | Not a real event. Kept so ingestion cannot recreate it. |

Thresholds are **settings**, not constants: `ledger_confidence_confirmed`
(0.95) and `ledger_confidence_review` (0.75) live in `user_settings`, and the
SQL reads them through `ledger_setting()`.

---

## Ingestion

```
connector → triage → extraction → normalization → dedupe → storage → entities
```

Only the connector knows what a mailbox is; only the last stage knows what
Postgres is. Everything between is source-agnostic, which is what lets a
calendar or a card API plug in later without touching the event model.

### The extraction ladder

Cost is controlled by ordering, not by avoiding the model:

| Layer | What it is | Cost |
| --- | --- | --- |
| 1. Envelope filter | Subject and sender only. OTPs, campaigns and newsletters never have their body downloaded. | free |
| 2. schema.org JSON-LD | `Order`, `FlightReservation`, `LodgingReservation`, `ParcelDelivery`, `Invoice` — markup senders already embed. | free, exact |
| 3. iCalendar | `.ics` attachments on invitations. | free, exact |
| 4. Sender rules | Card alerts, UPI payments, food delivery, cabs, shipments, utilities, tickets, insurance. | free |
| 5. The model | Only what survived all of the above *and* still reads as a transaction. | billed |

Measured against a real 30-day inbox: **844 bodies read, 200 events, 3 model
calls.** Roughly a third of a percent.

Thinking is disabled for extraction (`OPENAI_REASONING_EFFORT=none`). Measured
on real mail: identical output, 17% fewer tokens, 42% faster. Reading stated
fields into the right slots is not a task that benefits from deliberation.

Two mechanisms keep it there:

- **Rule tiers.** A Zomato receipt says both "your order from X" and "paid by
  card", so the food rule and the payment rule both match. Only the most
  specific tier that matched is kept — otherwise one email becomes two events.
- **The fingerprint cache.** `sender + digit-masked subject shape`. A shape seen
  three times that has never produced an event stops being sent to the model.
  It only ever suppresses negatives, so it cannot hide an event a rule would
  have caught.

### What the parser learned the hard way

Every rule below exists because real mail broke something. They are worth
knowing before changing the extraction code.

- **A card alert states three amounts.** The purchase, then the available
  limit, then the amount due. Nothing marks which is which, and the purchase is
  usually the smallest. Limits and balances are disqualified outright, and the
  tie-break between unlabelled amounts is *first*, not largest — a ₹140 coffee
  was once recorded as ₹1,90,465.
- **No amount beats a wrong amount.** When every figure on the page is a limit
  or a balance, extraction returns nothing. A wrong amount is silently summed
  into every total you look at; a missing one announces itself.
- **Marketing talks about transactions; an alert reports one.** Requiring the
  word "transaction" let a card-benefits mailer through as a ₹50,000 purchase.
  Rules now require the *shape* — an amount and a verb, adjacent.
- **One email tells one story.** A Zomato receipt says both "your order from X"
  and "paid by card". Rules are tiered, and only the most specific tier that
  matched is kept, or one dinner becomes two events.
- **An order number is not an event id.** The purchase, the parcel shipped
  against it and the refund reversing it all carry the same number. Keys are
  namespaced by event kind (`order:` / `parcel:` / `refund:`), otherwise the
  refund merges into the order and disappears.
- **Money moving between your own accounts is not spending.** Configure
  `ledger_self_identifiers` with your UPI handles and the name your bank
  prints; matching transfers become `transfer/self_transfer`.
- **Payment rails are not merchants.** "Payment to Easebuzz Private Limited"
  names how the money moved. Recorded as a merchant it invents a shop you never
  visited and asserts a name the deduplicator then uses to reject the real
  match.
- **Senders emit invalid iCalendar.** `DTSTART;TZID=Asia/Kolkata:20260816T130000Z`
  combines a named zone with a UTC suffix, which RFC 5545 forbids. Believing
  the `Z` put every such booking 5½ hours late; the named zone wins.
- **A rule that throws is a bug, not an odd layout.** Rule exceptions are
  recorded in the run and shown by `probe`. Swallowing them once hid a
  `ReferenceError` that disabled a rule on every email it matched.
- **One bank sends several templates.** HSBC alone writes both "was used for a
  purchase transaction of INR 140.00 at X" and "has been used for INR 189.00
  for payment to Y". Tightening the pattern around the first silently dropped
  ~20 real alerts a month. Tighten triage, not the extraction pattern: the
  promotional gate is what keeps marketing out.
- **A balance notice is not an event.** "Available balance in your account is
  Rs. 1,000.00" reports a state. Sent to the model, one came back as a ₹15,000
  credit that never happened.
- **The card issuer is not the merchant.** Linked as a `provider`, the bank
  accumulates the amount of every transaction on the card and becomes the
  largest merchant in the ledger. It is linked as `issuer`, counted but never
  credited with the spend.
- **You are not an entity in your own ledger.** Incoming self-transfers name
  you as the counterparty, in as many spellings as you have banks. People named
  by the model are filtered against `ledger_self_identifiers`.

The general shape of all of these: **a wrong value is worse than a missing
one**, because a wrong value is summed into totals and never announces itself.
Where the parser cannot tell, it records nothing and the review queue asks.

### Deduplication

The same dinner can arrive as a Zomato receipt, an HSBC card alert and a note
to Hermes. It must be one event with three sources.

1. **Deterministic.** `event_keys` maps every identifier — order number,
   transaction reference, PNR, calendar UID — to an event. A unique index makes
   this exact and race-proof.
2. **Fuzzy.** `ledger_find_duplicate` scores candidates on amount, name
   similarity (`pg_trgm`), type and time proximity. An **amount disagreement
   disqualifies outright**: two restaurant charges an hour apart for different
   amounts are two meals, and merging them would destroy a fact.
3. **Cross-type.** A card alert is a `purchase`; the food order it paid for is
   `food`. Matching is allowed to cross between spend types *when there is an
   amount to agree on*.

A **name disagreement disqualifies a match**, exactly as an amount
disagreement does. Without it, a ₹94.00 payment to Smartworks merged into a
₹94.58 Zomato order — amount and time carried the score while the contradicting
merchant contributed nothing. Two things that happened close together are still
two things.

On a match, evidence is added and confidence rises — an independent source type
adds `ledger_corroboration_bump`. Existing facts win; a disagreeing source is
recorded as a conflict in the audit log rather than silently dropped. A
dismissed event stays dismissed.

### Checkpoints

Per account and folder: `{uidValidity, lastUid}`. The checkpoint moves **after**
events are committed, so a crash costs a re-read (free, by design) rather than
a permanent gap. A changed `UIDVALIDITY` means the server renumbered the
mailbox, and the folder is rescanned from its lookback window.

---

## What it costs

Every billable call goes through one function (`ledger/extract/openai.js`), which
appends a line to a **local** cost ledger before doing anything else with the
result — including failed calls, since a request that burned tokens and then
timed out still cost money.

```bash
npm run ledger:costs -- --days 30
```

It is a local JSONL file, not a Supabase table, on purpose: it is operational
data about this machine's jobs rather than part of your life record, and it
should stay readable exactly when the database is not — which is when you most
want to know what a retry loop cost.

Tokens are recorded as facts, because the API reports them. Money is derived at
read time from `ledger/pricing.json`, so correcting a rate re-values the whole
history instead of leaving old rows wrong. A model with no configured price
shows its tokens and a blank cost rather than an invented number.

---

## The API

Every caller — browser, jobs, Hermes — goes through the same SQL functions.

| Function | Purpose |
| --- | --- |
| `ledger_ingest_event(user_id, payload)` | The single write path. Dedupe, merge, entities, provenance. |
| `ledger_search_events(...)` | Text, type, entity, status, date-range search. |
| `ledger_get_event(id)` | One event with sources, relations and history. |
| `ledger_create_event(...)` / `ledger_update_event(...)` | Manual and Hermes writes; corrections. |
| `ledger_dismiss_event(...)` / `ledger_delete_event(...)` | Reversible, and not. |
| `ledger_merge_events(target, duplicate)` | Fold a duplicate in, keeping all evidence. |
| `ledger_duplicate_candidates(id)` | What the merge picker offers. |
| `ledger_get_daily_summary` / `ledger_get_period_summary` | Derived write-ups plus live counts. |
| `ledger_stats(from, to)` | Aggregates, computed at call time, never stored. |
| `ledger_search_entities` / `ledger_get_entity` / `ledger_search_entity_events` | "What have I bought from Amazon?" |
| `ledger_export(from, to)` | Everything, as JSON. |
| `ledger_purge_snippets(days)` | Drop cached body text, keep the pointer. |

All are `SECURITY INVOKER`, so RLS enforces ownership for a signed-in caller.
The jobs use the service role, which bypasses RLS — so those functions take an
explicit `p_user_id` and check `ledger_can_act_as()` rather than trusting it.

### Hermes

```bash
node ledger/cli.js tool                       # list the tools
node ledger/cli.js tool search_events '{"query":"amazon","date_range":"last 30 days"}'
node ledger/cli.js tool create_event  '{"natural_language":"dinner at Nagarjuna last night, 1250"}'
node ledger/cli.js tool get_stats     '{"date_range":"this month"}'
```

`docs/hermes-tools.json` is the same set in JSON-Schema function-calling form.
Date ranges accept ISO dates, `{from,to}`, or phrases like `"last 30 days"`,
`"this month"`, `"yesterday"`.

A hosted Hermes can skip this layer and POST to
`/rest/v1/rpc/ledger_search_events` with the user's JWT — same functions, same
rules, RLS enforcing ownership.

---

## Privacy

- Mailboxes are opened **read-only**. Nothing is marked read, moved or deleted.
- Credentials never enter the repo or the database. IMAP passwords come from the
  macOS Keychain or an environment variable; `ledger/accounts.json` and
  `.env.ledger` are gitignored.
- The service-role key lives only in `.env.ledger` on your machine. It is not
  `VITE_`-prefixed, so Vite cannot inline it into the browser bundle.
- Sources store a **pointer** — mailbox, folder, UID, message-id — plus a
  300-character snippet for debugging that `ledger_purge_snippets()` removes on
  a schedule. Full bodies are never stored.
- `anon` has no grant on any ledger table; RLS scopes every row to its owner.
- The audit log has no INSERT/UPDATE/DELETE policy, so a user session cannot
  rewrite its own history. Only `SECURITY DEFINER` triggers append to it.
- `ledger_export()` and `ledger_delete_event(purge_sources => true)` exist so the
  data can be taken out or removed.

---

## Operations

```bash
npm run ledger:probe -- --days 7 --limit 100   # dry run: no database, no model calls
npm run ledger:ingest                          # the real thing
npm run ledger:ingest -- --backfill-days 30    # rescan a window, ignoring the checkpoint
npm run ledger:summarize -- --period day       # or week / month
npm run ledger:costs -- --days 30              # what the model has cost
npm run ledger:tool -- get_review_queue '{}'
node ledger/cli.js models --filter 5.6         # what OPENAI_MODEL can be set to
node ledger/cli.js purge --days 90             # drop old cached snippets
```

### Backfilling

`--backfill-days N` ignores the checkpoint and rescans that window. Safe to run
repeatedly: everything already stored is matched by its source id or dedupe key
and updated rather than duplicated — the same property that makes a crashed run
harmless. The checkpoint never moves backwards afterwards, so the next forward
run does not re-read everything since.

`probe` is the tuning loop: it prints what each layer extracted, what would
reach the model, and which senders the rules missed — the last of which is a
to-do list for new rules.

Scheduling is launchd; see `ledger/launchd/`. Ingestion runs every 15 minutes,
the daily summary at 23:40, retrospectives weekly and monthly.

### Adding a source

Implement `fetchNew(account, cursor, options)` returning
`{ messages, cursor, stats }` in the shape `src/ledger/email.js` expects, and
register it in `ledger/connectors/index.js`. Extraction, normalization,
deduplication, entity resolution, storage and the UI are unchanged.
