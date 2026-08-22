// The verification gates. Writes nothing, repairs nothing.
//
// PLAN §4.1 lists eleven invariants; the four that gate the export live here.
// Any failure becomes a RefusalError, and by construction the zip writer is
// unreachable until these have returned pass (PLAN §2, step 17).

import { RefusalError } from '../cli/errors.mjs';
import { allOccurrences, reverseString, substituteString } from '../substitute/engine.mjs';
import { residualScan, residueLine, firstExamples } from './residual.mjs';
import { EXAMPLES_PER_REPORT } from '../retain/constants.mjs';

/**
 * I2 — substitution reversibility, at STRING level, before serialization
 * (BRIEF §4.7a). Run after serialization and it tests the JSON escaper rather
 * than the substituter, and the bug class it exists for — ordering, overlap,
 * prefix collision — becomes invisible.
 *
 * Four independent properties. Reconstruction alone would be a tautology (the
 * spans were produced by the same pass that consumes them), so maximality and
 * completeness are computed by allOccurrences: a different algorithm, an
 * exhaustive indexOf sweep per entry rather than one indexed left-to-right
 * scan. Two implementations agreeing is evidence; one agreeing with itself is
 * not.
 *
 * @param {Iterable<{path,before,after,spans}>} strings  every changed string
 */
export function checkSubstitution(strings, table) {
  const failures = [];
  let replacements = 0;

  for (const s of strings) {
    replacements += s.spans.length;

    // (1) Fidelity: each span names the text it actually covers.
    for (const span of s.spans) {
      if (s.before.slice(span.start, span.end) !== span.spelling) {
        failures.push(fail(s, `span ${span.start}..${span.end} does not cover "${span.spelling}"`));
      }
    }

    // (2) Non-overlap and ordering: the interval mask never released a region
    // it had claimed, and never claimed one twice.
    for (let i = 1; i < s.spans.length; i += 1) {
      if (s.spans[i].start < s.spans[i - 1].end) {
        failures.push(fail(s, `spans ${i - 1} and ${i} overlap`));
      }
    }

    // (3) Reversibility.
    const back = reverseString(s.after, s.spans);
    if (back !== s.before) failures.push(fail(s, 'reverse(substitute(s)) !== s'));

    // (4) Maximality and completeness, by the independent algorithm.
    const occurrences = allOccurrences(s.before, table);
    const covered = (start, end) => s.spans.some((sp) => sp.start <= start && sp.end >= end);
    for (const occ of occurrences) {
      if (covered(occ.start, occ.end)) continue;
      // An occurrence not covered by any span is only legitimate if it
      // straddles a span boundary — i.e. it starts inside a claimed region.
      const straddles = s.spans.some((sp) => occ.start < sp.end && occ.end > sp.start);
      if (!straddles) {
        failures.push(
          fail(s, `missed "${occ.entry.spelling}" at ${occ.start}: the scan did not replace an occurrence it should have`),
        );
      }
    }
    for (const span of s.spans) {
      const longer = occurrences.find(
        (o) => o.start === span.start && o.end > span.end,
      );
      if (longer) {
        failures.push(
          fail(s, `chose "${span.spelling}" at ${span.start} where "${longer.entry.spelling}" was longer`),
        );
      }
    }

    if (failures.length > 50) break;
  }

  return Object.freeze({
    name: 'substitution invariant',
    ok: failures.length === 0,
    detail: `${replacements.toLocaleString('en-US')} replacements, ${failures.length === 0 ? 'all reversible' : `${failures.length} failed`}`,
    failures: Object.freeze(failures.slice(0, EXAMPLES_PER_REPORT)),
    replacements,
  });
}

function fail(s, message) {
  // BRIEF §4.7 / PLAN §4.2: the offending string is redacted to 40 characters.
  // A refusal that prints the raw string leaks the very thing it is guarding.
  return Object.freeze({ where: s.path, message, excerpt: `${s.before.slice(0, 40)}…` });
}

export function substitutionRefusal(result) {
  return new RefusalError('a replacement is not reversible', {
    why: [
      'This is an ordering or overlap bug in deident, not a configuration problem.',
      'Nothing was written.',
      '',
      ...result.failures.map((f) => `  ${f.where}: ${f.message}`),
    ],
    remedies: [{ label: 'Report with the lines above', command: 'file an issue against deident' }],
  });
}

/**
 * I4 + I5 — known-entity residue and unknown UUIDs, on the serialized bytes.
 */
export function checkResidue(bytes, table, knownUuids) {
  const scan = residualScan(bytes, table, knownUuids);
  return Object.freeze({
    name: 'known-entity residue',
    ok: scan.entityCount === 0 && scan.uuidCount === 0,
    detail: residueLine(scan),
    scan,
  });
}

export function residueRefusal(result) {
  const scan = result.scan;
  return new RefusalError(
    `${scan.entityCount} known-entity occurrence${scan.entityCount === 1 ? '' : 's'} and ${scan.uuidCount} unknown UUID${scan.uuidCount === 1 ? '' : 's'} survived into the output`,
    {
      why: [
        'The output still contains material the entity table was supposed to replace.',
        'Nothing was written.',
        '',
        ...firstExamples(scan),
      ],
      remedies: [{ label: 'Report with the lines above', command: 'file an issue against deident' }],
    },
  );
}

/**
 * I6 — the semantic pass ran. §3 and §F1: without it the tool cannot honestly
 * claim safety, so the export is refused. Checked at step 11 and again at
 * step 17, because a refusal a single skipped code path can bypass is not a
 * refusal.
 */
export function checkSemanticPass(tier1) {
  const ran = tier1 !== null && tier1 !== undefined && tier1.ran === true;
  return Object.freeze({
    name: 'semantic pass',
    ok: ran,
    detail: ran
      ? `${tier1.source} · ${tier1.entities.length} entities`
      : 'did not run',
    tier1,
  });
}

export function semanticRefusal(candidatesPath) {
  return new RefusalError('the semantic pass has not run', {
    why: [
      'Entity discovery from prose is required. The residual scan can only find',
      'entities it already knows about, so without this pass a "0 residue" result',
      'would be meaningless.',
      '',
      candidatesPath
        ? `The tier-0-cleaned prose to review is at:  ${candidatesPath}`
        : 'Run "deident export --preview" first to produce the candidates file.',
    ],
    remedies: [
      { label: 'Inside Claude Code', command: '/deident-scan' },
      { label: 'Or supply a list', command: 'deident export --entities entities.json' },
    ],
  });
}

/**
 * Run everything and return the report rows in the order cli-ux §6 prints
 * them. The caller turns any `ok: false` into the matching refusal.
 */
export function runAllChecks(state) {
  return Object.freeze([
    Object.freeze({
      name: 'serialization',
      ok: state.roundTripFailures.length === 0,
      detail: `${state.linesRead.toLocaleString('en-US')} / ${state.linesRead.toLocaleString('en-US')} lines byte-identical`,
    }),
    state.substitution,
    Object.freeze({
      name: 'pseudonym namespace',
      ok: state.namespaceHits.length === 0,
      detail:
        state.namespaceHits.length === 0
          ? `no pre-existing ${state.namespace ? `${state.namespace}_` : ''}PERSON_n tokens`
          : `${state.namespaceHits.length} pre-existing tokens`,
    }),
    state.residue,
    state.semantic,
  ]);
}

/** Turn the report rows into printable {label, detail, ok}. */
export function toReportRows(checks) {
  return checks.map((c) => Object.freeze({ label: c.name, detail: c.detail, ok: c.ok }));
}
