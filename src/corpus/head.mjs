// Read only the HEAD of a session file, and pull the first thing the person
// typed out of it.
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
 * The first authored user prompt in a session, whitespace collapsed, or null.
 *
 * Returns null rather than throwing for every failure a corpus can produce: a
 * file that vanished between the directory listing and here, a file that cannot
 * be opened, a head with no user record in it. Triage is the cheap stage and it
 * runs over every session at once, so one unreadable file must not end the run.
 * Measured on the live corpus: 161 of 205 sessions carry a first user prompt at
 * all, so an absent one is the ordinary case, not an error.
 *
 * @param {string} filePath
 * @param {{headBytes?: number}} opts
 * @returns {string|null}
 */
export function firstUserPrompt(filePath, opts = {}) {
  const head = readHead(filePath, opts.headBytes ?? HEAD_BYTES);
  if (head === null) return null;

  const lines = head.text.split('\n');
  // The last line of a truncated read is half a record, and half a record is
  // also where a multi-byte character can be cut in two, which `toString`
  // silently turns into U+FFFD. Dropping it costs nothing: a prompt that only
  // appears after 256 KB is not the first one.
  if (!head.complete) lines.pop();

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
    if (text !== null) return text;
  }
  return null;
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
