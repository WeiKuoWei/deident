// The retention table: PLAN §3 as code.
//
// BRIEF §4.4: enumerate every record type and decide each one DELIBERATELY;
// do not whitelist by guessing. An unknown type is therefore a refusal, not a
// silent drop, a new Claude Code version adding a record type is precisely
// the case §4.4 was written about, and the failure mode it warns of is user
// text being discarded without anybody noticing.
//
// Counts in the comments were measured over the full depth-0 corpus.

import { RefusalError } from '../cli/errors.mjs';
import { userDenyTokens, userDenyPatterns } from '../policy/userdeny.mjs';
import { retainToolUseResult, distillToolResult, lineCount } from './toolresult.mjs';
import {
  KEEP_THINKING_BLOCKS,
  TIMESTAMP_QUANTUM_MS,
  CODE_VALUED_TOOL_PARAMS,
  DENIED_CONTENT,
  DENIED_PATH_RE,
  DENIED_PATH_HEAD_RE,
  DENIED_PATH_REASON,
  PATH_TOKEN_RE,
  DENIED_PATH_MARKER,
  DENIED_MARKER,
  DENIED_TEXT,
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
  // live corpus DURING the acceptance run and were caught by I7, the refusal
  // is the mechanism working, not a defect in it.
  //
  // Both are artifact-comment bookkeeping and neither carries a user turn.
  // `artifact-comment-monitor` holds an artifact uuid, its human title and a
  // millisecond stamp. `artifact-autoreact-ledger` holds `accountUuid`, and on
  // the development machine that was the SAME account uuid that §F5 names as
  // the identifier no detector matches, arriving on a record
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

// `shape-only` is a third decision beside keep and drop, and it exists for one
// block type. Calling it `keep` would put a reviewed decision in this table
// that no longer describes what happens: the block survives and its payload
// does not. See retainBlock's tool_result case for the measurement.
const BLOCK_DECISIONS = Object.freeze({
  tool_result: 'shape-only',
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
      // Was `toolResultBytesOmitted`, which counted the middle of a truncated
      // result. Nothing is truncated now, so the honest counter is how many
      // results there were and how much they weighed.
      toolResults: 0,
      toolResultBytesDropped: 0,
      toolParamBytes: 0,
      dedupedPrompts: 0,
      injectedBytesDropped: 0,
      deniedBlocks: 0,
      deniedBytes: 0,
      deniedPaths: 0,
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
  // still has content or a distilled result, an empty shell is noise that the
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
 * text, none of them carrying a `toolUseResult`, so all 3,323 fell through to
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
    // `shape-only` and `keep` both route here; the difference is what
    // retainBlock emits, not whether it runs.
    //
    // It no longer takes `where`. That parameter existed so the one path that
    // could refuse (an unreviewed block nested inside a tool_result) could name
    // the file and line. Nothing under here refuses now, and a parameter
    // threaded through for a caller that is gone is the next thing to be
    // mistaken for a live one.
    const kept = retainBlock(block, ctx);
    if (kept !== null) out.push(kept);
  }
  return out;
}

function retainBlock(block, ctx) {
  switch (block.type) {
    case 'text': {
      if (typeof block.text !== 'string' || block.text.length === 0) return null;
      const rawText = stripInjected(block.text, ctx);
      if (rawText.length === 0) return null;
      // A deny-listed PATH inside prose is removed on its own, not by
      // withholding the turn: an assistant paragraph naming
      // `…/private/vendor-search/SCORECARD.md` is scoring evidence with one token
      // in it that must not ship.
      const text = stripDeniedPaths(rawText, ctx);
      const credential = deniedTextReason(text);
      if (credential !== null) {
        const bytes = Buffer.byteLength(text, 'utf8');
        ctx.stats.deniedBlocks += 1;
        ctx.stats.deniedBytes += bytes;
        return { type: 'text', text: DENIED_MARKER(bytes, credential) };
      }
      return { type: 'text', text };
    }

    case 'thinking': {
      if (!KEEP_THINKING_BLOCKS) return null;
      if (typeof block.thinking !== 'string' || block.thinking.length === 0) return null;
      // Agent reasoning quotes the same paths prose does.
      return { type: 'thinking', thinking: stripDeniedPaths(block.thinking, ctx) };
    }

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
      const input = stripCodeParams(block.input, ctx);
      // Measured on the archive built from the live corpus after the
      // tool_result cut: parameters are 1.48 MB of a 9.08 MB archive, 16.3%,
      // and they are the ONLY free text in it that no reader is ever shown.
      // The remainder line quotes this figure, so it is counted rather than
      // estimated: without it that line can only report the whole non-prose
      // share, 70.4%, of which 48.4% is record scaffolding and minted
      // identifiers that cannot hold a name at all.
      ctx.stats.toolParamBytes += Buffer.byteLength(JSON.stringify(input ?? null), 'utf8');
      return {
        type: 'tool_use',
        id: ctx.rewriteUuid(block.id),
        name: block.name ?? null,
        input,
      };
    }

    // Shape without content, and this is the whole contract: which tool,
    // whether it failed, how much came back.
    //
    // Twenty holes were reproduced against the shipped code on 2026-08-25.
    // Sorted by where the BYTES came from rather than by which module missed
    // them, seventeen of the twenty were in machine output: percent-encoded
    // CJK, HTML character references, Python bytes-repr, base64, zero-width
    // characters, a gcloud token, the secret half of an AWS credential pair,
    // cloud account identifiers. A human does not type base64 of a colleague's
    // name into a prompt. A program emits it, and the only route program
    // output takes into the archive is a tool_result.
    //
    // And nobody reads this surface. Measured over 250 of the 4,228 files in
    // the live corpus: tool_result is 47.2% of the three content surfaces by
    // bytes, against 30.5% prose and 22.3% tool_use parameters. tier1.mjs
    // builds the candidates file from prose blocks alone, so no reader and no
    // semantic pass ever saw a byte of it, and every miss in it was therefore
    // invisible rather than merely undetected.
    //
    // The cut is not reversible and does not need to be: cutting when the
    // recipient needed it, they come back and ask; not cutting when there was
    // a leak, the bytes have left.
    case 'tool_result': {
      const bytes = toolResultBytes(block.content);
      ctx.stats.toolResults += 1;
      ctx.stats.toolResultBytesDropped += bytes;
      return prune({
        type: 'tool_result',
        // The tool NAME is not on this block and is not copied onto it. It is
        // on the tool_use block this id pairs with, the rewrite is
        // deterministic, and makeUuidRewriter exists to keep exactly that
        // pairing resolvable. A second copy would be a second thing to keep
        // in step.
        tool_use_id: ctx.rewriteUuid(block.tool_use_id),
        // BRIEF §6 open question 1: is_error is what failure_signal is most
        // likely counted from, and suppressing it would silently RAISE OVR.
        // It was preserved verbatim through truncation before and is
        // preserved verbatim through deletion now.
        is_error: block.is_error === true ? true : null,
        result_bytes: bytes,
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

/**
 * ONE definition of a line, shared with toolresult.mjs.
 *
 * This used to be `split(NL).length` with no trailing-newline adjustment while
 * `lineCount` subtracted one and documented why, so the stripped Write
 * parameter reported one more line than `code_added_lines` for the same file:
 * 907 of 908 pairs in the corpus disagreed by exactly 1, one JSONL line apart
 * in the same export. A reader who picks the tool_use figure inflates every
 * Write by a line.
 */
function countLines(v) {
  if (typeof v === 'string') return lineCount(v);
  if (Array.isArray(v)) return v.reduce((a, x) => a + countLines(x?.new_string ?? x?.newString ?? ''), 0);
  return null;
}

function byteLength(v) {
  return typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : null;
}

/** The first DENIED_TEXT pattern this prose trips, or null. */
export function deniedTextReason(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // Same list as deniedReason at the sibling below. These two diverged and this
  // one gated user and assistant PROSE with the shipped patterns only, so a
  // per-person pattern withheld a tool result and not the sentence beside it.
  for (const re of [...DENIED_TEXT, ...userDenyPatterns()]) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m !== null) return m[0].trim();
  }
  return null;
}

/**
 * Is this token a path with a deny-listed SEGMENT?
 *
 * Segment-wise rather than DENIED_PATH_RE's leading-separator test, because
 * the caller already knows the token is a path: `private/vendor-search/x.md` has
 * no leading separator and is exactly the form that appears in prose.
 */
export function deniedPathToken(token) {
  for (const segment of token.split(/[\\\/]+/)) {
    if (segment !== '' && matchesDenySegment(segment)) return true;
  }
  return false;
}

function matchesDenySegment(segment) {
  const lower = segment.toLowerCase();
  return [...DENY_SEGMENT_TOKENS, ...userDenyTokens()].some((t) => lower.includes(t));
}

// Generic only. Per-person tokens arrive from beside the salt (userdeny.mjs).
const DENY_SEGMENT_TOKENS = Object.freeze(['private', 'identity', 'payroll']);

/** Replace every deny-listed path token in prose, counting what went. */
function stripDeniedPaths(text, ctx) {
  if (!/[\\\/]/.test(text)) return text;
  PATH_TOKEN_RE.lastIndex = 0;
  return text.replace(PATH_TOKEN_RE, (token) => {
    if (!deniedPathToken(token)) return token;
    ctx.stats.deniedPaths += 1;
    ctx.stats.deniedBytes += Buffer.byteLength(token, 'utf8');
    return DENIED_PATH_MARKER;
  });
}

/** The first deny pattern this text trips, shipped list first, or null. */
export function deniedReason(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const re of [...DENIED_CONTENT, ...userDenyPatterns()]) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m !== null) return m[0].trim();
  }
  // The deny-list applied to the cwd only, so a Read, an Edit or a directory
  // listing of a deny-listed path from an ALLOWED directory was invisible to
  // all three levels of privacy-tiers §4. The reason is generic on purpose:
  // one of the deny tokens is a person's name and this string ships.
  if (DENIED_PATH_RE.test(text) || DENIED_PATH_HEAD_RE.test(text)) return DENIED_PATH_REASON;
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
 * Bytes of text a tool returned, which is all that is kept of it.
 *
 * The payload the model read, not the JSON envelope around it: a consumer
 * comparing a 40 KB Read against a 200 B one is comparing what came back, and
 * counting the wrapper would make two identical results differ by their block
 * shape.
 *
 * Every shape is measured rather than refused, and that is a deliberate
 * relaxation of I7. The old path flattened this text in order to KEEP it, so
 * an unhandled nested block type was a silent drop of user text and a refusal
 * was the right answer; three types reached that refusal in production
 * (tool_reference, a nested document, an embedded PDF) and each one blocked a
 * whole export. Nothing is kept now, so an unrecognised shape can only change
 * a byte count. Refusing an export over that is docs/limits.md's cry-wolf
 * failure, and I7 still holds where it earns its keep: at the top level, and
 * on block types, where the text really would be kept.
 */
function toolResultBytes(content) {
  if (content === null || content === undefined) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return Buffer.byteLength(JSON.stringify(content), 'utf8');
  let bytes = 0;
  for (const b of content) {
    if (typeof b === 'string') bytes += Buffer.byteLength(b, 'utf8');
    else if (b !== null && typeof b === 'object' && typeof b.text === 'string') {
      bytes += Buffer.byteLength(b.text, 'utf8');
    } else if (b !== null && b !== undefined) {
      // An image, a document, a tool_reference, or whatever ships next. Its
      // size is the only thing about it that can be stated honestly.
      bytes += Buffer.byteLength(JSON.stringify(b), 'utf8');
    }
  }
  return bytes;
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
function retainPrompt(rec, ctx, kind, rawPrompt, extra = {}) {
  if (typeof rawPrompt !== 'string' || rawPrompt.trim().length === 0) return null;
  // These carry user prose, so they carry the same quoted paths prose does,
  // and they were the one keep-path with no denial check at all. Measured on a
  // real export: `private/payroll-ledger/backfill-payload…` and
  // `.gitignore:8:/private/` survived here after every other route had been
  // closed. The path goes and the prompt stays: §C3 keeps this class precisely
  // because it carries text found nowhere else.
  const text = stripDeniedPaths(rawPrompt, ctx);
  const why = deniedTextReason(text);
  if (why !== null) {
    const bytes = Buffer.byteLength(text, 'utf8');
    ctx.stats.deniedBlocks += 1;
    ctx.stats.deniedBytes += bytes;
    return prune({
      type: kind,
      uuid: rec.uuid ? ctx.rewriteUuid(rec.uuid) : null,
      sessionId: ctx.rewriteUuid(rec.sessionId),
      timestamp: quantise(rec.timestamp),
      cwd: rec.cwd ?? null,
      text: DENIED_MARKER(bytes, why),
      ...extra,
    });
  }
  // Keyed on the WHOLE text, not a 120-character prefix.
  //
  // PLAN C2/C3 justify this dedupe by the overlap between `last-prompt` and
  // `queue-operation`, where the texts are IDENTICAL. A prefix key is strictly
  // weaker than that justification requires, and the difference is not
  // theoretical: measured over all 225 sessions, 108 of 2,759 distinct prompts
  // (77,734 characters) were destroyed because they shared a boilerplate
  // opening, inter-session relay messages that all begin with the same fixed
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
 * §F5: account UUIDs match no detector, not path-shaped, not name-shaped, not
 * high-entropy-secret-shaped, so the residual scan is seeded with "any UUID
 * that is not a known message or session uuid". Measured on this corpus, ~10k
 * UUIDs appear inside tool output and prose (agent ids, scratchpad paths,
 * session references). If those are left alone, I5 can never pass and the gate
 * is permanently red, which is the §F7 failure mode again.
 *
 * Rewriting them deterministically costs nothing: a UUID carries no scoring
 * value, correlation between occurrences survives, and every UUID in the
 * output is then one deident minted, which is exactly what makes I5 a real
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
