// How many times each declared spelling would actually be replaced.
//
// Every gate this tool has asks whether a substitution was done CORRECTLY. None
// asks whether it should have been done at all, and a wrong replacement that is
// reversible satisfies all five of them.
//
// Measured 2026-08-24 on the live entity file: `課稅` — an ordinary noun meaning
// taxation — was a declared spelling, so it was a needle. `isWordChar` is
// /[A-Za-z0-9_]/, so a Han needle gets needsLeft false and needsRight false and
// therefore no boundary rule at all. 202 occurrences of a common word were
// replaced with a pseudonym across a corpus that had already been delivered,
// with the serialization invariant green, the substitution invariant green and
// known-entity residue at zero. Twelve agent passes over that corpus did not
// find it. This file would have printed it on the first run.
//
// It is deliberately NOT a gate. Frequency does not separate a noun from a name:
// on the same corpus 課稅 (noun, must not be replaced) counted 202, 小凱拉 (a
// name, must be replaced) counted 17, and 富途 (a brokerage, a real identity)
// counted 255 in between. A threshold that catches the first would refuse the
// third, which is §F7's cry-wolf failure arriving on schedule. The number goes
// in front of a reader; the reader decides.

import { leftBoundaryBlocks, rightBoundaryBlocks, equalsFold, buildTable } from '../substitute/engine.mjs';

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
 * @param {Iterable<string>} texts pre-substitution strings
 * @param {object} table from buildTable
 * @returns {ReadonlyArray<{entityId, kind, spelling, count, excerpt}>} descending by count
 */
export function probeCounts(texts, table) {
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
  for (const s of texts) {
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
            kind: entry.kind,
            spelling: entry.spelling,
            count: 0,
            excerpt: s.slice(Math.max(0, i - EXCERPT_CONTEXT), Math.min(s.length, end + EXCERPT_CONTEXT)).replace(/\s+/g, ' '),
          };
          counts.set(entry.spelling, rec);
        }
        rec.count += 1;
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
 * Parts of a declared person's name that occur ALONE in the corpus and are not
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
 * A REPORT, not an extra spelling, and for the same reason the probe is not a
 * gate. In this corpus alone, May, Wise and Ray are all parts of real names and
 * all ordinary words; adding them automatically is the 202-occurrence failure
 * with a new source. What is automatic is the FINDING - the count, and one
 * excerpt showing how the word is actually used.
 *
 * Only `person`. An org's words are not name parts: splitting "Acme
 * Advisory" proposes "Advisory".
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

  // part -> the longest declared spelling it came from, for the report line.
  const candidates = new Map();
  for (const e of entities ?? []) {
    if (e?.kind !== 'person') continue;
    for (const s of e.spellings ?? []) {
      if (typeof s !== 'string' || !s.includes(' ')) continue;
      for (const raw of s.split(/\s+/)) {
        const part = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (part.length < MIN_NAME_PART) continue;
        if (declared.has(part.toLowerCase())) continue;
        const prev = candidates.get(part);
        if (prev === undefined || s.length > prev.length) candidates.set(part, s);
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
