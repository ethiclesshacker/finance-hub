// ======================================================
// The single door to the OpenAI API.
//
// Everything billable goes through here — extraction, summary prose, anything
// added later — so the cost ledger cannot be bypassed by forgetting to record
// a call at a new call site. Failures are recorded too: a run that burned
// tokens and then timed out still cost money, and a cost ledger that only
// counts successes is the one that lies to you.
// ======================================================

import { config } from '../config.js';
import { recordUsage } from '../costs.js';

/**
 * One chat completion.
 *
 * Returns { ok, content, usage, error }. Never throws — the deterministic
 * layers are the ledger's backbone, and a model outage should degrade the
 * result, not end the run.
 */
export async function chat({
  job, messages, responseFormat = null, model = config.llm.model,
  reasoningEffort = config.llm.reasoningEffort,
}) {
  if (!config.llm.enabled) return { ok: false, error: 'llm disabled', content: null, usage: null };
  if (!config.llm.apiKey) return { ok: false, error: 'OPENAI_API_KEY not set', content: null, usage: null };

  const body = { model, messages };
  if (responseFormat) body.response_format = responseFormat;
  // Omitted entirely when unset, so a model that does not take the parameter
  // is unaffected.
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);

  try {
    const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      const error = /model/i.test(detail) && /not|unknown|does not exist/i.test(detail)
        ? `The model id "${model}" was rejected. Set OPENAI_MODEL in .env.ledger. ${detail}`
        : `OpenAI ${response.status}: ${detail}`;
      recordUsage({ job, model, usage: null, ok: false, error, meta: { ms: Date.now() - startedAt } });
      return { ok: false, error, content: null, usage: null };
    }

    const payload = await response.json();
    const usage = payload.usage || null;
    const content = payload?.choices?.[0]?.message?.content ?? null;

    recordUsage({ job, model, usage, ok: Boolean(content), meta: { ms: Date.now() - startedAt } });

    if (!content) return { ok: false, error: 'empty completion', content: null, usage };
    return { ok: true, content, usage, error: null };
  } catch (err) {
    const error = err.name === 'AbortError' ? `timed out after ${config.llm.timeoutMs}ms` : err.message;
    // The request may well have been billed before it was abandoned.
    recordUsage({ job, model, usage: null, ok: false, error, meta: { ms: Date.now() - startedAt } });
    return { ok: false, error, content: null, usage: null };
  } finally {
    clearTimeout(timer);
  }
}
