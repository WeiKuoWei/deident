// The effective cwd per record index.
//
// BRIEF §4.8: only 67% of lines carry `cwd`, and one file spanned 11 distinct
// cwd values including `...\ops-handover\private`. Directory-level opt-in
// is therefore not sufficient; the per-line filter needs a value for every
// line, including the 33% that carry none.
//
// PLAN §2: this must run BEFORE retention, because `relocated` and
// `worktree-state` are DROP records that are also the only evidence the
// effective directory moved. Drop them first and every line after the move is
// filtered against the wrong directory.

import fs from 'node:fs';

/**
 * @param {ReadonlyArray<{index:number, value:object}>} records
 * @returns {ReadonlyArray<string|null>} effective cwd, parallel to `records`
 */
export function resolveLineCwd(records) {
  const out = new Array(records.length);
  let current = null;

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i].value;
    const declared = cwdChangeFrom(rec);
    if (declared !== null) current = declared;
    out[i] = current;
  }

  // A file whose first records carry no cwd (last-prompt, bridge-session, mode
  // all lack it, §4.8) would otherwise be null-filtered. Back-fill from the
  // first known value: the session cannot have been in a *different* directory
  // before the first one it reports, and leaving null means "unknown", which
  // the line filter treats as deny.
  const firstKnown = out.find((v) => v !== null) ?? null;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === null) out[i] = firstKnown;
    else break;
  }

  return Object.freeze(out);
}

/**
 * The cwd this record establishes, or null if it establishes none.
 * Exported so the selftest can assert each source independently.
 */
export function cwdChangeFrom(rec) {
  if (rec === null || typeof rec !== 'object') return null;

  if (rec.type === 'relocated') {
    return nonEmpty(rec.relocatedCwd);
  }

  if (rec.type === 'worktree-state') {
    const ws = rec.worktreeSession;
    if (ws && typeof ws === 'object') {
      // Entering a worktree moves the effective directory to worktreePath;
      // leaving it restores originalCwd. The record does not say which, so
      // take worktreePath when present, the conservative choice, since a
      // worktree under a denied path must not be treated as the original.
      return nonEmpty(ws.worktreePath) ?? nonEmpty(ws.originalCwd);
    }
    return null;
  }

  return nonEmpty(rec.cwd);
}

function nonEmpty(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Whether two paths differing only in case name the same directory.
 *
 * This was unconditionally true, which is right on Windows and on a default
 * macOS volume and WRONG on Linux and on a case-sensitive APFS volume, where
 * `~/Projects/client-a` and `~/projects/client-a` are two different
 * directories. Folding them merges two workspaces into one row carrying one
 * tier and one displayed path, so a person who sets `redact` on the row they
 * can see sets it on a directory they were never shown. Measured before the
 * fix: two sessions in two real directories produced one group.
 *
 * Not folding when it should have been folded is the other error, and it is
 * cheap: two rows for one directory, both decided by the same person.
 *
 * A per-platform default, replaced at startup by an actual probe of the root.
 */
let foldCase = process.platform === 'win32' || process.platform === 'darwin';

/** @returns {boolean} */
export function caseFolding() {
  return foldCase;
}

/** Set explicitly. Called once at startup, and by fixtures. */
export function setCaseFolding(on) {
  foldCase = on === true;
}

/**
 * Ask the filesystem instead of guessing: stat the same directory with one
 * letter's case flipped. If that resolves, the filesystem folds case.
 *
 * Read-only, two syscalls, and correct on a case-sensitive macOS volume, which
 * `process.platform === 'darwin'` is not.
 *
 * Ceiling: one probe of the session-storage root stands for every volume the
 * corpus mentions. A cwd on a differently-configured mount is normalised by
 * the root's rule. Sessions are stored on the OS volume and overwhelmingly ran
 * there too, and the alternative is a stat per distinct directory on a path
 * that runs for every line.
 *
 * @param {string} dir an existing directory
 * @param {Function} stat injectable for fixtures
 * @returns {boolean|null} null when it could not be answered
 */
export function probeCaseFolding(dir, stat = fs.statSync) {
  if (typeof dir !== 'string' || dir === '') return null;
  let flipped = null;
  for (let i = dir.length - 1; i >= 0; i -= 1) {
    const c = dir[i];
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    if (lower === upper) continue; // not a letter, or has no other case
    const other = c === lower ? upper : lower;
    if (other.length !== 1) continue; // German ss uppercases to two characters
    flipped = dir.slice(0, i) + other + dir.slice(i + 1);
    break;
  }
  if (flipped === null) return null; // no letter anywhere: nothing to ask
  try {
    stat(dir);
  } catch {
    return null; // the reference is not there, so the answer would be noise
  }
  try {
    stat(flipped);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise a cwd for comparison only. Windows paths appear with both
 * separators and with case variants (§4.8 measured `projects` and `Projects`
 * as two spellings of one directory). Never used for output.
 */
export function normalizeCwd(cwd) {
  if (typeof cwd !== 'string') return '';
  const clean = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return foldCase ? clean.toLowerCase() : clean;
}

/**
 * The directory a session actually worked in: the effective cwd carrying the
 * most lines, compared case- and separator-insensitively (§4.8 measured
 * `projects` and `Projects` as two spellings of one directory).
 *
 * The launch directory is not the answer. Measured on the real corpus
 * 2026-08-22: 214 of 224 sessions sit under the single storage slug
 * `C--Users-devuser` because Claude Code is launched from the home directory,
 * and 85 of those spend most of their lines inside a real project.
 *
 * @returns {{norm: string, raw: string, count: number}|null} null when the
 *   session never declared a cwd at all.
 */
export function dominantCwd(cwds) {
  const counts = new Map();
  for (const cwd of cwds) {
    if (typeof cwd !== 'string' || cwd === '') continue;
    const norm = normalizeCwd(cwd);
    if (norm === '') continue;
    const hit = counts.get(norm);
    if (hit === undefined) counts.set(norm, { count: 1, raw: cwd });
    else hit.count += 1;
  }
  let best = null;
  for (const [norm, v] of counts) {
    // Strict >, so a tie keeps the spelling seen first. Deterministic output
    // is a requirement, not a nicety (cli-ux §11).
    if (best === null || v.count > best.count) best = { norm, raw: v.raw, count: v.count };
  }
  return best === null ? null : Object.freeze(best);
}
