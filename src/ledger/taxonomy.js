// ======================================================
// Event taxonomy.
//
// The database treats `type` as open text and registers anything it has not
// seen before (see ledger_event_types in 0003), so this file is a catalogue for
// labelling and filtering — not a gate. A connector that invents
// `type: 'concert'` will store fine; it just shows up unlabelled until someone
// adds it here.
//
// Everything in this module is pure. It is imported by the browser bundle, by
// the ingestion jobs under ledger/, and by the tests.
// ======================================================

export const EVENT_TYPES = [
  { id: 'activity',      label: 'Activity',      icon: 'fa-person-walking',  color: '#38bdf8' },
  { id: 'purchase',      label: 'Purchase',      icon: 'fa-bag-shopping',    color: '#a78bfa' },
  { id: 'food',          label: 'Food',          icon: 'fa-utensils',        color: '#fb923c' },
  { id: 'travel',        label: 'Travel',        icon: 'fa-plane',           color: '#2dd4bf' },
  { id: 'work',          label: 'Work',          icon: 'fa-briefcase',       color: '#94a3b8' },
  { id: 'meeting',       label: 'Meeting',       icon: 'fa-users',           color: '#38bdf8' },
  { id: 'communication', label: 'Communication', icon: 'fa-comments',        color: '#94a3b8' },
  { id: 'health',        label: 'Health',        icon: 'fa-heart-pulse',     color: '#f472b6' },
  { id: 'entertainment', label: 'Entertainment', icon: 'fa-film',            color: '#a78bfa' },
  { id: 'subscription',  label: 'Subscription',  icon: 'fa-arrows-rotate',   color: '#f59e0b' },
  { id: 'delivery',      label: 'Delivery',      icon: 'fa-truck',           color: '#f59e0b' },
  { id: 'appointment',   label: 'Appointment',   icon: 'fa-calendar-check',  color: '#38bdf8' },
  { id: 'note',          label: 'Note',          icon: 'fa-note-sticky',     color: '#94a3b8' },
  { id: 'task',          label: 'Task',          icon: 'fa-circle-check',    color: '#10b981' },
  { id: 'milestone',     label: 'Milestone',     icon: 'fa-flag',            color: '#10b981' },
  { id: 'location',      label: 'Location',      icon: 'fa-location-dot',    color: '#2dd4bf' },
  // Money moving without anything being bought: refunds, credits, salary, a
  // card bill being paid. Separate from `purchase` so that every "what did I
  // spend" answer is correct without having to remember to exclude them.
  { id: 'transfer',      label: 'Transfer',      icon: 'fa-right-left',      color: '#10b981' },
  { id: 'other',         label: 'Other',         icon: 'fa-circle-dot',      color: '#94a3b8' },
];

const TYPE_INDEX = Object.fromEntries(EVENT_TYPES.map(t => [t.id, t]));

export function typeMeta(id) {
  return TYPE_INDEX[id] || { id, label: titleCase(id), icon: 'fa-circle-dot', color: '#94a3b8' };
}

/** Known subtypes per type. Advisory: any snake_case string is accepted. */
export const SUBTYPES = {
  purchase:      ['amazon_order', 'restaurant_payment', 'grocery_purchase', 'electronics',
                  'clothing', 'subscription_payment', 'fuel', 'pharmacy', 'card_transaction', 'refund'],
  travel:        ['flight', 'train', 'bus', 'hotel', 'cab', 'trip', 'toll'],
  food:          ['restaurant', 'food_delivery', 'meal', 'snack', 'beverage', 'groceries'],
  work:          ['meeting', 'school_visit', 'project_activity', 'work_email', 'work_task', 'deadline'],
  meeting:       ['calendar_event', 'call', 'one_on_one', 'interview'],
  delivery:      ['package', 'order_shipped', 'order_delivered'],
  subscription:  ['renewal', 'signup', 'cancellation', 'trial'],
  health:        ['appointment', 'workout', 'medication', 'measurement'],
  communication: ['email', 'message', 'call'],
  entertainment: ['movie', 'concert', 'streaming', 'game', 'book'],
  appointment:   ['medical', 'personal', 'service'],
  note:          ['observation', 'idea', 'reminder'],
  milestone:     ['personal', 'work', 'financial'],
  location:      ['visit', 'checkin'],
  transfer:      ['refund', 'credit', 'salary', 'card_payment', 'self_transfer', 'cashback'],
};

// The four states an event can be in, plus `scheduled` for things that are on
// the calendar but have not happened yet — a calendar entry is evidence of an
// intention, not of an event.
export const STATUSES = [
  { id: 'confirmed',    label: 'Confirmed',    badge: 'badge-green',  hint: 'Stated by a source we trust, or entered by you.' },
  { id: 'inferred',     label: 'Inferred',     badge: 'badge-blue',   hint: 'Extracted with reasonable but not certain confidence.' },
  { id: 'scheduled',    label: 'Scheduled',    badge: 'badge-purple', hint: 'Planned. Not yet reconciled against evidence that it happened.' },
  { id: 'needs_review', label: 'Needs review', badge: 'badge-yellow', hint: 'Low confidence — confirm, correct, merge or dismiss it.' },
  { id: 'dismissed',    label: 'Dismissed',    badge: 'badge-gray',   hint: 'Not a real event. Kept so it is not re-created.' },
];

const STATUS_INDEX = Object.fromEntries(STATUSES.map(s => [s.id, s]));
export function statusMeta(id) {
  return STATUS_INDEX[id] || { id, label: titleCase(id || 'unknown'), badge: 'badge-gray', hint: '' };
}

export const SOURCE_TYPES = [
  { id: 'email',    label: 'Email',    icon: 'fa-envelope' },
  { id: 'calendar', label: 'Calendar', icon: 'fa-calendar' },
  { id: 'hermes',   label: 'Hermes',   icon: 'fa-robot' },
  { id: 'manual',   label: 'Manual',   icon: 'fa-pen' },
  { id: 'card',     label: 'Card',     icon: 'fa-credit-card' },
  { id: 'health',   label: 'Health',   icon: 'fa-heart-pulse' },
  { id: 'other',    label: 'Other',    icon: 'fa-circle-dot' },
];

const SOURCE_INDEX = Object.fromEntries(SOURCE_TYPES.map(s => [s.id, s]));
export function sourceMeta(id) {
  return SOURCE_INDEX[id] || { id, label: titleCase(id || 'unknown'), icon: 'fa-circle-dot' };
}

export const ENTITY_TYPES = [
  'person', 'company', 'merchant', 'restaurant', 'place',
  'product', 'project', 'organization', 'trip', 'account', 'other',
];

/** How an entity relates to an event. Also open text in the database. */
export const RELATIONSHIPS = [
  'merchant', 'restaurant', 'person', 'attendee', 'sender', 'recipient',
  'place', 'origin', 'destination', 'project', 'product', 'provider',
  // The bank behind a card. Counted, but never credited with the spend.
  'issuer', 'related',
];

/** How two events relate. */
export const EVENT_RELATIONSHIPS = [
  'payment_for', 'order_email', 'confirms', 'part_of', 'booking_for',
  'refund_for', 'follows', 'related',
];

function titleCase(s) {
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
