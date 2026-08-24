// Per-person deny rules, loaded from beside the salt and never committed.
//
// The shipped deny lists can only name things that are true of the AGENT: a
// directory called `private`, a file called `credentials.json`, `MEMORY.md`.
// Everything else is one machine's: a dictation app, an immigration folder, a
// directory named after a real person, and the names a given user gives their
// own memory files. The shipped list recognises one memory-file convention and
// nobody else's, which is why this file is where a second user's memory
// filenames go.
//
// Those were in the repository until 2026-08-23. That is a disclosure in a
// shared repo and dead weight for every other user, and deleting them was not
// an option either: the directory named after a person HAS a git remote, so
// without its token the proposed tier flips from exclude to redact and a
// private archive is offered for export. Per-person, beside the salt, is the
// only shape that is both private and functional.

import fs from 'node:fs';
import path from 'node:path';
import { RefusalError } from '../cli/errors.mjs';

/** Filename read from the salt directory. */
export const DENIED_USER_FILENAME = 'denied.json';

let tokens = Object.freeze([]);
let patterns = Object.freeze([]);

/**
 * Replace the per-person rules. Called once, before retention and before any
 * tier is proposed.
 *
 * Module state rather than a threaded argument: the three consumers are a
 * content check, a path check and a workspace-name check, in two different
 * layers, and none of them carries a context object. One explicit setter beats
 * three plumbing changes and a hidden global read.
 *
 * @returns {{tokens: number, patterns: number}} what was loaded, for the report
 */
export function setUserDeny(rules = {}) {
  tokens = Object.freeze(
    (Array.isArray(rules.tokens) ? rules.tokens : [])
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim().toLowerCase()),
  );
  patterns = Object.freeze(
    (Array.isArray(rules.patterns) ? rules.patterns : [])
      .filter((p) => typeof p === 'string' && p.trim().length > 0)
      .map((p) => new RegExp(p, 'i')),
  );
  return { tokens: tokens.length, patterns: patterns.length };
}

/** Extra deny tokens: matched inside a path segment or a workspace name. */
export function userDenyTokens() {
  return tokens;
}

/** Extra content patterns: matched against a path, a filename or prose. */
export function userDenyPatterns() {
  return patterns;
}

/**
 * Read the rules from the salt directory.
 *
 * Missing is the normal case and means the shipped lists only. Malformed
 * refuses rather than degrading to zero rules: this file is the reason certain
 * files never leave, and quietly having none of it is the exact failure the
 * tool exists to prevent.
 */
export function loadUserDeny(saltDir) {
  const file = path.join(saltDir, DENIED_USER_FILENAME);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { tokens: [], patterns: [] };
    throw new RefusalError(`could not read ${file}`, {
      why: [`${err.code}: ${err.message}`, 'This file decides which of your own files never leave.'],
      remedies: [{ label: 'Fix or remove it', command: `edit ${file}` }],
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RefusalError(`${file} is not valid JSON`, {
      why: [err.message, 'Refusing rather than exporting with none of your own deny rules.'],
      remedies: [{ label: 'Fix it', command: `edit ${file}` }],
    });
  }

  // A bare array is the patterns, because that is the common case.
  const rules = Array.isArray(parsed) ? { patterns: parsed, tokens: [] } : parsed ?? {};
  const outPatterns = Array.isArray(rules.patterns) ? rules.patterns : [];
  const outTokens = Array.isArray(rules.tokens) ? rules.tokens : [];
  if (!Array.isArray(rules.patterns) && !Array.isArray(rules.tokens)) {
    throw new RefusalError(`${file} has neither "patterns" nor "tokens"`, {
      why: ['Read as written it would contribute nothing, and silence here is a leak.'],
      remedies: [{ label: 'Fix it', command: `edit ${file}` }],
    });
  }

  for (const p of outPatterns) {
    if (typeof p !== 'string') continue;
    try {
      new RegExp(p, 'i');
    } catch (err) {
      throw new RefusalError(`${file}: ${JSON.stringify(p)} is not a valid pattern`, {
        why: [err.message],
        remedies: [{ label: 'Fix it', command: `edit ${file}` }],
      });
    }
  }

  return { tokens: outTokens, patterns: outPatterns };
}
