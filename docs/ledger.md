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

### Line items

An amount says a meal cost ₹149. It does not say it was rajma chawal.

Every delivery platform prints the basket in the plain-text body of its
receipt, so `src/ledger/items.js` reads it as part of the same free rules layer
— no model call, no PDF, no second request. What lands in `data.items` is
`{name, qty, amount?, options?}` per dish, and the parser is keyed on the shape
of the body rather than the subject, because two of these senders changed
layout inside a year while keeping the subject identical.

| Sender | Where the basket is | Per-item price |
| --- | --- | --- |
| Zomato | `1 X Cheese Masala Dosa` lines above `Total paid` | no — only in the attached invoice PDF |
| Swiggy (2026) | `BILL DETAILS`: `<dish> x1`, amount on the next line | yes |
| Swiggy (older) and Gourmet | an `Item Name / Quantity / Price` table | yes |
| Instamart | `1 x <item> ₹20.00` under `Order Items` | yes |
| Domino's | `Items / Qty / Price`, one pizza across four lines | yes |

Measured against a year of real mail: **342 order receipts, 342 baskets, 0
model calls.** What has no basket to read has one for a reason — a Swiggy
Dineout or District bill is an offline meal paid through an app, and the
restaurant never itemised it.

The rest is typed, on the Food screen: a meal with no receipt at all (four
things arrive from Blinkit as one grocery purchase; eating two of them on
Tuesday evening is a different event on a different day, with no money
attached) is recorded as its own `food/meal` event carrying only items. It is
written with `allow_merge` off — with no amount to agree on, the fuzzy matcher
has nothing but a timestamp, and it would fold the eating into the order that
paid for it.

Three things the platforms do that the parser has to survive:

- **The delivery app is not the restaurant.** Swiggy's body opens "Greetings
  from Swiggy", which satisfies every "ordered from X" pattern. Believing it
  files every meal under a restaurant called Swiggy — and the deduplicator then
  trusts that name. The restaurant comes from the `ORDER JOURNEY` heading, or
  from Zomato's subject line, and a guessed name that merely repeats the
  platform is discarded.
- **Instamart is Swiggy, from Swiggy's address, signed by Swiggy.** Only the
  subject separates a grocery run from a dinner, which is why `kind` is decided
  there and not by the sender.
- **The charges are worded like the dishes.** "Restaurant Packaging" and
  "Platform fee with GST" sit in the same list as the food; only the items
  carry a quantity, and the named charges are excluded outright.

### Meals

Which meal a plate counts as is derived from the clock at read time, never
stored:

| From | To | Meal |
| --- | --- | --- |
| 04:30 | 12:15 | Breakfast |
| 12:15 | 15:00 | Lunch |
| 15:00 | 19:00 | Snacks |
| 19:00 | 00:00 | Dinner |
| 00:00 | 04:30 | Snacks |

The day starts at 04:30 rather than at midnight, so food ordered at 01:00 is
the previous night's last snack instead of the next morning's breakfast. A
grocery order is not a meal at any hour and is labelled as itself.

The meal is a **label the event carries, not a section it sits in**. Grouping
the Food screen into breakfast/lunch/snacks/dinner bands meant a row's position
came from which band it belonged to rather than from when it happened — a 01:00
snack sorted between lunch and dinner — and a day of four meals rendered four
headers to group four single rows. As a label, the clock is the only sort key.

Deriving rather than storing is what makes the boundaries movable: change one
here (`MEAL_SLOTS` in `src/ledger/taxonomy.js`) and every meal in the ledger's
history relabels itself, with nothing re-ingested and no row rewritten.

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
- **A card alert at a restaurant is a meal.** The mail states a merchant and an
  amount and nothing else, so the event was a `purchase` — and a meal filed as
  a purchase never reaches the Food screen, which is the one place its dishes
  could be added. The merchant is now read three ways: the alias table's
  category, a list of words that only appear in food businesses ("foods",
  "dhaba", "dining" — but never "hotel", where half the matches would be places
  you slept), and, decisively, **whether that merchant already carries a food
  event in your ledger**. The last is what makes a correction stick: switch one
  alert from purchase to food by hand and every later alert from that merchant
  follows, with no rule written for it. The subtype stays `card_transaction`,
  because that is still how the event was seen and it is what lets the
  restaurant's own receipt take over the description if one arrives.
- **The card issuer is not the merchant.** Linked as a `provider`, the bank
  accumulates the amount of every transaction on the card and becomes the
  largest merchant in the ledger. It is linked as `issuer`, counted but never
  credited with the spend.
- **A campaign from a receipt address is still a campaign.** "The next time
  you order…" carries no offer and no discount, so it clears the promotional
  gate, and the food rule then read it as a meal from a restaurant called
  Zomato. An order leaves something behind: an order number, a basket or an
  amount. None of the three, no event.
- **A failed payment is not a purchase.** "Alert : Payment Failed for your
  Order #228036798252397" names the restaurant, the order number and the
  amount of a meal that was never cooked.
- **A cancelled order is not a meal either.** It reads exactly like a delivered
  one; it is recorded as the refund it becomes, related to the order rather
  than merged into it.
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
node ledger/cli.js tool log_meal      '{"natural_language":"2 packets maggi with 3 cheese slices"}'
node ledger/cli.js tool get_stats     '{"date_range":"this month"}'
```

#### Meals get their own pair of tools

`create_event` records that a meal happened. The Food screen is built on
*what was on the plate*, which is a harder question, so `log_meal` and
`add_meal_items` answer it directly:

| Sentence | What is written |
| --- | --- |
| "2 packets maggi with 3 cheese slices" | Maggi ×2, Cheese Slices ×3, now |
| "had 2 idlis and a vada at Veena Stores at 7:30am" | two dishes at a named place, at the stated time |
| "going to Ravi's place for dinner" | a `scheduled` meal at Ravi's Place, no dishes yet |
| "lunch at home — rajma chawal" | one dish, no place: eating at home is not a restaurant |

Three rules the parser follows, each of which exists because the alternative
was wrong:

- **A unit sits between the number and the name.** "2 packets maggi" is two
  Maggi; "3 cheese slices" is three Cheese Slices. Position is the only thing
  that separates a container from the food.
- **The past tense never schedules.** "had dinner", typed over breakfast, is
  last night's dinner — the meal's default hour is ahead of the clock, and
  scheduling it would file an eaten meal as an intention.
- **A number is what makes a phrase a dish**, unless a verb has already said
  the sentence is about food. "making maggi" is a dish; "going to Ravi's place"
  is a circumstance.

`add_meal_items` is the other half of a plan: it appends to a meal already in
the ledger, sums the quantity of a dish already listed rather than repeating
it, and flips a `scheduled` meal to `confirmed` — knowing what was on the plate
is evidence it happened. Both tools snap dish names to the spellings the ledger
already holds, so "maggi" joins the Maggi you eat weekly instead of starting a
second one, and both write with merging off: eating is not buying, and a meal
with no amount would otherwise fold into the grocery order that paid for it.

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
