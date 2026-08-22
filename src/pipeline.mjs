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
import { RefusalError } from './cli/errors.mjs';
import { resolveCorpus, corpusDateRange } from './corpus/root.mjs';
import { readSession, roundTripRefusal, nestingError } from './corpus/reader.mjs';
import { resolveLineCwd } from './corpus/cwdtrack.mjs';
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
import { readReview, writeReview, renderReviewHtml, REVIEW_FILENAME } from './policy/reviewfile.mjs';
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
import { newRetentionContext, retainRecord, rewriteUuidsInRecord } from './retain/records.mjs';
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

  const model = buildReviewModel(decisions, loaded, workspaceOf, [], nowStamp());
  const written = writeReview(model, path.join(outDir, REVIEW_FILENAME));

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
  const model = buildReviewModel(decisions, loaded, workspaceOf, [], nowStamp());

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
  if (flags.entity !== null) {
    report.renderNote(`--entity needs an export run to resolve occurrences; run: deident export --preview`);
    return 0;
  }
  if (flags.session !== null) {
    report.renderNote(`--session needs an export run to resolve a transcript; run: deident export --preview`);
    return 0;
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
  const retained = retainCorpus(loaded, workspaceOf, exportable, cwdTierIndex(decisions), rewriteUuid, flags);

  //  8  seed entities from PRE-substitution values (PLAN §2). Run seeding
  //     after substitution and these values are already pseudonyms: seeding
  //     becomes a no-op, the table is empty, and the tool exports the corpus
  //     while reporting a triumphant "known-entity residue: 0".
  const distinctCwds = [...new Set(retained.cwds)];
  const seeded = seedEntities(env, corpus, {
    cwds: distinctCwds,
    repoDirs: distinctCwds.slice(0, 200),
    texts: collectRetainedStrings(retained.records),
  });

  //  9  pseudonyms
  const tier0 = assignPseudonyms(seeded.entities, salt, flags.namespace);
  const tier0Table = buildTable(tier0.entities);

  // 10  tier-0 substitution -> `cleaned`
  const cleaned = substituteAll(retained.records, tier0Table);

  // 11  tier-1 discovery reads the OUTPUT of step 10, never the raw records
  const candidatesPath = path.join(outDir, CANDIDATES_FILENAME);
  const proseChunks = extractProse(cleaned.records);
  const candidates = writeCandidates(proseChunks, candidatesPath);

  const tier1 = flags.entities === null ? null : readEntities(flags.entities);
  const semantic = checkSemanticPass(tier1);
  if (!semantic.ok) {
    report.renderCandidates(candidates.path, candidates.chars);
    throw semanticRefusal(candidates.path);
  }

  // 12  tier-1 substitution targets the SAME cleaned object, with a pseudonym
  //     guard so a semantic pass returning "PERSON" cannot destroy tier 0.
  const tier1Assigned = assignPseudonyms(tier1.entities, salt, flags.namespace);
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
  const mergedTable = buildTable([...tier0.entities, ...tier1Assigned.entities]);
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
  if (!semantic.ok) throw semanticRefusal(candidates.path);

  // 16  manifest
  const manifest = buildManifest(retained, decisions, serialized, residue.scan.embedded);
  report.renderManifest(manifest);

  const entities = withOccurrences([...tier0.entities, ...tier1Assigned.entities], allStrings);

  // 17  the only step that writes an output artifact
  if (flags.preview) {
    const written = writePreview(
      {
        generated: nowStamp(),
        strings: allStrings,
        entities,
        manifest,
        checks: toReportRows(checks),
      },
      path.join(outDir, `deident-preview-${today()}.diff`),
    );
    report.renderWrote(written.path, written.bytes, path.join(saltDir, 'salt'));
    saveDecisions(saltDir, decisions);
    return 0;
  }

  const zipPath = path.join(outDir, `deident-export-${today()}.zip`);
  try {
    const written = writeZip(serialized.entries, zipPath);
    report.renderWrote(written.path, written.bytes, path.join(saltDir, 'salt'));
  } catch (err) {
    safeUnlink(zipPath);
    throw err;
  }
  saveDecisions(saltDir, decisions);
  return 0;
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
function retainCorpus(loaded, workspaceOf, exportable, cwdTiers, rewriteUuid, flags) {
  const out = [];
  const cwds = [];
  const stats = {
    kept: 0,
    dropped: 0,
    droppedByCwd: 0,
    userMessages: 0,
    assistantMessages: 0,
    images: 0,
    documents: 0,
    codeLinesCounted: 0,
    codeParamsDropped: 0,
    toolResultBytesOmitted: 0,
    dedupedPrompts: 0,
    sessions: 0,
    workspaces: new Set(),
  };

  for (const { file, cwds: lineCwds } of loaded.sessions) {
    const workspace = workspaceOf.get(file.path);
    if (workspace === undefined || !exportable.has(workspace.key)) continue;
    // Re-read rather than hold: the survey pass released this file's records
    // precisely so the whole corpus is never resident at once.
    const session = readSession(file.path, { skipUnreadable: flags.skipUnreadable, keepRaw: false });
    const ctx = newRetentionContext(rewriteUuid);
    const records = [];

    for (let i = 0; i < session.records.length; i += 1) {
      const verdict = allowLine(lineCwds[i], { cwdTiers });
      if (!verdict.allow) {
        stats.droppedByCwd += 1;
        continue;
      }
      const at = { file: file.path, line: session.records[i].index };
      let result;
      try {
        result = retainRecord(session.records[i].value, ctx, at);
      } catch (err) {
        // Every walker here is recursive. Pathological nesting is a property of
        // the input, so it is a read error naming the line (exit 3), never
        // "a bug in deident" (exit 1).
        if (err instanceof RangeError) throw nestingError(at.file, at.line, err);
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
    }
  }

  return Object.freeze({
    records: Object.freeze(out),
    cwds: Object.freeze(cwds),
    stats,
  });
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
    const dir = rewriteUuidsInRecord(substituteString(s.workspace.name, table).out, rewriteUuid);
    const id = rewriteUuid(s.file.sessionId) ?? s.file.sessionId;
    const name = `sessions/${sanitizeEntryName(dir)}/${sanitizeEntryName(id)}.jsonl`;
    entries.push({ name, data: body });
    parts.push(body, name, '\n');
  }
  return Object.freeze({ entries, allBytes: parts.join('') });
}

/** Keep entry names portable across Windows, macOS and Linux extractors. */
function sanitizeEntryName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'unnamed';
}

/** Step 16. */
function buildManifest(retained, decisions, serialized, embedded) {
  const s = retained.stats;
  return Object.freeze({
    sessions: s.sessions,
    workspaces: s.workspaces.size,
    userMessages: s.userMessages,
    zeros: Object.freeze([
      { label: 'lines of code', suppressed: `${s.codeLinesCounted.toLocaleString('en-US')} counted, none included` },
      { label: 'images', suppressed: `${s.images.toLocaleString('en-US')} replaced with placeholders` },
      { label: 'code parameters', suppressed: `${s.codeParamsDropped.toLocaleString('en-US')} replaced with counts` },
      { label: 'dropped by cwd', suppressed: `${s.droppedByCwd.toLocaleString('en-US')} lines outside an included directory` },
      { label: 'documents', suppressed: `${s.documents.toLocaleString('en-US')} pasted documents replaced` },
    ]),
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
    for (const p of g.sessionPaths) workspaceOf.set(p, Object.freeze({ key: g.key, name: d.name }));
  }
  return { decisions, workspaceOf };
}

function buildReviewModel(decisions, loaded, workspaceOf, entities, generated) {
  const flagged = [];
  for (const { file, cwds } of loaded.sessions) {
    const token = touchedDenied(cwds);
    if (token !== null) {
      flagged.push({
        date: new Date(file.mtimeMs).toISOString().slice(0, 10),
        workspace: workspaceOf.get(file.path)?.name ?? '<no-cwd>',
        reason: `a directory containing "${token}"`,
      });
    }
  }
  return Object.freeze({
    generated,
    workspaces: decisions,
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
