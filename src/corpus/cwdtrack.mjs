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
  // all lack it — §4.8) would otherwise be null-filtered. Back-fill from the
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
      // take worktreePath when present — the conservative choice, since a
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
 * Normalise a cwd for comparison only. Windows paths appear with both
 * separators and with case variants (§4.8 measured `projects` and `Projects`
 * as two spellings of one directory). Never used for output.
 */
export function normalizeCwd(cwd) {
  if (typeof cwd !== 'string') return '';
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
