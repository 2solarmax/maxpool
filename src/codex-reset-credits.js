// Adapted from TeamClaude v1.1.30 (KarpelesLab). License in codex-quota.js.
// Native Codex banked resets. The usage payload contains the inventory count;
// the detail route supplies eligible credit IDs and ISO-8601 expiration times.
// The consume route communicates its verdict in the JSON body, including on 200.

import { createHash, randomUUID } from 'node:crypto';

import { fetchCodexUsage } from './codex-usage.js';
import {
  CLAIM_FRESH_MS, CLAUDE_WALL_WEEKLY, POLICY, codexAutoResetOn, decideCodexWithReason,
  planExpiringReset, EXPIRING_RESET, RESET_OUTCOME, noteResetOutcome, retryAfterFailedReset, LAST_RESORT_REASON,
  weeklyUsedWithRefusal,
} from './reset-policy.js';
import { CLAIM_BACKOFF_STEPS_MS, GRANTS_EVERY_MS, LIFT_GRACE_MS, LISTING_FRESH_MS, REACTIVE_CLAIM_TIMEOUT_MS } from './reset-timing.js';
import { nativeCodexHeaders } from './codex-native.js';

function safeLine(value, max = 120) {
  // Remove the whole ANSI escape before stripping other control characters.
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\p{C}/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function resetRetryAt(response, now = Date.now()) {
  const value = response.headers?.get?.('retry-after');
  if (!value?.trim()) return null;
  const seconds = Number(value);
  const at = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(value);
  return Number.isFinite(at) ? Math.max(now, at) : null;
}

export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
export const CODEX_RESET_CREDITS_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;

const DETAIL_TTL_MS = GRANTS_EVERY_MS;
// The account table shows when a banked reset expires. It reads the credit rows for that
// at most this often per account that holds credits (sweeps that decide a claim read
// them anyway), and trusts a reading for the same time the other reset listings use.
const EXPIRY_REFRESH_MS = 2 * GRANTS_EVERY_MS;
const EXPIRY_VALID_MS = LISTING_FRESH_MS;
const RETRY_COOLDOWN_MS = CLAIM_BACKOFF_STEPS_MS[1];
const SUCCESS_COOLDOWN_MS = LIFT_GRACE_MS;
const BUDGET_LAPSED = Symbol('redeem budget lapsed');
export const REDEEM_BUDGET_MS = REACTIVE_CLAIM_TIMEOUT_MS;

function locallyOwned(account) {
  return account?.provider === 'codex' && account.codexAuth === 'native'
    && account.enabled !== false && !account.remote && !account.poolBenchedBy
    && !account.refreshDead && !account.subscriptionGone;
}

// ON unless the owner turned it off (codexAutoResetOn): see reset-policy.js.
function automaticFor(account) {
  return codexAutoResetOn(account);
}

/**
 * One detail row, or null when it names no credit we could ever redeem.
 *
 * @param {any} raw
 */
function creditRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || id.length > 128 || /[\p{C}]/u.test(id)) return null;
  const expires = raw.expires_at == null ? NaN : Date.parse(raw.expires_at);
  if (raw.expires_at != null && !Number.isFinite(expires)) return null;
  return {
    id,
    // `available` | `redeeming` | `redeemed`.
    status: typeof raw.status === 'string' ? raw.status : null,
    // A hard gate on redemption, checked alongside `status` — but `!== false`,
    // so a payload that predates the field degrades to usable. Reading an
    // absent field as "your plan cannot spend this" would switch the whole
    // feature off silently, which is the one failure mode nobody would notice.
    supportedByPlan: raw.is_supported_by_plan !== false,
    // ISO-8601 at this layer (epoch seconds one layer down, in the Rust
    // app-server). Null means the credit does not expire.
    expiresAt: Number.isFinite(expires) ? expires : null,
    title: typeof raw.title === 'string' ? safeLine(raw.title, 64) : null,
  };
}

/** @typedef {{id: string, status: string|null, supportedByPlan: boolean, expiresAt: number|null, title: string|null}} ResetCredit */

/**
 * The account's credit rows, with the expiry dates the policy reasons about.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number, url?: string }} [opts]
 */
export async function fetchResetCreditDetails(account, { fetchImpl = fetch, timeoutMs = 10_000, url = CODEX_RESET_CREDITS_URL } = {}) {
  const headers = nativeCodexHeaders(account);
  if (!headers) return { error: 'missing Codex account identity' };
  try {
    const res = await fetchImpl(url, {
      headers: { ...headers, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status, retryAt: resetRetryAt(res) };
    const data = await res.json();
    /** @type {ResetCredit[]} */
    const credits = Array.isArray(data?.credits)
      ? data.credits.flatMap((/** @type {any} */ row) => creditRow(row) ?? [])
      : [];
    const stated = data?.available_count == null ? NaN : Number(data.available_count);
    return {
      credits,
      // Upstream's own count when it states one, else what the rows show. This
      // is the account's HOLDINGS, not the redeemable set — see the split in
      // redeemableCredit.
      availableCount: Number.isFinite(stated) ? stated : credits.filter(c => c.status === 'available').length,
    };
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err), status: null };
  }
}

/**
 * Spend one credit. The single irreversible call in this file.
 *
 * `redeemRequestId` is an idempotency key: replaying the same one after a
 * failure that may or may not have reached upstream answers `already_redeemed`
 * rather than spending a second credit, so a caller that cannot tell what
 * happened must reuse its key rather than mint a fresh one.
 *
 * `creditId` is optional — omitted, the backend picks the next available credit
 * itself.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {{ creditId?: string|null, redeemRequestId: string }} attempt
 * @param {{ fetchImpl?: Function, timeoutMs?: number, url?: string }} [opts]
 */
export async function consumeResetCredit(account, { creditId = null, redeemRequestId }, { fetchImpl = fetch, timeoutMs = 20_000, url = CODEX_RESET_CREDITS_CONSUME_URL } = {}) {
  const headers = nativeCodexHeaders(account);
  if (!headers) return { error: 'missing Codex account identity' };
  if (!redeemRequestId) return { error: 'missing redeem request id' };
  // `credit_id` is written only when the caller named one, so the shape is
  // declared rather than inferred from the seed.
  /** @type {{redeem_request_id: string, credit_id?: string}} */
  const payload = { redeem_request_id: redeemRequestId };
  if (creditId) payload.credit_id = creditId;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, accept: 'application/json', 'content-type': 'application/json' },
      redirect: 'error',
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A declined redemption comes back 200 with its reason in `code`, so the
    // verdict is read from the BODY and a non-2xx means only that no verdict
    // was reached. Reversing those two would report "no_credit" as a success.
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status, retryAt: resetRetryAt(res) };
    const data = await res.json();
    const windows = Number(data?.windows_reset);
    return {
      code: typeof data?.code === 'string' ? safeLine(data.code, 64) : null,
      windowsReset: Number.isFinite(windows) ? windows : 0,
      credit: creditRow(data?.credit),
    };
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err), status: null };
  }
}

/**
 * Soonest to expire first, so "use it or lose it" spends the one that would be
 * lost. A credit that never expires sorts last, and two of those compare equal
 * rather than subtracting two infinities into NaN.
 *
 * @param {number|null} a
 * @param {number|null} b
 */
function byExpiry(a, b) {
  const left = a ?? Infinity;
  const right = b ?? Infinity;
  return left === right ? 0 : left - right;
}

/**
 * The one credit out of a list worth spending, or null when the list names none.
 *
 * `is_supported_by_plan` is as hard a gate as `status`, so it is applied BEFORE
 * any expiry reasoning: a credit this plan cannot spend is not one we hold for
 * this purpose, and must not be what makes an expiring-credit decision look
 * justified.
 *
 * @param {ResetCredit[]} [credits]
 * @returns {ResetCredit|null}
 */
export function redeemableCredit(credits = [], now = Date.now()) {
  return credits
    .filter(credit => credit?.status === 'available' && credit.supportedByPlan !== false
      && (credit.expiresAt == null || credit.expiresAt > now))
    .sort((a, b) => byExpiry(a.expiresAt, b.expiresAt))[0] ?? null;
}

/**
 * What every path through `maybeRedeemForPool` answers with. `redeemed` is the
 * only field a caller must read: the rest describe the decision for a log line.
 *
 * @typedef {{redeemed: boolean, reason: string, uncertain?: boolean, code?: string|null, windowsReset?: number}} RedeemResult
 */

/**
 * The per-account transient state the redeemer keeps. `credits` is null when
 * nothing is cached — distinct from an empty list, which is a fetched "this
 * account holds none".
 *
 * @typedef {{cooldownUntil: number, credits: ResetCredit[]|null, creditsAt: number, expiryRetryAt: number}} RedeemState
 */

// Executes the shared subscription reset decision through Codex's native grant.
// Serialize automatic and confirmed manual redemptions, and reserve the request
// ID durably before POST so another worker can survive a reply lost at reload.
export class ResetCreditRedeemer {
  constructor(accountManager, {
    config = null,
    peersWithRoom = (account, now) => accountManager.countPeersWithRoom?.(account, now),
    applyUsage = (account, usage) => accountManager.applyCodexUsageData?.(account.index, usage),
    transactState,
    detailsFn = fetchResetCreditDetails,
    consumeFn = consumeResetCredit,
    usageFn = fetchCodexUsage,
    now = Date.now,
    log = console.log,
    // The TOTAL budget for one attempt, not a per-call timeout.
    timeoutMs = REDEEM_BUDGET_MS,
    detailTtlMs = DETAIL_TTL_MS,
  } = {}) {
    this.am = accountManager;
    this.peersWithRoom = peersWithRoom;
    this.applyUsage = applyUsage;
    this.transactState = transactState;
    this.persistedState = config?.codexResetState ?? {};
    this.detailsFn = detailsFn;
    this.consumeFn = consumeFn;
    this.usageFn = usageFn;
    this.now = now;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.detailTtlMs = detailTtlMs;
    // Keyed by the account OBJECT, not its index or name: indices are renumbered
    // when an account is removed and names are not unique. The detail rows
    // stay in memory; durable redemption state contains only hashes and
    // scheduling data, separately from the account quota state.
    /** @type {WeakMap<object, RedeemState>} */
    this.state = new WeakMap();
    this.opportunityDetails = new WeakMap();
    this.inFlight = null;
    this.manualInFlight = false;
    // An unresolved POST can have spent a credit, even when the response or
    // worker was lost. The persistent hold blocks attempts during that interval.
    this.fleetCooldownUntil = Number(this.persistedState.fleetCooldownUntil) || 0;
  }

  _owns(account) {
    return locallyOwned(account) && this.am.accounts[account.index] === account;
  }

  _identity(account) {
    const workspace = account?.codexAccountId || account?.accountId || account?.organizationUuid;
    const user = account?.accountUuid || account?.userId;
    return workspace && user
      ? createHash('sha256').update(JSON.stringify([workspace, user])).digest('hex')
      : null;
  }

  async _updatePersistent(update) {
    if (this.transactState) {
      return this.transactState(raw => {
        const { state, value } = update(raw || {});
        return { state, value: { persisted: state, result: value } };
      }).then(({ persisted, result }) => {
        this.persistedState = persisted;
        this.fleetCooldownUntil = Number(persisted.fleetCooldownUntil) || 0;
        return result;
      });
    }
    const { state, value } = update(this.persistedState);
    this.persistedState = state;
    this.fleetCooldownUntil = Number(state.fleetCooldownUntil) || 0;
    return value;
  }

  async _reserve(account, creditId, manual, now, deadline, retryMs = RETRY_COOLDOWN_MS) {
    const identity = this._identity(account);
    if (!identity) return { reason: 'the Codex account is missing a stable workspace identity' };
    if (!creditId) return { reason: 'upstream did not identify the banked reset' };
    const credit = createHash('sha256').update(creditId).digest('hex');
    try {
      return await this._updatePersistent(current => {
        const decline = reason => ({ state: current, value: { reason } });
        if (this._timeLeft(deadline) <= 0) return decline('ran out of the redeem budget');
        const ledger = Array.isArray(current.ledger) ? current.ledger : [];
        if (ledger.some(record =>
          record?.identity === identity && record.credit === credit)) {
          return decline('this banked reset was already redeemed');
        }
        const pending = current.pending;
        const sameCredit = pending?.identity === identity && pending?.credit === credit;
        // A different worker might be between sending the POST and recording
        // its verdict. The durable reservation prevents it from racing us.
        if (pending?.reservedUntil > now) return decline('a banked reset is already in progress');
        if (pending && (current.fleetCooldownUntil || 0) > now) {
          return decline('the outcome of a recent banked reset is still being resolved');
        }
        if (!this._owns(account)) return decline('account ownership changed');
        if (!manual && !automaticFor(account)) return decline('automatic resets are off for this account');
        const reservation = {
          identity, credit,
          requestId: sameCredit ? pending.requestId : randomUUID(),
          replaying: sameCredit,
          reservedUntil: now + retryMs,
        };
        // A lost worker leaves this conservative hold in place. A subsequent
        // attempt at the same credit replays the exact upstream request ID.
        return {
          state: { ...current, pending: reservation, fleetCooldownUntil: now + SUCCESS_COOLDOWN_MS },
          value: { reservation },
        };
      });
    } catch {
      return { reason: 'could not persist the banked reset reservation' };
    }
  }

  async _finish(reservation, { redeemed, uncertain, now, retryMs = RETRY_COOLDOWN_MS }) {
    try {
      await this._updatePersistent(current => {
        if (current.pending?.requestId !== reservation.requestId) return { state: current, value: null };
        const ledger = (Array.isArray(current.ledger) ? current.ledger : [])
          .filter(record => record && now - record.at < 7 * 24 * 60 * 60 * 1000);
        if (redeemed) {
          ledger.push({ identity: reservation.identity, credit: reservation.credit, at: now });
        }
        return {
          state: {
            ledger,
            pending: uncertain ? { ...reservation, reservedUntil: now } : null,
            fleetCooldownUntil: redeemed ? now + SUCCESS_COOLDOWN_MS : uncertain ? now + retryMs : 0,
          },
          value: null,
        };
      });
    } catch {
      // Keep the original reservation and pause locally even if finishing its
      // durable update failed. The upstream POST must not be repeated to
      // recover a failure to persist its outcome.
      this.fleetCooldownUntil = Math.max(this.fleetCooldownUntil, now + retryMs);
      this.log('[MaxPool] Could not persist the Codex banked reset outcome');
    }
  }

  async readDetails(account, opts = {}) {
    const sentAt = this.now();
    const credential = account?.credential;
    let read;
    try { read = await this.detailsFn(account, opts); } catch (/** @type {any} */ error) {
      read = { error: error?.message || String(error) };
    }
    if (this._owns(account) && account.credential === credential && !(account.lastClaimAt >= sentAt)
      && sentAt >= (this.opportunityDetails.get(account)?.creditsAt || 0)) {
      this.opportunityDetails.set(account, { credits: !read.error && Array.isArray(read.credits) ? read.credits : null, creditsAt: sentAt });
      // A credit that left the rows after its own end expired unused (dashboard outcome).
      if (!read.error && Array.isArray(read.credits)) {
        this.am.observeResetInventory?.(account, read.credits
          .filter(credit => ['available', 'expired'].includes(credit?.status))
          .map(credit => ({ id: credit.id, endsAt: credit.expiresAt ?? null, window: 'weekly',
            expired: credit.status === 'expired' || credit.expiresAt != null && credit.expiresAt <= sentAt })), sentAt);
      }
      // A confirmed (or vanished) credit changes whether the account's cap is lifted.
      this.am.refreshCapLift?.(account.index, this.now(), 'credits refreshed');
    }
    return read;
  }

  /** The credits that lift this account's usage cap (owner, 2026-11-27: "an available
   *  reset should alter the cap"): confirmed rows read within LISTING_FRESH_MS that are
   *  available, plan-supported and unexpired, on an account this pool owns and may
   *  spend on its own, with no redeem attempt cooling down. Null when there are none or
   *  the rows are not known. Never the upstream count. */
  /** The soonest expiry among the credits that could be spent on `account` (same rows
   *  as liftRows), or null when there are none. */
  spendableExpiry(account, now = this.now()) {
    const rows = this.liftRows(account, now);
    if (!rows) return null;
    const dated = rows.map(credit => credit.expiresAt).filter(at => Number.isFinite(at));
    return dated.length ? Math.min(...dated) : null;
  }

  liftRows(account, now = this.now()) {
    const details = this.opportunityDetails.get(account);
    if (!details?.credits || !this._owns(account) || !automaticFor(account)) return null;
    if (!(now - details.creditsAt <= LISTING_FRESH_MS)) return null;
    if (this.fleetCooldownUntil > now || (this.state.get(account)?.cooldownUntil || 0) > now) return null;
    const live = details.credits.filter(credit => credit?.status === 'available'
      && credit.supportedByPlan !== false && (credit.expiresAt == null || credit.expiresAt > now));
    return live.length ? live : null;
  }

  // The placement comparison can read an existing decision, never fetch or spend a
  // credit. Only the credential holder has the private detail rows needed for it.
  expiringOpportunity(account, now = this.now()) {
    const details = this.opportunityDetails.get(account);
    if (!details?.credits || !this._owns(account) || !automaticFor(account)
      || this.inFlight || this.manualInFlight || this.fleetCooldownUntil > now || (this.state.get(account)?.cooldownUntil || 0) > now
      || now - details.creditsAt >= this.detailTtlMs) return null;
    const action = this._decision(account, details, false, now).action;
    const expiresAt = action?.grant?.endsAt;
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now >= POLICY.dyingWindowMs) return null;
    return { expiresAt, validUntil: Math.min(expiresAt, details.creditsAt + this.detailTtlMs,
      account.quota.codexWeeklyReadingAt + CLAIM_FRESH_MS, account.quota.unified7dReset) };
  }

  /**
   * When this account's redeemable banked resets expire, for the account table and the
   * status a linked pool reads. SANITIZED on purpose: counts and times only, never a
   * credit id or title. `null` means unknown (no credit rows read recently, or an
   * account this pool does not own); `{count: 0}` means the rows show nothing redeemable;
   * `earliestExpiresAt: null` with a count means every redeemable credit is non-expiring,
   * which is a different fact from not knowing.
   *
   * @param {Record<string, any>} account
   * @param {number} [now]
   * @returns {{checkedAt: number, count: number, earliestExpiresAt: number|null}|null}
   */
  expirySummary(account, now = this.now()) {
    const details = this.opportunityDetails.get(account);
    if (!details?.credits || !this._owns(account) || !(now - details.creditsAt <= EXPIRY_VALID_MS)) return null;
    const live = details.credits.filter(credit => credit?.status === 'available'
      && credit.supportedByPlan !== false && (credit.expiresAt == null || credit.expiresAt > now));
    const dated = live.map(credit => credit.expiresAt).filter(at => Number.isFinite(at));
    return { checkedAt: details.creditsAt, count: live.length,
      earliestExpiresAt: dated.length ? Math.min(...dated) : null };
  }

  // Keep the expiry the table shows current for an account that holds credits. The
  // upstream count says whether any exist; the rows are read only then, and at most
  // every EXPIRY_REFRESH_MS. A failed read is retried later, never in a tight loop, and
  // never touches the claim cooldown.
  async _noteExpiry(account, now, deadline) {
    const state = this._stateFor(account);
    const seen = this.opportunityDetails.get(account);
    // The upstream count says whether any exist; the rows are read only then. The ONE
    // exception: the last read showed a credit that was live THEN, and the count has
    // since dropped — read the rows once more, so a credit that lapsed is seen leaving
    // and the dashboard records "expired unused" (observeResetInventory). An empty read
    // clears `live` below, so this costs one read per lapse, never one per sweep.
    const live = seen?.credits ? redeemableCredit(seen.credits, seen.creditsAt) : null;
    if (!(account.quota?.codexResetCredits?.available > 0) && !live && !account._resetInventory?.length) return;
    if (now < state.expiryRetryAt) return;
    if (seen && now - seen.creditsAt < EXPIRY_REFRESH_MS) return;
    if (this._timeLeft(deadline) <= 0) return;
    const result = await this._credits(account, state, now, deadline);
    if (result.error) state.expiryRetryAt = Math.max(result.retryAt || 0, now + this._retryMs(account, EXPIRY_REFRESH_MS, now));
  }

  /**
   * @param {object} account
   * @returns {RedeemState}
   */
  _stateFor(account) {
    let state = this.state.get(account);
    if (!state) {
      state = { cooldownUntil: 0, credits: null, creditsAt: 0, expiryRetryAt: 0 };
      this.state.set(account, state);
    }
    return state;
  }

  // A quota sweep may also redeem a dying credit below the wall. A request
  // refusal only acts at the weekly wall, using the same hold and expiry rules.
  async maybeRedeemForPool(accounts, { reactive = false } = {}) {
    const enrolled = accounts?.filter(account => this._owns(account) && automaticFor(account)) || [];
    if (!enrolled.length) return { redeemed: false, reason: 'no accounts have automatic resets enabled' };
    if (this.manualInFlight) return { redeemed: false, reason: 'a manual reset is in progress' };
    // Only one automatic attempt may walk or spend across the local pool.
    if (this.inFlight) return this.inFlight;
    const attempt = this._attempt(enrolled, reactive).finally(() => { this.inFlight = null; });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * @param {Record<string, any>[]} accounts
   * @returns {Promise<RedeemResult>}
   */
  async _attempt(accounts, reactive) {
    const now = this.now();
    if (now < this.fleetCooldownUntil) {
      return { redeemed: false, reason: 'the pool is cooling down after a recent redemption attempt' };
    }
    const deadline = now + this.timeoutMs;
    const actions = [];
    let reason = 'no Codex account holds a credit worth spending';
    for (const account of accounts) {
      const q = account.quota || {};
      // Keep the cap lift in step with the stored rows on every sweep (no network): it
      // ends as soon as they age out, a redeem backs off, or automatic resets go off.
      this.am.refreshCapLift?.(account.index, now, 'credits refreshed');
      // A cap is not a full weekly window. Keep the listing current below the limit,
      // without authorizing consumption. ONE exception (owner 2026-11-28, the shared
      // expiry planner): a confirmed credit inside its last POLICY.lastResortMs IS
      // decided below the limit — that is the last resort, and the decision itself
      // checks the 30%-used floor and the free refill. A request refusal never spends
      // below the limit: it acts at the weekly wall only.
      const fresh = now - q.codexWeeklyReadingAt <= CLAIM_FRESH_MS;
      const atLimit = weeklyUsedWithRefusal(account, q.unified7d, q.unified7dReset, now) >= CLAUDE_WALL_WEEKLY;
      if (!fresh || !(q.unified7dReset > now) || (!atLimit && reactive)) {
        // Nothing to decide on this account now. A sweep may still refresh the expiry
        // the table shows (an account that will read its credits below does not need to).
        if (!reactive) await this._noteExpiry(account, now, deadline);
        continue;
      }
      if (!atLimit) {
        // Below the limit: read the rows first (at most every EXPIRY_REFRESH_MS), so a
        // credit entering its last-resort window is seen on THIS sweep, then let the
        // shared planner decide whether it is one.
        await this._noteExpiry(account, now, deadline);
        if (this._decision(account, this._stateFor(account), false, now).reason !== LAST_RESORT_REASON) continue;
      }
      const summary = q.codexResetCredits;
      if (summary && now - summary.checkedAt <= CLAIM_FRESH_MS
        && summary.available === 0) {
        if (!reactive && atLimit) await this._noteExpiry(account, now, deadline);
        continue;
      }
      const state = this._stateFor(account);
      if (now < state.cooldownUntil) continue;
      const result = await this._credits(account, state, now, deadline);
      if (result.error) {
        state.cooldownUntil = Math.max(result.retryAt || 0, now + this._retryMs(account, CLAIM_BACKOFF_STEPS_MS[0], now));
        reason = result.error;
        continue;
      }
      const decision = this._decision(account, state, reactive, this.now());
      if (decision.heldScope === 'general') this.am.noteWallHold?.(account, now);
      if (decision.action) actions.push({ account, state, ...decision.action });
      else reason = decision.reason;
    }
    actions.sort((a, b) => byExpiry(a.grant.endsAt, b.grant.endsAt));
    for (const { account, state, grant, reason: why } of actions) {
      const result = await this._consume(account, state, { creditId: grant.id, reason: why, expiresAt: grant.endsAt }, this.now(), deadline, reactive);
      if (result.redeemed) return result;
      reason = result.reason;
      if (this.now() < this.fleetCooldownUntil || this._timeLeft(deadline) <= 0) break;
    }
    return { redeemed: false, reason };
  }

  _decision(account, state, reactive, now) {
    const used = weeklyUsedWithRefusal(account, account.quota?.unified7d, account.quota?.unified7dReset, now);
    // A refusal acts at the weekly wall only; a last-resort spend is the sweep's.
    if (reactive && !(used >= CLAUDE_WALL_WEEKLY)) {
      return { action: null, reason: 'weekly below wall' };
    }
    // BELOW the limit the shared planner decides alone (one place for every provider):
    // nothing is spent before POLICY.lastResortMs of expiry.
    if (!(used >= CLAUDE_WALL_WEEKLY)) {
      const soonest = redeemableCredit(state.credits || [], now);
      const plan = planExpiringReset({ expiresAt: soonest?.expiresAt ?? null, util: account.quota?.unified7d,
        refillAt: account.quota?.unified7dReset, now });
      if (plan !== EXPIRING_RESET.LAST_RESORT) return { action: null, reason: 'weekly below limit' };
    }
    const summary = account.quota?.codexResetCredits;
    if (summary && now - summary.checkedAt <= CLAIM_FRESH_MS
      && summary.available === 0) {
      return { action: null, reason: 'no banked resets remaining' };
    }
    // The decision needs no "early" inputs any more (EXACT LIMIT): the cap a reset
    // lifts is read by the cap lift, never as a reason to spend, and the soonest a
    // compatible account frees up mattered only to the removed early wait.
    return decideCodexWithReason(account, state.credits, now, {
      listingCheckedAt: state.creditsAt,
      peersWithRoom: () => this.peersWithRoom(account, now),
      holdersInPool: this.am.countHoldingWalls ? () => this.am.countHoldingWalls(account, now) : undefined,
    });
  }

  /**
   * What is left of the attempt's budget, as the timeout for the next call.
   *
   * Zero or less means the client's share is gone: the caller makes no call and
   * declines, because a request started with nothing left cannot finish inside
   * the budget and would only push the hold past it.
   *
   * @param {number} deadline
   * @returns {number}
   */
  _timeLeft(deadline) {
    return deadline - this.now();
  }

  /**
   * Refresh the account's token, and never wait longer for it than the attempt
   * has left.
   *
   * `ensureTokenFresh` takes no timeout of its own and joins whatever refresh is
   * already running, so awaiting it plainly is unbounded — and reading the clock
   * afterwards can only report a deadline already missed, with every concurrent
   * refusal held for exactly as long. The only way to bound it is to race it.
   *
   * A refresh that lands late is not wrong, merely too late to act on: it
   * carries on in the background, and whatever asks next gets the token it
   * fetched. What must not happen is this attempt proceeding on it — an
   * irreversible call made for a client that has already stopped waiting is the
   * worst of both outcomes.
   *
   * @param {Record<string, any>} account
   * @param {number} deadline
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async _freshToken(account, deadline) {
    const left = this._timeLeft(deadline);
    if (!this._owns(account)) return { ok: false, error: 'account ownership changed' };
    if (left <= 0) return { ok: false, error: 'ran out of the redeem budget before refreshing the token' };
    /** @type {any} */
    let timer = null;
    /** @type {Promise<any>} */
    const lapsed = new Promise(resolve => { timer = setTimeout(() => resolve(BUDGET_LAPSED), left); });
    try {
      // Wrapped so a synchronous throw arrives as a rejection like any other,
      // and settled both ways so losing the race cannot leave one unhandled.
      const refreshed = (async () => this.am.ensureTokenFresh(account.index))()
        .then(ok => ok === false ? new Error('token refresh failed') : null, (/** @type {any} */ err) => err ?? new Error('token refresh failed'));
      const outcome = await Promise.race([refreshed, lapsed]);
      if (outcome === BUDGET_LAPSED) return { ok: false, error: 'ran out of the redeem budget refreshing the token' };
      // A refresh that failed is an answer, and the answer is no: the credential
      // in hand is the one upstream has already stopped accepting, and the next
      // call would spend the budget proving it.
      if (outcome) return { ok: false, error: `token refresh failed (${safeLine(outcome.message || String(outcome), 80)})` };
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The detail rows, from cache while they are fresh.
   *
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @param {number} now
   * @param {number} deadline
   * @returns {Promise<{credits?: ResetCredit[], error?: string}>}
   */
  async _credits(account, state, now, deadline) {
    if (state.credits && now - state.creditsAt < this.detailTtlMs) return { credits: state.credits };
    // The refresh is inside the budget too, and it is the one step here with no
    // timeout of its own, so it is raced against the deadline rather than
    // trusted to come back inside it.
    const fresh = await this._freshToken(account, deadline);
    if (!fresh.ok) return { error: fresh.error };
    const timeoutMs = this._timeLeft(deadline);
    if (timeoutMs <= 0) return { error: 'ran out of the redeem budget before reading the credit rows' };
    const result = await this.readDetails(account, { timeoutMs });
    if (result?.error) return result;
    const credits = result?.credits || [];
    state.credits = credits;
    state.creditsAt = now;
    return { credits };
  }

  /**
   * @param {Record<string, any>} account
   * @param {RedeemState} state
   * @param {{redeem: boolean, reason: string, creditId: string|null}} verdict
   * @param {number} now
   * @param {number} deadline
   * @returns {Promise<RedeemResult>}
   */
  async _consume(account, state, verdict, now, deadline, reactive) {
    const name = safeLine(account.name, 64);
    // Raced against the deadline, not merely measured after the fact: the
    // budget exists to bound what the waiting client is held for, and a check
    // that runs once the refresh has returned can only report a promise already
    // broken. See _freshToken.
    const fresh = await this._freshToken(account, deadline);
    const timeoutMs = fresh.ok ? this._timeLeft(deadline) : 0;
    if (timeoutMs <= 0) {
      // Declined like any other attempt that spent nothing: a cooldown, so a
      // burst against a slow upstream cannot re-enter here per refusal, and
      // no idempotency key minted for a request never made. Per-account only —
      // nothing was sent, so the fleet has nothing to be careful of.
      const why = fresh.error || 'ran out of the redeem budget';
      state.cooldownUntil = now + this._retryMs(account, RETRY_COOLDOWN_MS, now, verdict.expiresAt);
      this.log(`[MaxPool] Codex rate-limit reset on "${name}" stopped before redeeming — ${why}`);
      return { redeemed: false, reason: why };
    }

    const validate = () => this._decision(account, state, reactive, this.now()).action?.grant.id === verdict.creditId;
    return this.redeemGrant(account, verdict.creditId, { deadline, reason: verdict.reason, validate, expiresAt: verdict.expiresAt });
  }

  /** The wait before an automatic attempt on `account` is repeated after it failed: the
   *  usual cooldown, or about POLICY.lastResortRetryMs while the credit it is for is
   *  inside its last-resort window (the shared retryAfterFailedReset rule). */
  _retryMs(account, usualWaitMs, now = this.now(), expiresAt = undefined) {
    const soonest = expiresAt !== undefined ? expiresAt
      : redeemableCredit(this.opportunityDetails.get(account)?.credits || this._stateFor(account).credits || [], now)?.expiresAt;
    return retryAfterFailedReset({ expiresAt: soonest ?? null, util: weeklyUsedWithRefusal(account, account?.quota?.unified7d, account?.quota?.unified7dReset, now),
      refillAt: account?.quota?.unified7dReset, now, usualWaitMs });
  }

  /**
   * Shared consume execution, after the caller has checked its policy or a
   * fresh manual detail read. Each chosen credit keeps its own unread key.
   *
   * @param {Record<string, any>} account
   * @param {string|null} creditId
   * @param {{ manual?: boolean, deadline?: number, reason?: string, validate?: () => boolean }} [opts]
   * @returns {Promise<RedeemResult>}
   */
  async redeemGrant(account, creditId, { manual = false, deadline = this.now() + this.timeoutMs, reason = 'manual redeem', validate, expiresAt } = {}) {
    if (!this._owns(account)) {
      return { redeemed: false, reason: 'this Codex account cannot redeem a banked reset here' };
    }
    const now = this.now();
    // A manual redeem keeps the usual cooldown; an automatic one inside its last-resort
    // window retries about every POLICY.lastResortRetryMs (the request id is replayed,
    // so a retry after an uncertain outcome can never spend twice).
    let retryMs = manual ? RETRY_COOLDOWN_MS : this._retryMs(account, RETRY_COOLDOWN_MS, now, expiresAt);
    const { reservation, reason: unavailable } = await this._reserve(account, creditId, manual, now, deadline, retryMs);
    if (!reservation) return { redeemed: false, reason: unavailable };
    const { requestId: redeemRequestId } = reservation;
    const name = safeLine(account.name, 64);
    const state = this._stateFor(account);
    const timeoutMs = this._timeLeft(deadline);
    if (timeoutMs <= 0 || !this._owns(account) || (!manual && !automaticFor(account)) || (validate && !validate())) {
      await this._finish(reservation, { redeemed: false, uncertain: reservation.replaying, now, retryMs });
      const reason = timeoutMs <= 0 ? 'ran out of the redeem budget' : 'account or automatic reset eligibility changed';
      return { redeemed: false, reason };
    }

    this.log(`[MaxPool] ${manual ? 'Manually redeeming' : 'Redeeming'} a free Codex rate-limit reset on "${name}" — ${reason}`);
    const usedBefore = account.quota?.unified7d;
    let result;
    try {
      result = await this.consumeFn(account, { creditId, redeemRequestId }, { timeoutMs });
    } catch (error) {
      result = { error: safeLine(error?.message || String(error)) };
    }
    const redeemed = !result?.error && (result?.code === 'reset' || result?.code === 'already_redeemed');
    const declined = result?.code === 'no_credit' || result?.code === 'nothing_to_reset';
    const uncertain = !redeemed && !declined || Boolean(result?.error);
    retryMs = Math.max(retryMs, (result?.retryAt || 0) - this.now());
    await this._finish(reservation, { redeemed, uncertain, now: this.now(), retryMs });
    // The pool dashboard shows what became of each automatic reset (owner 2026-11-28),
    // recorded on the reading the decision was made on, before the post-reset re-read.
    if (redeemed) {
      noteResetOutcome(account, manual ? RESET_OUTCOME.MANUAL : reason === LAST_RESORT_REASON ? RESET_OUTCOME.LAST_RESORT
        : account.weeklyRefusal && !(usedBefore >= 1) ? RESET_OUTCOME.REFUSED : RESET_OUTCOME.SPENT,
        { util: usedBefore, id: creditId, now: this.now() });
    }
    state.credits = null;
    this.opportunityDetails.delete(account);
    this.am.refreshCapLift?.(account.index, this.now(), 'credit spent or unsettled');
    state.cooldownUntil = this.now() + (redeemed ? SUCCESS_COOLDOWN_MS : retryMs);
    if (uncertain) {
      const detail = safeLine(result?.error || 'no upstream verdict');
      this.log(`[MaxPool] Codex reset outcome is uncertain on "${name}" — ${detail}; the pool holds off`);
      return { redeemed: false, uncertain: true, reason: `redeem outcome uncertain (${detail})` };
    }
    if (redeemed) {
      account.lastClaimAt = this.now();
      account.lastGeneralClaimAt = account.lastClaimAt;
      this.am.noteRoutingRefill?.(account, 'wk', account.lastClaimAt);
      account.lastFullGeneralClaimAt = account.lastClaimAt;
      // A replay may confirm a spend that a previous usage read already counted.
      // Invalidate the old balance until OpenAI reports the post-reset inventory.
      account.codexResetCredits = null;
      if (account.quota) account.quota.codexResetCredits = null;
      account.codexQuotaSentAt = Math.max(account.codexQuotaSentAt || 0, account.lastClaimAt);
      const windowsReset = result.windowsReset || 0;
      this.log(`[MaxPool] Redeemed a free Codex reset on "${name}" — ${windowsReset} window(s) reset (${result.code})`);
      if (this.am.clearRateLimited(account.index)) {
        this.log(`[MaxPool] Rate-limit bench lifted on "${name}" by the reset`);
      }
      try { await this._refresh(account, name, deadline); } catch {
        this.log(`[MaxPool] Could not re-read Codex quota for "${name}" after the reset`);
      }
      return { redeemed: true, reason, code: result.code, windowsReset, accountName: account.name };
    }
    return { redeemed: false, reason: `upstream declined (${safeLine(result.code, 64)})`, code: result.code };
  }

  async manualRedeem(account, creditId) {
    if (!this._owns(account)) {
      return { redeemed: false, reason: 'this Codex account cannot redeem a banked reset here' };
    }
    if (!creditId || this.manualInFlight || this.inFlight) {
      return { redeemed: false, reason: creditId ? 'another banked reset is in progress' : 'select a banked reset' };
    }
    this.manualInFlight = true;
    const deadline = this.now() + this.timeoutMs;
    try {
      const fresh = await this._freshToken(account, deadline);
      const timeoutMs = this._timeLeft(deadline);
      if (!fresh.ok || timeoutMs <= 0) return { redeemed: false, reason: fresh.error || 'the reset request timed out' };
      const read = await this.readDetails(account, { timeoutMs });
      const credit = read.credits?.find(row => row.id === creditId);
      if (read.error || !credit || !redeemableCredit([credit], this.now())) {
        return { redeemed: false, reason: read.error || 'the selected banked reset is no longer available' };
      }
      return await this.redeemGrant(account, creditId, { manual: true, deadline });
    } finally {
      this.manualInFlight = false;
    }
  }

  /**
   * Put the account back in service after a successful reset: drop the hold and
   * re-read its quota.
   *
   * Nothing here fabricates a reading. If the read fails, or upstream has not
   * caught up with its own reset yet, the account stays blocked by its stale
   * exhausted numbers until the all-unavailable revalidation probe sends it a
   * live request — which is the same path that recovers every other account
   * whose quota we cannot see.
   *
   * That fallback is also why this read is held to the same deadline, and
   * skipped outright once it has passed: the hold clears either way, and a
   * reading we did not take is a delay of one request, while a client that gave
   * up waiting is the retry this redemption was spent to enable.
   *
   * @param {Record<string, any>} account
   * @param {string} name
   * @param {number} deadline
   */
  async _refresh(account, name, deadline) {
    if (!this._owns(account)) return;
    this.am.clearRateLimited(account.index);
    const timeoutMs = this._timeLeft(deadline);
    if (timeoutMs <= 0) {
      this.log(`[MaxPool] Out of time to re-read Codex quota for "${name}" after the reset — it will be re-learned from traffic`);
      return;
    }
    const sentAt = this.now();
    const credential = account.credential;
    const usage = await this.usageFn(account, { timeoutMs }).catch(() => null);
    if (!usage || usage.error) {
      this.log(`[MaxPool] Could not re-read Codex quota for "${name}" after the reset — it will be re-learned from traffic`);
      return;
    }
    if (this._owns(account) && account.credential === credential) await this.applyUsage(account, usage, { sentAt });
  }
}
