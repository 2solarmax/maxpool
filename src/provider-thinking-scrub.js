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
 * known Anthropic types; anything else is dropped.
 * `redacted_thinking` is also scrubbed — a provider can never produce a valid one.
 *
 * Red-team findings 1+6 (2026-11-06, round 3): the KNOWN provider tool blocks —
 * mcp_tool_use / mcp_tool_result / server_tool_use / web_search_tool_result — must not be
 * dropped either (that deleted GLM's web-tool calls and fetched results from the client
 * transcript). They are CONVERTED to text in both lanes via foreignToolBlockText(), the
 * same convention the REQUEST-side repair (convertForeignServerTools in server.js) uses —
 * one exported helper, no drifting copies. Truly unknown types stay dropped.
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

/**
 * Provider-authored TOOL blocks the scrub CONVERTS to text (red-team 2026-11-06 round-3
 * finding 1) instead of dropping. GLM emits these on response turns (web search, MCP
 * tools like webReader); the client transcript must keep what was called and found, in
 * the same text form the request-side repair produces. Everything else unknown = dropped.
 */
const PROVIDER_CONVERTIBLE_TOOL_TYPES = new Set([
  'server_tool_use', 'web_search_tool_result', 'mcp_tool_use', 'mcp_tool_result',
]);

const SCRUB_PLACEHOLDER = '(reasoning omitted)';

// ── ONE converter shared by the request-side repair (server.js convertForeignServerTools)
// ── and both scrub lanes. Pure: block in → string out, no globals, no state.

/**
 * Text rendering of one provider tool block, request-side convention:
 *   server_tool_use         → "[searched the web for: <query>]" / "[used <name>]"
 *   mcp_tool_use            → "[called <name> (<server>) on <input, 300 code points>]"
 *   web_search_tool_result  → "[search results: …]"
 *   mcp_tool_result         → "[<name> result: …]" / "[mcp tool returned no usable results]"
 * Truncation is by CODE POINTS: a raw .slice can split a surrogate pair (an emoji at
 * char 299), and a lone surrogate makes the body invalid JSON-UTF8 Anthropic 400s with
 * no repair path — killing the session the conversion is saving (red-team M1).
 */
export function foreignToolBlockText(b) {
  if (b?.type === 'server_tool_use') {
    const q = b.input?.query;
    return q ? `[searched the web for: ${q}]` : `[used ${b.name || 'a tool'}]`;
  }
  if (b?.type === 'mcp_tool_use') {
    const inp = JSON.stringify(b.input ?? {});
    return `[called ${b.name || 'a tool'}${b.server_name ? ` (${b.server_name})` : ''} on ${codePointClamp(inp, 300)}]`;
  }
  // Any result block (web_search_tool_result / mcp_tool_result) referring to a foreign call.
  const rows = Array.isArray(b?.content) ? b.content.slice() : [];
  // Fall back through the shapes a PROVIDER may use — the point of converting rather
  // than dropping is to keep what the search found; assuming Anthropic's {title,url}
  // would silently discard a GLM row that carries text instead.
  if (typeof b?.content === 'string' && b.content) rows.push(b.content); // a plain-string result (e.g. an error row) — keep it (red-team M6)
  const found = rows
    .map(r => [r?.title, r?.url].filter(Boolean).join(' — ')
      || (typeof r === 'string' ? r : (r?.text ?? r?.content ?? r?.snippet ?? '')))
    .map(t => (typeof t === 'string' ? codePointClamp(t, 300) : ''))
    .filter(Boolean).slice(0, 10);
  if (b?.type === 'mcp_tool_result') {
    // An MCP result carries {type:'text'} rows, not {title,url} — label it as the tool's
    // answer rather than "[search results]" so the transcript stays honest.
    return found.length ? `[${b.name || 'mcp tool'} result: ${found.join(' | ')}]` : '[mcp tool returned no usable results]';
  }
  return found.length ? `[search results: ${found.join(' | ')}]` : '[search returned no usable results]';
}

function codePointClamp(s, n) { return Array.from(s).slice(0, n).join(''); }

/** One summary line for the logs — per RESPONSE, not per block (red-team 2026-11-06 finding 6). */
export function describeScrub(stats) {
  const parts = [];
  if (stats.thinking) parts.push(`removed ${stats.thinking} provider thinking block(s)`);
  if (stats.converted) parts.push(`converted ${stats.converted} provider tool block(s)`);
  if (stats.unknown.length) parts.push(`dropped ${stats.unknown.length} unknown block(s): ${[...new Set(stats.unknown)].map(t => `"${t}"`).join(', ')}`);
  return parts.join(', ');
}

/** Streaming-lane block classifier: null = forward verbatim, 'drop' | block = convert. */
function scrubCell(bt) {
  if (bt === 'thinking' || bt === 'redacted_thinking') return 'drop';
  if (PROVIDER_CONVERTIBLE_TOOL_TYPES.has(String(bt))) return 'convert';
  if (PROVIDER_ALLOWED_BLOCK_TYPES.has(String(bt))) return 'forward';
  return 'drop';
}

/**
 * Scrub a COMPLETE parsed response body (buffered lane). Mutates nothing; returns a new
 * object when something was scrubbed, else null (caller forwards the original).
 * statsOut (optional object) receives { thinking, converted, unknown:[] }.
 */
export function scrubProviderResponseBody(json, statsOut) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.content)) return null;
  const stats = { thinking: 0, converted: 0, unknown: [] };
  let changed = false;
  const out = [];
  for (const block of json.content) {
    const cell = scrubCell(block?.type);
    if (cell === 'drop') {
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') stats.thinking++;
      else stats.unknown.push(String(block?.type));
      changed = true;
      continue;
    }
    if (cell === 'convert') {
      stats.converted++;
      out.push({ type: 'text', text: foreignToolBlockText(block) }); // round-3 finding 1
      changed = true;
      continue;
    }
    out.push(block);
  }
  if (!changed) return null;
  if (statsOut) Object.assign(statsOut, stats);
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
    this.convertedCount = 0;          // tool blocks converted to text (NOT counted in scrubbedCount)
    this._unknown = [];
    this._pending = null;             // { oldIndex, cell:'convert', block, json } while a convertible block streams
    this._stopped = false;            // placeholder already injected (message_delta or message_stop)
  }

  /** Per-response stats for describeScrub() — one summary line per response. */
  stats() { return { thinking: this.scrubbedCount, converted: this.convertedCount, unknown: this._unknown }; }

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
      const cell = scrubCell(bt);
      if (cell === 'drop') {
        this.scrubbedCount++;
        this.sawAnyThinking = this.sawAnyThinking || bt === 'thinking' || bt === 'redacted_thinking';
        if (bt !== 'thinking' && bt !== 'redacted_thinking') this._unknown.push(String(bt));
        this.onScrub?.(bt);
        if (!this.rewrite) this.rewrite = new Map();
        this.rewrite.set(j.index, -1);                        // suppressed: start/delta/stop all dropped
        return '';
      }
      if (cell === 'convert') {
        // Round-3 finding 1: buffer the whole block, then emit it as ONE text block at
        // the renumbered index — the client transcript keeps the call and its result.
        const newIdx = this.nextIndex(j.index);
        this.convertedCount++;
        this._pending = { oldIndex: j.index, block: { ...j.content_block }, json: '' };
        const startEv = { type: 'content_block_start', index: newIdx, content_block: { type: 'text', text: '' } };
        return `event: content_block_start\ndata: ${JSON.stringify(startEv)}\n\n`;
      }
      // Keep: renumber past every suppressed block before it.
      if (!this.rewrite) this.rewrite = new Map();
      this.keptCount = (this.keptCount || 0) + 1;
      const newIdx = this.nextIndex(j.index);
      if (newIdx !== j.index) { j = { ...j, index: newIdx }; return this.render(lines, dataLine, j) + '\n\n'; }
      return ev + '\n\n';
    }
    if (t === 'content_block_delta') {
      if (this._pending && j.index === this._pending.oldIndex) {
        const d = j.delta?.type;
        if (d === 'input_json_delta') this._pending.json += String(j.delta.partial_json ?? '');
        else if (d === 'text_delta') this._pending.block.text = (this._pending.block.text || '') + (j.delta.text ?? '');
        else if (d === 'thinking_delta' || d === 'signature_delta') { /* content only — ignored */ }
        else {
          // A delta type we do not model inside a convertible block: rather than guess
          // (a wrong guess DELETES provider content), fail open and convert from what we
          // have — an accurate bracket summary without the unknown payload.
          this._pending.unknownDelta = true;
        }
        return '';
      }
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
    if (t === 'content_block_stop') {
      if (this._pending && j.index === this._pending.oldIndex) {
        const p = this._pending;
        this._pending = null;
        const blockIdx = this.rewrite.get(p.oldIndex);
        const block = { ...p.block };
        if (p.json !== '') {
          try { block.input = JSON.parse(p.json); }
          catch { /* provider sent malformed partial JSON — convert from the metadata we hold */ }
        }
        const text = foreignToolBlockText(block);
        const deltaEv = { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text } };
        return `event: content_block_delta\ndata: ${JSON.stringify(deltaEv)}\n\nevent: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIdx })}\n\n`;
      }
      if (this.rewrite) {
        const mapped = this.rewrite.get(j.index);
        if (mapped === -1) return '';
        if (mapped !== undefined && mapped !== j.index) {
          j = { ...j, index: mapped };
          return this.render(lines, dataLine, j) + '\n\n';
        }
      }
      return ev + '\n\n';
    }
    if (t === 'message_delta' && this.scrubbedCount > 0 && !this.keptCount && !this.convertedCount) {
      // Finding 3 (streaming): every block was suppressed — emit ONE complete placeholder
      // text block before the message closes, so the stored turn is never content:[].
      // A converted tool block counts as content (round-3 finding 1) — no placeholder then.
      this.keptCount = 1;
      this._stopped = true;
      const startEv = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      const deltaEv = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SCRUB_PLACEHOLDER } };
      const stopEv = { type: 'content_block_stop', index: 0 };
      return `event: content_block_start\ndata: ${JSON.stringify(startEv)}\n\n`
        + `event: content_block_delta\ndata: ${JSON.stringify(deltaEv)}\n\n`
        + `event: content_block_stop\ndata: ${JSON.stringify(stopEv)}\n\n`
        + ev + '\n\n';
    }
    if (t === 'message_stop' && !this._stopped && this.scrubbedCount > 0 && !this.keptCount && !this.convertedCount) {
      // Finding 4: a thinking-only stream can close with message_stop and NO message_delta
      // (z.ai compat shape) — inject the placeholder block events BEFORE message_stop so
      // the stored turn is never content:[] on that path either.
      this.keptCount = 1;
      this._stopped = true;
      const startEv = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      const deltaEv = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SCRUB_PLACEHOLDER } };
      const stopEv = { type: 'content_block_stop', index: 0 };
      return `event: content_block_start\ndata: ${JSON.stringify(startEv)}\n\nevent: content_block_delta\ndata: ${JSON.stringify(deltaEv)}\n\nevent: content_block_stop\ndata: ${JSON.stringify(stopEv)}\n\n` + ev + '\n\n';
    }
    // message_start / message_stop / ping / usage: verbatim
    return ev + '\n\n';
  }

  nextIndex(oldIdx) {
    // Compute the renumbered index for a KEPT or CONVERTED block: count how many
    // suppressed blocks (map value -1) sit before it, subtract. Deterministic; no array reliance.
    if (!this.rewrite) this.rewrite = new Map();
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
