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
    //
    // Both lookups are indexed. `.some()` per occurrence and `.find()` per span
    // are occurrence x span cross-products: measured, one string with 2,000
    // spans cost 644 ms and one with 40,000 cost 32,002 ms, which is a check
    // nobody waits for and therefore a check that gets switched off (§F7's
    // failure mode arriving as latency). Spans are produced in ascending,
    // non-overlapping order, so a binary search answers "is this covered".
    const occurrences = allOccurrences(s.before, table);
    const covered = (start, end) => {
      let lo = 0;
      let hi = s.spans.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const span = s.spans[mid];
        if (span.end <= start) lo = mid + 1;
        else if (span.start > start) hi = mid - 1;
        else return span.start <= start && span.end >= end;
      }
      return false;
    };
    const longestAt = new Map();
    for (const occ of occurrences) {
      const best = longestAt.get(occ.start);
      if (best === undefined || occ.end > best.end) longestAt.set(occ.start, occ);
    }
    for (const occ of occurrences) {
      if (covered(occ.start, occ.end)) continue;
      // A straddling occurrence used to be whitelisted here, which whitelisted
      // exactly the bug: an entity beginning inside a claimed span and reaching
      // past it had its remainder shipped verbatim, and this check declared
      // that legitimate. The substituter absorbs those into the covering span
      // now, so a straddle reaching this point means the absorption failed and
      // part of a declared entity is about to leave the machine.
      failures.push(
        fail(s, `missed "${occ.entry.spelling}" at ${occ.start}: the scan did not replace an occurrence it should have`),
      );
    }
    for (const span of s.spans) {
      const longer = longestAt.get(span.start);
      if (longer !== undefined && longer.end > span.end) {
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
export function checkSemanticPass(tier1, coverage = null) {
  const ran = tier1 !== null && tier1 !== undefined && tier1.ran === true;
  // An EMPTY list is indistinguishable from not running, and it is exactly the
  // file a failed or interrupted /deident-scan leaves behind. tier1.mjs's own
  // header says a malformed list "must never silently become an empty list,
  // because an empty list passes I6 while delivering nothing" — and then a
  // deliberately empty one did precisely that, printing
  // `semantic pass  --entities empty.json · 0 entities  ok` beside a real zip.
  //
  // And USABLE entities, not declared ones. A list of one entity whose only
  // spelling is `  ` or `a` printed `semantic pass  --entities blank.json ·
  // 1 entities  ok` and shipped a zip: the spelling is rejected downstream by
  // rejectReason, so nothing was substituted, but the gate only counted the
  // array. A list whose every entry is rejected is not a semantic pass, for
  // the same reason an empty list is not — and BRIEF §3 makes this gate the
  // reason the tool can claim safety at all.
  const usable = ran ? tier1.entities.filter((e) => !e.rejected && e.spellings.length > 0).length : 0;
  const delivered = ran && usable > 0;
  // The list AND the per-session accounting. A list on its own says a reader
  // answered; it does not say which sessions the question covered.
  const uncovered = coverage === null ? 0 : coverage.uncovered.length;
  const read = coverage === null ? '' : ` · ${coverage.total - uncovered}/${coverage.total} sessions read`;
  return Object.freeze({
    name: 'semantic pass',
    ok: delivered && uncovered === 0,
    detail: ran
      ? `${tier1.source} · ${usable} entities${usable === tier1.entities.length ? '' : ` (${tier1.entities.length - usable} rejected)`}${read}`
      : 'did not run',
    // `absent` and `empty` first: they are the more fundamental failure and
    // their remedy is the same one whether or not any session is covered.
    why: !delivered ? (ran ? 'empty' : 'absent') : 'uncovered',
    coverage,
    tier1,
  });
}

/**
 * I6, per session.
 *
 * The gate used to be all-or-nothing: supplying `--entities` satisfied it for
 * the whole corpus, however much of that corpus anybody had actually read.
 * With a remembered dictionary that is not good enough, because a repeat run
 * could satisfy it having read nothing new at all — and the corpus grows
 * between runs, which is the ordinary case rather than the exotic one.
 *
 * So the accounting is per session. A session is covered when its prose has
 * been put in front of a reader and the hash of that prose is remembered; a
 * session that is new, or whose content has changed since, has not been. This
 * is STRICTER than the old gate in both directions, including the one that has
 * nothing to do with the dictionary: `export --entities an-old-list.json` over
 * a corpus that has grown used to ship the new sessions on the strength of a
 * list written before they existed.
 *
 * What it cannot check is whether the reader read the file, only that deident
 * put it in front of them. That is the same limit the old gate had, one
 * session at a time instead of one corpus at a time.
 *
 * @param {ReadonlyArray<{id, reason}>} uncovered
 * @param {number} total sessions in this export
 */
export function coverageRefusal(uncovered, total, candidatesPath, opts = {}) {
  const n = uncovered.length;
  // Under --full nothing is wrong and the person asked for this, so saying
  // "have not been through a semantic pass" about sessions they read last week
  // would be the tool stating something false in its most careful moment.
  const reason = opts.full === true
    ? `--full: ${n} session${n === 1 ? '' : 's'} to read again before the next export`
    : `${n} session${n === 1 ? ' has' : 's have'} not been through a semantic pass`;
  return new RefusalError(
    reason,
    {
      why: [
        ...uncovered.slice(0, EXAMPLES_PER_REPORT).map((s) => `  ${s.id}   ${s.reason}`),
        ...(n > EXAMPLES_PER_REPORT ? [`  ... and ${n - EXAMPLES_PER_REPORT} more`] : []),
        '',
        ...(opts.full === true
          ? ['--full ignores what deident remembers you having read, so every session', 'is offered again and the export waits for your answer.']
          : [
              'A session is covered once its prose has been put in front of a reader and',
              'the answer is remembered. Exporting one that never was would mean claiming',
              'a semantic pass covered text nobody has seen.',
            ]),
        '',
        ...(total > n
          ? [`The other ${total - n} session${total - n === 1 ? ' is' : 's are'} covered and were left out of the file below.`]
          : []),
        ...(candidatesPath ? [`The tier-0-cleaned prose to read is at:  ${candidatesPath}`] : []),
      ],
      remedies: [
        { label: 'Read the prose above', command: 'read the file named above, then write deident-entities.json' },
        { label: 'Then supply the list', command: 'deident export --entities deident-entities.json' },
      ],
    },
  );
}

export function semanticRefusal(candidatesPath, why = 'absent') {
  if (why === 'empty') {
    return new RefusalError('the entity list has no usable entity, which is not a semantic pass', {
      why: [
        'Every entry was empty or rejected, which is indistinguishable from a pass',
        'that never ran, and is exactly what a list of blank or one-character',
        'spellings produces.',
        'and it is exactly the file an interrupted discovery run leaves behind.',
        'BRIEF §3: graceful degradation here is silent failure.',
        '',
        candidatesPath ? `The tier-0-cleaned prose to review is at:  ${candidatesPath}` : '',
      ].filter((line) => line !== ''),
      // A remedy is a thing to do, and the thing to do is the same in every
      // harness: produce the candidates file, read it, write the entity list.
      // This used to name a slash command that existed only with the working
      // directory inside this repository, so the tool's most careful moment
      // named a step a Codex user, or anyone working elsewhere, could not run.
      remedies: [
        { label: 'Produce the prose to read', command: 'deident export --preview' },
        { label: 'Then supply the list', command: 'deident export --entities deident-entities.json' },
      ],
    });
  }
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
      { label: 'Produce the prose to read', command: 'deident export --preview' },
      { label: 'Then supply the list', command: 'deident export --entities deident-entities.json' },
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
      ok: (state.namespaceHitCount ?? state.namespaceHits.length) === 0,
      detail:
        state.namespaceHits.length === 0
          ? `no pre-existing ${state.namespace ? `${state.namespace}_` : ''}PERSON_n tokens`
          : `${state.namespaceHitCount ?? state.namespaceHits.length} pre-existing tokens`,
    }),
    state.residue,
    state.semantic,
  ]);
}

/** Turn the report rows into printable {label, detail, ok}. */
export function toReportRows(checks) {
  return checks.map((c) => Object.freeze({ label: c.name, detail: c.detail, ok: c.ok }));
}
