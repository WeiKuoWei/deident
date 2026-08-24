// How many times each declared spelling would actually be replaced.
//
// Every gate this tool has asks whether a substitution was done CORRECTLY. None
// asks whether it should have been done at all, and a wrong replacement that is
// reversible satisfies all five of them.
//
// Measured 2026-08-24 on the live entity file: `會議` — an ordinary noun meaning
// "meeting" — was a declared spelling, so it was a needle. The word is
// fabricated and the counts are real; the shape is that it is HAN, which is
// what leaves it with no boundary rule. `isWordChar` is
// /[A-Za-z0-9_]/, so a Han needle gets needsLeft false and needsRight false and
// therefore no boundary rule at all. 202 occurrences of a common word were
// replaced with a pseudonym across a corpus that had already been delivered,
// with the serialization invariant green, the substitution invariant green and
// known-entity residue at zero. Twelve agent passes over that corpus did not
// find it. This file would have printed it on the first run.
//
// It is deliberately NOT a gate. Frequency does not separate a noun from a name:
// on the same corpus 會議 (noun, must not be replaced) counted 202, 林大明 (a
// name, must be replaced) counted 17, and 遠帆 (a brokerage, a real identity)
// counted 255 in between. A threshold that catches the first would refuse the
// third, which is §F7's cry-wolf failure arriving on schedule. The number goes
// in front of a reader; the reader decides.

import { leftBoundaryBlocks, rightBoundaryBlocks, equalsFold, buildTable } from '../substitute/engine.mjs';
import { isCjkOnly } from './variants.mjs';

/** Characters of context kept either side of the one excerpt per spelling. */
const EXCERPT_CONTEXT = 60;

/**
 * Count, per spelling, the occurrences that WOULD be replaced.
 *
 * The same bucketed single-pass sweep residualScan uses, and the same boundary
 * helpers imported from the substituter, because a probe with its own matcher
 * would answer a question about a matcher nobody ships. An occurrence the
 * boundary rule rejects is not counted: the reader is being told what the
 * substituter would do, not what a grep would find.
 *
 * An item may be a bare string, or `{text, at}` where `at` says which session
 * and which record the string came from. The tagged form is what lets one
 * sweep answer both questions: `sink` is called once per occurrence and builds
 * the drill-down index cli-ux §5 needs, so §5 costs no extra pass over the
 * corpus. A bare string never calls `sink`, which is why uncoveredNameParts,
 * which probes throwaway candidate tables, records nothing.
 *
 * @param {Iterable<string|{text: string, at: object}>} texts pre-substitution strings
 * @param {object} table from buildTable
 * @param {?(entry: object, at: object, s: string, from: number, to: number) => void} sink
 * @returns {ReadonlyArray<{entityId, pseudonym, kind, spelling, count, excerpt}>} descending by count
 */
export function probeCounts(texts, table, sink = null) {
  const byFirst = new Map();
  for (const entry of table.entries) {
    if (entry.spelling.length === 0) continue;
    const lower = entry.lower ? entry.spelling.toLowerCase() : null;
    const probe = {
      entry,
      lower,
      second: entry.spelling.length > 1 ? entry.spelling[1] : null,
      secondLower: lower !== null && lower.length > 1 ? lower[1] : null,
    };
    const keys = entry.lower
      ? new Set([entry.spelling[0], entry.spelling[0].toLowerCase(), entry.spelling[0].toUpperCase()])
      : new Set([entry.spelling[0]]);
    for (const key of keys) {
      if (!byFirst.has(key)) byFirst.set(key, []);
      byFirst.get(key).push(probe);
    }
  }
  // Longest first, so a spelling contained in a longer one does not claim the
  // hit. Same ordering rule as buildTable, for the same reason.
  for (const bucket of byFirst.values()) bucket.sort((a, b) => b.entry.spelling.length - a.entry.spelling.length);

  const counts = new Map();
  for (const item of texts) {
    const tagged = typeof item !== 'string' && item !== null && typeof item === 'object';
    const s = tagged ? item.text : item;
    const at = tagged ? item.at ?? null : null;
    if (typeof s !== 'string' || s.length === 0) continue;
    for (let i = 0; i < s.length; i += 1) {
      const bucket = byFirst.get(s[i]);
      if (bucket === undefined) continue;
      for (const { entry, lower, second, secondLower } of bucket) {
        if (second !== null) {
          const next = s[i + 1];
          if (next === undefined) continue;
          if (next !== second && (secondLower === null || next.toLowerCase() !== secondLower)) continue;
        }
        if (lower === null ? !s.startsWith(entry.spelling, i) : !equalsFold(s, i, lower)) continue;
        const end = i + entry.spelling.length;
        if (end > s.length) continue;
        if (leftBoundaryBlocks(s, i, entry) || rightBoundaryBlocks(s, end, entry)) break;
        let rec = counts.get(entry.spelling);
        if (rec === undefined) {
          rec = {
            entityId: entry.entityId,
            // The token a reader drills into. Without it the count and
            // `review --entity` are two disconnected facts and the reader has
            // to guess which pseudonym a spelling became.
            pseudonym: entry.pseudonym,
            kind: entry.kind,
            spelling: entry.spelling,
            count: 0,
            excerpt: s.slice(Math.max(0, i - EXCERPT_CONTEXT), Math.min(s.length, end + EXCERPT_CONTEXT)).replace(/\s+/g, ' '),
          };
          counts.set(entry.spelling, rec);
        }
        rec.count += 1;
        if (sink !== null && at !== null) sink(entry, at, s, i, end);
        i = end - 1;
        break;
      }
    }
  }

  // A declared spelling that matched NOTHING is the other failure of the same
  // measurement, and it is reported for the same reason: a redaction string
  // nobody typed correctly protects nothing, and today it is silent.
  for (const entry of table.entries) {
    if (counts.has(entry.spelling)) continue;
    counts.set(entry.spelling, {
      entityId: entry.entityId,
      pseudonym: entry.pseudonym,
      kind: entry.kind,
      spelling: entry.spelling,
      count: 0,
      excerpt: '',
    });
  }

  return Object.freeze(
    [...counts.values()]
      .sort((a, b) => b.count - a.count || (a.spelling < b.spelling ? -1 : 1))
      .map((r) => Object.freeze(r)),
  );
}

/**
 * The rows a reader needs to see, which is both tails and neither middle.
 *
 * A spelling matched thousands of times is either the corpus's most important
 * entity or an ordinary word; a spelling matched zero times is a redaction that
 * did not happen. Both need a human. The middle is unremarkable by construction.
 */
export function probeOutliers(rows, { top = 15, includeZero = true } = {}) {
  const hits = rows.filter((r) => r.count > 0).slice(0, top);
  const zeros = includeZero ? rows.filter((r) => r.count === 0) : [];
  return Object.freeze({ hits: Object.freeze(hits), zeros: Object.freeze(zeros) });
}

/** A name part shorter than this is a needle with no useful boundary rule. */
const MIN_NAME_PART = 3;

/**
 * The longest run of words proposed from one spelling.
 *
 * Every shorter run inside a long one is proposed too, so a longer run adds
 * rows without adding findings, and a spelling that is a whole quoted sentence
 * would otherwise contribute a candidate per word position.
 */
const MAX_RUN_WORDS = 4;

/**
 * The pieces of one declared spelling that are worth proposing on their own.
 *
 * A single word is proposed only from a `person`. A contiguous run of two or
 * more words is proposed from ANY kind. That asymmetry is the whole rule, and
 * it is what admits a street out of an office address while rejecting
 * `Advisory` out of an org name:
 *
 *   A word taken out of a person's name is still a name. That is what a
 *   surname is. A word taken out of anything else is a noun.
 *
 * Measured 2026-08-24 over the live entity list and the tier-0-cleaned prose
 * of the same run. Proposing single words from every kind produced 52
 * candidates, 16 of which occurred in the prose, led by `and` at 337 and
 * followed by `Pro` 11, `Baltimore` 4, `Founders` 3, `Commercial` 2, `USD` 2,
 * `Industry` 1, `Road` 1, `South` 1: ordinary words at the top of a list a
 * person is supposed to read line by line, which is §F7's cry-wolf failure
 * arriving as a report nobody finishes. Adding runs of two or more added none
 * of that noise, because two adjacent words a corpus repeats verbatim are not
 * an accident of vocabulary. `Bramble Road` names one street (fabricated here,
 * the real one is in the entity file this was measured on); `Advisory` on its
 * own names nothing.
 *
 * A run is also a longer needle, so the boundary rule has more to work with,
 * which is the same argument SEPARATOR_BOUNDARY_MIN makes in the substituter.
 *
 * One condition on top, and it is a correctness rule rather than a tidiness
 * one: a word that starts with a lowercase Latin letter cannot be part of a
 * run. Measured on the live corpus after the run rule went in, a declared
 * `Founders and Ivy` proposed `and Ivy` at 7 occurrences, and every one of
 * them was an occurrence of the declared name `Ivy`. The probe table is sorted
 * longest first, so a run that merely prefixes a declared spelling with a
 * connector outranks it and claims spans that are already covered, and the
 * report then says the prose still names someone the export replaces.
 *
 * The cost, stated rather than hidden: a name with a lowercase particle
 * (`van Dijk`, `de Vries`) contributes no run. For a person the single-word
 * path still proposes `Dijk`, which is the half that carries the identity.
 */
function partsOf(spelling, kind) {
  // Split on whitespace, then strip whatever punctuation the writer put around
  // each word. A word whose TRAILING punctuation was stripped ENDS the run:
  // an address reads `…, 20-28 Bramble Road, Harbour Point`, and `Road Harbour`
  // is a phrase nobody wrote.
  const words = [];
  for (const raw of spelling.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    words.push({ word, ends: word.length === 0 || /[^\p{L}\p{N}]$/u.test(raw) });
  }

  const found = [];
  if (kind === 'person') {
    for (const { word } of words) {
      if (word.length >= MIN_NAME_PART) found.push(word);
      // A name written without spaces between its parts has nothing for the
      // loop above to split, so the only thing it proposes is the whole
      // spelling, which is already declared and gets filtered. Propose the two
      // ways such a name divides instead: the leading and the trailing two
      // codepoints. The floor of 2 is the one seed.mjs already applies to this
      // class, because a one-codepoint needle has no boundary rule and
      // over-matches inside a longer word (BRIEF §4.5 row 3).
      //
      // Bounded and self-limiting: at most two extra probe rows per person,
      // and uncoveredNameParts drops every row with count 0, so the half that
      // is only ever part of the full name disappears on its own.
      const cp = [...word];
      if (cp.length >= 3 && isCjkOnly(word)) {
        found.push(cp.slice(0, 2).join(''), cp.slice(-2).join(''));
      }
    }
  }
  // A connector breaks a run exactly the way punctuation does. Both mean the
  // same thing: the identity does not continue across it.
  const carries = (word) => word.length > 0 && !/^[a-z]/.test(word);
  for (let i = 0; i < words.length; i += 1) {
    if (!carries(words[i].word)) continue;
    const run = [];
    for (let j = i; j < words.length && run.length < MAX_RUN_WORDS; j += 1) {
      if (!carries(words[j].word)) break;
      run.push(words[j].word);
      // Joined with one space, which is the form a corpus writes even where
      // the declared spelling was laid out with more.
      if (run.length >= 2) found.push(run.join(' '));
      if (words[j].ends) break;
    }
  }
  return found;
}

/**
 * Parts of a declared spelling that occur ALONE in the corpus and are not
 * themselves declared.
 *
 * Measured 2026-08-24, comparing entity lists produced at three model tiers on
 * one corpus (docs/model-tier.md): every tier named "Grace Hopper" and the mid
 * tier never named the bare "Morgan", and the same held for Hsu, Mistry,
 * Smith, Abdullah, Reuther and Pocock. Substituting the full name and leaving
 * the bare surname is a half-replacement: the pseudonym appears once and the
 * prose says who it is two sentences later. The residue scan cannot catch it,
 * because it only looks for what it was given.
 *
 * The same half-replacement reaches every other kind through multi-word
 * spellings. Measured on the same run: a registered office address was
 * declared as ONE comma-separated string, so only the whole string was ever a
 * needle, and the shipped archive still carried the street on its own in two
 * spellings. The building name happened to be covered by another entity; the
 * street was not. See partsOf for the rule that admits the street without proposing
 * `Road`, `Centre` or `Advisory`.
 *
 * A REPORT, not an extra spelling, and for the same reason the probe is not a
 * gate. In this corpus alone, May, Wise and Ray are all parts of real names and
 * all ordinary words; adding them automatically is the 202-occurrence failure
 * with a new source. What is automatic is the FINDING - the count, and one
 * excerpt showing how the word is actually used.
 *
 * @param {ReadonlyArray<{kind:string, spellings:ReadonlyArray<string>}>} entities
 * @param {Iterable<string>} texts
 * @returns {ReadonlyArray<{part, from, count, excerpt}>} descending by count
 */
export function uncoveredNameParts(entities, texts) {
  const declared = new Set();
  for (const e of entities ?? []) {
    for (const s of e?.spellings ?? []) {
      if (typeof s === 'string') declared.add(s.trim().toLowerCase());
    }
  }

  // part -> the declared spelling it came from, for the report line, and the
  // SHORTEST of them rather than the longest.
  //
  // readEntities runs every declared spelling through expandVariants, so a
  // path-shaped spelling arrives carrying escaping twins that are longer than
  // the original: an address with `12/F` in it also has a `12\\F` form. The
  // label is the column that tells a reader which entry in their own file to
  // edit, and pointing it at a variant they never typed makes the row unusable.
  const candidates = new Map();
  for (const e of entities ?? []) {
    for (const s of e?.spellings ?? []) {
      // A single-word spelling has no parts: the only piece of it is itself,
      // and it is already a needle.
      //
      // Except that a name written without spaces has no whitespace to test,
      // so this line alone switched the whole detector off for it. Verified
      // against the shipped modules: `Grace Hopper` with a bare `Hopper` in the
      // prose returned a row, `王大明` with a bare `大明` returned nothing, and
      // the substituter shipped the bare half twice with every gate green.
      // That is renderNameParts's own stated failure, word for word.
      if (typeof s !== 'string') continue;
      if (!/\s/.test(s) && !(isCjkOnly(s) && [...s].length >= 3)) continue;
      for (const part of partsOf(s, e.kind)) {
        if (declared.has(part.toLowerCase())) continue;
        const prev = candidates.get(part);
        if (prev === undefined || s.length < prev.length) candidates.set(part, s);
      }
    }
  }
  if (candidates.size === 0) return Object.freeze([]);

  // Counted through the shipped matcher, so "occurs" means "would be replaced"
  // rather than "grep finds it".
  //
  // The table carries the already-declared spellings ALONGSIDE the candidate
  // parts, which is what makes the count mean "appears on its own". buildTable
  // orders longest first and the sweep stops at the first match, so every
  // occurrence inside the full name is claimed by the full name and the part's
  // count is exactly its bare uses. Counting the part alone instead reports
  // every surname in the corpus, including the ones already covered.
  const rowsToProbe = [
    ...[...declared].map((spelling, i) => ({
      id: `NPD${i}`, kind: 'person', pseudonym: `DECLARED_${i}`, spellings: [spelling],
    })),
    ...[...candidates.keys()].map((part, i) => ({
      id: `NP${i}`, kind: 'person', pseudonym: `NAMEPART_${i}`, spellings: [part],
    })),
  ];
  const counts = probeCounts(texts, buildTable(rowsToProbe));

  const rows = [];
  for (const c of counts) {
    if (c.count === 0 || !candidates.has(c.spelling)) continue;
    rows.push(
      Object.freeze({
        part: c.spelling,
        from: candidates.get(c.spelling),
        count: c.count,
        excerpt: c.excerpt,
      }),
    );
  }
  return Object.freeze(rows.sort((a, b) => b.count - a.count || (a.part < b.part ? -1 : 1)));
}
