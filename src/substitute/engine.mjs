// Longest-match, single left-to-right pass, with an already-replaced interval
// mask. BRIEF §4.6.
//
// Sequential String.replaceAll per entity is order-dependent and can re-match
// its own output; the measured prefix collisions (`gitroll` inside
// `gitroll-agentic`, `devuser` inside `devuser` inside `devuser@gitroll.io`)
// make that a real bug, not a theoretical one.
//
// Boundary rule is `(?<![A-Za-z0-9_])X(?![A-Za-z0-9_])`, NEVER `\b`. BRIEF
// §4.5 measured `\b` failing differently in Python and Node on the same
// inputs, and never matching a pure-CJK entity in either. The rule is
// implemented as direct character tests rather than a regex so there is no
// `\b` in the file to drift back to.

import { pseudonymPattern } from '../entities/pseudonym.mjs';

const WORD_RE = /[A-Za-z0-9_]/;

function isWordChar(ch) {
  return ch !== undefined && WORD_RE.test(ch);
}

// Two characters classes that ARE word characters under §4.5's rule but are
// token boundaries in the shapes this corpus actually contains.
//
// Measured over a real export (2026-08-22): 870 occurrences of known entities
// were classified "embedded" and shipped verbatim. They were not `ray` inside
// `array`, which is what §4.5 row 4 exists to protect. They were:
//
//   mcp__playwright-headless__browser_navigate   every MCP server name in the
//     corpus. The log format is always `mcp__NAME__tool`, so `_` on both sides
//     made the whole §F4 MCP entity class inert — a 100% miss rate on a control
//     the manifest simultaneously claimed was not implemented.
//   project_gitroll_site_hk_us_entity_rollback.md, dm-derek-cpa
//   CatalyteAI x187, AdaWang x3, MeetingAda和Jacob x8
//
// So: an underscore is a boundary for a spelling long enough that an accidental
// match is not the likelier reading, and a camel-case hump is a boundary
// always, because `MeetingAda` is two words in any reading. `ray` inside
// `array` is untouched by both rules: `ray` is three characters and starts
// lowercase, so neither fires.
const SEPARATOR_BOUNDARY_MIN = 5;
const UPPER_RE = /[A-Z]/;
const LOWER_RE = /[a-z0-9]/;

function isUpper(ch) {
  return ch !== undefined && UPPER_RE.test(ch);
}

function isLowerish(ch) {
  return ch !== undefined && LOWER_RE.test(ch);
}

/**
 * Does the character to the LEFT of `at` block a match of `entry`?
 * Exported so the residual scan cannot drift from the substituter.
 */
export function leftBoundaryBlocks(s, at, entry) {
  if (!entry.needsLeft) return false;
  const ch = s[at - 1];
  if (ch === undefined) return false;
  // The case of the MATCHED TEXT, not of the entry's spelling. Matching is
  // case-insensitive, so the entry for `GitRoll` reads `gitroll` — and asking
  // the spelling whether it starts a hump would answer for a casing that is not
  // the one in the file.
  if (isUpper(s[at]) && isLowerish(ch)) return false;
  if (entry.sepBoundary && ch === '_') return false;
  return leftIsWordChar(s, at);
}

// Case-insensitive matching, for spellings long enough that a case variant
// cannot be a different word.
//
// BRIEF §4.6 lists "case-variant only 7" as an observed form and PLAN §1 says
// variants.mjs expands case variants. It did not, for anything but a path's
// drive letter — so the org entity seeded from the git remote `gitroll-dev/
// gitroll` was the lowercase spelling, the company writes itself `GitRoll`
// everywhere, and `GitRoll` survived 1,804 times in a real export while the
// scan had no idea it existed. Enumerating lower/UPPER/Title does not help:
// `GitRoll` is none of them. Matching case-insensitively does.
//
// §F7's precision argument does not apply here: matching `GitRoll` when
// `gitroll` is a known entity cannot be a false positive.
const CASE_INSENSITIVE_MIN = 4;

function caseInsensitive(spelling) {
  return spelling.length >= CASE_INSENSITIVE_MIN && /[A-Za-z]/.test(spelling);
}

/**
 * Does `entry` match `s` at `at`? The matched TEXT may differ from the entry's
 * spelling, which is why every caller records `s.slice(at, end)` as the span's
 * spelling rather than the entry's — reversal has to restore what was there.
 */
export function matchesAt(s, at, entry) {
  const end = at + entry.spelling.length;
  if (end > s.length) return false;
  if (!entry.lower) return s.startsWith(entry.spelling, at);
  return equalsFold(s, at, entry.lower);
}

/**
 * Case-insensitive compare against an already-lowercased needle, without
 * allocating. This runs once per bucket entry per candidate offset over the
 * whole serialized output, so `s.slice(...).toLowerCase()` here would allocate
 * a string per comparison across tens of megabytes — a check nobody is willing
 * to wait for is a check that gets switched off (§F7's failure mode arriving
 * as latency).
 */
export function equalsFold(s, at, lower) {
  for (let k = 0; k < lower.length; k += 1) {
    const ch = s[at + k];
    if (ch === lower[k]) continue;
    if (ch === undefined || ch.toLowerCase() !== lower[k]) return false;
  }
  return true;
}

/** Does the character at `end` block a match of `entry`? */
export function rightBoundaryBlocks(s, end, entry) {
  if (!entry.needsRight) return false;
  const ch = s[end];
  if (ch === undefined) return false;
  if (isLowerish(s[end - 1]) && isUpper(ch)) return false;
  if (entry.sepBoundary && ch === '_') return false;
  return isWordChar(ch);
}

// The tail of a JSON escape or a percent-encoding, at the end of the window.
const ESCAPE_TAIL_RE = /(?:\\(?:u[0-9a-fA-F]{4}|[bfnrtv])|%[0-9A-Fa-f]{2})$/;

/**
 * Is the character to the LEFT of `at` a word character in the sense the
 * boundary rule means?
 *
 * `n` and `b` are word characters, but the `n` of a backslash-n and the final
 * `b` of a backslash-u escape are not: they are the tail of an escape
 * sequence, and the entity that follows starts a word.
 *
 * This matters because these logs nest JSON inside JSON. A pasted email body
 * or an embedded tool payload arrives as a string whose own newlines are the
 * two characters backslash + n, and CJK inside it arrives as backslash-u
 * escapes. Measured on the real corpus (2026-08-22, 210 exported sessions):
 * without this, a signature line reading backslash-n then a first name, and a
 * CJK sentence whose characters arrived as backslash-u escapes around a first
 * name, were both classified as "the spelling sits inside a longer word" and
 * left in the output. The residual scan shares this rule, so
 * it agreed with the substituter and reported `known-entity residue: 0` over a
 * zip that still named a third party. Both sides read this one function now.
 *
 * The escape is only real when its backslash is not itself escaped, so an even
 * run of backslashes before it means the `n` really is a letter.
 *
 * Exported so the residual scan cannot drift from the substituter.
 */
export function leftIsWordChar(s, at) {
  if (!isWordChar(s[at - 1])) return false;
  const m = ESCAPE_TAIL_RE.exec(s.slice(Math.max(0, at - 6), at));
  if (m === null) return true;
  // A percent-encoding has no doubling rule: `%3D` is always three characters
  // and the `D` is never a letter of a word. §4.6 measured this form as
  // `%3Ddevuser%40gitroll.io`, an email inside a URL query, and without this
  // the whole address was classified as embedded and left in the output.
  if (m[0][0] === '%') return false;
  let backslashes = 0;
  for (let j = at - m[0].length - 1; j >= 0 && s[j] === '\\'; j -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * @param {ReadonlyArray<object>} entities  each with {id, kind, canonical,
 *   spellings[], pseudonym, confidence, tier}
 * @param {{forbidInside?: RegExp}} opts
 *   forbidInside: a pattern whose matches are protected from substitution.
 *   Used for the tier-1 pseudonym guard (PLAN §2): a semantic pass that
 *   returns `PERSON` as a name would otherwise destroy every tier-0 token.
 * @returns {Readonly<object>} the table
 */
export function buildTable(entities, opts = {}) {

  const entries = [];
  const flagged = [];

  for (const e of entities) {
    if (e.pseudonym === null || e.pseudonym === undefined) {
      if (e.rejected) flagged.push(Object.freeze({ id: e.id, canonical: e.canonical, reason: e.rejected }));
      continue;
    }
    for (const spelling of e.spellings) {
      if (typeof spelling !== 'string' || spelling.length === 0) continue;
      entries.push(
        Object.freeze({
          spelling,
          pseudonym: e.pseudonym,
          entityId: e.id,
          kind: e.kind,
          tier: e.tier ?? 0,
          confidence: e.confidence,
          // Precomputed boundary requirements: only applied where the spelling
          // itself ends in a word character, which is exactly what the
          // lookaround form means.
          needsLeft: isWordChar(spelling[0]),
          needsRight: isWordChar(spelling[spelling.length - 1]),
          // Precomputed inputs to the two token-boundary exceptions above.
          sepBoundary: spelling.length >= SEPARATOR_BOUNDARY_MIN,
          lower: caseInsensitive(spelling) ? spelling.toLowerCase() : null,
        }),
      );
    }
  }

  // Longest decoded spelling wins. The tiebreak is lexical so the table — and
  // therefore the output — is identical across runs (I10).
  entries.sort(
    (a, b) => b.spelling.length - a.spelling.length || (a.spelling < b.spelling ? -1 : a.spelling > b.spelling ? 1 : 0),
  );

  // First-character index. Most characters start no spelling, so the scan
  // touches the entry list only where it could possibly match.
  const byFirstChar = new Map();
  for (const entry of entries) {
    // A case-insensitive entry is reachable from either case of its first
    // character, or the index would silently undo the whole point of it.
    const keys = entry.lower
      ? new Set([entry.spelling[0], entry.spelling[0].toLowerCase(), entry.spelling[0].toUpperCase()])
      : new Set([entry.spelling[0]]);
    for (const key of keys) {
      if (!byFirstChar.has(key)) byFirstChar.set(key, []);
      byFirstChar.get(key).push(entry);
    }
  }

  const byPseudonym = new Map();
  for (const entry of entries) {
    if (!byPseudonym.has(entry.pseudonym)) byPseudonym.set(entry.pseudonym, entry);
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    byFirstChar,
    byPseudonym,
    flagged: Object.freeze(flagged),
    forbidInside: opts.forbidInside ?? null,
    // The guard a REPEAT pass runs under: whatever the first pass emitted is
    // off limits, so re-running to a fixpoint can never eat its own output.
    repassGuard: opts.forbidInside ?? pseudonymPattern(opts.namespace ?? null),
    size: entries.length,
  });
}

/**
 * Substitute every entity spelling in `s`.
 *
 * The interval mask is materialised as `spans`, in ORIGINAL-string
 * coordinates. Because the scan jumps past each replacement, a replaced region
 * is never re-examined — which is the property BRIEF §4.6 requires and the one
 * `replaceAll` cannot give.
 *
 * @returns {{out: string, spans: ReadonlyArray<object>}}
 */
export function substituteString(s, table, forbidOverride = undefined) {
  if (typeof s !== 'string' || s.length === 0 || table.size === 0) {
    return { out: s, spans: EMPTY };
  }

  // Regions the caller has forbidden (already-emitted pseudonyms, for tier 1).
  const pattern = forbidOverride === undefined ? table.forbidInside : forbidOverride;
  const forbidden = pattern ? collectForbidden(s, pattern) : null;

  let out = '';
  let cursor = 0;
  let i = 0;
  const spans = [];

  while (i < s.length) {
    const bucket = table.byFirstChar.get(s[i]);
    if (bucket === undefined) {
      i += 1;
      continue;
    }

    const hit = longestMatchAt(s, i, bucket, forbidden);
    if (hit === null) {
      i += 1;
      continue;
    }

    // Absorb any entity that STARTS INSIDE the region just claimed and reaches
    // past its end.
    //
    // Without this the scan jumped the whole replaced span, so a longer entity
    // beginning inside it was never examined and its non-overlapping remainder
    // shipped verbatim. Declare `the operator` and `Bell Wang Wei` — the shape the
    // tier-1 schema example invites, two person entities sharing a token — and
    // `the operator Wang Wei` became `PERSON_A Wang Wei`, with the substitution
    // invariant reporting "all reversible" and the residual scan reporting
    // "0 occurrences", because neither looks for a partially present entity.
    //
    // The covering span replaces the union and emits both pseudonyms, so
    // nothing of either entity remains and reversal still restores the exact
    // original text from `spelling`.
    let end = i + hit.spelling.length;
    let replacement = hit.pseudonym;
    for (let j = i + 1; j < end; j += 1) {
      const inner = table.byFirstChar.get(s[j]);
      if (inner === undefined) continue;
      // Only a spelling LONGER than the remaining span can reach past it, and
      // buckets are sorted longest-first, so the search stops as soon as the
      // entries get short enough to be contained. Without this bound the
      // absorption pass costs one full bucket walk per character of every
      // replaced span, which on a corpus whose commonest entity is a long
      // absolute path is most of the run.
      const reach = longestMatchAt(s, j, inner, forbidden, end - j);
      if (reach === null) continue;
      replacement += ` ${reach.pseudonym}`;
      end = j + reach.spelling.length;
    }

    out += s.slice(cursor, i) + replacement;
    spans.push(
      Object.freeze({
        start: i,
        end,
        // The TEXT that was there, not the entry's spelling: a case-insensitive
        // entry matches `GitRoll` while its spelling reads `gitroll`, and
        // reversal must restore what the log actually said.
        spelling: s.slice(i, end),
        pseudonym: replacement,
        entityId: hit.entityId,
        tier: hit.tier,
      }),
    );
    i = end;
    cursor = i;
  }

  if (spans.length === 0) return { out: s, spans: EMPTY };
  out += s.slice(cursor);
  return { out, spans: Object.freeze(spans) };
}

const EMPTY = Object.freeze([]);

/**
 * The longest spelling in `bucket` that matches at `at` with valid boundaries.
 * `bucket` is already sorted longest-first, so the first valid hit is longest.
 * Exported for the verifier, which needs to ask this question independently.
 */
export function longestMatchAt(s, at, bucket, forbidden = null, minLength = 0) {
  for (const entry of bucket) {
    // Sorted longest-first, so once the entries are short enough there is
    // nothing left that could satisfy the caller's length floor.
    if (entry.spelling.length <= minLength) return null;
    const end = at + entry.spelling.length;
    if (end > s.length) continue;
    if (!matchesAt(s, at, entry)) continue;
    if (leftBoundaryBlocks(s, at, entry)) continue;
    if (rightBoundaryBlocks(s, end, entry)) continue;
    if (forbidden !== null && overlapsForbidden(at, end, forbidden)) continue;
    return entry;
  }
  return null;
}

function collectForbidden(s, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const ranges = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return ranges.length === 0 ? null : ranges;
}

function overlapsForbidden(start, end, ranges) {
  for (const [a, b] of ranges) {
    if (start < b && end > a) return true;
  }
  return false;
}

/**
 * Reconstruct the original string from a substituted one plus its spans.
 *
 * Reversal needs the spans because one entity legitimately has many spellings
 * and they all map to one pseudonym — `C:\Users\devuser` and `C:/Users/devuser`
 * are the same workspace. Recovering "which spelling" from the token alone is
 * not possible, and inventing a per-spelling token would put escaping trivia
 * into the reviewer's entity list.
 *
 * This is used by I2 and by the local reversal path described in BRIEF §3. It
 * is deliberately NOT the whole of the substitution invariant: checks.mjs adds
 * maximality and completeness, computed by a different algorithm, so the
 * invariant is not just this function agreeing with itself.
 */
export function reverseString(out, spans) {
  if (spans.length === 0) return out;
  let result = '';
  let cursor = 0;
  let original = 0;
  for (const span of spans) {
    // Everything between the previous replacement and this one is verbatim.
    const gap = span.start - original;
    result += out.slice(cursor, cursor + gap) + span.spelling;
    cursor += gap + span.pseudonym.length;
    original = span.end;
  }
  return result + out.slice(cursor);
}

/**
 * EVERY boundary-valid occurrence of EVERY spelling in `s`, including
 * overlapping and nested ones.
 *
 * This is the verifier's algorithm and it is deliberately not the
 * substituter's. substituteString stops at the first hit in a bucket (relying
 * on the sort to make that the longest) and then jumps past it; this one
 * collects all candidates at every offset and never skips, so it can see both
 * a match the fast scan missed and a longer match the fast scan passed over.
 * A wrong sort order, a released mask interval or a bad jump shows up as a
 * disagreement between the two. One implementation agreeing with itself would
 * not be evidence of anything.
 */
export function allOccurrences(s, table) {
  const found = [];
  // Regions the substituter was forbidden to touch are not occurrences it
  // missed. Without this the verifier reports the tier-1 pseudonym guard doing
  // its job as a bug.
  const forbidden = table.forbidInside ? collectForbidden(s, table.forbidInside) : null;
  for (let i = 0; i < s.length; i += 1) {
    const bucket = table.byFirstChar.get(s[i]);
    if (bucket === undefined) continue;
    for (const entry of bucket) {
      const end = i + entry.spelling.length;
      if (end > s.length) continue;
      if (!matchesAt(s, i, entry)) continue;
      if (leftBoundaryBlocks(s, i, entry)) continue;
      if (rightBoundaryBlocks(s, end, entry)) continue;
      if (forbidden !== null && overlapsForbidden(i, end, forbidden)) continue;
      found.push({ start: i, end, entry });
    }
  }
  return found;
}
