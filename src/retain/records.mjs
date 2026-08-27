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
  USER_DENY_REASON,
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

  // Three more that appeared in a live corpus after the two above, caught by
  // the same refusal. Measured over 261 depth-0 sessions: custom-title 12,319
  // records, history-suppression 412, cost-state 6.
  //
  // `custom-title` is `{customTitle, sessionId}` and customTitle is written by
  // the HUMAN, so it is the one of the three that can carry a client name or a
  // person. `ai-title` is already dropped for the machine-written equivalent;
  // a hand-typed title is strictly more identifying, not less.
  //
  // `history-suppression` is `{sessionId, cause, ts}` where cause is a token
  // such as `fork_inherit`. No user text.
  //
  // `cost-state` is per-session bookkeeping: totalCostUSD, the tool durations,
  // totalLinesAdded/Removed, a modelUsage map and `startTime` as a raw
  // millisecond epoch. The line counts are tempting -- they are the same
  // measurement §4.1 reconstructs from structuredPatch -- but startTime alone
  // would reinstate to the millisecond exactly what quantise() spent the
  // timestamp budget removing, so the record is dropped whole rather than
  // filtered. Admitting the counts is a separate decision with its own review.
  'custom-title': 'drop',
  'history-suppression': 'drop',
  'cost-state': 'drop',
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

/**
 * The prose half of the two tables above: which fields of a RETAINED record
 * hold text a reader must be shown.
 *
 * `extractProseBySession` in pipeline.mjs used to answer this question a
 * second time, by naming two record types, two block types and a generic
 * scrape of an attachment's string values. That second list went stale the
 * moment a `queued_command`'s `prompt` stopped being a raw string and became a
 * retained block array: the scrape found no string under it, the prompt
 * vanished from deident-candidates.txt, and the archive shipped it anyway,
 * with the export exiting 0 and every check green. 506 of the 527 prompts in
 * the corpus it was measured on had exactly the shape that regressed.
 *
 * That class is the worst one this tool has: the candidates file is what a
 * human reads, and the semantic pass is the only producer that can catch a
 * name nothing else recognises. A name that is retained but never put in front
 * of the reader is un-declarable BY CONSTRUCTION. It is also the fourth time
 * two lists have answered one question here, so there is one list, and the
 * extractor reads it rather than restating it.
 *
 * Keyed by FIELD NAME rather than by record type, because a field name is what
 * survives retention: `retainTurn` and `retainAttachment` emit the SAME block
 * array under different keys, and `retainContent` is already polymorphic over
 * the array and string forms. So is this table.
 *
 *   'prose'  a reader must see it. An array is walked as retained blocks; a
 *            string is shown as it stands.
 *   'skip'   an identifier, a stamp, a role, a tool name, or the one gap
 *            docs/limits.md declares. Not descended into either.
 *
 * An UNDECLARED field falls to 'prose', because between showing the reader a
 * uuid and hiding a sentence from them, only one of the two is the bug this
 * table exists for. F204 then fails on the undeclared field, so the fail-open
 * default buys safety without buying silence.
 */
export const PROSE_FIELDS = Object.freeze({
  text: 'prose', // a `text` block, `last-prompt`, `queue-operation`
  thinking: 'prose',
  content: 'prose', // `message.content` blocks, and a pasted file's body
  prompt: 'prose', // a `queued_command`
  snippet: 'prose', // an `edited_text_file`
  filename: 'prose', // third-party names live in the paths a person types

  type: 'skip',
  subtype: 'skip',
  uuid: 'skip',
  parentUuid: 'skip',
  sessionId: 'skip',
  id: 'skip',
  tool_use_id: 'skip',
  timestamp: 'skip',
  cwd: 'skip',
  role: 'skip',
  model: 'skip',
  mode: 'skip',
  operation: 'skip',
  name: 'skip', // the tool NAME, `Edit`, not what it touched
  redacted: 'skip', // the placeholder BLOCK_DECISIONS emits in place of a body
  result_form: 'skip',
  // A tool's parameters are the one free text in the archive no reader is ever
  // shown. docs/limits.md states that gap with its measurement rather than
  // leaving it to be discovered, so it is DECLARED here, not omitted here.
  input: 'skip',
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
      return retainMode(rec, ctx, where);
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
  return retainContent(content, ctx, where, 'message.content');
}

/**
 * The one dispatch. `message.content` is not the only field in the corpus that
 * holds this shape: a `queued_command` attachment's `prompt` holds the same
 * block array, and it used to be copied into the output verbatim, so
 * BLOCK_DECISIONS never saw it. Measured on a shipped archive: 13 base64
 * images, 2.7 MB, reached the recipient in full through that second path while
 * the identical blocks on the message path were replaced with a placeholder.
 *
 * That is the `document` bug again: two lists answering one question, one of
 * them maintained. There is one list now, and every caller reaches it here.
 */
function retainContent(content, ctx, where, what) {
  if (content === undefined || content === null) return [];
  if (Array.isArray(content)) return retainBlocks(content, ctx, where);
  if (typeof content === 'string') {
    return content.length === 0 ? [] : retainBlocks([{ type: 'text', text: content }], ctx, where);
  }
  throw unknown(`a ${what} that is neither an array nor a string (${typeof content})`, where);
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
      const { text } = stripAuthored(block.text, ctx);
      return text.length === 0 ? null : { type: 'text', text };
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
      // share, 70.4% of the archive, most of which is record scaffolding and
      // minted identifiers that cannot hold a name at all.
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

/**
 * The one stripping order every kept string goes through.
 *
 * Injections first, because a `<system-reminder>` is nobody's text and taking
 * it out can empty the string outright. Then the deny-listed PATHS inside
 * prose, removed one token at a time rather than by withholding the turn: an
 * assistant paragraph naming `…/private/vendor-search/SCORECARD.md` is scoring
 * evidence with one token in it that must not ship. Then the whole-block
 * denial, which is coarser on purpose.
 *
 * There were three copies of this order and one of them, retainPrompt's, was
 * missing the first step entirely. One order, one place, so the next copy
 * cannot lose a step quietly.
 *
 * @returns {{text: string, denied: boolean}} the stripped text or a
 *   DENIED_MARKER, and '' when nothing authored is left
 */
function stripAuthored(raw, ctx) {
  const text = stripDeniedPaths(stripInjected(raw, ctx), ctx);
  if (text.length === 0) return { text: '', denied: false };
  const why = deniedTextReason(text);
  if (why === null) return { text, denied: false };
  const bytes = Buffer.byteLength(text, 'utf8');
  ctx.stats.deniedBlocks += 1;
  ctx.stats.deniedBytes += bytes;
  return { text: DENIED_MARKER(bytes, why), denied: true };
}

/** The LABEL of the first DENIED_TEXT pattern this prose trips, or null. */
export function deniedTextReason(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // Same lists as deniedReason at the sibling below. These two diverged and this
  // one gated user and assistant PROSE with the shipped patterns only, so a
  // per-person pattern withheld a tool result and not the sentence beside it.
  //
  // A label, never `m[0]`: the return value of this function IS the reason a
  // DENIED_MARKER ships, so a match returned here is the withheld value handed
  // straight to the recipient. See DENIED_PATH_REASON's comment, which reached
  // that conclusion for the path half of the same question.
  for (const { re, reason } of DENIED_TEXT) {
    re.lastIndex = 0;
    if (re.test(text)) return reason;
  }
  return userDenyReason(text);
}

/** Per-person rules, kept apart because they all collapse to one label. */
function userDenyReason(text) {
  for (const re of userDenyPatterns()) {
    re.lastIndex = 0;
    if (re.test(text)) return USER_DENY_REASON;
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

/** The LABEL of the first deny pattern this text trips, shipped first, or null. */
export function deniedReason(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const { re, reason } of DENIED_CONTENT) {
    re.lastIndex = 0;
    if (re.test(text)) return reason;
  }
  const mine = userDenyReason(text);
  if (mine !== null) return mine;
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
  //
  // `deniedReason` returns null for anything that is not a string, so this
  // gate USED to skip a payload silently the moment it arrived as a block
  // array rather than as text: a base64 image body, a credential and a harness
  // injection all walked past a check that was looking at `undefined`.
  // `attachmentText` is what makes the gate see a real string either way.
  const named = att.filename ?? att.file?.filePath ?? null;
  const raw = att.snippet ?? att.content ?? att.file?.content;
  const payload = attachmentText(raw);
  const why = deniedReason(named) ?? deniedReason(payload);
  if (why !== null) {
    ctx.stats.deniedBlocks += 1;
    ctx.stats.deniedBytes += Buffer.byteLength(payload, 'utf8');
    return null;
  }

  // Every arm reaches the ONE dispatch.
  //
  // `prompt` was routed through `retainContent` and these two were not, so a
  // pasted document and an edited file's snippet were copied into the output
  // verbatim: BLOCK_DECISIONS never saw them, `image` was never counted, the
  // `document` placeholder was never emitted, `stripInjected` never ran and
  // `deniedTextReason` never ran. Reproduced end to end through the real CLI:
  // exit 0, six green checks, and a manifest printing `0 images` and `0
  // harness injections` over an archive holding a base64 image body, a
  // credential and a `<system-reminder>` span. It fires 58 times in this
  // author's own live corpus.
  //
  // README promises "Dropped: all images, all pasted documents, all code
  // content" and docs/limits.md promises injected spans are stripped whatever
  // they are called. Those are promises to a stranger, so this was not a
  // disclosed limit.
  //
  // The container is unwrapped here rather than inside `retainContent`: the
  // dispatch takes the block array or the string, never the box one arrives
  // in.
  //
  // Which box, measured over all 3,567 session files on this machine rather
  // than guessed: every one of the 58 `file` attachments is
  // `att.content.file.content`, a string, beside a `filePath` and a line
  // count. `att.file.content` does not occur at all and is kept only because
  // `att.file.filePath` above it does. `edited_text_file` is a plain string
  // 322 times out of 322, and `queued_command` is a string 486 times against
  // 21 block arrays. So the block-array form is real, the string form is the
  // common one, and the wrapper is the shape that actually ships a pasted
  // file. Every arm unwraps, because an arm that does not is how this bug
  // arrives the fifth time; a fourth shape refuses by name.
  //
  // An empty block list is the same nothing an absent payload was, and the
  // all-null test below is what drops the record. Keep it reachable.
  const body =
    subtype === 'queued_command'
      ? { prompt: nullIfEmpty(retainContent(unwrap(att.prompt), ctx, where, 'queued_command prompt')) }
      : subtype === 'edited_text_file'
        ? {
            filename: att.filename ?? null,
            snippet: nullIfEmpty(retainContent(unwrap(att.snippet), ctx, where, 'edited_text_file snippet')),
          }
        : {
            filename: named,
            content: nullIfEmpty(retainContent(unwrap(raw), ctx, where, 'file attachment content')),
          };

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

const nullIfEmpty = (blocks) => (blocks.length === 0 ? null : blocks);

/**
 * The block array or string inside the box a pasted file arrives in.
 *
 * One level, and only when the box is not itself a payload: a string has no
 * `.file`, and neither does a block array, so both fall through untouched and
 * a shape that is none of the three reaches `retainContent` to be refused by
 * name rather than unwrapped on a guess.
 */
function unwrap(value) {
  const inner = value === null || typeof value !== 'object' ? undefined : value.file?.content;
  return inner === undefined ? value : inner;
}

/**
 * An attachment payload as one string for the deny gate to read.
 *
 * Every string leaf joined, rather than JSON.stringify: a Windows path inside
 * a block would arrive at DENIED_PATH_RE with its separators doubled, and the
 * byte count the manifest reports would be the count of the JSON envelope
 * rather than of the text that was withheld.
 */
function attachmentText(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  const parts = [];
  const walk = (v) => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  return parts.join(String.fromCharCode(10));
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
  // These carry user prose, so they carry everything prose carries, and they
  // were the one keep-path with no denial check at all. Measured on a real
  // export: `private/payroll-ledger/backfill-payload…` and
  // `.gitignore:8:/private/` survived here after every other route had been
  // closed. The path goes and the prompt stays: §C3 keeps this class precisely
  // because it carries text found nowhere else.
  //
  // What they also carry is the harness's own injections, which this path
  // stripped on the message side and shipped whole here, with
  // injectedBytesDropped reading 0 for every one of them.
  const { text, denied } = stripAuthored(rawPrompt, ctx);
  // A prompt that was nothing but an injection is nothing anybody authored.
  if (text.length === 0) return null;
  if (denied) {
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

/**
 * The last deliberate fail-open in this table, and a high-frequency one:
 * 7,400 `mode` records in the live corpus.
 *
 * This read `typeof rec.mode === 'string' ? rec.mode : JSON.stringify(...)`,
 * so a non-string skipped every guarantee in this file at once. Constructed
 * against the shipped code, a `mode` holding an object came out as one string
 * carrying a deny-listed path, a memory filename, an intact
 * `<system-reminder>` span and a credential shape, with deniedBlocks 0,
 * deniedBytes 0, deniedPaths 0, injectedBytesDropped 0, and no refusal.
 *
 * Every mode in this corpus is a string, and that is a fact about one harness,
 * not a guarantee: retainContent already refuses on a container that is
 * neither array nor string, for the same reason (BRIEF §4.4).
 */
function retainMode(rec, ctx, where) {
  if (typeof rec.mode !== 'string') {
    throw unknown(`a mode record whose mode is not a string (${typeof rec.mode})`, where, 'a non-string mode');
  }
  const { text: value } = stripAuthored(rec.mode, ctx);
  if (value.length === 0) return null;
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
  proseFields: PROSE_FIELDS,
});
