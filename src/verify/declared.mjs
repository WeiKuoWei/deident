// The one verification whose needles do NOT come from the table it is checking.
//
// Every other check in src/verify is handed `mergedTable` and asks whether the
// output is consistent with it. known-values.json is seeded INTO that table, so
// the check and the thing it checks share a source: a value the safety rules
// rejected never entered the table, and the residue scan is then structurally
// blind to it. Not "might miss it": cannot look for it.
//
// docs/cli-ux.md §12b names the mechanism exactly. `buildTable` puts an entity
// whose pseudonym is null into `flagged` and never into `entries`, and
// `residualScan` sweeps `entries`. A declared value that `rejectReason` refuses
// (shorter than three characters, a single CJK character, a bare filesystem
// root) is therefore never substituted AND never scanned for, while
// `known-entity residue: 0 occurrences of 51 entity spellings` and `archive on
// disk ... ok` both pass. §6a already prints those rows with a dash instead of
// a count and the sentence "may still be in the archive". This is the half that
// was missing: the answer.
//
// So the file is re-read FROM DISK and the needles are derived here, and the
// needles the table already carries are dropped. The two sets are disjoint by
// construction, and that is the property that matters rather than an
// optimisation. cli-ux §12b: "a second pass over the same bytes with the same
// needles would read, in the report, as independent confirmation of a result it
// merely repeated. That is worse than no check." The report says which set this
// covered for the same reason.
//
// NOT a gate, and §12b makes that call with its reason: the person declared a
// value the tool has already told them it cannot safely substitute, so refusing
// the export would be refusing over a choice they made with the reason in front
// of them.

import { loadKnownValues } from '../policy/knownvalues.mjs';
import { excerptAt, jsonEscaped } from './residual.mjs';

// A rejected two-character value can occur tens of thousands of times, and the
// count is reported rather than gated, so an exact total past this point buys
// nothing a reader can act on. Stops one pathological declaration from turning
// a check into a wait.
const COUNT_CAP = 100_000;

/**
 * Sweep the produced bytes for the values the person declared that no other
 * scan carries.
 *
 * Plain substring matching, with no boundary rule. The boundary rule exists to
 * decide whether to REPLACE, and nothing replaced these; any occurrence at all
 * is the finding, and a boundary test here would hide the short-value case that
 * is the whole reason the gap exists.
 *
 * @param {string} bytes    the serialized output, as one string
 * @param {string} saltDir  where known-values.json lives
 * @param {object} table    the table residualScan was given, for the disjoint set
 */
export function checkDeclaredValues(bytes, saltDir, table) {
  const declared = loadKnownValues(saltDir);
  const swept = new Set(table.entries.map((e) => e.spelling));
  const rows = [];
  for (const d of declared) {
    if (swept.has(d.value)) continue;
    // Both forms, for the reason residual.mjs gives: serialization re-introduces
    // escaping the in-memory text never had. A Set because they are equal for
    // any value that needed no escaping, which is most of them.
    let count = 0;
    let excerpt = '';
    for (const form of new Set([d.value, jsonEscaped(d.value)])) {
      if (form.length === 0) continue;
      for (let at = bytes.indexOf(form); at !== -1; at = bytes.indexOf(form, at + form.length)) {
        if (excerpt === '') excerpt = excerptAt(bytes, at, form.length);
        count += 1;
        if (count >= COUNT_CAP) break;
      }
      if (count >= COUNT_CAP) break;
    }
    rows.push(Object.freeze({ value: d.value, kind: d.kind, count, excerpt, capped: count >= COUNT_CAP }));
  }
  return Object.freeze({
    name: 'declared values the table never carried',
    declared: declared.length,
    // How many of the declared list the residue scan really did cover, said as
    // a number so the complementary half is legible rather than implied.
    swept: declared.length - rows.length,
    rows: Object.freeze(rows.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))),
    found: rows.reduce((a, r) => a + r.count, 0),
  });
}
