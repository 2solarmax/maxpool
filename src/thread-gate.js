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

/** Whether an account is a non-Anthropic provider (GLM/Kimi) that can never hold an
 *  Anthropic-side thread. The ONE place this is decided, so the call site and the
 *  tests cannot disagree about it. */
export function isThreadlessAccount(account) {
  return account?.type === 'provider';
}

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
// Bucket for requests that carry no session header — keyed per account so the storm
// bound still applies without pretending we know whose conversation it is.
const NO_SESSION_PREFIX = '\u0000nosession:';

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
   *  chosen account cannot serve, and only while refusals are still under the bound.
   *
   *  2026-09-13: `isProvider` (GLM/Kimi) short-circuits to refuse — measured, not
   *  guessed: 118 of 118 provider-routed continues 400'd, the client never downgrades
   *  on a plain provider 400 (its downgrade trigger is exactly the code this gate
   *  returns), and when a slice tail is standalone-valid the provider ANSWERS it from
   *  a ~2-message orphan context (the "amnesia" bug: 2,844 effective input tokens
   *  where the prior turn had 478,596). Ownership tracking is meaningless for
   *  providers — they can never hold an Anthropic-side thread — so every provider
   *  continue is refused unconditionally: no owner record, no bound. The bound
   *  existed to stop storms when a client ignores refusals, but the classifier that
   *  acts on them ships in every continue-capable build (>= 2.1.265), and one
   *  refusal ends the session's slicing for good; a no-session-header storm is
   *  bounded by that same downgrade. Anthropic accounts keep the owner logic below —
   *  a same-account chain preserves the vendor's thread saving (64% of turns). */
  shouldRefuse(sessionKey, accountName, intent, isProvider = false) {
    if (!accountName) return false;
    if (intent?.kind !== 'continue') return false;          // `create` carries the full transcript
    if (isProvider) return true;                            // can never serve an Anthropic thread
    // A request with NO session header is invisible to ownership tracking, and measured
    // 2026-09-11 those are the majority of traffic — 14 of 20 consecutive /v1/messages
    // lines carried no `[sess …]`. Skipping them left threaded turns reaching GLM and
    // failing exactly as before the gate existed. We cannot know the owner, so treat it
    // as an unknown session (refuse, the safe direction) and bucket the refusal COUNT
    // per account so the storm bound still applies.
    const key = sessionKey || `${NO_SESSION_PREFIX}${accountName}`;
    const entry = this._touch(key);
    if (entry && entry.owner === accountName) return false; // the account that holds it
    if (entry && entry.refusals >= this.maxRefusals) return false;  // bounded fail-open
    return true;
  }

  /** Record a refusal we are about to emit. */
  noteRefused(sessionKey, accountName = null) {
    const key = sessionKey || (accountName ? `${NO_SESSION_PREFIX}${accountName}` : null);
    if (!key) return;
    const entry = this._touch(key) || { owner: null, refusals: 0 };
    this._set(key, { owner: entry.owner, refusals: entry.refusals + 1 });
  }

  /** Record that `accountName` served a threaded turn for this session — it now holds
   *  the thread. Any refusal streak ends here. */
  noteServed(sessionKey, accountName, intent) {
    if (!accountName) return;
    if (intent?.kind !== 'create' && intent?.kind !== 'continue') return;
    // Without a session header there is no conversation to attribute ownership to; only
    // clear the per-account refusal streak so a served turn re-arms the bound.
    const key = sessionKey || `${NO_SESSION_PREFIX}${accountName}`;
    this._set(key, { owner: sessionKey ? accountName : null, refusals: 0 });
  }

  get size() { return this.map.size; }
}
