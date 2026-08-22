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
  defaultSaltDir,
  assignPseudonyms,
  namespaceRefusal,
  pseudonymPattern,
} from './entities/pseudonym.mjs';
import { writeCandidates, readEntities, CANDIDATES_FILENAME } from './entities/tier1.mjs';
import { buildTable, substituteString } from './substitute/engine.mjs';
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
import { writeZip, safeUnlink } from './output/zip.mjs';
import { writePreview } from './output/preview.mjs';
import { EXAMPLES_PER_REPORT } from './retain/constants.mjs';

// ------------------------------------------------------------------- scan

export async function runScan(flags, env) {
  const outDir = path.resolve(flags.out ?? process.cwd());
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  const corpus = resolveCorpus(env, flags.root);

  const loaded = surveyCorpus(corpus, flags);
  const { decisions, workspaceOf } = classify(loaded, loadSavedDecisions(saltDir), flags);

  const reviewPath = path.join(outDir, REVIEW_FILENAME);
  const model = buildReviewModel(decisions, loaded, workspaceOf, [], nowStamp(), readSessionDrops(reviewPath));
  const written = writeReview(model, reviewPath);

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
  for (const w of loaded.warnings) report.renderWarning(w);
  return 0;
}

// ----------------------------------------------------------------- review

export async function runReview(flags, env) {
  const outDir = path.resolve(flags.out ?? process.cwd());
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  const corpus = resolveCorpus(env, flags.root);
  const loaded = surveyCorpus(corpus, flags);
  const saved = { ...loadSavedDecisions(saltDir), ...readReview(path.join(outDir, REVIEW_FILENAME)) };
  const { decisions, workspaceOf } = classify(loaded, saved, flags);
  const model = buildReviewModel(
    decisions, loaded, workspaceOf, [], nowStamp(), readSessionDrops(path.join(outDir, REVIEW_FILENAME)),
  );

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
    report.renderNote(`wrote ${target} — open it in your browser. No server was started.`);
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

  //  1  resolve the corpus
  const corpus = resolveCorpus(env, flags.root);

  //  2  read every file, checking I1 on untouched input
  //     3 rides along with 2, because it is the only step that reads raw line
  //     text and accumulating the corpus's raw lines to run it separately is
  //     what put the process over the V8 heap limit.
  const loaded = surveyCorpus(corpus, flags, flags.namespace);
  if (loaded.roundTripFailures.length > 0) throw roundTripRefusal(loaded.roundTripFailures);

  //  3  namespace collision — BEFORE any pseudonym is minted (PLAN §2)
  const namespaceHits = loaded.namespaceHits;
  if (loaded.namespaceHitCount > 0) throw namespaceRefusal(namespaceHits, flags.namespace, loaded.namespaceHitCount);

  //  5  workspace tiers (4 ran inside surveyCorpus, per file)
  const saved = { ...loadSavedDecisions(saltDir), ...readReview(path.join(outDir, REVIEW_FILENAME)) };
  const { decisions, workspaceOf } = classify(loaded, saved, flags);
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
  const sessionDrops = readSessionDrops(path.join(outDir, REVIEW_FILENAME));
  const retained = retainCorpus(
    loaded,
    workspaceOf,
    exportable,
    cwdTierIndex(decisions),
    rewriteUuid,
    flags,
    sessionDrops,
    allowedDenyTokens(decisions, flags.includeDenied),
  );

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
  const exportedCwds = [...new Set(retained.cwds)];
  const distinctCwds = [...new Set([...exportedCwds, ...allCorpusCwds(loaded)])];
  const seeded = seedEntities(env, corpus, {
    cwds: distinctCwds,
    // Only directories that are actually exported are probed for a remote:
    // the probe shells out, and an excluded directory's remote is not an
    // entity anybody in the export can see.
    repoDirs: exportedCwds.slice(0, 200),
    texts: collectRetainedStrings(retained.records),
  });

  //  9  pseudonyms
  const tier0 = assignPseudonyms(seeded.entities, salt, flags.namespace);
  const tier0Table = buildTable(tier0.entities, { namespace: flags.namespace });

  // 10  tier-0 substitution -> `cleaned`
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
  const tier1Assigned = assignPseudonyms(tier1.entities, salt, flags.namespace, { taken: tier0.taken });
  const tier1Table = buildTable(tier1Assigned.entities, { forbidInside: pseudonymPattern(flags.namespace) });
  const final = substituteAll(cleaned.records, tier1Table);

  // 13  substitution invariant, at string level, before serialization.
  //
  //     Each pass is verified against ITS OWN table. Verifying tier-0's
  //     strings against the merged table reports every tier-1 entity in them
  //     as "missed", because tier 0 was never asked to replace it — and a
  //     check that fails on correct behaviour is worse than no check.
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
  const residue = checkResidue(serialized.allBytes, mergedTable, rewriteUuid.minted);

  const checks = runAllChecks({
    linesRead: loaded.lineCount,
    roundTripFailures: loaded.roundTripFailures,
    namespaceHits,
    namespaceHitCount: loaded.namespaceHitCount,
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
  const manifest = buildManifest(retained, decisions, serialized, residue.scan.embedded, entities);
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
    rememberDecisions(saltDir, decisions);
    return 0;
  }

  const zipPath = path.join(outDir, `deident-export-${today()}.zip`);
  try {
    const written = writeZip(serialized.entries, zipPath);
    // privacy-tiers 4 level 3 needs attribution: "this entry is that session".
    // Without it the last look cannot act, because every id in the archive has
    // already been rewritten and nothing on this machine says which is which.
    // Local only, never an archive entry, and it maps ids to ids rather than
    // pseudonyms to real names, so it is not a re-identification key for the
    // data that left.
    writeExportMap(serialized.entries, path.join(outDir, EXPORT_MAP_FILENAME));
    report.renderWrote(written.path, written.bytes, path.join(saltDir, 'salt'));
  } catch (err) {
    safeUnlink(zipPath);
    throw err;
  }
  rememberDecisions(saltDir, decisions);
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

function rememberDecisions(saltDir, decisions) {
  try {
    saveDecisions(saltDir, decisions);
  } catch (err) {
    report.renderWarning(
      `could not remember your tier decisions (${err.code ?? 'error'}: ${err.message}) — ` +
        'the export is written and valid; you will be asked to set tiers again next time',
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
function surveyCorpus(corpus, flags, namespace = null) {
  const sessions = [];
  const roundTripFailures = [];
  const warnings = [];
  const namespaceHits = [];
  let namespaceHitCount = 0;
  let badLines = 0;
  let lineCount = 0;

  const pattern = pseudonymPattern(namespace);

  for (const file of corpus.files) {
    const session = readSession(file.path, {
      skipUnreadable: flags.skipUnreadable,
      keepRaw: false,
      // Step 3 reads raw line text, and it is the only step that does. Doing it
      // here means the raw lines never have to be accumulated.
      inspect: (line, lineNo) => {
        pattern.lastIndex = 0;
        const m = pattern.exec(line);
        if (m === null) return;
        namespaceHitCount += 1;
        if (namespaceHits.length < EXAMPLES_PER_REPORT) {
          namespaceHits.push(Object.freeze({ file: file.path, line: lineNo, token: m[0] }));
        }
      },
    });
    const cwds = resolveLineCwd(session.records);
    lineCount += session.records.length;
    badLines += session.badLines.length;
    roundTripFailures.push(...session.roundTripFailures);
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
  deniedTokensAllowed = new Set(),
) {
  const out = [];
  const cwds = [];
  const stats = {
    kept: 0,
    dropped: 0,
    droppedByCwd: 0,
    droppedBySession: 0,
    injectedBytesDropped: 0,
    deniedBlocks: 0,
    deniedBytes: 0,
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
    unknownTypes: new Map(),
    workspaces: new Set(),
  };
  // `--include-denied` takes a workspace NAME; the per-line gate matches a deny
  // TOKEN. The two were never connected, so a user who typed the documented
  // confirmation got the workspace promoted and then every one of its lines
  // dropped by the token check — a green success report over a 22-byte zip.
  // The tokens allowed here are exactly those of the workspaces the user named.
  const allowDenyTokenFor = deniedTokensAllowed;

  for (const { file, cwds: lineCwds } of loaded.sessions) {
    const workspace = workspaceOf.get(file.path);
    if (workspace === undefined || !exportable.has(workspace.key)) continue;
    // privacy-tiers §4 level 3. Checked before the file is re-read, because a
    // session held back by hand should cost nothing to hold back.
    if (sessionDrops.has(sessionIdOf(file.path))) {
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
      if (
        touchedExcluded &&
        RETENTION_TABLE.topLevel[session.records[i].value?.type] === 'keep' &&
        cwdChangeFrom(session.records[i].value) === null
      ) {
        stats.droppedCwdless += 1;
        continue;
      }
      let result;
      try {
        result = retainRecord(session.records[i].value, ctx, at);
      } catch (err) {
        // Every walker here is recursive. Pathological nesting is a property of
        // the input, so it is a read error naming the line (exit 3), never
        // "a bug in deident" (exit 1).
        if (err instanceof RangeError) throw nestingError(at.file, at.line, err);
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
      strings.push(...r.strings);
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
function buildManifest(retained, decisions, serialized, embedded, entities) {
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
      { label: 'denied file content', suppressed: `${num(s.deniedBlocks ?? 0)} blocks, ${num(s.deniedBytes ?? 0)} bytes withheld` },
      { label: 'harness injections', suppressed: `${num(s.injectedBytesDropped ?? 0)} bytes of injected context stripped` },
      { label: 'documents', suppressed: `${num(s.documents)} pasted documents replaced` },
      // cli-ux §6 prints this row. It printed nothing at all while a live
      // 93-character token was in the archive.
      { label: 'secrets', suppressed: `${num(occurrencesOf('secret'))} replaced (${num(distinctOf('secret'))} distinct)` },
      { label: 'phone numbers', suppressed: `${num(occurrencesOf('phone'))} replaced (${num(distinctOf('phone'))} distinct)` },
    ]),
    // Counters, not zeros: a row reading `0 dropped by cwd  3 lines outside an
    // included directory` asserts a number and then contradicts it.
    droppedByCwd: s.droppedByCwd,
    droppedCwdless: s.droppedCwdless ?? 0,
    emptiedSessions: s.emptiedSessions ?? 0,
    unknownTypes: Object.freeze(
      [...(s.unknownTypes ?? new Map())].map(([type, count]) => Object.freeze({ type, count })),
    ),
    embedded,
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
function classify(loaded, saved, flags) {
  const groups = groupSessions(loaded.sessions);
  const probe = makeRemoteProbe();
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
  return { decisions, workspaceOf };
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
