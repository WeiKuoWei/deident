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
import { RefusalError, UsageError, osErrorLine } from './cli/errors.mjs';
import { estimateTokens, tokenCost } from './cli/tokens.mjs';
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
  nothingAdmittedRefusal,
  exportableTiers,
  cwdTierIndex,
} from './policy/workspaces.mjs';
import { recordRead, loadReads, countReads } from './policy/reads.mjs';
import { groupSessions } from './policy/grouping.mjs';
import { proposeTier, makeRemoteProbe } from './policy/signals.mjs';
import { allowLine, touchedDenied } from './policy/linefilter.mjs';
import { readReview, readSessionDrops, writeReview, renderReviewHtml, parseSessionRows, REVIEW_FILENAME } from './policy/reviewfile.mjs';
import {
  renderTriage,
  readVerdicts,
  applyVerdicts,
  TRIAGE_FILENAME,
} from './policy/triage.mjs';
import { firstUserPrompt } from './corpus/head.mjs';
import { seedEntities, DECLARED_SOURCE } from './entities/seed.mjs';
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
import { writeCandidates, readEntities, buildEntityList, CANDIDATES_FILENAME } from './entities/tier1.mjs';
import { probeCounts, probeOutliers, uncoveredNameParts } from './entities/probe.mjs';
import {
  newOccurrenceIndex,
  occurrencePath,
  readOccurrences,
  writeOccurrences,
} from './entities/occurrences.mjs';
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
  coverageRefusal,
  runAllChecks,
  toReportRows,
  unverifiedRemainder,
} from './verify/checks.mjs';
import { checkDeclaredValues } from './verify/declared.mjs';
import { writeZip, readZipFile, safeUnlink } from './output/zip.mjs';
import { writePreview } from './output/preview.mjs';
import { EXAMPLES_PER_REPORT, MIN_REPLAY_MATCH_CHARS } from './retain/constants.mjs';
import { loadUserDeny, setUserDeny, missingDenyWarning } from './policy/userdeny.mjs';
import { loadKnownValues, missingKnownValuesWarning } from './policy/knownvalues.mjs';
import {
  loadDictionary,
  saveDictionary,
  mergeEntities,
  proseHash,
  uncoveredSessions,
  DICTIONARY_FILENAME,
} from './policy/dictionary.mjs';

/**
 * The directory a command writes into. NEVER throws a raw ENOENT.
 *
 * This was `path.resolve(flags.out ?? process.cwd())` in all three commands.
 * process.cwd() is the same shape as the os.userInfo() bug: a platform call
 * that throws where the code reads a value. On POSIX a directory can be
 * removed while a process sits in it, and the next process.cwd() raises
 * `ENOENT: no such file or directory, uv_cwd`. Windows holds a handle on the
 * working directory so it cannot be removed, which is why it never showed up
 * on the machine this was written on; `cd /tmp/x && rm -rf /tmp/x` in another
 * terminal is all it takes on a teammate's.
 *
 * main() caught it, so nobody saw a traceback. What they saw was worse:
 * wrapUnexpected turned it into "internal error ... This is a bug in deident,
 * not a problem with your data ... Report it with this line". That is the
 * answer homeDir() was written to stop giving. It is an environment, it has a
 * remedy, and the remedy is a flag.
 *
 * path.resolve is inside the try because it reads process.cwd() itself for a
 * relative argument, so `--out ./here` lands on the same corner.
 */
/**
 * Load the two per-person files that live beside the salt, and say so when this
 * run has neither.
 *
 * One helper rather than a check at each command, because all three commands
 * that classify a workspace route through here and the failure it guards is
 * silent in every one of them. See missingDenyWarning.
 *
 * Called BEFORE anything reads a session, and that position is the whole point
 * for known-values.json: a malformed one refuses in the first second rather
 * than at step 8 of an export that has already spent twenty minutes in the
 * retention pass.
 *
 * `defaultSaltDir` is called only when --salt-dir was given, and its throw is
 * swallowed: on a machine with no HOME, naming --salt-dir is the documented fix
 * for that, so the run must not then fail inside a warning about it.
 *
 * @returns {ReadonlyArray<{value: string, kind: string}>} the declared values,
 *   which the caller threads into seedEntities
 */
function loadPrivateRules(flags, env, saltDir) {
  const rules = loadUserDeny(saltDir);
  const knownValues = loadKnownValues(saltDir);
  if (flags.saltDir !== null) {
    let fallback = null;
    try {
      fallback = defaultSaltDir(env);
    } catch {
      fallback = null;
    }
    for (const warning of [missingDenyWarning(saltDir, fallback), missingKnownValuesWarning(saltDir, fallback)]) {
      if (warning !== null) report.renderWarning(warning);
    }
  }
  setUserDeny(rules);
  return knownValues;
}

export function resolveOutDir(flags) {
  let resolved;
  try {
    resolved = path.resolve(flags.out ?? process.cwd());
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    throw new RefusalError('the current directory no longer exists, so deident has nowhere to write', {
      why: [
        'The directory this shell is sitting in was removed while it was open.',
        'This is the environment deident was started in, not a problem with your data.',
      ],
      remedies: [
        { label: 'Name an absolute path', command: 'deident scan --out <path>' },
        { label: 'Or move somewhere real', command: 'change to a directory that exists, then run deident again' },
      ],
    });
  }
  return checkOutDir(resolved);
}

/**
 * `--out` pointing at a file is one mistake, and it used to produce two
 * different answers.
 *
 * Every command reads `<out>/review.md` before it writes anything. Where `out`
 * is a regular file, Windows answers that read with ENOENT, which the readers
 * correctly take as "not scanned yet", so the run carried on and refused at
 * the write with `could not write <out>/review.html  EEXIST`. POSIX answers it
 * with ENOTDIR, which is not ENOENT, so the same run refused with `could not
 * read <out>/review.md` and offered `deident scan --out <out>` as the remedy:
 * a command that fails the same way, for a mistake that is neither missing nor
 * unreadable. Measured 2026-08-24 on Ubuntu, against the same fixture that
 * passed on Windows.
 *
 * Checked once here rather than by teaching every reader that ENOTDIR means
 * absent: `--out` is a directory or it is nothing, and stating that where the
 * flag is resolved is the only place it stays one answer on both platforms.
 */
function checkOutDir(resolved) {
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    // ENOENT is the ordinary case: the directory is created on first write.
    // Anything else is left to the write, which names the file it failed on.
    if (err?.code !== 'ENOTDIR') return resolved;
  }
  if (stat !== null && stat.isDirectory()) return resolved;
  throw new RefusalError(`could not write into ${resolved}: it is a file, not a directory`, {
    why: ['--out names the directory deident writes its report into.', 'Nothing was written.'],
    remedies: [{ label: 'Name a directory', command: 'deident <command> --out <path>' }],
  });
}

// ------------------------------------------------------------------- scan

export async function runScan(flags, env) {
  const outDir = resolveOutDir(flags);
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  // Before anything proposes a tier: matchDenyToken consults these, and a
  // token loaded after classify would silently propose the wrong tier for
  // the very directory it exists to protect.
  const knownValues = loadPrivateRules(flags, env, saltDir);
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
    decisions, loaded, workspaceOf, scanEntities(corpus, env, loaded, saltDir, probe, knownValues, reviewProblems),
    // Both remembered and local, for the same reason the tiers are: a person
    // should not answer the same question twice. Scanning into a fresh
    // directory used to render every session as `keep` while the salt
    // directory held the drops, which produces a review file that invites
    // exporting exactly what was already refused.
    nowStamp(),
    new Set([...remembered.sessionDrops, ...readSessionDrops(reviewPath, lenient).drops]),
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

/**
 * cli-ux §5, `--entity`: every occurrence of one pseudonym.
 *
 * A lookup in the index the export wrote, and nothing else. It reads no
 * session file, which is both faster and the honest shape: these counts are
 * what the substituter DID, and a read-only command that recomputed them would
 * be answering a different question with the same number.
 */
function runEntityQuery(token, saltDir) {
  const file = occurrencePath(saltDir);
  const index = readOccurrences(saltDir, '--entity');
  const rows = Array.isArray(index.occurrences) ? index.occurrences : [];
  const rec = rows.find((r) => r.pseudonym === token);
  if (rec === undefined) {
    // Naming what IS there, because the commonest way to arrive here is a
    // token copied from an older export: the salt is stable but the namespace
    // is not, and a run with --namespace mints a different token for the same
    // person. An empty success would read as "this entity is clean".
    const known = rows.slice(0, 5).map((r) => r.pseudonym);
    throw new RefusalError(`${token} is not in the occurrence index`, {
      why: [
        `The last export (${index.at ?? 'unknown date'}) replaced ${rows.length} entities and none of them is ${token}.`,
        known.length === 0
          ? 'That export replaced nothing at all, so there is nothing to drill into.'
          : `Tokens it did replace, highest count first: ${known.join(', ')}.`,
        'A token from an earlier export will not be found here: --namespace changes the token for the same person.',
      ],
      remedies: [
        { label: 'List every token this export replaced', command: `read the "occurrences" array in ${file}` },
        { label: 'Or re-export and read the counts it prints', command: 'deident export --out <path> --json' },
      ],
    });
  }
  report.renderEntityOccurrences(rec, file);
  // Recorded as a drill-down and never as a session read. The rows this printed
  // are one excerpt per occurrence, so what the person now knows is about the
  // entity, not about any session it appeared in. Folding it into the session
  // count is the arithmetic that killed the random-sample proposal: a matched
  // line is not a look at 5,000 lines around it.
  recordRead(saltDir, token, 'review --entity', 'entities');
  return 0;
}

/**
 * cli-ux §5, `--session`: one full redacted transcript.
 *
 * The archive entry verbatim, because that is what "redacted" means here: the
 * bytes the recipient opens. A second renderer over the corpus would be a
 * second copy of the retention table, and this repository's own history is a
 * list of two copies of one rule drifting apart.
 *
 * ponytail: printed as the JSONL it is, not pretty-printed. A formatter would
 * be another thing to keep in step with the record types.
 */
function runSessionQuery(id, saltDir) {
  const file = occurrencePath(saltDir);
  const index = readOccurrences(saltDir, '--session');
  const sessions = Array.isArray(index.sessions) ? index.sessions : [];
  // Either name works: the id on this machine, or the entry name inside the
  // archive, which is the only id a person holding the zip can see.
  const match = sessions.find(
    (s) => s.id === id || s.entry === id || path.basename(s.entry ?? '', '.jsonl') === id,
  );
  if (match === undefined) {
    throw new RefusalError(`${id} is not a session in the last export`, {
      why: [
        `The export of ${index.at ?? 'unknown date'} wrote ${sessions.length} sessions, and none of them is ${id}.`,
        'A session held back at the review step is not in the archive, so it cannot be printed from one.',
      ],
      remedies: [
        { label: 'See which sessions are in the archive', command: `read export-map.txt beside the zip` },
        { label: 'Or find the session id from an entity', command: 'deident review --entity <TOKEN>' },
      ],
    });
  }

  const archive = index.archive ?? null;
  let entries;
  try {
    entries = readZipFile(archive);
  } catch (err) {
    throw new RefusalError(`could not read the archive at ${archive}`, {
      why: [
        osErrorLine(err),
        'The transcript printed here is read back out of the archive, so that it cannot disagree with what shipped.',
      ],
      remedies: [{ label: 'Export again', command: 'deident export --out <path>' }],
    });
  }
  const entry = entries.find((e) => e.name === match.entry);
  if (entry === undefined) {
    throw new RefusalError(`${match.entry} is not in ${archive}`, {
      why: ['The archive on disk is not the one this index was written for.'],
      remedies: [{ label: 'Export again', command: 'deident export --out <path>' }],
    });
  }
  report.renderSessionTranscript(match.id ?? id, match.entry, entry.data, `${file} and ${archive}`);
  // The one read path that opens a whole session, which is why it is the only
  // one that counts in the manifest. Recorded against the REAL session id, not
  // the archive entry name: the entry name is rewritten per export and the
  // manifest has to match reads to the sessions the next export ships.
  //
  // Written after the transcript, so a read is recorded only once the person
  // has actually been shown one.
  recordRead(saltDir, match.id ?? id, 'review --session');
  return 0;
}

export async function runReview(flags, env) {
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  // cli-ux §5's two queries answer from the index the export wrote, so they run
  // before the corpus is opened: `review` promises to write nothing, and
  // rebuilding the whole review model to answer them would read every session
  // file for a question already answered on disk.
  if (flags.entity !== null) return runEntityQuery(flags.entity, saltDir);
  if (flags.session !== null) return runSessionQuery(flags.session, saltDir);

  const outDir = resolveOutDir(flags);
  // Before anything proposes a tier: matchDenyToken consults these, and a
  // token loaded after classify would silently propose the wrong tier for
  // the very directory it exists to protect.
  const knownValues = loadPrivateRules(flags, env, saltDir);
  const corpus = resolveCorpus(env, flags.root);
  const loaded = surveyCorpus(corpus, flags);
  const reviewPath = path.join(outDir, REVIEW_FILENAME);
  const problems = [];
  const lenient = { onProblem: (why) => problems.push(why) };
  const remembered = loadSavedDecisions(saltDir);
  const saved = { byKey: remembered.workspaces, byName: readReview(reviewPath, lenient) };
  const { decisions, workspaceOf, probe } = classify(loaded, saved, flags);
  const model = buildReviewModel(
    decisions, loaded, workspaceOf, scanEntities(corpus, env, loaded, saltDir, probe, knownValues, problems),
    nowStamp(),
    new Set([...remembered.sessionDrops, ...readSessionDrops(reviewPath, lenient).drops]),
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
  report.renderTranscript(
    model.workspaces.map(
      (w) => `  ${w.tier.padEnd(12)} ${w.name.padEnd(26)} ${w.sessionCount} sessions   ${w.cwd ?? ''}`.trimEnd(),
    ),
  );
  return 0;
}

// ----------------------------------------------------------------- triage

/**
 * The cheap per-session pass, between `scan` and the entity list.
 *
 * It reads review.md, the HEAD of each still-kept session file, and nothing
 * else. Measured 2026-08-24 on the live corpus: 205 sessions, and each one's
 * workspace plus its first prompt truncated to 300 characters is 23,302
 * characters, about 7k tokens, against 915 KB and about 250k tokens for the
 * entity pass that follows.
 *
 * `resolveCorpus` is a directory walk and a stat per file; it opens nothing.
 * `firstUserPrompt` opens each file once and reads at most its first 256 KB.
 * Neither surveyCorpus nor retainCorpus runs here, and that is the point.
 */
export async function runTriage(flags, env) {
  const outDir = resolveOutDir(flags);
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  const reviewPath = path.join(outDir, REVIEW_FILENAME);
  const reviewText = readReviewText(reviewPath, outDir);
  const corpus = resolveCorpus(env, flags.root);
  const pathById = new Map(corpus.files.map((f) => [f.sessionId, f.path]));

  return flags.apply
    ? applyTriage(flags, saltDir, reviewPath, reviewText, pathById)
    : writeTriage(flags, outDir, reviewText, pathById, loadSavedDecisions(saltDir).sessionDrops);
}

/**
 * review.md is the input, so a missing one is a refusal rather than an empty
 * run. Triage's whole job is to shrink a list of sessions the person has
 * already decided about; with no decisions there is no list, and rendering
 * every session as a candidate would put the entire corpus in front of a
 * reader under a header claiming it had been filtered.
 */
function readReviewText(reviewPath, outDir) {
  try {
    return fs.readFileSync(reviewPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new RefusalError(`could not read ${reviewPath}`, {
        why: [`${err.code}: ${err.message}`],
        remedies: [{ label: 'Regenerate it', command: `deident scan --out ${outDir}` }],
      });
    }
    throw new RefusalError(`no ${REVIEW_FILENAME} in ${outDir}, so there is nothing to triage`, {
      why: [
        'Triage narrows the sessions your review still proposes to keep.',
        'Nothing has proposed anything yet, so every session would be a candidate',
        'and the header would be claiming a filter that had not run.',
      ],
      remedies: [{ label: 'Survey first', command: `deident scan --out ${outDir}` }],
    });
  }
}

/** Direction one: write the file a reader acts on. */
function writeTriage(flags, outDir, reviewText, pathById, rememberedDrops) {
  const rows = [];
  let missingFiles = 0;
  for (const row of parseSessionRows(reviewText)) {
    // Only what is still proposed `keep`, and remembered drops count too: scan
    // writes those into review.md, but a review.md generated before a hold was
    // remembered would offer the session again, and paying a reader to look at
    // a session that is already out is exactly the waste this stage removes.
    if (row.decision !== 'keep' || rememberedDrops.has(row.id)) continue;
    const filePath = pathById.get(row.id);
    if (filePath === undefined) {
      // The session was deleted between the scan and now. There is no prompt to
      // show and no reason to ask about it, so it is counted rather than listed.
      missingFiles += 1;
      continue;
    }
    const head = firstUserPrompt(filePath);
    rows.push(Object.freeze({ ...row, prompt: head.text, skipped: head.skipped }));
  }

  const body = renderTriage(rows, { chars: flags.triageChars });
  const triagePath = path.join(outDir, TRIAGE_FILENAME);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(triagePath, body, 'utf8');
  } catch (err) {
    throw new RefusalError(`could not write ${triagePath}`, {
      why: [`${err.code}: ${err.message}`, 'Nothing was written.'],
      remedies: [{ label: 'Choose a writable directory', command: 'deident triage --out <path>' }],
    });
  }

  if (missingFiles > 0) {
    report.renderWarning(
      `${missingFiles} session${missingFiles === 1 ? '' : 's'} in ${REVIEW_FILENAME} no longer exist on disk and were not offered`,
    );
  }
  report.renderTriageWritten({
    path: triagePath,
    sessions: rows.length,
    withoutPrompt: rows.filter((r) => r.prompt === null).length,
    // Counted separately because they are two different things to do about the
    // file: a row with nothing to judge is one the rubric already answers, and
    // a row shown a later prompt is one whose opening the reader should not
    // read anything into.
    shownLater: rows.filter((r) => r.prompt !== null && r.skipped.length > 0).length,
    chars: flags.triageChars,
    bytes: Buffer.byteLength(body, 'utf8'),
    // Same estimator as the candidates file. docs/model-tier.md argues triage
    // is worth a command because it is 35x cheaper than the entity pass, and
    // an argument about cost that never prints a cost is one the reader has to
    // take on trust.
    tokenEstimate: tokenCost([{ label: 'triage', estimate: estimateTokens(body) }]),
  });
  return 0;
}

/** Direction two: merge the reader's answer back into review.md. */
function applyTriage(flags, saltDir, reviewPath, reviewText, pathById) {
  const verdicts = readVerdicts(flags.verdicts);
  const result = applyVerdicts(reviewText, verdicts);

  if (result.applied.length > 0) {
    try {
      fs.writeFileSync(reviewPath, result.text, 'utf8');
    } catch (err) {
      throw new RefusalError(`could not write ${reviewPath}`, {
        why: [`${err.code}: ${err.message}`, 'No verdict was applied.'],
        remedies: [{ label: 'Fix the permissions', command: `edit ${reviewPath}` }],
      });
    }
    // Beside the tiers, for the reason F104 exists: a decision that lives only
    // in the review.md this run happened to read is lost the moment somebody
    // scans into a different directory.
    const remembered = loadSavedDecisions(saltDir);
    rememberDecisions(
      saltDir,
      // saveDecisions rebuilds the whole workspaces map from what it is handed,
      // so handing it an empty list would erase every remembered tier on the
      // machine. They are re-declared exactly as they were read back.
      Object.entries(remembered.workspaces).map(([key, tier]) => ({ key, tier, decided: true })),
      new Set([...remembered.sessionDrops, ...result.applied]),
    );
  }

  // Sessions get deleted between runs, so a stale id is ordinary. Refusing
  // would throw away every other verdict in the same file over somebody tidying
  // a directory, and the reader would have to run the whole stage again.
  for (const id of result.unmatched) {
    report.renderWarning(
      pathById.has(id)
        ? `verdict for "${id}" was not applied: that session is in the corpus but has no row in ${REVIEW_FILENAME}. Run scan again to decide it`
        : `verdict for "${id}" was not applied: no session with that id, and none in the corpus either. It was probably deleted between runs`,
    );
  }
  report.renderTriageApplied({
    path: reviewPath,
    applied: result.applied.length,
    unchanged: result.unchanged.length,
    unmatched: result.unmatched.length,
    verdicts: verdicts.length,
  });
  return 0;
}

// ----------------------------------------------------------------- export

export async function runExport(flags, env) {
  const outDir = resolveOutDir(flags);
  const saltDir = flags.saltDir ?? defaultSaltDir(env);
  // Before anything proposes a tier: matchDenyToken consults these, and a
  // token loaded after classify would silently propose the wrong tier for
  // the very directory it exists to protect.
  const knownValues = loadPrivateRules(flags, env, saltDir);
  // Read here rather than at step 11, so a dictionary somebody broke while
  // hand-editing refuses in the first second instead of after the corpus has
  // been read, which is more than ten minutes on a few hundred sessions.
  const dictionary = loadDictionary(saltDir);

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
  // workspaces got exported on a bare `deident export`, including one the
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
  // The one migration the entry gate needs, and the only half of it that is
  // detectable. Before default-deny, `scan` wrote its own `redact` proposal
  // into column 1 of review.md, so a remembered exportable tier from that era
  // may be a proposal nobody typed. Applied anyway (re-asking every row is the
  // 29 questions that produce no answers), and said out loud, because the
  // manifest's new sentence is a claim about how those tiers got there.
  //
  // The undetectable half is a review.md file written by that same version and
  // never regenerated. It is named in the remedy rather than guessed at:
  // `deident scan` rewrites column 1 from the current proposals.
  if (remembered.legacy) {
    const inherited = Object.values(remembered.workspaces).filter((t) => t === 'redact' || t === 'open').length;
    if (inherited > 0) {
      const one = inherited === 1;
      report.renderWarning(
        `${inherited} remembered tier${one ? ' predates' : 's predate'} the entry gate, when deident still proposed ` +
          `"redact" for any workspace with a git remote, so ${one ? 'it' : 'some of them'} may be a proposal you ` +
          `never typed. ${one ? 'It is' : 'They are'} applied this run. To see and re-type ` +
          `${one ? 'it' : 'them'}: deident scan, then read column 1 of ${REVIEW_FILENAME}`,
      );
    }
  }
  // Remembered HERE, not after the zip is written.
  //
  // A decision typed into review.md used to be persisted only by a run that
  // also produced a successful export, so the sequence "set a tier, watch the
  // export refuse for an unrelated reason, run it again elsewhere" lost the
  // tier. workspaces.json is memory, not output: cli-ux §10's "no output file
  // behind" is about the zip, and forgetting what the person told you is the
  // failure that ends with an excluded workspace shipping.
  // Declared before anything is read, so an unknown value refuses at the flag
  // rather than after twenty minutes of work.
  const reviewSessions = readSessionDrops(reviewPath, { audience: flags.audience ?? 'public' });
  // A row spelled the way review.md used to spell it. It is still held, and
  // saying so is the difference between a silent migration and one the person
  // can finish: the value is no longer offered, so nothing else will mention it.
  if (reviewSessions.legacyAudienceRows > 0) {
    report.renderWarning(
      `${reviewSessions.legacyAudienceRows} row(s) in ${REVIEW_FILENAME} say drop:audience, which deident no longer ` +
        'offers. They are held, the same as drop, and the decision is remembered. To rewrite the file in the ' +
        'current shape: deident scan',
    );
  }
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
  // The screen every first run now ends on, because no proposal is exportable
  // (signals.mjs, the remote branch). It has to carry the next action rather
  // than restate the rule, so it names the file, the column and the rows.
  const nothingAdmitted = nothingAdmittedRefusal(decisions, reviewPath);
  if (nothingAdmitted !== null) throw nothingAdmitted;

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
  //     `namespaceHits` is capped at EXAMPLES_PER_REPORT; `namespaceHitFiles`
  //     counts every one. Filtering both to the retained set can leave the
  //     sample empty while the counter is positive, so the file list comes
  //     from the counter and the sample is only ever an example.
  let scopedHitCount = 0;
  const scopedHitFiles = [];
  for (const [file, count] of loaded.namespaceHitFiles ?? []) {
    if (!retainedFiles.has(file)) continue;
    scopedHitCount += count;
    scopedHitFiles.push(file);
  }
  if (scopedHitCount > 0) {
    throw namespaceRefusal(scopedHits, flags.namespace, scopedHitCount, scopedHitFiles);
  }

  //  8  seed entities from PRE-substitution values (PLAN §2). Run seeding
  //     after substitution and these values are already pseudonyms: seeding
  //     becomes a no-op, the table is empty, and the tool exports the corpus
  //     while reporting a triumphant "known-entity residue: 0".
  //
  //     Seeded from EVERY directory the corpus touched, not only the exported
  //     ones. An excluded workspace's own path is still spelled out inside
  //     retained text: measured on a real export, the parent matched and the
  //     tail did not, so the zip carried `X_WORKSPACE_10601283/private/
  //     auditor-notes` x8, `/private/hsbc-out.json` x9 and
  //     `/private/payroll-ledger` x12, a recipient learning the private
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
    // The whole of what the declared audience moves. It decides whether the
    // employer's own product vocabulary is an identity or a word the reader
    // uses daily; it does not decide which sessions ship.
    audience: reviewSessions.audience,
    // Read at the top of the command, not here: a malformed list must refuse
    // before the retention pass, not after it.
    knownValues,
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
  //     is meant to feed, so a run that refused for an unrelated reason left
  //     un-de-identified names on disk. It is written only on the path that
  //     needs it: the refusal that asks the user to produce an entity list.
  const candidatesPath = path.join(outDir, CANDIDATES_FILENAME);
  const tier1 = resolveTier1(flags, dictionary);

  // 11a  per-session accounting for the semantic pass.
  //
  //      Hashed over the RETAINED prose, before tier-0 substitution: the
  //      cleaned text carries pseudonyms and `--namespace` takes a fresh value
  //      every run, so a hash of the cleaned text would report every session
  //      as changed on every run while looking like it worked.
  //
  //      The two record sets are the same sessions in the same order
  //      (substituteAll rebuilds the array as it walks it), and the candidates
  //      file needs the CLEANED prose, so the pair is matched on session id
  //      rather than on index.
  const rawProse = new Map(
    extractProseBySession(retained.records).map((s) => [s.id, s.chunks]),
  );
  const perSession = extractProseBySession(cleaned.records).map((s) => ({
    id: s.id,
    chunks: s.chunks,
    mtimeMs: s.mtimeMs,
    hash: proseHash(rawProse.get(s.id) ?? s.chunks),
  }));
  const uncovered = uncoveredSessions(dictionary.sessions, perSession, { ignoreRecord: flags.full });
  const coverage = Object.freeze({ total: perSession.length, uncovered });

  const semantic = checkSemanticPass(tier1, coverage);
  if (!semantic.ok) {
    // Which sessions go in front of the reader, decided by WHICH failure this
    // is rather than by what is uncovered.
    //
    //   uncovered only   coverage is short and the list is fine: the ordinary
    //                    repeat run, and the whole economic argument. 915 KB of
    //                    prose becomes the handful of sessions that changed.
    //                    `--full` arrives here with every session uncovered, so
    //                    it needs no branch of its own.
    //   everything       there is no usable entity list at all, so there is
    //                    nothing remembered to read against. Showing only what
    //                    changed here is the trap: with the entities deleted by
    //                    hand and the session record kept, the reader would be
    //                    handed one session, write a list from it, and the next
    //                    run would export the whole corpus against it with
    //                    every gate green, because every session IS recorded as
    //                    read.
    const shown = new Set(uncovered.map((s) => s.id));
    const showAll = semantic.why !== 'uncovered';
    const offered = perSession.filter((s) => showAll || shown.has(s.id));
    // The batch, bounded by a running character budget.
    //
    // The whole safety gate is a reader getting through this file in one pass,
    // and nothing was checking the pass was possible. rememberShown runs below
    // on everything written here, keyed on having been SHOWN, so a reader who
    // got through 200 KB of the measured 915 KB had all 205 sessions recorded
    // as read and the next export printed `205/205 sessions read ok`.
    //
    // At least one session always goes in, or a single session larger than the
    // budget stalls the loop forever. What is left out is not remembered, so
    // coverageRefusal already drives the next batch on the next run: no new
    // command, no new flag path, no new state.
    const batch = [];
    let spent = 0;
    for (const s of offered) {
      const size = s.chunks.reduce((a, c) => a + (typeof c === 'string' ? c.length : 0), 0);
      if (batch.length > 0 && spent + size > flags.batchChars) break;
      spent += size;
      batch.push(s);
    }
    const deferred = offered.length - batch.length;
    const chunks = batch.flatMap((s) => s.chunks);
    const omitted = showAll ? 0 : perSession.length - shown.size;
    const candidates = writeCandidates(
      chunks,
      candidatesPath,
      // Everything the residual scan runs over the zip runs over this file too.
      // It is the one artifact intended to be read by an LLM, i.e. the one most
      // likely to leave the machine, and its own header states that the
      // username, paths, git identity and remotes have already been replaced.
      // `audience` is here because this file is the instruction the reader
      // writes the entity list against, and the rule it must state changes with
      // the declared recipient. Kept in SKILL.md alone it reached them only if
      // the operator had loaded the skill and remembered a conditional in it.
      { table: tier0Table, omitted, deferred, audience: reviewSessions.audience },
    );
    // Written BEFORE the refusal, and it is memory rather than output: these
    // sessions have now been put in front of a reader, and cli-ux §10's "no
    // output file behind" is about the archive. Forgetting it means the next
    // run shows the same prose again, which is the cost this whole file exists
    // to remove.
    // `reset` when showAll, because showAll means the session record is by
    // definition untrustworthy (that is why it is true). Merging a capped
    // batch into it would recreate exactly the trap the comment above names:
    // the reader gets batch 1, writes a list from it, and the next run exports
    // the whole corpus against that list with every gate green, because every
    // other session is still recorded as read.
    rememberShown(saltDir, dictionary, batch, { reset: showAll });
    report.renderCandidates(
      candidates.path,
      candidates.chars,
      omitted,
      candidates.omittedChars,
      deferred,
      tokenCost([{ label: 'candidates', estimate: candidates.estimate }]),
    );
    if (semantic.why === 'uncovered') {
      throw coverageRefusal(uncovered, perSession.length, candidates.path, { full: flags.full });
    }
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
  //     green. Nothing could catch it either, checkSubstitution only sees
  //     strings that CHANGED, and residualScan cannot find a spelling tier 0
  //     already destroyed. A 20,000-trial two-tier fuzz produced 3,636 of
  //     these and the gates caught none.
  //     A uuid in the candidates file is deident's OWN output, and declaring
  //     one makes the residue gate refuse against the tool itself. Stripped
  //     before anything else looks at the list, so nothing downstream has to
  //     know about the case.
  const minted = stripMintedSpellings(tier1.entities, rewriteUuid.minted);
  for (const d of minted.dropped) {
    report.renderWarning(
      `entity spelling ignored, it is a uuid deident minted rather than one from your sessions: ${d}`,
    );
  }
  const tier1Entities = minted.entities.map((e) => withCleanedSpellings(e, tier0Table, flags.namespace));
  const tier1Assigned = assignPseudonyms(tier1Entities, salt, flags.namespace, { taken: tier0.taken });
  const tier1Table = buildTable(tier1Assigned.entities, { forbidInside: pseudonymGuardPattern(flags.namespace) });
  report.renderPhase(`Substituting ${tier1Table.size.toLocaleString('en-US')} tier-1 spellings`);
  const final = substituteAll(cleaned.records, tier1Table);

  //  12a  How many times each spelling WOULD be replaced, over the text each
  //       pass actually sees. Not a gate: measured 2026-08-24, an ordinary noun
  //       at 202 occurrences had to fail and a real identity at 255 had to pass,
  //       so no threshold separates them. The number goes in front of a reader.
  //
  //       The same sweep builds the drill-down index (cli-ux §5). The counts
  //       and the occurrences behind them come from ONE walk with ONE matcher,
  //       so a reader who drills into a count cannot be shown a different
  //       number from the one that sent them there. Written to the salt
  //       directory at the end of a successful run, never to the output
  //       directory: see occurrences.mjs.
  const occurrenceIndex = newOccurrenceIndex();
  const cleanedTexts = taggedRetainedStrings(cleaned.records);
  const replacementCounts = Object.freeze([
    ...probeCounts(taggedRetainedStrings(retained.records), tier0Table, occurrenceIndex.sink),
    ...probeCounts(cleanedTexts, tier1Table, occurrenceIndex.sink),
  ]);
  report.renderProbe(probeOutliers(replacementCounts));

  //  12a  The values the person DECLARED, printed back with what each one
  //       actually replaced.
  //
  //       Not a gate and not a threshold. src/entities/probe.mjs measured that
  //       frequency does not separate a noun from a name (202, 17 and 255 on
  //       one corpus, in the wrong order), and a declared value is where a
  //       false alarm would do the most damage: the person wrote this file by
  //       hand about themselves, and a source that argues with them is a source
  //       that stops being filled in. So a declared value that turns out to be
  //       an ordinary word occurring hundreds of times is REPLACED, and its
  //       count is printed beside it for the person to act on.
  //
  //       The rows nobody else prints are the two that mean a declaration did
  //       nothing: a value the corpus never contained (usually a typo in the
  //       list), and a value the existing safety rules refuse to substitute at
  //       all, which today is visible only in the export map.
  report.renderDeclared(declaredValueRows(seeded.entities, replacementCounts));

  //  12b  Pieces of a declared spelling that still stand alone in the text: a
  //       surname of a declared person, and a contiguous run of words from a
  //       declared spelling of any other kind.
  //
  //       Measured over the tier-0-cleaned text, which is what the semantic
  //       pass read, so a part the reader could have declared and did not is
  //       what shows up. Reported and not substituted: docs/model-tier.md
  //       measured every tier naming "Grace Hopper" while the mid tier never
  //       named the bare "Morgan", and in this corpus May, Wise and Ray are
  //       all parts of real names and all ordinary words. Measured 2026-08-24
  //       over the live corpus, the run half found five more: a street and a
  //       district from an office address declared as one string, and an org
  //       name whose only declared form carried a trailing partner list.
  report.renderNameParts(uncoveredNameParts(tier1Entities, cleanedTexts));

  // 13  substitution invariant, at string level, before serialization.
  //
  //     Each pass is verified against ITS OWN table. Verifying tier-0's
  //     strings against the merged table reports every tier-1 entity in them
  //     as "missed", because tier 0 was never asked to replace it, and a
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

  // The counterweight to the block above, and it is measured on this run
  // rather than quoted. Every check in `checks` compares the output against the
  // entity table; nothing compares it against the sessions. `perSession` is the
  // prose that has been put in front of a reader (the semantic-pass gate above
  // refuses while any of it has not been), and the archive is what leaves, so
  // the difference is the part of the export no person read and no check reads
  // for names. Bytes on both sides, so the percentage means what it says.
  const proseBytes = perSession.reduce(
    (a, s) => a + s.chunks.reduce((b, c) => b + (typeof c === 'string' ? Buffer.byteLength(c, 'utf8') : 0), 0),
    0,
  );
  const remainder = unverifiedRemainder(
    proseBytes,
    Buffer.byteLength(serialized.allBytes, 'utf8'),
    retained.stats.toolParamBytes ?? 0,
  );
  report.renderChecks(toReportRows(checks), remainder);

  //  15a  The declared values the table never carried, swept with needles
  //       re-derived from known-values.json on disk.
  //
  //       Run here rather than beside the on-disk rescan so it also runs under
  //       --preview, which is the run where the person can still fix their list
  //       before anything is packed. cli-ux §6a prints these rows with a dash
  //       and the sentence "may still be in the archive"; this is the answer to
  //       that sentence.
  //
  //       It re-reads the file, so a malformed list throws a RefusalError here
  //       rather than returning a clean result. That is the right outcome and
  //       not a second validation pass: loadPrivateRules read the same file
  //       successfully at the top of the command, so a failure at this point
  //       means somebody edited it mid-run, and a check whose needles came from
  //       a file that changed under it cannot say anything. Nothing is written
  //       yet, so cli-ux §10 holds.
  report.renderDeclaredResidue(checkDeclaredValues(serialized.allBytes, saltDir, mergedTable));

  //  15b  The occurrences the boundary rule refused, per spelling, for the
  //       tier-0 spellings that identify the uploader. Measured 2026-08-24: the
  //       OS username shipped inside cloud resource names (`stdevuser-prod`,
  //       `kv-devuser37557093578778`) while this same scan printed
  //       `known-entity residue 0`, because a seed glued to alphanumerics can
  //       never match. A report and not a gate: the boundary rule is correct
  //       and §4.5 row 4 requires the non-match.
  report.renderGluedResidue(residue.scan.gluedHits);

  for (const w of [...loaded.warnings, ...seeded.warnings]) report.renderWarning(w);

  if (!substitution.ok) throw substitutionRefusal(substitution);
  if (!residue.ok) throw residueRefusal(residue);
  // I6 again, per PLAN §2: a refusal one skipped code path can bypass is not
  // a refusal. Both halves of it, because per-session coverage is the half a
  // dictionary can silently satisfy.
  if (semantic.why === 'uncovered' && !semantic.ok) {
    throw coverageRefusal(coverage.uncovered, coverage.total, candidatesPath, { full: flags.full });
  }
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
  // corpus, or tier 0 had already destroyed the spelling, and the second is
  // how a declared org shipped its remainder while `--preview` alone would
  // have shown the row reading `1 spelling, 0 occurrences`. Plain `export`
  // printed nothing at all.
  const unmatched = entities.filter(
    (e) => e.tier === 1 && !e.rejected && e.spellings.length > 0 && (e.occurrences ?? 0) === 0,
  );
  if (unmatched.length > 0) {
    report.renderUnmatched(unmatched.map((e) => ({ id: e.id, kind: e.kind, canonical: e.canonical })));
  }
  // How many sessions in THIS archive a human has opened, and how many are
  // shipping unread. Keyed on the archive's own entries rather than on the
  // retained set, so the denominator is the number of files the recipient will
  // find in the zip and cannot drift from it.
  //
  // The mtime comes from the session record the export already read, so a read
  // of a session that has been appended to since stops counting with no extra
  // stat and no extra state.
  const mtimeOf = new Map(perSession.map((s) => [s.id, s.mtimeMs]));
  const reading = countReads(
    loadReads(saltDir),
    serialized.entries.map((e) => ({ id: e.source, mtimeMs: mtimeOf.get(e.source) ?? NaN })),
  );
  const manifest = buildManifest(retained, decisions, serialized, residue, entities, spanCaveats(allStrings), reviewSessions, seeded.audienceEntities, reading);
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
        // Same object the terminal and --json got, so the three surfaces
        // cannot disagree about the size of what nobody checked.
        unverified: remainder,
      },
      path.join(outDir, `deident-preview-${today()}.diff`),
    );
    rememberEntities(saltDir, dictionary, minted.entities, rewriteUuid.minted);
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
    // This is a build instruction rather than
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
    // Beside the salt, not beside the zip. It carries pseudonym -> real
    // spelling AND real session id, which is strictly more than export-map.txt,
    // so the output directory is the one place it must never be: that is the
    // directory a person zips up and sends.
    //
    // Written here, after the on-disk residue scan, so an index can never
    // describe an archive that was refused and removed.
    writeOccurrences(
      occurrencePath(saltDir),
      {
        at: nowStamp(),
        archive: written.path,
        sessions: serialized.entries.map((e) => ({ id: e.source ?? null, entry: e.name })),
        occurrences: occurrenceIndex.rows(),
      },
      (w) => report.renderWarning(w),
    );
    // After the archive is on disk, so a run that refused at the on-disk scan
    // does not record identities against an export that never happened.
    rememberEntities(saltDir, dictionary, minted.entities, rewriteUuid.minted);
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

/**
 * Where this run's tier-1 entities come from.
 *
 * No flag: the dictionary supplies them, which is what makes a repeat run one
 * command. The flag: the file wins, and the dictionary supplies only the
 * identities the file does not name.
 *
 * The union rather than the file alone, and the direction is deliberate. A
 * reader answering a repeat run writes a list about the sessions they were
 * just shown (a handful), and applying only that list would drop every
 * identity the earlier runs established while every gate stayed green, because
 * the residual scan can only look for what it was given (§F1). Dropping an
 * identity on purpose is still possible and is a hand edit of the dictionary,
 * which is the file's whole point.
 */
function resolveTier1(flags, dictionary) {
  const remembered =
    dictionary.entities.length === 0
      ? null
      : buildEntityList(dictionary.entities, {
          at: dictionary.path,
          source: `the dictionary at ${dictionary.path}`,
        });
  if (flags.entities === null) return remembered;

  const declared = readEntities(flags.entities);
  if (remembered === null) return declared;

  // Merged as declared lists, so one validator sees the result and the
  // identity rule is the same one the dictionary is written with.
  const merged = mergeEntities(
    dictionary.entities,
    declared.entities.map((e) => ({ kind: e.kind, spellings: e.declared, confidence: e.confidence })),
  );
  return buildEntityList(merged.entities, {
    at: flags.entities,
    source: `--entities ${flags.entities} + ${dictionary.entities.length} remembered`,
    generated: declared.generated,
  });
}

/** Record that these sessions have been put in front of a reader. */
function rememberShown(saltDir, dictionary, sessions, opts = {}) {
  const stamp = nowStamp();
  const record = opts.reset === true ? {} : { ...dictionary.sessions };
  for (const s of sessions) record[s.id] = { hash: s.hash, read: stamp };
  try {
    saveDictionary(saltDir, { entities: dictionary.entities, sessions: record });
  } catch (err) {
    report.renderWarning(
      `could not remember which sessions you have read (${err.code ?? 'error'}: ${err.message}). ` +
        `${DICTIONARY_FILENAME} is memory, not output, so nothing is wrong with this run; ` +
        'the next one will show you the same prose again',
    );
  }
}

/**
 * Merge the entity list this export actually used into the dictionary.
 *
 * `stripMintedSpellings` again, on the declared forms this time. A uuid in the
 * candidates file is deident's own output, and declaring one makes the residue
 * gate refuse against the tool itself; remembering one turns that from a
 * one-run mistake into a permanent one. Same function rather than a second
 * copy of the rule, so the two cannot disagree.
 */
function rememberEntities(saltDir, dictionary, entities, minted) {
  // A REJECTED entity is left out. It replaced nothing this run and would
  // replace nothing next run either (rejectReason is deterministic), so
  // remembering it is a row in a hand-edited file that does nothing.
  const declared = entities
    .filter((e) => !e.rejected && (e.declared?.length ?? 0) > 0)
    .map((e) => ({ kind: e.kind, spellings: [...e.declared], confidence: e.confidence }));
  const clean = stripMintedSpellings(declared, minted);
  const merged = mergeEntities(dictionary.entities, clean.entities);
  try {
    saveDictionary(saltDir, { entities: merged.entities, sessions: dictionary.sessions });
  } catch (err) {
    report.renderWarning(
      `could not remember the entity list (${err.code ?? 'error'}: ${err.message}). ` +
        'The export is written and valid; the next run will ask you for the list again',
    );
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
 * The parsed records of a file are NOT kept. Measured on the operator's 833 MB corpus
 * (2026-08-22): holding the raw text, the parsed value and a second array of
 * raw lines for the whole corpus needed between 2.5 and 3.0 GB of old space and
 * aborted the process with a V8 heap-limit FATAL ERROR, which no try/catch can
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
  // line inside multi-line prose, the exact shape cli-ux §3's own sample row
  // arrives in, while the check printed "no pre-existing PERSON_n tokens ok"
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
    // can report it, and it throws inside `scan`, the command cli-ux §1 sells
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
    // These have to be declared HERE as well as in the retention context: the
    // merge below is `if (typeof v === 'number' && k in stats)`, so a counter
    // that exists only on the context is summed into nothing and the manifest
    // prints a confident zero.
    toolResults: 0,
    toolResultBytesDropped: 0,
    toolParamBytes: 0,
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
  // dropped by the token check, a green success report over a 22-byte zip.
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
    // gives it the cwd in force when it was written, which, for a record that
    // REPLAYS earlier user text, is the cwd of a later moment, not of the turn
    // it replays. Measured on a real export: prose authored only at
    // `...\ops-handover\private\auditor-notes` was replayed by three
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
    // reduced to zero is not a conservative choice, it is a silent one, the
    // manifest said only "3,784 records dropped" and "5,821 user messages",
    // which reads as though the user prose is intact.
    //
    // `mode` was worse: 6,976 of them in the corpus, 0 carrying a cwd, so
    // every one went, and docs/privacy-tiers.md defines the count-only tier
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
      // the real cost was a fraction of that, a number that overstates its own
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
/**
 * Remove spellings that name a uuid deident itself minted.
 *
 * `deident-candidates.txt` is written AFTER the uuid rewrite, so every uuid a
 * reader sees in it is already a pseudonym. Measured 2026-08-24 on the live
 * corpus: two independent readers each saw one recurring 49 times, reasonably
 * called it a secret, and declared it. The export then refused with
 * "1 known-entity occurrence survived into the output" and offered the remedy
 * "file an issue against deident". The tool blamed itself for its own output,
 * ten minutes into a run, on the one path whose whole job is to be trustworthy.
 *
 * Dropped rather than refused, which is the opposite of this file's usual
 * direction, because the asymmetry runs the other way for once: a minted uuid
 * is ALREADY a pseudonym, so removing it from the table protects nothing and
 * loses nothing, while keeping it makes the export impossible. There is no
 * reading of the person's intent under which they wanted this.
 *
 * Reported, never silent. They wrote it down for a reason and are owed the
 * sentence saying why it was not needed.
 *
 * @param {ReadonlyArray<object>} entities
 * @param {Set<string>} minted `rewriteUuid.minted`
 * @returns {{entities: ReadonlyArray<object>, dropped: ReadonlyArray<string>}}
 */
export function stripMintedSpellings(entities, minted) {
  if (!(minted instanceof Set) || minted.size === 0) {
    return { entities, dropped: Object.freeze([]) };
  }
  const dropped = [];
  const out = [];
  for (const e of entities) {
    const kept = (e.spellings ?? []).filter((s) => !minted.has(s));
    if (kept.length === (e.spellings ?? []).length) {
      out.push(e);
      continue;
    }
    for (const s of e.spellings) if (minted.has(s)) dropped.push(`${e.kind}: ${s}`);
    // An entity left with no spellings is not kept as an empty one: it would
    // mint a pseudonym for nothing and put a row in the review that names an
    // identity nobody can act on.
    if (kept.length > 0) out.push(Object.freeze({ ...e, spellings: Object.freeze(kept) }));
  }
  return { entities: Object.freeze(out), dropped: Object.freeze(dropped) };
}

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
 * on the excluded lines, no attribution guess required.
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
 * open every `\private` directory on the machine, a line elsewhere still
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

/**
 * The same strings, each carrying which session and which record it came from.
 *
 * probeCounts accepts either shape, so the drill-down index cli-ux §5 needs is
 * built by the sweep that was already running rather than by a third pass over
 * the corpus. One `at` object per RECORD, shared by every string inside it: a
 * record holds many strings and allocating an identical tag for each of them
 * doubled the peak footprint of a stage that already holds the whole corpus.
 *
 * `turn` is the record's 1-based position among the ones this session
 * RETAINED, which is what the archive contains and therefore the only numbering
 * a reader can follow to the line. It is deliberately not the source file's
 * line number: the retention table drops most of a session, so a line number
 * would point at prose that is not in the export and often not shown anywhere.
 */
function taggedRetainedStrings(sessions) {
  const out = [];
  for (const s of sessions) {
    for (let i = 0; i < s.records.length; i += 1) {
      const at = Object.freeze({
        session: s.file.sessionId,
        workspace: s.workspace.name,
        date: new Date(s.file.mtimeMs).toISOString().slice(0, 10),
        turn: i + 1,
      });
      const strings = collectStrings(s.records[i], []);
      for (const text of strings) out.push({ text, at });
    }
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
 * Step 11's input: prose only, grouped by session. Feeding a semantic pass
 * bytes nobody authored is how it starts inventing entities.
 *
 * This list is INCLUSIVE and that is now load-bearing rather than incidental.
 * `text`, `thinking`, the two prompt records and an attachment's strings are
 * what a reader is shown, and after the tool_result cut they are also very
 * nearly everything in the archive that a reader COULD be shown. The one thing
 * in the archive that is free text and is not here is a `tool_use` parameter;
 * see docs/limits.md, which states that gap with its measurement rather than
 * leaving it to be discovered.
 *
 * Per session rather than one flat list, because the two questions the
 * candidates file now answers are per session: has this one's content changed
 * since somebody read it, and does it therefore need to be shown again.
 *
 * @returns {Array<{id: string, chunks: string[]}>}
 */
function extractProseBySession(sessions) {
  const out = [];
  for (const s of sessions) {
    const chunks = [];
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
    // mtime rides along so coverageRefusal can mark a session that is still
    // being written. The file record is already in hand, and uncoveredSessions
    // spreads the row, so it costs one property and no plumbing.
    out.push({ id: s.file.sessionId, chunks, mtimeMs: s.file.mtimeMs });
  }
  return out;
}

/**
 * Step 14.
 *
 * Entry NAMES are de-identified too, and are included in the bytes the
 * residual scan sees. The raw name would be
 * `sessions/C--Users-devuser/d1e2f3a4-...jsonl`: the slug carries the username
 * and the filename is the real session uuid. Neither is inside any JSON body,
 * so a scan over record bytes alone would report `known-entity residue: 0`
 * over a zip whose directory listing names the user, the §F1 failure, one
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
    // (`...-claude-C--Users-devuser-4f2c81ad-...-scratchpad-smoketest`). The
    // slug is fabricated; the shape is a uuid sitting mid-slug with more path
    // segments after it. No entity spelling matches that, so it reached the
    // zip's directory listing verbatim and I5 correctly reported three unknown
    // uuids. Same reuse as the record walker, so a slug and a record body
    // cannot disagree.
    //
    // The entry directory is derived from the workspace's own CWD, not from its
    // short label. `s.workspace.name` is the last path segment, and the entity
    // table only carries full cwd spellings, so the bare basename never matched
    // anything: the archive contained `./sessions/market-report/...jsonl` (a
    // fabricated stand-in; the shape is a bare basename, no drive and no
    // separators, which is why no cwd spelling matched it) while every
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

/**
 * Keep entry names portable across Windows, macOS and Linux extractors.
 *
 * The illegal-character class was here from the start; the two rules below
 * were not, and they cover exactly the names a NON-Windows uploader can
 * produce and a Windows recipient cannot receive. `~/projects/aux` is an
 * ordinary directory on macOS and Linux and impossible to create on Windows,
 * so it only ever reaches the archive from a teammate's machine.
 *
 * Measured against the extractor the recipient actually has:
 *
 *   PS> Expand-Archive probe.zip -DestinationPath out
 *   WARNING: The archive entry 'sessions/aux/s0.jsonl' contains a Windows
 *   reserved device name as one of its segments which is not supported.
 *   The entry was renamed to 'sessions\_aux\s0.jsonl'.
 *
 * Renamed for con, prn, aux, nul, com1-9 and lpt1-9 in either case, and
 * silently, with no warning at all, for a trailing dot or space: `notes.` and
 * `trail ` landed as `notes` and `trail`.
 *
 * Both break export-map.txt, which records this exact string and exists so
 * privacy-tiers level 3 can attribute an archive entry back to a session
 * (cli-ux §10). A path that no longer resolves is the one thing that file may
 * not contain. Escaping here means the recipient extracts what the map says.
 *
 * The rule stops at the bare name because that is where the measurement
 * stopped: `aux.jsonl`, `auxiliary`, `console`, `com0`, `lpt0` and `com10` all
 * extracted intact, and `aux.txt` created fine through Win32 on this build.
 *
 * ponytail: two distinct workspaces can still collide after sanitising, the
 * way `a:b` and `a_b` always could. Nothing disambiguates, because entry names
 * must be stable across runs (I10) and a collision suffix is not. Give it a
 * per-workspace hash suffix if a real collision ever shows up.
 */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeEntryName(name) {
  // Order matters, and it is the reverse of the order the rules were written
  // in. The length cap has to run BEFORE the trailing-dot strip, because
  // truncating at 120 can put a dot or a space back on the end; and the device
  // test has to run after it, because `aux.` truncated or not is still the
  // name Windows resolves to the AUX device.
  const clean = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120).replace(/[. ]+$/, '');
  if (clean === '') return 'unnamed';
  return WINDOWS_DEVICE_NAME.test(clean) ? `_${clean}` : clean;
}

/** Step 16. */
function buildManifest(retained, decisions, serialized, residue, entities, caveats = { absorbed: 0, cjk: 0 }, held = null, audienceEntities = 0, read = null) {
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
      // The largest single thing this tool withholds, and it was the one thing
      // it withheld without saying so. A reader comparing this row against
      // "denied file content" below is looking at the difference between a
      // rule that had to match and a rule that never has to.
      {
        label: 'tool output',
        suppressed: `${num(s.toolResults ?? 0)} results, ${num(s.toolResultBytesDropped ?? 0)} bytes, kept as shape only`,
      },
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
      // existed, a Taiwan passport number 13 times, 8 people's Slack ids 255
      // times, with nothing in the manifest naming either.
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
    // A subset of `embedded`, and the only subset a reader can act on. It gets
    // its own limits line because "2,278 spellings abut a letter or digit"
    // reads as an accounting note, and "your username is in the archive 14
    // times" is a decision.
    gluedOccurrences: residue.scan.gluedCount ?? 0,
    // The other half of the same finding, and the half that is silent: an
    // empty row list beside a green residue line reads as clean, and the
    // reason it is empty is the letter beside the spelling, not an absence of
    // occurrences.
    gluedNotListed: residue.scan.gluedNotListed ?? Object.freeze([]),
    // The residue line belongs beside the limits, not only in the checks
    // table: review.html and the preview print the limits block and used to
    // carry no residue figure at all.
    residueLine: residue.detail,
    // privacy-tiers 6: a corpus exported for a teammate and one exported for
    // the public are not comparable, and nothing in the contents says which.
    // Recorded even at the default, because an absent field reads as
    // "not considered" rather than as "public".
    audience: held?.audience ?? 'public',
    // Sessions are held by the floor and by nothing else.
    heldByFloor: held?.heldByFloor ?? 0,
    // What the declared audience did, which is a number that can be non-zero.
    // Its predecessor `heldByAudience` was 0 on every measured run because
    // nothing ever wrote the session decision it counted, so it reported a
    // check that had not run as a check that had passed.
    audienceEntities,
    countOnly: Object.freeze({
      sessions: decisions.filter((d) => d.tier === 'count-only').reduce((a, d) => a + d.sessionCount, 0),
      workspaces: decisions.filter((d) => d.tier === 'count-only').length,
    }),
    // The entry-gate bound. Derived from the decisions already in hand rather
    // than passed in, because these two numbers ARE the tier list counted two
    // ways and a second source for them could disagree with the tier rows.
    admitted: Object.freeze({
      workspaces: decisions.filter((d) => d.tier === 'redact' || d.tier === 'open').length,
      notAdmitted: decisions.filter((d) => d.tier !== 'redact' && d.tier !== 'open').length,
    }),
    // How much of this a human opened. Never null in a real run: an absent
    // field renders as no line at all, and a silent manifest is what shipped
    // twice.
    read,
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
 * rows, on a corpus whose export replaces 146,904 occurrences of 2,778
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
/**
 * One row per declared value: what it was, and how many occurrences it claimed.
 *
 * The count is summed over an entity's spellings rather than read off one of
 * them, because expandVariants turns a declared address with a path-shaped
 * fragment in it into several needles and a reader asked "how many" about the
 * value they typed, not about one escaping twin of it.
 *
 * A rejected entity has no spellings at all, so it appears with a count of zero
 * and carries its own reason. That is the row this function exists for: today
 * a declared value the tool refuses to substitute is announced nowhere except
 * export-map.txt, which is read after the archive already exists.
 */
function declaredValueRows(entities, counts) {
  const total = new Map();
  for (const c of counts) total.set(c.entityId, (total.get(c.entityId) ?? 0) + c.count);
  return Object.freeze(
    entities
      .filter((e) => (e.sources ?? []).includes(DECLARED_SOURCE))
      .map((e) =>
        Object.freeze({
          value: e.canonical,
          kind: e.kind,
          count: total.get(e.id) ?? 0,
          rejected: e.rejected ?? null,
          // A value the tool had already found on its own is a different fact
          // from one only the list knew about, and it is the honest answer to
          // "did writing this file change anything".
          alsoInferred: (e.sources ?? []).some((s) => s !== DECLARED_SOURCE),
        }),
      )
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1)),
  );
}

function scanEntities(corpus, env, loaded, saltDir, probe, knownValues, warnings = []) {
  const cwds = [...allCorpusCwds(loaded)];
  const seeded = seedEntities(env, corpus, { cwds, repoDirs: cwds.slice(0, 200), probeRemote: probe, texts: [], knownValues });
  // The seed warnings were dropped on the floor here, on the two commands a
  // person runs FIRST. `export` renders them; scan and review did not, so an
  // environment that could not read the OS username or the git identity said
  // nothing at all, and the gap is an ABSENCE in the entity list, which is
  // exactly the shape nobody notices. Only export gets to refuse, so here they
  // join the review problems the caller already prints.
  for (const w of seeded.warnings) warnings.push(w);
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
  // forget and leave I5 reporting its own output as an unknown uuid, which is
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
