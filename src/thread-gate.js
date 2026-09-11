// Thread gate — let Claude Code fall back to stateless when maxpool routed a threaded
// turn somewhere that cannot serve it.
//
// WHY (2026-09-10). Claude Code >= 2.1.265 keeps the conversation on Anthropic's servers
// and sends only the tail plus `thread:{type:"continue", previous_message_id}`. That
// removed the self-containment every maxpool routing capability rests on: a different
// Anthropic account 404s ("No thread state was found"), and GLM/Kimi reject a transcript
// that opens mid-tool-call (z.ai `[1214]`). Measured: 10 of 12 live requests carry it.
//
// HOW. We do NOT rebuild the transcript. The client already knows how to fall back, and
// Anthropic built the signal for exactly this case — a proxy that cannot honour threads.
// A 400 carrying `error.details.error_code = "thread_unsupported_request"` makes the
// client resend that turn stateless AND stop using threads for that agent+model for the
// rest of the session. So the client replays with the transcript it already holds; we
// never reuse a thread reference and therefore can never serve a stale conversation.
//
// Routing is NOT consulted or constrained. This runs after the account has been chosen;
// it only decides what to say to it.

export const THREAD_UNSUPPORTED_CODE = 'thread_unsupported_request';

/** What kind of thread intent a request body carries. Cheap: only the head of the body
 *  is JSON-parsed, and a non-JSON body is simply 'none'. */
export function readThreadIntent(body) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    const t = j?.thread;
    if (!t || typeof t !== 'object') {
      // `previous_message_id` can also ride in `diagnostics`; that alone is not a thread.
      return { kind: 'none' };
    }
    if (t.type === 'continue') return { kind: 'continue' };
    if (t.type === 'create') return { kind: 'create' };
    return { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

/** The exact body the client's classifier reads. `details.error_code` is the field it
 *  keys on; the message is free text and is never shown to a person. */
export function threadRefusalBody(accountName) {
  return {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: `maxpool routed this turn to "${accountName}", which does not hold this thread. Resend it stateless.`,
      details: { error_code: THREAD_UNSUPPORTED_CODE },
    },
  };
}

// Sessions whose last threaded turn we served, and how many times we have refused them.
// Two short strings per entry; bounded and LRU-evicted.
const MAX_SESSIONS = 500;
// A session that keeps sending threaded turns after being refused is one whose client
// did NOT take the downgrade (a different agent id, a model switch, an older build).
// Refusing forever would double its request volume, so stop and forward instead.
const MAX_CONSECUTIVE_REFUSALS = 2;

export class ThreadOwners {
  constructor({ maxSessions = MAX_SESSIONS, maxRefusals = MAX_CONSECUTIVE_REFUSALS } = {}) {
    this.map = new Map();          // sessionKey -> { owner, refusals }
    this.maxSessions = maxSessions;
    this.maxRefusals = maxRefusals;
  }

  _touch(key) {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }   // LRU bump
    return v;
  }

  _set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSessions) this.map.delete(this.map.keys().next().value);
  }

  /** Decide AFTER routing has chosen. Returns true only for a `continue` turn that the
   *  chosen account cannot serve, and only while refusals are still under the bound. */
  shouldRefuse(sessionKey, accountName, intent) {
    if (!sessionKey || !accountName) return false;
    if (intent?.kind !== 'continue') return false;          // `create` carries the full transcript
    const entry = this._touch(sessionKey);
    if (entry && entry.owner === accountName) return false; // the account that holds it
    if (entry && entry.refusals >= this.maxRefusals) return false;  // bounded fail-open
    return true;
  }

  /** Record a refusal we are about to emit. */
  noteRefused(sessionKey) {
    if (!sessionKey) return;
    const entry = this._touch(sessionKey) || { owner: null, refusals: 0 };
    this._set(sessionKey, { owner: entry.owner, refusals: entry.refusals + 1 });
  }

  /** Record that `accountName` served a threaded turn for this session — it now holds
   *  the thread. Any refusal streak ends here. */
  noteServed(sessionKey, accountName, intent) {
    if (!sessionKey || !accountName) return;
    if (intent?.kind !== 'create' && intent?.kind !== 'continue') return;
    this._set(sessionKey, { owner: accountName, refusals: 0 });
  }

  get size() { return this.map.size; }
}
