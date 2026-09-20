import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePayload, bearerToken, routePath, ValidationError, LIMITS,
} from '../supabase/functions/healthsync/validate.js';

const metric = (over = {}) => ({
  id: 'healthkit:0F3A', type: 'step_count', value: 120, unit: 'count',
  start_at: '2026-09-19T03:00:00.000Z', end_at: '2026-09-19T03:05:00.000Z',
  source_name: 'Watch', source_bundle_id: 'com.apple.health.x', metadata: { k: 'v' },
  ...over,
});
const workout = (over = {}) => ({
  id: 'healthkit:W1', activity_type: 'running',
  start_at: '2026-09-19T01:00:00.000Z', end_at: '2026-09-19T01:30:00.000Z',
  duration_seconds: 1800, total_energy_kcal: 300, active_energy_kcal: null,
  source_name: 'Watch', metadata: {}, ...over,
});
const payload = (over = {}) => ({
  device_id: 'dev-1', export_id: '6F9619FF-8B86-D011-B42D-00C04FC964FF',
  generated_at: '2026-09-20T10:00:00.000Z', timezone: 'Asia/Kolkata', source: 'healthkit',
  schema_version: 1,
  date_range: { start: '2026-09-20T00:00:00.000Z', end: '2026-09-20T10:00:00.000Z' },
  metrics: [metric()], workouts: [workout()], deletions: [{ id: 'healthkit:X', kind: 'metric' }],
  ...over,
});
const rejects = (input, pattern) =>
  assert.throws(() => validatePayload(input), (e) => e instanceof ValidationError && pattern.test(e.message));

test('a well-formed payload passes, and export_id is lower-cased for the uuid cast', () => {
  const out = validatePayload(payload());
  assert.equal(out.export_id, '6f9619ff-8b86-d011-b42d-00c04fc964ff');
  assert.equal(out.metrics.length, 1);
  assert.equal(out.workouts[0].active_energy_kcal, null);
  assert.equal(out.workouts[0].distance_meters, null);
});

test('unknown fields do not survive', () => {
  const out = validatePayload(payload({ evil: 1, metrics: [metric({ user_id: 'someone-else' })] }));
  assert.equal('evil' in out, false);
  assert.equal('user_id' in out.metrics[0], false);
});

test('non-finite and non-numeric values are refused, not coerced', () => {
  rejects(payload({ metrics: [metric({ value: NaN })] }), /metrics\[0\]\.value/);
  rejects(payload({ metrics: [metric({ value: Infinity })] }), /metrics\[0\]\.value/);
  rejects(payload({ metrics: [metric({ value: '120' })] }), /metrics\[0\]\.value/);
  rejects(payload({ metrics: [metric({ value: null })] }), /metrics\[0\]\.value/);
  rejects(payload({ workouts: [workout({ duration_seconds: NaN })] }), /duration_seconds/);
  rejects(payload({ workouts: [workout({ distance_meters: 'far' })] }), /distance_meters/);
});

test('dates must parse and be in order', () => {
  rejects(payload({ generated_at: 'yesterday' }), /generated_at/);
  rejects(payload({ metrics: [metric({ start_at: 12345 })] }), /start_at/);
  rejects(payload({ metrics: [metric({ end_at: '2026-09-19T02:00:00.000Z' })] }), /before start_at/);
  rejects(payload({ date_range: { start: 'x', end: 'y' } }), /date_range\.start/);
  rejects(payload({ date_range: null }), /date_range/);
});

test('export_id must be a uuid', () => {
  rejects(payload({ export_id: 'not-a-uuid' }), /export_id/);
  rejects(payload({ export_id: undefined }), /export_id/);
});

test('record count is capped across all three lists', () => {
  const many = Array.from({ length: LIMITS.records }, (_, i) => metric({ id: `healthkit:${i}` }));
  rejects(payload({ metrics: many }), /exceeds the limit/); // + 1 workout + 1 deletion
  assert.equal(validatePayload(payload({ metrics: many, workouts: [], deletions: [] })).metrics.length, LIMITS.records);
});

test('over-long strings are a 400 here, not a 500 in the database', () => {
  rejects(payload({ metrics: [metric({ id: 'x'.repeat(LIMITS.idLength + 1) })] }), /longer than/);
  rejects(payload({ metrics: [metric({ type: '' })] }), /non-empty/);
  rejects(payload({ timezone: 'z'.repeat(65) }), /timezone/);
});

test('metadata keeps strings, drops the rest, and is size-capped', () => {
  const out = validatePayload(payload({ metrics: [metric({ metadata: { a: 'ok', b: 5, c: { nested: 1 } } })] }));
  assert.deepEqual(out.metrics[0].metadata, { a: 'ok' });
  assert.deepEqual(validatePayload(payload({ metrics: [metric({ metadata: null })] })).metrics[0].metadata, {});
  rejects(payload({ metrics: [metric({ metadata: [] })] }), /metadata/);
  rejects(payload({ metrics: [metric({ metadata: { big: 'x'.repeat(LIMITS.metadataBytes) } })] }), /too large/);
  const wide = Object.fromEntries(Array.from({ length: LIMITS.metadataKeys + 1 }, (_, i) => [`k${i}`, 'v']));
  rejects(payload({ metrics: [metric({ metadata: wide })] }), /keys/);
});

test('deletions need a known kind', () => {
  rejects(payload({ deletions: [{ id: 'healthkit:X', kind: 'everything' }] }), /kind/);
  rejects(payload({ deletions: [{ kind: 'metric' }] }), /deletions\[0\]\.id/);
});

test('lists may be absent but not the wrong type', () => {
  const out = validatePayload(payload({ metrics: undefined, workouts: null, deletions: undefined }));
  assert.deepEqual([out.metrics, out.workouts, out.deletions], [[], [], []]);
  rejects(payload({ metrics: 'lots' }), /metrics/);
  rejects([], /payload/);
  rejects(null, /payload/);
});

test('bearerToken', () => {
  assert.equal(bearerToken('Bearer abc123'), 'abc123');
  assert.equal(bearerToken('  bearer   abc123 '), 'abc123');
  assert.equal(bearerToken('Basic abc123'), null);
  assert.equal(bearerToken('Bearer'), null);
  assert.equal(bearerToken('Bearer a b'), null);
  assert.equal(bearerToken(null), null);
});

test('routePath strips the gateway prefix and nothing else', () => {
  assert.equal(routePath('/functions/v1/healthsync/api/apple-health/sync'), '/api/apple-health/sync');
  assert.equal(routePath('/healthsync/api/apple-health/sync'), '/api/apple-health/sync');
  assert.equal(routePath('/healthsync'), '/');
  assert.equal(routePath('/healthsyncevil/api'), '/healthsyncevil/api');
  assert.equal(routePath('/api/apple-health/sync'), '/api/apple-health/sync');
});
