// Connector registry.
//
// A connector is anything that can answer "what is new since this cursor?" and
// return messages in the shape src/ledger/email.js expects. Adding calendar,
// a card API or Apple Health later means adding a file here — the pipeline,
// deduplication, entity resolution, storage and UI stay untouched. That is the
// whole reason the ingestion layer and the event model are separate.

import { connector as imap } from './imap.js';

export const CONNECTORS = { imap };

export function getConnector(protocol) {
  const connector = CONNECTORS[protocol];
  if (!connector) {
    throw new Error(`Unknown connector "${protocol}". Available: ${Object.keys(CONNECTORS).join(', ')}`);
  }
  return connector;
}
