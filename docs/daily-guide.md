# Using your ledger — a daily guide

The ledger's principle: **anything that leaves a receipt records itself.** Your
only job is the things that don't. Measured on a year of your data, email
ingestion captures ~90% of events on its own — every Swiggy order, card alert,
subscription and booking. What follows is the other 10%, and it takes about
thirty seconds a day.

## Never tell Hermes about

Anything with an email trail. Swiggy, Zomato, Domino's, Blinkit, Zepto, Amazon,
card transactions, UPI alerts, subscriptions, flight and train bookings — all
of it arrives on its own within a day. Telling Hermes creates a second copy the
deduper then has to catch. If something with a receipt seems missing, the fix
is `npm run ledger:ingest`, not typing it in.

## Every morning — one sentence

> "88.4 this morning."

Weight, right after you wake up, before anything else. This is the single
highest-value sentence in this guide: calories-in is already recorded on 82% of
your days, and a daily weight is the other half of the feedback loop that tells
you whether the 1,800 kcal target is actually working. One reading per day —
if you re-weigh, say it again and the earlier value is corrected, not
duplicated.

Occasionally, when you measure them: *"waist is 96"*, *"body fat came out 24.5"*.

## During the day — meals that leave no receipt

The ledger sees what you ordered, never what you cooked or paid cash for.
Whenever you eat something with no email behind it:

> "Had 2 aloo parathas and curd at home for breakfast."
> "Ate at the office canteen — rajma chawal."
> "Two idlis and a filter coffee at Veena Stores, paid cash, ₹90."

Dish names get snapped to spellings the ledger already knows, so "maggi" joins
every previous Maggi rather than starting a new dish, and the nutrition
dictionary prices it automatically. Mention the amount only if you actually
paid there — eating is not buying.

The same goes for eating *part* of a grocery order: buying four things from
Blinkit was one event; eating two of them on Tuesday is a different one.

## When you move

> "Gym for 45 minutes."
> "Walked 4k in Cubbon Park."
> "Badminton, an hour, pretty hard."

What you state — duration, distance, intensity — is recorded as fact. If you
ask "how much did that burn?", the estimate is stored separately as inference,
never mixed into what you said. This is currently the only calories-out signal
the ledger has.

## When something is worth remembering

> "Hit 87 on the scale — first time under 88 in a year." *(milestone)*
> "Headache all afternoon, third day running." *(health)*
> "Started reading Snow Crash." *(note)*

The bar: would you want this on the timeline when you scroll back in a year?
If yes, one sentence is enough — Hermes types and files it.

## Scanning packaged food

Reading a barcode out (or photographing it) resolves the product against its
real printed label and remembers it forever:

> "Scan this: 8901491101837."

Scanning does **not** log it as eaten — say *"and I ate the pack"* if you did.
If the barcode isn't in the database, read the per-100g panel off the packet
and Hermes records it by hand; every future receipt naming it is then priced.

## Questions worth asking

| Ask | What you get |
| --- | --- |
| "How many calories today?" | Today's total, what's left of the 1,800, always with coverage attached |
| "Protein this week?" | Per-eating-day average — your known weak spot (~41 g vs a 55–110 g want) |
| "How did last month compare to this one?" | Month buckets, kcal per eating day |
| "What did I spend on food this month?" | The money side of the same events |
| "What dishes have no nutrition yet?" | The gaps dragging coverage down, most-eaten first |
| "When did I last eat at Kapoor's?" | Any timeline question, any type |

When Hermes gives you a calorie number, the honest reading is: **it is a floor,
built from receipts and estimates.** A total over 95% of meals priced and one
over 60% are different claims — the coverage figure says which you're getting.

## Weekly, two minutes

- **The review queue** (Life → Review). Low-confidence extractions wait there;
  confirm or dismiss a few. It currently holds a long backlog — burn it down in
  batches, newest first.
- **Missing baskets** (Food → the "Missing" chip). Meals that arrived as bare
  card alerts — a table bill, a cash payment. Fill in what was on the plate;
  each one you fill raises the calorie coverage.
- **Disputed numbers.** If a dish's calories look wrong on a card, tell Hermes:
  *"Kapoor's mini thali is more like 600."* A correction is marked verified,
  outranks every estimate permanently, and re-values every meal that ever
  contained the dish.

## The loop this all serves

You're going from 90 to 75 kg. The ledger's version of that project:

1. **Calories in** — automatic, 82% of days, ~1,900 kcal/eating-day lately.
2. **The target** — 1,800 kcal/day (Settings → Food). Red points on the curve
   are days over it.
3. **Weight** — yours to say, one sentence each morning.
4. **Movement** — yours to say, when it happens.

Give it four to six weeks of morning weights and the chart answers the only
question that matters: is the line going down at about half a kilo a week? If
it isn't, the target moves — and that's a settings change, not a diet crisis.
