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

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * @param {string} bytes     the serialized output, as one string
 * @param {object} table     the substitution table (entries carry spellings)
 * @param {Set<string>} knownUuids  rewritten message/session uuids (§F5)
 * @returns {Readonly<{entityHits, uuidHits, entityCount, uuidCount}>}
 */
export function residualScan(bytes, table, knownUuids = new Set()) {
  const entityHits = [];

  for (const entry of table.entries) {
    // The serialized form of a spelling is what actually lands in the file.
    // Both are searched: the decoded form (present in raw JSON body text that
    // needed no escaping) and JSON.stringify's own escaping of it.
    const forms = new Set([entry.spelling, jsonEscaped(entry.spelling)]);
    for (const form of forms) {
      let from = 0;
      for (;;) {
        const at = bytes.indexOf(form, from);
        if (at === -1) break;
        entityHits.push(
          Object.freeze({
            entityId: entry.entityId,
            spelling: entry.spelling,
            form,
            offset: at,
            excerpt: excerptAt(bytes, at, form.length),
          }),
        );
        from = at + form.length;
        if (entityHits.length > 10_000) break;
      }
      if (entityHits.length > 10_000) break;
    }
    if (entityHits.length > 10_000) break;
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
    uuidCount: uuidHits.length,
    entitiesScanned: table.entries.length,
  });
}

/** How JSON.stringify would write this text inside a string literal. */
export function jsonEscaped(s) {
  const quoted = JSON.stringify(s);
  return quoted.slice(1, -1);
}

function excerptAt(bytes, at, len) {
  const start = Math.max(0, at - 30);
  const end = Math.min(bytes.length, at + len + 30);
  return bytes.slice(start, end).replace(/\s+/g, ' ');
}

/** The report line. cli-ux §7: this exact wording, never "safe". */
export function residueLine(scan) {
  return `${scan.entityCount} occurrences of ${scan.entitiesScanned} entity spellings`;
}

export function firstExamples(scan) {
  return [
    ...scan.entityHits.slice(0, EXAMPLES_PER_REPORT).map((h) => `  ${h.entityId}  …${h.excerpt}…`),
    ...scan.uuidHits.slice(0, EXAMPLES_PER_REPORT).map((h) => `  unknown uuid ${h.uuid}`),
  ];
}
