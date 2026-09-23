// ======================================================
// Dates and clocks, in the user's zone.
//
// Pure and dependency-free, so the browser, the jobs and the tests all import
// the same file. Before this existed, "midnight of this date in this zone"
// was written out seven times across the core, the tools and the views, and
// each copy was one DST edge or one half-hour offset away from disagreeing
// with the others. A timeline that says 00:00 for a dinner is the kind of bug
// that comes from two of them drifting apart.
//
// Two shapes run through here and are never mixed up:
//
//   an instant   — an ISO string or a Date; the same moment everywhere
//   a local day  — a YYYY-MM-DD string, meaningful only in a named zone
//
// Nothing here guesses a zone. Every function that needs one takes it, and
// falls back to DEFAULT_TIME_ZONE only because this is a ledger of one
// person's life and that person lives in one place.
// ======================================================

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** Split YYYY-MM-DD into numbers. */
function ymd(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return [y, m, d];
}

/** A UTC Date → YYYY-MM-DD. */
function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

/** The wall clock in `timeZone` at an instant, as the parts Intl reports. */
function wallParts(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: +parts.year, month: +parts.month - 1, day: +parts.day,
    // Some ICU builds print midnight as "24" under h23; keep it on the clock.
    hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second,
  };
}

/** How far ahead of UTC `timeZone` is at an instant, in milliseconds. */
export function zoneOffsetMs(utcMs, timeZone = DEFAULT_TIME_ZONE) {
  const p = wallParts(new Date(utcMs), timeZone);
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - utcMs;
}

/**
 * Build an ISO instant from date/time parts in a named IANA zone. `month` is
 * zero-based, as in Date.UTC.
 *
 * Doing this without a date library means going through the zone twice: format
 * a guess in the target zone, measure how far off it landed, and correct. That
 * is exact for every offset, including the half-hour ones this app lives in.
 */
export function zonedISO({ year, month, day, hour = 0, minute = 0 }, timeZone = DEFAULT_TIME_ZONE) {
  const guess = Date.UTC(year, month, day, hour, minute, 0);
  const offset = zoneOffsetMs(guess, timeZone);
  const corrected = guess - offset;
  // A second pass catches a DST boundary falling between the two instants.
  const offset2 = zoneOffsetMs(corrected, timeZone);
  return new Date(guess - offset2).toISOString();
}

/** The calendar date an instant falls on, in the user's zone. */
export function localDateISO(instant, timeZone = DEFAULT_TIME_ZONE) {
  const p = wallParts(instant, timeZone);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Midnight at the start of a local day, as an instant. */
export function dayStartISO(isoDate, timeZone = DEFAULT_TIME_ZONE) {
  const [year, m, day] = ymd(isoDate);
  return zonedISO({ year, month: m - 1, day }, timeZone);
}

/** Shift a YYYY-MM-DD by whole days, in UTC so DST cannot move it. */
export function shiftISO(isoDate, days) {
  const [y, m, d] = ymd(isoDate);
  return toISODate(new Date(Date.UTC(y, m - 1, d + days)));
}

/**
 * The local date `days` away from an instant, as { year, month, day } with a
 * zero-based month — the shape zonedISO() takes back.
 */
export function shiftLocalDate(instant, days, timeZone = DEFAULT_TIME_ZONE) {
  const [year, month, day] = ymd(localDateISO(instant, timeZone));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/** The Monday of the ISO week a local date falls in. */
export function startOfWeek(isoDate) {
  const [y, m, d] = ymd(isoDate);
  const offset = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;   // ISO: Monday = 0
  return shiftISO(isoDate, -offset);
}

/** The wall clock where the user is, so "now" means now to them. */
export function localClock(instant, timeZone = DEFAULT_TIME_ZONE) {
  const p = wallParts(instant, timeZone);
  return { hour: p.hour, minute: p.minute, second: p.second };
}

/** "13:45" — an instant's clock time in the user's zone. */
export function formatTime(iso, timeZone = DEFAULT_TIME_ZONE) {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
  });
}

/**
 * "Sat, 22 Aug 2026" — a local day as a heading. The date is built in UTC and
 * formatted in UTC, so no zone can shift it onto the neighbouring day.
 *
 *   { year: false }  drops the year, for a list that is all one year
 *   { long: true }   "Saturday, 22 August 2026", for a summary's label
 */
export function formatDayHeading(day, { year = true, long = false } = {}) {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short',
    ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
}

/**
 * A datetime-local value for an instant, in the browser's own zone. That is
 * the zone the input will read the value back in, which is why this is the
 * one function here that deliberately takes none.
 */
export function toLocalInput(iso) {
  const date = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "5m ago", "3h ago", "2d ago" — how long since an instant. */
export function relativeTime(iso, now = Date.now()) {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  return minutes < 60 ? `${minutes}m ago`
       : minutes < 1440 ? `${Math.round(minutes / 60)}h ago`
       : `${Math.round(minutes / 1440)}d ago`;
}
