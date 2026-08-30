// ======================================================
// Line items — what was actually in the order.
//
// An amount tells you a meal cost ₹149. It does not tell you that it was
// rajma chawal. The delivery platforms all print the basket in the plain-text
// body of their receipt, so reading it costs nothing: no model call, no PDF,
// no extra request. Against a year of real mail (353 order emails from Zomato,
// Swiggy, Instamart and Domino's) every one of them yielded its items.
//
// Each platform lays the basket out differently, and two of them have changed
// layout inside the last year while keeping the same subject line — so the
// parsers are keyed on the *shape of the body*, and a vendor that no longer
// matches returns nothing rather than guessing. A wrong item list is worse
// than none: it would be summed, searched and remembered as a thing you ate.
//
// Pure and synchronous, like the rest of the extraction core. Imported by the
// email rules, the browser and the tests.
// ======================================================

const MAX_ITEMS = 40;
const MAX_NAME = 120;

const clean = s => String(s ?? '').replace(/[ ​]/g, ' ').replace(/\s+/g, ' ').trim();
const toLines = text => String(text || '').split('\n').map(clean).filter(Boolean);

/** A line that is nothing but money: "₹195", "Rs.66.66", "195.00". */
function bareAmount(line) {
  const m = clean(line).match(/^(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)$/i);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function makeItem(name, qty, amount, options) {
  const label = clean(name).slice(0, MAX_NAME);
  if (!label) return null;
  const out = { name: label, qty: Number.isFinite(qty) && qty > 0 ? qty : 1 };
  if (Number.isFinite(amount)) out.amount = amount;
  const extras = (options || []).map(clean).filter(o => o && o !== '|');
  if (extras.length) out.options = extras.join(', ').slice(0, MAX_NAME);
  return out;
}

// ── Zomato ─────────────────────────────────────────────
//
// "1 X Cheese Masala Dosa", one line per item, between the restaurant address
// and "Total paid - ₹87.93". Names only — Zomato puts the per-item price in
// the attached tax invoice, not in the mail.
function zomatoItems(text) {
  const out = [];
  for (const line of toLines(text)) {
    if (/^total paid/i.test(line)) break;
    const m = line.match(/^(\d{1,2})\s*X\s+(.+)$/i);
    if (!m) continue;
    const entry = makeItem(m[2], Number(m[1]));
    if (entry) out.push(entry);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ── Swiggy, 2026 layout ────────────────────────────────
//
// A BILL DETAILS block where an item is "<name> x1" with the amount on the
// next line, and the charges below it are worded the same way but never carry
// a quantity. Customisations arrive as their own line — "With Aloo Jeera (₹0)"
// — and belong to the item above them.
const SWIGGY_CHARGE = new RegExp([
  'restaurant packaging', 'packaging', 'platform fee', 'delivery (fee|partner fee)',
  'taxes?', 'gst', 'discount', 'item total', 'order total', 'to pay', 'grand total',
  'tip', 'donation', 'handling', 'convenience', 'paid via', 'free',
].map(w => `^${w}\\b`).join('|'), 'i');

function swiggyBillItems(lines, start) {
  const out = [];
  for (let i = start; i < lines.length && out.length < MAX_ITEMS; i++) {
    const line = lines[i];
    if (/^(paid via|disclaimer|get the swiggy app|follow us)/i.test(line)) break;

    const m = line.match(/^(.+?)\s+x\s*(\d{1,2})$/i);
    if (!m || SWIGGY_CHARGE.test(m[1])) continue;

    // The amount sits on the next line; the customisations, when there are
    // any, come after it. Scanning from the amount finds nothing at all.
    const amount = bareAmount(lines[i + 1]);
    const options = [];
    for (let j = i + (amount === null ? 1 : 2); j < lines.length && /^(with|\()/i.test(lines[j]); j++) {
      options.push(lines[j]);
    }

    const entry = makeItem(m[1], Number(m[2]), amount, options);
    if (entry) out.push(entry);
  }
  return out;
}

// ── Swiggy, older layout, and Swiggy Gourmet ───────────
//
// An "Item Name / Quantity / Price" table flattened to one cell per line. Both
// layouts still arrive under the same subject, so the parser picks by what the
// body contains rather than by what the subject says.
function swiggyTableItems(lines) {
  const start = lines.findIndex(l => /^item name$/i.test(l));
  if (start < 0) return [];

  const out = [];
  for (let i = start + 3; i + 2 < lines.length && out.length < MAX_ITEMS; i += 3) {
    // The table ends at the totals, which break the name/qty/price rhythm.
    if (!/^\d{1,2}$/.test(lines[i + 1])) break;
    const entry = makeItem(lines[i], Number(lines[i + 1]), bareAmount(lines[i + 2]));
    if (!entry) break;
    out.push(entry);
  }
  return out;
}

// ── Instamart ──────────────────────────────────────────
//
// "1 x Lay's Potato Chips - American Style ₹20.00" under "Order Items", down
// to "Order Summary". Quantity, name and price all on one line.
function instamartItems(lines) {
  const start = lines.findIndex(l => /^order items/i.test(l));
  if (start < 0) return [];

  const out = [];
  for (let i = start + 1; i < lines.length && out.length < MAX_ITEMS; i++) {
    if (/^order summary/i.test(lines[i])) break;
    const m = lines[i].match(/^(\d{1,2})\s*x\s*(.+?)\s*₹\s*([\d,]+(?:\.\d{1,2})?)$/i);
    if (!m) continue;
    const entry = makeItem(m[2], Number(m[1]), Number(m[3].replace(/,/g, '')));
    if (entry) out.push(entry);
  }
  return out;
}

// ── Domino's ───────────────────────────────────────────
//
// An Items/Qty/Price table where one pizza spans four lines: the name, its
// crust and size ("Regular | Cheese Burst"), the quantity, then the price. The
// quantity is the only line that is a bare integer, which is what separates
// one item from the next.
function dominosItems(lines) {
  const start = lines.findIndex(l => /^items$/i.test(l));
  if (start < 0) return [];

  const out = [];
  let pending = [];
  for (let i = start + 1; i < lines.length && out.length < MAX_ITEMS; i++) {
    const line = lines[i];
    if (/^(sub total|grand total|taxes)/i.test(line)) break;
    if (/^(qty|price)$/i.test(line)) continue;

    if (/^\d{1,2}$/.test(line) && pending.length) {
      const entry = makeItem(pending[0], Number(line), bareAmount(lines[i + 1]), pending.slice(1));
      if (entry) out.push(entry);
      pending = [];
      i++; // the price line belongs to the item just emitted
      continue;
    }
    pending.push(line);
  }
  return out;
}

// ── Who sent it, and what the order was ────────────────

/** The line after a label, which is how these templates render a heading. */
function lineAfter(lines, pattern) {
  const i = lines.findIndex(l => pattern.test(l));
  return i >= 0 && lines[i + 1] ? lines[i + 1] : null;
}

/**
 * Read an order email's basket.
 *
 * Returns `{ vendor, kind, restaurant, items }`, or null when the message is
 * not one of these platforms' order receipts. `restaurant` is the place the
 * food came from — Zomato and Swiggy are how it got here, not who cooked it,
 * and conflating the two makes the delivery app the biggest restaurant in the
 * ledger.
 *
 * `kind` is `groceries` for a store order and `food_delivery` for a meal.
 * Instamart is a Swiggy address with a Swiggy sender name, so the only thing
 * that distinguishes a grocery run from a dinner is the subject.
 */
export function parseOrderItems(message) {
  const address = (message?.from?.address || '').toLowerCase();
  const subject = clean(message?.subject);
  const text = message?.text || '';
  const lines = toLines(text);

  if (/zomato\.com$/.test(address) && /order from/i.test(subject)) {
    return {
      vendor: 'Zomato', kind: 'food_delivery',
      // The subject names the restaurant more reliably than the body, which
      // says "Thank you for ordering from X" in one template and "Your order
      // from X was delivered in just 17 minutes" in another.
      restaurant: clean(subject.replace(/^.*order from\s*/i, '')) || null,
      items: zomatoItems(text),
    };
  }

  if (/swiggy\.in$/.test(address)) {
    if (/instamart/i.test(subject)) {
      return { vendor: 'Instamart', kind: 'groceries', restaurant: null, items: instamartItems(lines) };
    }
    if (/dineout/i.test(subject) || /dineout/i.test(text.slice(0, 400))) {
      // An offline bill paid through the app: a real restaurant, no basket.
      const paidTo = text.match(/paid to:\s*([^,\n]{2,60})/i);
      return { vendor: 'Swiggy Dineout', kind: 'dineout', restaurant: paidTo ? clean(paidTo[1]) : null, items: [] };
    }
    if (/\border\b/i.test(subject)) {
      const bill = lines.findIndex(l => /^bill details$/i.test(l));
      return {
        vendor: /gourmet/i.test(subject) ? 'Swiggy Gourmet' : 'Swiggy',
        kind: 'food_delivery',
        restaurant: lineAfter(lines, /^order journey$/i)
                 || lineAfter(lines, /^ordered from:?$/i)
                 || lineAfter(lines, /^restaurant:?$/i),
        items: bill >= 0 ? swiggyBillItems(lines, bill + 1) : swiggyTableItems(lines),
      };
    }
    return null;
  }

  if (/dominos\.co\.in$/.test(address) && /order/i.test(subject)) {
    return { vendor: "Domino's", kind: 'food_delivery', restaurant: "Domino's", items: dominosItems(lines) };
  }

  return null;
}

/**
 * A dish name as it should be stored: "cheese slices" → "Cheese Slices".
 *
 * Words that already carry a capital are left alone, so "McPuff" and "IDLI"
 * survive. Casing is not cosmetic here — the Dishes ranking groups by name,
 * and "maggi" beside "Maggi" is one dish counted twice.
 */
export function dishName(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
    .split(' ')
    .map(word => (/[A-Z]/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
    .slice(0, MAX_NAME);
}

/**
 * The basket as one line of prose, for a title or a summary.
 *
 * Two names is the most that reads at a glance in a timeline row; beyond that
 * the count carries more than a truncated third dish would.
 */
export function summariseItems(items, limit = 2) {
  const list = (items || []).filter(i => i?.name);
  if (!list.length) return null;

  const shown = list.slice(0, limit).map(i => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name));
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}
