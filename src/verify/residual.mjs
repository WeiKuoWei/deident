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
import { leftBoundaryBlocks, rightBoundaryBlocks, equalsFold } from '../substitute/engine.mjs';

const WORD_RE = /[A-Za-z0-9_]/;
function isWordChar(ch) {
  return ch !== undefined && WORD_RE.test(ch);
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

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
      // casing. Indexing it under one case only would let `GitRoll` through a
      // scan whose table knows `gitroll` — the exact shape of the 1,804-
      // occurrence leak this pairing exists to make impossible.
      // `second` is a one-character pre-check. residualScan is linear in the
      // number of spellings — measured over a fixed 12.6 MB string: 216 ms at
      // 10 spellings, 2,791 ms at 1,000, 7,798 ms at 3,000 — and the spelling
      // count itself grows with the corpus, so the sweep is quadratic in
      // corpus size. Most probes in a bucket differ from the text at the
      // SECOND character, and rejecting those with one comparison rather than
      // a full fold-compare is the cheapest large constant available.
      const lower = entry.lower ? form.toLowerCase() : null;
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

  for (let i = 0; i < bytes.length && entityHits.length <= 10_000; i += 1) {
    const bucket = byFirst.get(bytes[i]);
    if (bucket === undefined) continue;
    for (const { form, entry, lower, second, secondLower } of bucket) {
      if (second !== null) {
        const next = bytes[i + 1];
        if (next === undefined) continue;
        if (next !== second && (secondLower === null || next.toLowerCase() !== secondLower)) continue;
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
      if (leftBoundaryBlocks(bytes, i, entry) || rightBoundaryBlocks(bytes, end, entry)) {
        embedded += 1;
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

  return Object.freeze({
    entityHits: Object.freeze(entityHits),
    uuidHits: Object.freeze(uuidHits),
    entityCount: entityHits.length,
    embedded,
    escapeArtifacts,
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

const EXCERPT_CONTEXT = Number(process.env.DEIDENT_EXCERPT_CONTEXT ?? 30);

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
