# Card points, fed by the ledger

The Points page used to be typed by hand. It was built before the event ledger
existed, so every HSBC TravelOne spend ended up stored twice: once typed, once
read from the bank's alert email. `0012_card_points.sql` joins them.

```
card alert email ─▶ ledger event (on the points card)
                         │  cc_sync_from_events()   after every ingest, and on page load
                         ▼
cc_merchant_rules ─▶ cc_transactions row, basis = assumed
  bank's name → your label, multiplier        │  Confirm, or edit (any edit confirms)
                                              ▼
                                        basis = confirmed
```

## What lives where

| Fact | Home | Notes |
|---|---|---|
| Date, amount | The ledger event | Read through the `cc_points` view. The typed copy is only a fallback for rows with no event |
| Description | The ledger event | Editable from the Points page; `cc_confirm()` writes it through. Shows in Life, search, summaries and to Hermes |
| Label, multiplier, stated points | `cc_transactions` | Yours. Never overwritten by the bank |
| Bank name → label + multiplier | `cc_merchant_rules` | The table to curate. Learned from typed rows; an edited rule becomes `manual` and is never relearned |

Always read `cc_points`, never `cc_transactions`, for date and amount.

## The rules

- **One card.** Setting `cc_points_account`, the card's last four digits. Empty by default, which switches automatic rows off. Alerts for any other card are ignored.
- **Work spend is a tick-box** (`is_work`, on the row and on the merchant rule, `0014_card_work_flag.sql`), not a label. The label says who was paid; work says why. A learned rule defaults to work only when the label nearly always was (at least three rows, four in five of them work), so a cab company or a marketplace stays personal and you tick the exception. `life_days()` reports `work_spend` and `personal_spend`. Nothing is written to the event to do this.
- **Bank wins on amount and date, you win on label, multiplier and points.** A disagreement stays visible as `amount_typed`.
- **Any save confirms.** Editing a row, or adding a note to it, is looking at it.
- **Auto-creation starts the day after the last typed row** (stored as `cc_auto_from`). Older unpaired alerts go to the Reconcile tab instead, because an old unpaired alert is as likely to be a typo on one side as a missed entry, and auto-creating it would double count.

## Notes

Every note follows one grammar, shown as the placeholder in the note box:

```
Type: detail | who | when
```

`who` and `when` are optional. Types in use: Flight, Hotel, Train, Bus, Cab,
Cargo, Food, Movie, Parking, Fuel, Subscription, Voucher, Shopping, Gift,
Souvenir, Book, Health, Vehicle, Telecom, Fee, Refund, Tax, Course, Event,
Ticket, Bonus. A small charge from a dining platform beside the meal it belongs
to reads `Fee: booking charge | <place>`.

A `| Name` tag that matches a known person, by name or alias, links them to the
event (`0015_entity_aliases.sql`). Only people who already exist are linked, so
"Apr" never becomes a person. Aliases live in `entities.metadata.aliases`;
`ledger_add_entity_aliases()` adds them and `ledger_merge_entities()` folds a
duplicate person into the right one.

## Reconcile

Three lists, each a different decision, and every decision is remembered
(`0013_card_reconcile.sql`) so a list can be emptied and stays empty.

| List | What it is | Decisions |
|---|---|---|
| Looks like a waiting card alert | A typed row with a plausible alert nearby, up to five candidates | Link, or Not a match |
| Card alerts with no row | A spend from before automatic rows | Add row, or Ignore |
| No card alert found | Typed rows with nothing plausible. Collapsed | Mark all as fine |

An action removes its own row and redraws nothing else, so the page never
jumps. The rest of the screen catches up when you leave the tab.

**Pooled rows.** A typed row that adds several alerts together ("cabs:
various") cannot link, because a link is one row to one event. Either ignore
its alerts, or replace the pooled row with the individual alert rows. Adding
the alerts *and* keeping the pooled row counts the points twice.

A points row follows an event merge: when the ledger folds a card alert into
another event, a trigger moves the link to the survivor.

## Backups taken before the change (2026-09-21)

`backup.cc_transactions_20260921` and `backup.cc_redemptions_20260921` in the
database (a schema the API does not expose), and
`~/projects/finance-hub-backups/cc-points-2026-09-21.json` locally. A second pair,
`backup.cc_transactions_20260921_pre_cleanup` and `…-pre-cleanup.json`, was taken
before pooled typed rows were replaced by their individual alert rows.
