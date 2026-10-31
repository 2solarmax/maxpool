/** z.ai subscription list — the FACT source for a GLM plan's billing cycle and
 *  price (same API the finops forecast uses; 2026-10-31). Used for the
 *  price-per-token column on the Capacity page: tank tokens ÷ normalized monthly
 *  price. Values are cached per account; a failed read degrades the column to
 *  '--' and never touches routing. */
const SUBS_URL = 'https://api.z.ai/api/biz/subscription/list';
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, annually: 12 };

export async function listSubscriptions(token, { signal, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(SUBS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const env = await res.json();
    const rows = env?.data;
    if (!Array.isArray(rows)) return { error: 'bad_payload' };
    return { subscriptions: rows.map(s => ({
      id: s.id,
      product: s.productName || null,
      billingCycle: s.billingCycle || null,
      price: Number(s.renewPrice ?? s.actualPrice ?? 0) || null,
      autoRenew: Number(s.autoRenew ?? 0) === 1,
      status: s.status || null,
    })) };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'error') };
  }
}

/** Monthly-normalized price in USD, or null. An annually-billed plan's per-month
 *  cost is price/12 — the token tank it buys is the same every month. */
export function monthlyPriceUSD(subscriptions) {
  if (!subscriptions?.length) return null;
  // Prefer the VALID auto-renewing plan; fall back to the first row.
  const s = subscriptions.find(x => x.status === 'VALID' && x.autoRenew)
    || subscriptions.find(x => x.status === 'VALID')
    || subscriptions[0];
  const months = CYCLE_MONTHS[s?.billingCycle] || 0;
  if (!months || !s?.price) return null;
  return s.price / months;
}
