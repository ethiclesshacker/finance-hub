// ======================================================
// Pure helpers for the Health screen. No DOM, no network — so they run under
// `node --test` exactly as they run in the browser.
// ======================================================

export { shiftISO } from '../ledger/dates.js';

// Own tables rather than toLocaleDateString: ICU versions disagree ("Sep" vs
// "Sept" for en-GB), and an axis label should not change with the browser.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "14 Sep" — short enough for an axis tick. */
export function shortDay(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "Mon 14 Sep" — for a tooltip title, where the weekday earns its space. */
export function longDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** 5.07 → "5h 4m". Null in, em dash out. */
export function formatHours(hours) {
  if (hours === null || hours === undefined || Number.isNaN(Number(hours))) return '—';
  const total = Math.round(Number(hours) * 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

const present = v => v !== null && v !== undefined;

/** Mean of the days that have a value. A day with no data is a gap, not a zero. */
export function meanOf(days, key) {
  const values = days.map(d => d[key]).filter(present).map(Number);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** The most recent day carrying `key`, as { day, value }, or null. */
export function latestOf(days, key) {
  for (let i = days.length - 1; i >= 0; i--) {
    if (present(days[i][key])) return { day: days[i].day, value: Number(days[i][key]) };
  }
  return null;
}

/**
 * The headline numbers for a range of overview days.
 *
 * `today` is excluded from the step and energy averages: a day still in
 * progress drags the mean down every morning and recovers every evening, which
 * reads as a trend and is not one.
 */
export function summarise(days, today) {
  const complete = days.filter(d => d.day !== today);
  const todayRow = days.find(d => d.day === today) || null;
  return {
    stepsAvg:      meanOf(complete, 'steps'),
    stepsToday:    todayRow?.steps ?? null,
    activeAvg:     meanOf(complete, 'active_kcal'),
    burnedAvg:     meanBurned(complete),
    sleepAvg:      meanOf(days, 'sleep_hours'),
    sleepLast:     latestOf(days, 'sleep_hours'),
    restingLatest: latestOf(days, 'resting_hr'),
    restingAvg:    meanOf(days, 'resting_hr'),
    hrvAvg:        meanOf(days, 'hrv_ms'),
    hrvLatest:     latestOf(days, 'hrv_ms'),
    weightLatest:  latestOf(days, 'weight_kg'),
    daysWithData:  days.filter(d => Object.keys(d).length > 1).length,
  };
}

function meanBurned(days) {
  const totals = days
    .filter(d => present(d.active_kcal) && present(d.basal_kcal))
    .map(d => Number(d.active_kcal) + Number(d.basal_kcal));
  return totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
}

/**
 * Hourly buckets from health_intraday → 24 slots, zero-filled, so the x-axis is
 * always a whole day and an empty night reads as empty rather than missing.
 */
export function fillHours(buckets) {
  const byHour = new Map((buckets || []).map(b => [Number(String(b.at).slice(0, 2)), Number(b.value) || 0]));
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2, '0')}:00`, value: byHour.get(h) || 0 }));
}
