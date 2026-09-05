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

### Nutrition

The ledger records what was ordered and what it cost. It has never recorded
what was in it. `0005_nutrition.sql` adds that as a **dish dictionary**, and
the shape follows from one measurement: a year of eating produced 654 food
events but only **146 distinct dish names**. Nutrition is a property of "Cheese
Masala Dosa", not of the twenty-four separate evenings you ordered one.

So `food_items` holds one row per dish, keyed by the same
`ledger_normalize_name()` that dedupes merchants, and every event that mentions
that dish reads the same row. Resolve once, reuse forever; re-running the
resolver costs nothing.

#### The resolver ladder

`npm run ledger:nutrition` walks four rungs, cheapest first:

| Rung | Source | What it answers | Measured on this ledger |
| --- | --- | --- | --- |
| 0 | the dictionary | already resolved | free |
| 0.5 | the reference engine | the same dish, spelled differently | free |
| 1 | curated table | the traps only | 10 names |
| 1.7 | Anuvaad INDB (local) | generic Indian dishes, measured | free, no API |
| 2 | Open Food Facts / USDA FDC | branded packages | 27 names |
| 3 | the model | composed dishes, INDB-grounded | 99 names |

**The ordering is deliberately the opposite of the obvious one**, and it is the
only interesting decision in the feature. Structured food databases look like
they should be the first pass and are not, because they answer a different
question than the one being asked: they hold *ingredients and packaged
products*, while a receipt line is *a composed dish at an unknown portion*.
Probing the real dish names against both APIs:

| Query | What came back |
| --- | --- |
| `Bhindi Roti Thali` | FDC: "Bread, chappatti or roti" — a thali is roti *plus* dal *plus* sabzi *plus* rice |
| `Paneer Grilled Sandwich` | FDC: "Fish sandwich, grilled" — wrong food, plausible score |
| `Cheese Masala Dosa` | both: nothing |
| `rajma chawal` | OFF: two retort pouches at 73 and 285 kcal/100g, disagreeing 4× |
| `Onion` | FDC: "ONION" at 289 kcal/100g — an exact string match, and 7× wrong |

That last row is why acceptance is **not** a string-similarity threshold: the
perfect name match was the worst answer in the probe. `judge()` in
`ledger/nutrition/databases.js` instead requires three things at once — the
candidate must name essentially the whole query (coverage, not Jaccard, which
rewards short names), its energy density must be physically possible for a
food, and independent rows for the same product must agree. All four rows above
are rejected; a real `Lay's` label is accepted.

#### The reference engine

Before anything is looked up or estimated, `food_match_item()` asks whether the
dictionary already knows this dish under a different spelling — `Idli (2pc)` and
`Idly (2pc)`, `Onion Uttapam` and `Onion Uthappam`. Re-estimating those is worse
than wasteful: two rows for one plate will disagree by a hundred calories, and
the disagreement then shows up as noise in a daily total with no real cause.

The hard part is knowing when **not** to reuse, and a similarity score cannot
do it. These four pairs all score high and only the first is safe:

| Pair | Trigram | Same dish? |
| --- | --- | --- |
| `Idli (2pc)` / `Idly (2pc)` | 0.83 | yes — transliteration |
| `Paneer Butter Masala Mini Thali` / `… Thali` | 0.88 | **no** — a size |
| `Veg Fried Rice` / `Egg Fried Rice` | 0.79 | **no** — different food |
| `Coke Zero 300ml` / `Coca Cola 300ml` | 0.71 | **no** — 200 kcal apart |

So there are two gates, not one. pg_trgm rules out unrelated dishes cheaply;
`sameDish()` in `ledger/nutrition/reference.js` then requires that the leftover
tokens be nothing that could change the plate. A **MODIFIER** — cheese, ghee,
paneer, egg, a size, a sugar state — present on one side and absent on the other
disqualifies the match outright, and is checked *before* spelling is paired off,
so `veg`/`egg` can never be waved through as a typo.

Only then are same-word-different-spelling tokens paired up by edit distance,
with a budget that scales with length (`idli`/`idly` at 4 letters gets one edit;
`uttapam`/`uthappam` at 8 gets two; anything under 4 letters gets none). Without
that pairing step a substitution always contributes *two* tokens to the diff and
could never read as a single spelling difference.

A reused row **inherits its origin**: `source_ref` records which dish it was
taken from, the similarity, and the reason, and confidence drops a step. A value
that began as a model estimate never gets promoted to looking like a checked one
just by being copied.

The dictionary grows as the resolver runs, so a name the model resolves in an
early batch is available to match against later in the same run.

#### The Anuvaad INDB rung, and what it grounds

`ledger/nutrition/indb.json` is the **vegetarian subset** of the Anuvaad Indian
Nutrient Databank (2024.11): 859 standardized recipes with per-100g composition
*and a real per-serving portion* — the one thing no remote database offered. A
local file: free to consult, cannot rate-limit.

The vegetarian filter ran at extraction (155 rows dropped): all flesh by
English and Hindi names (chicken/murgh, mutton/gosht, fish/machli, keema…),
all egg dishes, and the egg-*defined* preparations — meringue, soufflé,
classic mayonnaise. Explicitly eggless variants stay, as does all dairy.
`test/nutrition.test.js` holds the line against regressions.

Used two ways:

- **A judged rung** for generic names INDB truly contains ("Masala dosa" →
  345 kcal / 210 g, measured). Same gates as the remote rung, with one
  addition: an *exact* name match skips the candidates-must-agree gate,
  because INDB's several dosa variants disagreeing is real variety, not
  ambiguity — it must not veto the row whose name is the query.
- **Grounding for the model.** Each batch carries the closest INDB rows as
  measured anchors, so "Cheese Masala Dosa" is estimated as *measured masala
  dosa + cheese*, with a note that restaurant versions run 10–30% richer.

Rank 38 (`0007_indb_source.sql`): above USDA FDC, below an OFF printed label.

#### The curated table is deliberately tiny

`ledger/nutrition/curated.js` holds ten entries, and growing it would be a
mistake. It is not "dishes we have estimates for" — it is "cases where a model
reliably errs and the right answer is not a judgement call": zero-calorie
drinks whose names contain "Coke", raw produce that every database returns
dried, and sachet condiments where assuming 100g is the whole error.

Filling it with estimated rows would be worse than useless. `curated` outranks
`llm` in `food_source_rank()`, so a guess written there would permanently
shadow a better answer while carrying a provenance implying a human checked it.
The way to improve a dish you eat often is to correct it with `setManual()`,
which writes `source = 'manual'`, `verified = true` — an honest record that
someone actually checked those numbers.

#### Portion is stored, never implied

Every food database on earth returns kcal per 100g. A ledger row is "one mini
thali". The gram weight bridging those two is **the largest error term in the
whole estimate**, so `portion_g` is a column you can correct rather than a
number buried inside a kcal figure you cannot audit. The model is required to
state it; the database rung records whether it came from the item name, the
database's serving size, or a bare 100g assumption.

#### Stated calories outrank the dictionary

A calorie count carried on the line item itself (`kcal`) wins over any
dictionary row: it came from the person or the menu, about that exact serving.
Zero is a legitimate statement — a Coke Zero — so the test is "is a number",
never truthiness. Macros still come from the dictionary when it knows the dish.

Stated counts are also written through to `food_items` as `source = 'manual'`
(unverified), so a dish the user once priced is never estimated again. This
rule exists because of a real failure: "Maharaja Mac 833, fries 225, Coke Zero
0" rolled up as **1 kcal** — only the Coke Zero was in the dictionary, and the
rollup threw the stated numbers away. `0006_stated_calories.sql` carries the
SQL half.

#### What the rollup refuses to do

`food_event_nutrition()` reports a `basis` per meal, and the honesty is in the
middle value:

- `itemized` — every line item resolved. The number means something.
- `partial` — some resolved. Reported *with the shortfall*, because a
  half-priced basket must never read as a light meal.
- `none` — no basket, or nothing in it resolved. **`kcal` is null, never 0.** An
  unknown meal is not a meal without calories, and a zero would quietly drag
  every average down.

Averages are per *eating day*, not per calendar day: a ledger built from
receipts knows nothing about the days you cooked, and averaging those in as
zeroes would invent a diet rather than report one. Any total on the Food screen
carries its coverage beside it, because the same average over 40% of your meals
and over 95% of them are different claims.

#### On the Food screen

The Food page shows kcal per eating day and protein in its header, a calorie
figure on each meal row, and a per-serving chip on each dish card with the
provenance in its tooltip. Above the list is one chart — calories over time,
with a Day / Week / Month toggle.

The chart plots **kcal per eating day at every grain**. A week bucket is the
average of its eating days, never their sum: the grain must change the
resolution and not the units, or switching to Week silently multiplies the
y-axis by seven and the line looks like a change in how someone eats. The
tooltip carries how many eating days a bucket was built from, because a week
averaged over two days is a much weaker claim than one averaged over seven.

Everything calorie-related is hidden until the dictionary can answer. An empty
chart claims the data exists and is flat; no chart claims nothing.

Nothing here writes back to `events`. The rollup is computed at read time, so
correcting one dish row re-values the entire history at once and leaves no
stale copies — the same reason the meal label is derived rather than stored.

The Food screen mirrors the SQL rollup in `src/ledger/nutrition.js`, the same
twinning `normalizeName()` has and for the same reason: the screen loads every
food event once and filters by period in memory, so asking the database to
re-roll on each range change would trade that away for nothing. **Change one,
change both.**

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
| `food_upsert_item(user_id, payload)` | The single write path for a dish. Rank-guarded; never demotes. |
| `food_match_item(name, threshold)` | The reference engine's candidate list. Judgement stays in JS. |
| `food_pending_items(limit)` | Dish names with no nutrition, most-eaten first. |
| `food_event_nutrition(from, to)` | Per-meal rollup with its `basis`. |
| `food_coverage()` | How much of the ledger the dictionary can answer. |

All are `SECURITY INVOKER`, so RLS enforces ownership for a signed-in caller.
The jobs use the service role, which bypasses RLS — so those functions take an
explicit `p_user_id` and check `ledger_can_act_as()` rather than trusting it.

### Hermes

Hermes reaches the ledger as an MCP server, so every tool below is a native
tool in its list, with its schema — not a skill it has to notice, load and
turn into a shell command. That distinction is the difference between
"Weighed 87.4" being written and being "Noted".

```bash
npm run -s ledger:mcp                         # the MCP server, stdio, one JSON-RPC message per line
```

Registered in `~/.hermes/config.yaml` under `mcp_servers.ledger`; the tools
appear as `mcp__ledger__log_meal` and so on. `ledger/mcp.js` is a thin
adapter over `TOOLS` in `ledger/tools.js`: write tools return a receipt (the
event minus its sources and audit trail), read tools return the data as is.

The CLI form still exists for a person at a terminal:

```bash
node ledger/cli.js tool                       # list the tools
node ledger/cli.js tool search_events '{"query":"amazon","date_range":"last 30 days"}'
node ledger/cli.js tool create_event  '{"natural_language":"dinner at Nagarjuna last night, 1250"}'
node ledger/cli.js tool log_meal      '{"natural_language":"2 packets maggi with 3 cheese slices"}'
node ledger/cli.js tool get_stats     '{"date_range":"this month"}'
```

#### A logged meal is priced as it is logged

`log_meal` and `add_meal_items` do three things the CLI never used to: snap each
dish name to the dictionary's spelling through the same trigram-plus-token rule
the resolver uses (so "Cheese Slice" joins "Cheese Slices" and inherits its
calories), ask the resolver — with a one-call budget — about any dish that is
still new, and read the meal back. The receipt carries a `nutrition` block:
`kcal`, `protein_g`, `basis` and `dishes_priced`, so the assistant can answer
"logged, ~510 kcal" in one breath. When `basis` is `none` the honest answer is
"logged, calories pending". The `dev.aadityavs.ledger.nutrition` launchd job
(09:20 and 23:45) prices what email brought in and anything inline pricing
could not settle.

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

Four of these are about food specifically:

| Tool | For |
| --- | --- |
| `lookup_barcode` | The user reads out or photographs a barcode. Resolves it against Open Food Facts, remembers the product, and optionally logs it as eaten. |
| `get_nutrition` | "How many calories did I have today?" Totals for a period, at `total`/`day`/`week`/`month` grain, always with coverage attached. |
| `set_food_nutrition` | The user reads the panel off a packet, or disputes a number. Writes `manual` + `verified`, which outranks every estimate permanently and applies retroactively. |
| `list_unresolved_foods` | What has no nutrition yet, most-eaten first — so Hermes can ask about the handful that would improve coverage most. |
| `log_measurement` | A body reading — weight, waist, body fat. One per metric per day; a same-day repeat is a correction (via `ledger_update_event`, audited), never a duplicate. Bounds-checked so "884" can never become a weight. |
| `log_activity` | A workout, run, walk or sport. Stated facts (what, how long, how far) land in `data`; an estimated calorie burn, if any, lands in `inference` — the user said what they did, not what it burned. |

**A barcode is a key, not a search.** `lookup_barcode` hits Open Food Facts'
product endpoint with an exact identifier, so there is no candidate list, no
similarity score and no `judge()` step — the EAN either identifies a product with
a printed label or it does not. That is why it is trusted at 0.95 confidence when
the text-search rung tops out at 0.85. A barcode OFF does not have returns a
`not_found` with a next step (ask for the label and call `set_food_nutrition`),
not an error.

`lookup_barcode` defaults to **not** logging the item as eaten. Scanning a packet
in a shop is not eating it, and a tool that quietly adds 500 kcal to today
because someone was curious about a label would be worse than no tool.

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
