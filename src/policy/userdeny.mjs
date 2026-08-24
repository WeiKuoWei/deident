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
 * A salt directory that silently has none of the person's own deny rules.
 *
 * The documented way to run "as if for the first time" is a fresh `--salt-dir`,
 * and denied.json lives IN the salt directory, so the fresh run loads zero
 * per-person rules. Nothing announces that. This module's own header names the
 * cost: the directory named after a real person HAS a git remote, so without
 * its token the proposed tier flips from exclude to redact and a private
 * workspace is offered for export, with every gate green: no gate knows a rule
 * was ever supposed to exist. It is the one configuration where the person
 * believes they are protected and is not.
 *
 * A warning and not a refusal, and the condition is deliberately narrow. A
 * genuinely first-ever run has no denied.json anywhere and must not be blocked
 * or nagged; warning there would put this line on every first run of every
 * install, which is §F7's cry-wolf failure. It fires only where the person is
 * demonstrably protected in the default directory and not in this one.
 *
 * @param {string} saltDir the directory actually in use
 * @param {?string} defaultDir where deident would have looked without --salt-dir
 * @returns {?string} one warning line, or null
 */
export function missingDenyWarning(saltDir, defaultDir) {
  if (typeof defaultDir !== 'string' || defaultDir.length === 0) return null;
  if (path.resolve(saltDir) === path.resolve(defaultDir)) return null;
  const here = path.join(saltDir, DENIED_USER_FILENAME);
  if (fs.existsSync(here)) return null;
  const fallback = path.join(defaultDir, DENIED_USER_FILENAME);
  if (!fs.existsSync(fallback)) return null;
  return (
    `${saltDir} has no ${DENIED_USER_FILENAME}, so none of your own deny rules are loaded, ` +
    `while ${fallback} has some. Directories you expect to be excluded will be offered for export ` +
    `and no check will say so. Copy it first: cp "${fallback}" "${here}"`
  );
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
