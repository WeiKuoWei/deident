// A workspace is a directory a person worked in, not a storage slug.
//
// BRIEF §4.9 is explicit: `:`, `\`, `/` and `.` all collapse to `-` in the
// slug, the collisions are real, and since Claude Code v2.1.234 the slug need
// not be path-derived at all. "Resolve the root from the environment. Read
// `cwd` from the record. Never parse the slug." So the slug is neither a name
// to show a human nor a unit to make a decision about.
//
// Measured on the real corpus 2026-08-22, grouping by slug:
//   214 of 224 sessions -> one slug, `C--Users-devuser`, because Claude Code is
//   launched from the home directory. One tier decision would have controlled
//   95% of the corpus, which is not a decision.
// Grouping by the dominant per-line cwd instead:
//   129 sessions genuinely worked in the home directory, 85 regroup into 44
//   real project directories that each get their own signals and their own row.

import os from 'node:os';
import { dominantCwd, normalizeCwd } from '../corpus/cwdtrack.mjs';
import { matchDenyToken } from './workspaces.mjs';

/** Names for the two rows that are not a project directory. cli-ux §3. */
export const HOME_NAME = '<home>';
export const UNKNOWN_NAME = '<no-cwd>';

/**
 * @param {ReadonlyArray<{file: object, cwds: ReadonlyArray<string|null>}>} sessions
 * @param {{homedir?: string}} opts
 * @returns {ReadonlyArray<object>} one group per real directory, name-sorted.
 *   group = {key, name, cwd, normCwd, sessionCount, bytes, sessionPaths,
 *            isHome, unresolved, denyToken}
 */
export function groupSessions(sessions, opts = {}) {
  const homeNorm = normalizeCwd(opts.homedir ?? os.homedir());
  const groups = new Map();

  for (const s of sessions) {
    const dom = dominantCwd(s.cwds ?? []);
    const key = dom === null ? UNKNOWN_NAME : dom.norm;
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        key,
        cwd: dom === null ? null : dom.raw,
        normCwd: dom === null ? null : dom.norm,
        sessionCount: 0,
        bytes: 0,
        sessionPaths: [],
        isHome: dom !== null && dom.norm === homeNorm,
        unresolved: dom === null,
        denyToken: dom === null ? null : matchDenyToken(dom.raw),
      };
      groups.set(key, g);
    }
    g.sessionCount += 1;
    g.bytes += s.file?.bytes ?? 0;
    g.sessionPaths.push(s.file?.path ?? null);
    // The deny token is read from the group's OWN directory and nowhere else.
    //
    // Tainting a group because one of its lines wandered into a denied
    // directory was tried and reverted: on the real corpus it excluded the
    // home directory, `ops-handover` and `personal-finance` outright, and
    // labelled the last one `deny-list matched: "redacted-name"`, which is not true of
    // that workspace. privacy-tiers §4 has three levels for exactly this
    // reason — the wandering line is caught by level 2 (the per-line filter
    // drops it, both for its deny token and because the directory it moved
    // into is its own excluded workspace) and by level 3 (the session is
    // listed under "sessions worth a second look"). Level 1 answers only
    // "what is this workspace".
  }

  const named = assignNames([...groups.values()]);
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze(named.map((g) => Object.freeze({ ...g, sessionPaths: Object.freeze(g.sessionPaths) })));
}

/**
 * A short human-readable label per group, unique within the run because it is
 * the key the user edits in review.md and the key decisions are saved under.
 * One path segment where that is unambiguous, more segments where it is not.
 */
export function assignNames(groups) {
  const name = new Map(); // group -> chosen name
  const taken = new Set();
  const contest = [];
  for (const g of groups) {
    if (g.unresolved) claim(g, UNKNOWN_NAME);
    else if (g.isHome) claim(g, HOME_NAME);
    else contest.push(g);
  }

  function claim(g, wanted) {
    let chosen = wanted;
    for (let i = 2; taken.has(chosen); i += 1) chosen = `${wanted}~${i}`;
    taken.add(chosen);
    name.set(g, chosen);
  }

  let pending = contest;
  for (let depth = 1; depth <= 4 && pending.length > 0; depth += 1) {
    const byName = new Map();
    for (const g of pending) {
      const candidate = tailSegments(g.cwd, depth);
      if (!byName.has(candidate)) byName.set(candidate, []);
      byName.get(candidate).push(g);
    }
    const next = [];
    for (const [candidate, members] of byName) {
      if (members.length === 1 && !taken.has(candidate)) claim(members[0], candidate);
      else for (const m of members) next.push(m); // never push(...members): argument-stack overflow
    }
    pending = next;
  }
  // Anything still colliding after four segments gets its whole path, and
  // claim() suffixes if even that is ambiguous. A group must never be dropped
  // here: dropping one would silently drop its sessions from every count.
  for (const g of pending) claim(g, safeName(g.normCwd ?? g.cwd));

  return groups.map((g) => ({ ...g, name: name.get(g) }));
}

/** The last `n` segments of a real path. Not a slug (§4.9). */
export function tailSegments(cwd, n) {
  const parts = String(cwd)
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter((p) => p !== '' && !/^[A-Za-z]:$/.test(p));
  return safeName(parts.length === 0 ? String(cwd) : parts.slice(-n).join('/'));
}

/**
 * review.md is whitespace-delimited (`tier  name  N sessions  ...`), so a name
 * carrying a space would be parsed as a different name than it was rendered
 * as, and the decision would silently not stick. `My Documents` is an ordinary
 * Windows path segment.
 */
function safeName(text) {
  return String(text).replace(/\s+/g, '_');
}
