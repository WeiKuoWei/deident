// The pipeline, in PLAN §2's order. Each step's position is load-bearing and
// the reasons are recorded beside it.
//
//  1 resolveCorpus          6 allowLine                11 tier-1 discovery
//  2 readSession + I1       7 retainRecord             12 tier-1 substitution
//  3 namespace collision    8 seedEntities             13 substitution invariant
//  4 resolveLineCwd         9 buildTable + pseudonyms  14 serialize
//  5 classifyWorkspaces    10 tier-0 substitution      15 residualScan
//                                                      16 renderManifest
//                                                      17 writeZip

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import * as report from './cli/report.mjs';
import { RefusalError, UsageError } from './cli/errors.mjs';
import { resolveCorpus, corpusDateRange } from './corpus/root.mjs';
import { readSession, roundTripRefusal, nestingError } from './corpus/reader.mjs';
import { resolveLineCwd, cwdChangeFrom } from './corpus/cwdtrack.mjs';
import {
  classifyWorkspaces,
  summarizeTiers,
  loadSavedDecisions,
  saveDecisions,
  orphanedDecisions,
  unclassifiedRefusal,
  exportableTiers,
  cwdTierIndex,
} from './policy/workspaces.mjs';
import { groupSessions } from './policy/grouping.mjs';
import { proposeTier, makeRemoteProbe } from './policy/signals.mjs';
import { allowLine, touchedDenied } from './policy/linefilter.mjs';
import { readReview, readSessionDrops, writeReview, renderReviewHtml, REVIEW_FILENAME } from './policy/reviewfile.mjs';
import { seedEntities } from './entities/seed.mjs';
import {
  loadOrCreateSalt,
  readSalt,
  defaultSaltDir,
  assignPseudonyms,
  namespaceRefusal,
  pseudonymPattern,
  pseudonymGuardPattern,
  pseudonymScanPattern,
} from './entities/pseudonym.mjs';
import { writeCandidates, readEntities, CANDIDATES_FILENAME } from './entities/tier1.mjs';
import { probeCounts, probeOutliers } from './entities/probe.mjs';
import { buildTable, substituteString, leftIsWordChar } from './substitute/engine.mjs';
import { substituteRecord, collectStrings } from './substitute/walker.mjs';
import {
  newRetentionContext,
  retainRecord,
  rewriteUuidsInRecord,
  RETENTION_TABLE,
} from './retain/records.mjs';
import {
  checkSubstitution,
  substitutionRefusal,
  checkResidue,
  residueRefusal,
  checkSemanticPass,
  semanticRefusal,
  runAllChecks,
  toReportRows,
} from './verify/checks.mjs';
import { writeZip, readZipFile, safeUnlink } from './output/zip.mjs';
import { writePreview } from './output/preview.mjs';
import { EXAMPLES_PER_REPORT, MIN_REPLAY_MATCH_CHARS } from './retain/constants.mjs';
import { loadUserDeny, setUserDeny } from './policy/userdeny.mjs';

// ------------------------------------------------------------------- scan

export async function runScan(flags, env) {
  const outDir = path.resolve(flags.out ?? process.cwd());
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  // Before anything proposes a tier: matchDenyToken consults these, and a
  // token loaded after classify would silently propose the wrong tier for
  // the very directory it exists to protect.
  setUserDeny(loadUserDeny(saltDir));
  const corpus = resolveCorpus(env, flags.root);

  const loaded = surveyCorpus(corpus, flags);

  // scan REGENERATES review.md, so it reads the old one leniently: every line
  // it can parse is carried forward, every line it cannot is reported and
  // ignored. Refusing here made the recovery command the one command a broken
  // review.md could block, and left the broken file in place.
  const reviewPath = path.join(outDir, REVIEW_FILENAME);
  const reviewProblems = [];
  const lenient = { onProblem: (why) => reviewProblems.push(why) };
  const remembered = loadSavedDecisions(saltDir);
  const saved = { byKey: remembered.workspaces, byName: readReview(reviewPath, lenient) };
  const { decisions, workspaceOf, probe } = classify(loaded, saved, flags);

  const model = buildReviewModel(
    decisions, loaded, workspaceOf, scanEntities(corpus, env, loaded, saltDir, probe),
    nowStamp(), readSessionDrops(reviewPath, lenient).drops,
  );
  const written = writeReview(model, reviewPath);

  // The decision list itself, for a caller that is not going to parse
  // review.md. review.md stays the human surface and the durable record; this
  // is the same rows, already frozen in the model, in a shape an agent can
  // read without a parser. Ignored entirely in the human path.
  if (flags.json) {
    report.machineAdd({
      workspaces: model.workspaces.map((w) => ({
        name: w.name, tier: w.tier, sessions: w.sessionCount, cwd: w.cwd ?? null, note: w.note ?? null,
      })),
      sessions: model.sessions.map((x) => ({
        id: x.id, decision: x.decision, workspace: x.workspace, date: x.date,
      })),
    });
  }

  report.renderScan({
    fileCount: corpus.files.length,
    bytes: corpus.bytes,
    dateRange: corpusDateRange(corpus.files),
    workspaceCount: decisions.length,
    emptyDirs: corpus.workspaceDirs.filter((d) => d.sessionCount === 0).length,
    tiers: summarizeTiers(decisions),
    reviewPath: written.path,
    unreadable: loaded.badLines,
  });
  for (const w of [...reviewProblems, ...loaded.warnings]) report.renderWarning(w);
  return 0;
}

// ----------------------------------------------------------------- review

export async function runReview(flags, env) {
  const outDir = path.resolve(flags.out ?? process.cwd());
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  // Before anything proposes a tier: matchDenyToken consults these, and a
  // token loaded after classify would silently propose the wrong tier for
  // the very directory it exists to protect.
  setUserDeny(loadUserDeny(saltDir));
  const corpus = resolveCorpus(env, flags.root);
  const loaded = surveyCorpus(corpus, flags);
  const reviewPath = path.join(outDir, REVIEW_FILENAME);
  const problems = [];
  const lenient = { onProblem: (why) => problems.push(why) };
  const remembered = loadSavedDecisions(saltDir);
  const saved = { byKey: remembered.workspaces, byName: readReview(reviewPath, lenient) };
  const { decisions, workspaceOf, probe } = classify(loaded, saved, flags);
  const model = buildReviewModel(
    decisions, loaded, workspaceOf, scanEntities(corpus, env, loaded, saltDir, probe),
    nowStamp(), readSessionDrops(reviewPath, lenient).drops,
  );
  for (const w of problems) report.renderWarning(w);

  if (flags.html) {
    const target = path.join(outDir, 'review.html');
    // Every other report writer names the file and the fix; this one used to
    // hand a permissions problem to the generic wrapper, which told the user
    // their own directory was "a bug in deident" and sent them to file an issue.
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderReviewHtml(model), 'utf8');
    } catch (err) {
      throw new RefusalError(`could not write ${target}`, {
        why: [`${err.code}: ${err.message}`, 'Nothing was written.'],
        remedies: [{ label: 'Choose a writable directory', command: 'deident review --html --out <path>' }],
      });
    }
    report.renderNote(`wrote ${target}. Open it in your browser. No server was started.`);
    return 0;
  }
  // cli-ux §5 specifies both queries and they are part of the slice-1 contract,
  // but neither is implemented. They used to print a note and exit 0, pointing
  // at `export --preview`, which does not answer either question — so a scripted
  // check of "can I drill into PERSON_11" passed while nothing happened. A flag
  // that exits 0 without doing its job is the shape of failure BRIEF §2 is
  // about, and refusing is strictly more honest than accepting.
  for (const [flag, value] of [['--entity', flags.entity], ['--session', flags.session]]) {
    if (value === null) continue;
    throw new UsageError(`${flag} is specified in docs/cli-ux.md §5 but is not implemented in slice 1`, {
      why: [`No occurrence index is built yet, so ${flag} cannot be answered.`],
    });
  }

  report.renderTranscript(
    model.workspaces.map(
      (w) => `  ${w.tier.padEnd(12)} ${w.name.padEnd(26)} ${w.sessionCount} sessions   ${w.cwd ?? ''}`.trimEnd(),
    ),
  );
  return 0;
}

// ----------------------------------------------------------------- export

export async function runExport(flags, env) {
  const outDir = path.resolve(flags.out ?? process.cwd());
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  // Before anything proposes a tier: matchDenyToken consults these, and a
  // token loaded after classify would silently propose the wrong tier for
  // the very directory it exists to protect.
  setUserDeny(loadUserDeny(saltDir));

  //  1  resolve the corpus
  const corpus = resolveCorpus(env, flags.root);

  //  2  read every file, checking I1 on untouched input
  //     3 rides along with 2, because it is the only step that reads raw line
  //     text and accumulating the corpus's raw lines to run it separately is
  //     what put the process over the V8 heap limit.
  const loaded = surveyCorpus(corpus, flags, flags.namespace, 'export');
  if (loaded.roundTripFailures.length > 0) throw roundTripRefusal(loaded.roundTripFailures);

  //  3  namespace collision. Deferred to step 7a, once retention has decided
  //      which files are actually in the archive: a hit in a session nobody is
  //      exporting cannot make anything ambiguous, and refusing on it is how
  //      every export burned a fresh namespace. Still before any pseudonym is
  //      minted (PLAN §2), which is what the ordering rule actually requires.
  const namespaceHits = loaded.namespaceHits;

  //  5  workspace tiers (4 ran inside surveyCorpus, per file)
  const reviewPath = path.join(outDir, REVIEW_FILENAME);
  const remembered = loadSavedDecisions(saltDir);
  const reviewTiers = readReview(reviewPath);
  // cli-ux §11 and privacy-tiers §3: "tier decisions live in
  // ~/.deident-private/workspaces.json and are reused". An export that can
  // find neither the review file nor a remembered decision has nothing to
  // reuse, and falling through to the proposal is how nine remote-bearing
  // workspaces got exported on a bare `deident export` — including one the
  // person had set to `exclude` in a review.md this run never looked at,
  // because --out defaults to the current directory.
  if (Object.keys(reviewTiers).length === 0 && Object.keys(remembered.workspaces).length === 0) {
    throw new RefusalError(`no tier decisions: ${reviewPath} does not exist and none are remembered`, {
      why: [
        'deident will not apply its own proposal as if you had agreed to it.',
        'Per-directory opt-in means the opt-in has to have happened somewhere.',
      ],
      remedies: [
        { label: 'Decide first', command: `deident scan --out ${outDir}   # then edit ${REVIEW_FILENAME}` },
        { label: 'Or point at the review you edited', command: 'deident export --out <the directory scan wrote to>' },
      ],
    });
  }
  const saved = { byKey: remembered.workspaces, byName: reviewTiers };
  const { decisions, workspaceOf, probe } = classify(loaded, saved, flags);
  for (const orphan of orphanedDecisions(remembered.workspaces, decisions)) {
    report.renderWarning(
      `a remembered tier for "${orphan}" matches no workspace in this run and was not applied`,
    );
  }
  // Remembered HERE, not after the zip is written.
  //
  // A decision typed into review.md used to be persisted only by a run that
  // also produced a successful export, so the sequence "set a tier, watch the
  // export refuse for an unrelated reason, run it again elsewhere" lost the
  // tier. workspaces.json is memory, not output: cli-ux §10's "no output file
  // behind" is about the zip, and forgetting what the person told you is the
  // failure that ends with an excluded workspace shipping.
  const reviewSessions = readSessionDrops(reviewPath);
  const sessionDrops = new Set([...remembered.sessionDrops, ...reviewSessions.drops]);
  // A review file that lists sessions is a decision about THOSE sessions. Any
  // session written since it was generated appears in no row, and treating an
  // absent row as consent is how a corpus grows past its own review.
  const decidedSessions = reviewSessions.known;
  rememberDecisions(saltDir, decisions, sessionDrops);

  if (!flags.skipUnclassified) {
    const refusal = unclassifiedRefusal(decisions);
    if (refusal !== null) throw refusal;
  }
  const exportable = exportableTiers(decisions);
  if (exportable.size === 0) {
    throw new RefusalError('no workspace is set to an exportable tier', {
      why: [
        'Every workspace is excluded, count-only or unclassified, so the export',
        'would contain nothing. Opt in explicitly; deident never opts you in.',
      ],
      remedies: [{ label: 'Set tiers', command: `deident scan   # then edit ${REVIEW_FILENAME}` }],
    });
  }

  //  6 + 7  per-line cwd gate, then retention
  const salt = loadOrCreateSalt(saltDir);
  const rewriteUuid = makeUuidRewriter(salt);
  report.renderPhase('Applying the tiers and retention rules');
  const retained = retainCorpus(
    loaded,
    workspaceOf,
    exportable,
    cwdTierIndex(decisions),
    rewriteUuid,
    flags,
    sessionDrops,
    decidedSessions,
    allowedDenyTokens(decisions, flags.includeDenied),
  );

  //  7a  namespace collision, scoped to the files that are leaving.
  //
  //      The tool writes its own namespace into the terminal, the terminal into
  //      the session log, and the session log into the next run's corpus, so a
  //      whole-corpus check makes the tool poison itself: eight exports on this
  //      machine needed eight namespaces. A token in a session that is not in
  //      the archive cannot be confused with a minted one, because it is not
  //      there.
  const retainedFiles = new Set(retained.records.map((r) => r.file.path));
  const scopedHits = namespaceHits.filter((h) => retainedFiles.has(h.file));
  let scopedHitCount = 0;
  for (const [file, count] of loaded.namespaceHitFiles ?? []) {
    if (retainedFiles.has(file)) scopedHitCount += count;
  }
  if (scopedHitCount > 0) throw namespaceRefusal(scopedHits, flags.namespace, scopedHitCount);

  //  8  seed entities from PRE-substitution values (PLAN §2). Run seeding
  //     after substitution and these values are already pseudonyms: seeding
  //     becomes a no-op, the table is empty, and the tool exports the corpus
  //     while reporting a triumphant "known-entity residue: 0".
  //
  //     Seeded from EVERY directory the corpus touched, not only the exported
  //     ones. An excluded workspace's own path is still spelled out inside
  //     retained text: measured on a real export, the parent matched and the
  //     tail did not, so the zip carried `X_WORKSPACE_10601283/private/
  //     derek-evidence` x8, `/private/hsbc-out.json` x9 and
  //     `/private/payroll-ledger` x12 — a recipient learning the private
  //     subtree's structure, the third party it concerns and what each file is
  //     for, from an export whose review said that workspace was excluded.
  //     Seeding the longer path makes longest-match replace the whole thing.
  report.renderPhase('Seeding entities');
  const exportedCwds = [...new Set(retained.cwds)];
  const distinctCwds = [...new Set([...exportedCwds, ...allCorpusCwds(loaded)])];
  const seeded = seedEntities(env, corpus, {
    cwds: distinctCwds,
    // Only directories that are actually exported are probed for a remote:
    // the probe shells out, and an excluded directory's remote is not an
    // entity anybody in the export can see.
    repoDirs: exportedCwds.slice(0, 200),
    // The same memoised probe classify() used, not a second cache of the same
    // question: git costs ~85 ms per spawn and 200 workspaces paid it twice.
    probeRemote: probe,
    texts: collectRetainedStrings(retained.records),
  });

  //  9  pseudonyms
  const tier0 = assignPseudonyms(seeded.entities, salt, flags.namespace);
  const tier0Table = buildTable(tier0.entities, { namespace: flags.namespace });

  // 10  tier-0 substitution -> `cleaned`
  report.renderPhase(`Substituting ${tier0Table.size.toLocaleString('en-US')} tier-0 spellings`);
  const cleaned = substituteAll(retained.records, tier0Table);

  // 11  tier-1 discovery reads the OUTPUT of step 10, never the raw records.
  //
  //     The candidates file holds third-party prose that tier 1 has not seen
  //     yet, and cli-ux §10 promises that any non-zero exit leaves no output
  //     file behind. It used to be written on EVERY export attempt, ahead of
  //     the substitution invariant, the residual scan and the entity list it
  //     is meant to feed — so a run that refused for an unrelated reason left
  //     un-de-identified names on disk. It is written only on the path that
  //     needs it: the refusal that asks the user to produce an entity list.
  const candidatesPath = path.join(outDir, CANDIDATES_FILENAME);
  const tier1 = flags.entities === null ? null : readEntities(flags.entities);
  const semantic = checkSemanticPass(tier1);
  if (!semantic.ok) {
    const candidates = writeCandidates(
      extractProse(cleaned.records),
      candidatesPath,
      // Everything the residual scan runs over the zip runs over this file too.
      // It is the one artifact intended to be read by an LLM, i.e. the one most
      // likely to leave the machine, and its own header states that the
      // username, paths, git identity and remotes have already been replaced.
      { table: tier0Table },
    );
    report.renderCandidates(candidates.path, candidates.chars);
    throw semanticRefusal(candidates.path, semantic.why);
  }

  // 12  tier-1 substitution targets the SAME cleaned object, with a pseudonym
  //     guard so a semantic pass returning "PERSON" cannot destroy tier 0.
  //     The tier-0 tokens are threaded in, so a tier-1 entity that hashes onto
  //     one is walked forward rather than silently sharing it. Proving I9 twice
  //     over two halves proves nothing about the merged table that ships.
  //
  //     Each declared spelling is also carried in its TIER-0-CLEANED form.
  //     Without it, a declared entity whose spelling contains a tier-0
  //     spelling can never match: `Devuser Consulting Ltd` is already
  //     `PERSON_3877290 Consulting Ltd` by the time tier 1 runs, so tier 1
  //     matched nothing and the remainder shipped verbatim with every gate
  //     green. Nothing could catch it either — checkSubstitution only sees
  //     strings that CHANGED, and residualScan cannot find a spelling tier 0
  //     already destroyed. A 20,000-trial two-tier fuzz produced 3,636 of
  //     these and the gates caught none.
  const tier1Entities = tier1.entities.map((e) => withCleanedSpellings(e, tier0Table, flags.namespace));
  const tier1Assigned = assignPseudonyms(tier1Entities, salt, flags.namespace, { taken: tier0.taken });
  const tier1Table = buildTable(tier1Assigned.entities, { forbidInside: pseudonymGuardPattern(flags.namespace) });
  report.renderPhase(`Substituting ${tier1Table.size.toLocaleString('en-US')} tier-1 spellings`);
  const final = substituteAll(cleaned.records, tier1Table);

  //  12a  How many times each spelling WOULD be replaced, over the text each
  //       pass actually sees. Not a gate: measured 2026-08-24, an ordinary noun
  //       at 202 occurrences had to fail and a real identity at 255 had to pass,
  //       so no threshold separates them. The number goes in front of a reader.
  const replacementCounts = Object.freeze([
    ...probeCounts(collectRetainedStrings(retained.records), tier0Table),
    ...probeCounts(collectRetainedStrings(cleaned.records), tier1Table),
  ]);
  report.renderProbe(probeOutliers(replacementCounts));

  // 13  substitution invariant, at string level, before serialization.
  //
  //     Each pass is verified against ITS OWN table. Verifying tier-0's
  //     strings against the merged table reports every tier-1 entity in them
  //     as "missed", because tier 0 was never asked to replace it — and a
  //     check that fails on correct behaviour is worse than no check.
  report.renderPhase('Verifying the substitution invariant');
  const allStrings = [...cleaned.strings, ...final.strings];
  const substitution = mergeCheckResults(
    checkSubstitution(cleaned.strings, tier0Table),
    checkSubstitution(final.strings, tier1Table),
  );

  // 14  serialize
  const mergedTable = buildTable([...tier0.entities, ...tier1Assigned.entities], {
    namespace: flags.namespace,
  });
  const serialized = serializeSessions(final.records, mergedTable, rewriteUuid);

  // 15  residual scan on the serialized bytes
  report.renderPhase('Scanning the serialized output for known-entity residue');
  const residue = checkResidue(serialized.allBytes, mergedTable, rewriteUuid.minted);

  const checks = runAllChecks({
    linesRead: loaded.lineCount,
    roundTripFailures: loaded.roundTripFailures,
    namespaceHits,
    namespaceHitCount: scopedHitCount,
    namespace: flags.namespace,
    substitution,
    residue,
    semantic,
  });

  report.renderChecks(toReportRows(checks));
  for (const w of [...loaded.warnings, ...seeded.warnings]) report.renderWarning(w);

  if (!substitution.ok) throw substitutionRefusal(substitution);
  if (!residue.ok) throw residueRefusal(residue);
  // I6 again, per PLAN §2: a refusal one skipped code path can bypass is not
  // a refusal.
  if (!semantic.ok) throw semanticRefusal(candidatesPath, semantic.why);

  if (retained.records.length === 0) {
    // An empty archive presented as a success is the one outcome a
    // manifest-based trust model must never produce. Reachable whenever the
    // cwd gate happens to drop everything.
    throw new RefusalError('every session was filtered out, so the export would be empty', {
      why: [
        `${retained.stats.droppedByCwd.toLocaleString('en-US')} lines were dropped by the per-line cwd gate and`,
        `${retained.stats.emptiedSessions.toLocaleString('en-US')} sessions retained nothing.`,
        'Writing a zero-entry archive and reporting success would be worse than',
        'refusing, so nothing was written.',
      ],
      remedies: [
        { label: 'Check the tiers', command: `deident scan   # then edit ${REVIEW_FILENAME}` },
        { label: 'Include a denied workspace', command: 'deident export --include-denied <name>' },
      ],
    });
  }

  // 16  manifest. Occurrence counts come first, because the manifest reports
  //     how many secrets and phone numbers were replaced and those are counted
  //     per entity, not per record.
  const entities = withOccurrences([...tier0.entities, ...tier1Assigned.entities], allStrings);
  // A declared entity that matched NOTHING is the loudest thing this run can
  // say. It means either the semantic pass named something that is not in the
  // corpus, or tier 0 had already destroyed the spelling — and the second is
  // how a declared org shipped its remainder while `--preview` alone would
  // have shown the row reading `1 spelling, 0 occurrences`. Plain `export`
  // printed nothing at all.
  const unmatched = entities.filter(
    (e) => e.tier === 1 && !e.rejected && e.spellings.length > 0 && (e.occurrences ?? 0) === 0,
  );
  if (unmatched.length > 0) {
    report.renderUnmatched(unmatched.map((e) => ({ id: e.id, kind: e.kind, canonical: e.canonical })));
  }
  const manifest = buildManifest(retained, decisions, serialized, residue, entities, spanCaveats(allStrings));
  report.renderManifest(manifest);

  // 17  the only step that writes an output artifact
  if (flags.preview) {
    const written = writePreview(
      {
        generated: nowStamp(),
        strings: allStrings,
        // The merged table, so a tier-0 excerpt cannot show a tier-1 entity.
        table: mergedTable,
        entities,
        manifest,
        checks: toReportRows(checks),
      },
      path.join(outDir, `deident-preview-${today()}.diff`),
    );
    report.renderWrote(written.path, written.bytes, path.join(saltDir, 'salt'));
    return 0;
  }

  const zipPath = path.join(outDir, `deident-export-${today()}.zip`);
  const mapPath = path.join(outDir, EXPORT_MAP_FILENAME);
  try {
    const written = writeZip(serialized.entries, zipPath);

    // The last gate, and the only one whose subject is the file a recipient
    // opens. Every other check runs over `serialized.allBytes`, a string
    // assembled BESIDE the entries, so the deflate path, the entry naming, the
    // central directory and the rename from .part were outside all of them.
    //
    // journey-and-pitfalls 2.1 states this as a build instruction rather than
    // an aspiration, because on the delivery run a reviewer was handed
    // something that was not what shipped three separate times, and each time
    // the gap was where the leak lived. The entry NAMES are scanned too: F38
    // exists because a uuid rode out inside one.
    const shipped = readZipFile(zipPath);
    const onDisk = checkResidue(
      shipped.map((e) => `${e.name}\n${e.data}`).join('\n'),
      mergedTable,
      rewriteUuid.minted,
    );
    report.renderOnDiskResidue(shipped.length, onDisk);
    if (!onDisk.ok) throw residueRefusal(onDisk);
    // privacy-tiers 4 level 3 needs attribution: "this entry is that session".
    // Without it the last look cannot act, because every id in the archive has
    // already been rewritten and nothing on this machine says which is which.
    // Local only, never an archive entry, and it maps ids to ids rather than
    // pseudonyms to real names, so it is not a re-identification key for the
    // data that left.
    writeExportMap(serialized.entries, mapPath);
    report.renderWrote(written.path, written.bytes, path.join(saltDir, 'salt'));
  } catch (err) {
    // Both artifacts, not just the zip. The map was written INSIDE this try
    // and after writeZip, so a throw between them removed the zip and left a
    // map pointing at a file that no longer exists (cli-ux §10).
    safeUnlink(zipPath);
    safeUnlink(mapPath);
    throw err;
  }
  return 0;
}

/**
 * Persist the tier decisions, after the artifact is safely on disk.
 *
 * This was the only writer with no try/catch, and it ran AFTER writeZip and
 * after the success line: an unwritable salt directory produced
 * `-> deident-export-2026-08-22.zip  515 B` immediately followed by
 * `internal error ... Nothing was written.` and exit 1, with the finished zip
 * still sitting in the output directory. cli-ux §10 says a non-zero exit leaves
 * no output behind; here a non-zero exit left the export AND told the user the
 * opposite. A lost tier memo costs one re-edit of review.md, so it is a
 * warning, not a failure.
 */
export const EXPORT_MAP_FILENAME = 'export-map.txt';

/** Local `<session id>  <archive entry>` lines, one per exported session. */
function writeExportMap(entries, outPath) {
  const body = entries.map((e) => `${e.source ?? '?'}  ${e.name}`).join('\n');
  try {
    fs.writeFileSync(outPath, `${body}\n`, 'utf8');
  } catch (err) {
    // The zip is already on disk and valid; losing the map costs a re-run.
    report.renderWarning(`could not write ${outPath} (${err.code ?? 'error'}: ${err.message})`);
  }
}

function rememberDecisions(saltDir, decisions, sessionDrops) {
  try {
    saveDecisions(saltDir, decisions, sessionDrops);
  } catch (err) {
    report.renderWarning(
      `could not remember your tier decisions (${err.code ?? 'error'}: ${err.message}). ` +
        'The export is written and valid; you will be asked to set tiers again next time',
    );
  }
}

// ------------------------------------------------------------------ steps

/**
 * Steps 2, 3 and 4, one file at a time.
 *
 * The parsed records of a file are NOT kept. Measured on Ray's 833 MB corpus
 * (2026-08-22): holding the raw text, the parsed value and a second array of
 * raw lines for the whole corpus needed between 2.5 and 3.0 GB of old space and
 * aborted the process with a V8 heap-limit FATAL ERROR — which no try/catch can
 * catch, so the user got no refusal and no explanation at all. Each file is
 * read, reduced to what later steps actually need (its per-line cwd values and
 * a few counters), and released. `retainCorpus` re-reads the files it needs.
 * Two reads of a file are cheap; the whole corpus resident at once is not.
 */
const PROGRESS_EVERY = 25;

function surveyCorpus(corpus, flags, namespace = null, phase = null) {
  const sessions = [];
  const roundTripFailures = [];
  const warnings = [];
  const namespaceHits = [];
  let namespaceHitCount = 0;
  const namespaceHitFiles = new Map();
  let badLines = 0;
  let lineCount = 0;

  // I3 reads RAW serialized lines, so it uses the no-lookbehind pattern plus
  // engine.mjs's escape-tail rule. With the lookbehind, the `n` of a
  // backslash-n
  // escape counted as a word character and hid every token at the start of a
  // line inside multi-line prose — the exact shape cli-ux §3's own sample row
  // arrives in — while the check printed "no pre-existing PERSON_n tokens ok"
  // and deident minted the same token for something else in the same archive.
  const pattern = pseudonymScanPattern(namespace);

  if (phase !== null) report.renderPhase(`Reading ${corpus.files.length.toLocaleString('en-US')} session files`);
  let seen = 0;
  for (const file of corpus.files) {
    seen += 1;
    if (phase !== null && seen % PROGRESS_EVERY === 0) report.renderProgress(seen, corpus.files.length, 'files read');
    const session = readSession(file.path, {
      skipUnreadable: flags.skipUnreadable,
      keepRaw: false,
      // Step 3 reads raw line text, and it is the only step that does. Doing it
      // here means the raw lines never have to be accumulated.
      inspect: (line, lineNo) => {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(line)) !== null) {
          // The left boundary, asked of the one implementation that knows a
          // backslash-n is an escape and not a letter.
          if (leftIsWordChar(line, m.index)) continue;
          namespaceHitCount += 1;
          namespaceHitFiles.set(file.path, (namespaceHitFiles.get(file.path) ?? 0) + 1);
          if (namespaceHits.length < EXAMPLES_PER_REPORT) {
            namespaceHits.push(Object.freeze({ file: file.path, line: lineNo, token: m[0] }));
          }
          return;
        }
      },
    });
    const cwds = resolveLineCwd(session.records);
    lineCount += session.records.length;
    badLines += session.badLines.length;
    // A loop, not `push(...arr)`. Spreading passes one argument per element,
    // so a file with ~125,000 failing lines throws RangeError before any check
    // can report it — and it throws inside `scan`, the command cli-ux §1 sells
    // as the one that writes nothing dangerous.
    for (const f of session.roundTripFailures) roundTripFailures.push(f);
    if (session.badLines.length > 0) {
      warnings.push(`${file.path}: ${session.badLines.length} unreadable line(s) skipped`);
    }
    sessions.push(Object.freeze({ file, cwds }));
  }

  return Object.freeze({
    sessions: Object.freeze(sessions),
    roundTripFailures: Object.freeze(roundTripFailures),
    warnings: Object.freeze(warnings),
    namespaceHits: Object.freeze(namespaceHits),
    namespaceHitCount,
    namespaceHitFiles: Object.freeze(namespaceHitFiles),
    badLines,
    lineCount,
  });
}

/** Steps 6 and 7, re-reading one file at a time (see surveyCorpus). */
function retainCorpus(
  loaded,
  workspaceOf,
  exportable,
  cwdTiers,
  rewriteUuid,
  flags,
  sessionDrops = new Set(),
  decidedSessions = new Set(),
  deniedTokensAllowed = new Set(),
) {
  const out = [];
  const cwds = [];
  const stats = {
    kept: 0,
    dropped: 0,
    droppedByCwd: 0,
    droppedBySession: 0,
    droppedUndecided: 0,
    injectedBytesDropped: 0,
    deniedBlocks: 0,
    deniedBytes: 0,
    deniedPaths: 0,
    userMessages: 0,
    assistantMessages: 0,
    images: 0,
    documents: 0,
    codeLinesCounted: 0,
    codeParamsDropped: 0,
    toolResultBytesOmitted: 0,
    dedupedPrompts: 0,
    sessions: 0,
    emptiedSessions: 0,
    droppedCwdless: 0,
    droppedCwdlessByType: new Map(),
    unreadableRecords: 0,
    unknownTypes: new Map(),
    workspaces: new Set(),
  };
  // `--include-denied` takes a workspace NAME; the per-line gate matches a deny
  // TOKEN. The two were never connected, so a user who typed the documented
  // confirmation got the workspace promoted and then every one of its lines
  // dropped by the token check — a green success report over a 22-byte zip.
  // The tokens allowed here are exactly those of the workspaces the user named.
  const allowDenyTokenFor = deniedTokensAllowed;

  let seen = 0;
  for (const { file, cwds: lineCwds } of loaded.sessions) {
    seen += 1;
    if (seen % PROGRESS_EVERY === 0) report.renderProgress(seen, loaded.sessions.length, 'sessions processed');
    const workspace = workspaceOf.get(file.path);
    if (workspace === undefined || !exportable.has(workspace.key)) continue;
    // privacy-tiers §4 level 3. Checked before the file is re-read, because a
    // session held back by hand should cost nothing to hold back.
    const sid = sessionIdOf(file.path);
    // Fail closed on a session the review never saw. Only when the review
    // actually listed sessions: an empty set means the file had no opinion,
    // not that every session is unknown.
    if (decidedSessions.size > 0 && !decidedSessions.has(sid)) {
      stats.droppedUndecided += 1;
      continue;
    }
    if (sessionDrops.has(sid)) {
      stats.droppedBySession += 1;
      continue;
    }
    // Re-read rather than hold: the survey pass released this file's records
    // precisely so the whole corpus is never resident at once.
    const session = readSession(file.path, { skipUnreadable: flags.skipUnreadable, keepRaw: false });
    const ctx = newRetentionContext(rewriteUuid);
    const records = [];

    // Did this session ever work inside a directory that is not exported?
    //
    // BRIEF §4.11 and PLAN §4.2 say a deny-listed directory is `exclude` and
    // its material never leaves. It did. A `last-prompt` (and a
    // `queue-operation`, same shape) carries no `cwd` of its own, so cwdtrack
    // gives it the cwd in force when it was written — which, for a record that
    // REPLAYS earlier user text, is the cwd of a later moment, not of the turn
    // it replays. Measured on a real export: prose authored only at
    // `...\ops-handover\private\derek-evidence` was replayed by three
    // later last-prompt records sitting at `...\ops-handover`, passed the
    // gate, and shipped. Eight distinct fragments that appear ONLY on
    // deny-listed lines in the whole corpus reached the zip that way, including
    // wage prose and bank statement text.
    //
    // A cwd-less record cannot be attributed to a turn, so in a session that
    // ever touched an excluded directory it is dropped rather than guessed at.
    // §C3 kept these types precisely because they carry user text found nowhere
    // else, which is exactly what makes mis-attributing them expensive.
    const touchedExcluded = lineCwds.some(
      (cwd) => !allowLine(cwd, { cwdTiers, allowDenyTokenFor }).allow,
    );

    // ...but only the ones that actually replay it.
    //
    // Dropping EVERY cwd-less keep-record destroyed two whole record classes.
    // Measured over the 39 sessions a default-shaped run exports: 2,162
    // last-prompt and 613 queue-operation records dropped, 0 kept, and 872 of
    // those texts (135,668 characters) appear nowhere else in their own
    // session. Under the most permissive policy the tool supports it still
    // cost 1,006 and 227. PLAN C2/C3 measure these at 70.3% and 32.2% unique
    // and the Framing axis is scored from exactly this text, so a class
    // reduced to zero is not a conservative choice, it is a silent one — the
    // manifest said only "3,784 records dropped" and "5,821 user messages",
    // which reads as though the user prose is intact.
    //
    // `mode` was worse: 6,976 of them in the corpus, 0 carrying a cwd, so
    // every one went — and docs/privacy-tiers.md defines the count-only tier
    // as "session count, work mode and outcome only", which the export
    // manifest prints verbatim while shipping no work mode at all.
    //
    // The real hazard is narrower than the rule: a record that REPLAYS text
    // typed inside an excluded directory. That is testable rather than
    // guessable, so it is tested. Everything else is kept.
    const excludedTexts = touchedExcluded ? new Set() : null;
    if (excludedTexts !== null) {
      const strings = [];
      for (let i = 0; i < session.records.length; i += 1) {
        if (allowLine(lineCwds[i], { cwdTiers, allowDenyTokenFor }).allow) continue;
        collectStrings(session.records[i].value, strings);
      }
      for (const text of strings) {
        if (text.length >= MIN_REPLAY_MATCH_CHARS) {
          excludedTexts.add(text);
          excludedTexts.add(text.trim());
        }
      }
    }

    for (let i = 0; i < session.records.length; i += 1) {
      const verdict = allowLine(lineCwds[i], { cwdTiers, allowDenyTokenFor });
      if (!verdict.allow) {
        stats.droppedByCwd += 1;
        continue;
      }
      const at = { file: file.path, line: session.records[i].index };
      // Applied only to types retention would otherwise KEEP. Every other
      // cwd-less type (permission-mode, bridge-session, ai-title,
      // file-history-*) is dropped by the retention table anyway, and counting
      // those here reported 9,086 "dropped records" on the real corpus where
      // the real cost was a fraction of that — a number that overstates its own
      // damage is as untrustworthy as one that hides it.
      const type = session.records[i].value?.type;
      if (
        touchedExcluded &&
        RETENTION_TABLE.topLevel[type] === 'keep' &&
        cwdChangeFrom(session.records[i].value) === null &&
        replaysExcluded(session.records[i].value, excludedTexts)
      ) {
        stats.droppedCwdless += 1;
        stats.droppedCwdlessByType.set(type, (stats.droppedCwdlessByType.get(type) ?? 0) + 1);
        continue;
      }
      let result;
      try {
        result = retainRecord(session.records[i].value, ctx, at);
      } catch (err) {
        // Every walker here is recursive. Pathological nesting is a property of
        // the input, so it is a read error naming the line (exit 3), never
        // "a bug in deident" (exit 1).
        if (err instanceof RangeError) {
          if (!flags.skipUnreadable) throw nestingError(at.file, at.line, err);
          stats.unreadableRecords += 1;
          continue;
        }
        if (flags.skipUnknownTypes && err instanceof RefusalError && err.detail && err.detail.unknown) {
          const key = err.detail.unknown;
          stats.unknownTypes.set(key, (stats.unknownTypes.get(key) ?? 0) + 1);
          continue;
        }
        throw err;
      }
      if (result.keep) {
        try {
          records.push(rewriteUuidsInRecord(result.record, ctx.rewriteUuid));
        } catch (err) {
          if (err instanceof RangeError && flags.skipUnreadable) {
            stats.unreadableRecords += 1;
            continue;
          }
          if (err instanceof RangeError) throw nestingError(at.file, at.line, err);
          throw err;
        }
        if (lineCwds[i]) cwds.push(lineCwds[i]);
      }
    }

    for (const [k, v] of Object.entries(ctx.stats)) {
      if (typeof v === 'number' && k in stats) stats[k] += v;
    }
    if (records.length > 0) {
      stats.sessions += 1;
      stats.workspaces.add(workspace.key);
      out.push(Object.freeze({ file, workspace, records: Object.freeze(records) }));
    } else {
      // A session that retained nothing used to be skipped without incrementing
      // any counter, so the shipped session count disagreed with the count the
      // uploader approved in review.md and nothing said why. Session count is
      // load-bearing downstream: privacy-tiers §2 shrinks domain confidence
      // toward PRIOR_WEIGHT = 6 and gives no level at all under 8 sessions, so
      // a vanished session moves a denominator that decides whether a person is
      // scored.
      stats.emptiedSessions += 1;
    }
  }

  return Object.freeze({
    records: Object.freeze(out),
    cwds: Object.freeze(cwds),
    stats,
  });
}

/**
 * A tier-1 entity plus the form its spellings take AFTER tier-0 substitution.
 *
 * Tier 1 runs over cleaned text, so a spelling that contains a tier-0 spelling
 * is not present any more and can never match. The cleaned form is: the engine
 * allows a match that strictly contains a pseudonym, so the whole span goes
 * and reversal still restores exactly what was there.
 */
function withCleanedSpellings(entity, tier0Table, namespace = null) {
  if (entity.rejected || entity.spellings.length === 0) return entity;
  const forms = new Set(entity.spellings);
  for (const spelling of entity.spellings) {
    const cleaned = substituteString(spelling, tier0Table).out;
    if (cleaned === spelling || cleaned.length === 0) continue;
    // The cleaned form has to carry text of its own.
    //
    // A declared entity that tier 0 already replaces IN FULL cleans down to a
    // bare pseudonym, and seeding that as a spelling is a disaster in two
    // directions: the substituter correctly refuses to replace a token with
    // another token (an exact overlap is not a containment), and the residual
    // scan then finds the "spelling" in every occurrence of the token and
    // fails the export. Measured on the real corpus: 2,056 reported
    // occurrences, none of them a leak.
    const stripped = cleaned.replace(pseudonymGuardPattern(namespace), '').trim();
    if (stripped.length >= 2) forms.add(cleaned);
  }
  if (forms.size === entity.spellings.length) return entity;
  return Object.freeze({
    ...entity,
    spellings: Object.freeze([...forms].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))),
  });
}

/**
 * Does this cwd-less record carry text that was authored inside an excluded
 * directory?
 *
 * The measured hazard: prose authored only inside a `private` subdirectory
 * was replayed by three later last-prompt records sitting one level up, at
 * the ordinary workspace directory. They passed the gate and shipped.
 * A record that replays
 * text has that text in it, so the test is an exact match against the strings
 * on the excluded lines — no attribution guess required.
 */
function replaysExcluded(record, excludedTexts) {
  if (excludedTexts === null || excludedTexts.size === 0) return false;
  const strings = collectStrings(record, []);
  for (const text of strings) {
    if (text.length < MIN_REPLAY_MATCH_CHARS) continue;
    if (excludedTexts.has(text) || excludedTexts.has(text.trim())) return true;
  }
  return false;
}

/**
 * The deny tokens the user has explicitly overridden, for the per-line gate.
 *
 * `--include-denied` names a workspace; `allowLine` matches a token. Only the
 * tokens of workspaces the user named AND that ended up on an exportable tier
 * are allowed, so typing the confirmation for one workspace does not quietly
 * open every `\private` directory on the machine — a line elsewhere still
 * resolves to its own workspace and that workspace's tier still decides.
 */
function allowedDenyTokens(decisions, includeDenied) {
  const named = new Set(includeDenied ?? []);
  const tokens = new Set();
  for (const d of decisions) {
    if (d.denyToken === null || !named.has(d.name)) continue;
    if (d.tier === 'redact' || d.tier === 'open') tokens.add(d.denyToken);
  }
  return tokens;
}

/** Every distinct effective cwd in the corpus, exported or not. */
function allCorpusCwds(loaded) {
  const out = new Set();
  for (const session of loaded.sessions) {
    for (const cwd of session.cwds) {
      if (typeof cwd === 'string' && cwd.length > 0) out.add(cwd);
    }
  }
  return out;
}

/** Every string in the retained (pre-substitution) records, for the email sweep. */
function collectRetainedStrings(sessions) {
  const out = [];
  for (const s of sessions) {
    for (const rec of s.records) collectStrings(rec, out);
  }
  return out;
}

/** Steps 10 and 12. */
function substituteAll(sessions, table) {
  const out = [];
  const strings = [];
  for (const s of sessions) {
    const records = [];
    for (const rec of s.records) {
      const r = substituteRecord(rec, table);
      records.push(r.record);
      // See surveyCorpus: one record can hold ~125,000 changed strings.
      for (const changed of r.strings) strings.push(changed);
    }
    out.push(Object.freeze({ file: s.file, workspace: s.workspace, records: Object.freeze(records) }));
  }
  return Object.freeze({ records: Object.freeze(out), strings: Object.freeze(strings) });
}

/**
 * Step 11's input: prose only. BRIEF §4.10 measured `text` at 2.30% of bytes,
 * and feeding a semantic pass the other 97.7% is how it starts inventing
 * entities.
 */
function extractProse(sessions) {
  const chunks = [];
  for (const s of sessions) {
    for (const rec of s.records) {
      if (rec.type === 'last-prompt' || rec.type === 'queue-operation') {
        if (typeof rec.text === 'string') chunks.push(rec.text);
        continue;
      }
      if (rec.type === 'attachment') {
        for (const v of Object.values(rec.attachment ?? {})) if (typeof v === 'string') chunks.push(v);
        continue;
      }
      for (const block of rec.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
        else if (block?.type === 'thinking' && typeof block.thinking === 'string') chunks.push(block.thinking);
      }
    }
  }
  return chunks;
}

/**
 * Step 14.
 *
 * Entry NAMES are de-identified too, and are included in the bytes the
 * residual scan sees. The raw name would be
 * `sessions/C--Users-devuser/006033ea-...jsonl`: the slug carries the username
 * and the filename is the real session uuid. Neither is inside any JSON body,
 * so a scan over record bytes alone would report `known-entity residue: 0`
 * over a zip whose directory listing names the user — the §F1 failure, one
 * level up from the text.
 */
export function serializeSessions(sessions, table, rewriteUuid) {
  const entries = [];
  const parts = [];
  for (const s of sessions) {
    const body = `${s.records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    // The slug is substituted for entities AND swept for uuids, in that order.
    // Measured on the real corpus (2026-08-22): a workspace launched from a
    // scratchpad path carries a session uuid inside its own directory slug
    // (`...-claude-C--Users-devuser-6b85b649-...-scratchpad-resumetest`). No
    // entity matches it, so it reached the zip's directory listing verbatim
    // and I5 correctly reported three unknown uuids. Same reuse as the record
    // walker, so a slug and a record body cannot disagree.
    //
    // The entry directory is derived from the workspace's own CWD, not from its
    // short label. `s.workspace.name` is the last path segment, and the entity
    // table only carries full cwd spellings, so the bare basename never matched
    // anything: the archive contained `./sessions/catalyte/...jsonl` while every
    // record body inside it read `"cwd":"WORKSPACE_3736654"`. That is the real
    // directory name in plaintext AND a free WORKSPACE_n -> real-name mapping
    // handed to the recipient, and a scan over record bodies reported
    // `known-entity residue: 0` over it. There is no §F7 trade-off here: the
    // entry name is generated by deident, so it can always be a token.
    const dir = rewriteUuidsInRecord(
      substituteString(s.workspace.cwd ?? s.workspace.name, table).out,
      rewriteUuid,
    );
    const id = rewriteUuid(s.file.sessionId) ?? s.file.sessionId;
    const name = `sessions/${sanitizeEntryName(entryDir(dir, s.workspace.key))}/${sanitizeEntryName(id)}.jsonl`;
    entries.push({ name, data: body, source: s.file.sessionId });
    parts.push(body, name, '\n');
  }
  return Object.freeze({ entries, allBytes: parts.join('') });
}

/**
 * A directory name for the archive, or an opaque one when substitution left a
 * path behind.
 *
 * A leftover separator or drive letter means the workspace's cwd was not fully
 * replaced, and shipping half a path as a folder name is the same disclosure in
 * a quieter form. The fallback is derived from the workspace key so it is
 * stable across runs (I10) and identical for every session of one workspace.
 */
function entryDir(dir, key) {
  if (typeof dir !== 'string' || dir === '') return 'workspace';
  if (!/[\\/:]/.test(dir)) return dir;
  return `workspace-${createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 8)}`;
}

/** Keep entry names portable across Windows, macOS and Linux extractors. */
function sanitizeEntryName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'unnamed';
}

/** Step 16. */
function buildManifest(retained, decisions, serialized, residue, entities, caveats = { absorbed: 0, cjk: 0 }) {
  const s = retained.stats;
  const num = (v) => v.toLocaleString('en-US');
  const occurrencesOf = (kind) =>
    entities.filter((e) => e.kind === kind).reduce((a, e) => a + (e.occurrences ?? 0), 0);
  const distinctOf = (kind) => entities.filter((e) => e.kind === kind && (e.occurrences ?? 0) > 0).length;
  return Object.freeze({
    sessions: s.sessions,
    workspaces: s.workspaces.size,
    userMessages: s.userMessages,
    zeros: Object.freeze([
      { label: 'lines of code', suppressed: `${num(s.codeLinesCounted)} counted, none included` },
      { label: 'images', suppressed: `${num(s.images)} replaced with placeholders` },
      { label: 'code parameters', suppressed: `${num(s.codeParamsDropped)} replaced with counts` },
      { label: 'held back by hand', suppressed: `${num(s.droppedBySession ?? 0)} sessions dropped in review.md` },
      { label: 'never reviewed', suppressed: `${num(s.droppedUndecided ?? 0)} sessions written since the last scan` },
      { label: 'denied file content', suppressed: `${num(s.deniedBlocks ?? 0)} blocks, ${num(s.deniedBytes ?? 0)} bytes withheld` },
      { label: 'denied paths', suppressed: `${num(s.deniedPaths ?? 0)} path references removed from prose` },
      { label: 'harness injections', suppressed: `${num(s.injectedBytesDropped ?? 0)} bytes of injected context stripped` },
      { label: 'documents', suppressed: `${num(s.documents)} pasted documents replaced` },
      // cli-ux §6 prints this row. It printed nothing at all while a live
      // 93-character token was in the archive.
      { label: 'secrets', suppressed: `${num(occurrencesOf('secret'))} replaced (${num(distinctOf('secret'))} distinct)` },
      { label: 'phone numbers', suppressed: `${num(occurrencesOf('phone'))} replaced (${num(distinctOf('phone'))} distinct)` },
      // cli-ux §6's shape: a zero where a zero is the point, with the
      // suppressed count beside it. Both classes shipped verbatim before they
      // existed — a Taiwan passport number 13 times, 8 people's Slack ids 255
      // times — with nothing in the manifest naming either.
      { label: 'identity numbers', suppressed: `${num(occurrencesOf('idnumber'))} replaced (${num(distinctOf('idnumber'))} distinct)` },
      { label: 'account ids', suppressed: `${num(occurrencesOf('account'))} replaced (${num(distinctOf('account'))} distinct)` },
    ]),
    // Counters, not zeros: a row reading `0 dropped by cwd  3 lines outside an
    // included directory` asserts a number and then contradicts it.
    droppedByCwd: s.droppedByCwd,
    droppedCwdless: s.droppedCwdless ?? 0,
    droppedCwdlessByType: Object.freeze(
      [...(s.droppedCwdlessByType ?? new Map())]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => Object.freeze({ type, count })),
    ),
    emptiedSessions: s.emptiedSessions ?? 0,
    unknownTypes: Object.freeze(
      [...(s.unknownTypes ?? new Map())].map(([type, count]) => Object.freeze({ type, count })),
    ),
    absorbedSpans: caveats.absorbed,
    cjkSpans: caveats.cjk,
    embedded: residue.scan.embedded,
    escapeArtifacts: residue.scan.escapeArtifacts ?? 0,
    // The residue line belongs beside the limits, not only in the checks
    // table: review.html and the preview print the limits block and used to
    // carry no residue figure at all.
    residueLine: residue.detail,
    countOnly: Object.freeze({
      sessions: decisions.filter((d) => d.tier === 'count-only').reduce((a, d) => a + d.sessionCount, 0),
      workspaces: decisions.filter((d) => d.tier === 'count-only').length,
    }),
    bytes: Buffer.byteLength(serialized.allBytes, 'utf8'),
  });
}

// ------------------------------------------------------------------ shared

/**
 * Step 5. Sessions are grouped by the directory they actually worked in, not
 * by the storage slug they were launched from (§4.9, and see grouping.mjs for
 * the measurement), then each group gets a proposed tier from the signals
 * privacy-tiers §3 lists.
 *
 * @returns {{decisions, workspaceOf: Map<string, {key, name}>}} keyed by
 *   session file path, because a session's workspace is now a derived fact and
 *   every later step has to look it up the same way.
 */
function classify(loaded, saved, flags, probe = makeRemoteProbe()) {
  const groups = groupSessions(loaded.sessions);
  const decisions = classifyWorkspaces(groups, saved, {
    includeDenied: flags.includeDenied,
    propose: (g) => proposeTier(g, probe),
  });
  const byKey = new Map(decisions.map((d) => [d.key, d]));
  const workspaceOf = new Map();
  for (const g of groups) {
    const d = byKey.get(g.key);
    for (const p of g.sessionPaths) {
      // `cwd` rides along because the zip's entry directory is derived from it,
      // not from the short label: the label is the last path segment and the
      // entity table only carries full paths, so the label never matched.
      workspaceOf.set(p, Object.freeze({ key: g.key, name: d.name, cwd: g.cwd ?? null }));
    }
  }
  return { decisions, workspaceOf, probe };
}

/**
 * The entity list the review surface shows (cli-ux §3 and §4).
 *
 * Both commands used to pass a literal `[]` here, so `review.md` read
 * `## entities to be replaced  (0)` and `review.html`'s entity table had no
 * rows — on a corpus whose export replaces 146,904 occurrences of 2,778
 * spellings. §F6's rule that low-confidence entities are listed individually
 * cannot be enforced over an empty list, and the person doing the review had
 * nothing to review.
 *
 * Two honest limits, stated in the file rather than papered over:
 *   - the classes swept out of session TEXT (emails, credentials, phone
 *     numbers, platform ids, MCP names) are not listed here. Finding them
 *     needs the retention pass, which is the 24-minute half of `export`, and
 *     cli-ux §1 says scan and review are the cheap commands.
 *   - occurrences are not counted here for the same reason. `export --preview`
 *     counts them.
 */
function scanEntities(corpus, env, loaded, saltDir, probe) {
  const cwds = [...allCorpusCwds(loaded)];
  const seeded = seedEntities(env, corpus, { cwds, repoDirs: cwds.slice(0, 200), probeRemote: probe, texts: [] });
  const salt = readSalt(saltDir);
  // No salt yet means no export has run. scan and review write nothing but
  // review.md (cli-ux §1), so they must not mint one just to print a token.
  const withToken = salt === null
    ? seeded.entities.map((e) => Object.freeze({ ...e, pseudonym: e.rejected ? null : `<${e.id}>` }))
    : assignPseudonyms(seeded.entities, salt, null).entities;
  return Object.freeze(withToken.map((e) => Object.freeze({ ...e, occurrences: null })));
}

/** A session's id is its file's basename: stable, and local to this machine. */
function sessionIdOf(filePath) {
  return path.basename(filePath, '.jsonl');
}

function buildReviewModel(decisions, loaded, workspaceOf, entities, generated, sessionDrops = new Set()) {
  const flagged = [];
  const sessions = [];
  for (const { file, cwds } of loaded.sessions) {
    const token = touchedDenied(cwds);
    if (token !== null) {
      flagged.push({
        date: new Date(file.mtimeMs).toISOString().slice(0, 10),
        workspace: workspaceOf.get(file.path)?.name ?? '<no-cwd>',
        reason: `a directory containing "${token}"`,
      });
    }
    const id = sessionIdOf(file.path);
    sessions.push({
      id,
      date: new Date(file.mtimeMs).toISOString().slice(0, 10),
      workspace: workspaceOf.get(file.path)?.name ?? '<no-cwd>',
      decision: sessionDrops.has(id) ? 'drop' : 'keep',
    });
  }
  sessions.sort((a, b) =>
    a.workspace !== b.workspace ? (a.workspace < b.workspace ? -1 : 1) : a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  return Object.freeze({
    generated,
    workspaces: decisions,
    sessions: Object.freeze(sessions),
    flaggedSessions: Object.freeze(flagged),
    entities: Object.freeze(entities),
  });
}

function mergeCheckResults(a, b) {
  const replacements = a.replacements + b.replacements;
  const failures = [...a.failures, ...b.failures];
  return Object.freeze({
    name: 'substitution invariant',
    ok: a.ok && b.ok,
    detail: `${replacements.toLocaleString('en-US')} replacements, ${failures.length === 0 ? 'all reversible' : `${failures.length} failed`}`,
    failures: Object.freeze(failures),
    replacements,
  });
}

/** Spans that need a caveat in the manifest: see engine.mjs's span fields. */
function spanCaveats(strings) {
  let absorbed = 0;
  let cjk = 0;
  for (const s of strings) {
    for (const span of s.spans) {
      if (span.absorbed) absorbed += 1;
      if (span.cjk) cjk += 1;
    }
  }
  return Object.freeze({ absorbed, cjk });
}

function withOccurrences(entities, strings) {
  const counts = new Map();
  for (const s of strings) {
    for (const span of s.spans) counts.set(span.entityId, (counts.get(span.entityId) ?? 0) + 1);
  }
  return entities.map((e) => Object.freeze({ ...e, occurrences: counts.get(e.id) ?? 0 }));
}

/**
 * §F5: rewrite every uuid deterministically. The graph structure (parentUuid
 * links, tool_use_id pairing) survives, the real identifiers do not, and I5
 * becomes checkable: any UUID in the output that is not in this set is a leak.
 */
function makeUuidRewriter(salt) {
  const cache = new Map();
  // The set of minted uuids lives ON the rewriter, not beside it. Every caller
  // that mints one registers it by construction, so a new call site cannot
  // forget and leave I5 reporting its own output as an unknown uuid — which is
  // exactly what happened when zip entry names started being rewritten.
  const minted = new Set();
  const rewrite = (value) => {
    if (typeof value !== 'string' || value.length === 0) return null;
    const hit = cache.get(value);
    if (hit !== undefined) return hit;
    const h = createHash('sha256').update(JSON.stringify([salt, 'uuid', value]), 'utf8').digest('hex');
    const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    cache.set(value, uuid);
    minted.add(uuid);
    return uuid;
  };
  rewrite.minted = minted;
  return rewrite;
}

function nowStamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
