// The retention table: PLAN §3 as code.
//
// BRIEF §4.4: enumerate every record type and decide each one DELIBERATELY;
// do not whitelist by guessing. An unknown type is therefore a refusal, not a
// silent drop — a new Claude Code version adding a record type is precisely
// the case §4.4 was written about, and the failure mode it warns of is user
// text being discarded without anybody noticing.
//
// Counts in the comments were measured over the full depth-0 corpus.

import { RefusalError } from '../cli/errors.mjs';
import { retainToolUseResult, distillToolResult } from './toolresult.mjs';
import {
  TOOL_RESULT_HEAD_BYTES,
  TOOL_RESULT_TAIL_BYTES,
  TRUNCATION_MARKER,
  KEEP_THINKING_BLOCKS,
  TIMESTAMP_QUANTUM_MS,
  CODE_VALUED_TOOL_PARAMS,
  DENIED_CONTENT,
  DENIED_PATH_RE,
  DENIED_PATH_REASON,
  DENIED_MARKER,
  INJECTED_SPANS,
} from './constants.mjs';

// PLAN §3.1. DROP-AFTER-USE types are consumed by cwdtrack at step 4 and
// dropped here at step 7; the ordering is load-bearing (PLAN §2).
const TOP_LEVEL = Object.freeze({
  assistant: 'keep',
  user: 'keep',
  attachment: 'keep',
  'last-prompt': 'keep',
  mode: 'keep',
  'queue-operation': 'keep',
  system: 'keep',
  'permission-mode': 'drop',
  'bridge-session': 'drop',
  'ai-title': 'drop',
  'file-history-snapshot': 'drop',
  'file-history-delta': 'drop',
  'atis-latch': 'drop',
  'agent-name': 'drop',
  'agent-setting': 'drop',
  'frame-link': 'drop',
  'pr-link': 'drop',
  relocated: 'drop-after-use',
  'worktree-state': 'drop-after-use',

  // These two did not exist when BRIEF §4.4 was written. They appeared in the
  // live corpus DURING the acceptance run and were caught by I7 — the refusal
  // is the mechanism working, not a defect in it.
  //
  // Both are artifact-comment bookkeeping and neither carries a user turn.
  // `artifact-comment-monitor` holds an artifact uuid, its human title and a
  // millisecond stamp. `artifact-autoreact-ledger` holds `accountUuid`, and
  // the value on this machine is the SAME `7594939e-…` that §F5 names
  // verbatim as the identifier no detector matches — arriving on a record
  // type the brief never saw. Dropping `bridge-session` alone would no longer
  // have been enough.
  'artifact-comment-monitor': 'drop',
  'artifact-autoreact-ledger': 'drop',
});

// PLAN §3.2. Only three of the 26 carry user text.
const ATTACHMENT_KEEP = Object.freeze(['queued_command', 'edited_text_file', 'file']);
const ATTACHMENT_DROP = Object.freeze([
  'total_tokens_reminder',
  'hook_additional_context',
  'hook_success',
  'task_reminder',
  'output_style',
  'skill_listing',
  'goal_status',
  'deferred_tools_delta',
  'ultra_effort_enter',
  'mcp_instructions_delta',
  'agent_listing_delta',
  'command_permissions',
  'date_change',
  'async_hook_response',
  'auto_mode',
  'nested_memory',
  'compact_file_reference',
  'read_truncation_notice',
  'invoked_skills',
  'hook_system_message',
  'hook_cancelled',
  'workflow_size_guideline_change',
  'dynamic_skill',
]);

// PLAN §3.1 row 9: keep compact_boundary only. away_summary is prose naming
// third parties who never consented (§F2) and is dropped even though it is
// user-adjacent.
const SYSTEM_KEEP = Object.freeze(['compact_boundary']);
const SYSTEM_DROP = Object.freeze([
  'stop_hook_summary',
  'turn_duration',
  'away_summary',
  'informational',
  'local_command',
  'scheduled_task_fire',
  'model_consent_fallback',
  'model_refusal_fallback',
]);

const BLOCK_DECISIONS = Object.freeze({
  tool_result: 'keep',
  tool_use: 'keep',
  thinking: 'keep',
  redacted_thinking: 'drop',
  text: 'keep',
  image: 'drop-counted',
  document: 'drop-counted',
});

export function newRetentionContext(rewriteUuid) {
  return {
    rewriteUuid,
    seenModes: new Set(),
    seenPrompts: new Set(),
    stats: {
      kept: 0,
      dropped: 0,
      userMessages: 0,
      assistantMessages: 0,
      images: 0,
      documents: 0,
      codeLinesCounted: 0,
      codeParamsDropped: 0,
      toolResultBytesOmitted: 0,
      dedupedPrompts: 0,
      injectedBytesDropped: 0,
      deniedBlocks: 0,
      deniedBytes: 0,
    },
  };
}

/**
 * @returns {{keep: boolean, record: object|null}}
 * @throws {RefusalError} on an unknown type, sub-type or content block (I7)
 */
export function retainRecord(rec, ctx, where) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    throw unknown('a record that is not a JSON object', where, 'a non-object record');
  }

  const decision = TOP_LEVEL[rec.type];
  if (decision === undefined) throw unknown(`top-level record type "${rec.type}"`, where, `type ${rec.type}`);
  if (decision !== 'keep') {
    ctx.stats.dropped += 1;
    return DROPPED;
  }

  const out = retainByType(rec, ctx, where);
  if (out === null) {
    ctx.stats.dropped += 1;
    return DROPPED;
  }
  ctx.stats.kept += 1;
  return { keep: true, record: out };
}

const DROPPED = Object.freeze({ keep: false, record: null });

function retainByType(rec, ctx, where) {
  switch (rec.type) {
    case 'user':
    case 'assistant':
      return retainTurn(rec, ctx, where);
    case 'attachment':
      return retainAttachment(rec, ctx, where);
    case 'last-prompt':
      return retainPrompt(rec, ctx, 'last-prompt', rec.lastPrompt);
    case 'queue-operation':
      return retainPrompt(rec, ctx, 'queue-operation', rec.content, { operation: rec.operation ?? null });
    case 'mode':
      return retainMode(rec, ctx);
    case 'system':
      return retainSystem(rec, ctx, where);
    default:
      throw unknown(`top-level record type "${rec.type}"`, where);
  }
}

// ------------------------------------------------------------------- turns

function retainTurn(rec, ctx, where) {
  const msg = rec.message;
  const content = retainMessageContent(msg, ctx, where);

  // A turn whose every block was dropped carries nothing. Keep it only when it
  // still has content or a distilled result — an empty shell is noise that the
  // residual scan then has to walk.
  const distilled = 'toolUseResult' in rec ? retainToolUseResult(rec.toolUseResult) : null;
  if (content.length === 0 && distilled === null) return null;

  if (distilled !== null) {
    const d = distillToolResult(rec.toolUseResult);
    if (typeof d.code_added_lines === 'number') ctx.stats.codeLinesCounted += d.code_added_lines;
  }
  if (rec.type === 'user') ctx.stats.userMessages += 1;
  else ctx.stats.assistantMessages += 1;

  return prune({
    type: rec.type,
    uuid: ctx.rewriteUuid(rec.uuid),
    parentUuid: rec.parentUuid ? ctx.rewriteUuid(rec.parentUuid) : null,
    sessionId: ctx.rewriteUuid(rec.sessionId),
    timestamp: quantise(rec.timestamp),
    cwd: rec.cwd ?? null,
    isSidechain: rec.isSidechain === true ? true : null,
    isMeta: rec.isMeta === true ? true : null,
    message: {
      role: msg?.role ?? null,
      model: msg?.model ?? null,
      content,
    },
    toolUseResult: distilled,
  });
}

/**
 * `message.content` is a block array OR a plain string, and the string form was
 * silently dropped.
 *
 * Measured over all 225 depth-0 sessions: 3,323 `user` records carry
 * `message.content` as a string, 2,871,417 characters of user-typed prompt
 * text, none of them carrying a `toolUseResult` — so all 3,323 fell through to
 * `records.length === 0` and were counted as "dropped" beside `permission-mode`
 * and `ai-title`. 207 of the 225 files were affected, and two exported no user
 * prose at all.
 *
 * I7 does not fire on this, because the record type and the block types are all
 * known: it is the CONTAINER SHAPE that was unhandled, and an unhandled shape
 * fell through to a silent drop rather than a refusal. That is the one outcome
 * BRIEF §4.4's retention design forbids, so a third shape raises the same
 * refusal an unknown record type does.
 */
function retainMessageContent(msg, ctx, where) {
  const content = msg === null || typeof msg !== 'object' ? undefined : msg.content;
  if (content === undefined || content === null) return [];
  if (Array.isArray(content)) return retainBlocks(content, ctx, where);
  if (typeof content === 'string') {
    return content.length === 0 ? [] : retainBlocks([{ type: 'text', text: content }], ctx, where);
  }
  throw unknown(`a message.content that is neither an array nor a string (${typeof content})`, where);
}

function retainBlocks(blocks, ctx, where) {
  const out = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    const decision = BLOCK_DECISIONS[block.type];
    if (decision === undefined) throw unknown(`content block type "${block.type}"`, where, `block ${block.type}`);
    if (decision === 'drop') continue;
    if (decision === 'drop-counted') {
      if (block.type === 'image') ctx.stats.images += 1;
      else ctx.stats.documents += 1;
      out.push({ type: block.type, redacted: 'replaced with a placeholder' });
      continue;
    }
    const kept = retainBlock(block, ctx);
    if (kept !== null) out.push(kept);
  }
  return out;
}

function retainBlock(block, ctx) {
  switch (block.type) {
    case 'text': {
      if (typeof block.text !== 'string' || block.text.length === 0) return null;
      const text = stripInjected(block.text, ctx);
      return text.length > 0 ? { type: 'text', text } : null;
    }

    case 'thinking':
      if (!KEEP_THINKING_BLOCKS) return null;
      return typeof block.thinking === 'string' && block.thinking.length > 0
        ? { type: 'thinking', thinking: block.thinking }
        : null;

    case 'tool_use': {
      // What the tool was ASKED to touch. `Read`, `Edit`, `Write` and
      // `SendUserFile` all carry the path as a parameter, and every one of
      // them ran from an ordinary cwd while naming a deny-listed file. The
      // tool NAME survives, because "an Edit happened" is scoring evidence and
      // carries no path.
      const why = deniedToolUse(block.input);
      if (why !== null) {
        ctx.stats.deniedBlocks += 1;
        const bytes = Buffer.byteLength(JSON.stringify(block.input ?? null), 'utf8');
        ctx.stats.deniedBytes += bytes;
        return {
          type: 'tool_use',
          id: ctx.rewriteUuid(block.id),
          name: block.name ?? null,
          input: { redacted: DENIED_MARKER(bytes, why) },
        };
      }
      return {
        type: 'tool_use',
        id: ctx.rewriteUuid(block.id),
        name: block.name ?? null,
        input: stripCodeParams(block.input, ctx),
      };
    }

    case 'tool_result': {
      const denied = denyToolResult(block.content, ctx);
      if (denied !== null) {
        return prune({
          type: 'tool_result',
          tool_use_id: ctx.rewriteUuid(block.tool_use_id),
          is_error: block.is_error === true ? true : null,
          content: denied,
          redacted_omitted_bytes: null,
        });
      }
      const { text, omitted } = capToolResult(block.content, ctx);
      return prune({
        type: 'tool_result',
        tool_use_id: ctx.rewriteUuid(block.tool_use_id),
        // §6 open question 1: is_error is what failure_signal is most likely
        // counted from, and suppressing it would raise OVR. Kept verbatim,
        // before and independently of any truncation.
        is_error: block.is_error === true ? true : null,
        content: text,
        redacted_omitted_bytes: omitted > 0 ? omitted : null,
      });
    }

    default:
      return null;
  }
}

/**
 * The first denied path named by any string in a tool's parameters, or null.
 * Keys as well as values: a file-history map is keyed by absolute filename.
 */
function deniedToolUse(input) {
  if (input === null || typeof input !== 'object') return deniedReason(input);
  for (const [k, v] of Object.entries(input)) {
    const why = deniedReason(k) ?? (typeof v === 'string' ? deniedReason(v) : deniedToolUse(v));
    if (why !== null) return why;
  }
  return null;
}

/** BRIEF §3: code content is never exported, only counted. */
function stripCodeParams(input, ctx) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input ?? null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (CODE_VALUED_TOOL_PARAMS.includes(k)) {
      ctx.stats.codeParamsDropped += 1;
      out[k] = { redacted: 'code removed', lines: countLines(v), bytes: byteLength(v) };
      continue;
    }
    out[k] = v;
  }
  return out;
}

function countLines(v) {
  if (typeof v === 'string') return v.length === 0 ? 0 : v.split('\n').length;
  if (Array.isArray(v)) return v.reduce((a, x) => a + countLines(x?.new_string ?? x?.newString ?? ''), 0);
  return null;
}

function byteLength(v) {
  return typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : null;
}

/** The first DENIED_CONTENT pattern this text trips, or null. */
export function deniedReason(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const re of DENIED_CONTENT) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m !== null) return m[0].trim();
  }
  // The deny-list applied to the cwd only, so a Read, an Edit or a directory
  // listing of a deny-listed path from an ALLOWED directory was invisible to
  // all three levels of privacy-tiers §4. The reason is generic on purpose:
  // one of the deny tokens is a person's name and this string ships.
  if (DENIED_PATH_RE.test(text)) return DENIED_PATH_REASON;
  return null;
}

/**
 * Remove the harness's own injected spans from authored text.
 *
 * These carry the owner's memory index and local command output into sessions
 * that never mentioned either, and nobody wrote them, so nothing authored is
 * lost. Counted so the manifest can say how much went.
 */
function stripInjected(text, ctx) {
  let out = text;
  for (const re of INJECTED_SPANS) {
    re.lastIndex = 0;
    out = out.replace(re, '');
  }
  if (out.length !== text.length) {
    ctx.stats.injectedBytesDropped += Buffer.byteLength(text, 'utf8') - Buffer.byteLength(out, 'utf8');
  }
  return out.trim();
}

/**
 * A tool result that read a denied file leaves as a count, not as its content.
 *
 * The whole result goes, not the matching line: a file listing is denied by
 * one entry in it, and half a private file is still a private file.
 */
function denyToolResult(content, ctx) {
  const text = flattenContent(content);
  const why = deniedReason(text);
  if (why === null) return null;
  ctx.stats.deniedBlocks += 1;
  const bytes = Buffer.byteLength(text, 'utf8');
  ctx.stats.deniedBytes += bytes;
  return DENIED_MARKER(bytes, why);
}

/**
 * Head + tail cap. §6 open question 1 is unresolved, so the caps in
 * constants.mjs are generous and the omission is stated in the record rather
 * than being silent.
 */
function capToolResult(content, ctx) {
  const text = flattenContent(content);
  if (text === null) return { text: null, omitted: 0 };
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= TOOL_RESULT_HEAD_BYTES + TOOL_RESULT_TAIL_BYTES) return { text, omitted: 0 };

  const buf = Buffer.from(text, 'utf8');
  const head = buf.subarray(0, TOOL_RESULT_HEAD_BYTES).toString('utf8');
  const tail = buf.subarray(buf.length - TOOL_RESULT_TAIL_BYTES).toString('utf8');
  const omitted = bytes - TOOL_RESULT_HEAD_BYTES - TOOL_RESULT_TAIL_BYTES;
  ctx.stats.toolResultBytesOmitted += omitted;
  return { text: head + TRUNCATION_MARKER(omitted) + tail, omitted };
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === null || content === undefined ? null : JSON.stringify(content);
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text);
    else if (b && typeof b === 'object' && b.type === 'image') parts.push('[image removed by deident]');
  }
  return parts.join('\n');
}

// ------------------------------------------------------------- attachments

function retainAttachment(rec, ctx, where) {
  const att = rec.attachment;
  const subtype = att && typeof att === 'object' ? att.type : undefined;
  if (subtype === undefined) throw unknown('an attachment with no sub-type', where);
  if (ATTACHMENT_DROP.includes(subtype)) return null;
  if (!ATTACHMENT_KEEP.includes(subtype)) {
    throw unknown(`attachment sub-type "${subtype}"`, where, `attachment ${subtype}`);
  }

  // An attachment names the file it came from, so the denial is exact here.
  const named = att.filename ?? att.file?.filePath ?? null;
  const why = deniedReason(named) ?? deniedReason(att.snippet ?? att.content ?? att.file?.content ?? '');
  if (why !== null) {
    ctx.stats.deniedBlocks += 1;
    ctx.stats.deniedBytes += Buffer.byteLength(
      String(att.snippet ?? att.content ?? att.file?.content ?? ''),
      'utf8',
    );
    return null;
  }

  const body =
    subtype === 'queued_command'
      ? { prompt: att.prompt ?? null }
      : subtype === 'edited_text_file'
        ? { filename: att.filename ?? null, snippet: att.snippet ?? null }
        : { filename: att.filename ?? att.file?.filePath ?? null, content: att.content ?? att.file?.content ?? null };

  if (Object.values(body).every((v) => v === null)) return null;

  return prune({
    type: 'attachment',
    uuid: ctx.rewriteUuid(rec.uuid),
    sessionId: ctx.rewriteUuid(rec.sessionId),
    timestamp: quantise(rec.timestamp),
    cwd: rec.cwd ?? null,
    attachment: { type: subtype, ...body },
  });
}

// ------------------------------------------- prompts carried outside message

/**
 * BRIEF §4.4 and PLAN C2/C3. `queue-operation` carries user text that appears
 * nowhere else 70.3% of the time; `last-prompt` 32.2% of the time. Both are
 * kept, and deduped against each other within a session (C3) so the overlap
 * does not double-count the Framing axis.
 */
function retainPrompt(rec, ctx, kind, text, extra = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  // Keyed on the WHOLE text, not a 120-character prefix.
  //
  // PLAN C2/C3 justify this dedupe by the overlap between `last-prompt` and
  // `queue-operation`, where the texts are IDENTICAL. A prefix key is strictly
  // weaker than that justification requires, and the difference is not
  // theoretical: measured over all 225 sessions, 108 of 2,759 distinct prompts
  // (77,734 characters) were destroyed because they shared a boilerplate
  // opening — inter-session relay messages that all begin with the same fixed
  // envelope. That is the C3 evidence class being thrown away by the very step
  // meant to protect it.
  const key = text;
  if (ctx.seenPrompts.has(key)) {
    ctx.stats.dedupedPrompts += 1;
    return null;
  }
  ctx.seenPrompts.add(key);
  return prune({
    type: kind,
    uuid: rec.uuid ? ctx.rewriteUuid(rec.uuid) : null,
    sessionId: ctx.rewriteUuid(rec.sessionId),
    timestamp: quantise(rec.timestamp),
    cwd: rec.cwd ?? null,
    text,
    ...extra,
  });
}

function retainMode(rec, ctx) {
  const value = typeof rec.mode === 'string' ? rec.mode : JSON.stringify(rec.mode ?? null);
  if (ctx.seenModes.has(value)) return null;
  ctx.seenModes.add(value);
  return prune({ type: 'mode', sessionId: ctx.rewriteUuid(rec.sessionId), mode: value });
}

function retainSystem(rec, ctx, where) {
  const subtype = rec.subtype ?? null;
  if (subtype === null) throw unknown('a system record with no subtype', where);
  if (SYSTEM_DROP.includes(subtype)) return null;
  if (!SYSTEM_KEEP.includes(subtype)) throw unknown(`system subtype "${subtype}"`, where, `system ${subtype}`);
  return prune({
    type: 'system',
    subtype,
    uuid: rec.uuid ? ctx.rewriteUuid(rec.uuid) : null,
    sessionId: ctx.rewriteUuid(rec.sessionId),
    timestamp: quantise(rec.timestamp),
  });
}

// ------------------------------------------------------------------ shared

const UUID_IN_TEXT = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * Rewrite every UUID inside retained STRINGS, not only in uuid-shaped fields.
 *
 * §F5: account UUIDs match no detector — not path-shaped, not name-shaped, not
 * high-entropy-secret-shaped — so the residual scan is seeded with "any UUID
 * that is not a known message or session uuid". Measured on this corpus, ~10k
 * UUIDs appear inside tool output and prose (agent ids, scratchpad paths,
 * session references). If those are left alone, I5 can never pass and the gate
 * is permanently red, which is the §F7 failure mode again.
 *
 * Rewriting them deterministically costs nothing: a UUID carries no scoring
 * value, correlation between occurrences survives, and every UUID in the
 * output is then one deident minted — which is exactly what makes I5 a real
 * check rather than a wish.
 */
export function rewriteUuidsInRecord(value, rewriteUuid) {
  if (typeof value === 'string') {
    if (!value.includes('-')) return value;
    UUID_IN_TEXT.lastIndex = 0;
    return value.replace(UUID_IN_TEXT, (u) => rewriteUuid(u) ?? u);
  }
  if (Array.isArray(value)) return value.map((v) => rewriteUuidsInRecord(v, rewriteUuid));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[rewriteUuidsInRecord(k, rewriteUuid)] = rewriteUuidsInRecord(v, rewriteUuid);
    }
    return out;
  }
  return value;
}

/** §F4: millisecond stamps fingerprint the device. Quantise to the minute. */
export function quantise(timestamp) {
  if (typeof timestamp !== 'string') return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  return new Date(Math.floor(ms / TIMESTAMP_QUANTUM_MS) * TIMESTAMP_QUANTUM_MS)
    .toISOString()
    .replace(/\.000Z$/, 'Z');
}

/** Drop null-valued keys so the export does not carry empty scaffolding. */
function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function unknown(what, where, kind = null) {
  return new RefusalError(`deident has never seen ${what}`, {
    why: [
      where ? `  ${where.file}  line ${where.line}` : '',
      '',
      'deident refuses to guess whether a record it has never seen carries user',
      'text. Every type in the export has an explicit, reviewed decision, and a',
      'silent drop is how the highest-value user turns get lost (BRIEF §4.4).',
    ].filter((l) => l !== ''),
    remedies: [
      { label: 'Report the type above', command: 'file an issue against deident' },
      { label: 'Or drop just these records', command: 'deident export --skip-unknown-types' },
      { label: 'Meanwhile, export older logs', command: 'deident export --root <older copy>' },
    ],
    // `unknown` names the class the escape hatch counts. Claude Code ships a
    // new record type every few weeks (§F4 records 2.1.215 -> 2.1.238 inside
    // one corpus), so refusal stays the default without being terminal: one
    // such line in one session of one teammate used to block that person's
    // whole export, with "export older logs" as the only remedy offered.
    detail: { ...(where ?? {}), unknown: kind ?? what },
  });
}

export const RETENTION_TABLE = Object.freeze({
  topLevel: TOP_LEVEL,
  attachmentKeep: ATTACHMENT_KEEP,
  attachmentDrop: ATTACHMENT_DROP,
  systemKeep: SYSTEM_KEEP,
  systemDrop: SYSTEM_DROP,
  blocks: BLOCK_DECISIONS,
});
