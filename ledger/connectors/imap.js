// ======================================================
// IMAP source connector.
//
// IMAP rather than the Gmail or Zoho APIs on purpose: one implementation
// covers every address you own, on any provider, with no OAuth app to
// register per vendor. The cost is that it needs an app-specific password —
// which is also its security story, since an app password is scoped to mail
// and revocable on its own.
//
// The connector is deliberately dumb. It knows how to find messages it has not
// seen and how to hand them over in a normalized shape; it knows nothing about
// events, extraction or the ledger. Another connector (calendar, a card API,
// Apple Health) only has to produce the same shape to reuse the whole pipeline
// behind it.
//
// Two properties that matter:
//   - The mailbox is opened READ-ONLY. Nothing is marked read, moved or
//     deleted. The ledger is an observer of your mail, not a participant.
//   - Envelopes are fetched before bodies, so mail that is obviously not an
//     event (newsletters, OTPs) never has its body downloaded at all.
// ======================================================

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { htmlToText, triage } from '../../src/ledger/email.js';

/**
 * Fetch messages this account has not been seen before.
 *
 * `cursor` is opaque to the pipeline: { folders: { INBOX: { uidValidity, lastUid } } }.
 * UIDVALIDITY changing means the server renumbered the mailbox, so the stored
 * UID is meaningless and the folder is re-scanned from the lookback window.
 *
 * Returns { messages, cursor, stats }. The cursor is only advanced past
 * messages actually returned, so a crash costs a re-read, never a gap.
 */
export async function fetchNew(account, cursor = {}, options = {}) {
  const maxMessages = options.maxMessages ?? 200;
  const maxBytes = options.maxMessageBytes ?? 512 * 1024;
  const lookbackDays = options.lookbackDays ?? account.lookbackDays ?? 7;
  // A backfill deliberately ignores the checkpoint and rescans a date window.
  // Safe because ingestion is idempotent: everything already stored is matched
  // by its source id or its dedupe key and updated rather than duplicated.
  const ignoreCursor = Boolean(options.ignoreCursor);

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.password },
    logger: false,
    // A stalled connection must not wedge a cron job until the next one.
    socketTimeout: options.socketTimeoutMs ?? 60_000,
  });

  const messages = [];
  const nextCursor = { folders: { ...(cursor.folders || {}) } };
  const stats = { seen: 0, skippedBySubject: 0, skippedTooLarge: 0, fetchedBodies: 0 };

  await client.connect();
  try {
    for (const folder of account.folders) {
      if (messages.length >= maxMessages) break;

      let lock;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true });
      } catch (err) {
        stats[`error:${folder}`] = err.message;
        continue;
      }

      try {
        const uidValidity = String(client.mailbox.uidValidity);
        const stored = nextCursor.folders[folder] || {};
        const resumable = !ignoreCursor
                       && stored.uidValidity === uidValidity
                       && Number.isFinite(Number(stored.lastUid));
        const lastUid = resumable ? Number(stored.lastUid) : 0;

        // Which UIDs to look at. A fresh folder (or a renumbered one) starts
        // from a date window rather than the whole mailbox — the first run
        // should populate a useful ledger, not import a decade of mail.
        let candidates = [];
        if (resumable && lastUid > 0) {
          for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, envelope: true, size: true }, { uid: true })) {
            // A range whose start is past the highest UID still returns the
            // last message, per RFC 3501. Filter it out or every run
            // re-processes the newest mail forever.
            if (msg.uid > lastUid) candidates.push(msg);
          }
        } else {
          const since = new Date(Date.now() - lookbackDays * 86_400_000);
          const uids = await client.search({ since }, { uid: true });
          if (uids?.length) {
            for await (const msg of client.fetch(uids, { uid: true, envelope: true, size: true }, { uid: true })) {
              candidates.push(msg);
            }
          }
        }

        candidates.sort((a, b) => a.uid - b.uid);
        stats.seen += candidates.length;

        // Cheap pass: reject on subject and size before downloading anything.
        const wanted = [];
        for (const candidate of candidates) {
          if (wanted.length + messages.length >= maxMessages) break;

          if (candidate.size && candidate.size > maxBytes) {
            stats.skippedTooLarge++;
            wanted.push({ uid: candidate.uid, skip: true });
            continue;
          }

          const envelopeVerdict = triage({
            subject: candidate.envelope?.subject || '',
            from: candidate.envelope?.from?.[0]
              ? { name: candidate.envelope.from[0].name, address: candidate.envelope.from[0].address }
              : null,
            headers: {},
            text: candidate.envelope?.subject || '',
            html: '',
          }, { selfAddresses: [account.user] });

          // Only a verdict reachable from the subject and sender alone skips
          // the body — an OTP, a newsletter, a campaign. Anything else is read,
          // because the body is where the evidence usually is.
          if (envelopeVerdict.decision === 'reject'
              && ['never-an-event subject', 'promotional'].includes(envelopeVerdict.reason)) {
            stats.skippedBySubject++;
            wanted.push({ uid: candidate.uid, skip: true });
            continue;
          }

          wanted.push({ uid: candidate.uid, skip: false });
        }

        const toFetch = wanted.filter(w => !w.skip).map(w => w.uid);
        const parsed = new Map();

        if (toFetch.length) {
          for await (const msg of client.fetch(toFetch, { uid: true, source: true }, { uid: true })) {
            stats.fetchedBodies++;
            try {
              parsed.set(msg.uid, await toMessage(msg, account, folder));
            } catch (err) {
              stats[`parse_error:${msg.uid}`] = err.message;
            }
          }
        }

        // Advance the cursor strictly in UID order and stop at the first
        // message that failed to parse, so nothing is silently skipped.
        let highest = lastUid;
        for (const item of wanted) {
          if (!item.skip) {
            const message = parsed.get(item.uid);
            if (!message) break;
            messages.push(message);
          }
          highest = item.uid;
        }

        // Never move the checkpoint backwards. A backfill scans old mail and
        // would otherwise rewind the cursor, making the next forward run
        // re-read everything since.
        const previous = (cursor.folders?.[folder]?.uidValidity === uidValidity)
          ? Number(cursor.folders[folder].lastUid) || 0
          : 0;
        nextCursor.folders[folder] = { uidValidity, lastUid: Math.max(highest, previous) };
      } finally {
        lock.release();
      }
    }
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }

  return { messages, cursor: nextCursor, stats };
}

/** RFC822 → the shape every extractor in src/ledger/email.js expects. */
async function toMessage(raw, account, folder) {
  // skipHtmlToText keeps mailparser away from html-to-text, whose deepmerge-ts
  // dependency has a stack-exhaustion bug on recursive object graphs — a
  // crafted email could otherwise kill the job. We already have a plain-text
  // converter that the LLM path uses, so this drops a dependency and a risk in
  // one move.
  const mail = await simpleParser(raw.source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const from = mail.from?.value?.[0] || null;

  const headers = {};
  if (mail.headers instanceof Map) {
    for (const [key, value] of mail.headers.entries()) {
      headers[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }

  return {
    messageId: mail.messageId || `${account.key}:${folder}:${raw.uid}`,
    accountKey: account.key,
    folder,
    uid: raw.uid,
    date: mail.date || new Date(),
    subject: mail.subject || '',
    from: from ? { name: from.name || null, address: (from.address || '').toLowerCase() } : null,
    to: (mail.to?.value || []).map(t => ({ name: t.name || null, address: (t.address || '').toLowerCase() })),
    headers,
    text: mail.text || htmlToText(mail.html) || '',
    html: mail.html || '',
    attachments: (mail.attachments || []).map(a => ({
      filename: a.filename || null,
      contentType: a.contentType || null,
      // Only calendar payloads are kept; everything else would be a copy of
      // your mail sitting in memory for no reason.
      content: /calendar|\.ics$/i.test(`${a.contentType || ''} ${a.filename || ''}`)
        ? a.content?.toString('utf8')
        : null,
    })),
  };
}

export const connector = { id: 'imap', sourceType: 'email', fetchNew };
