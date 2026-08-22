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

const WORD_RE = /[A-Za-z0-9_]/;

function isWordChar(ch) {
  return ch !== undefined && WORD_RE.test(ch);
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
    const key = entry.spelling[0];
    if (!byFirstChar.has(key)) byFirstChar.set(key, []);
    byFirstChar.get(key).push(entry);
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
export function substituteString(s, table) {
  if (typeof s !== 'string' || s.length === 0 || table.size === 0) {
    return { out: s, spans: EMPTY };
  }

  // Regions the caller has forbidden (already-emitted pseudonyms, for tier 1).
  const forbidden = table.forbidInside ? collectForbidden(s, table.forbidInside) : null;

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

    out += s.slice(cursor, i) + hit.pseudonym;
    spans.push(
      Object.freeze({
        start: i,
        end: i + hit.spelling.length,
        spelling: hit.spelling,
        pseudonym: hit.pseudonym,
        entityId: hit.entityId,
        tier: hit.tier,
      }),
    );
    i += hit.spelling.length;
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
export function longestMatchAt(s, at, bucket, forbidden = null) {
  for (const entry of bucket) {
    const end = at + entry.spelling.length;
    if (end > s.length) continue;
    if (!s.startsWith(entry.spelling, at)) continue;
    if (entry.needsLeft && isWordChar(s[at - 1])) continue;
    if (entry.needsRight && isWordChar(s[end])) continue;
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
  for (let i = 0; i < s.length; i += 1) {
    const bucket = table.byFirstChar.get(s[i]);
    if (bucket === undefined) continue;
    for (const entry of bucket) {
      const end = i + entry.spelling.length;
      if (end > s.length) continue;
      if (!s.startsWith(entry.spelling, i)) continue;
      if (entry.needsLeft && isWordChar(s[i - 1])) continue;
      if (entry.needsRight && isWordChar(s[end])) continue;
      found.push({ start: i, end, entry });
    }
  }
  return found;
}
