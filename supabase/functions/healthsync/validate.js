// Shape and size checks for a HealthSync upload.
//
// Plain JS with no imports, on purpose: the Edge Function (Deno) and the test
// suite (node --test) both load this exact file, so what is tested is what runs.
//
// The database function trusts types and enforces identity. This file is the
// other half: nothing reaches the database unless every number is finite, every
// date parses, and the whole thing is small enough to be one transaction.

export const LIMITS = Object.freeze({
  bodyBytes: 8 * 1024 * 1024,
  records: 5000,        // metrics + workouts + deletions, per batch
  idLength: 256,
  textLength: 256,
  metadataKeys: 64,
  metadataBytes: 8 * 1024,
});

export class ValidationError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(path, why) {
  throw new ValidationError(`${path}: ${why}`);
}

function text(value, path, { max = LIMITS.textLength, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail(path, 'required');
  }
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  if (value.length > max) fail(path, `longer than ${max} characters`);
  return value;
}

function number(value, path, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail(path, 'required');
  }
  // Number.isFinite, not a Number() coercion: upstream coerced, which turned
  // NaN into JSON null and then into a NOT NULL violation halfway through a write.
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  return value;
}

function instant(value, path) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(path, 'must be an ISO-8601 timestamp');
  return value;
}

function metadata(value, path) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const keys = Object.keys(value);
  if (keys.length > LIMITS.metadataKeys) fail(path, `more than ${LIMITS.metadataKeys} keys`);
  const out = {};
  for (const key of keys) {
    const v = value[key];
    // The app sends [String: String]. Anything else is dropped, not rejected:
    // losing one odd metadata value is better than losing the sample.
    if (typeof v === 'string') out[key] = v;
  }
  if (JSON.stringify(out).length > LIMITS.metadataBytes) fail(path, 'too large');
  return out;
}

function span(record, path) {
  const start = instant(record.start_at, `${path}.start_at`);
  const end = instant(record.end_at, `${path}.end_at`);
  if (Date.parse(end) < Date.parse(start)) fail(path, 'end_at is before start_at');
  return { start_at: start, end_at: end };
}

function list(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value;
}

function object(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}

/**
 * Returns a clean copy of the payload containing only known fields, or throws
 * ValidationError naming the first thing wrong with it.
 */
export function validatePayload(input) {
  const p = object(input, 'payload');

  const metrics = list(p.metrics, 'metrics');
  const workouts = list(p.workouts, 'workouts');
  const deletions = list(p.deletions, 'deletions');
  const total = metrics.length + workouts.length + deletions.length;
  if (total > LIMITS.records) fail('payload', `${total} records exceeds the limit of ${LIMITS.records}`);

  const exportId = text(p.export_id, 'export_id');
  if (!UUID.test(exportId)) fail('export_id', 'must be a UUID');

  const range = object(p.date_range, 'date_range');

  return {
    device_id: text(p.device_id, 'device_id'),
    export_id: exportId.toLowerCase(),
    generated_at: instant(p.generated_at, 'generated_at'),
    timezone: text(p.timezone, 'timezone', { max: 64 }),
    source: text(p.source, 'source', { optional: true }),
    schema_version: number(p.schema_version, 'schema_version'),
    date_range: {
      start: instant(range.start, 'date_range.start'),
      end: instant(range.end, 'date_range.end'),
    },
    metrics: metrics.map((raw, i) => {
      const path = `metrics[${i}]`;
      const m = object(raw, path);
      return {
        id: text(m.id, `${path}.id`, { max: LIMITS.idLength }),
        type: text(m.type, `${path}.type`),
        value: number(m.value, `${path}.value`),
        unit: text(m.unit, `${path}.unit`),
        ...span(m, path),
        source_name: text(m.source_name, `${path}.source_name`),
        source_bundle_id: text(m.source_bundle_id, `${path}.source_bundle_id`, { optional: true }),
        metadata: metadata(m.metadata, `${path}.metadata`),
      };
    }),
    workouts: workouts.map((raw, i) => {
      const path = `workouts[${i}]`;
      const w = object(raw, path);
      return {
        id: text(w.id, `${path}.id`, { max: LIMITS.idLength }),
        activity_type: text(w.activity_type, `${path}.activity_type`),
        ...span(w, path),
        duration_seconds: number(w.duration_seconds, `${path}.duration_seconds`),
        total_energy_kcal: number(w.total_energy_kcal, `${path}.total_energy_kcal`, { optional: true }),
        active_energy_kcal: number(w.active_energy_kcal, `${path}.active_energy_kcal`, { optional: true }),
        distance_meters: number(w.distance_meters, `${path}.distance_meters`, { optional: true }),
        source_name: text(w.source_name, `${path}.source_name`),
        source_bundle_id: text(w.source_bundle_id, `${path}.source_bundle_id`, { optional: true }),
        metadata: metadata(w.metadata, `${path}.metadata`),
      };
    }),
    deletions: deletions.map((raw, i) => {
      const path = `deletions[${i}]`;
      const d = object(raw, path);
      if (d.kind !== 'metric' && d.kind !== 'workout') fail(`${path}.kind`, "must be 'metric' or 'workout'");
      return { id: text(d.id, `${path}.id`, { max: LIMITS.idLength }), kind: d.kind };
    }),
  };
}

/** `Authorization: Bearer <token>` → token, or null. */
export function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * The function is reachable as /functions/v1/healthsync/... in production and
 * /healthsync/... under `supabase functions serve`. Returns the part after.
 */
export function routePath(pathname) {
  for (const prefix of ['/functions/v1/healthsync', '/healthsync']) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      return pathname.slice(prefix.length) || '/';
    }
  }
  return pathname;
}
