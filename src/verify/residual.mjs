// The residual scan, run on the FINAL SERIALIZED BYTES.
//
// PLAN §2: this is the one place where later is strictly more correct.
// Serialization re-introduces escaping forms the in-memory scan never sees —
// a CJK entity re-emitted as a backslash-u escape, a Windows path re-doubled
// to `C:\\Users\\...`. BRIEF §4.6 recorded both forms on the way in; the same
// transformation applies on the way out. Scan the exact bytes that enter the
// zip and no other bytes.
//
// §F1 is the reason the label is what it is. This scan searches for KNOWN
// entities. A third-party name the seeds never knew and the semantic pass
// missed is, by construction, undetectable by it. Measured: 230 distinct
// emails across a 90-file sample, 228 of them not the user. Emails have a
// regex; names do not. So the indicator reads `known-entity residue: N` and
// never "safe", never "0 leaks".

import { EXAMPLES_PER_REPORT } from '../retain/constants.mjs';
// The left-boundary rule is imported, never re-implemented. When the scan had
// its own copy, both copies had the same escape-tail bug and agreed with each
// other, which is how a leak was reported as `known-entity residue: 0`.
import { leftBoundaryBlocks, rightBoundaryBlocks, equalsFold, foldLower } from '../substitute/engine.mjs';

// This file used to keep its own copy of WORD_RE and isWordChar. They were
// dead, and they were dead wrong in the same way the substituter's were, which
// is the shape the header above records: two copies of the boundary rule agreed
// with each other and a leak was reported as `known-entity residue: 0`. The
// rule is imported, never re-implemented, so there is nothing here to drift.

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

// At or above this length a glued spelling earns a row whatever is beside it.
//
// Over one shipped archive (18.8 MB of exported bytes, 2026-08-24), counting
// occurrences the boundary rule refused, for ten plausible seeds at each
// length:
//
//   3 characters   median 643 occurrences, worst 1,996
//   4 characters   median  13 occurrences, worst   270
//   5 characters   median   0 occurrences, worst    14
//
// The 14 at five characters were the finding this report exists for. Below
// five the report was a wall of `array`, and docs/cli-ux.md §7 and §F7 both say
// what happens to a check that fires constantly.
const GLUED_MIN = 5;

// Below GLUED_MIN a row still has to be earned, and what earns it is the
// neighbour rather than the length.
//
// The measurement above averaged two populations. Re-measured over ~20 MB of
// session logs, per seed, splitting the refused occurrences by whether the
// neighbour that actually BLOCKS is a letter:
//
//   3 chars   letter-blocked median 412, worst 8,371 | sep/digit median 20, worst 52
//   4 chars   letter-blocked median  46, worst   113 | sep/digit median  4, worst 26
//
// The flood is the letter class entirely. The separator/digit class is one to
// two orders of magnitude smaller and is where the real leaks sit:
// `project_<name>_notes.md`, `kv-<name>0123`, `HKID_<Name>Yan.jpg`. Gating on
// length denied a disclosure to every user with a three- or four-character
// given name, which is the common case for Chinese, Korean and Japanese
// romanisations, and that population is not random.
//
// The floor stays because a one- or two-character needle has no useful
// boundary rule at all, which is the same argument seed.mjs makes at
// rejectReason.
const GLUED_SEP_MIN = 3;

// Deliberately `\p{L}` and not `[A-Za-z]`: the boundary rule itself is
// Unicode-aware, so the test for "a letter blocked this" has to be too or a
// Cyrillic neighbour would read as a separator.
const ALPHA_RE = /\p{L}/u;

/**
 * Is this a spelling whose glued occurrences are worth putting in front of a
 * reader?
 *
 * Tier 0 and `person`, which is exactly the set of spellings that identify the
 * UPLOADER: the OS username, `git config user.name`, `git config user.email`
 * and its local part, and their own handles swept out of an address. Those are
 * the measured cases. The username survived inside cloud resource names such
 * as `stdevuser-prod` and `kv-devuser37557093578778`, glued on both sides, and
 * the export reported zero residue.
 *
 * The other kinds are deliberately out, and each for its own reason rather
 * than for tidiness:
 *
 *   workspace  a path is already substituted as a path, so its glued form is
 *              its own longer form and every deeper path under it would be a
 *              row.
 *   org        a remote owner glued to a digit or a hyphenless suffix is a
 *              repo, a bucket or a resource the org already puts its name on.
 *   machine    an MCP server name occurs only as `mcp__NAME__tool`, and the
 *              substituter's `_` exception already matches every one.
 *   tier 1     these come from the semantic pass, which names third parties.
 *              A reader cannot act on a glued occurrence of someone else's
 *              surname the way they can act on their own username.
 */
function gluedWorthy(entry, bytes, at, end, lb, rb) {
  if (entry.tier !== 0 || entry.kind !== 'person') return false;
  if (entry.spelling.length >= GLUED_MIN) return true;
  if (entry.spelling.length < GLUED_SEP_MIN) return false;
  // Only the side that BLOCKS is tested. In `HKID_<Name>Yan` the right-hand
  // uppercase is a camel hump, so rightBoundaryBlocks already said no, and
  // testing that character anyway would throw away the leak this exists for.
  return !(lb && ALPHA_RE.test(bytes[at - 1])) && !(rb && ALPHA_RE.test(bytes[end]));
}

/**
 * @param {string} bytes     the serialized output, as one string
 * @param {object} table     the substitution table (entries carry spellings)
 * @param {Set<string>} knownUuids  rewritten message/session uuids (§F5)
 * @returns {Readonly<{entityHits, uuidHits, entityCount, uuidCount}>}
 */
export function residualScan(bytes, table, knownUuids = new Set()) {
  const entityHits = [];

  // The serialized form of a spelling is what actually lands in the file. Both
  // are searched: the decoded form (present wherever the text needed no
  // escaping) and JSON.stringify's own escaping of it, which is how a CJK
  // entity or a Windows path re-enters the bytes in a shape the in-memory scan
  // never saw.
  //
  // Indexed by first character and swept in ONE pass. An indexOf loop per form
  // is O(forms x bytes): with a few hundred entity spellings over tens of
  // megabytes of output that is tens of gigabytes of scanning, and a check
  // nobody is willing to wait for is a check that gets switched off (§F7's
  // failure mode, arriving as latency instead of noise).
  const byFirst = new Map();
  for (const entry of table.entries) {
    for (const form of new Set([entry.spelling, jsonEscaped(entry.spelling)])) {
      if (form.length === 0) continue;
      // A case-insensitive entry is matched, and therefore scanned for, in any
      // casing. Indexing it under one case only would let `Northwind` through a
      // scan whose table knows `northwind` — the exact shape of the 1,804-
      // occurrence leak this pairing exists to make impossible.
      // `second` is a one-character pre-check. residualScan is linear in the
      // number of spellings — measured over a fixed 12.6 MB string: 216 ms at
      // 10 spellings, 2,791 ms at 1,000, 7,798 ms at 3,000 — and the spelling
      // count itself grows with the corpus, so the sweep is quadratic in
      // corpus size. Most probes in a bucket differ from the text at the
      // SECOND character, and rejecting those with one comparison rather than
      // a full fold-compare is the cheapest large constant available.
      const lower = entry.lower ? foldLower(form) : null;
      const probe = {
        form,
        entry,
        lower,
        second: form.length > 1 ? form[1] : null,
        secondLower: lower !== null && lower.length > 1 ? lower[1] : null,
      };
      const keys = entry.lower
        ? new Set([form[0], form[0].toLowerCase(), form[0].toUpperCase()])
        : new Set([form[0]]);
      for (const key of keys) {
        if (!byFirst.has(key)) byFirst.set(key, []);
        byFirst.get(key).push(probe);
      }
    }
  }
  for (const bucket of byFirst.values()) bucket.sort((a, b) => b.form.length - a.form.length);

  // Embedded occurrences — a spelling sitting inside a longer word — are
  // counted but do NOT fail the export.
  //
  // BRIEF §4.5 row 4 labels `ray` inside `array index` a CORRECT non-match, so
  // a gate that failed on it would refuse every export forever over behaviour
  // the brief demands. That is §F7's "a scan that cries wolf is the first
  // thing switched off", arriving as a permanently red gate.
  //
  // The honest handling is that they are a different finding class: reported
  // as a number the reader can see, and covered by the "NOT protected against"
  // block, rather than either silently ignored or treated as a leak.
  let embedded = 0;
  // Counted separately from `embedded`, because the reason is different and so
  // is what a reader can do about it. An escape artifact IS legible to anyone
  // who greps the shipped file — measured 2026-08-22: 16 occurrences of the OS
  // username and 2 of the storage slug, beside a printed
  // `known-entity residue 0`. Exempting it silently was the part that was
  // wrong, not the exemption.
  let escapeArtifacts = 0;
  // The same occurrences as `embedded`, kept per spelling and scoped, so a
  // reader gets rows they can act on instead of one aggregate they cannot.
  //
  // Collected in THIS sweep rather than a second one. A separate boundary-off
  // scanner would be a second matcher over the same bytes, and this file's own
  // header records what happened last time the scan had its own copy of the
  // boundary rule: both copies had the same bug, agreed with each other, and a
  // leak was reported as `known-entity residue: 0`.
  const glued = new Map();
  // The occurrences gluedWorthy refused for the letter beside them, kept per
  // spelling so the limits block can name them.
  //
  // renderGluedResidue returns without printing when there are no rows, so
  // without this a three- or four-character username whose occurrences are all
  // letter-blocked produces an empty list, and an empty list beside a green
  // `known-entity residue 0` reads as a clean result. It is not: it is not
  // examined. Counted here rather than re-derived later, because the only
  // place that knows which side blocked is this sweep.
  const notListed = new Map();

  for (let i = 0; i < bytes.length && entityHits.length <= 10_000; i += 1) {
    const bucket = byFirst.get(bytes[i]);
    if (bucket === undefined) continue;
    for (const { form, entry, lower, second, secondLower } of bucket) {
      if (second !== null) {
        const next = bytes[i + 1];
        if (next === undefined) continue;
        if (next !== second && (secondLower === null || foldLower(next) !== secondLower)) continue;
      }
      if (lower === null ? !bytes.startsWith(form, i) : !equalsFold(bytes, i, lower)) continue;
      // A match that begins inside a JSON escape sequence is an artifact of
      // reading serialized bytes as flat text, not a leak.
      //
      // Measured on the real corpus: one session records an ENOENT whose path
      // a tool had already double-decoded, so the retained string genuinely
      // holds CR + "ayku". Serialized, that is the two bytes `\` `r` followed
      // by `ayku` — and the literal substring "devuser" therefore appears in the
      // byte stream while appearing nowhere in the decoded text. Failing the
      // export on it is §F7 exactly: a scan that cries wolf.
      //
      // The test is the standard one: a backslash is an escape introducer only
      // when preceded by an even number of backslashes, so a match starting
      // immediately after an ODD run is inside an escape.
      if (startsInsideEscape(bytes, i)) {
        escapeArtifacts += 1;
        break;
      }
      // Same boundary rule as the substituter, for the same reason.
      const end = i + form.length;
      if (end > bytes.length) continue;
      // Named, because gluedWorthy needs to know WHICH side blocked: a short
      // spelling earns a row only where nothing alphabetic is doing the
      // blocking.
      const lb = leftBoundaryBlocks(bytes, i, entry);
      const rb = rightBoundaryBlocks(bytes, end, entry);
      if (lb || rb) {
        embedded += 1;
        if (gluedWorthy(entry, bytes, i, end, lb, rb)) {
          let rec = glued.get(entry.spelling);
          if (rec === undefined) {
            rec = {
              entityId: entry.entityId,
              spelling: entry.spelling,
              count: 0,
              excerpt: excerptAt(bytes, i, form.length),
            };
            glued.set(entry.spelling, rec);
          }
          rec.count += 1;
        } else if (entry.tier === 0 && entry.kind === 'person') {
          notListed.set(entry.spelling, (notListed.get(entry.spelling) ?? 0) + 1);
        }
        break;
      }
      entityHits.push(
        Object.freeze({
          entityId: entry.entityId,
          spelling: entry.spelling,
          form,
          offset: i,
          excerpt: excerptAt(bytes, i, form.length),
        }),
      );
      break;
    }
  }

  // §F5: account UUIDs match no detector — not path-shaped, not name-shaped,
  // not high-entropy-secret-shaped. So seed the scan with "any UUID that is
  // not a known message or session uuid".
  const uuidHits = [];
  UUID_RE.lastIndex = 0;
  let m;
  while ((m = UUID_RE.exec(bytes)) !== null) {
    if (knownUuids.has(m[0])) continue;
    uuidHits.push(Object.freeze({ uuid: m[0], offset: m.index, excerpt: excerptAt(bytes, m.index, m[0].length) }));
    if (uuidHits.length > 10_000) break;
  }

  const gluedHits = Object.freeze(
    [...glued.values()]
      .sort((a, b) => b.count - a.count || (a.spelling < b.spelling ? -1 : 1))
      .map((r) => Object.freeze(r)),
  );

  return Object.freeze({
    entityHits: Object.freeze(entityHits),
    uuidHits: Object.freeze(uuidHits),
    entityCount: entityHits.length,
    embedded,
    escapeArtifacts,
    gluedHits,
    gluedCount: gluedHits.reduce((a, r) => a + r.count, 0),
    gluedNotListed: Object.freeze(
      [...notListed]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([spelling, count]) => Object.freeze({ spelling, count })),
    ),
    uuidCount: uuidHits.length,
    entitiesScanned: table.entries.length,
  });
}

/**
 * True when position `at` is the character immediately after an odd-length run
 * of backslashes — i.e. inside a JSON escape sequence rather than at the start
 * of real content. Exported so the selftest can pin it directly.
 */
export function startsInsideEscape(bytes, at) {
  let backslashes = 0;
  for (let j = at - 1; j >= 0 && bytes[j] === '\\'; j -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** How JSON.stringify would write this text inside a string literal. */
export function jsonEscaped(s) {
  const quoted = JSON.stringify(s);
  return quoted.slice(1, -1);
}

function excerptAt(bytes, at, len) {
  const start = Math.max(0, at - EXCERPT_CONTEXT);
  const end = Math.min(bytes.length, at + len + EXCERPT_CONTEXT);
  return bytes.slice(start, end).replace(/\s+/g, ' ');
}

// The same `??` root cause as the MCP seeder, with a smaller blast radius and
// a worse failure. `??` treats only null and undefined as absent, so a blank
// DEIDENT_EXCERPT_CONTEXT became Number('') === 0 and every printed example
// lost its surrounding context. A non-numeric value was worse still: NaN
// reaches String.prototype.slice, every excerpt comes out empty, and the
// examples ARE the remedy a residue refusal offers.
const EXCERPT_CONTEXT_SET = Number(process.env.DEIDENT_EXCERPT_CONTEXT);
const EXCERPT_CONTEXT = Number.isFinite(EXCERPT_CONTEXT_SET) && EXCERPT_CONTEXT_SET > 0 ? EXCERPT_CONTEXT_SET : 30;

/** The report line. cli-ux §7: this exact wording, never "safe". */
export function residueLine(scan) {
  return `${scan.entityCount} occurrences of ${scan.entitiesScanned} entity spellings`;
}

/** Entity residue only, for a gate that does not look at UUIDs. */
export function entityExamples(scan) {
  return scan.entityHits.slice(0, EXAMPLES_PER_REPORT).map((h) => `  ${h.entityId}  …${h.excerpt}…`);
}

export function firstExamples(scan) {
  return [
    ...scan.entityHits.slice(0, EXAMPLES_PER_REPORT).map((h) => `  ${h.entityId}  …${h.excerpt}…`),
    ...scan.uuidHits.slice(0, EXAMPLES_PER_REPORT).map((h) => `  unknown uuid ${h.uuid}`),
  ];
}
