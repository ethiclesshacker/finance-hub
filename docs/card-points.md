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
- **Work spend.** Setting `cc_work_label` (default `Work`). It is a purpose, not a merchant: a marketplace, an airline and a software subscription can all be work. Rows under it count as work, and `life_days()` reports `work_spend` and `personal_spend`. Nothing is written to the event to do this.
- **Bank wins on amount and date, you win on label, multiplier and points.** A disagreement stays visible as `amount_typed`.
- **Any save confirms.** Editing a row, or adding a note to it, is looking at it.
- **Auto-creation starts the day after the last typed row** (stored as `cc_auto_from`). Older unpaired alerts go to the Reconcile tab instead, because an old unpaired alert is as likely to be a typo on one side as a missed entry, and auto-creating it would double count.

## Not handled

A typed row that pools several alerts (one row for four cab rides)
cannot link: the link is one row to one event. Such rows stay typed, and their
alerts stay in Reconcile. Do not press "Add row" on those alerts.

## Backups taken before the change (2026-09-21)

`backup.cc_transactions_20260921` and `backup.cc_redemptions_20260921` in the
database (a schema the API does not expose), and
`~/projects/finance-hub-backups/cc-points-2026-09-21.json` locally.
