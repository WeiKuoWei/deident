// Longest-match, single left-to-right pass, with an already-replaced interval
// mask. BRIEF §4.6.
//
// Sequential String.replaceAll per entity is order-dependent and can re-match
// its own output; the measured prefix collisions (`northwind` inside
// `northwind-agentic`, `devuser` inside `devuser` inside `devuser@northwind.example`)
// make that a real bug, not a theoretical one.
//
// Boundary rule is `(?<![A-Za-z0-9_])X(?![A-Za-z0-9_])`, NEVER `\b`. BRIEF
// §4.5 measured `\b` failing differently in Python and Node on the same
// inputs, and never matching a pure-CJK entity in either. The rule is
// implemented as direct character tests rather than a regex so there is no
// `\b` in the file to drift back to.

import { pseudonymGuardPattern } from '../entities/pseudonym.mjs';
import { isCjkOnly, SPACELESS_RE } from '../entities/variants.mjs';

// Every letter and digit, in any script, minus the scripts that are written
// without spaces between words.
//
// It was /[A-Za-z0-9_]/, which granted the boundary rule to Latin and withheld
// it from every other alphabet. Measured by running this engine: `Роман` inside
// the common noun `романы` became `PERSON_01ы`, `דוד` inside `דודה` (aunt)
// became `PERSON_03ה`, and `Νίκος` swallowed the Greek letters after it. That is
// §4.5's `小明` inside `小明天` failure, "corrupted a sentence naming nobody with
// every gate green", in scripts where the writing system does not force it.
//
// Han and Kana stay OUTSIDE the word class, via SPACELESS_RE, so needsLeft and
// needsRight remain false for them and nothing about that path moves. Combining
// marks (\p{M}: Hebrew niqqud, Arabic diacritics) are deliberately left out,
// which keeps today's lax behaviour for them: that is the match-more direction,
// not the leak direction.
const WORD_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch) {
  return ch !== undefined && WORD_RE.test(ch) && !SPACELESS_RE.test(ch);
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
//     made the whole §F4 MCP entity class inert, a 100% miss rate on a control
//     the manifest simultaneously claimed was not implemented.
//   project_northwind_site_migration.md, dm-vance-cpa
//   KestrelisAI x187, NoraLund x3, MeetingNora和Ivan x8
//
// Those five strings are fabricated stand-ins and the counts are the real
// ones. The shapes are what the rule turns on: two are `_`-separated with the
// entity spelling five characters or more, one is `-`-separated, and three are
// camel humps where the entity is followed by an uppercase letter (`KestrelisAI`)
// or preceded by one (`MeetingNora`, `NoraLund`).
//
// So: an underscore is a boundary for a spelling long enough that an accidental
// match is not the likelier reading, and a camel-case hump is a boundary
// always, because `MeetingNora` is two words in any reading. `ray` inside
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
  // A match cannot START on the body of an escape. See startsOnEscapeBody:
  // `Nancy` matched the `n` of a nested `\n` and the substitution ate the
  // escape. Tested here so the substituter, allOccurrences and residualScan
  // all get it from one function.
  if (ch === '\\' && startsOnEscapeBody(s, at)) return true;
  // The case of the MATCHED TEXT, not of the entry's spelling. Matching is
  // case-insensitive, so the entry for `Northwind` reads `northwind`, and asking
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
// drive letter, so the org entity seeded from the git remote `northwind-co/
// northwind` was the lowercase spelling, the company writes itself `NorthWind`
// everywhere, and `Northwind` survived 1,804 times in a real export while the
// scan had no idea it existed. Enumerating lower/UPPER/Title does not help:
// `NorthWind` is none of them. Matching case-insensitively does.
//
// §F7's precision argument does not apply here: matching `Northwind` when
// `northwind` is a known entity cannot be a false positive.
const CASE_INSENSITIVE_MIN = 4;

/**
 * Should this spelling be matched in any casing?
 *
 * The test used to be /[A-Za-z]/, which granted the guarantee to Latin and
 * withheld it from every other bicameral script. Cyrillic and Greek entries got
 * entry.lower null, matchesAt fell through to startsWith, and residual.mjs
 * derives its own fold flag from the same entry.lower, so the substituter and
 * the residue scan went blind together. That is F51's guarantee, the one that
 * exists because a 1,804-occurrence leak came from a casing mismatch, denied
 * for no reason but the character class.
 *
 * The replacement asks the case map instead of the alphabet: a spelling folds if
 * it has a distinct case form at all. `northwind` qualifies through its uppercase,
 * which is why both directions are tested rather than just toLowerCase.
 *
 * The length condition is load-bearing and not a nicety. matchesAt computes its
 * end as `at + entry.spelling.length`, so a spelling whose lowercase is a
 * different length would consume the wrong span and reversal would restore the
 * wrong text. Turkish dotted capital I lowercases to two code units, and German
 * sharp s uppercases to two. Those stay on the literal path: exact case still
 * matches, the other case simply does not, which is a miss rather than a
 * corruption.
 */
function caseInsensitive(spelling) {
  if (spelling.length < CASE_INSENSITIVE_MIN) return false;
  const lower = spelling.toLowerCase();
  if (lower.length !== spelling.length) return false;
  return lower !== spelling || spelling.toUpperCase() !== spelling;
}

/**
 * Lowercase, with final sigma folded onto sigma.
 *
 * `String.prototype.toLowerCase` applies Unicode's Final_Sigma rule, so a
 * trailing `Σ` in a whole word becomes `ς`. equalsFold lowers ONE isolated
 * character at a time, and `Σ` with nothing after it always gives `σ`. The
 * table lowered whole spellings and the matcher lowered characters, so they
 * disagreed at the last character of every Greek entity ending in sigma, and
 * a spelling did not match even against its own text.
 *
 * Silent, and it defeated the gate too: residual.mjs imports equalsFold so the
 * two can never drift. They did not drift; they were wrong together, and the
 * export printed `known-entity residue 0` with the plaintext name in the
 * archive.
 *
 * Both sides route through here. Whole-window lowercasing inside equalsFold
 * would allocate a string per comparison across tens of megabytes, and
 * Final_Sigma is the ONLY context-sensitive lowercase mapping in Unicode's
 * default non-locale-tailored algorithm, so one character covers the class.
 * `ς` and `σ` are both single UTF-16 units, so span lengths and the reversal
 * invariant are untouched.
 *
 * Exported so the residual scan cannot drift from the substituter.
 */
export function foldLower(s) {
  const lower = s.toLowerCase();
  return lower.includes('ς') ? lower.replaceAll('ς', 'σ') : lower;
}

/**
 * Does `entry` match `s` at `at`? The matched TEXT may differ from the entry's
 * spelling, which is why every caller records `s.slice(at, end)` as the span's
 * spelling rather than the entry's, reversal has to restore what was there.
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
 * a string per comparison across tens of megabytes, a check nobody is willing
 * to wait for is a check that gets switched off (§F7's failure mode arriving
 * as latency).
 */
export function equalsFold(s, at, lower) {
  for (let k = 0; k < lower.length; k += 1) {
    const ch = s[at + k];
    if (ch === lower[k]) continue;
    if (ch === undefined || foldLower(ch) !== lower[k]) return false;
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
// `%25XX` is a DOUBLY percent-encoded byte, which is what a URL put inside
// another URL's query string looks like. Measured on a real export:
// `%2540northwind.example`, the window ends in `540`, so the digit `0` made
// `northwind` look embedded and the domain shipped in plaintext beside the
// pseudonym of the person whose address it is.
const ESCAPE_TAIL_RE = /(?:\\(?:u[0-9a-fA-F]{4}|[bfnrtv])|%(?:25)?[0-9A-Fa-f]{2})$/;

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
  // `%3Ddevuser%40northwind.example`, an email inside a URL query, and without this
  // the whole address was classified as embedded and left in the output.
  if (m[0][0] === '%') return false;
  let backslashes = 0;
  for (let j = at - m[0].length - 1; j >= 0 && s[j] === '\\'; j -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

// Everything a backslash may legally introduce, in JSON and in the JS string
// literals these logs carry: the JSON seven, plus `v`, `0`, `x` and the quote
// forms JSON never emits but other serializers do.
const ESCAPABLE_RE = /["'`\\/0bfnrtuvx]/;

// The subset of those whose body is a WORD character, so a match starting on
// it welds the escape's own character onto the entity. Measured 2026-08-25
// over the live corpus, sites where a lone backslash is followed by one of
// these: n 199,716 | r 175,416 | u 78,240 | t 71,958 | b 15,701 | f 9,049 |
// 0 2,441 | v 1,300 | x 217. The others (`"` `\` `/` and the quote forms)
// cannot weld: their body is not a word character, so no spelling that starts
// with one is subject to the left-boundary rule at all.
const ESCAPE_BODY_RE = /[0bfnrtuvx]/;

/**
 * Does anything in `s` prove its backslashes are LITERAL rather than escape
 * introducers?
 *
 * The two readings are indistinguishable one character at a time. `line one\n`
 * and `C:\Users\` both hold a lone backslash before a letter that names an
 * escape, and reading the first as a path or the second as escaped text is
 * wrong in opposite directions: one corrupts the output, the other leaves the
 * username in it.
 *
 * What separates them is the REST of the string. A backslash run followed by a
 * character no escape may take is a backslash that has to be literal, and one
 * literal backslash means the writer was not escaping. `C:\Users\ravi` carries
 * `\U`, and `\U` is not an escape in any of these dialects.
 *
 * Measured over the live corpus (220 session files, 150,829 lines, 6,749,630
 * decoded strings): 161,655 sites where a lone backslash is followed by the OS
 * username, whose first letter names an escape. This test refuses 0 of them.
 * Without it, all 161,655 stop being substituted, and the boundary rule is the
 * only thing standing between the username and the archive at every one.
 *
 * Deliberately representation-independent, because residualScan is handed the
 * DECODED prose in one place and the SERIALIZED bytes in another, and a rule
 * that answered differently for the two forms of one string is the shape that
 * put a green gate over a real leak here before. Serializing doubles every
 * literal backslash and leaves every escape single, so a run followed by a
 * non-escapable character stays a run followed by a non-escapable character.
 */
function escapeBearing(s) {
  // One slot, because both callers ask about the same string many times over:
  // substituteString walks one string to the end, residualScan sweeps one
  // 19 MB blob. Without it a long string with no literal backslash anywhere,
  // a code chunk is the measured case, is rescanned per match and the sweep
  // goes quadratic, which is §F7 arriving as latency.
  if (s === bearingKey) return bearingValue;
  let bearing = true;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '\\') continue;
    let run = 1;
    while (s[i + run] === '\\') run += 1;
    const next = s[i + run];
    if (next === undefined || !ESCAPABLE_RE.test(next)) {
      bearing = false;
      break;
    }
    i += run - 1;
  }
  bearingKey = s;
  bearingValue = bearing;
  return bearing;
}

let bearingKey = null;
let bearingValue = false;

/**
 * Would a match starting at `at` eat the body of an escape sequence?
 *
 * The mirror of leftIsWordChar. That one asks whether the character to the
 * LEFT is the tail of an escape and therefore not a letter of a word; this
 * asks whether the character AT `at` is the body of one and therefore not the
 * start of a word. Only the first question was ever asked, so `Nancy` matched
 * the `n` of a nested `\n` and the substitution consumed an escape the text
 * needed: `line one\nancy went home` came out as `line one\X_1 went home`.
 *
 * `eitherLayer` is for residualScan and nothing else. The substituter is only
 * ever handed DECODED strings (walker.mjs parses first), where one literal
 * backslash is a run of 1, so an odd run means the last backslash introduces
 * an escape. residualScan is handed the decoded prose for the candidates file
 * and the SERIALIZED bytes for the zip, and serializing doubles every literal
 * backslash, so the same site arrives there as a run of 2. It cannot tell the
 * two apart, so it asks for both, and its answer is a superset of the
 * substituter's: whatever the substituter declines, the scan exempts. That
 * direction is the one that matters. The other would refuse an export over a
 * match nobody made.
 *
 * The union is not free and the price is measured. Over the live corpus,
 * 1,545,309 sites where a backslash run precedes another character: the two
 * rules give the same verdict at all but 188, and every one of the 188 is the
 * scan exempting where the substituter substitutes, never the reverse. The
 * scan reports them in the artifact count rather than hiding them. The
 * reverse, which would refuse an export over a match nobody made, is 0.
 *
 * Exported so the residual scan cannot drift from the substituter.
 */
export function startsOnEscapeBody(s, at, eitherLayer = false) {
  if (at === 0 || !ESCAPE_BODY_RE.test(s[at] ?? '')) return false;
  let run = 0;
  for (let j = at - 1; j >= 0 && s[j] === '\\'; j -= 1) run += 1;
  if (run % 2 !== 1 && !(eitherLayer && run % 4 === 2)) return false;
  return escapeBearing(s);
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
    // `looseSpellings` are matched with NO boundary test. They are base64
    // needles, which by construction sit inside a longer base64 run, so both
    // neighbours are word characters and the boundary rule refuses every one.
    // The exemption is per-spelling and explicit; nothing else gets it.
    const all = [
      ...e.spellings.map((spelling) => ({ spelling, loose: false })),
      ...(e.looseSpellings ?? []).map((spelling) => ({ spelling, loose: true })),
    ];
    // The spellings a PERSON supplied, as against the ones expandVariants
    // generated from them. Nothing about matching turns on this; the probe
    // does, because "the string you typed matched nothing" and "an escaping
    // twin of it matched nothing" are not the same finding and one of them is
    // not a finding at all. Measured against the shipped modules: one declared
    // path expands to seven spellings, six of which match nothing, so the
    // report's "matched nothing" block was six parts noise.
    //
    // `canonical` is the fallback because tier 0 infers rather than reads, and
    // its canonical IS the inferred string. An entity with neither field is a
    // hand-built table, and there every spelling counts as supplied, which
    // keeps the honest direction: report rather than suppress.
    const typed = new Set(e.declared ?? (typeof e.canonical === 'string' ? [e.canonical] : e.spellings));
    for (const { spelling, loose } of all) {
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
          needsLeft: !loose && isWordChar(spelling[0]),
          needsRight: !loose && isWordChar(spelling[spelling.length - 1]),
          // Precomputed inputs to the two token-boundary exceptions above.
          sepBoundary: spelling.length >= SEPARATOR_BOUNDARY_MIN,
          // BRIEF §4.5: "For CJK entities require length >= 2 and FLAG them
          // for review, because the lookaround does not prevent over-matching
          // inside a longer CJK word." The length rule was implemented and the
          // flag was not, so a two-character entity matching inside a longer
          // word (小明 inside 小明天) corrupted a sentence that named nobody,
          // with every gate green and nothing in the manifest saying so.
          cjk: isCjkOnly(spelling),
          lower: caseInsensitive(spelling) ? foldLower(spelling) : null,
          declared: typed.has(spelling),
        }),
      );
    }
  }

  // Longest decoded spelling wins. The tiebreak is lexical so the table, and
  // therefore the output, is identical across runs (I10).
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
    //
    // pseudonymGuardPattern, NOT pseudonymPattern. The latter carries the §4.5
    // boundary lookarounds, so it refused to match a token abutting a word
    // character, `ORG_11499881Corp`, which is precisely the shape the
    // fixpoint exists to create. The token then sat in no forbidden range and
    // the next pass was free to substitute inside it. A guard that relies on
    // the same boundary rule the fixpoint is there to defeat is not a guard.
    repassGuard: opts.forbidInside ?? pseudonymGuardPattern(opts.namespace ?? null),
    size: entries.length,
  });
}

/**
 * Substitute every entity spelling in `s`.
 *
 * The interval mask is materialised as `spans`, in ORIGINAL-string
 * coordinates. Because the scan jumps past each replacement, a replaced region
 * is never re-examined, which is the property BRIEF §4.6 requires and the one
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
    // shipped verbatim. Declare `the operator` and `Bell Wang Ivy`, the shape the
    // tier-1 schema example invites, two person entities sharing a token, and
    // `Ada Wren Wang Ivy` became `PERSON_A Wang Ivy`, with the substitution
    // invariant reporting "all reversible" and the residual scan reporting
    // "0 occurrences", because neither looks for a partially present entity.
    //
    // The covering span replaces the union and emits both pseudonyms, so
    // nothing of either entity remains and reversal still restores the exact
    // original text from `spelling`.
    let end = i + hit.spelling.length;
    let replacement = hit.pseudonym;
    let absorbed = false;
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
      absorbed = true;
    }

    out += s.slice(cursor, i) + replacement;
    spans.push(
      Object.freeze({
        start: i,
        end,
        // The TEXT that was there, not the entry's spelling: a case-insensitive
        // entry matches `Northwind` while its spelling reads `northwind`, and
        // reversal must restore what the log actually said.
        spelling: s.slice(i, end),
        pseudonym: replacement,
        entityId: hit.entityId,
        tier: hit.tier,
        // Two overlapping entities collapsed into one span. The token they
        // SHARED is gone, so `A: Ada Wren Wang` and `B: Ada Wren Reed Wang` both
        // come out as `PERSON_a ORG_b`, identical output from different
        // input. I2 still passes because reverseString is fed the spans, which
        // carry the original text; but BRIEF §3 forbids persisting a map, so
        // the only reversal path that actually exists is regenerating the
        // entity list and hashing candidates, and that path cannot tell the
        // two apart. Counted so the manifest can say so rather than letting
        // "all reversible" imply more than it delivers.
        absorbed,
        cjk: hit.cjk === true,
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
    if (start >= b || end <= a) continue;
    // A match that STRICTLY CONTAINS a protected token is allowed.
    //
    // The guard exists so a semantic pass returning `PERSON` as a name cannot
    // destroy every tier-0 token; `PERSON` inside `PERSON_1` does not contain
    // the token, so that is still refused. What it was also refusing is the
    // case tier 1 cannot otherwise reach at all: a declared entity whose
    // spelling contains a tier-0 spelling. `Devuser Consulting Ltd` becomes
    // `PERSON_3877290 Consulting Ltd` after tier 0, so the declared spelling
    // no longer exists in the cleaned text, tier 1 matched nothing, and the
    // remainder shipped verbatim with every gate green (20,000-trial fuzz:
    // 3,636 leaks, 0 caught). The cleaned form is seeded as a spelling, and
    // this is what lets it match. Reversal is unaffected: the span records the
    // text that was actually there.
    if (start <= a && end >= b && end - start > b - a) continue;
    return true;
  }
  return false;
}

/**
 * Reconstruct the original string from a substituted one plus its spans.
 *
 * Reversal needs the spans because one entity legitimately has many spellings
 * and they all map to one pseudonym, `C:\Users\devuser` and `C:/Users/devuser`
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
