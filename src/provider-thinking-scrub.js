/**
 * Provider-thinking scrub — keep foreign reasoning OUT of the shared transcript.
 *
 * WHY (owner 2026-11-05, task research/maxpool-round2): a mixed GLM+Claude session
 * stores GLM-authored `thinking` blocks; Claude rejects their signatures (400), and the
 * repair that recovers the session strips ALL thinking — rewriting the cached prefix from
 * the first thinking block onward. Scrubbing provider thinking at the RESPONSE boundary
 * means the transcript never contains it: no 400s, no repair, and the Claude-side cache
 * prefix is never mutated by contamination. Claude accounts are NEVER scrubbed (their
 * thinking is validly signed, cache-relevant, and must round-trip).
 *
 * Two lanes (red team 2026-11-05, finding 2): the streaming lane (streamResponse) and
 * the buffered/non-streaming lane (next to normalizeModelEcho). Both must scrub or the
 * fallback lane re-poisons histories CC itself hits exactly when providers misbehave.
 *
 * Red-team finding 1: NEVER skip SSE block indexes. A second CC reducer family (SDK
 * paths, query-tool subagents, RC hosts) pushes on content_block_start and indexes by
 * ARRAY POSITION — a suppressed block shifts every later one and silently corrupts text.
 * So the streaming scrub RENUMBERS: an oldIndex→newIndex map rewrites every subsequent
 * start/delta/stop for the same message. Internal consumers (usage ledger, capacity,
 * streamLog) still see the PRE-scrub stream (finding 6: scrub applies at res.write only).
 *
 * Red-team finding 3: a thinking-only provider turn must not scrub to `content: []` —
 * Anthropic rejects empty assistant content on the next request and no repair covers it.
 * Synthesize a "(reasoning omitted)" text block instead.
 *
 * Red-team finding 4: unknown/renamed provider block types would pass through, get
 * stored, and 400 later in a class no repair matches. The provider pass allows only
 * known Anthropic types; anything else is dropped with a warn log. `redacted_thinking`
 * is also scrubbed — a provider can never produce a valid one.
 *
 * Provenance-ready for the deferred replay-memory upgrade (B): nothing here parses block
 * content. If B is ever built, its memory keys off (session, provider, turn) and stores
 * these blocks as opaque bytes — a z.ai format change cannot corrupt it.
 */

/** Anthropic content-block types a PROVIDER response may carry through to the client. */
const PROVIDER_ALLOWED_BLOCK_TYPES = new Set([
  'text', 'tool_use', 'thinking', 'redacted_thinking', // thinking* are listed so the
  // scrub can MATCH them explicitly; both are removed below — never forwarded.
]);

const SCRUB_PLACEHOLDER = '(reasoning omitted)';

/**
 * Scrub a COMPLETE parsed response body (buffered lane). Mutates nothing; returns a new
 * object when something was scrubbed, else null (caller forwards the original).
 */
export function scrubProviderResponseBody(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.content)) return null;
  let changed = false;
  const out = [];
  for (const block of json.content) {
    const type = block?.type;
    if (type === 'thinking' || type === 'redacted_thinking') { changed = true; continue; }
    if (!PROVIDER_ALLOWED_BLOCK_TYPES.has(String(type))) {
      changed = true;
      console.warn(`[Maxpool] scrub: dropped unknown provider block type "${type}"`);
      continue;
    }
    out.push(block);
  }
  if (!changed) return null;
  if (out.length === 0) out.push({ type: 'text', text: SCRUB_PLACEHOLDER }); // finding 3
  return { ...json, content: out };
}

/**
 * Streaming-lane scrub state. Feed it each raw SSE chunk BEFORE res.write; it returns
 * the bytes to write (possibly rewritten, possibly split — renumbering can change an
 * event's length). Parse-level, not regex-level: SSE events are small and framed, and a
 * regex cannot renumber `index` fields safely.
 */
export class ProviderThinkingScrubber {
  constructor({ onScrub } = {}) {
    this.onScrub = onScrub || null;   // fires once per scrubbed block (instrumentation)
    this.rewrite = null;              // Map oldIndex -> newIndex (-1 = suppressed)
    this.keptCount = 0;
    this.sawAnyThinking = false;
    this.buffer = '';                 // incomplete SSE tail
    this.scrubbedCount = 0;
  }

  /** Process one decoded chunk; returns the string to write (may be ''). */
  push(text) {
    this.buffer += text;
    const events = this.buffer.split('\n\n');
    this.buffer = events.pop() ?? '';
    let out = '';
    for (const ev of events) out += this.event(ev);
    return out;
  }

  /** Flush at stream end: process any trailing event without a blank line. */
  flush() {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? this.event(rest) : '';
  }

  event(ev) {
    const lines = ev.split('\n');
    let data = null;
    let dataLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('data:')) { data = lines[i].slice(5).trimStart(); dataLine = i; break; }
    }
    if (data == null) return ev + '\n\n';                    // non-data frame (event:, ping) — verbatim
    let j;
    try { j = JSON.parse(data); } catch { return ev + '\n\n'; } // malformed JSON — verbatim
    const t = j?.type;
    if (t === 'content_block_start') {
      const bt = j?.content_block?.type;
      if (bt === 'thinking' || bt === 'redacted_thinking' || !PROVIDER_ALLOWED_BLOCK_TYPES.has(String(bt))) {
        this.scrubbedCount++;
        this.sawAnyThinking = this.sawAnyThinking || bt === 'thinking' || bt === 'redacted_thinking';
        if (bt !== 'thinking' && bt !== 'redacted_thinking') {
          console.warn(`[Maxpool] scrub: dropped unknown provider block type "${bt}"`);
        }
        this.onScrub?.(bt);
        if (!this.rewrite) this.rewrite = new Map();
        this.rewrite.set(j.index, -1);                        // suppressed: start/delta/stop all dropped
        return '';
      }
      // Keep: renumber past every suppressed block before it.
      if (!this.rewrite) this.rewrite = new Map();
      this.keptCount = (this.keptCount || 0) + 1;
      const newIdx = this.nextIndex(j.index);
      if (newIdx !== j.index) { j = { ...j, index: newIdx }; return this.render(lines, dataLine, j) + '\n\n'; }
      return ev + '\n\n';
    }
    if (t === 'content_block_delta' || t === 'content_block_stop') {
      if (this.rewrite) {
        const mapped = this.rewrite.get(j.index);
        if (mapped === -1) return '';                        // belongs to a suppressed block
        if (mapped !== undefined && mapped !== j.index) {
          j = { ...j, index: mapped };
          return this.render(lines, dataLine, j) + '\n\n';
        }
      }
      return ev + '\n\n';
    }
    if (t === 'message_delta' && this.scrubbedCount > 0 && !this.keptCount) {
      // Finding 3 (streaming): every block was suppressed — emit ONE complete placeholder
      // text block before the message closes, so the stored turn is never content:[].
      this.keptCount = 1;
      const startEv = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      const deltaEv = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SCRUB_PLACEHOLDER } };
      const stopEv = { type: 'content_block_stop', index: 0 };
      return `event: content_block_start\ndata: ${JSON.stringify(startEv)}\n\n`
        + `event: content_block_delta\ndata: ${JSON.stringify(deltaEv)}\n\n`
        + `event: content_block_stop\ndata: ${JSON.stringify(stopEv)}\n\n`
        + ev + '\n\n';
    }
    // message_start / message_stop / ping / usage: verbatim
    return ev + '\n\n';
  }

  nextIndex(oldIdx) {
    // Compute the renumbered index for a KEPT block: count how many suppressed blocks
    // (map value -1) sit before it, subtract. Deterministic; no array reliance.
    let shift = 0;
    for (const [o, n] of this.rewrite) if (o < oldIdx && n === -1) shift++;
    const mapped = oldIdx - shift;
    this.rewrite.set(oldIdx, mapped);
    return mapped;
  }

  render(lines, dataLine, j) {
    lines[dataLine] = 'data: ' + JSON.stringify(j);
    return lines.join('\n');
  }
}

/** Is the scrub active for this request? (config flag + provider account) */
export function scrubEnabledFor(account, config) {
  return Boolean(config?.providerThinkingScrub) && account?.type === 'provider';
}
