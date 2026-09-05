#!/usr/bin/env node
// ======================================================
// The ledger as an MCP server.
//
// Hermes used to reach the ledger through a skill: a markdown file it had to
// notice, load, read, and then turn into a shell command with escaped JSON.
// On a cheap model that chain broke at the first link most mornings — "Weighed
// 87.4" got "Noted" and nothing was written. This file removes the chain:
// every tool in tools.js is offered to the model directly, with its schema,
// as a native tool it can call in one step.
//
//   node --env-file-if-exists=.env --env-file-if-exists=.env.ledger ledger/mcp.js
//
// Speaks MCP over stdio: one JSON-RPC message per line, nothing else on
// stdout. Anything the ledger prints goes to stderr so it cannot corrupt the
// protocol stream.
// ======================================================

import { createInterface } from 'node:readline';
import { TOOLS, runTool } from './tools.js';

const VERSION = '1.0.0';
const PROTOCOL = '2025-06-18';

// Nothing but protocol on stdout.
for (const level of ['log', 'info', 'debug', 'warn']) {
  console[level] = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
}

const READ_ONLY = new Set([
  'search_events', 'get_event', 'get_nutrition', 'list_unresolved_foods',
  'get_daily_summary', 'get_period_summary', 'get_entity', 'search_entity_events',
  'search_entities', 'get_stats', 'get_review_queue', 'export_ledger',
]);

// A write returns the whole event, including every source and the audit
// trail. The model only needs enough to confirm in one line.
const RECEIPT_KEYS = ['id', 'type', 'subtype', 'title', 'occurred_at', 'status', 'data', 'inference', 'entities', 'merged', 'deduplicated', 'created', 'updated'];
function receipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.event && typeof value.event === 'object') {
    return { ...value, event: receipt(value.event) };
  }
  if (!('id' in value && 'type' in value && 'title' in value)) return value;
  const out = {};
  for (const key of RECEIPT_KEYS) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

function toolList() {
  return Object.entries(TOOLS).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: spec.parameters || { type: 'object', properties: {} },
    annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: name === 'delete_or_dismiss_event' || name === 'merge_events' },
  }));
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }); }

async function callTool(params) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (!name || !TOOLS[name]) {
    return { content: [{ type: 'text', text: `Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}` }], isError: true };
  }
  try {
    const result = await runTool(name, args);
    const body = READ_ONLY.has(name) ? result : receipt(result);
    return { content: [{ type: 'text', text: JSON.stringify(body ?? null) }], isError: false };
  } catch (err) {
    return { content: [{ type: 'text', text: `${name} failed: ${err.message}` }], isError: true };
  }
}

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ledger', version: VERSION },
        instructions:
          'The record of what the user did: meals, weight, workouts, purchases, travel, meetings. '
          + 'When the user states a fact about food, drink, body, exercise or spend, write it in the same turn: '
          + 'log_meal, log_measurement, log_activity, or create_event. Read before answering questions about '
          + 'spend, calories or history: get_stats, get_nutrition, search_events.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: toolList() });
    case 'tools/call':
      return reply(id, await callTool(params));
    default:
      if (isNotification) return;
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

// Exit when the client hangs up — but only after every request already in
// flight has been answered, or a slow read would be cut off mid-flight.
let inFlight = 0;
let closing = false;
function maybeExit() { if (closing && inFlight === 0) process.exit(0); }

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { return fail(null, -32700, 'Parse error'); }
  inFlight++;
  handle(message)
    .catch((err) => {
      if (message.id !== undefined && message.id !== null) fail(message.id, -32603, err.message);
      else console.warn(`mcp: ${err.message}`);
    })
    .finally(() => { inFlight--; maybeExit(); });
});
rl.on('close', () => { closing = true; maybeExit(); });
