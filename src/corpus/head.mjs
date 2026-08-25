// Read only the HEAD of a session file, and pull out the first thing the person
// typed that a reader can judge.
//
// This exists for the triage stage, and the constraint is the whole reason it
// is a separate module: a triage that reads the whole session is the expensive
// stage wearing a hat. Measured on the live corpus (2026-08-24): 205 sessions,
// 833 MB, and each session's cwd plus its first user prompt truncated to 300
// characters is a 23,302-character payload. Reading the files whole to get that
// would cost the same as the pass triage exists to protect.
//
// Nothing here parses a slug and nothing here resolves a cwd (BRIEF §4.9): the
// caller already knows the workspace, from review.md, which is where the person
// decided it.

import fs from 'node:fs';
import { INJECTED_SPANS } from '../retain/constants.mjs';

/**
 * How much of a file to read.
 *
 * 64 KB was tried first and is not enough. Claude Code's first `user` record
 * carries the harness's injected context with it - CLAUDE.md, the memory index,
 * the skill list - and on this machine that record alone runs past 60 KB before
 * the person's own sentence starts. A head too short does not fail loudly; it
 * reports "no first user prompt", which reads as an empty session rather than as
 * a truncated read, and the reader then triages a blank row.
 *
 * 256 KB costs at most 52 MB of reads over a 205-session corpus, and most files
 * are smaller than that so the real figure is lower. It is a read, not a parse,
 * and it is bounded whatever the corpus does.
 */
export const HEAD_BYTES = 256 * 1024;

/**
 * A slash command as it actually arrives in a session record.
 *
 * Measured 2026-08-25 on the live corpus: `/clear` is stored as the 106
 * characters `<command-name>/clear</command-name>` followed by an empty
 * `<command-message>` and an empty `<command-args>`, and nothing else. It is
 * not a bare `/clear` string, which is why a triage stage looking for one found
 * none and showed the reader the raw envelope instead.
 */
const COMMAND_TAG = /<command-(?:name|message|args|contents)>([^]*?)<\/command-(?:name|message|args|contents)>/g;
const COMMAND_NAME = /<command-name>([^]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^]*?)<\/command-args>/;

/**
 * The command envelope rendered as what the person typed: `/goal ship it`, or
 * `/clear`.
 *
 * The envelope itself is structure, not prose. Rendering it raw spends 106 of
 * the characters this stage exists to ration on XML that says nothing, and a
 * reader who sees it cannot tell a session that opened with a context reset
 * from one whose first sentence happened to contain angle brackets.
 */
function unwrapCommand(text) {
  if (!COMMAND_NAME.test(text)) return text;
  const name = (text.match(COMMAND_NAME)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const args = (text.match(COMMAND_ARGS)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  // Whatever the person typed OUTSIDE the envelope. A command invoked with a
  // sentence after it puts the sentence here.
  const rest = text.replace(COMMAND_TAG, ' ').replace(/\s+/g, ' ').trim();
  return [name, args, rest].filter((s) => s !== '').join(' ');
}

/**
 * Whether a prompt gives a triage reader nothing to judge.
 *
 * Only two shapes qualify: empty, and a bare command name with no arguments
 * after it. Deliberately NOT a length rule. Measured 2026-08-25 on 214 live
 * sessions, a character floor buys almost nothing and costs real prompts: only
 * 2 plain-prose first prompts are under 12 characters and 13 are under 20,
 * while a complete, perfectly judgeable question written in Han script runs to
 * 18. A floor tuned on Latin prose throws away the shortest scripts first.
 */
function contentless(text) {
  const unwrapped = unwrapCommand(text);
  return unwrapped === '' || /^\/[^\s]*$/.test(unwrapped);
}

/**
 * The first user prompt in a session that a reader can actually judge.
 *
 * NOT literally the first one. Triage reads one prompt per session and its
 * whole cost argument rests on that prompt being representative, so a session
 * that opens with `/clear` used to put a command envelope in front of the
 * reader and nothing else. One of the two sessions that shipped 21 identity
 * fields in plaintext opened exactly that way.
 *
 * Measured 2026-08-25 over the live corpus root at depth 1, the way
 * resolveCorpus scopes it: 214 sessions, 45 of them (21.0%) with a contentless
 * first prompt. 28 carry no user prompt in the head at all; 17 open with a bare
 * slash command (`/clear` x11, `/model` x2, `/login`, `/mcp`,
 * `/reload-plugins`, `/doctor`). Of those 17, 15 are answered by the next
 * prompt in the SAME head that was already read, 14 at index 1 and 1 at index
 * 2. So this costs no extra I/O and reads no further into any file: the stage
 * stays the cheap one.
 *
 * Returns null rather than throwing for every failure a corpus can produce: a
 * file that vanished between the directory listing and here, a file that cannot
 * be opened, a head with no user record in it. Triage is the cheap stage and it
 * runs over every session at once, so one unreadable file must not end the run.
 * An absent prompt is the ordinary case, not an error.
 *
 * @param {string} filePath
 * @param {{headBytes?: number}} opts
 * @returns {{text: string|null, skipped: ReadonlyArray<string>}} `skipped` is
 *   what came before the returned prompt, already unwrapped, so the caller can
 *   say the shown prompt was not the first. Both empty means the head held no
 *   authored prompt at all.
 */
export function firstUserPrompt(filePath, opts = {}) {
  const nothing = Object.freeze({ text: null, skipped: Object.freeze([]) });
  const head = readHead(filePath, opts.headBytes ?? HEAD_BYTES);
  if (head === null) return nothing;

  const lines = head.text.split('\n');
  // The last line of a truncated read is half a record, and half a record is
  // also where a multi-byte character can be cut in two, which `toString`
  // silently turns into U+FFFD. Dropping it costs nothing: a prompt that only
  // appears after 256 KB is not the first one.
  if (!head.complete) lines.pop();

  const skipped = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      // An unparseable line in the head is not this command's problem to
      // report: `scan` and `export` both already refuse or skip on it, with the
      // file and the line named. Refusing here would make the cheap stage the
      // one that blocks on a half-written session.
      continue;
    }
    const text = authoredText(value);
    if (text === null) continue;
    if (contentless(text)) {
      // Recorded, not discarded. A reader shown the third prompt of a session
      // without being told so would draw conclusions about how the session
      // opened from a prompt that arrived after a context reset.
      skipped.push(unwrapCommand(text));
      continue;
    }
    return Object.freeze({ text: unwrapCommand(text), skipped: Object.freeze(skipped) });
  }
  // Every prompt in the head said nothing, or there were none. The caller
  // renders those differently: `skipped` distinguishes them.
  return Object.freeze({ text: null, skipped: Object.freeze(skipped) });
}

/** The first `limit` bytes of a file, or null if it cannot be read at all. */
function readHead(filePath, limit) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(limit);
    const read = fs.readSync(fd, buf, 0, limit, 0);
    return { text: buf.toString('utf8', 0, read), complete: read < limit };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // A descriptor that will not close is not worth failing a triage over.
      }
    }
  }
}

/**
 * What the person actually typed in one record, or null.
 *
 * Three exclusions, each of which would otherwise put text in front of a reader
 * that nobody wrote:
 *
 *   - `isMeta` records are the harness talking to itself.
 *   - `tool_result` blocks inside a user record are output, not a prompt. They
 *     are also the largest thing in a session, which is exactly what this stage
 *     must not show.
 *   - the injected spans, which carry the owner's memory index and local
 *     command output into sessions that never mentioned either. Same list the
 *     retention pass strips, so the two cannot disagree about what is authored.
 *
 * Whitespace is collapsed because the triage file is one line per prompt. A
 * prompt with newlines in it would render as several rows, and a reader cannot
 * tell where one session's block ends and the next begins.
 */
function authoredText(record) {
  if (record === null || typeof record !== 'object') return null;
  if (record.type !== 'user' || record.isMeta === true) return null;

  const content = record.message?.content;
  const parts = [];
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;

  let out = parts.join(' ');
  for (const re of INJECTED_SPANS) out = out.replace(re, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
}
