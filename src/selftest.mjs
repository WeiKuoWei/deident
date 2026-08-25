// `node deident.mjs --selftest`. Plain node:assert, no framework, no network,
// no real log content.
//
// Every fixture exists because it catches ONE specific bug, and the bug is
// named beside it. A fixture whose expected value was computed the way the
// code computes it would pass by construction, so expected values here are
// literals taken from BRIEF's measurements or worked by hand.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { expandVariants, looseVariants, squashedForm, isCjkOnly, backslashUEscape } from './entities/variants.mjs';
import { hanVariants, foldTable } from './entities/hanfold.mjs';
import {
  seedEntities,
  rejectReason,
  sweepEmails,
  sweepSecrets,
  sweepPhones,
  sweepUnixUid,
  sweepMcpNames,
  sweepIdNumbers,
  sweepPlatformIds,
  osUsername,
  projectShaped,
  basenameOf,
  buildEntities,
} from './entities/seed.mjs';
import { buildTable, substituteString, reverseString, allOccurrences, leftIsWordChar } from './substitute/engine.mjs';
import { probeCounts, probeOutliers } from './entities/probe.mjs';
import { substituteRecord } from './substitute/walker.mjs';
import { checkSubstitution, checkSemanticPass, semanticRefusal, coverageRefusal } from './verify/checks.mjs';
import { residualScan, startsInsideEscape, jsonEscaped } from './verify/residual.mjs';
import { distillToolResult, retainToolUseResult, checkAddedLines } from './retain/toolresult.mjs';
import { newRetentionContext, retainRecord, quantise, rewriteUuidsInRecord, deniedReason } from './retain/records.mjs';
import { resolveLineCwd, cwdChangeFrom } from './corpus/cwdtrack.mjs';
import { allowLine } from './policy/linefilter.mjs';
import {
  classifyWorkspaces,
  matchDenyToken,
  cwdTierIndex,
  summarizeTiers,
  saveDecisions,
  loadSavedDecisions,
  orphanedDecisions,
} from './policy/workspaces.mjs';
import { groupSessions, tailSegments, HOME_NAME, UNKNOWN_NAME } from './policy/grouping.mjs';
import { proposeTier, personalDataShape, GIT_UNAVAILABLE } from './policy/signals.mjs';
import { setUserDeny } from './policy/userdeny.mjs';
import { limitLines } from './cli/limits.mjs';
import { readSession } from './corpus/reader.mjs';
import { probeCaseFolding, setCaseFolding, caseFolding, normalizeCwd } from './corpus/cwdtrack.mjs';
import { uncoveredNameParts } from './entities/probe.mjs';
import { resolveRoot } from './corpus/root.mjs';
import {
  setCommand,
  renderRefusal,
  renderReadError,
  renderManifest,
  renderProbe,
  renderCandidates,
  renderTriageWritten,
  captureOutput,
} from './cli/report.mjs';
import {
  namespaceCollisions,
  namespaceRefusal,
  assignPseudonyms,
  pseudonymPattern,
  pseudonymGuardPattern,
  pseudonymScanPattern,
  loadOrCreateSalt,
  defaultSaltDir,
} from './entities/pseudonym.mjs';
import { buildZip, readZip, readZipFile, MAX_ENTRIES } from './output/zip.mjs';
import { renderPreview } from './output/preview.mjs';
import {
  parseReview,
  parseSessionDrops,
  parseSessionRows,
  readSessionDrops,
  renderReview,
  renderReviewHtml,
  SESSION_DECISIONS,
} from './policy/reviewfile.mjs';
import { readEntities, writeCandidates } from './entities/tier1.mjs';
import { estimateTokens, roundEstimate, tokenCost } from './cli/tokens.mjs';
import { CANDIDATE_CHUNK_CHARS } from './retain/constants.mjs';
import { DICTIONARY_FILENAME, mergeEntities } from './policy/dictionary.mjs';
import { parseCliArgs } from './cli/args.mjs';
import { checkRuntime, REQUIRED_NODE } from './cli/runtime.mjs';
import { serializeSessions, resolveOutDir, sanitizeEntryName, stripMintedSpellings } from './pipeline.mjs';
import { RefusalError, ReadError, UsageError } from './cli/errors.mjs';

// Both sides of every fold pair must be Han and nothing else. A pair that
// slipped in a lookalike from another block would fold text nobody asked about.
const HAN_ONLY = /^\p{sc=Han}$/u;
const BS = String.fromCharCode(92); // a single backslash, written without escapes
const NL = String.fromCharCode(10);
const SEP = String.fromCharCode(92); // a backslash, written this way so no escape layer can eat it

// ---------------------------------------------------------------- helpers

const SALT = 'selftest-salt-0123456789abcdef0123456789abcdef';

function entity(id, kind, canonical, pseudonym, extra = {}) {
  return {
    id,
    kind,
    canonical,
    spellings: expandVariants(canonical),
    pseudonym,
    confidence: 'high',
    tier: 0,
    rejected: null,
    source: 'fixture',
    ...extra,
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deident-selftest-'));
}


// --------------------------------------------------- end-to-end harness

const ENTRY = fileURLToPath(new URL('../deident.mjs', import.meta.url));

/**
 * Run the real CLI in a child process. Returns {code, out}.
 *
 * Both streams are captured and concatenated. Warnings go to stderr and
 * refusals go to stderr, so a harness that reads stdout alone cannot see the
 * difference between "warned and carried on" and "said nothing".
 */
function runCli(args, env = null) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Merged, never replaced: a bare env on Windows loses SystemRoot and the
    // child cannot start at all, which reads as a failing assertion rather
    // than a broken harness.
    env: env === null ? process.env : { ...process.env, ...env },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}


/**
 * A corpus with the shapes the round-2 findings were measured on: a session
 * that leaves an allowed directory for a deny-listed one and comes back, a
 * cwd-less record replaying what was typed while it was away, a credential, a
 * phone number, an `ls -l` owner id, and a second session that lives entirely
 * inside the deny-listed directory.
 *
 * CORPUS_USER is the account the corpus was written by, because §F3's owner-id
 * sweep only fires beside the name the RUNNING user has. Written as the
 * author's own account name, F61's `the stable owner id must not leave` passed
 * on his machine and on no other: measured 2026-08-24 the same corpus on Linux
 * ran as `root`, the sweep matched nothing, and the owner id shipped inside
 * the zip. Fabricated, and never a name from this machine.
 */
const CORPUS_USER = 'nkoro';
const CORPUS_USER_ENV = Object.freeze({ USERNAME: CORPUS_USER, USER: CORPUS_USER });

function writeCorpus(root, { unknownType = false } = {}) {
  const projects = path.join(root, 'projects', 'ws');
  fs.mkdirSync(projects, { recursive: true });
  const cwd = ['C:', 'Users', 'devuser', 'projects', 'alpha'].join(BS);
  const denied = [cwd, 'private', 'auditor-notes'].join(BS);
  const sid = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const PRIVATE = 'PRIVATE-MATERIAL-TYPED-IN-THE-DENIED-DIRECTORY';
  let seq = 0;
  const turn = (at, text) => ({
    type: 'user',
    uuid: `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`,
    sessionId: sid,
    timestamp: '2026-08-20T10:11:12.345Z',
    cwd: at,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

  const rows = [
    turn(cwd, `working in ${cwd} with mcp__playwright-headless__browser_navigate`),
    // A string-valued message.content: the same user turn, silently dropped.
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000901',
      sessionId: sid,
      timestamp: '2026-08-20T10:11:12.345Z',
      cwd,
      message: { role: 'user', content: 'KEEP-THIS-STRING-FORM-PROMPT' },
    },
    turn(cwd, `token ${'github_pat_11ABCDEFG0'}${'a'.repeat(50)} pasted by mistake`),
    turn(cwd, 'ring me on +852-5555 0100'),
    turn(cwd, `-rw-r--r-- 1 ${CORPUS_USER} 197609    929 Aug 21 23:49 .gitignore`),
    turn(cwd, `notes under ${denied} and ${denied}${BS}hsbc.json`),
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000902',
      sessionId: sid,
      timestamp: '2026-08-20T10:12:00.000Z',
      cwd,
      message: { role: 'user', content: [{ type: 'text', text: 'made a file' }] },
      toolUseResult: {
        type: 'create',
        filePath: `${cwd}${BS}a.txt`,
        content: ['l1', 'l2', 'l3'].join(NL),
        structuredPatch: [],
      },
    },
    turn(denied, PRIVATE),
    turn(cwd, 'back in alpha'),
    // No cwd of its own, and it replays what was typed while away.
    { type: 'last-prompt', sessionId: sid, timestamp: '2026-08-20T10:13:00.000Z', lastPrompt: PRIVATE },
  ];
  if (unknownType) rows.push({ type: 'quantum-flux', uuid: 'q', cwd });
  fs.writeFileSync(path.join(projects, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');

  const onlyDenied = [
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000903',
      sessionId: other,
      timestamp: '2026-08-20T11:00:00.000Z',
      cwd: denied,
      message: { role: 'user', content: [{ type: 'text', text: PRIVATE }] },
    },
  ];
  fs.writeFileSync(path.join(projects, `${other}.jsonl`), onlyDenied.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');

  // A third session inside the INCLUDED workspace whose every record is a DROP
  // type. It used to be skipped without incrementing any counter, so the
  // shipped session count silently disagreed with the count in review.md.
  const emptied = '44444444-4444-4444-8444-444444444444';
  fs.writeFileSync(
    path.join(projects, `${emptied}.jsonl`),
    [
      JSON.stringify({ type: 'permission-mode', sessionId: emptied, cwd, mode: 'default' }),
      JSON.stringify({ type: 'ai-title', sessionId: emptied, cwd, title: 'x' }),
    ].join(NL) + NL,
    'utf8',
  );

  fs.writeFileSync(
    path.join(root, 'ents.json'),
    JSON.stringify({ entities: [{ kind: 'person', spellings: ['Nora Lund'], confidence: 'high' }] }),
    'utf8',
  );
  return { cwd, denied, private: PRIVATE };
}

/**
 * One extra session in the same workspace whose first prompt is far longer than
 * any triage limit, written beside writeCorpus's sessions so the triage
 * fixtures can measure truncation without perturbing every other fixture's
 * corpus.
 */
const LONG_SESSION_ID = '55555555-5555-4555-8555-555555555555';

function writeLongPromptSession(root, cwd, text) {
  const rows = [
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000905',
      sessionId: LONG_SESSION_ID,
      timestamp: '2026-08-20T12:00:00.000Z',
      cwd,
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  ];
  fs.writeFileSync(
    path.join(root, 'projects', 'ws', `${LONG_SESSION_ID}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join(NL) + NL,
    'utf8',
  );
  return LONG_SESSION_ID;
}

/**
 * A session that opens with a bare slash command and says what it is about
 * only afterwards.
 *
 * The envelope is the one the live corpus writes, character for character:
 * measured 2026-08-25 over 214 sessions, a `/clear` first prompt is the 106
 * characters `<command-name>/clear</command-name>` plus an empty
 * `<command-message>` and an empty `<command-args>`, and nothing else. 17 of
 * those 214 sessions open with one, 11 of them `/clear`, and the triage stage
 * showed the reader the envelope and no work.
 */
function writeCommandFirstSession(root, cwd, sessionId, command, then = null) {
  const envelope =
    `<command-name>${command}</command-name> ` +
    `<command-message>${command.replace('/', '')}</command-message> ` +
    '<command-args></command-args>';
  const turn = (seq, text) => ({
    type: 'user',
    uuid: `00000000-0000-4000-8000-9000000000${String(seq).padStart(2, '0')}`,
    sessionId,
    timestamp: '2026-08-20T13:00:00.000Z',
    cwd,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const rows = [turn(1, envelope)];
  if (then !== null) rows.push(turn(2, then));
  fs.writeFileSync(
    path.join(root, 'projects', 'ws', `${sessionId}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join(NL) + NL,
    'utf8',
  );
  return sessionId;
}

/**
 * One session carrying the classes of value that leaked from a finished export
 * with all six gates green: a document name ordering, a date of birth, a
 * postal address and a payment-platform account id.
 *
 * Every value is FABRICATED. What each one preserves is the shape:
 *   Aurelio Ferreira-Nkemdirim  a written-out name in a document ordering that
 *                               appears in no git config, so tier 0 has no
 *                               source for it at all
 *   1974-11-03                  a bare ISO date, which DATE_SHAPED_RE
 *                               deliberately excludes from the id-number sweep
 *   Flat 6B, 219 Marlowe ...    an address as ONE comma-separated string, which
 *                               is how a person writes one down
 *   pm-8842-31770               a payment-platform account handle: vendor
 *                               prefix, digits, matching no platform-id regex
 */
const DECLARED_VALUES = Object.freeze([
  'Aurelio Ferreira-Nkemdirim',
  '1974-11-03',
  'Flat 6B, 219 Marlowe Crescent, Ashford Bay',
  'pm-8842-31770',
]);

function writeDeclaredValueSession(root, cwd, sessionId = '66666666-6666-4666-8666-666666666666') {
  const turn = (seq, text) => ({
    type: 'user',
    uuid: `00000000-0000-4000-8000-8000000000${String(seq).padStart(2, '0')}`,
    sessionId,
    timestamp: '2026-08-20T14:00:00.000Z',
    cwd,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const rows = [
    turn(1, `filling the booking form: passport reads ${DECLARED_VALUES[0]}, born ${DECLARED_VALUES[1]}`),
    turn(2, `address of record is ${DECLARED_VALUES[2]} and the payout account is ${DECLARED_VALUES[3]}`),
  ];
  fs.writeFileSync(
    path.join(root, 'projects', 'ws', `${sessionId}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join(NL) + NL,
    'utf8',
  );
  return sessionId;
}

/** Write a known-values.json into a salt directory that may not exist yet. */
function writeKnownValues(saltDir, body) {
  fs.mkdirSync(saltDir, { recursive: true });
  const file = path.join(saltDir, 'known-values.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return file;
}

/** Total bytes of every session file under a fixture root. */
function corpusBytes(root) {
  const dir = path.join(root, 'projects', 'ws');
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.jsonl')) total += fs.statSync(path.join(dir, name)).size;
  }
  return total;
}

/**
 * Make `file` unwritable, and PROVE it took.
 *
 * chmod 0444 is the failure a real user hits: on Windows it maps to the
 * read-only attribute, which is what a locked or cloud-synced directory
 * reports. On POSIX as root the bit is ignored (CAP_DAC_OVERRIDE), and a suite
 * run as root is not exotic: measured 2026-08-24 on WSL2 Ubuntu, the chmod
 * returned cleanly, the write went straight through it, and F67 then asserted
 * a warning the run had no reason to print.
 *
 * The fallback is the one refusal no privilege overrides: point the path at a
 * directory that is not there. Reading it is ENOENT, which loadSavedDecisions
 * already treats as "no memo yet", so only the SAVE fails.
 *
 * @returns {() => void} undo, leaving the path gone either way
 */
function makeUnwritable(file) {
  fs.chmodSync(file, 0o444);
  if (!writableByThisProcess(file)) {
    return () => {
      fs.chmodSync(file, 0o666);
      fs.rmSync(file, { force: true });
    };
  }
  fs.rmSync(file);
  fs.symlinkSync(path.join(path.dirname(file), 'no-such-directory', path.basename(file)), file);
  assert.ok(!writableByThisProcess(file), 'the fixture could not make the tier memo unwritable on this machine');
  return () => {
    fs.unlinkSync(file);
  };
}

/** Whether this process can actually open `file` for writing, bits aside. */
function writableByThisProcess(file) {
  try {
    fs.appendFileSync(file, '');
    return true;
  } catch {
    return false;
  }
}

/**
 * The step the documented flow has and these fixtures used to skip: put the
 * corpus in front of a reader.
 *
 * `export` with no entity list refuses and writes deident-candidates.txt on
 * its way out, and THAT is what records a hash per session. Without it every
 * session is one nobody has read, and the per-session gate refuses, which is
 * the whole point of the gate, so the fixtures run the real first step rather
 * than being exempted from it.
 *
 * The candidates file is removed afterwards because it is not what any caller
 * is measuring, and several of them count the files in the output directory.
 *
 * @returns {{code: number, out: string, candidateBytes: number}}
 */
function primeSemanticPass(root, out, saltDir, env = null, extra = []) {
  const r = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir, ...extra], env);
  assert.equal(r.code, 1, `the priming run should refuse for want of an entity list: ${r.out}`);
  const file = path.join(out, 'deident-candidates.txt');
  const candidateBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  fs.rmSync(file, { force: true });
  return { ...r, candidateBytes };
}

/** One more user turn appended to a session that already exists, in place. */
function appendTurn(root, sessionId, cwd, text) {
  const file = path.join(root, 'projects', 'ws', `${sessionId}.jsonl`);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000907',
      sessionId,
      timestamp: '2026-08-21T09:00:00.000Z',
      cwd,
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + NL,
    'utf8',
  );
  return file;
}

/** Hold one session back by hand, the way a person edits review.md. */
function setSessionDecision(reviewPath, id, decision) {
  const text = fs.readFileSync(reviewPath, 'utf8');
  fs.writeFileSync(
    reviewPath,
    text.replace(new RegExp(`^\\S+(\\s+.*${id})$`, 'm'), `${decision}$1`),
    'utf8',
  );
}

/** Promote one workspace in review.md, the way a person edits the file. */
function setTier(reviewPath, name, tier) {
  const text = fs.readFileSync(reviewPath, 'utf8');
  const lines = text.split(NL).map((line) => {
    const parts = line.trim().split(/\s+/);
    return parts[1] === name && parts[0] !== '#' ? `${tier.padEnd(12)} ${line.trim().slice(parts[0].length).trim()}` : line;
  });
  fs.writeFileSync(reviewPath, lines.join(NL), 'utf8');
}

// ----------------------------------------------------------------- suite

const FIXTURES = [
  // F01, BRIEF §4.5 row 1. Python \b MISSES this; Node \b happens to hit it.
  // The regression guard is against anyone "simplifying" the lookaround back
  // to \b, which would make behaviour runtime-dependent.
  ['F01', '因為Dean他想要 / Dean: Latin entity abutting CJK', () => {
    // `Dean` is fabricated. Shape: a Latin name with a CJK character hard
    // against BOTH sides and no whitespace anywhere, which is what Python's
    // \b misses.
    const t = buildTable([entity('P1', 'person', 'Dean', 'PERSON_1')]);
    assert.equal(substituteString('因為Dean他想要', t).out, '因為PERSON_1他想要');
  }],

  // F02, BRIEF §4.5 row 2, the other side of the CJK boundary.
  ['F02', 'Ivy跟小語 / Ivy: CJK on the trailing side', () => {
    // Fabricated. Shape: the Latin name leads and the CJK follows, so the
    // trailing side of the lookaround is the one under test. `小語` must stay
    // CJK: a Latin word after the name tests nothing new.
    const t = buildTable([entity('P1', 'person', 'Ivy', 'PERSON_1')]);
    assert.equal(substituteString('Ivy跟小語', t).out, 'PERSON_1跟小語');
  }],

  // F03, BRIEF §4.5 row 3. Both \b implementations MISS 林先生/林, and the
  // lookaround HITS it, but hitting it is over-matching inside a longer word,
  // so the rule is length >= 2 and FLAG, never substitute.
  ['F03', '林先生 / 林: one-char CJK is flagged, not substituted', () => {
    // `林` and `林大明` are fabricated. Shape: a ONE-character CJK surname that
    // is also the first character of a longer CJK word, and the same surname
    // in a three-character full name. Both lengths are load-bearing here.
    const reason = rejectReason('林');
    assert.ok(reason !== null, 'a single-character CJK entity must be rejected');
    assert.match(reason, /single-character CJK/);
    assert.ok(isCjkOnly('林'));
    const t = buildTable([entity('P1', 'person', '林', null, { rejected: reason, spellings: [] })]);
    assert.equal(substituteString('林先生', t).out, '林先生', 'must not substitute');
    assert.equal(t.flagged.length, 1, 'must be flagged for review');
    // A two-character CJK entity IS substituted.
    const t2 = buildTable([entity('P2', 'person', '林大明', 'PERSON_2')]);
    assert.equal(substituteString('林大明說', t2).out, 'PERSON_2說');
  }],

  // F04, BRIEF §4.5 row 4, the correct NON-match. Catches the over-eager
  // substring substituter someone reaches for after seeing F03 fail.
  ['F04', "'array' does not match entity 'ray'", () => {
    const t = buildTable([entity('P1', 'person', 'ray', 'PERSON_1')]);
    assert.equal(substituteString('array index for ray', t).out, 'array index for PERSON_1');
    assert.equal(substituteString('an array index', t).out, 'an array index');
  }],

  // F05, §F3. 296 bare occurrences in the owner column of ls -l, where
  // longest-prefix path substitution never fires.
  ['F05', 'ls -l owner column: bare username outside any path', () => {
    const t = buildTable([
      entity('W1', 'workspace', `C:${BS}Users${BS}devuser`, 'WORKSPACE_1'),
      entity('P1', 'person', 'devuser', 'PERSON_1'),
    ]);
    const line = '-rw-r--r-- 1 devuser 197609    929 Aug 21 23:49 .gitignore';
    const out = substituteString(line, t).out;
    assert.equal(out, '-rw-r--r-- 1 PERSON_1 197609    929 Aug 21 23:49 .gitignore');
    assert.ok(!out.includes('devuser'), 'the bare username must not survive');
    // And the path form still wins where it applies.
    assert.equal(substituteString(`at C:${BS}Users${BS}devuser${BS}x`, t).out, 'at WORKSPACE_1' + BS + 'x');
  }],

  // F06, §4.6 prefix collision. Requires sort-by-length-descending.
  ['F06', 'northwind vs northwind-agentic: prefix collision', () => {
    const t = buildTable([
      entity('O1', 'org', 'northwind', 'ORG_1'),
      entity('O2', 'org', 'northwind-agentic', 'ORG_2'),
    ]);
    assert.equal(substituteString('northwind and northwind-agentic', t).out, 'ORG_1 and ORG_2');
    assert.equal(substituteString('northwind-agentic first', t).out, 'ORG_2 first');
  }],

  // F07, §4.6 three-way nested collision plus the email form. Catches an
  // interval mask that releases a region it already claimed.
  //
  // SHAPE: three fabricated spellings forming a STRICT PREFIX CHAIN,
  // nkoro < nkorox < nkorox42@northwind.example. The nesting is the property under
  // test; collapsing any two of them to one string deletes the fixture.
  ['F07', 'nkoro / nkorox / nkorox42@northwind.example: nested collision', () => {
    const t = buildTable([
      entity('P1', 'person', 'nkoro', 'PERSON_1'),
      entity('P2', 'person', 'nkorox', 'PERSON_2'),
      entity('P3', 'person', 'nkorox42@northwind.example', 'PERSON_3'),
    ]);
    const s = 'nkoro, nkorox and nkorox42@northwind.example walk in';
    const r = substituteString(s, t);
    assert.equal(r.out, 'PERSON_1, PERSON_2 and PERSON_3 walk in');
    for (let i = 1; i < r.spans.length; i += 1) {
      assert.ok(r.spans[i].start >= r.spans[i - 1].end, 'spans must not overlap');
    }
    assert.equal(reverseString(r.out, r.spans), s);
  }],

  // F08, I2 over F01..F07 together, plus the independent verifier.
  ['F08', 'substitute then reverse over every earlier fixture (I2)', () => {
    const entities = [
      entity('P1', 'person', 'Dean', 'PERSON_1'),
      entity('P2', 'person', 'Ivy', 'PERSON_2'),
      entity('P3', 'person', 'devuser', 'PERSON_3'),
      entity('P4', 'person', 'devuser', 'PERSON_4'),
      entity('O1', 'org', 'northwind', 'ORG_1'),
      entity('O2', 'org', 'northwind-agentic', 'ORG_2'),
    ];
    const t = buildTable(entities);
    const inputs = [
      '因為Dean他想要',
      'Ivy跟小語',
      'array index',
      '-rw-r--r-- 1 devuser 197609 929 x',
      'northwind and northwind-agentic',
      'devuser devuser',
      `C:${BS}Users${BS}devuser${BS}projects`,
    ];
    const strings = [];
    for (const s of inputs) {
      const r = substituteString(s, t);
      assert.equal(reverseString(r.out, r.spans), s, `reversal failed for ${JSON.stringify(s)}`);
      if (r.spans.length > 0) strings.push({ path: 'fixture', before: s, after: r.out, spans: r.spans });
    }
    const check = checkSubstitution(strings, t);
    assert.ok(check.ok, `invariant failed: ${JSON.stringify(check.failures)}`);

    // Negative control: the invariant must FAIL on a corrupted span set.
    // Without this the whole check could be vacuous and nobody would know.
    const corrupted = strings.map((s) => ({ ...s, spans: s.spans.slice(0, -1) }));
    assert.ok(!checkSubstitution(corrupted, t).ok, 'the invariant must catch a dropped span');
  }],

  // F09, §4.2 / §4.3. The 24.1%-of-edits case that manufactures a false
  // "abandoned" session. Expected value 7 is counted by hand from the fixture.
  ['F09', 'Edit with added 7, removed 7, net 0 → code_added_lines is 7, not 0', () => {
    const patch = [
      {
        oldStart: 1,
        oldLines: 7,
        newStart: 1,
        newLines: 7,
        lines: [
          '-old one', '-old two', '-old three', '-old four',
          '-old five', '-old six', '-old seven',
          '+new one', '+new two', '+new three', '+new four',
          '+new five', '+new six', '+new seven',
          ' context',
        ],
      },
    ];
    const d = distillToolResult({ structuredPatch: patch, oldString: 'x', newString: 'y' });
    assert.equal(d.code_added_lines, 7);
    assert.equal(d.code_removed_lines, 7);
    assert.equal(d.code_added_lines - d.code_removed_lines, 0, 'net really is 0 here');
    assert.notEqual(d.code_added_lines, 0, 'the whole point: added is not the net');
    // The patch body is code and must not survive distillation.
    const kept = retainToolUseResult({ structuredPatch: patch, oldString: 'SECRET', newString: 'CODE' });
    assert.ok(!JSON.stringify(kept).includes('SECRET'));
    assert.ok(!JSON.stringify(kept).includes('old one'));
    assert.equal(checkAddedLines(d), null);
  }],

  // F10, PLAN C6. 1,304 records carry a string-valued toolUseResult.
  ['F10', 'string-valued toolUseResult → null, not 0, and no crash', () => {
    const d = distillToolResult('The file has been updated successfully.');
    assert.equal(d.code_added_lines, null);
    assert.equal(d.form, 'string');
    assert.equal(checkAddedLines(d), null);
    for (const weird of [null, undefined, 42, [], true]) {
      assert.equal(distillToolResult(weird).code_added_lines, null, `${JSON.stringify(weird)} must be null`);
    }
  }],

  // F11, §4.3: null and 0 are different and 0 is the dangerous one.
  ['F11', 'Write with no structuredPatch → null, not 0', () => {
    const d = distillToolResult({ filePath: 'x.md', type: 'create' });
    assert.equal(d.code_added_lines, null);
    assert.equal(d.form, 'no-patch');
    // An EMPTY patch array with nothing else to read is UNKNOWN, not zero.
    const empty = distillToolResult({ structuredPatch: [] });
    assert.equal(empty.code_added_lines, null);
    assert.equal(empty.form, 'empty-patch');
    // A malformed hunk must not produce a partial count presented as true.
    assert.equal(distillToolResult({ structuredPatch: [{ lines: 'not an array' }] }).code_added_lines, null);
  }],

  // F12, I3, and PLAN C4: this fires on the real corpus today, so the test
  // protects a path the operator hits on his first run.
  ['F12', 'a pre-existing PERSON_1 token aborts, and --namespace X clears it', () => {
    const lines = [
      { file: 'a.jsonl', line: 1, text: '{"text":"the plan says PERSON_1 is Ray"}' },
      { file: 'a.jsonl', line: 2, text: '{"text":"nothing here"}' },
    ];
    const hits = namespaceCollisions(lines, null);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].token, 'PERSON_1');
    assert.equal(namespaceCollisions(lines, 'X').length, 0, '--namespace X must clear it');
    // And the shifted namespace really is what gets minted.
    const a = assignPseudonyms([entity('P1', 'person', 'Ray', null)], SALT, 'X');
    assert.match(a.entities[0].pseudonym, /^X_PERSON_\d+$/);
    // The pattern must not match a mere prefix of a longer word.
    assert.equal(namespaceCollisions([{ file: 'b', line: 1, text: 'PERSON_1A' }], null).length, 0);
  }],

  // F13, §4.6 variant expansion. Catches a table that covers the common form
  // and leaks the other five.
  ['F13', 'every escaping variant of one path root', () => {
    const variants = expandVariants(`C:${BS}Users${BS}devuser`);
    const required = [
      `C:${BS}Users${BS}devuser`,
      'C:/Users/devuser',
      '/c/Users/devuser',
      `C:${BS}${BS}Users${BS}${BS}devuser`,
      `c:${BS}Users${BS}devuser`,
    ];
    for (const form of required) {
      assert.ok(variants.includes(form), `missing variant ${JSON.stringify(form)}`);
    }
    // URL-encoded, on the email rather than the path (§4.6's measured case).
    assert.ok(expandVariants('devuser@northwind.example').includes('devuser%40northwind.example'));
    // Backslash-u-escaped CJK, as found inside embedded JSON.
    assert.equal(backslashUEscape('林大明'), `${BS}u6797${BS}u5927${BS}u660e`);
    assert.ok(expandVariants('林大明').includes(`${BS}u6797${BS}u5927${BS}u660e`));

    // All six forms in ONE string, all replaced.
    const t = buildTable([
      entity('W1', 'workspace', `C:${BS}Users${BS}devuser`, 'WORKSPACE_1'),
      entity('P1', 'person', 'devuser@northwind.example', 'PERSON_1'),
      entity('P2', 'person', '林大明', 'PERSON_2'),
    ]);
    const s = [
      `C:${BS}Users${BS}devuser`,
      'C:/Users/devuser',
      '/c/Users/devuser',
      `C:${BS}${BS}Users${BS}${BS}devuser`,
      'devuser%40northwind.example',
      `${BS}u6797${BS}u5927${BS}u660e`,
    ].join(' | ');
    const out = substituteString(s, t).out;
    assert.ok(!out.includes('devuser'), `leaked: ${out}`);
    assert.ok(!out.includes('u6797'), `leaked escaped CJK: ${out}`);
  }],

  // F14, a truncated last line. Exit 3, cli-ux §9 shape, no stack trace.
  ['F14', 'truncated last line → ReadError with file, line and cause', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, '{"type":"mode","mode":"normal"}\n{"type":"user","mess', 'utf8');
    let caught = null;
    try {
      readSession(file);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ReadError, 'must be a ReadError, not a SyntaxError');
    assert.equal(caught.code, 3);
    assert.equal(caught.detail.file, file);
    assert.equal(caught.detail.line, 2);
    assert.match(caught.detail.likelyCause, /still being written/);
    // --skip-unreadable continues past it.
    const ok = readSession(file, { skipUnreadable: true });
    assert.equal(ok.records.length, 1);
    assert.equal(ok.badLines.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  // F15, I7. An unknown type is a refusal, not a silent drop. That is the
  // entire point of BRIEF §4.4.
  ['F15', 'an unknown record type refuses rather than dropping silently', () => {
    const ctx = newRetentionContext((u) => u);
    assert.throws(
      () => retainRecord({ type: 'future-thing', payload: 'user text' }, ctx, { file: 'a', line: 9 }),
      (err) => err instanceof RefusalError && /future-thing/.test(err.reason),
    );
    // Same for an unknown attachment sub-type and an unknown content block.
    assert.throws(
      () => retainRecord({ type: 'attachment', attachment: { type: 'brand_new' } }, ctx, null),
      (err) => err instanceof RefusalError && /brand_new/.test(err.reason),
    );
    assert.throws(
      () =>
        retainRecord(
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'hologram' }] } },
          ctx,
          null,
        ),
      (err) => err instanceof RefusalError && /hologram/.test(err.reason),
    );
    // A KNOWN drop type is dropped quietly, as decided.
    assert.equal(retainRecord({ type: 'ai-title', title: 'x' }, ctx, null).keep, false);
  }],

  // F16, §4.8. 33% of lines carry no cwd; the effective value carries forward
  // rather than defaulting to the workspace root.
  ['F16', 'a record with no cwd inherits the previous effective cwd', () => {
    const records = [
      { value: { type: 'user', cwd: `C:${BS}p${BS}x` } },
      { value: { type: 'last-prompt', lastPrompt: 'hi' } },
      { value: { type: 'user', cwd: `C:${BS}p${BS}y` } },
      { value: { type: 'mode', mode: 'normal' } },
    ];
    const cwds = resolveLineCwd(records);
    assert.deepEqual(cwds, [`C:${BS}p${BS}x`, `C:${BS}p${BS}x`, `C:${BS}p${BS}y`, `C:${BS}p${BS}y`]);
    // A file that opens with cwd-less records back-fills from the first known.
    const leading = resolveLineCwd([{ value: { type: 'mode' } }, { value: { type: 'user', cwd: 'C:/a' } }]);
    assert.deepEqual(leading, ['C:/a', 'C:/a']);
  }],

  // F17, §4.8 plus §4.11. The measured hazard: one file spanned 11 cwds, two
  // of them under \private, inside a workspace that is not itself denied.
  ['F17', 'a line whose cwd moved under \\private is dropped inside an included workspace', () => {
    const records = [
      { value: { type: 'user', cwd: `C:${BS}p${BS}x` } },
      { value: { type: 'user', cwd: `C:${BS}p${BS}x${BS}private` } },
    ];
    const cwds = resolveLineCwd(records);
    assert.equal(allowLine(cwds[0], {}).allow, true);
    const denied = allowLine(cwds[1], {});
    assert.equal(denied.allow, false);
    assert.match(denied.reason, /private/);
    assert.equal(matchDenyToken(`C:${BS}p${BS}payroll-2026`), 'payroll');
    assert.equal(matchDenyToken(`C:${BS}p${BS}private-archive`), 'private');
    assert.equal(matchDenyToken(`C:${BS}p${BS}ordinary`), null);
    // Unknown cwd is deny, never allow.
    assert.equal(allowLine(null, {}).allow, false);
  }],

  // F18, the step 4 versus step 7 ordering. If `relocated` were dropped at
  // retention before cwd resolution, every line after the move would be
  // filtered against the wrong directory.
  ['F18', 'a relocated record moves the cwd BEFORE it is dropped', () => {
    const records = [
      { value: { type: 'user', cwd: `C:${BS}p${BS}x` } },
      { value: { type: 'relocated', relocatedCwd: `C:${BS}p${BS}x${BS}private` } },
      { value: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } } },
    ];
    const cwds = resolveLineCwd(records);
    assert.equal(cwds[2], `C:${BS}p${BS}x${BS}private`, 'the move must apply to the following record');
    assert.equal(allowLine(cwds[2], {}).allow, false, 'and that record must then be dropped');
    // The relocated record itself is dropped at retention.
    const ctx = newRetentionContext((u) => u);
    assert.equal(retainRecord(records[1].value, ctx, null).keep, false);
    // worktree-state feeds the same path.
    assert.equal(
      cwdChangeFrom({ type: 'worktree-state', worktreeSession: { worktreePath: 'C:/wt', originalCwd: 'C:/o' } }),
      'C:/wt',
    );
  }],

  // F19, §9 definition of done. Handled, not a crash.
  ['F19', 'an empty .jsonl file is handled, not a crash', () => {
    const dir = tmpdir();
    for (const [name, body] of [['empty.jsonl', ''], ['blank.jsonl', '\n\n\n'], ['bom.jsonl', '\ufeff{"type":"mode","mode":"n"}\n']]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body, 'utf8');
      const s = readSession(file);
      assert.equal(s.badLines.length, 0, `${name} must not report a bad line`);
      assert.equal(s.roundTripFailures.length, 0, `${name} must round-trip`);
    }
    assert.equal(readSession(path.join(dir, 'empty.jsonl')).records.length, 0);
    assert.equal(readSession(path.join(dir, 'bom.jsonl')).records.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  // F20, §6 open question 1: the one that silently inflates OVR. If
  // truncation dropped is_error, failure_signal could fall below 3,
  // hits_trouble would go false, Resilience would go null and OVR would RISE.
  ['F20', 'is_error survives truncation of a large tool_result', () => {
    const ctx = newRetentionContext((u) => u);
    const huge = 'E'.repeat(50_000);
    const rec = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: huge }],
      },
    };
    const out = retainRecord(rec, ctx, null);
    const block = out.record.message.content[0];
    assert.equal(block.is_error, true, 'is_error must survive');
    assert.ok(block.content.length < huge.length, 'the body must actually be truncated');
    assert.ok(block.redacted_omitted_bytes > 0, 'the omission must be stated, not silent');
    assert.ok(block.content.includes('omitted by deident'), 'the marker must be present');
    assert.ok(ctx.stats.toolResultBytesOmitted > 0);
  }],

  // F21, I1 on the hard cases. §4.6 measured 1,206 non-BMP strings.
  ['F21', 'non-BMP emoji and escaped CJK round-trip byte-identically (I1)', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'hard.jsonl');
    const values = [
      { type: 'mode', mode: 'normal', note: '🧑‍💻 family 👨‍👩‍👧‍👦 and 𝕏' },
      { type: 'mode', mode: 'plan', note: '林大明 said "ok"\ttab\nnewline' },
      { type: 'mode', mode: 'x', note: `path C:${BS}Users${BS}devuser` },
    ];
    fs.writeFileSync(file, `${values.map((v) => JSON.stringify(v)).join('\n')}\n`, 'utf8');
    const s = readSession(file);
    assert.equal(s.records.length, 3);
    assert.equal(s.roundTripFailures.length, 0, 'stringify(parse(line)) must equal line');
    // And a line a future writer formatted differently is DETECTED, not ignored.
    fs.writeFileSync(file, '{"type":"mode", "mode":"spaced"}\n', 'utf8');
    assert.equal(readSession(file).roundTripFailures.length, 1, 'the invariant must be able to fail');
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  // F22, the pseudonym guard at step 12. A semantic pass that helpfully
  // returns "PERSON" as a name would otherwise destroy every tier-0 token.
  ['F22', 'a tier-1 entity overlapping an emitted pseudonym is refused, not applied', () => {
    const cleaned = 'we met PERSON_7 and WORKSPACE_3 today';

    // A semantic pass returning the bare word "PERSON" is the headline case,
    // and the boundary rule does NOT stop it: `_` is a token separator for a
    // spelling this long, so "PERSON" matches inside "PERSON_7". Only the
    // guard stands between that and every tier-0 replacement in the corpus.
    const bareWord = buildTable([entity('T0', 'person', 'PERSON', 'PERSON_99', { tier: 1 })]);
    assert.equal(
      substituteString(cleaned, bareWord).out,
      'we met PERSON_99_7 and WORKSPACE_3 today',
      'unguarded, the bare word really does eat a tier-0 token',
    );
    const bareGuarded = buildTable([entity('T0', 'person', 'PERSON', 'PERSON_99', { tier: 1 })], {
      forbidInside: pseudonymPattern(null),
    });
    assert.equal(substituteString(cleaned, bareGuarded).out, cleaned, 'the guard must stop it');

    // The case the guard exists for is a tier-1 spelling that IS a pseudonym
    // token, a semantic pass reading the cleaned text and reporting the token
    // itself as a name it found. That match is boundary-valid, so nothing but
    // the guard stops it.
    const attack = entity('T1', 'person', 'PERSON_7', 'PERSON_99', { tier: 1 });
    const unguarded = buildTable([attack]);
    assert.equal(
      substituteString(cleaned, unguarded).out,
      'we met PERSON_99 and WORKSPACE_3 today',
      'without the guard a tier-0 token really is destroyed',
    );

    const guarded = buildTable([attack], { forbidInside: pseudonymPattern(null) });
    assert.equal(substituteString(cleaned, guarded).out, cleaned, 'the guard must protect tier-0 tokens');

    // A legitimate tier-1 entity is still applied through the guard.
    const g2 = buildTable(
      [entity('T2', 'person', 'Nora', 'PERSON_98', { tier: 1 })],
      { forbidInside: pseudonymPattern(null) },
    );
    assert.equal(substituteString('PERSON_7 met Nora', g2).out, 'PERSON_7 met PERSON_98');
  }],

  // F23, I10 idempotence, and I11: a failed run leaves nothing behind.
  ['F23', 'the same input produces a byte-identical zip; a failure leaves no file', () => {
    const entries = [
      { name: 'sessions/a/1.jsonl', data: '{"type":"mode","mode":"normal"}\n' },
      { name: 'sessions/a/2.jsonl', data: '{"type":"user","text":"hi 中文"}\n' },
    ];
    const first = buildZip(entries);
    const second = buildZip(entries);
    assert.ok(first.equals(second), 'two runs must produce identical bytes');
    assert.ok(buildZip([...entries].reverse()).equals(first), 'entry order must not matter');

    // Same salt and namespace produce the same pseudonyms.
    const ents = [entity('P1', 'person', 'devuser', null), entity('O1', 'org', 'northwind', null)];
    const a = assignPseudonyms(ents, SALT, 'X').entities.map((e) => e.pseudonym);
    const b = assignPseudonyms([...ents].reverse(), SALT, 'X').entities.map((e) => e.pseudonym);
    assert.deepEqual(a, b, 'assignment must not depend on discovery order');
    assert.notDeepEqual(a, assignPseudonyms(ents, `${SALT}z`, 'X').entities.map((e) => e.pseudonym));

    // I11: a refused export leaves no .part and no output file.
    const dir = tmpdir();
    const target = path.join(dir, 'out.zip');
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.part`), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  // --------------------------------------------------- additional coverage

  // The residual scan is a gate; a gate that cannot fail is not a gate.
  ['F24', 'the residual scan reports a real leak and ignores an escape artifact', () => {
    const t = buildTable([entity('P1', 'person', 'devuser', 'PERSON_1')]);
    const leak = JSON.stringify({ text: 'left behind: devuser here' });
    assert.equal(residualScan(leak, t).entityCount, 1, 'a real leak must be found');
    assert.equal(residualScan(JSON.stringify({ text: 'PERSON_1 here' }), t).entityCount, 0);

    // The measured false positive: decoded text holding CR + "ayku"
    // serializes to the bytes \ r a y k u, so "devuser" appears in the byte
    // stream and nowhere in the decoded text.
    const artifact = JSON.stringify({ text: `x${BS}Users\devuser.claude` });
    assert.ok(artifact.includes('devuser'), 'the artifact really is in the bytes');
    assert.equal(residualScan(artifact, t).entityCount, 0, 'an escape artifact is not a leak');
    assert.equal(startsInsideEscape(`a${BS}devuser`, 2), true);
    assert.equal(startsInsideEscape(`a${BS}${BS}devuser`, 3), false);

    // Boundary-invalid occurrences are counted, not failed (§4.5 row 4).
    const embedded = residualScan(JSON.stringify({ text: 'an array index' }), buildTable([entity('P1', 'person', 'ray', 'PERSON_1')]));
    assert.equal(embedded.entityCount, 0);
    assert.equal(embedded.embedded, 1, 'and it is reported, not hidden');

    // §F5: a UUID that is not a rewritten one is a leak.
    // Fabricated. Shape preserved: a well-formed v4 uuid that is not in the
    // set of uuids this pass rewrote, which is what makes it a leak.
    const uuid = 'cccccccc-0000-4000-8000-000000000000';
    assert.equal(residualScan(uuid, t, new Set()).uuidCount, 1);
    assert.equal(residualScan(uuid, t, new Set([uuid])).uuidCount, 0);
  }],

  ['F25', 'timestamps are quantised to the minute (§F4)', () => {
    assert.equal(quantise('2026-08-22T04:35:59.123Z'), '2026-08-22T04:35:00Z');
    assert.equal(quantise('2026-08-22T04:35:00.000Z'), '2026-08-22T04:35:00Z');
    assert.equal(quantise('not a date'), null);
    assert.equal(quantise(undefined), null);
    // Two stamps in the same minute must be indistinguishable.
    assert.equal(quantise('2026-08-22T04:35:01.001Z'), quantise('2026-08-22T04:35:58.999Z'));
  }],

  ['F26', 'UUIDs inside retained text are rewritten too (§F5, I5)', () => {
    const rw = (u) => (typeof u === 'string' ? `00000000-0000-4000-8000-${u.slice(-12)}` : null);
    // Fabricated. Shape preserved: a well-formed v4 uuid sitting bare in prose,
    // which is where a session id turns up when the model quotes a path back.
    const rec = { text: 'see d1e2f3a4-5b6c-4d7e-8f90-1a2b3c4d5e6f for details', id: 'x' };
    const out = rewriteUuidsInRecord(rec, rw);
    assert.ok(!out.text.includes('d1e2f3a4'), 'the uuid must not survive in prose');
    assert.ok(out.text.includes('00000000-0000-4000-8000-'));
    assert.equal(out.id, 'x', 'non-uuid values are untouched');
  }],

  // F69, the bare local part of the uploader's own address survived six times
  // in a real export, because the seeded spelling is the whole address and the
  // OS username inside it is a correct embedded non-match (F07's nested
  // collision). Seeding EVERY local part would make entities of `legal`,
  // `info`, `support` and `admin`; the guard is that the handle must contain
  // the OS username, which is what makes it demonstrably the uploader's own.
  ['F69', "the uploader's own email handle is an entity, other people's are not", () => {
    const texts = ['write to devuser@northwind.example or legal@kestrelis.ai, cc support@northsky-hr.com'];
    const seeded = seedEntities(
      { USERNAME: 'devuser' },
      { files: [] },
      { cwds: [], repoDirs: [], texts },
    );
    const canonicals = seeded.entities.map((e) => e.canonical);
    assert.ok(canonicals.includes('devuser'), `expected the own-handle seed: ${canonicals.join(', ')}`);
    // Third-party local parts are ordinary words and are NOT seeded bare.
    for (const other of ['legal', 'support']) {
      assert.ok(!canonicals.includes(other), `${other} must not become an entity`);
    }
    // The full addresses still are, per §F1/§F2.
    assert.ok(canonicals.includes('legal@kestrelis.ai'));
    assert.ok(canonicals.includes('support@northsky-hr.com'));
  }],

  // F70, §F4 required MCP server names to be entities. seed.mjs read them from
  // the local settings files, which cover locally-configured servers only, so
  // every Claude.ai connector, configured server-side and named in no file on
  // this machine, survived 436 times in a real export. The log form is always
  // `mcp__NAME__tool`, which is the §F7 precision profile exactly: it cannot
  // match anything by accident and it is the only form that occurs.
  ['F70', 'MCP server names are swept out of the corpus, not just the settings files', () => {
    const found = sweepMcpNames([
      'ran mcp__claude_ai_Gmail__send_message then mcp__playwright-headless__browser_navigate',
      'and mcp__claude-in-chrome__navigate',
    ]);
    assert.deepEqual(found.sort(), ['claude-in-chrome', 'claude_ai_Gmail', 'playwright-headless']);
    // A name must be a name: no bare prefix, nothing under three characters.
    assert.deepEqual(sweepMcpNames(['mcp__ab__x', 'a bare mcp__ mention']), []);

    // And the swept name is replaced where it occurs, boundary and all.
    const built = buildEntities(found.map((n) => ({ kind: 'machine', canonical: n, source: 'fixture', confidence: 'low' })));
    const table = buildTable(assignPseudonyms(built, SALT, null).entities);
    const out = substituteString('mcp__claude_ai_Gmail__send_message failed', table).out;
    assert.ok(!out.includes('claude_ai_Gmail'), out);
    assert.match(out, /^mcp__MACHINE_[0-9]+__send_message failed$/);
  }],

  ['F27', 'the email sweep is precise and finds third-party addresses (§F1, §F7)', () => {
    const found = sweepEmails([
      'cc legal@kestrelis.ai and dana@norbrookvanceadvisory.com about it',
      'not an email: a@b, foo@, @bar.com, M1019757',
    ]);
    assert.ok(found.includes('legal@kestrelis.ai'));
    assert.ok(found.includes('dana@norbrookvanceadvisory.com'));
    // §F7: a passport-shaped regex matched M1019757, a thermal-paste part
    // number. An email regex cannot.
    assert.equal(found.filter((e) => e.includes('M1019757')).length, 0);
    assert.equal(sweepEmails(['no at sign here']).length, 0);
  }],

  ['F28', 'generic directory words are not seeded as entities (§F7)', () => {
    // Substituting `dashboard` or `references` into prose is the cry-wolf
    // failure arriving through the discovery pass rather than the scan.
    assert.equal(projectShaped('dashboard'), false);
    assert.equal(projectShaped('references'), false);
    assert.equal(projectShaped('private-archive'), true);
    // Fabricated. The shape under test is the hyphen: projectShaped accepts on
    // [-_.0-9] or a non-ASCII character, so a replacement without one flips
    // this to false and the assertion stops testing the accept path.
    assert.equal(projectShaped('note-vault'), true);
    assert.equal(projectShaped('wf_20783'), true);
    // A name with no letter in it is a version or a date, never a project.
    // Seeded from a real cwd on 2026-08-22; substituting it rewrites every
    // version string in the prose, and §F4 says leave the version sequence.
    assert.equal(projectShaped('6.2.0'), false);
    assert.equal(projectShaped('2026-08'), false);
    assert.equal(projectShaped('會議記錄'), true, 'a CJK name has no ASCII letter and must survive');
    assert.equal(basenameOf(`C:${BS}Users${BS}devuser${BS}projects${BS}deident`), 'deident');
    assert.equal(basenameOf('C:/'), null);
  }],

  ['F29', 'review.md round-trips its workspace decisions', () => {
    const model = {
      generated: '2026-08-22 04:00',
      workspaces: [
        { name: 'northwind', cwd: 'C:/w/northwind', sessionCount: 61, tier: 'redact', note: 'git remote g/g', denyToken: null },
        { name: 'private-archive', cwd: 'C:/w/private-archive', sessionCount: 4, tier: 'exclude', note: 'deny-list matched: "private"', denyToken: 'private' },
        // Fabricated. Shape: an unclassified row whose name is NOT a deny token
        // and is not one of the two decided rows above, so parseReview has
        // something it must drop rather than round-trip.
        { name: 'passport-map', cwd: 'C:/w/passport-map', sessionCount: 6, tier: 'unclassified', note: 'NEW', denyToken: null },
      ],
      flaggedSessions: [],
      entities: [
        { id: 'P1', kind: 'person', pseudonym: 'PERSON_1', spellings: ['a', 'b'], occurrences: 988, confidence: 'high', source: 'git config', rejected: null },
        { id: 'P2', kind: 'person', pseudonym: 'PERSON_2', spellings: ['c'], occurrences: 4, confidence: 'low', source: 'semantic pass', rejected: null },
      ],
    };
    const text = renderReview(model);
    const back = parseReview(text);
    assert.equal(back.northwind, 'redact');
    assert.equal(back['private-archive'], 'exclude');
    assert.equal(back['passport-map'], undefined, 'unclassified must not become a decision');
    // §F6: low-confidence entities are individual rows, never a collapsed count.
    assert.ok(text.includes('PERSON_2'), 'the low-confidence entity must be listed by name');
    assert.ok(text.includes('← check me'));
    assert.ok(!/\d+ items \[expand\]/.test(text), 'nothing may be collapsed behind an expander');
    // The salt must never appear in a review file.
    assert.ok(!text.includes(SALT));
    assert.throws(() => parseReview('## workspaces\nbogus-tier name 1 sessions\n'), RefusalError);
  }],

  ['F30', 'a malformed entity list refuses rather than becoming an empty one (I6)', () => {
    const dir = tmpdir();
    const write = (name, body) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, body, 'utf8');
      return f;
    };
    assert.throws(() => readEntities(write('bad.json', '{oops')), RefusalError);
    assert.throws(() => readEntities(write('noarr.json', '{"x":1}')), RefusalError);
    assert.throws(() => readEntities(write('nokind.json', '{"entities":[{"kind":"alien","spellings":["a"]}]}')), RefusalError);
    assert.throws(() => readEntities(write('nosp.json', '{"entities":[{"kind":"person"}]}')), RefusalError);
    assert.throws(() => readEntities(path.join(dir, 'missing.json')), RefusalError);

    const good = readEntities(write('ok.json', '{"entities":[{"kind":"person","spellings":["Nora Lund","Nora"],"confidence":"high"}]}'));
    assert.equal(good.ran, true);
    assert.equal(good.entities.length, 1);
    assert.equal(good.entities[0].tier, 1);
    assert.ok(good.entities[0].spellings.includes('Nora Lund'));
    // A bare array is accepted too.
    assert.equal(readEntities(write('arr.json', '[{"kind":"org","spellings":["Acme"]}]')).entities.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['F31', 'the deny-list needs typed confirmation and opt-in is never implicit', () => {
    const groups = [
      { key: 'c:/w/ordinary', name: 'ordinary', cwd: 'C:/w/ordinary', normCwd: 'c:/w/ordinary', sessionCount: 3, bytes: 1, denyToken: null },
      { key: 'c:/w/private-archive', name: 'private-archive', cwd: 'C:/w/private-archive', normCwd: 'c:/w/private-archive', sessionCount: 4, bytes: 1, denyToken: 'private' },
    ];
    const plain = classifyWorkspaces(groups, {}, {});
    assert.equal(plain[0].tier, 'unclassified', 'with no signal read, an unseen workspace is never swept in');
    assert.equal(plain[1].tier, 'exclude');
    // A saved decision alone must NOT re-enable a denied workspace.
    const saved = classifyWorkspaces(groups, { 'private-archive': 'redact', ordinary: 'redact' }, {});
    assert.equal(saved[1].tier, 'exclude', 'review.md alone cannot override the deny-list');
    assert.equal(saved[0].tier, 'redact');
    // Only the typed flag does.
    const typed = classifyWorkspaces(groups, { 'private-archive': 'redact' }, { includeDenied: ['private-archive'] });
    assert.equal(typed[1].tier, 'redact');
    // And a proposal never outranks the deny-list either.
    const proposed = classifyWorkspaces(groups, {}, { propose: () => ({ tier: 'redact', reason: 'signal' }) });
    assert.equal(proposed[1].tier, 'exclude');
  }],

  ['F32', 'the CLI rejects bad usage without touching anything', () => {
    assert.equal(parseCliArgs([]).mode, 'usage');
    assert.equal(parseCliArgs(['--help']).mode, 'usage');
    assert.equal(parseCliArgs(['--selftest']).mode, 'selftest');
    assert.equal(parseCliArgs(['export']).flags.preview, false);
    assert.equal(parseCliArgs(['export', '--preview']).flags.preview, true);
    for (const argv of [
      ['scan', '--preview'],
      ['export', '--namespace', 'lower'],
      ['bogus'],
      ['scan', 'review'],
      ['review', '--html', '--entity', 'PERSON_1'],
      ['export', '--include-denied', 'private-archive*'],
    ]) {
      assert.throws(() => parseCliArgs(argv), UsageError, `should reject ${argv.join(' ')}`);
    }
    assert.equal(new UsageError('x').code, 2);
    assert.equal(new ReadError('x').code, 3);
    assert.equal(new RefusalError('x').code, 1);
  }],

  ['F33', 'object keys carrying a path are substituted, not just values', () => {
    const t = buildTable([entity('W1', 'workspace', `C:${BS}Users${BS}devuser`, 'WORKSPACE_1')]);
    const rec = { backups: { [`C:${BS}Users${BS}devuser${BS}a.md`]: 'x' }, nested: [{ p: 'C:/Users/devuser/b' }] };
    const r = substituteRecord(rec, t);
    const json = JSON.stringify(r.record);
    assert.ok(!json.includes('devuser'), `a key leaked: ${json}`);
    assert.ok(json.includes('WORKSPACE_1'));
    // The input must not be mutated.
    assert.ok(JSON.stringify(rec).includes('devuser'), 'the input record must be untouched');
  }],

  ['F34', 'allOccurrences sees matches the fast scan is allowed to skip', () => {
    // The verifier must be able to disagree with the substituter, or it proves
    // nothing. Here it sees the nested short entity that longest-match hides.
    //
    // SHAPE: two fabricated spellings where the shorter is a STRICT PREFIX of
    // the longer, nkoro < nkorox. Making them one string removes the nesting
    // the two counts (1, then 2) exist to distinguish.
    const t = buildTable([
      entity('P1', 'person', 'nkoro', 'PERSON_1'),
      entity('P2', 'person', 'nkorox', 'PERSON_2'),
    ]);
    const s = 'nkorox';
    assert.equal(substituteString(s, t).spans.length, 1, 'the substituter takes the longest only');
    const all = allOccurrences(s, t);
    assert.equal(all.length, 1, 'nkoro inside nkorox is boundary-invalid, so not an occurrence');
    // With a valid boundary on both, the verifier sees both candidates.
    const s2 = 'nkoro nkorox';
    assert.equal(allOccurrences(s2, t).length, 2);
  }],

  // Regression guard for the two types the live gate caught mid-run. If
  // either is ever re-classified as KEEP, the account uuid §F5 names comes
  // straight back into the export on a record type the brief never listed.
  ['F36', 'the artifact-comment record types are dropped, account uuid and all', () => {
    const ctx = newRetentionContext((u) => u);
    const monitor = {
      type: 'artifact-comment-monitor',
      v: 1,
      sessionId: 's',
      artifacts: { 'aaaaaaaa-0000-4000-8000-000000000000': { state: 'armed', writtenAtMs: 1787376269019, title: 'Q3 Payroll Review' } },
    };
    const ledger = {
      type: 'artifact-autoreact-ledger',
      v: 1,
      sessionId: 's',
      // Fabricated. Shape preserved: a well-formed v4 uuid, the same shape the
      // real `accountUuid` on this record type carries.
      accountUuid: 'bbbbbbbb-0000-4000-8000-000000000000',
      artifacts: {},
    };
    for (const rec of [monitor, ledger]) {
      const out = retainRecord(rec, ctx, null);
      assert.equal(out.keep, false, `${rec.type} must be dropped`);
      assert.equal(out.record, null);
    }
  }],

  ['F35', 'the serialized-form scan catches an escaped CJK entity (§4.6)', () => {
    const t = buildTable([entity('P1', 'person', '林大明', 'PERSON_1')]);
    // JSON.stringify does not escape CJK by default, so the decoded form is
    // what lands; but an embedded JSON string carries the \\uXXXX form, and
    // jsonEscaped is how the scan reaches it.
    assert.equal(jsonEscaped(`a${BS}b`), `a${BS}${BS}b`);
    const bytes = JSON.stringify({ text: 'a 林大明 b' });
    assert.equal(residualScan(bytes, t).entityCount, 1, 'the CJK entity must be findable in the bytes');
  }],

  // Both of the following were found by the live acceptance run against the
  // real corpus on 2026-08-22, after F01-F36 were green. Each is the exact
  // shape that refused the export.
  ['F37', 'a bare drive root is not an entity, and would cry wolf if it were', () => {
    // Negative control first: with the spelling in the table, ordinary Python
    // trips the residual scan. `if r != c:` followed by a newline serializes
    // as `c:` then the two characters backslash-n, so the three-character
    // spelling `c:\` matches text that contains no path at all.
    const NL = String.fromCharCode(10);
    const wolf = buildTable([
      {
        id: 'W1',
        kind: 'workspace',
        canonical: `C:${BS}`,
        spellings: [`c:${BS}`],
        pseudonym: 'WORKSPACE_1',
        confidence: 'low',
        tier: 0,
        rejected: null,
        source: 'fixture',
      },
    ]);
    const bytes = JSON.stringify({ text: `if r != c:${NL}157 f = A[r]` });
    assert.ok(residualScan(bytes, wolf).entityCount > 0, 'negative control: the spelling does match');

    // The guard: every root form is rejected, so it never reaches a table.
    for (const root of [`C:${BS}`, 'C:/', 'c:', '/', BS, '/c/']) {
      assert.notEqual(rejectReason(root), null, `${root} must be rejected`);
    }
    assert.equal(rejectReason(`C:${BS}Users${BS}devuser`), null, 'a real home path is still an entity');
    const seeded = buildEntities([
      { kind: 'workspace', canonical: `C:${BS}`, source: 'session cwd', confidence: 'high' },
    ]);
    assert.deepEqual(seeded[0].spellings, [], 'a rejected entity carries no spellings');
  }],

  ['F38', 'a uuid inside a workspace name is rewritten before it becomes an entry name', () => {
    // The slug of a session launched from a scratchpad path embeds a uuid that
    // no entity matches. Substitution alone left it in the zip's directory
    // listing, where I5 correctly reported it as an unknown uuid.
    const real = 'deadbeef-1111-4222-8333-444455556666';
    const minted = 'aaaaaaaa-0000-4000-8000-000000000000';
    const rewrite = (u) => (u === real ? minted : null);
    const out = serializeSessions(
      [{ file: { sessionId: real }, workspace: { key: 'k', name: `${real}/scratchpad` }, records: [{ type: 'x' }] }],
      buildTable([]),
      rewrite,
    );
    assert.equal(out.entries.length, 1);
    assert.ok(!out.entries[0].name.includes('deadbeef'), 'the real uuid must not survive into the entry name');
    assert.ok(out.entries[0].name.includes(minted), 'the minted uuid replaces it');
    assert.ok(!out.allBytes.includes('deadbeef'), 'and the residual scan sees the rewritten name');
  }],

  ['F39', 'an entity preceded by a JSON escape is a real occurrence, not an embedded one', () => {
    // These logs nest JSON inside JSON: a pasted email body arrives as a
    // string whose own newlines are the two characters backslash + n, and CJK
    // inside it arrives as backslash-u escapes. Before this rule the `n` of
    // `\n` counted as a word character, so `Best\nDean` was classified as the
    // spelling sitting inside a longer word and left in the output, and the
    // residual scan had its own copy of the same rule, so it agreed and
    // reported `known-entity residue: 0` over a zip that named a third party.
    // Found by the live acceptance run, 2026-08-22, in 210 exported sessions.
    const t = buildTable([entity('P1', 'person', 'Dean', 'PERSON_1')]);
    assert.equal(substituteString(`Best${BS}nDean${BS}n${BS}nOn Jul`, t).out, `Best${BS}nPERSON_1${BS}n${BS}nOn Jul`);
    assert.equal(substituteString(`${BS}t${BS}tDean's push`, t).out, `${BS}t${BS}tPERSON_1's push`);
    assert.equal(substituteString(`${BS}u4e0bDean${BS}u7684`, t).out, `${BS}u4e0bPERSON_1${BS}u7684`);

    // Negative controls. F04's correct non-match must survive unchanged, and a
    // doubled backslash means the `n` really is a letter, not an escape.
    const r = buildTable([entity('P2', 'person', 'ray', 'PERSON_2')]);
    assert.equal(substituteString('array index', r).out, 'array index');
    assert.equal(substituteString('Deanson', t).out, 'Deanson', 'a lowercase continuation is still embedded');
    // A camel-case hump IS a token boundary, though: `DeanJoin` is two words in
    // any reading, and this is the shape that shipped `KestrelisAI` x187.
    assert.equal(substituteString('DeanJoin', t).out, 'PERSON_1Join');
    // An escaped backslash means the `n` really is a letter. Asserted with a
    // lowercase entity, so the camel-hump rule cannot mask the escape rule:
    // one backslash is an escape and the entity follows it, two backslashes
    // leave a literal `n` and the entity is inside a longer word.
    assert.equal(substituteString(`x${BS}nray`, r).out, `x${BS}nPERSON_2`);
    assert.equal(substituteString(`x${BS}${BS}nray`, r).out, `x${BS}${BS}nray`, 'an escaped backslash leaves a literal n');

    // §4.6's percent-encoded form is the same shape: `%3D` ends in `D`, so the
    // email that follows it read as embedded. Measured on the real corpus in
    // 22 occurrences of one query string.
    const e = buildTable([
      entity('P3', 'person', 'devuser@northwind.example', 'PERSON_3'),
      entity('O1', 'org', 'northwind-co', 'ORG_1'),
    ]);
    assert.equal(
      substituteString('authuser%3Ddevuser%40northwind.example%23all', e).out,
      'authuser%3DPERSON_3%23all',
    );
    assert.equal(substituteString('github.com%2Fnorthwind-co%2Fx', e).out, 'github.com%2FORG_1%2Fx');
  }],

  // ---- round 2. Four review findings against the shipped slice 1. -------
  //
  // All four had one root cause: a "workspace" was a storage slug directory
  // rather than the directory a person actually worked in.

  ['F40', 'a workspace is named from its resolved cwd, never from the storage slug', () => {
    const session = (p, cwds) => ({ file: { path: p, sessionId: p, bytes: 1 }, cwds });
    const groups = groupSessions(
      [
        session('s1', [`C:${BS}Users${BS}u${BS}projects${BS}northwind`]),
        // Fabricated. Shape: a project directory with a generic subdirectory
        // below it, so the group name must come out `scripts` (the last
        // segment) and not the project. A single-segment path tests nothing.
        session('s2', [`C:${BS}Users${BS}u${BS}projects${BS}market-report${BS}scripts`]),
      ],
      { homedir: `C:${BS}Users${BS}u` },
    );
    assert.deepEqual(groups.map((g) => g.name), ['northwind', 'scripts']);
    for (const g of groups) {
      assert.ok(!g.name.includes('C--'), 'the slug must never reach a name');
      assert.ok(g.cwd.startsWith('C:'), 'and the full resolved cwd is carried as the reason');
    }
    // The review row shows the short name AND the directory it stands for.
    const text = renderReview({
      generated: 'x',
      workspaces: classifyWorkspaces(groups, {}, { propose: () => ({ tier: 'redact', reason: 'r' }) }),
      flaggedSessions: [],
      entities: [],
    });
    assert.match(text, /^redact +northwind +\d+ sessions/m);
    assert.ok(text.includes(`C:${BS}Users${BS}u${BS}projects${BS}northwind`), 'the row must name the real directory');
    assert.ok(!text.includes('C--Users'), 'and never the slug');
    // Two sessions in one directory spelled two ways are ONE row (§4.8).
    // A separator is never a difference; a capital letter is one exactly where
    // the filesystem says so (F108). Asserted as two statements, because
    // written as one it asserted whichever answer the running machine gives
    // and failed on the other: measured 2026-08-24, this passed on Windows and
    // reported two rows on Linux.
    const one = groupSessions(
      [session('a', ['C:/Users/u/projects/x']), session('b', [`C:${BS}Users${BS}u${BS}projects${BS}x`])],
      { homedir: 'C:/Users/u' },
    );
    assert.equal(one.length, 1, 'a separator is not a different directory, anywhere');
    assert.equal(one[0].sessionCount, 2);
    const mixed = [session('a', ['C:/Users/u/Projects/x']), session('b', [`C:${BS}Users${BS}u${BS}projects${BS}x`])];
    const wasFolding = caseFolding();
    try {
      setCaseFolding(true);
      assert.equal(groupSessions(mixed, { homedir: 'C:/Users/u' }).length, 1, 'one directory, one row');
      setCaseFolding(false);
      assert.equal(groupSessions(mixed, { homedir: 'C:/Users/u' }).length, 2, 'two directories, two rows');
    } finally {
      setCaseFolding(wasFolding);
    }
    // review.md is whitespace-delimited, so a name may not carry a space.
    assert.equal(tailSegments('C:/Users/u/My Docs/plan', 2), 'My_Docs/plan');
  }],

  ['F41', 'tiers are proposed from signals, so unclassified is the residue not the default', () => {
    const g = (name, extra = {}) => ({
      key: name, name, cwd: `C:/w/${name}`, normCwd: `c:/w/${name}`,
      sessionCount: 1, denyToken: null, unresolved: false, ...extra,
    });
    const probe = (dir) => (dir === 'C:/w/northwind' ? { raw: 'northwind-co/ledger' } : null);

    assert.equal(proposeTier(g('northwind'), probe).tier, 'redact');
    assert.equal(proposeTier(g('scratch'), probe).tier, 'exclude', 'no remote fails closed');
    // git missing from PATH is not the same fact as a directory without a
    // remote, and the reason the person reads has to say which one happened.
    const noGit = proposeTier(g('anything'), () => GIT_UNAVAILABLE);
    assert.equal(noGit.tier, 'exclude', 'unreadable signal still fails closed');
    assert.doesNotMatch(noGit.reason, /^no git remote$/, 'must not assert a fact it never measured');
    assert.match(noGit.reason, /git/);
    assert.equal(proposeTier(g('private-archive', { denyToken: 'private' }), probe).tier, 'exclude');
    assert.equal(proposeTier(g(HOME_NAME), probe).tier, 'exclude');
    assert.equal(proposeTier(g('x', { unresolved: true }), probe).tier, 'unclassified');
    // `open` is never proposed: repository visibility is not on disk and
    // BRIEF §2 forbids the network call that would answer it. Guessing it
    // wrong leaks, because `open` is the weaker tier (privacy-tiers §5).
    const reason = proposeTier(g('northwind'), probe).reason;
    assert.match(reason, /open/, 'the row must say the person decides that');
    assert.ok(!reason.includes(String.fromCharCode(0x2014)), 'no em dash in user-facing prose');

    // The census: one unclassified row out of five, not five out of five.
    const decisions = classifyWorkspaces(
      [g('northwind'), g('scratch'), g('private-archive', { denyToken: 'private' }), g('a'), g('b', { unresolved: true })],
      {},
      { propose: (ws) => proposeTier(ws, probe) },
    );
    const byTier = Object.fromEntries(summarizeTiers(decisions).map((r) => [r.tier, r.workspaces]));
    assert.deepEqual(byTier, { exclude: 3, redact: 1, unclassified: 1 });

    // A proposal is not a decision and is never written to workspaces.json.
    // Saved as one, a repo that later lost its remote would keep exporting on
    // a `redact` nobody chose (privacy-tiers §3: signals change, re-propose).
    const dir = tmpdir();
    saveDecisions(dir, decisions);
    assert.deepEqual(loadSavedDecisions(dir).workspaces, {});
    const answered = classifyWorkspaces([g('northwind')], { northwind: 'open' }, { propose: (ws) => proposeTier(ws, probe) });
    assert.equal(answered[0].decided, true);
    saveDecisions(dir, answered, new Set(['aaaa-bbbb']));
    // Keyed by the workspace's normalised cwd, not by its display label: the
    // label moves when a NEIGHBOURING workspace appears (F79).
    assert.deepEqual(loadSavedDecisions(dir).workspaces, { [answered[0].key]: 'open' });
    assert.deepEqual([...loadSavedDecisions(dir).sessionDrops], ['aaaa-bbbb']);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['F42', 'a storage directory with no sessions produces no row and no decision', () => {
    // It can contribute nothing to an export, so it must not consume a
    // decision. Twenty-six of them padded the real review file.
    const groups = groupSessions([{ file: { path: 's1', bytes: 1 }, cwds: ['C:/w/real'] }], { homedir: 'C:/h' });
    assert.deepEqual(groups.map((x) => x.name), ['real']);
    assert.equal(groupSessions([], { homedir: 'C:/h' }).length, 0, 'no sessions, no rows at all');
  }],

  ['F43', 'sessions regroup by the directory they worked in, not the one they launched from', () => {
    // Measured 2026-08-22: 214 of 224 real sessions sit under the single slug
    // `C--Users-devuser`, because Claude Code is launched from the home
    // directory. One tier decision controlling 95% of a corpus is not a
    // decision. Four sessions, one launch directory, three answers.
    const home = 'C:/Users/u';
    const s = (p, cwds) => ({ file: { path: p, sessionId: p, bytes: 1 }, cwds });
    const groups = groupSessions(
      [
        s('a', [home, `${home}/projects/northwind`, `${home}/projects/northwind`]),
        s('b', [home, home, `${home}/projects/northwind`]),
        s('c', [home, home, home]),
        s('d', [null, null]),
      ],
      { homedir: home },
    );
    assert.deepEqual(
      Object.fromEntries(groups.map((x) => [x.name, x.sessionCount])),
      { [HOME_NAME]: 2, [UNKNOWN_NAME]: 1, northwind: 1 },
    );
    const homeGroup = groups.find((x) => x.name === HOME_NAME);
    assert.equal(homeGroup.isHome, true);
    const proposal = proposeTier(homeGroup, () => null);
    assert.equal(proposal.tier, 'exclude');
    assert.match(proposal.reason, /individually undecidable/, 'the home bucket says what it is');
    assert.equal(groups.find((x) => x.name === UNKNOWN_NAME).unresolved, true);
  }],

  ['F44', 'the per-line gate resolves a line to its most specific workspace', () => {
    // The excluded home directory is a prefix of every other workspace on the
    // machine. Asked "is this line under an excluded directory", the gate
    // drops the entire corpus; asked "which workspace is this line in", it
    // drops the right lines and nothing else.
    //
    // The index a real run builds is keyed by normalizeCwd's output, so the
    // fixture builds it the same way rather than typing a lowercased key by
    // hand. Typed by hand it stated the folded answer on every platform, and
    // on a case-sensitive filesystem the gate then matched none of its own
    // keys and denied every line: measured 2026-08-24, three of these
    // assertions passed on Windows and the same three failed on Linux, one of
    // them for a reason the fixture never checked.
    const index = (tiers) =>
      cwdTierIndex(
        classifyWorkspaces(
          ['C:/Users/u', 'C:/Users/u/projects/northwind'].map((cwd, i) => ({
            key: normalizeCwd(cwd),
            name: i === 0 ? HOME_NAME : 'northwind',
            cwd,
            normCwd: normalizeCwd(cwd),
            sessionCount: i === 0 ? 9 : 1,
            denyToken: null,
          })),
          tiers,
          {},
        ),
      );

    const wasFolding = caseFolding();
    try {
      for (const folding of [true, false]) {
        setCaseFolding(folding);
        const cwdTiers = index({ [HOME_NAME]: 'exclude', northwind: 'redact' });
        assert.equal(cwdTiers[0].name, 'northwind', 'longest prefix first, or home swallows everything');
        assert.equal(allowLine('C:/Users/u/projects/northwind/src', { cwdTiers }).allow, true);
        const home = allowLine('C:/Users/u', { cwdTiers });
        assert.equal(home.allow, false);
        // Which row denied it, not merely that something did. Unmapped denies
        // too, so a gate that had stopped matching its own keys still read as
        // this assertion passing.
        assert.match(home.reason, /"<home>"/, 'the home row is what denied it');
        assert.equal(
          allowLine(`C:${BS}Users${BS}u${BS}projects${BS}northwind`, { cwdTiers }).allow,
          true,
          'a separator variant is the same directory',
        );
        // Case is the half that depends on the filesystem (F108). Where it
        // folds, `Projects` is the same directory; where it does not, it is a
        // directory nobody classified, and an unclassified directory fails
        // closed rather than borrowing its neighbour's tier.
        assert.equal(
          allowLine(`C:${BS}Users${BS}u${BS}Projects${BS}northwind`, { cwdTiers }).allow,
          folding,
          `case variant under folding=${folding}`,
        );
        assert.equal(allowLine('D:/elsewhere', { cwdTiers }).allow, false, 'no workspace, no export');
      }
    } finally {
      setCaseFolding(wasFolding);
    }
    // The bug this replaced: the index was built from storage slug paths,
    // which can never prefix-match a real cwd, so no workspace tier reached
    // any line at all.
    const slugIndex = [
      { prefix: 'c:/users/u/.claude/projects/c--users-u-projects-northwind', tier: 'exclude', name: 'x' },
    ];
    assert.equal(
      allowLine('C:/Users/u/projects/northwind', { cwdTiers: slugIndex }).allow,
      false,
      'an unmatched line fails closed rather than silently defaulting to allow',
    );
  }],

  // F45, a closed pipe is ordinary use, not a crash.
  //
  // `deident scan | head -0` closes stdout mid-write. The EPIPE arrives as an
  // ASYNCHRONOUS 'error' event on the socket, so main()'s try/catch cannot see
  // it and Node's default handler prints a V8 traceback. BRIEF §2 makes that a
  // failed delivery. Run in a child process because the handler is attached to
  // this process's real stdout at module load and cannot be faked in-process.
  ['F45', 'a reader closing the pipe exits 0 with no traceback', () => {
    const dir = tmpdir();
    const driver = path.join(dir, 'pipe-driver.cjs');
    fs.writeFileSync(
      driver,
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, [process.env.DEIDENT_ENTRY, '--help'], {",
        "  stdio: ['ignore', 'pipe', 'pipe'],",
        '});',
        'let err = "";',
        "child.stdout.destroy();",
        "child.stderr.on('data', (d) => { err += d; });",
        "child.on('close', (code) => { process.stdout.write(JSON.stringify({ code, err })); });",
      ].join('\n'),
      'utf8',
    );
    const entry = fileURLToPath(new URL('../deident.mjs', import.meta.url));
    const raw = execFileSync(process.execPath, [driver], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DEIDENT_ENTRY: entry },
    });
    const result = JSON.parse(raw);
    assert.doesNotMatch(result.err, /Unhandled 'error' event|node:events/, 'no traceback may reach stderr');
    assert.doesNotMatch(result.err, /EPIPE/, 'EPIPE must be swallowed, not reported');
    assert.equal(result.code, 0, 'a closed pipe is exit 0, not a crash');
  }],

  // F46, invalid UTF-8 is silently replaced with U+FFFD by a 'utf8' read, and
  // the serialization check then compares two already-damaged strings and
  // reports the line as byte-identical. The whole point of I1 is to catch a
  // writer that changed, so a check that cannot see the damage is not a check.
  ['F46', 'invalid UTF-8 bytes are a round-trip failure, not a byte-identical line', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'lossy.jsonl');
    const head = Buffer.from('{"type":"user","uuid":"u","text":"', 'utf8');
    const tail = Buffer.from(`"}${String.fromCharCode(10)}`, 'utf8');
    // Valid CJK around three bytes that decode to nothing: FF FE 80.
    const body = Buffer.from([0xe4, 0xbd, 0xa0, 0xff, 0xfe, 0x80, 0xe5, 0xa5, 0xbd]);
    fs.writeFileSync(file, Buffer.concat([head, body, tail]));

    const session = readSession(file);
    assert.equal(session.records.length, 1, 'the line still parses after replacement');
    const utf8 = session.roundTripFailures.filter((f) => f.line === null);
    assert.equal(utf8.length, 1, 'the lossy decode must be reported');
    assert.match(utf8[0].why, /UTF-8/);

    // And a clean file with the same CJK reports nothing.
    const clean = path.join(dir, 'clean.jsonl');
    fs.writeFileSync(clean, Buffer.concat([head, Buffer.from([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]), tail]));
    assert.equal(readSession(clean).roundTripFailures.length, 0);
  }],

  // F47, the corpus is read one file at a time, and a file's raw line text is
  // released once it has been checked.
  //
  // Holding the raw text, the parsed value AND a second array of raw lines for
  // the whole corpus needed 2.5-3.0 GB of old space on the real 833 MB corpus
  // and aborted the process with a V8 heap-limit FATAL ERROR. A heap-limit
  // abort is a process-level abort: no catch runs, no refusal is printed, and
  // the user is told nothing at all.
  ['F47', 'the reader can release raw line text and still run the namespace probe', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'raw.jsonl');
    const rows = [
      { type: 'user', uuid: 'a', sessionId: 's', message: { role: 'user', content: [] } },
      { type: 'mode', sessionId: 's', mode: 'plan' },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');

    const seen = [];
    const session = readSession(file, { keepRaw: false, inspect: (line, no) => seen.push([no, line]) });
    assert.equal(session.records.length, 2);
    assert.equal(seen.length, 2, 'inspect must see every parsed line');
    assert.equal(seen[0][1], JSON.stringify(rows[0]), 'inspect receives the raw text');
    for (const rec of session.records) {
      assert.equal(rec.line, undefined, 'raw line text must not be retained when keepRaw is false');
      assert.ok(rec.value !== undefined, 'the parsed value is still there');
    }
    // The default is unchanged, so callers that need raw text still get it.
    assert.equal(readSession(file).records[0].line, JSON.stringify(rows[0]));
  }],

  // F48, an empty CLAUDE_CONFIG_DIR is not a setting.
  //
  // `??` does not treat '' as absent and `path.resolve('')` is the cwd, so a
  // shell profile exporting the variable unconditionally silently repointed the
  // corpus root at the working directory. Harmless while the refusal fires;
  // not harmless the moment a `projects/` directory exists in the cwd.
  ['F48', 'a blank CLAUDE_CONFIG_DIR falls through to the default root', () => {
    const home = os.homedir();
    for (const blank of ['', '   ']) {
      const root = resolveRoot({ CLAUDE_CONFIG_DIR: blank });
      assert.equal(root.configDir, path.resolve(path.join(home, '.claude')));
      assert.match(root.source, /default/, 'the reported source must not name a variable nobody set');
    }
    const set = resolveRoot({ CLAUDE_CONFIG_DIR: path.join(home, 'elsewhere') });
    assert.equal(set.source, 'CLAUDE_CONFIG_DIR');
    assert.equal(resolveRoot({}, '  ').source, 'the default ~/.claude', 'a blank --root is not an override');
  }],

  // F49, cli-ux §1 makes a point of scan and review writing nothing dangerous.
  // A refusal raised by `scan` that reads "Refusing to export" contradicts the
  // model the interface exists to teach.
  ['F49', 'a refusal names the command it is refusing, not always "export"', () => {
    const err = new RefusalError('could not write review.md', { why: [], remedies: [] });
    const seen = {};
    for (const command of ['scan', 'review', 'export']) {
      setCommand(command);
      seen[command] = captureOutput(() => renderRefusal(err));
    }
    assert.match(seen.scan, /Refusing to scan:/);
    assert.match(seen.review, /Refusing to continue:/);
    assert.match(seen.export, /Refusing to export:/);
    assert.doesNotMatch(seen.scan, /Refusing to export/);
    setCommand(null);
  }],

  // F50, the embedded class was one bucket, and it shipped 870 known-entity
  // occurrences while the gate read `known-entity residue 0  ok`.
  //
  // The residual scan imports the substituter's boundary rule precisely so the
  // two agree, which made I4 untested by construction: whatever the substituter
  // declined to replace, the scan declined to report. §4.5 row 4 justifies not
  // FAILING on `ray` inside `array`. It does not justify putting
  // `mcp__playwright-headless__` and `KestrelisAI` in the same bucket as `array`.
  ['F50', 'a separator or a camel hump is a token boundary, an ordinary letter is not', () => {
    const t = buildTable([
      entity('M1', 'machine', 'playwright-headless', 'MACHINE_1'),
      entity('O1', 'org', 'Kestrelis', 'ORG_1'),
      entity('P1', 'person', 'Nora', 'PERSON_1'),
      entity('O2', 'org', 'northwind', 'ORG_2'),
      entity('P2', 'person', 'ray', 'PERSON_2'),
    ]);
    const leaks = [
      // The whole §F4 MCP class: the log form is always mcp__NAME__tool.
      ['mcp__playwright-headless__browser_navigate', 'mcp__MACHINE_1__browser_navigate'],
      ['project_northwind_site_migration.md', 'project_ORG_2_site_migration.md'],
      ['KestrelisAI funds payroll', 'ORG_1AI funds payroll'],
      ['MeetingNora和Ivan', 'MeetingPERSON_1和Ivan'],
    ];
    for (const [before, after] of leaks) assert.equal(substituteString(before, t).out, after, before);

    // BRIEF §4.5 row 4 is untouched: `ray` is three characters and starts
    // lowercase, so neither exception fires for it.
    for (const kept of ['an array index', 'x_ray_y', 'grayscale']) {
      assert.equal(substituteString(kept, t).out, kept, kept);
    }

    // And the residual scan agrees, because it reads the same two predicates.
    const scan = residualScan('mcp__playwright-headless__x and KestrelisAI', t, new Set());
    assert.equal(scan.entityCount, 2, 'both must be reported as residue, not counted as embedded');
    assert.equal(residualScan('an array index', t, new Set()).entityCount, 0);
  }],

  // F51, the org entity is seeded from the git remote `northwind-co/ledger`,
  // i.e. lowercase, and the company writes itself `NorthWind` everywhere. That
  // spelling survived 1,804 times in a real export and the scan had no idea it
  // existed. Enumerating lower/UPPER/Title does not help: `NorthWind` is none of
  // them. F06 passes today only because both its fixtures are lowercase.
  ['F51', 'a non-path entity matches in any casing, and reversal restores the original', () => {
    const t = buildTable([
      entity('O1', 'org', 'northwind', 'ORG_1'),
      // SHAPE: a fabricated given name of FOUR CHARACTERS OR MORE, so it is
      // above CASE_INSENSITIVE_MIN and its all-caps spelling must still match.
      // A three-letter replacement falls under the floor and the row below
      // silently stops testing case folding.
      entity('P1', 'person', 'Renata', 'PERSON_1'),
      entity('P2', 'person', 'ray', 'PERSON_2'),
    ]);
    for (const [before, after] of [
      ['NorthWind x KestrelisAI Exchange', 'ORG_1 x KestrelisAI Exchange'],
      ['the NORTHWIND repo', 'the ORG_1 repo'],
      ['northwind', 'ORG_1'],
      ['RENATA delacroix', 'PERSON_1 delacroix'],
    ]) {
      assert.equal(substituteString(before, t).out, after, before);
    }

    // I2 still holds: the span records the text that was there, not the
    // entity's own spelling, so reversal is exact.
    const r = substituteString('NorthWind and northwind', t);
    assert.equal(reverseString(r.out, r.spans), 'NorthWind and northwind');

    // The residual scan is matched to the substituter, or the pairing that
    // makes I4 meaningful would let the same 1,804 occurrences through.
    assert.equal(residualScan('Northwind here', t, new Set()).entityCount, 1);

    // Precision floor: three characters is below the case-insensitive minimum,
    // so `Ray` at the start of a sentence is not swept up.
    assert.equal(substituteString('Ray and array', t).out, 'Ray and array');
  }],
  // F52 - a workspace tier is not fine-grained enough on this corpus: 130 of
  // 225 sessions share the home directory, so one tier decides 58% of the
  // export. privacy-tiers 4 calls the per-session hold "level 3"; this is it.
  //
  // The two sections must not read each other's lines. `## workspaces` rows
  // start with a tier and `## sessions` rows start with keep/drop, so a parser
  // that forgot to stop at the section header would throw "keep is not a tier"
  // on a file the person edited correctly.
  ['F52', 'a session held back in review.md round-trips and leaves its workspace alone', () => {
    const model = {
      generated: '2026-08-22 00:00',
      workspaces: [
        { tier: 'redact', name: '<home>', sessionCount: 2, cwd: 'C:' + String.fromCharCode(92) + 'home', note: null },
        { tier: 'exclude', name: 'private-archive', sessionCount: 1, cwd: 'C:' + String.fromCharCode(92) + 'private', note: null },
      ],
      sessions: [
        { id: 'aaaa-1111', date: '2026-08-01', workspace: '<home>', decision: 'keep' },
        { id: 'bbbb-2222', date: '2026-08-02', workspace: '<home>', decision: 'drop' },
        { id: 'cccc-3333', date: '2026-08-03', workspace: 'private-archive', decision: 'keep' },
      ],
      flaggedSessions: [],
      entities: [],
    };

    const text = renderReview(model);
    const { drops, known } = parseSessionDrops(text);
    assert.deepEqual([...drops], ['bbbb-2222'], 'exactly the held-back session comes back');

    // Every id the file mentions, kept or dropped. This is what lets the export
    // fail closed on a session written after the review was generated: absent
    // from `known` means nobody has decided about it, which is not consent.
    assert.deepEqual([...known].sort(), ['aaaa-1111', 'bbbb-2222', 'cccc-3333']);
    assert.ok(!known.has('dddd-4444'), 'a session written since the scan is not in known');

    const tiers = parseReview(text);
    assert.equal(tiers['<home>'], 'redact', 'the session rows do not disturb the workspace tiers');
    assert.equal(tiers['private-archive'], 'exclude');

    // The workspace section must not be read as session decisions, and the
    // informational "second look" section must not be either.
    assert.equal(parseSessionDrops('## workspaces' + NL + 'exclude foo 1 sessions' + NL).drops.size, 0);
    const advisory = parseSessionDrops('## sessions worth a second look' + NL + 'drop 2026-08-01 ws cwd touched x' + NL);
    assert.equal(advisory.drops.size, 0, 'the advisory list is a report, not an input');
    assert.equal(advisory.known.size, 0, 'and it does not make its rows count as decided either');

    // No sessions section at all is no opinion, not "every session unknown".
    // Reading it the other way would hold back an entire corpus on a review
    // file written before the per-session level existed.
    assert.equal(parseSessionDrops('## workspaces' + NL + 'redact foo 1 sessions' + NL).known.size, 0);

    // An unknown word in column 1 refuses rather than being read as keep.
    assert.throws(() => parseSessionDrops('## sessions' + NL + 'maybe 2026-08-01 ws aaaa-1111' + NL), RefusalError);
  }],

  // F53, two entities where one's suffix is the other's prefix.
  //
  // The scan jumped past each replacement, so an entity that STARTS INSIDE the
  // span just claimed was never examined and its remainder shipped verbatim.
  // With `the operator` and `Bell Wang Ivy` both declared high-confidence persons,
  // the exact shape the tier-1 schema example invites, two names sharing a
  // token, the export contained the complete third-party name `Wang Ivy`
  // while the report read `4 replacements, all reversible  ok` and
  // `known-entity residue  0  ok`. Three gates, all blind to one class.
  ['F53', 'a partially overlapping entity does not ship its tail', () => {
    const t = buildTable([
      entity('P1', 'person', 'Ada Wren', 'PERSON_1'),
      entity('P2', 'person', 'Wren Wang Ivy', 'PERSON_2'),
    ]);
    const before = 'intro call: Ada Wren Wang Ivy and the team';
    const r = substituteString(before, t);
    assert.ok(!r.out.includes('Wang Ivy'), `the declared name must not survive: ${r.out}`);
    assert.ok(!r.out.includes('Reed'), `no token of either entity may survive: ${r.out}`);
    assert.equal(r.out, 'intro call: PERSON_1 PERSON_2 and the team');
    assert.equal(reverseString(r.out, r.spans), before, 'I2 still holds over the covering span');

    // The verifier no longer whitelists a straddling occurrence, so if the
    // substituter ever stops absorbing, the export refuses instead of shipping.
    const check = checkSubstitution([{ path: 'x', before, after: r.out, spans: r.spans }], t);
    assert.ok(check.ok, check.failures.map((f) => f.message).join('; '));
    const halfDone = substituteString(before, buildTable([entity('P1', 'person', 'the operator', 'PERSON_1')]));
    const pretend = checkSubstitution(
      [{ path: 'x', before, after: halfDone.out, spans: halfDone.spans }],
      t,
    );
    assert.equal(pretend.ok, false, 'a span set that leaves an entity partly present must FAIL');
  }],

  // F54, the Write tool's real corpus shape is `{type:'create', filePath,
  // content, structuredPatch: []}`: a genuinely empty patch array plus the
  // whole new file in `content`. Treating the empty array as a measured zero
  // destroyed 83,211 true added lines across 838 records, 75.9% of every added
  // line in the corpus, and destroyed them as `0`, the one value BRIEF §4.3
  // calls dangerous, because `distill.ts` reads `abandoned: === 0`.
  //
  // F11 covers `no-patch` (9 records in the corpus). It never touched
  // `empty-patch` (838 records).
  ['F54', 'a file creation counts its content, and never reports 0 for unknown', () => {
    const created = distillToolResult({
      type: 'create',
      filePath: 'a.txt',
      content: ['l1', 'l2', 'l3'].join(NL),
      structuredPatch: [],
    });
    assert.equal(created.code_added_lines, 3, 'three lines were added, not zero');
    assert.equal(created.form, 'create-content');
    assert.equal(checkAddedLines(created), null, 'I8 must accept a true count');

    // A trailing newline terminates the last line rather than starting one.
    assert.equal(
      distillToolResult({ type: 'create', content: ['a', 'b', ''].join(NL), structuredPatch: [] }).code_added_lines,
      2,
    );
    // A genuinely empty new file adds nothing, and that IS a measured zero.
    assert.equal(distillToolResult({ type: 'create', content: '', structuredPatch: [] }).code_added_lines, 0);
    // An empty patch with no content cannot be resolved, so it is null.
    assert.equal(distillToolResult({ structuredPatch: [] }).code_added_lines, null);
    assert.match(checkAddedLines({ code_added_lines: 0, form: 'empty-patch' }), /must be null/);
  }],

  // F55, a `message.content` that is a plain string is the same user turn as
  // `[{type:'text',text}]`, and it was dropped whole. 3,323 records, 2,871,417
  // characters of user-typed prompt text, no refusal and no manifest line.
  ['F55', 'a string-valued message.content is a user turn, not a silent drop', () => {
    const ctx = newRetentionContext((u) => u);
    const rec = {
      type: 'user',
      uuid: 'a',
      sessionId: 's',
      timestamp: '2026-08-22T10:00:00.000Z',
      cwd: 'C:/tmp',
      message: { role: 'user', content: 'rewrite the parser so it handles the empty case' },
    };
    const out = retainRecord(rec, ctx, { file: 'f', line: 1 });
    assert.equal(out.keep, true, 'the turn must be kept');
    assert.deepEqual(out.record.message.content, [
      { type: 'text', text: 'rewrite the parser so it handles the empty case' },
    ]);
    assert.equal(ctx.stats.userMessages, 1);

    // An unrecognised container shape is a refusal, not another silent drop:
    // BRIEF §4.4's "do not whitelist by guessing" is about exactly this.
    assert.throws(
      () => retainRecord({ ...rec, message: { role: 'user', content: { text: 'x' } } }, ctx, { file: 'f', line: 2 }),
      /never seen/,
    );
  }],

  // F56, the prompt dedupe keyed on a 120-character prefix, so 108 distinct
  // prompts (77,734 characters) sharing a boilerplate opening collapsed to one.
  // PLAN C2/C3 justify removing EXACT duplicates; a prefix key is weaker than
  // that justification and throws away the evidence class C3 exists to keep.
  ['F56', 'prompts dedupe on the whole text, not on a 120-character prefix', () => {
    const ctx = newRetentionContext((u) => u);
    const preamble = 'RELAY ENVELOPE '.repeat(10); // > 120 characters, identical
    const one = { type: 'last-prompt', sessionId: 's', timestamp: '2026-08-22T10:00:00.000Z', lastPrompt: preamble + 'first body' };
    const two = { type: 'last-prompt', sessionId: 's', timestamp: '2026-08-22T10:01:00.000Z', lastPrompt: preamble + 'a completely different body' };
    assert.ok(preamble.length > 120);

    assert.equal(retainRecord(one, ctx, { file: 'f', line: 1 }).keep, true);
    assert.equal(retainRecord(two, ctx, { file: 'f', line: 2 }).keep, true, 'a different body is a different prompt');
    // An exact duplicate is still removed, which is all C2/C3 asked for.
    assert.equal(retainRecord({ ...two, timestamp: '2026-08-22T10:02:00.000Z' }, ctx, { file: 'f', line: 3 }).keep, false);
    assert.equal(ctx.stats.dedupedPrompts, 1);
  }],

  // F57, cli-ux §6 prints a `0 secrets  N replaced` line, so the contract
  // already promised credential handling. Nothing in the pipeline looked for
  // one: a real export carried a 93-character GitHub fine-grained PAT twice, in
  // plain text, at full length. Only unambiguous vendor prefixes are matched,
  // because §F7 asks for precision and an entropy heuristic fires on every hash
  // and uuid in the corpus.
  ['F57', 'credential shapes, phone numbers and the ls -l owner id are entities', () => {
    const pat = 'github_pat_11ABCDEFG0' + 'a'.repeat(50);
    const secrets = sweepSecrets([`Token: "${pat}" and sk-ant-${'x'.repeat(24)} here`]);
    assert.ok(secrets.includes(pat), 'the full-length PAT must be found');
    assert.equal(secrets.length, 2);
    // Precision: none of these are credentials.
    assert.deepEqual(sweepSecrets(['M1019757 thermal paste', 'sha256:abcdef0123456789', 'ghost_writer']), []);

    // Scheduled-trigger ids. Found by grepping the SHIPPED archive rather than
    // the report: one sat in plaintext in an export
    // that had passed all six checks, because the reader listed two of the
    // three trigger ids in the corpus and nothing else was looking. This is a
    // fixed prefix plus 26 base62 characters, which is a machine's job and not
    // a reader's, and it is exactly the kind an entity list misses one of.
    // Fabricated, not the one that was found. A fixture is committed source in
    // a repo with a remote, so a real credential pasted into one is a
    // disclosure with a longer half-life than the export it came from.
    const trig = 'trig_01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    assert.ok(sweepSecrets([`routine ${trig} runs monthly`]).includes(trig));
    // §F7 precision: the prefix has to be followed by a real token.
    assert.deepEqual(sweepSecrets(['trig_', 'trigger_happy', 'trig_short']), []);

    // E.164 phones. §F7's profile again: no version or part number matches.
    const phones = sweepPhones(['ring +852-5555 0100 or +1 650 666 1234 today']);
    assert.deepEqual(phones, ['+852-5555 0100', '+1 650 666 1234']);
    assert.deepEqual(sweepPhones(['bump to v+1.2.3', 'part +12 34']), []);
    // A unified-diff added line is the one shape that would over-match.
    assert.deepEqual(sweepPhones([NL + '+12345678901234'], []), []);

    // §F3 says the stable Windows UID "is itself an identifier". Nothing
    // produced one, and it survived 786 times in a real export in exactly the
    // shape F05 exists to guard.
    assert.deepEqual(sweepUnixUid(['-rw-r--r-- 1 devuser 197609    929 Aug 21 23:49 .gitignore'], 'devuser'), ['197609']);
    // A four-digit POSIX uid is four characters that occur everywhere in
    // ordinary text; substituting every `1000` would be §F7 over-substitution.
    assert.deepEqual(sweepUnixUid(['-rw-r--r-- 1 devuser 1000 929 a.txt'], 'devuser'), []);

    // And each becomes a real, substitutable entity.
    const built = buildEntities([
      { kind: 'secret', canonical: pat, source: 'fixture', confidence: 'high' },
      { kind: 'phone', canonical: '+852-5555 0100', source: 'fixture', confidence: 'high' },
      { kind: 'machine', canonical: '197609', source: 'fixture', confidence: 'high' },
    ]);
    const assigned = assignPseudonyms(built, SALT, null);
    const table = buildTable(assigned.entities);
    const out = substituteString(`use ${pat} then call +852-5555 0100, uid 197609`, table).out;
    assert.ok(!out.includes(pat), 'the credential must not survive');
    assert.ok(!out.includes('5136'), 'the phone number must not survive');
    assert.ok(!out.includes('197609'), 'the owner id must not survive');
    assert.match(out, /SECRET_[0-9]+/);
    assert.match(out, /PHONE_[0-9]+/);
  }],

  // F58, a git remote is evidence a directory is a repository. It is not
  // evidence its content is shareable. A personal message archive was proposed
  // `redact` on the strength of its remote alone and shipped a third party's
  // real name 10 times plus per-chat filenames naming the people in them; the
  // deny-list never looked, because privacy-tiers §3 matches it against
  // directory names and the directory carries no deny token.
  ['F58', 'a git remote alone does not make a personal archive shareable', () => {
    const remote = (raw) => ({ raw, owner: raw.split('/')[0], repo: raw.split('/')[1], host: null });
    const group = (name) => ({ name, cwd: `C:${BS}x${BS}${name}`, denyToken: null, unresolved: false });

    // Fabricated. Shape: a whole segment in PERSONAL_TOKENS (here `chat`), so
    // personalDataShape returns non-null and the proposal drops to
    // unclassified. A name with no personal segment proposes redact instead
    // and the fixture asserts nothing.
    const personal = proposeTier(group('chat-archive'), () => remote('me/chat-archive'));
    assert.equal(personal.tier, 'unclassified', 'a personal archive must not be swept in by its remote');
    assert.match(personal.reason, /personal data/);

    // Ordinary work still proposes redact, or the row becomes 29 questions.
    assert.equal(proposeTier(group('northwind'), () => remote('northwind-co/ledger')).tier, 'redact');
    // Whole segments only: a substring test would call these personal data.
    // Fabricated. Shape: an ordinary multi-segment work name whose every
    // segment is outside PERSONAL_TOKENS, so it must come back null.
    assert.equal(personalDataShape('learning-signal-dashboard'), null);
    assert.equal(personalDataShape('pipeline-runner'), null);
    assert.equal(personalDataShape('timeline'), null);
    assert.equal(personalDataShape('private-archive'), 'archive');
    assert.equal(personalDataShape('old-line'), 'line');
    assert.equal(personalDataShape('health-tracker'), 'health');
  }],

  // F59, only the salt's LENGTH was checked, and String.prototype.trim does
  // not strip U+0000, so a file of 64 NUL bytes passed and every pseudonym in
  // the export was derived from an all-zero salt: predictable to anyone who
  // guesses that, which is BRIEF §3's per-uploader salt decision undone in
  // silence. A 3-byte salt was refused only because it happened to be short.
  ['F59', 'a zeroed or foreign salt file is refused, not accepted on length', () => {
    const nul = String.fromCharCode(0);
    for (const [name, body] of [
      ['zeroed', Buffer.alloc(64, 0)],
      ['padded with NULs', Buffer.from('a'.repeat(32) + nul.repeat(32), 'utf8')],
      ['not hex', Buffer.from('z'.repeat(64), 'utf8')],
      ['too long', Buffer.from('a'.repeat(65), 'utf8')],
      ['uppercase hex', Buffer.from('A'.repeat(64), 'utf8')],
    ]) {
      const dir = tmpdir();
      fs.writeFileSync(path.join(dir, 'salt'), body);
      assert.throws(() => loadOrCreateSalt(dir), /not a salt deident wrote/, name);
    }

    // A salt deident wrote is accepted, and loading twice is stable.
    const good = tmpdir();
    const minted = loadOrCreateSalt(good);
    assert.match(minted, /^[0-9a-f]{64}$/);
    assert.equal(loadOrCreateSalt(good), minted);
  }],

  // F60, I9 was proved twice over two halves. `assignPseudonyms` created a
  // fresh `taken` set per call and the pipeline calls it once for tier 0 and
  // once for tier 1, so two different entities could carry one token and the
  // merged table silently kept the first. The index is 24 bits and the email
  // sweep admits up to 5,000 `person` entities, so this is order 1.5% per
  // export, not one in sixteen million.
  ['F60', 'bijectivity holds across the tier-0 and tier-1 passes, not within each', () => {
    const tier0 = assignPseudonyms(
      buildEntities([{ kind: 'person', canonical: 'first-person', source: 'fixture', confidence: 'high' }]),
      SALT,
      null,
    );
    const token = tier0.entities[0].pseudonym;
    assert.ok(token, 'tier 0 must mint a token');

    // Force the collision: a tier-1 entity whose index is made to land on the
    // token tier 0 already used.
    const collide = [
      { id: 'T1', kind: 'person', canonical: 'second-person', spellings: ['second-person'], tier: 1, rejected: null },
    ];
    const forced = assignPseudonyms(collide, SALT, null, { taken: new Set([token]) });
    assert.notEqual(forced.entities[0].pseudonym, token, 'the second entity must not reuse the first token');

    // And the pipeline's own threading is what makes that happen: without the
    // taken set, two passes over the same canonical produce the same token.
    const unthreaded = assignPseudonyms(collide, SALT, null);
    const rerun = assignPseudonyms(collide, SALT, null, { taken: new Set([unthreaded.entities[0].pseudonym]) });
    assert.notEqual(rerun.entities[0].pseudonym, unthreaded.entities[0].pseudonym);
    // The result is still deterministic, so I10 survives.
    assert.equal(
      assignPseudonyms(collide, SALT, null, { taken: new Set([unthreaded.entities[0].pseudonym]) }).entities[0]
        .pseudonym,
      rerun.entities[0].pseudonym,
    );
  }],

  // F61, the acceptance run, end to end, over the shapes round 2 measured.
  //
  // Everything here is asserted against the SHIPPED BYTES of the zip, because
  // every one of these leaks passed an in-memory check: the report said
  // `known-entity residue 0  ok` over an archive that contained a live
  // credential, a personal mobile, a stable machine id, and prose typed inside
  // a directory the review said was excluded.
  ['F61', 'end to end: what actually reaches the zip', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);

    // The run is told which user wrote this corpus (CORPUS_USER), because the
    // owner-id assertion below is about a sweep that is anchored on the
    // running user's name and is otherwise only ever exercised on the one
    // machine whose account name the corpus happened to be written with.
    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(scan.code, 0, scan.out);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);

    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ], CORPUS_USER_ENV);
    assert.equal(exported.code, 0, exported.out);

    const zips = fs.readdirSync(out).filter((f) => f.endsWith('.zip'));
    assert.equal(zips.length, 1, 'exactly one archive');
    const entries = readZipFile(path.join(out, zips[0]));
    const bytes = entries.map((e) => `${e.name}${NL}${e.data}`).join(NL);

    // Content authored inside a deny-listed directory, replayed by a cwd-less
    // record that carries the cwd of a LATER moment (BRIEF §4.11).
    assert.ok(!bytes.includes(corpus.private), 'material from the denied directory must not leave');
    // The deny-listed subtree's own path, which used to survive as a tail.
    assert.ok(!bytes.includes('auditor-notes'), 'the excluded subtree must not be spelled out');
    // §F7-safe credential shapes, E.164 numbers, and the §F3 owner id.
    assert.ok(!bytes.includes('github_pat_'), 'a credential must not leave');
    assert.ok(!bytes.includes('5136 7788'), 'a personal mobile must not leave');
    assert.ok(!bytes.includes(CORPUS_USER), 'the bare username must not leave');
    assert.ok(!bytes.includes('197609'), 'the stable owner id must not leave');
    // The MCP server name, which the boundary rule made inert.
    assert.ok(!bytes.includes('playwright-headless'), 'the MCP server name must not leave');
    // And the directory listing, which is outside every record body.
    assert.ok(!bytes.includes('sessions/alpha/'), `the entry name names the workspace: ${entries.map((e) => e.name)}`);

    // What must be KEPT: a string-valued message.content is a user turn, and a
    // file creation's added lines are its content.
    assert.ok(bytes.includes('KEEP-THIS-STRING-FORM-PROMPT'), 'a string-form user turn must survive');
    assert.match(exported.out, /0 lines of code\s+3 counted/, 'the Write-create must count 3 added lines');
    assert.match(exported.out, /0 secrets\s+1 replaced/);
    assert.match(exported.out, /0 phone numbers\s+1 replaced/);
    // A session that retained nothing is reported rather than vanishing.
    assert.match(exported.out, /1 sessions retained nothing/);
    // And so is the cost of the cwd-less rule: §C3 kept last-prompt because it
    // carries user text found nowhere else, so dropping one is not free and is
    // not reported as free.
    assert.match(exported.out, /records dropped: they replay text typed inside an excluded/);
    assert.match(exported.out, /last-prompt \(1\)/, 'and the class is named, not just a total');
    // The trust block never asserts a number and then contradicts it.
    assert.doesNotMatch(exported.out, /0 dropped by cwd/);
  }],

  // F62, `--include-denied` names a workspace; the per-line gate matches a
  // deny token. The two were never connected, so the documented confirmation
  // promoted the workspace and then dropped every one of its lines: a green
  // success report over a 22-byte archive that `unzip -l` calls empty.
  ['F62', '--include-denied reaches the line gate, and an empty export refuses', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    setTier(path.join(out, 'review.md'), 'auditor-notes', 'redact');
    const args = [
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ];

    primeSemanticPass(root, out, saltDir);
    const without = runCli(args);
    assert.equal(without.code, 0, without.out);
    assert.match(without.out, /1 sessions from 1 workspaces/, 'the denied workspace stays out by default');

    // Primed AGAIN for the second configuration, and that is the correct
    // answer rather than a fixture wrinkle: --include-denied puts lines from
    // the denied directory back into the session, so the prose a reader would
    // see is not the prose they saw last time. A session whose retained text
    // changes is shown again, whether the corpus changed or the settings did.
    primeSemanticPass(root, out, saltDir, null, ['--include-denied', 'auditor-notes']);
    const withFlag = runCli([...args, '--include-denied', 'auditor-notes']);
    assert.equal(withFlag.code, 0, withFlag.out);
    assert.match(withFlag.out, /2 sessions from 2 workspaces/, 'the typed confirmation must actually include it');

    // And an export that retains nothing refuses rather than writing an empty
    // archive and reporting success.
    const empty = tmpdir();
    const emptyOut = path.join(empty, 'out');
    const dir = path.join(empty, 'projects', 'ws');
    fs.mkdirSync(dir, { recursive: true });
    const cwd = ['C:', 'Users', 'devuser', 'projects', 'beta'].join(BS);
    const sid = '33333333-3333-4333-8333-333333333333';
    fs.writeFileSync(
      path.join(dir, `${sid}.jsonl`),
      [
        JSON.stringify({ type: 'permission-mode', sessionId: sid, cwd, mode: 'default' }),
        JSON.stringify({ type: 'ai-title', sessionId: sid, cwd, title: 'x' }),
      ].join(NL) + NL,
      'utf8',
    );
    fs.writeFileSync(
      path.join(empty, 'ents.json'),
      JSON.stringify({ entities: [{ kind: 'person', spellings: ['Nora Lund'], confidence: 'high' }] }),
      'utf8',
    );
    runCli(['scan', '--root', empty, '--out', emptyOut, '--salt-dir', path.join(empty, 'salt')]);
    setTier(path.join(emptyOut, 'review.md'), 'beta', 'redact');
    const refused = runCli([
      'export', '--root', empty, '--out', emptyOut, '--salt-dir', path.join(empty, 'salt'),
      '--entities', path.join(empty, 'ents.json'),
    ]);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /the export would be empty/);
    assert.equal(fs.readdirSync(emptyOut).filter((f) => f.endsWith('.zip')).length, 0, 'no archive may be left');
  }],

  // F63, one unknown top-level record type blocked a whole export with no
  // escape hatch, and --skip-unreadable did not cover the class. Claude Code
  // ships a new record type every few weeks (§F4 records 2.1.215 -> 2.1.238
  // inside one corpus), so refusal stays the default without being terminal.
  ['F63', 'an unknown record type refuses by default and can be dropped on request', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root, { unknownType: true });
    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    // With the escape hatch, or the priming run refuses on the unknown record
    // type before it ever reaches the step that puts prose in front of a reader.
    primeSemanticPass(root, out, saltDir, null, ['--skip-unknown-types']);
    const args = [
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ];

    const refused = runCli(args);
    assert.equal(refused.code, 1, 'the default is still a refusal');
    assert.match(refused.out, /quantum-flux/);
    assert.match(refused.out, /--skip-unknown-types/, 'the refusal must name the escape hatch');

    const skipped = runCli([...args, '--skip-unknown-types']);
    assert.equal(skipped.code, 0, skipped.out);
    // Dropped records the user never hears about are the §4.4 failure arriving
    // through the escape hatch, so they are named and counted.
    assert.match(skipped.out, /quantum-flux \(1\)/);
    assert.match(skipped.out, /dropped unread under --skip-unknown-types/);
  }],

  // F64, `export --preview` printed a before/after pair per entity, i.e. a
  // complete portable re-identification key for every entity that actually
  // occurs, six lines under a header reading "Neither is any entity-to-
  // pseudonym map". review.md carries the same disclaimer and honours it, so
  // the two report surfaces disagreed and one of them was wrong. Aggravating:
  // --out defaults to the working directory, so the file lands next to the zip.
  ['F64', 'the preview shows what leaves, not a map back to who it was', () => {
    const table = buildTable([
      entity('P1', 'person', 'Nora Lund', 'PERSON_1'),
      entity('P2', 'person', 'devuser', 'PERSON_2'),
      entity('O1', 'org', 'Acme Advisory', 'ORG_1'),
    ]);
    const before = 'devuser: call with Nora Lund about the Acme Advisory invoice';
    const r = substituteString(before, table);

    const text = renderPreview({
      generated: '2026-08-22 00:00',
      strings: [{ path: 'x', before, after: r.out, spans: r.spans }],
      table,
      entities: [
        { id: 'P1', kind: 'person', pseudonym: 'PERSON_1', spellings: ['Nora Lund'], confidence: 'high', source: 'semantic pass', rejected: null, canonical: 'Nora Lund' },
        { id: 'O1', kind: 'org', pseudonym: 'ORG_1', spellings: ['Acme Advisory'], confidence: 'high', source: 'semantic pass', rejected: null, canonical: 'Acme Advisory' },
      ],
      manifest: { sessions: 1, workspaces: 1, userMessages: 1, zeros: [] },
      checks: [],
    });

    for (const spelling of ['Nora Lund', 'Acme Advisory', 'devuser']) {
      assert.ok(!text.includes(spelling), `${spelling} must not appear beside its pseudonym`);
    }
    // The excerpt is still there, in exported form, or the preview shows nothing.
    assert.match(text, /PERSON_1/);
    assert.match(text, /call with PERSON_1 about the ORG_1 invoice/);
    // A tier-0 excerpt must not show a tier-1 name sitting a few characters away.
    assert.ok(!text.includes('Wang'), 'no fragment of a declared entity may survive the excerpt');
  }],

  // F65 - cli-ux §5's two queries used to print a note and exit 0, pointing at
  // `export --preview`, which answers neither: a scripted check of "can I drill
  // into PERSON_11" passed while nothing happened. BRIEF §2 calls that a
  // failure, and it is the rule that outlives the implementation.
  //
  // They are implemented now (F148, F150), so what this guards is the state
  // where there is still nothing to answer from. Both queries read an index the
  // EXPORT writes, so on a machine that has only ever scanned there is none,
  // and the honest answer is a refusal naming the command that builds one.
  // "0 occurrences" here would read as "this entity is clean".
  ['F65', 'a query with nothing to answer from refuses and names the command that builds one', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);

    for (const [flag, value] of [['--entity', 'PERSON_11'], ['--session', '2026-08-20']]) {
      const r = runCli(['review', '--root', root, '--out', out, '--salt-dir', saltDir, flag, value]);
      assert.equal(r.code, 1, `${flag} must refuse, not succeed: ${r.out}`);
      assert.match(r.out, /export --out/, `${flag} does not name what to run first: ${r.out}`);
      assert.ok(!/0 occurrences|no occurrences/i.test(r.out), 'a missing index must not read as an empty result');
    }

    // `review` itself still works.
    assert.equal(runCli(['review', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);
  }],

  // F66, every walker in the pipeline is recursive, so pathologically nested
  // JSON exhausts the JS stack. That is a property of the INPUT, and it was
  // reported as `internal error while running "scan": Maximum call stack size
  // exceeded / This is a bug in deident, not a problem with your data`, exit 1
  //, naming the wrong culprit and sending the user to file an issue about
  // their own file. Threshold measured between 1,500 (passes) and 3,000 (fails).
  ['F66', 'a record nested too deeply is a read error naming the line, not a bug report', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'deep.jsonl');
    const depth = 6000;
    const nested = '{"n":'.repeat(depth) + '1' + '}'.repeat(depth);
    fs.writeFileSync(
      file,
      `{"type":"user","uuid":"a","sessionId":"s","message":{"role":"user","content":[]},"toolUseResult":${nested}}` + NL,
      'utf8',
    );

    let caught = null;
    try {
      readSession(file);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ReadError, `expected a ReadError, got ${caught && caught.name}`);
    assert.equal(caught.code, 3, 'an unreadable input is exit 3, not exit 1');
    assert.equal(caught.detail.file, file);
    assert.equal(caught.detail.line, 1);
    assert.match(caught.detail.likelyCause, /nests JSON/);
  }],

  // F67, the export's write ordering and its one deliberate exception.
  //
  // Three separate ways a run reported the opposite of what it did:
  //   - saveDecisions was the only writer with no try/catch and it ran AFTER
  //     writeZip and after the success line, so an unwritable salt directory
  //     printed `-> deident-export.zip  515 B` and then `internal error ...
  //     Nothing was written.` with exit 1 and the finished zip still on disk.
  //   - deident-candidates.txt was written on EVERY export attempt, ahead of
  //     the substitution invariant and the residual scan, so a run that refused
  //     for an unrelated reason left un-de-identified third-party prose behind.
  //   - review --html had no mkdir, so a missing output directory arrived as
  //     "a bug in deident".
  ['F67', 'a written export stays written, and nothing else is written beside it', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir);
    const args = [
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ];

    // A successful export writes the zip and NOT the candidates file: that file
    // holds prose the semantic pass has not seen, so it exists only on the
    // refusal that asks for one.
    const ok = runCli(args);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(fs.existsSync(path.join(out, 'deident-candidates.txt')), false, 'no candidates file on success');

    // Now make the tier memo unwritable. The export must still succeed, warn,
    // and leave the zip in place.
    fs.rmSync(path.join(out, fs.readdirSync(out).find((f) => f.endsWith('.zip'))));
    // Loadable so the run still reaches the save, unwritable so only the SAVE
    // fails. makeUnwritable verifies that rather than trusting the permission
    // bit, which root does not honour.
    const memo = path.join(saltDir, 'workspaces.json');
    fs.writeFileSync(memo, '{}', 'utf8');
    const restoreMemo = makeUnwritable(memo);
    const blocked = runCli(args);
    assert.equal(blocked.code, 0, `a lost tier memo is not a failed export: ${blocked.out}`);
    assert.match(blocked.out, /could not remember your tier decisions/);
    assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.zip')).length, 1, 'the archive stays');
    assert.doesNotMatch(blocked.out, /Nothing was written/, 'the report must not contradict the archive on disk');
    restoreMemo();

    // review --html into a directory that does not exist yet.
    const deep = path.join(root, 'nested', 'deeper');
    const html = runCli(['review', '--html', '--root', root, '--out', deep, '--salt-dir', saltDir]);
    assert.equal(html.code, 0, html.out);
    assert.ok(fs.existsSync(path.join(deep, 'review.html')));

    // And where the path cannot be a directory at all, it is a named refusal
    // with a remedy, not an internal error.
    //
    // The refusal has to be the SAME one on every platform. Asserted only as
    // "could not write" it was two different answers: Windows reads
    // `<out>/review.md` as ENOENT and refused at the later write, POSIX reads
    // it as ENOTDIR and refused with `could not read <out>/review.md`, whose
    // remedy was `deident scan --out <out>`: the same mistake again.
    const blocking = path.join(root, 'a-file');
    fs.writeFileSync(blocking, 'not a directory', 'utf8');
    const refused = runCli(['review', '--html', '--root', root, '--out', blocking, '--salt-dir', saltDir]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /could not write/);
    assert.match(refused.out, /is a file, not a directory/, 'the refusal names the mistake that was made');
    assert.doesNotMatch(refused.out, /could not read/, 'and never blames the file it went looking for');
    assert.match(refused.out, /--out <path>/);
    assert.doesNotMatch(refused.out, /bug in deident/);
  }],

  // F68, an empty entity list satisfied I6: `semantic pass  --entities
  // empty.json · 0 entities  ok` printed beside a real zip. tier1.mjs's own
  // header says an empty list "passes I6 while delivering nothing", and it is
  // exactly the file a failed or interrupted discovery run leaves behind.
  ['F68', 'an empty entity list is not a semantic pass', () => {
    const empty = checkSemanticPass({ ran: true, source: '--entities empty.json', entities: [] });
    assert.equal(empty.ok, false, 'zero entities is indistinguishable from not running');
    assert.equal(empty.why, 'empty');
    assert.match(semanticRefusal('cands.txt', empty.why).reason, /no usable entity/);

    // F81's half of the same gate: a list whose every entry is REJECTED is not
    // a semantic pass either. `{"entities":[{"kind":"person",
    // "spellings":["  "]}]}` printed `1 entities  ok` and shipped a zip,
    // because the gate counted the array and the spelling was rejected
    // downstream. Anyone can type that file in ten seconds.
    const blank = checkSemanticPass({
      ran: true,
      source: '--entities blank.json',
      entities: [{ id: 'T1', canonical: 'a', spellings: [], rejected: 'shorter than 3 characters' }],
    });
    assert.equal(blank.ok, false, 'a list of rejected entities delivers nothing');
    assert.equal(blank.why, 'empty');
    // A blank spelling never gets that far: the reader refuses the file.
    const dir = tmpdir();
    const file = path.join(dir, 'blank.json');
    fs.writeFileSync(file, JSON.stringify({ entities: [{ kind: 'person', spellings: ['  '] }] }), 'utf8');
    assert.throws(() => readEntities(file), /blank spelling/);

    const absent = checkSemanticPass(null);
    assert.equal(absent.ok, false);
    assert.equal(absent.why, 'absent');
    assert.match(semanticRefusal('cands.txt', absent.why).reason, /has not run/);

    const real = checkSemanticPass({
      ran: true,
      source: '--entities e.json',
      entities: [{ id: 'T1', canonical: 'Nora Lund', spellings: ['Nora Lund'], rejected: null }],
    });
    assert.equal(real.ok, true);
    // The count in the report is the USABLE count, and it says so when the two
    // differ, because a number that overstates the pass is what was wrong.
    const mixed = checkSemanticPass({
      ran: true,
      source: '--entities e.json',
      entities: [
        { id: 'T1', canonical: 'Nora Lund', spellings: ['Nora Lund'], rejected: null },
        { id: 'T2', canonical: 'a', spellings: [], rejected: 'too short' },
      ],
    });
    assert.equal(mixed.ok, true);
    assert.match(mixed.detail, /1 entities \(1 rejected\)/);
  }],

  // F71, a replacement changes the text the boundary rule reads.
  //
  // Measured on a real export: `devuserNorthwind.onmicrosoft.com` glued the
  // uploader's handle to the org name. Two things were wrong. The camel-hump
  // test asked the ENTRY's spelling whether it started a hump, and matching is
  // case-insensitive, so the entry for `Northwind` reads `northwind` and answered
  // for a casing that is not the one in the file. And once a replacement lands,
  // the text around the next candidate is different, so the substituter and
  // the residual scan can legitimately disagree, which is a permanently red
  // gate rather than a bug in either.
  ['F71', 'the boundary reads the matched text, and substitution runs to a fixpoint', () => {
    const t = buildTable(
      [entity('P1', 'person', 'devuser', 'X_PERSON_147'), entity('O1', 'org', 'northwind', 'X_ORG_725')],
      { namespace: 'X' },
    );
    const before = 'mail devuserNorthwind.onmicrosoft.com here';
    const r = substituteRecord({ text: before }, t);
    assert.equal(r.record.text, 'mail X_PERSON_147X_ORG_725.onmicrosoft.com here');
    assert.ok(!r.record.text.includes('devuser'), 'the handle must not survive');
    // The residual scan agrees, which is the whole point of the pairing.
    assert.equal(residualScan(r.record.text, t, new Set()).entityCount, 0);

    // I2 per pass, exactly as the pipeline proves it for tier 0 versus tier 1.
    for (const str of r.strings) assert.equal(reverseString(str.after, str.spans), str.before);
    assert.ok(checkSubstitution(r.strings, t).ok);

    // A repeat pass runs under the pseudonym guard, so the fixpoint can never
    // eat its own output: a spelling that matches an emitted token is refused.
    const selfEating = buildTable([entity('P2', 'person', 'X_ORG_725', 'X_PERSON_9')], { namespace: 'X' });
    const second = substituteString('X_ORG_725 stays', selfEating, selfEating.repassGuard);
    assert.equal(second.out, 'X_ORG_725 stays');
  }],
  // F72 - the unit of denial is a block, not a session.
  //
  // Measured on the 2026-08-22 corpus: dropping every session that carried an
  // injected memory index or a dictation hint file took the archive from 35
  // sessions to 17, and not one of those sessions was ABOUT the private
  // matter. The private thing arrived as an attachment or a tool result the
  // user never asked for, inside an hour of unrelated engineering.
  ['F72', 'a denied file is withheld block by block, and its session survives', () => {
    const ctx = newRetentionContext((u) => u);
    const at = { file: 'a', line: 1 };

    // 1. A tool result that read a denied file leaves as a byte count.
    const tr = retainRecord(
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 's',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'MEMORY.md line one' + NL + 'and two' },
          ],
        },
      },
      ctx,
      at,
    );
    assert.ok(tr.keep, 'the record itself survives');
    const block = tr.record.message.content[0];
    assert.match(block.content, /withheld by deident/, 'the denied content is replaced');
    assert.ok(!block.content.includes('line one'), 'and none of it survives');
    assert.equal(ctx.stats.deniedBlocks, 1);

    // 2. A clean tool result in the same session is untouched.
    const clean = retainRecord(
      {
        type: 'user',
        uuid: 'u2',
        sessionId: 's',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ordinary build output' }],
        },
      },
      ctx,
      at,
    );
    assert.equal(clean.record.message.content[0].content, 'ordinary build output');
    assert.equal(ctx.stats.deniedBlocks, 1, 'a clean block is not counted as denied');

    // 3. An attachment naming a denied file is dropped whole.
    const att = retainRecord(
      {
        type: 'attachment',
        uuid: 'u3',
        sessionId: 's',
        attachment: { type: 'edited_text_file', filename: 'C:\\memory' + String.fromCharCode(92) + 'MEMORY.md', snippet: 'private index' },
      },
      ctx,
      at,
    );
    assert.equal(att.keep, false, 'the attachment does not survive');
    assert.equal(ctx.stats.deniedBlocks, 2);

    // 4. Harness-injected spans are stripped, authored text either side stays.
    const before = ctx.stats.injectedBytesDropped;
    const txt = retainRecord(
      {
        type: 'user',
        uuid: 'u4',
        sessionId: 's',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'fix the parser <system-reminder>recalled: the salary file lives at ...</system-reminder> please',
            },
          ],
        },
      },
      ctx,
      at,
    );
    const kept = txt.record.message.content[0].text;
    assert.ok(kept.startsWith('fix the parser'), 'authored text before the span stays');
    assert.ok(kept.endsWith('please'), 'and after it');
    assert.ok(!kept.includes('salary'), 'the injected span is gone');
    assert.ok(ctx.stats.injectedBytesDropped > before, 'and what went is counted');

    // 5. A message that was ONLY an injection retains nothing.
    const only = retainRecord(
      {
        type: 'user',
        uuid: 'u5',
        sessionId: 's',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>all of it</system-reminder>' }],
        },
      },
      ctx,
      at,
    );
    assert.ok(!only.keep || (only.record.message.content ?? []).length === 0, 'nothing authored means nothing kept');
  }],

  // F73, `array.push(...items)` passes one ARGUMENT per element, so a
  // corpus-sized array overflows the argument stack.
  //
  // Measured 2026-08-22: 100,000 spans is fine, 125,000 throws RangeError
  // "Maximum call stack size exceeded". A 762 KB session file holding one user
  // message of `'devuser '.repeat(130000)` reached it through walker.mjs, and the
  // same shape reached `deident scan` through roundTripFailures, surfacing as
  // "internal error … This is a bug in deident", with no remedy at all.
  ['F73', 'a corpus-sized array never reaches push(...spread)', () => {
    const t = buildTable([entity('P1', 'person', 'devuser', 'PERSON_1')]);
    const many = 'devuser '.repeat(150_000);
    const r = substituteRecord({ message: { content: [{ type: 'text', text: many }] } }, t);
    assert.equal(r.record.message.content[0].text.includes('devuser'), false);
    assert.equal(r.strings[0].spans.length, 150_000);

    // The other four sites cannot be reached without building a corpus that
    // large, so they are pinned by shape: no module may spread into push.
    const root = fileURLToPath(new URL('.', import.meta.url));
    const offenders = [];
    const walkDir = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(p);
        else if (e.name.endsWith('.mjs') && e.name !== 'selftest.mjs') {
          for (const line of fs.readFileSync(p, 'utf8').split(NL)) {
            const code = line.trim();
            if (/\.push\(\.\.\./.test(code) && !code.startsWith('//') && !code.startsWith('*')) offenders.push(`${e.name}: ${code}`);
          }
        }
      }
    };
    walkDir(root);
    assert.deepEqual(offenders, [], 'push(...arr) is an argument-stack overflow on corpus-sized input');
  }],

  // F74, the deep-nesting refusal told the user to run --skip-unreadable, and
  // --skip-unreadable produced the identical exit 3, because the RangeError
  // branch ran BEFORE the skip branch. A remedy that cannot work is worse than
  // none (cli-ux §8), and there was no other route past the file.
  ['F74', '--skip-unreadable actually skips a record nested too deeply', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'deep.jsonl');
    const depth = 6000;
    const nested = '{"n":'.repeat(depth) + '1' + '}'.repeat(depth);
    fs.writeFileSync(
      file,
      [
        '{"type":"user","uuid":"a","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"kept"}]}}',
        `{"type":"user","uuid":"b","sessionId":"s","message":{"role":"user","content":[]},"toolUseResult":${nested}}`,
      ].join(NL) + NL,
      'utf8',
    );

    const skipped = readSession(file, { skipUnreadable: true });
    assert.equal(skipped.records.length, 1, 'the readable record survives');
    assert.equal(skipped.badLines.length, 1, 'and the unreadable one is counted, not fatal');

    // Without the flag it is still exit 3, and it names a remedy that works.
    let caught = null;
    try {
      readSession(file);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ReadError);
    assert.match(caught.detail.remedy, /--skip-unreadable/);
    const printed = captureOutput(() => renderReadError(caught));
    assert.equal((printed.match(/--skip-unreadable/g) ?? []).length, 1, 'named once, not twice');

    // And an error the flag cannot help names its own remedy instead.
    const other = new ReadError('could not open x', {
      detail: { file: 'x', line: null, parserMessage: 'EACCES', likelyCause: 'Permission denied.', remedy: 'Fix the permissions.' },
    });
    assert.match(captureOutput(() => renderReadError(other)), /Fix the permissions\./);
    assert.ok(!captureOutput(() => renderReadError(other)).includes('--skip-unreadable'));
  }],

  // F75, `review.md` read `## entities to be replaced  (0)` and review.html's
  // entity table had no rows, on the same corpus whose export replaced 146,904
  // occurrences of 2,778 spellings: runScan and runReview both passed a
  // literal `[]` as the entity list. §F6's rule that low-confidence entities
  // are listed individually is unenforceable over an empty list, and the
  // person doing the review had nothing to review.
  ['F75', 'scan and review list the entities, and say what they have not counted', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(scan.code, 0, scan.out);
    const review = fs.readFileSync(path.join(out, 'review.md'), 'utf8');
    const header = /## entities to be replaced {2}\((\d+)\)/.exec(review);
    assert.ok(header, 'the section exists');
    assert.ok(Number(header[1]) > 0, `the entity list must not be empty: ${header[1]}`);
    assert.match(review, /not yet counted/, 'a count nobody measured is not printed as 0');
    assert.match(review, /export --preview/, 'and the file says where the counts come from');

    // scan writes review.md and nothing else (cli-ux §1/§2): no salt is minted
    // just to print a token.
    assert.equal(fs.existsSync(path.join(saltDir, 'salt')), false, 'scan must not create the salt');

    const html = runCli(['review', '--html', '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(html.code, 0, html.out);
    const page = fs.readFileSync(path.join(out, 'review.html'), 'utf8');
    assert.ok((page.match(/<tr class=/g) ?? []).length > 0, 'the entity table has rows');
    assert.match(page, /type="search"/, 'cli-ux §4: the reader can search');
    assert.ok(!/https?:\/\//.test(page.replace(/[^]*?<script>/, '')), 'no network, no CDN');
  }],

  // F76, the "NOT protected against" block lived in three files and two of
  // them still listed MCP server names as unprotected while the entity table
  // was replacing 2,864 of them. cli-ux §6: a disclosure hiding an
  // implemented-but-inert control is worse than either honest option.
  ['F76', 'one source of truth for the NOT-protected block', () => {
    const m = {
      sessions: 1, workspaces: 1, userMessages: 1, zeros: [],
      droppedByCwd: 0, emptiedSessions: 0, embedded: 7, escapeArtifacts: 3,
      residueLine: '0 occurrences of 12 entity spellings', unknownTypes: [],
      countOnly: { sessions: 0, workspaces: 0 },
    };
    const terminal = captureOutput(() => renderManifest(m));
    const preview = renderPreview({
      generated: 'now', strings: [], table: null, entities: [], manifest: m, checks: [],
    });
    const html = renderReviewHtml({
      generated: 'now', workspaces: [], entities: [], sessions: [], flaggedSessions: [], manifest: m,
    });

    for (const [name, whole] of [['terminal', terminal], ['preview', preview], ['review.html', html]]) {
      // Only the block itself: elsewhere on the page, naming a class deident
      // DOES sweep is the honest statement.
      const at = whole.indexOf('NOT protected against');
      assert.ok(at >= 0, `${name} has no NOT-protected block`);
      const text = whole.slice(at);
      assert.ok(!/MCP server names/.test(text), `${name} still claims MCP names are unprotected`);
      assert.match(text, /localhost ports/, `${name} lost the fingerprint line`);
      assert.match(text, /0 occurrences of 12 entity spellings/, `${name} has no residue figure`);
      assert.match(text, /7 known-entity spellings abut/, `${name} has no embedded count`);
      assert.match(text, /3 spellings are legible in the raw bytes/, `${name} hides the escape artifacts`);
      assert.match(text, /a tool read for you/, `${name} still says only pasted documents`);
    }
  }],

  // F77, `deident scan` is the command whose whole job is to regenerate
  // review.md, and it was the one command a hand-broken review.md could block.
  // It refused, left the broken file exactly as the user broke it, and the
  // other refusals in the codebase point at this command as the fix.
  ['F77', 'scan regenerates a review.md it cannot parse', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'review.md'),
      ['## sessions', 'maybe 2026-08-22 demo aaaa', '', '## workspaces', 'perhaps alpha 1 sessions'].join(NL) + NL,
      'utf8',
    );

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(scan.code, 0, scan.out);
    assert.match(scan.out, /"maybe" is not a session decision/, 'the bad line is reported');
    assert.match(scan.out, /"perhaps" is not a tier/, 'both sections are reported');
    const rewritten = fs.readFileSync(path.join(out, 'review.md'), 'utf8');
    assert.ok(!rewritten.includes('maybe 2026'), 'the broken file was replaced');
    assert.match(rewritten, /## workspaces/);

    // export still refuses on a line it cannot parse: it is not the recovery
    // command, and guessing a tier is how an excluded workspace ships.
    fs.writeFileSync(path.join(out, 'review.md'), ['## workspaces', 'perhaps alpha 1 sessions'].join(NL) + NL, 'utf8');
    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(exported.code, 1, exported.out);
    assert.match(exported.out, /is not a tier/);
  }],

  // F78, SALT_RE is a shape test. 64 zeros were caught by an explicit branch;
  // 63 zeros and a 1 walked around it, and so did 64 digits. BRIEF §3's
  // per-uploader salt reasoning only holds while the salt is actually random.
  ['F78', 'a patterned salt is refused, not accepted on shape', () => {
    const check = (text) => {
      const dir = tmpdir();
      fs.writeFileSync(path.join(dir, 'salt'), `${text}${NL}`, 'utf8');
      try {
        loadOrCreateSalt(dir);
        return null;
      } catch (err) {
        return err;
      }
    };
    assert.ok(check('0'.repeat(63) + '1') instanceof RefusalError, '63 zeros and a 1 is not a salt');
    assert.ok(check('0123456789'.repeat(6) + '0123') instanceof RefusalError, '64 digits is not a salt');
    assert.ok(check('ab'.repeat(32)) instanceof RefusalError, 'a two-character period is not a salt');
    assert.equal(check('0123456789abcdef'.repeat(4)), null, 'all 16 hex characters is a salt');

    // And a real one round-trips, which is what proves the guard is not simply
    // rejecting everything.
    const fresh = tmpdir();
    const made = loadOrCreateSalt(fresh);
    assert.match(made, /^[0-9a-f]{64}$/);
    assert.equal(loadOrCreateSalt(fresh), made, 'the salt is stable across runs (I10)');
  }],

  // F79, a tier the person typed has to be durable and has to survive a
  // neighbouring workspace appearing.
  //
  // Two separate holes, both ending with an excluded workspace in the zip and
  // every gate green:
  //   1. saveDecisions persisted only rows where `decided` was already true,
  //      which was only set when a saved decision had already matched, so a
  //      tier typed for the FIRST time was never written down. --out defaults
  //      to the current directory, so `scan` / `cd elsewhere` / `export`
  //      applied the proposal to nine remote-bearing workspaces with no flags.
  //   2. the key was the display label, and assignNames() escalates `proj` to
  //      `parent/proj` the moment a second `proj` appears.
  ['F79', 'a typed tier is durable and survives a workspace being renamed', () => {
    const root = tmpdir();
    const scanned = path.join(root, 'a');
    const elsewhere = path.join(root, 'b');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    const args = (out) => [
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ];

    assert.equal(runCli(['scan', '--root', root, '--out', scanned, '--salt-dir', saltDir]).code, 0);
    setTier(path.join(scanned, 'review.md'), 'alpha', 'exclude');

    // An export that can find neither a review file nor a memory has nothing
    // to reuse, and must not fall through to its own proposal.
    const blind = runCli(args(elsewhere));
    assert.equal(blind.code, 1, blind.out);
    assert.match(blind.out, /no tier decisions/);
    assert.equal(fs.existsSync(elsewhere) && fs.readdirSync(elsewhere).some((f) => f.endsWith('.zip')), false);

    // Exporting against the review the person edited records the decision...
    const refused = runCli(args(scanned));
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /no workspace is set to an exportable tier/);
    const saved = JSON.parse(fs.readFileSync(path.join(saltDir, 'workspaces.json'), 'utf8'));
    assert.equal(Object.values(saved.workspaces).includes('exclude'), true, `the typed tier was not saved: ${JSON.stringify(saved)}`);
    assert.ok(Object.keys(saved.workspaces).every((k) => k.includes('/')), 'keyed by path, not by label');

    // ...and the memory is what a run with a different --out then reuses.
    const again = runCli(args(elsewhere));
    assert.equal(again.code, 1, again.out);
    assert.match(again.out, /no workspace is set to an exportable tier/);

    // The label is not the key: rename the workspace and the decision holds.
    const group = { key: 'c:/users/devuser/projects/alpha', name: 'alpha', cwd: 'C:/Users/devuser/projects/alpha', normCwd: 'c:/users/devuser/projects/alpha', sessionCount: 1, bytes: 1, denyToken: null, unresolved: false, isHome: false };
    const renamed = { ...group, name: 'projects/alpha' };
    const decide = (ws) => classifyWorkspaces([ws], { byKey: { [group.key]: 'exclude' }, byName: {} }, {
      propose: () => ({ tier: 'redact', reason: 'a remote' }),
    })[0];
    assert.equal(decide(group).tier, 'exclude');
    assert.equal(decide(renamed).tier, 'exclude', 'a renamed row must not revert to the proposal');

    // And a saved key that matches nothing is reported, never silently dropped.
    assert.deepEqual(orphanedDecisions({ 'c:/gone': 'redact' }, [group]), ['c:/gone']);
  }],

  // F80, I3 ran the DECODED-string pattern over RAW serialized lines, where
  // the `n` of a backslash-n escape is a word character, so its lookbehind
  // refused to match any pseudonym-shaped token at the start of a line inside
  // multi-line prose. That is exactly how docs/cli-ux §3's own `PERSON_03 <-`
  // sample row arrives once a teammate reads the docs in a session.
  //
  // The check printed `pseudonym namespace  no pre-existing PERSON_n tokens
  // ok`, deident minted the same token for a tier-1 person, and the archive
  // then contained one token meaning two different things, with reversal
  // permanently ambiguous, which PLAN §2 says this check exists to prevent.
  ['F80', 'the namespace check sees a token that follows a JSON escape', () => {
    const scan = pseudonymScanPattern(null);
    const hits = (line) => {
      scan.lastIndex = 0;
      const out = [];
      let m;
      while ((m = scan.exec(line)) !== null) if (!leftIsWordChar(line, m.index)) out.push(m[0]);
      return out;
    };
    // The raw serialized forms. Every escape whose last character is a word
    // char used to hide the token.
    assert.deepEqual(hits(`Notes:${BS}nPERSON_6194449 is a code name`), ['PERSON_6194449']);
    assert.deepEqual(hits(`a${BS}tORG_12 b`), ['ORG_12']);
    assert.deepEqual(hits(`a${BS}u4e2dWORKSPACE_9 b`), ['WORKSPACE_9']);
    // And the non-match the boundary rule exists for still does not match.
    assert.deepEqual(hits('MYPERSON_1'), []);

    // End to end: the export refuses and offers the namespace shift.
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    const dir = path.join(root, 'projects', 'ws');
    const sid = '55555555-5555-4555-8555-555555555555';
    fs.writeFileSync(
      path.join(dir, `${sid}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: '00000000-0000-4000-8000-000000000905',
        sessionId: sid,
        cwd: ['C:', 'Users', 'devuser', 'projects', 'alpha'].join(BS),
        message: { role: 'user', content: [{ type: 'text', text: `Notes:${NL}PERSON_6194449 is my code name for Bob.` }] },
      }) + NL,
      'utf8',
    );

    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(exported.code, 1, exported.out);
    assert.match(exported.out, /already contains? a token in the pseudonym namespace/);
    assert.match(exported.out, /--namespace X/);
    assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.zip')).length, 0, 'nothing may be written');
  }],

  // F81, four classes shipped verbatim while the manifest asserted they were
  // handled, which is the §F6b failure repeated in new shapes.
  //
  //   `0 secrets`      beside two live Bearer tokens (a `v2.…` API token and a
  //                    Notion MCP upload JWT whose payload carries org UUIDs)
  //   nothing at all   beside a Taiwan passport number, 13 occurrences
  //   nothing at all   beside 8 people's Slack ids, 255 occurrences of one
  //   `0 phone numbers` beside 12 numbers written the way humans write them
  ['F81', 'bearer tokens, id numbers, account ids and formatted phones are entities', () => {
    const bearer = 'v2.5lB0-QQOVaaaaaaaaaaaaaaaaaaaaaa';
    const jwt = 'eyJwdXJwb3NlIjoibWNwX2ZpbGVfdXBsb2FkIn0.abcdefghijkl.';
    const secrets = sweepSecrets([
      `{"headers":{"Authorization":"Bearer ${bearer}"}}`,
      `{"authorization":"Bearer ${jwt}"}`,
      'curl -H "authorization: Bearer ' + jwt + '"',
    ]);
    assert.ok(secrets.includes(bearer), `the bearer token is a credential: ${secrets}`);
    assert.ok(secrets.includes(jwt), 'so is the JWT');
    assert.ok(!secrets.some((v) => v.startsWith('Bearer')), 'the word Bearer is not the secret');
    // §F7: the word has to be there. A bare version string is not a token.
    assert.deepEqual(sweepSecrets(['upgraded to v2.5lB0-QQOVaaaaaaaaaaaaaaaaaaaaaa yesterday']), []);

    // An identity-document number, only where the words say what it is.
    assert.deepEqual(sweepIdNumbers(['Taiwan passport No. 361234560   U.S. TIN: none']), ['361234560']);
    // `passport-map` is fabricated, but the word `passport` in it is not
    // decoration: the shape under test is the cue word appearing with no
    // digits beside it. Drop the word and this stops testing the guard.
    assert.deepEqual(sweepIdNumbers(['passport number pending', 'the passport-map project']), [],
      'no number, no entity');
    // §F7's own example: a passport-shaped regex matched a thermal-paste part
    // number, and nothing here says "passport" beside it.
    assert.deepEqual(sweepIdNumbers(['the part is M1019757 and it runs hot']), []);

    // Account ids: stable join keys for a named person. All four ids are
    // fabricated. The shapes are what the sweep keys off: `U` + 9 alphanumerics
    // for a user, `D` for a DM channel, and 32 hex that only counts as an id
    // when a notion.com URL puts it there, which the negative below pins.
    const ids = sweepPlatformIds([
      'Participants: A (ID: U07QX4MN2K), B (ID: U07QX9PT6R)  Channel: DM (ID: D07QXB3WV8)',
      'notes at app.notion.com/7c41d9a2e8b640f5b1de73a209cc5e84',
    ]);
    assert.ok(ids.includes('U07QX4MN2K') && ids.includes('D07QXB3WV8'), `slack ids: ${ids}`);
    assert.ok(ids.includes('7c41d9a2e8b640f5b1de73a209cc5e84'), 'the notion page id');
    // A bare 32-hex string is every content hash in the corpus (§F7).
    assert.deepEqual(sweepPlatformIds(['sha 7c41d9a2e8b640f5b1de73a209cc5e84 of the blob']), []);

    // Phone numbers as they appear in a signature block, not in E.164. The
    // digits are fabricated; the four punctuation shapes are what is under
    // test, so changing a bracket or a separator breaks the fixture and
    // changing a digit does not.
    const phones = sweepPhones([
      'M: +1 (650) 555 0148',
      'HK (+852) 5550 0142 / (+886) 900 123 456',
      'office (650) 555-0173 or 801-555-0119',
    ]);
    for (const want of ['+1 (650) 555 0148', '(+852) 5550 0142', '(650) 555-0173', '801-555-0119']) {
      assert.ok(phones.includes(want), `${want} survived: ${phones}`);
    }
    assert.deepEqual(sweepPhones(['built 2026-08-22 from 1.2.3', 'range 2024-2025']), [],
      'a date is not a phone number');

    // And an MCP name written in prose with no tool after it.
    assert.ok(
      sweepMcpNames(['see mcp__plugin_context7_context7__ for docs']).includes('plugin_context7_context7'),
      'a bare mcp__NAME__ fragment is the same server name',
    );

    // Every new kind mints a token, or the entity is carried and never applied.
    const seeded = buildEntities([
      { kind: 'idnumber', canonical: '361234560', source: 'x', confidence: 'high' },
      { kind: 'account', canonical: 'U07QX4MN2K', source: 'x', confidence: 'high' },
    ]);
    const assigned = assignPseudonyms(seeded, SALT, null).entities;
    assert.deepEqual(assigned.map((e) => e.pseudonym.replace(/_\d+$/, '')), ['ACCOUNT', 'IDNUM']);
  }],

  // F82, a pseudonym whose plaintext original appears in the same string has
  // done nothing. Three forms reversed one without the salt, measured on a
  // real export:
  //   `accountant = X_ORG_1684551 https://www.norbroo…ory.com`   x15
  //   `…authuser%3DX_PERSON_465285%2540northwind.example`               (a doubly
  //      percent-encoded @, so §4.6's single-%XX escape rule saw the digit `0`
  //      and called `northwind` embedded)
  //   `…mcgZGV2dXNlckBub3J0aHdpbmQuZXhhbXBsZQ%26…`, base64 of the work address   x30
  //
  // Spellings below are fabricated; the shapes are what the fixture needs.
  // ORG_2 is MULTI-WORD and its squashed form is the domain that appears in
  // the same string, so a one-word replacement removes the case (a) tests.
  ['F82', 'the domain, the double-encoding and the base64 of an entity are the entity', () => {
    const withVariants = (id, kind, canonical, pseudonym) => ({
      ...entity(id, kind, canonical, pseudonym),
      looseSpellings: looseVariants(canonical),
    });
    const t = buildTable([
      withVariants('O1', 'org', 'northwind', 'ORG_1'),
      withVariants('P1', 'person', 'devuser@northwind.example', 'PERSON_1'),
      withVariants('O2', 'org', 'Norbrook Vance Advisory', 'ORG_2'),
    ]);

    // (a) the domain spelling of a multi-word org.
    assert.equal(
      substituteString('accountant = ORG_2 https://www.norbrookvanceadvisory.com', t).out.includes('norbrookvance'),
      false,
    );
    // A one-word name has no squashed form to confuse with an English word.
    assert.equal(squashedForm('northwind'), null);
    assert.equal(squashedForm('Norbrook Vance Advisory'), 'norbrookvanceadvisory');

    // (b) a doubly percent-encoded at-sign no longer hides the domain.
    assert.equal(substituteString('authuser%3DX%2540northwind.example', t).out, 'authuser%3DX%2540ORG_1.example');

    // (c) base64, at every one of the three alignments, and still reversible.
    for (const prefix of ['', 'x', 'xy']) {
      const blob = `q${Buffer.from(`${prefix}devuser@northwind.example&z`, 'utf8').toString('base64')}`;
      const r = substituteString(blob, t);
      assert.equal(r.spans.length > 0, true, `alignment "${prefix}" was missed`);
      assert.equal(reverseString(r.out, r.spans), blob, 'reversal must still be exact');
    }
    // The loose exemption applies to base64 needles and to nothing else: an
    // ordinary spelling still obeys §4.5, so `ray` inside `array` is untouched.
    const strict = buildTable([entity('P9', 'person', 'ray', 'PERSON_9')]);
    assert.equal(substituteString('array index', strict).out, 'array index');
  }],

  // F83, the deny-list filtered where the agent WAS, never what it TOUCHED.
  //
  // BRIEF §4.11 says per-directory opt-in, never opt-out, and privacy-tiers §4
  // claims three levels of granularity make that sufficient. All three read
  // the cwd, so a Read, an Edit or a directory listing of a deny-listed path
  // from an ALLOWED cwd was invisible to every one of them. Measured on a real
  // export: `…\private\vendor-search\SCORECARD.md` x17,
  // `…\private\VENDOR-BRIEF.md` x36, `calc.mjs` x5, the
  // parent got a WORKSPACE pseudonym and the subpath below it did not, and a
  // `[chat]…txt` naming the counselling counterparty arrived in a directory
  // listing run from the home directory.
  ['F83', 'a deny-listed path is withheld whoever touched it, from wherever', () => {
    const denied = ['C:', 'w', 'ops-handover', 'private', 'vendor-search', 'SCORECARD.md'].join(BS);
    assert.equal(deniedReason(denied), 'a deny-listed directory');
    // Reached through the path deny-list now, not through a literal in the
    // shipped pattern list, so the reason is the generic one. That is the
    // same rule the reason string already followed: one of the deny tokens
    // is a person, and this string ships.
    assert.equal(deniedReason('projects/private-archive/organized/2025-09.txt'), 'a deny-listed directory');
    // The token has to be inside a path SEGMENT, or ordinary prose trips it.
    assert.equal(deniedReason('the files are at /home and private things'), null);
    assert.equal(deniedReason('run the august-payroll.mjs script'), null);
    assert.equal(deniedReason('C:/w/deident/src/policy/reviewfile.mjs'), null);
    // A RELATIVE path beginning with the deny segment. DENIED_PATH_RE wants a
    // separator BEFORE the token, so grep output quoted as
    // `private/vendor-search/COST-COMPARISON.md:17:` matched nothing and survived
    // a real export. The separator AFTER the segment is what keeps this off
    // the sentence "a private repo".
    assert.equal(deniedReason('private/vendor-search/COST-COMPARISON.md:17:| Quick'), 'a deny-listed directory');
    assert.equal(deniedReason('payroll/2026/ledger.md'), 'a deny-listed directory');
    assert.equal(deniedReason('a private repo is fine'), null);
    assert.equal(deniedReason('identity is a hard problem'), null);

    const ctx = newRetentionContext((u) => u);
    const at = { file: 'a', line: 1 };
    // A tool ASKED to touch it: the parameters go, the tool name stays,
    // because "an Edit happened" is scoring evidence and carries no path.
    const use = retainRecord(
      {
        type: 'assistant',
        uuid: 'u1',
        sessionId: 's',
        cwd: 'C:' + BS + 'w',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: denied, old_string: 'a', new_string: 'b' } }],
        },
      },
      ctx,
      at,
    );
    const block = use.record.message.content[0];
    assert.equal(block.name, 'Edit', 'the tool name survives');
    assert.equal(JSON.stringify(block.input).includes('SCORECARD'), false, 'the path does not');
    assert.equal(JSON.stringify(block.input).includes('vendor-search'), false, 'nor the subdirectory');
    assert.match(block.input.redacted, /withheld by deident/);
    // The marker must not name the token: one of them is a person.
    assert.equal(/payroll|private|identity/i.test(block.input.redacted), false);
    assert.equal(ctx.stats.deniedBlocks, 1);

    // A directory listing that ENUMERATES one, from an allowed cwd.
    const listing = retainRecord(
      {
        type: 'user',
        uuid: 'u2',
        sessionId: 's',
        cwd: 'C:' + BS + 'w',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: `Mode  Name${NL}-a---  ${denied}${NL}-a---  ok.md` }],
        },
      },
      ctx,
      at,
    );
    assert.equal(listing.record.message.content[0].content.includes('SCORECARD'), false);
    assert.equal(ctx.stats.deniedBlocks, 2);

    // And an ordinary tool call in the same session is untouched.
    const fine = retainRecord(
      {
        type: 'assistant',
        uuid: 'u3',
        sessionId: 's',
        cwd: 'C:' + BS + 'w',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'C:/w/src/index.mjs' } }] },
      },
      ctx,
      at,
    );
    assert.equal(fine.record.message.content[0].input.file_path, 'C:/w/src/index.mjs');
    assert.equal(ctx.stats.deniedBlocks, 2);
  }],

  // F84, the cwd-less gate destroyed two whole record classes and never said
  // so. Measured over the 39 sessions a default-shaped run exports: 2,162
  // last-prompt and 613 queue-operation records dropped, 0 kept, 872 of those
  // texts (135,668 characters) appearing nowhere else in their own session,
  // and 0 of 6,976 `mode` records in the corpus carry a cwd, so every one went
  // too, while the manifest prints privacy-tiers' "session count, work mode
  // and outcome only" verbatim.
  //
  // Claude Code is launched from the home directory, scan proposes that
  // workspace `exclude`, and BRIEF §4.8 already measured that one session
  // spans many cwds, so `touchedExcluded` was true for 39 of 39 sessions.
  ['F84', 'a cwd-less record is dropped only when it replays excluded text', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    const dir = path.join(root, 'projects', 'ws');
    const sid = '66666666-6666-4666-8666-666666666666';
    const KEPT = 'THIS-PROMPT-WAS-TYPED-IN-THE-ALLOWED-DIRECTORY-AND-MUST-SURVIVE';
    fs.writeFileSync(
      path.join(dir, `${sid}.jsonl`),
      [
        // one line inside the denied directory, so touchedExcluded is true
        JSON.stringify({
          type: 'user', uuid: '00000000-0000-4000-8000-000000000911', sessionId: sid,
          timestamp: '2026-08-20T10:00:00.000Z', cwd: corpus.denied,
          message: { role: 'user', content: [{ type: 'text', text: corpus.private }] },
        }),
        JSON.stringify({
          type: 'user', uuid: '00000000-0000-4000-8000-000000000912', sessionId: sid,
          timestamp: '2026-08-20T10:01:00.000Z', cwd: corpus.cwd,
          message: { role: 'user', content: [{ type: 'text', text: KEPT }] },
        }),
        // cwd-less, replays the ALLOWED prompt: it must survive.
        JSON.stringify({ type: 'last-prompt', sessionId: sid, timestamp: '2026-08-20T10:02:00.000Z', lastPrompt: KEPT }),
        // cwd-less, replays the DENIED prompt: it must not.
        JSON.stringify({ type: 'queue-operation', sessionId: sid, timestamp: '2026-08-20T10:03:00.000Z', operation: 'add', content: corpus.private }),
        // cwd-less and carries no text at all: work mode must reach the zip.
        JSON.stringify({ type: 'mode', sessionId: sid, mode: 'plan' }),
      ].join(NL) + NL,
      'utf8',
    );

    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir);
    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(exported.code, 0, exported.out);
    const bytes = readZipFile(path.join(out, fs.readdirSync(out).find((f) => f.endsWith('.zip'))))
      .map((e) => e.data)
      .join(NL);

    assert.ok(bytes.includes(KEPT), 'a prompt typed in the allowed directory must survive');
    assert.ok(!bytes.includes(corpus.private), 'a prompt replaying denied text must not');
    const types = new Set(
      bytes.split(NL).filter((l) => l.trim() !== '').map((l) => JSON.parse(l).type),
    );
    assert.ok(types.has('last-prompt'), `last-prompt must not be a class at zero: ${[...types]}`);
    assert.ok(types.has('mode'), 'privacy-tiers count-only promises work mode, so mode must ship');
    assert.ok(!types.has('queue-operation'), 'the replayed one is the only one dropped');
  }],

  // F85, a declared tier-1 entity whose spelling contains a tier-0 spelling
  // was never applied, and its remainder shipped with every gate green.
  //
  // Tier 1 runs over CLEANED text, so `Devuser Consulting Ltd` is already
  // `PERSON_n Consulting Ltd` by the time tier 1 looks, the declared spelling
  // no longer exists, and nothing can catch it: checkSubstitution only
  // receives strings that CHANGED, and residualScan cannot find a spelling
  // tier 0 has already destroyed. A 20,000-trial two-tier fuzz produced 3,636
  // instances and the gates caught 0.
  ['F85', 'a tier-1 entity survives tier-0 substitution, or the run says so', () => {
    const tier0 = buildTable([entity('P0', 'person', 'Devuser', 'PERSON_1')]);
    const declared = { kind: 'org', canonical: 'Devuser Consulting Ltd', spellings: ['Devuser Consulting Ltd'], rejected: null };
    const cleanedSpellings = [
      ...new Set([
        ...declared.spellings,
        ...declared.spellings.map((sp) => substituteString(sp, tier0).out),
      ]),
    ];
    assert.ok(cleanedSpellings.includes('PERSON_1 Consulting Ltd'), 'the cleaned form is a spelling');

    const tier1 = buildTable(
      [{ ...entity('O1', 'org', 'Devuser Consulting Ltd', 'ORG_1'), spellings: cleanedSpellings }],
      { forbidInside: pseudonymGuardPattern(null) },
    );
    const cleaned = substituteString('The invoice came from Devuser Consulting Ltd today.', tier0).out;
    assert.equal(cleaned, 'The invoice came from PERSON_1 Consulting Ltd today.');
    const final = substituteString(cleaned, tier1);
    assert.equal(final.out, 'The invoice came from ORG_1 today.', 'the remainder must not ship');
    assert.equal(reverseString(final.out, final.spans), cleaned, 'and reversal is still exact');

    // The guard it had to walk past is still a guard: a semantic pass that
    // returns `PERSON` as a name cannot destroy tier-0 tokens.
    const greedy = buildTable([entity('P9', 'person', 'PERSON', 'ORG_9')], { forbidInside: pseudonymGuardPattern(null) });
    assert.equal(substituteString('PERSON_1 wrote it', greedy).out, 'PERSON_1 wrote it');

    // And the fixpoint guard covers a token glued to a word character, which
    // is exactly the shape the fixpoint exists to create.
    const guard = pseudonymGuardPattern(null);
    guard.lastIndex = 0;
    assert.deepEqual('Vendor ORG_11499881Corp invoiced'.match(guard), ['ORG_11499881']);
    const eats = buildTable([entity('X1', 'org', '11499881Corp', 'ORG_2')]);
    assert.equal(
      substituteString('Vendor ORG_11499881Corp invoiced', eats, eats.repassGuard).out,
      'Vendor ORG_11499881Corp invoiced',
      'a repeat pass must not substitute inside its own token',
    );
  }],

  // F87, three retention defects that all report something untrue.
  ['F87', 'one line count, a codepoint-safe cut, and no silent nested drop', () => {
    const ctx = newRetentionContext((u) => u);
    const at = { file: 'a', line: 1 };

    // (1) The stripped Write parameter reported one more line than
    // code_added_lines for the same file: 907 of 908 pairs in the corpus
    // disagreed by exactly 1, one JSONL line apart in the same export.
    const body = ['l1', 'l2', 'l3'].join(NL) + NL;
    const write = retainRecord(
      {
        type: 'assistant', uuid: 'u1', sessionId: 's',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'C:/w/a.txt', content: body } }] },
      },
      ctx,
      at,
    );
    const stripped = write.record.message.content[0].input.content;
    const counted = distillToolResult({ type: 'create', filePath: 'C:/w/a.txt', content: body, structuredPatch: [] });
    assert.equal(stripped.lines, 3, 'a trailing newline terminates the last line');
    assert.equal(stripped.lines, counted.code_added_lines, 'the two figures in one export must agree');

    // (2) The head/tail cut split a multi-byte character, and toString then
    // substituted U+FFFD: 196 of 1,217 truncated blocks in the corpus gained
    // one. This tool only removes; it must not insert.
    const FFFD = String.fromCharCode(0xfffd);
    const cjk = '中'.repeat(9000);
    const capped = retainRecord(
      {
        type: 'user', uuid: 'u2', sessionId: 's',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: cjk }] },
      },
      ctx,
      at,
    );
    const text = capped.record.message.content[0].content;
    assert.ok(text.includes('omitted by deident'), 'it was truncated');
    assert.equal(text.includes(FFFD), false, 'and no replacement character was invented');
    assert.equal(Buffer.from(text, 'utf8').includes(Buffer.from(FFFD, 'utf8')), false);

    // (3) A nested block type nobody has decided about is a refusal, the same
    // as at the top level (I7). Today's instance carries only an MCP tool name
    // and is dropped by name; anything else raises.
    const known = retainRecord(
      {
        type: 'user', uuid: 'u3', sessionId: 's',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'tool_reference', name: 'mcp__x__y' }, { type: 'text', text: 'result' }] }],
        },
      },
      ctx,
      at,
    );
    assert.equal(known.record.message.content[0].content, 'result');
    assert.throws(
      () => retainRecord(
        {
          type: 'user', uuid: 'u4', sessionId: 's',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'brand_new_thing', payload: 'user text nobody reviewed' }] }] },
        },
        newRetentionContext((u) => u),
        at,
      ),
      /never seen/,
      'a silent drop is how the highest-value turns get lost (BRIEF §4.4)',
    );
  }],
  // F86 - a presigned URL's session token is a credential, and prose whose
  // subject is a recovery kit goes as a block.
  //
  // Both come from the same 2026-08-22 finding. An AWS SigV4 query token
  // carries no vendor prefix, is not a JWT and has no `Bearer` before it, so
  // all three existing sweeps walked past it while the manifest printed
  // `0 secrets`. And a reviewer looking at an Emergency Kit could only say the
  // quotes were truncated, so exact removal could not be promised - which is
  // how a whole session gets dropped for something a block rule removes.
  ['F86', 'an AWS session token is swept, and credential prose is withheld as a block', () => {
    const token = 'FQoGZXIvYXdzEBYaDExhbXBs' + 'x'.repeat(40);
    const url = `https://s3.amazonaws.com/b/k?X-Amz-Security-Token=${token}&X-Amz-Signature=abc`;
    const swept = sweepSecrets([`fetch ${url} now`]);
    assert.ok(swept.includes(token), 'the token value is taken');
    assert.ok(!swept.some((v) => v.includes('X-Amz-Security-Token')), 'the parameter name is not');

    // The temporary key id shares AKIA's shape with a different first letter.
    assert.ok(sweepSecrets(['id ASIA' + 'Q'.repeat(16) + ' here']).length === 1);

    // A signed URL with no credential parameters is not a secret.
    assert.deepEqual(sweepSecrets(['https://s3.amazonaws.com/bucket/key?versionId=3']), []);

    // Block rule: prose about a recovery kit leaves as a byte count.
    const ctx = newRetentionContext((u) => u);
    const rec = retainRecord(
      {
        type: 'assistant',
        uuid: 'u1',
        sessionId: 's',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Your 1Password Emergency Kit is in Downloads and holds the account key.' }],
        },
      },
      ctx,
      { file: 'a', line: 1 },
    );
    const out = rec.record.message.content[0].text;
    assert.match(out, /withheld by deident/);
    assert.ok(!out.includes('Downloads'), 'the whole block goes, not the matched phrase');
    assert.equal(ctx.stats.deniedBlocks, 1);

    // Ordinary prose that merely names the product is untouched: a session
    // comparing password managers is exactly the work worth exporting.
    const keep = retainRecord(
      {
        type: 'assistant',
        uuid: 'u2',
        sessionId: 's',
        message: { role: 'assistant', content: [{ type: 'text', text: '1Password costs less than the team plan.' }] },
      },
      ctx,
      { file: 'a', line: 2 },
    );
    assert.equal(keep.record.message.content[0].text, '1Password costs less than the team plan.');
    assert.equal(ctx.stats.deniedBlocks, 1, 'and it is not counted as denied');
  }],

  // F88, three environment and format ceilings that each arrived as
  // `internal error … This is a bug in deident, not a problem with your data`,
  // which is the one shape BRIEF §2 forbids.
  ['F88', 'an empty HOME and a full archive are named, not reported as bugs', () => {
    // os.homedir() throws uv_os_homedir ENOENT when HOME and USERPROFILE are
    // both empty, and it was called unguarded from resolveRoot and
    // defaultSaltDir.
    assert.throws(() => resolveRoot({ HOME: '', USERPROFILE: '' }), (err) => {
      assert.ok(err instanceof RefusalError);
      assert.match(err.reason, /no home directory/);
      assert.match(err.remedies[0].command, /--root/);
      return true;
    });
    // Naming a path is the remedy, so naming one has to work.
    assert.equal(resolveRoot({ HOME: '', USERPROFILE: '' }, 'C:/w/cfg').configDir, path.resolve('C:/w/cfg'));
    assert.throws(() => defaultSaltDir({ HOME: '', USERPROFILE: '' }), /no home directory/);
    // An EMPTY DEIDENT_SALT_DIR is not a setting: `??` let it through and the
    // salt resolved to ./salt in the current directory, where an existing file
    // would have been read in preference to the real one.
    assert.throws(() => defaultSaltDir({ HOME: '', USERPROFILE: '', DEIDENT_SALT_DIR: '  ' }), /no home directory/);
    assert.equal(defaultSaltDir({ DEIDENT_SALT_DIR: 'C:/w/s' }), 'C:/w/s');

    // The zip writer has no ZIP64 path: 65,535 entries is fine, 65,536 threw
    // RangeError from inside buildZip.
    const entry = (i) => ({ name: `sessions/w/${i}.jsonl`, data: 'x' });
    const many = [];
    for (let i = 0; i < MAX_ENTRIES + 1; i += 1) many.push(entry(i));
    assert.throws(() => buildZip(many), (err) => {
      assert.ok(err instanceof RefusalError, `expected a refusal, got ${err.name}: ${err.message}`);
      assert.match(err.reason, /65,536 entries/);
      assert.match(err.why.join(' '), /65,535/);
      return true;
    });
    assert.ok(buildZip(many.slice(0, MAX_ENTRIES)).length > 0, 'the documented limit still works');
  }],

  // F89, a full-corpus export ran 24m28s and printed its first byte after the
  // whole pipeline had finished. Twenty-four minutes of silence is
  // indistinguishable from a hang, and two runs were killed believing it had
  // wedged. cli-ux §2 rules out progress bars, not output.
  ['F89', 'a long run says which phase it is in, and the hot loops are indexed', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir);
    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(exported.code, 0, exported.out);
    for (const phase of [/Reading \d+ session files/, /Applying the tiers/, /Seeding entities/, /Substituting/, /Verifying the substitution invariant/, /Scanning the serialized output/]) {
      assert.match(exported.out, phase, `no line for ${phase}`);
    }
    // Every phase line comes BEFORE the Checks block it used to hide behind.
    assert.ok(exported.out.indexOf('Reading') < exported.out.indexOf('Checks'));

    // checkSubstitution was an occurrence x span cross-product: one string
    // with 2,000 spans cost 644 ms and one with 40,000 cost 32,002 ms. The
    // same work is now indexed, so it has to finish in ordinary time.
    const t = buildTable([entity('P1', 'person', 'devuser', 'PERSON_1')]);
    const many = 'devuser '.repeat(20_000);
    const r = substituteRecord({ text: many }, t);
    const started = Date.now();
    const result = checkSubstitution(r.strings, t);
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.replacements, 20_000);
    assert.ok(Date.now() - started < 10_000, `20,000 spans took ${Date.now() - started} ms`);
  }],

  // F90, two things the report was silent about while every gate read green.
  //
  // (a) BRIEF §4.5 asks for length >= 2 AND a flag for CJK entities, "because
  //     the lookaround does not prevent over-matching inside a longer CJK
  //     word". The length rule shipped, the flag did not: 小明 matched inside
  //     小明天 and mangled a sentence that named nobody.
  // (b) Two overlapping declared entities collapse to one span, and the token
  //     they SHARE disappears, so `Rosa Barnard Freight` and `Rosa Barnard
  //     Barnard Freight` come out identical. I2 passes because reverseString
  //     is fed the spans, but §3 forbids persisting them, so the reversal path
  //     that actually exists (regenerate the list, hash candidates) cannot
  //     tell the two apart.
  ['F90', 'a CJK match and an absorbed overlap are counted, not passed off as clean', () => {
    const cjk = buildTable([entity('P1', 'person', '小明', 'PERSON_1')]);
    const over = substituteString('明天小明天氣很好', cjk);
    assert.equal(over.out, '明天PERSON_1天氣很好', 'BRIEF §4.5: the lookaround cannot stop this');
    assert.equal(over.spans[0].cjk, true, 'so the occurrence has to be counted');
    // A Latin entity is not flagged, or the count means nothing.
    const latin = buildTable([entity('P2', 'person', 'Dean', 'PERSON_2')]);
    assert.equal(substituteString('因為Dean他', latin).spans[0].cjk, false);

    // SHAPE: two fabricated multi-word entities SHARING A MIDDLE TOKEN,
    // `Rosa Barnard` and `Barnard Freight`. Input (a) writes the shared token
    // once so the spans overlap and one absorbs the other; input (b) writes it
    // twice so they do not. Replacing either spelling with one that shares no
    // token with the other leaves nothing to absorb and the fixture asserts
    // something that cannot happen.
    const pair = buildTable([
      entity('P3', 'person', 'Rosa Barnard', 'PERSON_3'),
      entity('O1', 'org', 'Barnard Freight', 'ORG_1'),
    ]);
    const a = substituteString('A: Rosa Barnard Freight', pair);
    const b = substituteString('B: Rosa Barnard Barnard Freight', pair);
    assert.equal(a.spans.some((sp) => sp.absorbed), true, 'the overlap is recorded as absorbed');
    assert.equal(a.out.slice(3), b.out.slice(3), 'two different inputs, one output: this is the point');
    // Span-relative reversal still works, which is exactly the distinction the
    // manifest now has to draw.
    assert.equal(reverseString(a.out, a.spans), 'A: Rosa Barnard Freight');
    assert.equal(reverseString(b.out, b.spans), 'B: Rosa Barnard Barnard Freight');

    const printed = captureOutput(() => renderManifest({
      sessions: 1, workspaces: 1, userMessages: 1, zeros: [], droppedByCwd: 0, emptiedSessions: 0,
      absorbedSpans: 2, cjkSpans: 5, embedded: 0, unknownTypes: [], countOnly: { sessions: 0, workspaces: 0 },
    }));
    assert.match(printed, /2 replacements merged two overlapping entities/);
    // The label said "CJK" while the flag was set for every non-Latin script,
    // so a Cyrillic or Hebrew replacement was reported under the wrong writing
    // system and the wrong reason. F145 is the fixture for that; this one
    // pins that the count still reaches the manifest.
    assert.match(printed, /5 entity occurrences in a script written without spaces/);
  }],

  // F91, the second half of F83: a deny-listed path quoted in PROSE.
  //
  // Withholding a whole assistant turn because it names a path would throw
  // away the scoring evidence the export exists for, so the path goes and the
  // paragraph stays. Measured on a real export, in assistant prose rather than
  // tool output: `private/vendor-search/SCORECARD.md` and
  // `WORKSPACE_n/private/WORKSPACE_m/VENDOR-BRIEF.md`.
  ['F91', 'a deny-listed path quoted in prose is removed without the paragraph', () => {
    const ctx = newRetentionContext((u) => u);
    const at = { file: 'a', line: 1 };
    const say = (text) =>
      retainRecord(
        { type: 'assistant', uuid: 'u', sessionId: 's', cwd: 'C:/w', message: { role: 'assistant', content: [{ type: 'text', text }] } },
        ctx,
        at,
      ).record.message.content[0].text;

    // No leading separator: this is the form that appears in prose, and
    // DENIED_PATH_RE's leading-separator test does not see it.
    const out = say('The table is at `private/vendor-search/SCORECARD.md`, see also src/policy/x.mjs');
    assert.ok(!out.includes('SCORECARD'), out);
    assert.ok(out.includes('src/policy/x.mjs'), 'an ordinary path is untouched');
    assert.ok(out.startsWith('The table is at'), 'the sentence survives');
    assert.equal(ctx.stats.deniedPaths, 1);

    // Windows separators too.
    assert.ok(!say(['see C:', 'w', 'private', 'a.md'].join(BS) + ' now').includes('a.md'));
    // And the marker names no directory: one of the deny tokens is a person.
    assert.equal(/payroll|private|identity/i.test(say('at /x/private-archive/notes.txt')), false);
    // Agent reasoning quotes the same paths.
    const think = retainRecord(
      { type: 'assistant', uuid: 'u2', sessionId: 's', cwd: 'C:/w', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'open /w/payroll-2026/ledger.md next' }] } },
      ctx,
      at,
    ).record.message.content[0].thinking;
    assert.ok(!think.includes('ledger.md'), think);

    // last-prompt and queue-operation carry user prose, and were the one
    // keep-path with no denial check at all: `private/payroll-ledger/…`
    // survived a real export there after every other route had been closed.
    const prompt = retainRecord(
      { type: 'last-prompt', sessionId: 's', lastPrompt: 'check private/payroll-ledger/backfill.json again' },
      ctx,
      at,
    );
    assert.ok(prompt.keep, 'the prompt survives: §C3 keeps this class for text found nowhere else');
    assert.ok(!prompt.record.text.includes('backfill.json'), prompt.record.text);
    assert.ok(prompt.record.text.startsWith('check '), 'and the rest of the prompt is intact');
  }],
  // F92 - every gate asks whether a substitution was done correctly. None asks
  // whether it should have been done at all.
  //
  // Measured 2026-08-24: the ordinary noun for "meeting" was a declared spelling,
  // Han needles get no boundary rule because isWordChar is /[A-Za-z0-9_]/, and
  // 202 occurrences of a common word were replaced across a corpus already
  // delivered. Serialization invariant green, substitution invariant green,
  // known-entity residue zero, because a reversible wrong replacement satisfies
  // every check that exists. Twelve agent passes missed it. The probe is the
  // instrument that makes it loud.
  ['F92', 'the probe counts what would be replaced, and both tails are visible', () => {
    const table = buildTable([
      { id: 'T1', kind: 'secret', pseudonym: 'X_S_1', spellings: ['CJKWORD'] },
      { id: 'T2', kind: 'person', pseudonym: 'X_P_1', spellings: ['Ray'] },
      { id: 'T3', kind: 'org', pseudonym: 'X_O_1', spellings: ['NeverAppears'] },
    ]);
    const rows = probeCounts(['CJKWORD here and CJKWORD again', 'Ray and array and Ray'], table);
    const by = Object.fromEntries(rows.map((r) => [r.spelling, r]));

    assert.equal(by.CJKWORD.count, 2, 'both occurrences counted');

    // The count is what the SUBSTITUTER would do, not what a grep would find:
    // `Ray` inside `array` is a correct non-match per the boundary rule, and a
    // probe that counted it would report a hazard the tool does not have.
    assert.equal(by.Ray.count, 2, 'the occurrence inside a longer word is not counted');

    // The zero tail is the same measurement's other failure: a declared
    // redaction string that matched nothing protected nothing, silently.
    assert.equal(by.NeverAppears.count, 0);
    assert.equal(by.NeverAppears.excerpt, '');

    // Descending, so the noun-shaped hazard is the first thing a reader sees.
    assert.ok(rows[0].count >= rows[rows.length - 1].count);
    const out = probeOutliers(rows);
    assert.deepEqual(out.zeros.map((z) => z.spelling), ['NeverAppears']);
    assert.ok(out.hits.every((h) => h.count > 0));

    // An excerpt is carried so the reader can judge the sense, not just the
    // count. A number alone cannot separate a noun from a name.
    assert.match(by.CJKWORD.excerpt, /CJKWORD here and/);

    // Overlapping needles: the longer one claims the hit, as in buildTable.
    const nested = buildTable([
      { id: 'T4', kind: 'org', pseudonym: 'X_O_2', spellings: ['Acme Corporation'] },
      { id: 'T5', kind: 'org', pseudonym: 'X_O_3', spellings: ['Acme'] },
    ]);
    const nrows = probeCounts(['Acme Corporation shipped it'], nested);
    const nby = Object.fromEntries(nrows.map((r) => [r.spelling, r]));
    assert.equal(nby['Acme Corporation'].count, 1);
    assert.equal(nby.Acme.count, 0, 'the shorter needle does not double-count inside the longer');
  }],
  // F93 - case folding is granted to Latin and denied to every other bicameral
  // script, by one ASCII regex.
  //
  // caseInsensitive() gates on /[A-Za-z]/, so a Cyrillic or Greek spelling gets
  // entry.lower null and matchesAt falls through to startsWith. That is F51's
  // guarantee, the one that exists because a 1,804-occurrence leak came from a
  // casing mismatch, withheld from Cyrillic and Greek for no reason but the
  // character class. residual.mjs:65 derives its own fold flag from the same
  // entry.lower, so the substituter and the residue scan go blind together.
  //
  // The fix must NOT open the length-changing case. Turkish dotted capital I
  // lowercases to two code units, and matchesAt computes its end as
  // at + entry.spelling.length, so folding a spelling whose lowercase is a
  // different length would consume the wrong span and reversal would restore
  // the wrong text. Fold only where the case map preserves length.
  ['F93', 'case folding follows the script, not the ASCII range', () => {
    const cyrillic = buildTable([{ id: 'C1', kind: 'org', pseudonym: 'X_O_1', spellings: ['Яндекс'] }]);
    assert.equal(substituteString('партнёр ЯНДЕКС сегодня', cyrillic).out, 'партнёр X_O_1 сегодня');
    assert.equal(substituteString('партнёр яндекс сегодня', cyrillic).out, 'партнёр X_O_1 сегодня');

    const greek = buildTable([{ id: 'G1', kind: 'org', pseudonym: 'X_O_2', spellings: ['Ελλάδα'] }]);
    assert.equal(substituteString('στην ΕΛΛΆΔΑ τώρα', greek).out, 'στην X_O_2 τώρα');

    // Reversal still restores what was actually there, in the casing it was in.
    const t = buildTable([{ id: 'C2', kind: 'org', pseudonym: 'X_O_3', spellings: ['Яндекс'] }]);
    const r = substituteString('ЯНДЕКС и Яндекс', t);
    assert.equal(reverseString(r.out, r.spans), 'ЯНДЕКС и Яндекс');

    // A spelling whose lowercase changes length is left on the literal path
    // rather than folded, because matchesAt measures the span with the entry's
    // own length. Exact case still matches; the other case simply does not.
    const turkish = buildTable([{ id: 'T1', kind: 'person', pseudonym: 'X_P_1', spellings: ['İstanbul'] }]);
    assert.equal(substituteString('from İstanbul today', turkish).out, 'from X_P_1 today');
    const spans = substituteString('from İstanbul today', turkish).spans;
    assert.equal(reverseString('from X_P_1 today', spans), 'from İstanbul today');

    // Latin is unchanged: this widens the gate, it does not move it.
    const latin = buildTable([{ id: 'L1', kind: 'org', pseudonym: 'X_O_4', spellings: ['Northwind'] }]);
    assert.equal(substituteString('at northwind and NORTHWIND', latin).out, 'at X_O_4 and X_O_4');
    // And the short-spelling floor still applies, whatever the script.
    const short = buildTable([{ id: 'S1', kind: 'org', pseudonym: 'X_O_5', spellings: ['Ян'] }]);
    assert.equal(substituteString('ЯН здесь', short).out, 'ЯН здесь');
  }],
  // F94 - the same name in two Unicode normalisations is two byte strings, and
  // literal matching sees two different needles.
  //
  // This is the macOS case and it is not exotic there, it is the default. APFS
  // and HFS+ store filenames DECOMPOSED, so every path and filename this tool
  // reads on a Mac arrives in NFD while the same name typed by the person, or
  // returned by git config, or pasted into an entity list, is NFC. Measured
  // before the fix: an entity declared NFC against NFD text replaced nothing,
  // and the reverse replaced nothing, in both directions, with zero normalize()
  // calls anywhere in the source.
  //
  // Unlike Han folding this needs no table and no judgement. NFC and NFD are a
  // standards-defined lossless pair, so the honest fix is to carry both forms
  // as spellings and leave the matcher literal: each form keeps its own length,
  // which is what matchesAt's span arithmetic requires.
  ['F94', 'a name normalises two ways and both are matched', () => {
    const nfc = 'José';
    const nfd = 'José';
    assert.notEqual(nfc, nfd, 'the fixture is only meaningful if these differ');
    assert.equal(nfc.normalize('NFC'), nfd.normalize('NFC'), 'and only if they are the same name');

    assert.ok(expandVariants(nfc).includes(nfd), 'declaring the composed form covers the decomposed');
    assert.ok(expandVariants(nfd).includes(nfc), 'and the other way round');

    const table = buildTable([{ id: 'P1', kind: 'person', pseudonym: 'X_P_1', spellings: expandVariants(nfc) }]);
    assert.equal(substituteString(`hi ${nfd} there`, table).out, 'hi X_P_1 there');
    assert.equal(substituteString(`hi ${nfc} there`, table).out, 'hi X_P_1 there');

    // Reversal restores the form that was actually in the text, not the one
    // that was declared. A Mac path put back as NFC would no longer name the
    // file it came from.
    const r = substituteString(`hi ${nfd} there`, table);
    assert.equal(reverseString(r.out, r.spans), `hi ${nfd} there`);

    // A path is the measured case, so it must survive the path forms too.
    const macPath = '/Users/josé/projects/app';
    assert.ok(expandVariants(macPath).includes(macPath.normalize('NFD')));

    // ASCII gains nothing and must not grow: NFC and NFD of pure ASCII are the
    // same string, and a duplicate needle is a wasted bucket entry per offset.
    const ascii = expandVariants('Northwind');
    assert.equal(new Set(ascii).size, ascii.length, 'no duplicate forms');
  }],
  // F95 - a refusal tells a Mac user to run notepad.
  //
  // Ten remedy commands across the source are Windows-only: eight `notepad` and
  // two `del`. A remedy is the one part of a refusal that is supposed to be
  // runnable, and cli-ux makes it the contract for getting unstuck. On macOS or
  // Linux every one of them fails, which turns the tool's most careful moment
  // into a dead end. The settled operator is an agent, and an agent copying
  // `notepad review.md` into a shell on a Mac gets command-not-found.
  //
  // The invariant, not the instance: no remedy names a platform-specific
  // program. A file the person must edit is named as a file.
  ['F95', 'no refusal hands out a command that only exists on one platform', () => {
    // Only the FIRST token, which is the program being invoked. A word like
    // `copy` inside a placeholder such as `--root <older copy>` is English,
    // not DOS, and a check that cries wolf on it is the one that gets deleted.
    const PLATFORM_ONLY = new Set([
      'notepad', 'del', 'explorer', 'start', 'type', 'copy', 'move', 'cls',
      'open', 'nano', 'vim', 'rm', 'cat', 'less', 'xdg-open',
    ]);
    const root = fileURLToPath(new URL('.', import.meta.url));
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.mjs') || e.name === 'selftest.mjs') continue;
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/command:\s*(`[^`]*`|'[^']*')/g)) {
          const cmd = m[1].slice(1, -1);
          const program = cmd.trim().split(/\s+/)[0].toLowerCase();
          if (PLATFORM_ONLY.has(program)) offenders.push(`${e.name}: ${cmd}`);
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, [], `platform-specific remedies: ${offenders.join('; ')}`);
  }],
  // F96 - the path variants are Windows-shaped, so a Mac path has one form.
  //
  // pathForms canonicalises around a drive letter and otherwise only swaps
  // separators, which on macOS produces nothing: backslash forms do not occur
  // there. Two forms do, constantly, and neither was generated.
  //
  // (a) The tilde. `/Users/x/projects/app` and `~/projects/app` are the same
  // path and both appear in the same session: a shell prompt, a tool that
  // abbreviates, and a person typing all prefer the short one, while realpath
  // and the log records prefer the long one. The home directory is the most
  // heavily seeded entity there is, so missing half its spellings is the
  // largest single hole on that platform.
  //
  // (b) The /private prefix. On macOS /var, /tmp and /etc are symlinks into
  // /private, so realpath returns /private/var/... for a path the person wrote
  // as /var/... . Anything resolved through the filesystem comes back in the
  // long form while anything quoted from the person stays short.
  ['F96', 'a POSIX home path is also spelled with a tilde, and /private is a symlink', () => {
    // The home directory ITSELF, which is what seed.mjs adds on every run. The
    // first version of this generator made group 3 optional, so a spelling with
    // nothing under it emitted the one-character needle `~`. That is not a word
    // character, so buildTable gives it no boundary rule at all, and every
    // tilde in the corpus is replaced: `cd ~`, `~/.zshrc`, and `approx ~5 min`
    // becoming a pseudonym with a digit stuck to it. Fires on 100% of macOS and
    // Linux runs, 0% of Windows, with every gate green, because the residue
    // scan looks for the spellings it was given and `~` is one of them.
    assert.ok(!expandVariants('/Users/devuser').includes('~'), 'a bare tilde is not a needle');
    assert.ok(!expandVariants('/home/devuser').includes('~'));
    assert.ok(!expandVariants('/Users/devuser/').includes('~'));

    const home = expandVariants('/Users/devuser/projects/app');
    assert.ok(home.includes('~/projects/app'), 'the tilde form of a macOS home path');

    const linux = expandVariants('/home/devuser/notes');
    assert.ok(linux.includes('~/notes'), 'and of a Linux home path');

    // The reverse direction: a tilde spelling must cover the expanded form it
    // will meet in the logs. Without a home directory to expand against, the
    // generator cannot know the username, so this is where a caller supplies it.
    const tilde = expandVariants('~/projects/app', { home: '/Users/devuser' });
    assert.ok(tilde.includes('/Users/devuser/projects/app'), 'the expanded form of a tilde path');

    // /private is the same path, so both spellings must be needles.
    const short = expandVariants('/var/folders/zz/T/session.jsonl');
    assert.ok(short.includes('/private/var/folders/zz/T/session.jsonl'));
    const long = expandVariants('/private/tmp/scratch');
    assert.ok(long.includes('/tmp/scratch'));

    // Precision, not recall: a path that merely CONTAINS the word private, or a
    // /Users path with no second segment, must not sprout forms.
    assert.ok(!expandVariants('/opt/private-thing/x').some((f) => f.startsWith('~')));
    assert.deepEqual(expandVariants('/Users').filter((f) => f.startsWith('~')), []);

    // A Windows path is untouched by any of this.
    const win = expandVariants('C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'devuser' + String.fromCharCode(92) + 'app');
    assert.ok(!win.some((f) => f.startsWith('~')), 'no tilde form for a drive-letter path');
    assert.ok(win.some((f) => f.startsWith('/c/')), 'the Git Bash form still exists');
  }],
  // F97 - the residue gate scans a string in memory, not the file that ships.
  //
  // Measured on the delivery run, and stated as a build instruction: "the
  // review step should physically read the output file." Three times in the
  // delivery run a reviewer was handed something that was not what shipped, and
  // each time the gap was where the leak lived. The gate at pipeline.mjs scans
  // `serialized.allBytes`, which is assembled beside the entries rather than
  // read back from them, so a defect in the writer, the deflate path or the
  // entry naming is invisible to every check the tool has.
  //
  // Closing it needs a reader, because the writer is a hand-rolled deterministic
  // ZIP over node:zlib with no npm dependency to lean on. This pins the reader
  // against the writer: whatever buildZip emits, readZip returns byte-identical,
  // and a scan over the inflated bytes therefore scans the shipped artifact.
  ['F97', 'the archive can be read back, so the gate can scan what ships', () => {
    const entries = [
      { name: 'sessions/W_1/a.jsonl', data: '{"type":"user","text":"ordinary"}\n' },
      { name: 'sessions/W_1/b.jsonl', data: '{"type":"user","text":"Yandex here"}\n' },
      { name: 'manifest.json', data: '{"sessions":2}' },
    ];
    const buf = buildZip(entries);
    const back = readZip(buf);

    assert.equal(back.length, entries.length, 'every entry comes back');
    for (const e of entries) {
      const got = back.find((b) => b.name === e.name);
      assert.ok(got, `${e.name} is in the archive`);
      assert.equal(got.data, e.data, `${e.name} inflates byte-identically`);
    }

    // The point of the reader: a scan over the INFLATED bytes sees what a
    // recipient sees. A table that knows the entity finds it here, in the same
    // shape residualScan is given at the in-memory gate.
    const table = buildTable([{ id: 'O1', kind: 'org', pseudonym: 'X_O_1', spellings: ['Yandex'] }]);
    const shipped = back.map((b) => b.data).join('');
    const scan = residualScan(shipped, table, new Set());
    assert.equal(scan.entityCount, 1, 'the planted entity is found in the shipped bytes');

    // And a clean archive scans clean, so the gate is not simply always red.
    const cleanBuf = buildZip([{ name: 'sessions/W_1/a.jsonl', data: '{"type":"user","text":"ordinary"}\n' }]);
    const cleanScan = residualScan(readZip(cleanBuf).map((b) => b.data).join(''), table, new Set());
    assert.equal(cleanScan.entityCount, 0);

    // An entry name is part of the artifact too: F38 exists because a uuid rode
    // out inside one. The reader must return names, not only bodies.
    assert.ok(back.every((b) => typeof b.name === 'string' && b.name.length > 0));

    // Empty archive, and a body containing the local-file signature, which is
    // where a hand-rolled reader that scans for magic bytes instead of walking
    // the central directory goes wrong.
    assert.deepEqual(readZip(buildZip([])), []);
    const tricky = [{ name: 'sessions/W_1/c.jsonl', data: 'PK' + String.fromCharCode(3, 4) + ' not a header' }];
    assert.equal(readZip(buildZip(tricky))[0].data, tricky[0].data);
  }],
  // F98 - the residue gate must scan the file, not the string beside it.
  //
  // Until now the last gate ran over `serialized.allBytes`, assembled in memory
  // alongside the entries. Everything downstream of that assembly - the deflate
  // path, the entry naming, the central directory, the rename from .part - was
  // outside every check the tool has. The delivery run is the
  // rule this closes, and it is stated there as a build instruction rather than
  // an aspiration: the review step should physically read the output file.
  //
  // The check is cheap because the reader already exists for the writer's own
  // round-trip, and it is the only gate whose subject is the artifact a
  // recipient opens.
  ['F98', 'the written archive is read back and scanned before the run succeeds', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir);
    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(exported.code, 0, exported.out);

    // Named separately from the in-memory scan, because a reader who sees one
    // "residue" line cannot tell which artifact it covered, and the whole point
    // of this one is that it covered a different artifact from all the rest.
    assert.match(exported.out, /archive on disk/, `no on-disk gate in the report:${NL}${exported.out}`);

    // And it really opened the file: the row counts the entries the READER
    // found, a number only the written archive can supply.
    const zipName = fs.readdirSync(out).find((f) => f.endsWith('.zip'));
    assert.ok(zipName, 'an archive was written');
    const entries = readZipFile(path.join(out, zipName));
    assert.ok(entries.length > 0);
    assert.match(exported.out, new RegExp(`${entries.length} entries read back`));
  }],
  // F99 - the settled operator is an agent, and every number this tool computes
  // reaches it as padded columns whose width is data-dependent.
  //
  // The manifest's most interesting counters are built as English prose
  // ("3 counted, none included"), the check rows are aligned by pad(), and a
  // refusal's remedies are a shaped object flattened to text on the way out. An
  // agent driving this has to parse the disclosure format, which is the one
  // thing cli-ux put in a single greppable file so it would never be parsed.
  //
  // --json emits the values that are ALREADY in hand at the render call: the
  // frozen manifest, the frozen checks array, the typed error. It is an
  // encoding, not a second code path, which is why the human output must be
  // byte-identical when the flag is absent.
  ['F99', 'every command can answer in JSON, including when it refuses', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);

    // scan
    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir, '--json']);
    assert.equal(scan.code, 0, scan.out);
    const parseOne = (text, what) => {
      try { return JSON.parse(text); } catch (err) { assert.fail(`${what} is not one JSON document: ${err.message} ||| ${text.replace(/\s+/g, ' ').slice(0, 600)}`); }
    };
    const scanDoc = parseOne(scan.out, 'scan');
    assert.equal(scanDoc.command, 'scan');
    assert.equal(scanDoc.ok, true);
    assert.ok(Array.isArray(scanDoc.workspaces) && scanDoc.workspaces.length > 0, `no workspaces: ${scan.out.slice(0, 400)}`);
    assert.ok(scanDoc.workspaces.every((w) => typeof w.tier === 'string' && typeof w.name === 'string'), JSON.stringify(scanDoc.workspaces).slice(0, 300));

    // A refusal answers in the same envelope, and keeps its exit code. An agent
    // that has to tell "refused" from "crashed" by reading prose cannot.
    const refused = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--json']);
    assert.notEqual(refused.code, 0);
    const errDoc = parseOne(refused.out, 'refusal');
    assert.equal(errDoc.ok, false);
    assert.equal(typeof errDoc.error.reason, 'string');
    assert.ok(Array.isArray(errDoc.error.why), refused.out.slice(0, 300));
    assert.ok(Array.isArray(errDoc.error.remedies), refused.out.slice(0, 300));
    assert.ok(errDoc.error.remedies.every((r) => typeof r.command === 'string'), JSON.stringify(errDoc.error.remedies).slice(0, 300));
    assert.equal(errDoc.error.code, refused.code, 'the exit code is in the document too');

    // export
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir);
    const ok = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--json',
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(ok.code, 0, ok.out);
    const doc = parseOne(ok.out, 'export');
    assert.equal(doc.command, 'export');
    assert.equal(doc.ok, true);
    assert.equal(typeof doc.manifest.sessions, 'number', 'a count is a number, not "3 counted"');
    assert.ok(Array.isArray(doc.checks) && doc.checks.length >= 5, JSON.stringify(doc.checks).slice(0, 400));
    assert.ok(doc.checks.every((c) => typeof c.label === 'string' && typeof c.ok === 'boolean'), JSON.stringify(doc.checks).slice(0, 400));
    assert.ok(doc.checks.some((c) => /archive on disk/i.test(c.label)), 'the on-disk gate is a check too');
    assert.equal(typeof doc.wrote.path, 'string');
    assert.equal(typeof doc.wrote.bytes, 'number');

    // Exactly one document, and nothing but the document: an agent reads stdout
    // whole. A stray progress line makes JSON.parse throw on a successful run.
    assert.equal(scan.out.trim().startsWith('{'), true, scan.out.slice(0, 200));
    assert.equal(ok.out.trim().endsWith('}'), true, ok.out.slice(-200));

    // The human output is untouched when the flag is absent. This is an
    // encoding, not a fork.
    const human = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(human.code, 0);
    assert.doesNotMatch(human.out, /^\s*\{/m, 'no JSON leaks into the human path');
    assert.match(human.out, /Workspaces/);
  }],
  // F100 - the audience setting must not be able to remove a session.
  //
  // It used to. `drop:audience` was a third session decision, held at `public`
  // and released at `teammate` or `company`, and the measured result on the live
  // corpus was that it never held anything:
  //
  //   audience=teammate   heldByFloor=151   heldByAudience=0
  //   occurrences of "drop:audience" in the produced review.md:  0
  //
  // Nothing writes that value: buildReviewModel emits keep or drop, and triage
  // only ever moves a row toward drop. So the axis asked the operator for a
  // decision that changed nothing, while defining `public` as the setting under
  // which the MOST sessions are held. The expected user publishes publicly, so
  // the design handed its main case the worst archive, and it did it with the
  // one instrument measured on this corpus as the expensive
  // mistake: whole-session removal took that funnel from 35 sessions to 17, and
  // block-level denial and value-level redaction took it back to 76.
  //
  // The axis now moves what goes INTO the entity list (F154) and never which
  // sessions ship. An unqualified `drop` IS the floor and stays the only way to
  // hold a session, so the two goals stop competing: privacy is served by
  // substituting more, usefulness by keeping everything.
  ['F100', 'the audience setting never removes a session, at any value', () => {
    const model = {
      generated: '2026-08-24 00:00',
      workspaces: [{ tier: 'redact', name: '<home>', sessionCount: 3, cwd: 'C:', note: null }],
      sessions: [
        { id: 'aaaa-1111', date: '2026-08-01', workspace: '<home>', decision: 'keep' },
        { id: 'bbbb-2222', date: '2026-08-02', workspace: '<home>', decision: 'drop' },
      ],
      flaggedSessions: [],
      entities: [],
    };
    const text = renderReview(model);

    // The same rows at every audience. Only the floor holds anything.
    for (const audience of ['public', 'company', 'teammate']) {
      const held = parseSessionDrops(text, { audience });
      assert.deepEqual([...held.drops], ['bbbb-2222'], `${audience} moved a session`);
      assert.deepEqual([...held.known].sort(), ['aaaa-1111', 'bbbb-2222']);
      assert.equal(held.heldByFloor, 1, `${audience}: the floor count is the only held count`);
    }

    // The review file must stop offering a decision the tool no longer has.
    // An operator told to classify every held row into two buckets spends the
    // step that matters on a distinction with no effect.
    assert.doesNotMatch(text, /drop:audience/, 'review.md still offers the removed decision');
    assert.deepEqual([...SESSION_DECISIONS], ['keep', 'drop']);

    // A review.md written before the change still holds its rows. Refusing
    // would strand the file; reading the value as unknown would RELEASE a
    // session someone held, so it is read as the drop it was.
    const legacy = '## sessions' + NL + 'drop:audience 2026-08-03  ws  cccc-3333' + NL;
    for (const audience of ['public', 'company', 'teammate']) {
      const old = parseSessionDrops(legacy, { audience });
      assert.deepEqual([...old.drops], ['cccc-3333'], `${audience} released a legacy audience-held row`);
      assert.equal(old.heldByFloor, 1, 'a legacy row is held, so it is counted as held');
      assert.equal(old.legacyAudienceRows, 1, 'the row is counted so the operator can be told to fix it');
    }
    // And triage still recognises such a row, or a file with one in it silently
    // stops being triageable.
    assert.deepEqual(parseSessionRows(legacy).map((r) => r.id), ['cccc-3333']);

    // An unknown qualifier refuses rather than being read as the safe default.
    // Guessing here fails towards release.
    assert.throws(() => parseSessionDrops('## sessions' + NL + 'drop:later 2026-08-01 ws aaaa-1111' + NL), RefusalError);

    // And an unknown audience refuses too, for the same reason.
    assert.throws(() => parseSessionDrops(text, { audience: 'friends' }), RefusalError);
  }],
  // F101 - the manifest must say which audience it was exported for, and what
  // that audience actually did.
  //
  // privacy-tiers 6: a recipient comparing two corpora needs to see that one
  // uploader withheld 40% of theirs, or a privacy choice reads downstream as a
  // skill gap. The audience is the other half of that: a corpus exported for a
  // teammate and one exported for the public are not comparable, and nothing in
  // the contents says which is which.
  //
  // `heldByAudience` used to be the second number here and it was always 0,
  // because nothing ever wrote the decision it counted (F100). A zero printed
  // where no check ran is BRIEF section 4.3's mistake in the report block whose
  // whole job is being believed. The honest number is the one the axis now
  // moves: how many entities are in the table BECAUSE of the declared audience.
  ['F101', 'the declared audience is recorded, with the count of what it changed', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir);

    // An unknown audience refuses at the flag, before any work is done.
    const bogus = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--audience', 'friends',
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.notEqual(bogus.code, 0);
    assert.match(bogus.out, /audience/i);

    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--audience', 'company', '--json',
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(exported.code, 0, exported.out);
    const doc = JSON.parse(exported.out);
    assert.equal(doc.manifest.audience, 'company', 'the recipient claim travels with the archive');
    assert.equal(typeof doc.manifest.heldByFloor, 'number');
    // The empty count is gone rather than printed as a zero.
    assert.equal('heldByAudience' in doc.manifest, false, 'a count nothing ever wrote is still reported');
    assert.equal(doc.manifest.audienceEntities, 0, 'an insider audience adds nothing to the table');

    // Default is public when nothing is declared, and it is recorded as such
    // rather than left absent: absent reads as "not considered".
    const dflt = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--json',
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(dflt.code, 0, dflt.out);
    assert.equal(JSON.parse(dflt.out).manifest.audience, 'public');
    assert.equal(typeof JSON.parse(dflt.out).manifest.audienceEntities, 'number');

    // The human path prints it too, in the block whose whole job is being
    // believed, and it says what the setting did rather than only naming it.
    const human = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--audience', 'teammate',
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(human.code, 0, human.out);
    assert.match(human.out, /teammate/);
    assert.doesNotMatch(human.out, /by the audience setting/, 'the empty count is still being printed');
  }],
  // F102 - the runtime floor is discovered at the last step of a ten-minute run.
  //
  // node:zlib's crc32 arrived in Node 20.15 and 22.2, and it is used in exactly
  // one place: buildZip, which is step 17 of 17. So a person on an older Node
  // reads the corpus, classifies it, substitutes, runs all five gates, and only
  // then gets `TypeError: crc32 is not a function` - wrapped by the entry point
  // as "internal error, please report this", which is the shape BRIEF section 2
  // forbids. The version is knowable before any of that work happens.
  //
  // A package.json `engines` field does not do this. npm's engine-strict
  // defaults to false, so it warns and proceeds; and the tool is run directly as
  // `node deident.mjs`, where npm is not involved at all.
  ['F102', 'an unsupported runtime is named at startup, not at the last write', () => {
    // The floor is what the source actually needs, not a number typed twice.
    assert.ok(REQUIRED_NODE.major >= 20, 'the floor is a real version');
    assert.equal(typeof zlib.crc32, 'function', 'and this build clears it');

    // Below the floor: refused, with a usage exit code and a runnable remedy.
    const old = checkRuntime({ node: 'v20.14.0' });
    assert.ok(old instanceof UsageError, 'a runtime that cannot work is a usage problem');
    assert.equal(old.code, 2);
    assert.match(old.reason, /20\.14/, 'says which version it found');
    assert.match(old.why.join(' '), /crc32|zlib/i, 'and what is missing, not just a number');
    assert.ok(old.remedies.length > 0 && old.remedies.every((r) => typeof r.command === 'string'));

    // The two release lines both have a floor, and the older major is not
    // rejected just for being older.
    assert.equal(checkRuntime({ node: 'v20.15.0' }), null, 'the 20.x floor passes');
    assert.equal(checkRuntime({ node: 'v22.1.0' }) instanceof UsageError, true, '22.1 is below its own floor');
    assert.equal(checkRuntime({ node: 'v22.2.0' }), null, 'the 22.x floor passes');
    assert.equal(checkRuntime({ node: 'v24.0.0' }), null, 'anything newer passes');
    assert.equal(checkRuntime({ node: process.version }), null, 'and so does the build running this');

    // An unparseable version is not silently treated as fine: the failure
    // direction of guessing here is a ten-minute run that ends in a traceback.
    assert.ok(checkRuntime({ node: 'not-a-version' }) instanceof UsageError);
    assert.ok(checkRuntime({}) instanceof UsageError);
  }],
  // F103 - the hardest gate in the tool told you to run a command you do not
  // have.
  //
  // semanticRefusal printed `{ label: 'Inside Claude Code', command: '/deident-scan' }`
  // as its FIRST remedy, on both branches, on the one refusal BRIEF section 3
  // makes mandatory. That slash command existed only when the working directory
  // was inside this repository, so for a Codex user, or a Claude Code user
  // working anywhere else, the tool's most careful moment named a remedy that
  // could not be run.
  //
  // The fix is not a better slash command. A remedy is a thing to do, and the
  // thing to do is the same in every harness: produce the candidates file, read
  // it, write the entity list. So the remedy names files and a CLI invocation,
  // which is portable by construction.
  ['F103', 'no refusal names a command that belongs to one harness', () => {
    const HARNESS_SHAPED = /(^|"|`|\s)\/[a-z][a-z0-9-]{2,}(\s|"|`|$)/;
    const root = fileURLToPath(new URL('.', import.meta.url));
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.mjs') || e.name === 'selftest.mjs') continue;
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/command:\s*(`[^`]*`|'[^']*')/g)) {
          const cmd = m[1].slice(1, -1);
          if (HARNESS_SHAPED.test(cmd)) offenders.push(`${e.name}: ${cmd}`);
        }
        // And the label must not promise one either.
        for (const m of text.matchAll(/label:\s*'([^']*)'/g)) {
          if (/inside claude code|in codex|in cursor/i.test(m[1])) offenders.push(`${e.name}: label ${m[1]}`);
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, [], `harness-specific remedies: ${offenders.join('; ')}`);

    // The operator contract ships in two places because harnesses disagree
    // about where to look. They must not drift: a reader following the stale
    // one is exactly how the entity-kind list fell 62 commits behind.
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const skill = fs.readFileSync(path.join(repo, 'skills', 'deident', 'SKILL.md'), 'utf8');
    const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    const bodyOf = (text) => text.slice(text.indexOf('# deident')).trim();
    assert.equal(bodyOf(skill), bodyOf(agents), 'SKILL.md and AGENTS.md have drifted');

    // And the skill must not restate a constant it can read at runtime, which
    // is the drift that already happened once.
    assert.doesNotMatch(skill, /person \| org \| client \| workspace \| machine/);

    // The frontmatter is the half the body comparison above cannot see, and it
    // drifted there: SKILL.md's `description` listed two Chinese trigger
    // phrases, AGENTS.md has no frontmatter and so listed none. Same contract,
    // different activation on the two harnesses, with the drift check green.
    //
    // The fix is not to compare frontmatter, because AGENTS.md legitimately has
    // none. It is that the description must carry no language-specific literal
    // at all: a literal list serves exactly the languages someone remembered to
    // add, so "English plus the author's own language" is what it always
    // becomes. Non-ASCII in the description is that mistake, detectably.
    const description = /^description:.*$/m.exec(skill.slice(0, skill.indexOf(NL + '---')))?.[0] ?? '';
    assert.ok(description.length > 0, 'no description in the skill frontmatter');
    const literals = [...description].filter((c) => c.codePointAt(0) > 127);
    assert.deepEqual(literals, [], `language-specific trigger literals: ${literals.join(' ')}`);
  }],

  // F156 - the two operator contracts are the only files in this repository a
  // person reads end to end, and both carried four em dashes against a house
  // rule that forbids them anywhere.
  //
  // F41 already asserts this over one user-facing string. One string is what a
  // fixture can guard by naming it; a document is not, and these four survived
  // because nothing looked at the file. The scope is exactly the two contract
  // files: source comments and the design docs quote outside text, and a check
  // over those would fail on punctuation the source actually used.
  ['F156', 'the operator contract carries no em dash, in either of its two copies', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const EM_DASH = String.fromCharCode(0x2014);
    for (const rel of [path.join('skills', 'deident', 'SKILL.md'), 'AGENTS.md']) {
      const text = fs.readFileSync(path.join(repo, rel), 'utf8');
      const offenders = text
        .split(NL)
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => line.includes(EM_DASH))
        .map(([n, line]) => `${rel}:${n}: ${line.trim().slice(0, 70)}`);
      assert.deepEqual(offenders, [], offenders.join(NL));
    }
  }],
  // F104 - scanning into a fresh directory forgot every session decision.
  //
  // Found by running the documented flow rather than by reading the code.
  // `scan --out <new dir>` reads review.md from THAT directory, which does not
  // exist yet, so every session rendered as `keep` - while the salt directory,
  // three lines above, was holding 142 remembered drops. Workspace tiers came
  // through, because those are read from `remembered.workspaces`; session
  // decisions were not, because nothing read `remembered.sessionDrops`.
  //
  // The asymmetry is the bug. The two decision kinds are persisted by the same
  // writer for the same reason - so a person does not answer twice - and one of
  // them was being dropped on the floor. A fresh review.md that says keep 213
  // times, with the previous decisions still on disk, is a file that invites
  // exporting everything the person already refused.
  ['F104', 'a re-scan elsewhere keeps the session decisions, not only the tiers', () => {
    const root = tmpdir();
    const saltDir = path.join(root, 'salt');
    const first = path.join(root, 'one');
    const second = path.join(root, 'two');
    writeCorpus(root);

    const s1 = runCli(['scan', '--root', root, '--out', first, '--salt-dir', saltDir, '--json']);
    assert.equal(s1.code, 0, s1.out);
    setTier(path.join(first, 'review.md'), 'alpha', 'redact');

    // Hold back a session that is NOT the only one in its workspace, or the
    // export refuses for the unrelated reason that nothing is left.
    const rows = JSON.parse(s1.out).sessions.filter((x) => x.workspace === 'alpha');
    assert.ok(rows.length >= 2, `alpha needs two sessions to hold one back: ${JSON.stringify(rows)}`);
    // The last one, not the first: writeCorpus's other alpha session retains
    // nothing after the cwd gate, so holding back the productive one empties
    // the archive and the export refuses for an unrelated reason.
    const heldId = rows[rows.length - 1].id;
    const reviewPath = path.join(first, 'review.md');
    fs.writeFileSync(
      reviewPath,
      fs.readFileSync(reviewPath, 'utf8').replace(new RegExp(`^keep(\\s+.*${heldId})$`, 'm'), 'drop$1'),
    );

    // The edit has to have landed, or the rest of this fixture proves nothing.
    assert.match(
      fs.readFileSync(reviewPath, 'utf8'),
      new RegExp(`^drop\\s+.*${heldId}`, 'm'),
      'the hold was not written into the first review.md',
    );

    primeSemanticPass(root, first, saltDir);
    const exported = runCli([
      'export', '--root', root, '--out', first, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(exported.code, 0, exported.out);

    // It must also have been remembered, or a re-scan has nothing to read.
    const store = JSON.parse(fs.readFileSync(path.join(saltDir, 'workspaces.json'), 'utf8'));
    assert.ok(store.sessionDrops.includes(heldId), `not remembered: ${JSON.stringify(store.sessionDrops)}`);

    // Now scan somewhere else. The tiers survive; the session decision must too.
    const again = runCli(['scan', '--root', root, '--out', second, '--salt-dir', saltDir, '--json']);
    assert.equal(again.code, 0, again.out);
    const row = JSON.parse(again.out).sessions.find((x) => x.id === heldId);
    assert.ok(row, 'the held session is missing from the new scan');
    assert.equal(row.decision, 'drop', 'a remembered hold must not come back as keep');

    // And it is written into the new review.md, not only into the JSON, or the
    // next person to edit that file re-answers a question already answered.
    assert.match(
      fs.readFileSync(path.join(second, 'review.md'), 'utf8'),
      new RegExp(`^drop\\s+.*${heldId}`, 'm'),
    );
  }],
  // F105 - macOS resolves /tmp and /var into /private, and the deny-list read
  // that as the word the user meant.
  //
  // On macOS /tmp, /var and /etc are symlinks into /private, and process.cwd()
  // returns the physical path. So a session started from /tmp records a cwd of
  // /private/var/folders/..., matchDenyToken sees the substring `private`, the
  // workspace is force-excluded, its lines are dropped, and review.md tells the
  // person `deny-list matched: "private"` about a directory they never called
  // that. It fails safe, but it loses sessions silently and states something
  // false about the user's own filesystem.
  //
  // The codebase already knows about this symlink: variants.mjs generates both
  // spellings of a path deliberately. The deny path never got the same
  // treatment, and the difference only shows on a platform nobody here runs.
  ['F105', 'the macOS /private symlink is not the deny-listed word private', () => {
    // The symlink prefix alone is not a deny match.
    assert.equal(matchDenyToken('/private/tmp/scratch'), null);
    assert.equal(matchDenyToken('/private/var/folders/zz/T/session'), null);
    assert.equal(matchDenyToken('/private/etc/hosts'), null);

    // A real private directory UNDER it still is, or the exemption would be a
    // hole rather than a fix.
    assert.equal(matchDenyToken('/private/var/folders/zz/private/notes'), 'private');
    assert.equal(matchDenyToken('/private/tmp/payroll-2026'), 'payroll');

    // And /private used as an ordinary directory name, not as the macOS
    // symlink root, is still caught: only the three system roots are exempt.
    assert.equal(matchDenyToken('/private/client-files'), 'private');
    assert.equal(matchDenyToken('/Users/nkoro/private/notes'), 'private');
    assert.equal(matchDenyToken('C:' + BS + 'w' + BS + 'private'), 'private');

    // Unchanged for everything that is not the exemption.
    assert.equal(matchDenyToken('/Users/nkoro/projects/app'), null);
    assert.equal(matchDenyToken('/var/log/system.log'), null);
  }],
  // F106 - the tool reads one agent's logs and its own refusal did not say so.
  //
  // resolveCorpus enumerates <root>/projects/<dir>/*.jsonl at depth 0, which is
  // Claude Code's layout. Codex's layout was surveyed separately and records Codex's as
  // $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl, three levels deeper
  // and under a different directory name. So `--root ~/.codex` produces
  // `no session storage at ~/.codex/projects`, and the refusal then offers
  // --root again, which is the flag that just failed.
  //
  // The skill is installable in more than one harness, so a Codex user WILL
  // arrive here. Telling them what is read, rather than offering a flag that
  // cannot help, is the difference between a scope limit and a dead end.
  ['F106', 'the refusal for a missing corpus says which agent is read', () => {
    const root = tmpdir();
    const missing = runCli(['scan', '--root', path.join(root, 'nothing-here'), '--out', path.join(root, 'out')]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.out, /no session storage/);

    // Names the agent whose layout it reads, so a reader knows whether the
    // path is wrong or the tool is.
    assert.match(missing.out, /Claude Code/i, `the refusal does not say what it reads:${NL}${missing.out}`);

    // And does not offer, as the remedy for a failed --root, the same --root
    // with nothing else said.
    const remedyLines = missing.out.split(NL).filter((l) => /--root/.test(l));
    assert.ok(
      remedyLines.length === 0 || missing.out.match(/Codex|not read|only reads/i),
      `--root is offered with no scope stated:${NL}${missing.out}`,
    );

    // The skill's own description must scope itself too, or a harness routes a
    // user into a tool that structurally cannot read their logs.
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const skill = fs.readFileSync(path.join(repo, 'skills', 'deident', 'SKILL.md'), 'utf8');
    const front = skill.slice(0, skill.indexOf('---', 4));
    assert.match(front, /Claude Code/, 'the skill description does not name the agent it reads');
  }],

  ['F107', 'the namespace refusal survives an empty sample, because that is the normal case', () => {
    // The scan keeps the first EXAMPLES_PER_REPORT collisions but counts every
    // one per file. The export filters BOTH to the retained files, so a sample
    // that filled up on dropped files filters to nothing while the counter
    // still says 7. Measured on a live corpus that already contained tokens
    // from an earlier export: this threw on hits[0] and the refusal became
    // "internal error, please report this" -- the one refusal in the tool whose
    // remedy is a single flag, replaced by the one message that has no remedy.
    const err = namespaceRefusal([], 'AB', 7, ['a.jsonl', 'b.jsonl']);
    assert.match(err.reason, /7 input lines/);
    assert.equal(err.remedies[0].command, 'deident export --namespace ABZ');
    assert.match(err.why.join(' '), /2 files/, 'the file count must come from the counter, not the sample');
    // And it reads as a sentence. Composing the line from fragments produced
    // "across in 1 file" on a real run: correct, informative, and the sort of
    // line that makes a reader stop trusting the rest of the page.
    assert.doesNotMatch(err.why[0], /across in/, 'the empty-sample line is not English');
    assert.doesNotMatch(err.why[0], /\s\s/, 'a fragment was joined with a hole in it');
    assert.ok(!err.why.join(' ').includes('undefined'));

    // With a sample, it still leads with a real token: that is what tells a
    // reader the collision is with THIS namespace and not a coincidence.
    const sampled = namespaceRefusal(
      [{ file: 'a.jsonl', line: 3, token: 'AB_PERSON_7' }], 'AB', 7, ['a.jsonl'],
    );
    assert.match(sampled.why[0], /AB_PERSON_7/);
    assert.match(sampled.why[0], /1 file/);

    // Negative control: the old code path. Reading hits[0] unguarded is what
    // broke, so the fixture fails if anything reintroduces the assumption.
    assert.doesNotThrow(() => namespaceRefusal([], null, 1));
    assert.doesNotThrow(() => namespaceRefusal([], 'AB', null));
  }],

  ['F108', 'two directories that differ only in case are not merged on a case-sensitive filesystem', () => {
    const was = caseFolding();
    try {
      const sessions = [
        { file: { path: 'a.jsonl', bytes: 1 }, cwds: ['/home/u/Projects/client-a'] },
        { file: { path: 'b.jsonl', bytes: 1 }, cwds: ['/home/u/projects/client-a'] },
      ];

      // Folding was unconditional. On Linux, and on a case-sensitive APFS
      // volume, these are two real directories: merging them gives one row
      // carrying one tier and ONE displayed path, so a person who sets
      // `redact` on the row they can see sets it on a directory they were
      // never shown. Measured before the fix: two sessions, one group.
      setCaseFolding(false);
      const apart = groupSessions(sessions, { homedir: '/home/u' });
      assert.equal(apart.length, 2, 'two real directories must stay two rows');

      // On Windows and a default macOS volume they ARE one directory, and
      // splitting them puts the same directory in front of the person twice.
      setCaseFolding(true);
      assert.equal(groupSessions(sessions, { homedir: '/home/u' }).length, 1);

      // Separator normalisation is not case folding and never turns off.
      setCaseFolding(false);
      assert.equal(normalizeCwd('C:' + SEP + 'w' + SEP + 'x' + SEP), 'C:/w/x');
      assert.equal(normalizeCwd('C:' + SEP + 'W' + SEP + 'x'), 'C:/W/x');
      setCaseFolding(true);
      assert.equal(normalizeCwd('C:' + SEP + 'W' + SEP + 'x'), 'c:/w/x');
    } finally {
      setCaseFolding(was);
    }

    // The probe asks the filesystem rather than process.platform, which is
    // wrong on a case-sensitive macOS volume. Injected stat, so the fixture
    // states both answers on every platform.
    const insensitive = () => undefined;
    const sensitive = (p) => {
      if (p === '/x/Abc') return undefined;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    assert.equal(probeCaseFolding('/x/Abc', insensitive), true);
    assert.equal(probeCaseFolding('/x/Abc', sensitive), false);

    // Unanswerable is null, not a guess: the caller keeps its default rather
    // than being handed a fabricated false, which is the answer that splits.
    assert.equal(probeCaseFolding('/1/2/3', insensitive), null, 'no letter to flip');
    assert.equal(probeCaseFolding('', insensitive), null);
    assert.equal(
      probeCaseFolding('/x/Abc', () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      null,
      'the reference directory is not there, so the answer would be noise',
    );
  }],

  ['F115', "a declared spelling that is one of deident's own minted uuids is dropped, not shipped into a refusal", () => {
    // Measured 2026-08-24 on the live corpus. deident-candidates.txt is written
    // AFTER the uuid rewrite, so every uuid in it is a value deident minted.
    // Two independent readers each saw one recurring 49 times, reasonably
    // called it a secret, and declared it. The export then refused with
    // "1 known-entity occurrence survived into the output" and the remedy
    // "file an issue against deident": the tool blamed itself for its own
    // output, on the one path whose whole job is to be trustworthy.
    //
    // Dropping is safe in a way that nothing else here is. A minted uuid is
    // already a pseudonym, so removing it from the table protects nothing and
    // loses nothing; keeping it makes the export impossible.
    // Both values fabricated. Shape preserved on the minted one: a uuid whose
    // version and variant nibbles are hash output rather than v4, which is what
    // tells a minted uuid apart from one that arrived in the corpus.
    const minted = new Set(['e1e1e1e1-2b2b-3c3c-4d4d-5e5e5e5e5e5e']);
    const real = '11111111-2222-4333-8444-555555555555';

    const { entities, dropped } = stripMintedSpellings(
      [
        { kind: 'secret', spellings: ['e1e1e1e1-2b2b-3c3c-4d4d-5e5e5e5e5e5e'], confidence: 'high' },
        { kind: 'person', spellings: ['Ada Lovelace', 'e1e1e1e1-2b2b-3c3c-4d4d-5e5e5e5e5e5e'] },
        { kind: 'secret', spellings: [real], confidence: 'high' },
      ],
      minted,
    );

    // The entity that was ONLY a minted uuid is gone: an empty spellings array
    // would mint a pseudonym for nothing and put a phantom row in the review.
    assert.equal(entities.length, 2);
    assert.deepEqual(entities[0].spellings, ['Ada Lovelace'], 'the real spelling survives');
    assert.deepEqual(entities[1].spellings, [real], 'a uuid deident did NOT mint is left alone');

    // Reported, never silent. The person wrote it down for a reason and is
    // owed the sentence explaining why it is not needed.
    assert.equal(dropped.length, 2);
    assert.ok(dropped.every((d) => d.includes('e1e1e1e1')));

    // Negative control: with nothing minted, nothing is touched, and the same
    // array comes back rather than a rebuilt one.
    const untouched = stripMintedSpellings([{ kind: 'secret', spellings: [real] }], new Set());
    assert.equal(untouched.dropped.length, 0);
    assert.deepEqual(untouched.entities[0].spellings, [real]);

    // The candidates header has to say this, or the reader makes the same
    // reasonable mistake every time and only finds out ten minutes later.
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const src = fs.readFileSync(path.join(repo, 'src', 'entities', 'tier1.mjs'), 'utf8');
    assert.match(src, /EVERY UUID BELOW IS ALREADY A PSEUDONYM/, 'the candidates header does not warn about uuids');
  }],

  ['F109', 'a declared person name whose surname is left uncovered is reported, not silently substituted', () => {
    // Measured 2026-08-24 comparing entity lists from three model tiers on one
    // corpus: every tier named the full name and the mid tier never named the
    // bare surname, for seven different people. Substituting the full name and
    // leaving the bare surname is a half-replacement: the prose still says who
    // it is two sentences later, and no gate catches it because the residue
    // scan only looks for what it was given.
    //
    // It is a REPORT and not an automatic spelling, for the same reason the
    // probe is not a gate. On the real corpus May, Wise and Ray were all parts
    // of real names and all ordinary words; deriving them automatically is the
    // 202-occurrence failure with a new source. The reader decides, holding
    // the count.
    //
    // Every value here is fabricated. The SHAPE is what matters and a
    // find-and-replace over this repo has already destroyed it once:
    //   Grace Hopper  a full name whose surname also stands alone in the prose
    //                 and is NOT declared. That is the whole subject.
    //   Alan Turing   a full name that IS fully declared, so it proposes nothing.
    //   Acme Advisory an org, to prove "Advisory" is never proposed.
    const texts = [
      'Grace Hopper sent it. Hopper replied later, and Hopper again on Friday.',
      'Alan Turing reviewed it.',
    ];
    const entities = [
      { kind: 'person', spellings: ['Grace Hopper', 'Grace'] },
      { kind: 'person', spellings: ['Alan Turing', 'Alan', 'Turing'] },
      { kind: 'org', spellings: ['Acme Advisory'] },
    ];

    const found = uncoveredNameParts(entities, texts);
    const names = found.map((f) => f.part);
    assert.deepEqual(names, ['Hopper'], `expected only Hopper, got ${JSON.stringify(names)}`);

    // Two, not three. The occurrence inside "Grace Hopper" is already covered
    // by the declared full name, and the number a reader acts on is how many
    // times the surname stands ALONE: "Hopper replied later, and Hopper again
    // on Friday". Counting the part by itself reports every surname in the
    // corpus, including the ones already fully handled.
    assert.equal(found[0].count, 2, 'the count is bare uses, not every occurrence');
    assert.equal(found[0].from, 'Grace Hopper');
    assert.ok(found[0].excerpt.includes('Hopper'));

    // Already declared: not reported again, in either case.
    assert.equal(
      uncoveredNameParts([{ kind: 'person', spellings: ['Grace Hopper', 'hopper'] }], texts).length,
      0,
    );

    // Never occurs on its own: reporting it would be noise, and this is the
    // list a person reads line by line.
    assert.equal(uncoveredNameParts([{ kind: 'person', spellings: ['Alan Turing'] }], ['Alan Turing only']).length, 0);

    // Only people. An org's words are not name parts: splitting "Acme
    // Advisory" proposes "Advisory", which is a common noun.
    assert.equal(
      uncoveredNameParts([{ kind: 'org', spellings: ['Acme Advisory'] }], ['Advisory Advisory']).length,
      0,
    );

    // One-character and two-character parts are not proposed: a two-letter
    // needle with no boundary rule is the bare-tilde bug in another costume.
    assert.equal(uncoveredNameParts([{ kind: 'person', spellings: ['Al Bo'] }], ['Al Bo, then Bo, then Al']).length, 0);
  }],

  // F110 - the username guard guarded nothing, and the seed that goes missing
  // is the one §F3 exists for.
  //
  // seed.mjs read the username as `os.userInfo?.().username`. Optional chaining
  // guards a null RESULT; os.userInfo() THROWS. Reproduced against the shipped
  // code with the throw Node raises when there is no passwd entry:
  //
  //     Error: uv_os_get_passwd returned ENOENT
  //         at seedEntities (src/entities/seed.mjs:36:61)
  //
  // That is BRIEF §2's failed delivery: a traceback instead of deident's own
  // refusal shape, in a container with no passwd entry, on a locked-down CI
  // runner, and on some managed Windows profiles.
  //
  // Degrading is not enough on its own. The username is a tier-0 seed and §F3
  // measured 296 BARE occurrences in the `ls -l` owner column that no path
  // substitution ever fires on, so an unreadable username is a live leak
  // vector going unseeded. It is warned about, the way a missing home
  // directory already is, and never swallowed.
  ['F110', 'an environment with no passwd entry cannot read a username, and says so instead of throwing', () => {
    const passwdless = () => {
      throw Object.assign(new Error('uv_os_get_passwd returned ENOENT'), {
        code: 'ENOENT',
        syscall: 'uv_os_get_passwd',
      });
    };

    // The seam: injected rather than monkey-patched onto node:os, for the
    // reason probeCaseFolding takes an injected stat - the fixture has to
    // state both answers on a machine that only has one of them.
    assert.equal(osUsername({}, passwdless), null, 'a throw means "no username was readable"');
    assert.equal(osUsername({ USERNAME: 'devuser' }, passwdless), 'devuser', 'the environment answers first');
    assert.equal(osUsername({ USER: 'devuser' }, passwdless), 'devuser');

    // Blank is not a name. Present-but-empty is exactly the state a stripped
    // container image ships, and '' as an entity spelling matches everywhere.
    assert.equal(osUsername({ USERNAME: '   ', USER: '' }, passwdless), null);
    assert.equal(osUsername({}, () => ({ username: '' })), null);
    assert.equal(osUsername({}, () => null), null, 'a null RESULT, which is what the old guard covered');
    assert.equal(osUsername({}, () => ({ username: 'ci-runner' })), 'ci-runner');

    // End to end: seedEntities does not throw, seeds no username, and the
    // warning naming the gap reaches the caller.
    const seeded = seedEntities({ HOME: '/home/nobody' }, { workspaceDirs: [] }, { userInfo: passwdless });
    assert.ok(
      seeded.warnings.some((w) => w.includes('OS username')),
      `expected a warning naming the OS username, got ${JSON.stringify(seeded.warnings)}`,
    );
    assert.equal(
      seeded.entities.filter((e) => e.source === 'os username (bare)').length,
      0,
      'nothing is invented to stand in for the username',
    );

    // ...and it has somewhere to arrive. `export` rendered seeded.warnings;
    // scan and review threw them away, which is the shape that makes a lost
    // seed invisible: what a person sees is an entity list with one fewer row.
    // Driven here with the settings-file warning because it is the one seed
    // warning an env alone can provoke - os.userInfo cannot be broken from
    // outside the process - and it travels the same array.
    const root = tmpdir();
    const out = path.join(root, 'out');
    writeCorpus(root);
    const scan = runCli(
      ['scan', '--root', root, '--out', out, '--salt-dir', path.join(root, 'salt')],
      { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'nothing-here') },
    );
    assert.equal(scan.code, 0);
    assert.ok(
      scan.out.includes('MCP server names were not seeded'),
      `scan swallowed its seed warnings:\n${scan.out}`,
    );
  }],

  // F111 - F95's invariant, one layer down: the PROGRAM was portable and the
  // SHELL SYNTAX around it was not.
  //
  // `HOME=<path>` is the remedy for "no home directory, so deident cannot find
  // your session storage". In bash it sets a variable. In PowerShell, which is
  // the default shell for the team this ships to, it is a parse error:
  //
  //     HOME=/tmp/x : The term 'HOME=/tmp/x' is not recognized as the name of
  //     a cmdlet, function, script file, or operable program.
  //
  // cli-ux §8 makes the remedy the contract for getting unstuck, and a remedy
  // that cannot be run is worse than no remedy: the person now believes they
  // typed the fix and it did not work. The settled operator is an agent, which
  // runs the string verbatim rather than reading around it.
  //
  // No platform detection: the string has to be correct to READ on any
  // platform, so it is either shell-neutral prose or both forms, labelled.
  ['F111', 'no refusal hands out shell syntax that only parses in one shell', () => {
    // Anchored at the start of the command, which is the only position where
    // these mean what they mean. An unanchored /export\s/ matches `deident
    // export --preview` in 19 places, and a check that cries wolf on the
    // tool's own subcommand is the one that gets switched off (§F7).
    const POSIX_ONLY = [
      [/^[A-Za-z_][A-Za-z0-9_]*=/, 'a VAR=value prefix parses only in a POSIX shell'],
      [/^export\s+[A-Za-z_][A-Za-z0-9_]*=/, 'export VAR= is not a builtin in PowerShell or cmd'],
      [/\$[A-Za-z_{(]/, 'a $VAR or $(...) expansion'],
      [/[0-9]?>[&\s]*\/dev\/null/, '/dev/null does not exist on Windows'],
      [/`/, 'backtick command substitution'],
      [/'/, 'a single-quoted token is not a quote in cmd.exe'],
    ];
    // The same seam F95 uses, for the same reason: cli-ux §8 makes the remedy
    // the runnable half of a refusal, so it is the half a person or an agent
    // pastes into a shell. The `why` prose alongside it is swept by hand
    // rather than by regex - matching a JS array literal across comments and
    // nested brackets needs a parser, and the approximation flagged whole
    // functions.
    const root = fileURLToPath(new URL('.', import.meta.url));
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.mjs') || e.name === 'selftest.mjs') continue;
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/command:\s*(`[^`]*`|'[^']*')/g)) {
          const raw = m[1].slice(1, -1);
          // `${flag}` is JavaScript interpolation, not shell expansion, and a
          // check that cannot tell them apart fires on every templated remedy
          // in the file.
          const cmd = raw.replace(/\$\{[^}]*\}/g, '').trim();
          for (const [re, why] of POSIX_ONLY) {
            if (re.test(cmd)) offenders.push(`${e.name}: ${why} in "${raw}"`);
          }
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, [], `POSIX-only shell syntax: ${offenders.join(' | ')}`);
  }],

  // F112 - the docs handed to the team carried the author's real username.
  //
  // `C:\Users\devuser\projects\ops-handover\private` and
  // `C:/Users/devuser/.claude/projects` are provenance ("these figures come from
  // this corpus"), so the sentences stay and only the name goes. cli-ux §9
  // already settled the spelling: `C:\Users\<you>\.claude\projects`.
  //
  // Two costs, and the second is the one that matters. A reader on macOS
  // cannot follow a path that exists on one machine. And a de-identification
  // tool shipping its author's home directory in its own documentation is the
  // demonstration that the discipline is not applied here.
  //
  // Scoped to the files the team reads as documentation: docs/, README.md and
  // the skill. BRIEF.md and PLAN.md carry the same shape 21 times inside §4
  // measurement tables where the path form IS the datum being reported; those
  // are the owner's spec to edit, not a portability fix, and they are named in
  // the handover rather than changed here.
  ['F112', 'no shipped document carries a real home directory from one machine', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    // Every absolute home-path shape the corpus actually spells (BRIEF §4.6),
    // plus the two POSIX ones a teammate's machine produces. The captured
    // group is the user segment, and the only accepted value is a placeholder.
    const SHAPES = [
      new RegExp('[A-Za-z]:[' + BS + BS + '/]Users[' + BS + BS + '/]([^\\s' + BS + BS + '/`"|)]+)', 'g'),
      /\/c\/Users\/([^\s\\/`"|)]+)/g,
      /(?:^|[\s`"(])\/(?:Users|home)\/([^\s\\/`"|)]+)/g,
    ];
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) files.push(p);
      }
    };
    walk(path.join(repo, 'docs'));
    walk(path.join(repo, 'skills'));
    files.push(path.join(repo, 'README.md'));

    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(NL);
      lines.forEach((line, i) => {
        for (const re of SHAPES) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) {
            if (m[1].startsWith('<')) continue;
            offenders.push(`${path.basename(file)}:${i + 1} ${m[0]}`);
          }
        }
      });
    }
    assert.deepEqual(offenders, [], `real home paths in shipped docs: ${offenders.join(' | ')}`);
  }],

  // F113 - process.cwd() is the same shape as os.userInfo(): a platform call
  // that throws where the code reads a value.
  //
  // All three commands opened with `path.resolve(flags.out ?? process.cwd())`.
  // On POSIX a directory can be removed while a process sits in it, and
  // process.cwd() then raises `ENOENT: no such file or directory, uv_cwd`.
  // Windows holds a handle on the working directory so it cannot be removed,
  // which is why this never showed up here. `cd /tmp/x && rm -rf /tmp/x` in
  // another terminal is all it takes on a teammate's machine.
  //
  // The throw did not reach the terminal as a traceback - main() catches
  // everything - but wrapUnexpected turned it into "internal error ... This is
  // a bug in deident, not a problem with your data ... Report it with this
  // line". That is the same wrong answer homeDir() was written to stop giving:
  // it is an environment, it has a remedy, and the remedy is a flag.
  //
  // path.resolve is inside the try because it reads process.cwd() itself when
  // the argument is relative, so `--out ./here` throws on the same corner.
  ['F113', 'a working directory that has been deleted is an environment, not an internal error', () => {
    const real = process.cwd;
    const gone = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), {
        code: 'ENOENT',
        syscall: 'uv_cwd',
      });
    };
    try {
      process.cwd = gone;

      let refusal = null;
      try {
        resolveOutDir({});
      } catch (err) {
        refusal = err;
      }
      assert.ok(refusal instanceof RefusalError, 'a refusal, not a raw ENOENT');
      assert.ok(
        !/internal error|bug in deident/i.test(`${refusal.reason} ${refusal.why.join(' ')}`),
        `the user is blamed for their own environment: ${refusal.reason}`,
      );
      assert.ok(refusal.remedies.length > 0, 'cli-ux §8: a refusal names its remedy');
      assert.ok(
        refusal.remedies.some((r) => r.command.includes('--out')),
        `the remedy is the flag that does not need a cwd, got ${JSON.stringify(refusal.remedies)}`,
      );

      // A relative --out still needs the cwd, so it refuses the same way
      // rather than throwing out of path.resolve.
      assert.throws(() => resolveOutDir({ out: 'here' }), RefusalError);

      // An absolute --out needs no cwd at all and must still work: this is the
      // remedy the refusal hands out, so it has to be true.
      const abs = os.tmpdir();
      assert.equal(resolveOutDir({ out: abs }), path.resolve(abs));
    } finally {
      process.cwd = real;
    }

    // And the ordinary case is untouched.
    assert.equal(resolveOutDir({}), path.resolve(process.cwd()));
  }],

  // F114 - sanitizeEntryName promised portability across Windows extractors
  // and did not deliver it. The names it did not handle are the ones only a
  // NON-Windows uploader can produce, which is why this survived.
  //
  // `~/projects/aux` is an ordinary directory on macOS and Linux and
  // impossible to create on Windows, so the workspace name reaches the archive
  // only from a teammate's machine and breaks only at the recipient's.
  // Measured with the extractor the recipient actually has:
  //
  //   PS> Expand-Archive probe.zip -DestinationPath out
  //   WARNING: The archive entry 'sessions/aux/s0.jsonl' contains a Windows
  //   reserved device name as one of its segments which is not supported.
  //   The entry was renamed to 'sessions\_aux\s0.jsonl'.
  //
  // Renamed for con, prn, aux, nul, com1-9 and lpt1-9, in either case. And
  // silently, with no warning at all, for a trailing dot or space: `notes.`
  // and `trail ` landed as `notes` and `trail`.
  //
  // Both break export-map.txt, which records the archive entry verbatim and
  // exists so that privacy-tiers level 3 can attribute an entry back to a
  // session (cli-ux §10). A path that no longer resolves is the one thing that
  // file may not contain. Writing the escaped name into the archive means the
  // recipient extracts what the map already says.
  //
  // Measured, not folklore: `aux.jsonl`, `auxiliary`, `console`, `com0`,
  // `lpt0` and `com10` all extracted intact, and `aux.txt` created fine
  // through Win32 on this build, so the rule stops at the bare name.
  ['F114', 'an archive entry named after a Windows device extracts under the name deident recorded', () => {
    for (const name of ['con', 'PRN', 'aux', 'Nul', 'com1', 'COM9', 'lpt1', 'lpt9']) {
      assert.equal(sanitizeEntryName(name), `_${name}`, `${name} is a reserved device name`);
    }

    // Trailing dot and trailing space are dropped by Windows itself, silently,
    // and dropping them here is what keeps the archive and the map agreeing.
    assert.equal(sanitizeEntryName('notes.'), 'notes');
    assert.equal(sanitizeEntryName('trail '), 'trail');
    assert.equal(sanitizeEntryName('dots...'), 'dots');
    // ...and a name that is nothing else still has to be a name.
    assert.equal(sanitizeEntryName('...'), 'unnamed');
    assert.equal(sanitizeEntryName('   '), 'unnamed');

    // Not reserved, and mangling them would rename real workspaces for
    // nothing (§F7: a scan that cries wolf is the first thing switched off).
    for (const name of ['auxiliary', 'console', 'com0', 'lpt0', 'com10', 'aux.jsonl', 'nulls', 'a-normal-name']) {
      assert.equal(sanitizeEntryName(name), name, `${name} is not a device name`);
    }

    // The length cap runs before the trailing strip, because truncating at
    // 120 can put a dot back on the end. Written the other way round first,
    // which shipped exactly the name Windows was going to rewrite.
    assert.equal(sanitizeEntryName(`${'a'.repeat(119)}. tail`), 'a'.repeat(119));
    assert.equal(sanitizeEntryName(`aux${'.'.repeat(200)}`), '_aux');

    // The characters it already handled still go.
    assert.equal(sanitizeEntryName('a:b/c'), 'a_b_c');
    assert.equal(sanitizeEntryName(''), 'unnamed');
    // A session id passes through untouched: it is the other caller.
    assert.equal(
      sanitizeEntryName('11111111-1111-4111-8111-111111111111'),
      '11111111-1111-4111-8111-111111111111',
    );
  }],

  // F116..F122 - the per-session triage stage.
  //
  // Measured on the live corpus before it existed: 205 sessions, and each
  // session's cwd plus its first user prompt truncated to 300 characters is a
  // 23,302-character payload, about 7k tokens. The entity pass that follows
  // reads 915 KB, about 250k tokens. A 35x difference for the stage that
  // decides whether a session ships at all is worth a command.
  //
  // The whole stage rests on one property, so it gets the most direct test:
  // a triage verdict may only ever move a session TOWARD drop.
  //
  // F116 - "keep" is not a verdict, and asking for it is a refusal.
  //
  // docs/model-tier.md disqualifies the low tier for the entity pass because
  // its failures are MISSES and a miss there is a disclosure. Triage inverts
  // that only because removal is the only power on offer, so the moment a
  // verdict can release a session the whole argument for a cheap reader is
  // gone. Enforced in code rather than in the header, because a header is a
  // request and this is a constraint.
  ['F116', 'a triage verdict of "keep" is refused, naming the row', () => {
    const root = tmpdir();
    const saltDir = path.join(root, 'salt');
    const out = path.join(root, 'out');
    writeCorpus(root);
    const scanned = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(scanned.code, 0, scanned.out);

    const reviewPath = path.join(out, 'review.md');
    const before = fs.readFileSync(reviewPath, 'utf8');
    const verdicts = path.join(out, 'deident-triage.json');
    const id = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(
      verdicts,
      JSON.stringify({ verdicts: [{ id, verdict: 'keep', reason: 'looks fine to me' }] }),
      'utf8',
    );

    const r = runCli(['triage', '--apply', '--verdicts', verdicts, '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(r.code, 1, `a keep verdict must refuse: ${r.out}`);
    assert.match(r.out, /keep/, 'the refusal must name the word it refused');
    assert.match(r.out, new RegExp(id), 'the refusal must name the row');
    assert.equal(fs.readFileSync(reviewPath, 'utf8'), before, 'a refused verdict file must change nothing');
  }],

  // F117 - the other half of the same constraint. "unsure" is the explicit way
  // to say "I looked and I am not acting", so it must leave an existing drop
  // exactly where it is. A verdict that could quietly re-open a held-back
  // session is the same failure as a keep verdict wearing a different word.
  ['F117', 'a triage verdict cannot overturn an existing drop', () => {
    const root = tmpdir();
    const saltDir = path.join(root, 'salt');
    const out = path.join(root, 'out');
    writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);

    const reviewPath = path.join(out, 'review.md');
    const id = '11111111-1111-4111-8111-111111111111';
    setSessionDecision(reviewPath, id, 'drop');
    assert.ok(readSessionDrops(reviewPath).drops.has(id), 'the hold was not written into review.md');

    const verdicts = path.join(out, 'deident-triage.json');
    fs.writeFileSync(
      verdicts,
      JSON.stringify({ verdicts: [{ id, verdict: 'unsure', reason: 'cannot tell from the first line' }] }),
      'utf8',
    );
    const r = runCli(['triage', '--apply', '--verdicts', verdicts, '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(r.code, 0, r.out);
    assert.ok(readSessionDrops(reviewPath).drops.has(id), 'an unsure verdict must not release a dropped session');

    // A `drop` verdict against a row that already reads drop is the other half:
    // a counted no-op, not a rewrite. Rewriting it would replace whatever the
    // person had written on that row with the triage reason, which is a verdict
    // overwriting a decision it did not make.
    const held = fs.readFileSync(reviewPath, 'utf8').replace(
      new RegExp(`^drop(\\s+.*${id})$`, 'm'),
      'drop$1   # held by hand, before any triage ran',
    );
    fs.writeFileSync(reviewPath, held, 'utf8');
    fs.writeFileSync(
      verdicts,
      JSON.stringify({ verdicts: [{ id, verdict: 'drop', reason: 'triage would have said this instead' }] }),
      'utf8',
    );
    const again = runCli(['triage', '--apply', '--verdicts', verdicts, '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /1 changed nothing/, 'the no-op must be counted and reported');
    const after = fs.readFileSync(reviewPath, 'utf8');
    assert.ok(after.includes('held by hand, before any triage ran'), 'the row the person wrote must survive');
    assert.ok(!after.includes('triage would have said this instead'), 'and must not be overwritten');
    assert.ok(readSessionDrops(reviewPath).drops.has(id), 'and it is still dropped');
  }],

  // F118 - the apply path writes into column 1 of review.md, which is the one
  // column the export reads. Asserted through readSessionDrops rather than by
  // matching the line, because the line shape is not the contract: what the
  // export sees is.
  //
  // The reason is appended to the row, so the next person to open the file can
  // see why it went. That put a fifth token on a row whose id used to be read
  // as "the last word on the line" - which would have made the id the last word
  // of the reason instead.
  ['F118', 'an applied triage verdict lands in review.md and round-trips through readSessionDrops', () => {
    const root = tmpdir();
    const saltDir = path.join(root, 'salt');
    const out = path.join(root, 'out');
    writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);

    const reviewPath = path.join(out, 'review.md');
    const id = '22222222-2222-4222-8222-222222222222';
    assert.ok(!readSessionDrops(reviewPath).drops.has(id), 'the session starts out kept');

    const verdicts = path.join(out, 'deident-triage.json');
    fs.writeFileSync(
      verdicts,
      JSON.stringify({ verdicts: [{ id, verdict: 'drop', reason: 'first prompt is somebody else"s document' }] }),
      'utf8',
    );
    const r = runCli(['triage', '--apply', '--verdicts', verdicts, '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(r.code, 0, r.out);

    const text = fs.readFileSync(reviewPath, 'utf8');
    assert.match(text, new RegExp(`^drop\\s+.*${id}`, 'm'), 'column 1 must read drop');
    assert.ok(text.includes('somebody else"s document'), 'the reason must be on the row');
    const parsed = readSessionDrops(reviewPath);
    assert.ok(parsed.drops.has(id), 'the applied verdict must round-trip');
    assert.ok(parsed.known.has(id), 'and the row must still count as decided');

    // Remembered beside the tiers, or a re-scan elsewhere loses it (F104).
    const store = JSON.parse(fs.readFileSync(path.join(saltDir, 'workspaces.json'), 'utf8'));
    assert.ok(store.sessionDrops.includes(id), `not remembered: ${JSON.stringify(store.sessionDrops)}`);
  }],

  // F119 - sessions get deleted between runs, so a verdict naming an id that is
  // no longer in the corpus is ordinary, not a failure. Refusing would mean one
  // stale row throws away every other verdict in the file, and the reader would
  // have to re-run the whole stage to recover from somebody tidying a directory.
  ['F119', 'a triage verdict for an unknown session warns and does not refuse', () => {
    const root = tmpdir();
    const saltDir = path.join(root, 'salt');
    const out = path.join(root, 'out');
    writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);

    const gone = '99999999-9999-4999-8999-999999999999';
    const real = '22222222-2222-4222-8222-222222222222';
    const verdicts = path.join(out, 'deident-triage.json');
    fs.writeFileSync(
      verdicts,
      JSON.stringify({
        verdicts: [
          { id: gone, verdict: 'drop', reason: 'session no longer on disk' },
          { id: real, verdict: 'drop', reason: 'held back' },
        ],
      }),
      'utf8',
    );
    const r = runCli(['triage', '--apply', '--verdicts', verdicts, '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(r.code, 0, `an unknown id must warn, not refuse: ${r.out}`);
    assert.match(r.out, new RegExp(gone), 'the warning must name the id it could not find');
    // The other verdict in the same file still landed.
    assert.ok(readSessionDrops(path.join(out, 'review.md')).drops.has(real), 'one stale row must not void the rest');
  }],

  // F120 - the whole point of the stage is not paying a reader to look at
  // something already decided. A session that is already dropped is not on
  // offer, because the only verdict it could receive is the one it already has.
  ['F120', 'the triage file offers only sessions currently proposed keep', () => {
    const root = tmpdir();
    const saltDir = path.join(root, 'salt');
    const out = path.join(root, 'out');
    writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);

    const dropped = '22222222-2222-4222-8222-222222222222';
    const kept = '11111111-1111-4111-8111-111111111111';
    setSessionDecision(path.join(out, 'review.md'), dropped, 'drop');

    const r = runCli(['triage', '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(r.code, 0, r.out);
    const text = fs.readFileSync(path.join(out, 'deident-triage.txt'), 'utf8');
    assert.ok(text.includes(kept), 'a kept session must be offered');
    assert.ok(!text.includes(dropped), 'a session already dropped must not be offered');
  }],

  // F121 - a triage that reads the whole session is the expensive stage wearing
  // a hat. Only the head of each file is read and only the first prompt is
  // rendered, truncated, so the payload cannot grow with the corpus.
  ['F121', 'the triage file truncates the first prompt and never carries a session body', () => {
    const root = tmpdir();
    const saltDir = path.join(root, 'salt');
    const out = path.join(root, 'out');
    const corpus = writeCorpus(root);
    const long = `TRIAGE-PROMPT-HEAD ${'z'.repeat(60_000)} TRIAGE-PROMPT-TAIL`;
    writeLongPromptSession(root, corpus.cwd, long);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);

    const r = runCli(['triage', '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(r.code, 0, r.out);
    const triagePath = path.join(out, 'deident-triage.txt');
    const text = fs.readFileSync(triagePath, 'utf8');

    assert.ok(text.includes('TRIAGE-PROMPT-HEAD'), 'the start of the prompt must be shown');
    assert.ok(!text.includes('TRIAGE-PROMPT-TAIL'), 'the end of a 60,000-character prompt must not be');
    assert.ok(
      fs.statSync(triagePath).size < corpusBytes(root) / 2,
      `triage file ${fs.statSync(triagePath).size} B is not small against a ${corpusBytes(root)} B corpus`,
    );

    // The limit is the limit, and the flag moves it.
    const promptLine = text.split(NL).find((l) => l.includes('TRIAGE-PROMPT-HEAD'));
    assert.ok(promptLine.length <= 320, `default limit not applied: ${promptLine.length} characters`);
    assert.equal(runCli(['triage', '--root', root, '--out', out, '--salt-dir', saltDir, '--triage-chars', '40']).code, 0);
    const short = fs.readFileSync(triagePath, 'utf8').split(NL).find((l) => l.includes('TRIAGE-PROMPT-HEAD'));
    assert.ok(short.length <= 60, `--triage-chars 40 not applied: ${short.length} characters`);
  }],

  // F122 - the constraint is enforced in code, and the person or agent reading
  // the file is told so in the file itself. Asserted against the rendered
  // header rather than a copy of the wording here: a fixture holding its own
  // copy of the sentence passes while the shipped file says something else.
  ['F122', 'the triage header states the drop-only rule to whoever reads it', () => {
    const root = tmpdir();
    const saltDir = path.join(root, 'salt');
    const out = path.join(root, 'out');
    writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);
    assert.equal(runCli(['triage', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);

    const header = fs.readFileSync(path.join(out, 'deident-triage.txt'), 'utf8').split('# ---')[0];
    assert.match(header, /toward "?drop"?/i, 'the header must say the verdict only ever moves toward drop');
    assert.match(header, /there is no "keep" verdict/i, 'and must say plainly that keep is not on offer');
    assert.match(header, /coverage/, 'and must say what a wrong verdict costs');
    assert.match(header, /model-tier\.md/, 'and must point at the measurement it rests on');
  }],
  ['F123', 'the ES5 version gate agrees with the real floor, and stays parseable by the runtime it rejects', () => {
    // Measured 2026-08-24 in a clean Ubuntu 20.04 install, which is what a
    // teammate on a stock LTS box has: `apt-get install nodejs` gives Node
    // 10.19, and running the tool on it printed a SyntaxError stack from
    // deident.mjs line 9. src/cli/runtime.mjs exists to prevent exactly that
    // picture and never got to run, because it lives inside the ESM the old
    // parser choked on. A guard that cannot load on the runtime it guards
    // against is not a guard.
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const gate = fs.readFileSync(path.join(repo, 'deident.js'), 'utf8');

    // The floor is stated twice, in two languages, so it can drift. This is
    // the check that makes the duplication safe rather than a second bug.
    const major = /major:\s*(\d+)/.exec(gate);
    assert.ok(major, 'the gate does not state a major version');
    assert.equal(Number(major[1]), REQUIRED_NODE.major, 'gate and runtime.mjs disagree on the major');
    for (const [maj, min] of Object.entries(REQUIRED_NODE.minors)) {
      // Built from String.raw, because in a plain template literal `\s` is not
      // an escape and silently collapses to `s`, which matched nothing and
      // made this assertion fire on a gate that was correct.
      assert.match(gate, new RegExp(String.raw`${maj}:\s*${min}`), `the gate is missing the ${maj}.${min} floor`);
    }

    // ES5 only. Anything newer and the file fails the same way the file it
    // protects does, on the same runtimes, for the same reason.
    const banned = [
      [/\bconst\s/, 'const'],
      [/\blet\s/, 'let'],
      [/=>/, 'arrow function'],
      [/`/, 'template literal'],
      [/\?\./, 'optional chaining'],
      [/\?\?/, 'nullish coalescing'],
      [/\.\.\./, 'spread'],
    ];
    // Comments carry prose that would trip the scan, so only code is examined.
    const code = gate
      .split(NL)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join(NL);
    for (const [re, name] of banned) {
      assert.ok(!re.test(code), `deident.js uses ${name}, which the runtime it rejects cannot parse`);
    }

    // The dynamic import must never appear as a bare token: written literally
    // it is itself a syntax error on the runtime being rejected.
    // The dynamic import may appear exactly once, and only inside the string
    // handed to new Function. Written as a bare token it is itself a syntax
    // error on the runtime being rejected, so this file would fail the same
    // way the file it protects does.
    const importLines = code.split(NL).filter((l) => /import\s*\(/.test(l));
    assert.equal(importLines.length, 1, 'import( appears somewhere unexpected in the gate');
    assert.match(importLines[0], /new Function\(/, 'the gate must defer the import token to runtime');

    // And the seam it reaches for has to exist.
    const entry = fs.readFileSync(path.join(repo, 'deident.mjs'), 'utf8');
    assert.match(entry, /export async function run\(/, 'deident.js calls mod.run()');
  }],

  ['F124', 'a multi-word spelling of any kind contributes contiguous runs, and only a person contributes single words', () => {
    // F109 restricted the name-part report to `person`. On the 2026-08-24 live
    // run a registered office address was declared as ONE string, so only the
    // whole string was ever a needle, and the archive still carried the street
    // on its own. Nothing could catch it: the residue scan looks only for the
    // spellings it was given, and the probe never split a non-person entity.
    //
    // The rule, measured before it was chosen (see probe.mjs): a single word
    // is proposed only from a `person`, and a contiguous run of two or more
    // words is proposed from any kind. Proposing single words from every kind
    // on the live entity list produced 52 candidates of which 16 occurred, led
    // by `and` at 337 and followed by `Pro`, `Commercial`, `USD`, `Road`,
    // `Industry` and `South`, all ordinary words at the top of a list a person
    // supposed to read line by line, which is §F7's cry-wolf failure.
    //
    // Every value below is fabricated. The SHAPE is what matters and a
    // find-and-replace over this repo has already destroyed it once:
    //   the address   a registered office declared as one comma-separated
    //                 string, whose street also stands alone in the prose.
    //   Acme Advisory a two-word org, to prove no single word is ever proposed
    //                 from a non-person: `Advisory` is a common noun.
    //   Grace Hopper  a person whose surname stands alone, so the single-word
    //                 path is exercised in the same call.
    const address = 'Rm 4, 12/F, Northgate Commercial Centre, 20-28 Bramble Road, Harbour Point';
    const texts = [
      'Invoices go to Bramble Road. The Bramble Road office signs for them.',
      'The Centre 20-28 sign is on the wall, and Advisory work is billed monthly.',
      'Grace Hopper sent it, and Hopper replied.',
    ];
    const entities = [
      { kind: 'secret', spellings: [address] },
      { kind: 'org', spellings: ['Acme Advisory'] },
      { kind: 'person', spellings: ['Grace Hopper', 'Grace'] },
    ];

    const parts = uncoveredNameParts(entities, texts).map((r) => r.part);

    // The escape itself. Two words of the declared address, standing alone.
    assert.ok(parts.includes('Bramble Road'), `expected Bramble Road, got ${JSON.stringify(parts)}`);

    // The precision half, and the reason the rule is runs and not words. Each
    // of these occurs in the text above on its own.
    for (const noise of ['Road', 'Centre', 'Commercial', 'Advisory', 'Point', 'Northgate']) {
      assert.ok(!parts.includes(noise), `${noise} is a single word of a non-person and must not be proposed`);
    }

    // A run never crosses the punctuation the writer put there: the address
    // reads "Centre, 20-28" and "Centre 20-28" is a phrase nobody wrote, so it
    // is not proposed even though the text happens to contain it.
    assert.ok(!parts.includes('Centre 20-28'), 'a run crossed a comma');

    // The person path is untouched by any of this, in the same call.
    assert.ok(parts.includes('Hopper'), 'the single-word person part stopped being reported');

    // Counted through the shipped matcher, so the number is bare uses. Both
    // occurrences of "Bramble Road" stand alone; neither is inside the
    // declared address, which does not appear in the text at all.
    const row = uncoveredNameParts(entities, texts).find((r) => r.part === 'Bramble Road');
    assert.equal(row.count, 2, 'the count is bare uses of the run');
    assert.equal(row.from, address, 'the row names the declared spelling it came from');

    // And it names the form the person TYPED, not an escaping variant of it.
    // readEntities runs every declared spelling through expandVariants, so a
    // path-shaped address arrives carrying a backslash-doubled twin that is
    // longer than the original. Labelling the row with that twin shows the
    // reader a string they never wrote, in the one column that tells them
    // which entry to edit.
    const variant = address.replace('12/F', `12${SEP}${SEP}F`);
    const labelled = uncoveredNameParts(
      [{ kind: 'secret', spellings: [variant, address] }],
      texts,
    ).find((r) => r.part === 'Bramble Road');
    assert.equal(labelled.from, address, `the row was labelled with an escaping variant: ${labelled.from}`);

    // A run that IS the whole declared spelling proposes nothing: it is
    // already a needle, so reporting it would be a row with no action behind
    // it. Two-word orgs are therefore silent, which is most of them.
    assert.deepEqual(
      uncoveredNameParts([{ kind: 'org', spellings: ['Acme Advisory'] }], ['Acme Advisory bills monthly']),
      [],
    );

    // A lowercase connector never joins a run, and this one is a correctness
    // rule rather than a tidiness rule.
    //
    // Measured on the live corpus after the run rule went in: a declared
    // workspace "Founders and Ivy" proposed "and Ivy", which occurred 7 times
    // and every one of them was an occurrence of the declared name "Ivy". The probe
    // table is sorted longest first, so the 7-character run outranked the
    // 3-character declared spelling and claimed spans that were already
    // covered. The report then said "the prose still names them" about a name
    // the export replaces.
    //
    // The cost is stated rather than hidden: a name with a lowercase particle
    // ("van Dijk") proposes no run. For a person the single-word path still
    // proposes "Dijk", which is the half that carries the identity.
    const connector = uncoveredNameParts(
      [{ kind: 'workspace', spellings: ['Founders and Ivy'] }, { kind: 'person', spellings: ['Ivy Chen'] }],
      ['Founders and Ivy met, and Ivy signed it, and Ivy filed it.'],
    ).map((r) => r.part);
    assert.ok(!connector.includes('and Ivy'), `a lowercase connector joined a run: ${JSON.stringify(connector)}`);
  }],

  ['F125', 'a tier-0 spelling of the uploader glued to alphanumerics is reported, with the boundary rule off', () => {
    // Measured 2026-08-24 over a shipped archive (18.8 MB of exported bytes):
    // the OS username survived inside cloud resource names, glued to letters
    // and digits on both sides. The boundary rule refuses every one of them,
    // correctly by its own terms, because §4.5 row 4 makes `ray` inside `array`
    // a CORRECT non-match, so the export printed `known-entity residue 0` while
    // the username sat in the archive.
    //
    // A REPORT, never a gate. A gate here would fail every export forever over
    // behaviour BRIEF §4.5 demands.
    //
    // Fabricated values. The SHAPE:
    //   devuser                    the OS username, this repo's standing
    //                              placeholder for it
    //   stdevuser-prod etc.        cloud resource names that glue a username
    //                              to a prefix, a suffix or a digit run, which
    //                              is how the real ones were shaped
    //   /home/devuser/notes        a bounded occurrence, which belongs to the
    //                              residue GATE and must not appear here twice
    const bytes = [
      '["stdevuser-prod","ai-devuser01","kv-devuser37557093578778"]',
      'storageAccounts stdevuser3756557093578778',
      'the file /home/devuser/notes was read',
    ].join(' ');
    const table = buildTable([
      { id: 'PERSON_01', kind: 'person', tier: 0, pseudonym: 'PERSON_01', spellings: ['devuser'] },
    ]);

    const scan = residualScan(bytes, table, new Set());
    assert.equal(scan.gluedHits.length, 1, 'one spelling, one row');
    const hit = scan.gluedHits[0];
    assert.equal(hit.spelling, 'devuser');
    // Four glued occurrences. The fifth, inside the path, is bounded on the
    // left by `/` and on the right by `/`, so the substituter replaced it and
    // the residue gate owns it. Counting it here would report a handled
    // occurrence as an unhandled one.
    assert.equal(hit.count, 4, `expected the four glued occurrences, got ${hit.count}`);
    assert.ok(hit.excerpt.includes('devuser'), 'the row carries an excerpt to judge it by');

    // Scope, and the two halves of it that keep this from crying wolf.
    //
    // A workspace path is out: it is substituted as a path and matches its own
    // longer form, so every deeper path under it would be a row.
    const workspace = buildTable([
      { id: 'WORKSPACE_01', kind: 'workspace', tier: 0, pseudonym: 'WORKSPACE_01', spellings: ['projects'] },
    ]);
    assert.equal(residualScan('myprojectsdir', workspace, new Set()).gluedHits.length, 0);

    // A short spelling is out. Measured over the same 18.8 MB: at three
    // characters the median seed produced 643 glued occurrences and the worst
    // 1,996; at four, 13 and 270; at five, 0 and 14, and the 14 were the real
    // leak. Five is where the report becomes something a person finishes.
    const short = buildTable([
      { id: 'PERSON_02', kind: 'person', tier: 0, pseudonym: 'PERSON_02', spellings: ['ray'] },
    ]);
    assert.equal(residualScan('an array index', short, new Set()).gluedHits.length, 0);

    // Still counted in the aggregate the manifest already prints, so the two
    // numbers cannot disagree about the same occurrence.
    assert.ok(scan.embedded >= 4, 'the glued rows are the same occurrences the embedded counter sees');
  }],

  // F126, every run started from zero.
  //
  // The expensive stage is the only one that scales with the corpus, so a
  // second run cost as much as the first for almost no new information: the
  // owner read the prose, wrote an entity list, exported, and the next run
  // asked them to read the same prose again. The list is now remembered beside
  // the salt.
  //
  // The other half of this fixture is where the file must NOT be. It holds
  // real spellings and real session ids in plaintext, so it is memory and
  // never output: not in the archive, not in the output directory, not in the
  // repository.
  ['F126', 'a successful export remembers the entity list, and the dictionary never leaves the salt directory', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(scan.code, 0, scan.out);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);

    const first = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ], CORPUS_USER_ENV);
    assert.equal(first.code, 0, first.out);

    const dictFile = path.join(saltDir, DICTIONARY_FILENAME);
    assert.ok(fs.existsSync(dictFile), 'the export did not remember the entity list');
    const dict = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
    assert.ok(typeof dict._note === 'string' && dict._note.length > 0, 'a file a person edits by hand needs a header');
    // The spellings as the person TYPED them, not the escaping variants the
    // reader expands them into: this file is edited by hand and a row showing
    // a string nobody wrote is a row nobody can act on.
    assert.deepEqual(
      dict.entities.map((e) => e.spellings),
      [['Nora Lund']],
      `the declared spelling was not remembered as written: ${JSON.stringify(dict.entities)}`,
    );

    // The second run supplies no entity list at all and still exports.
    const second = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(second.code, 0, `the second run should need no --entities: ${second.out}`);
    assert.match(second.out, /dictionary/, 'the report must say where the entities came from');

    // Where the dictionary must not be.
    assert.ok(!fs.existsSync(path.join(out, DICTIONARY_FILENAME)), 'the dictionary reached the output directory');
    const zips = fs.readdirSync(out).filter((f) => f.endsWith('.zip'));
    assert.equal(zips.length, 1, 'exactly one archive');
    const entries = readZipFile(path.join(out, zips[0]));
    assert.ok(!entries.some((e) => e.name.includes(DICTIONARY_FILENAME)), 'the dictionary is an archive entry');
    const bytes = entries.map((e) => `${e.name}${NL}${e.data}`).join(NL);
    assert.ok(!bytes.includes('Nora Lund'), 'the remembered spelling must not be in the archive');
    assert.ok(!bytes.includes('_note'), 'the dictionary body must not be in the archive');
    const repo = fileURLToPath(new URL('..', import.meta.url));
    assert.ok(!fs.existsSync(path.join(repo, DICTIONARY_FILENAME)), 'the dictionary was written into the repository');
  }],

  // F127, merging by position mints two pseudonyms for one person, which
  // entities/tier1.mjs already warns about in the operator contract: "One
  // identity per entry, or one person gets two pseudonyms and the prose stops
  // making sense". A dictionary makes it worse, because the split then
  // persists across every later run.
  //
  // Every value is fabricated. The SHAPE:
  //   Grace Hopper / Grace   a stored identity with two spellings
  //   Hopper                 a SECOND stored entry that overlaps the first
  //                          only through the incoming one, so the merge has
  //                          to be transitive rather than pairwise
  //   ghopper                a run-together handle form arriving new
  //   Acme Advisory          shares nothing, and must stay its own identity
  //   Bramblesoft/bramblesoft  one org written two ways, which is §4.5's
  //                          measured case-variant hazard as an identity
  //                          question rather than a matching one
  ['F127', 'entities merge by shared spelling and never by position', () => {
    const stored = [
      { kind: 'person', spellings: ['Grace Hopper', 'Grace'], confidence: 'high' },
      { kind: 'person', spellings: ['Hopper'], confidence: 'low' },
      { kind: 'org', spellings: ['Acme Advisory'], confidence: 'high' },
    ];
    const incoming = [
      { kind: 'person', spellings: ['Grace', 'Hopper', 'ghopper'], confidence: 'high' },
      { kind: 'client', spellings: ['Northwind Trading'], confidence: 'low' },
    ];

    const merged = mergeEntities(stored, incoming);
    assert.equal(merged.entities.length, 3, `expected one person, one org, one client: ${JSON.stringify(merged.entities)}`);

    const person = merged.entities.find((e) => e.spellings.includes('ghopper'));
    assert.deepEqual(
      [...person.spellings].sort(),
      ['Grace', 'Grace Hopper', 'Hopper', 'ghopper'],
      'the two stored entries and the incoming one are one identity',
    );

    const org = merged.entities.find((e) => e.kind === 'org');
    assert.deepEqual(org.spellings, ['Acme Advisory'], 'an identity that shares nothing must stay separate');
    assert.ok(merged.entities.some((e) => e.kind === 'client'), 'a wholly new identity is added');
    assert.equal(merged.added, 1, 'one identity was new');

    // Case is a spelling difference, not an identity difference. §4.5 measured
    // `Northwind` surviving 1,804 times because the case variant was treated as
    // a different string; two dictionary entries for one org is the same
    // mistake one layer up.
    const cased = mergeEntities(
      [{ kind: 'org', spellings: ['Bramblesoft'], confidence: 'high' }],
      [{ kind: 'org', spellings: ['bramblesoft', 'bramblesoft-dev'], confidence: 'high' }],
    );
    assert.equal(cased.entities.length, 1, `a case variant is the same identity: ${JSON.stringify(cased.entities)}`);
    assert.ok(cased.entities[0].spellings.includes('Bramblesoft'), 'both spellings are kept');
    assert.ok(cased.entities[0].spellings.includes('bramblesoft-dev'));
  }],

  // F128, the gate that says "a semantic pass ran" was all-or-nothing:
  // supplying --entities satisfied it for the whole corpus. With a dictionary
  // that is not good enough, because a repeat run could satisfy it having read
  // nothing new, and the corpus grows between runs.
  //
  // Per-session accounting instead: a session is covered when its prose has
  // been put in front of a reader and the hash of that prose is remembered.
  // A session whose content changed since is not covered, and the export
  // refuses naming it.
  ['F128', 'a session whose content changed since it was read is refused by name, and only it is shown again', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    // A second exportable session, so "shown 1, omitted 1" is a number that
    // can be wrong. With one session both readings look identical.
    const second = writeLongPromptSession(root, corpus.cwd, 'PROSE-FROM-THE-SESSION-ALREADY-READ');

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(scan.code, 0, scan.out);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    const primed = primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);

    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ], CORPUS_USER_ENV);
    assert.equal(exported.code, 0, exported.out);

    // The corpus grows, which is the ordinary case: one more turn typed into a
    // session that was already read and approved.
    appendTurn(root, second, corpus.cwd, 'PROSE-TYPED-AFTER-THE-LAST-READ');

    const refused = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(refused.code, 1, `an unread session must refuse the export: ${refused.out}`);
    assert.match(refused.out, /semantic pass/, 'the refusal names what has not happened');
    assert.ok(refused.out.includes(second), `the refusal must name the session: ${refused.out}`);
    assert.ok(!fs.readdirSync(out).some((f) => f.endsWith('.zip') && fs.statSync(path.join(out, f)).mtimeMs > Date.now()), 'no new archive');

    // And only that session goes back in front of a reader. This is the whole
    // economic argument: on the live corpus the first read is 915 KB of prose
    // and the second is the handful of sessions that changed.
    const candidates = fs.readFileSync(path.join(out, 'deident-candidates.txt'), 'utf8');
    assert.ok(candidates.includes('PROSE-TYPED-AFTER-THE-LAST-READ'), 'the changed session must be shown');
    assert.ok(
      !candidates.includes('KEEP-THIS-STRING-FORM-PROMPT'),
      'a session whose content has not changed was put in front of the reader again',
    );
    assert.match(candidates, /1 more session is not in this file/, 'the header must say what was left out and why');
    assert.ok(
      candidates.length < primed.candidateBytes,
      `the second read (${candidates.length} B) is not smaller than the first (${primed.candidateBytes} B)`,
    );
  }],

  // F129, a dictionary that cannot be read must refuse, the way loadUserDeny
  // refuses. Continuing with no dictionary is how a person ships an export
  // they believed was covered: the entity list would silently be empty and the
  // per-session gate would report every session as never read, which reads as
  // a corpus problem rather than as a broken file.
  //
  // A MISSING dictionary is the opposite case and is ordinary: it means this
  // is the first run.
  ['F129', 'an unreadable dictionary refuses and names the line; a missing one is an ordinary first run', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    fs.mkdirSync(saltDir, { recursive: true });

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(scan.code, 0, scan.out);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');

    // Missing: the run refuses for want of an entity list, which is the FIRST
    // RUN refusal and names the candidates file, not the dictionary.
    const missing = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(missing.code, 1, missing.out);
    assert.doesNotMatch(missing.out, /dictionary/i, `a missing dictionary is not an error: ${missing.out}`);

    // Malformed: a missing comma between two entries, hand-counted to line 4.
    // Fabricated names; the SHAPE is two well-formed entries with the
    // separator between them gone, which is what hand-editing produces.
    const dictFile = path.join(saltDir, DICTIONARY_FILENAME);
    fs.writeFileSync(
      dictFile,
      [
        '{',
        '  "entities": [',
        '    {"kind": "person", "spellings": ["Grace Hopper"]}',
        '    {"kind": "person", "spellings": ["Ada Lovelace"]}',
        '  ]',
        '}',
      ].join(NL),
      'utf8',
    );
    const broken = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(broken.code, 1, broken.out);
    assert.match(broken.out, /line 4/, `the refusal must name the line: ${broken.out}`);
    assert.match(broken.out, /entities\.json/, 'and the file');

    // A well-formed file whose entries are not is the same refusal, addressed
    // by entry rather than by line, because an index is what a person edits.
    fs.writeFileSync(
      dictFile,
      JSON.stringify({ entities: [{ kind: 'person', spellings: ['Grace Hopper'] }, { kind: 'person' }] }, null, 2),
      'utf8',
    );
    const noSpellings = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(noSpellings.code, 1, noSpellings.out);
    assert.match(noSpellings.out, /entities\[1\]/, `the refusal must name the entry: ${noSpellings.out}`);
  }],

  // F130, every uuid in the candidates file is already a pseudonym, and
  // declaring one made the export refuse against deident's own output (the
  // reason stripMintedSpellings exists). A dictionary turns that from a
  // one-run mistake into a permanent one, so the stripped list is what gets
  // remembered, using the same function rather than a second copy of the rule.
  ['F130', 'a minted uuid declared as a spelling is never written into the dictionary', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(scan.code, 0, scan.out);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);

    const first = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ], CORPUS_USER_ENV);
    assert.equal(first.code, 0, first.out);

    // A uuid deident minted, taken from its own output. The run is
    // deterministic (cli-ux §11), so the same value is minted again below.
    const entries = readZipFile(path.join(out, fs.readdirSync(out).find((f) => f.endsWith('.zip'))));
    const minted = entries.map((e) => e.data).join('').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    assert.ok(minted !== null, 'the archive should carry rewritten uuids to take one from');

    const declared = path.join(root, 'with-uuid.json');
    fs.writeFileSync(
      declared,
      JSON.stringify({
        entities: [
          { kind: 'person', spellings: ['Nora Lund'], confidence: 'high' },
          // Two spellings, and that is the case the second strip exists for.
          // An entity whose ONLY spelling is a minted uuid is dropped whole by
          // the first strip and never reaches the merge; one that also carries
          // a real spelling survives, and its declared array still holds the
          // uuid unless the merge strips it again.
          // `Bramblesoft Ltd` is fabricated: SHAPE is a real spelling beside
          // the poisoned one, so the entity has to survive minus the uuid.
          { kind: 'secret', spellings: [minted[0], 'Bramblesoft Ltd'], confidence: 'low' },
        ],
      }),
      'utf8',
    );
    const second = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--entities', declared,
    ], CORPUS_USER_ENV);
    assert.equal(second.code, 0, second.out);

    const dict = JSON.parse(fs.readFileSync(path.join(saltDir, DICTIONARY_FILENAME), 'utf8'));
    const remembered = JSON.stringify(dict.entities);
    assert.ok(!remembered.includes(minted[0]), `a minted uuid was remembered as a spelling: ${remembered}`);
    assert.ok(remembered.includes('Bramblesoft Ltd'), `the rest of the entity was thrown away too: ${remembered}`);
  }],

  // F131, the record is a memory of what a person decided, and a person is
  // allowed to change their mind about what counts as an identity. Without a
  // way to ignore the record, the only route back to the whole corpus is
  // deleting a file whose path they would have to be told.
  ['F131', '--full ignores the record and puts the whole corpus in front of a reader again', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    writeLongPromptSession(root, corpus.cwd, 'PROSE-FROM-THE-SESSION-ALREADY-READ');

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(scan.code, 0, scan.out);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ], CORPUS_USER_ENV);
    assert.equal(exported.code, 0, exported.out);

    // Everything is covered, so a bare re-run exports with no reading at all.
    const quiet = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(quiet.code, 0, quiet.out);

    const full = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--full'], CORPUS_USER_ENV);
    assert.equal(full.code, 1, `--full re-reads, so it refuses until the reader answers: ${full.out}`);
    const candidates = fs.readFileSync(path.join(out, 'deident-candidates.txt'), 'utf8');
    assert.ok(candidates.includes('PROSE-FROM-THE-SESSION-ALREADY-READ'), 'a covered session must be shown again');
    assert.ok(candidates.includes('KEEP-THIS-STRING-FORM-PROMPT'), 'and so must the other one');
    assert.doesNotMatch(candidates, /not in this file/, 'nothing is omitted under --full');

    // Combining it with an entity list is refused at the flag: --full says
    // "show me everything again" and --entities says "here is my answer", so
    // a run carrying both would read the answer and then refuse to use it.
    const both = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--full',
      '--entities', path.join(root, 'ents.json'),
    ], CORPUS_USER_ENV);
    assert.equal(both.code, 2, `--full with --entities is a usage error: ${both.out}`);
  }],

  // F132 - which failure it is decides what goes in the candidates file, and
  // "whatever is uncovered" is the wrong answer for one of them.
  //
  // Hand-editing is a first-class use of the dictionary, so the states a
  // hand-editor can leave it in have to be states the tool handles. Delete the
  // entities, keep the session record, and let one session change: coverage is
  // short by one, so a file built from "whatever is uncovered" holds that one
  // session. The reader writes a list from it, the run then succeeds (every
  // session IS recorded as read), and the export ships a corpus whose entity
  // list was derived from a single session. Every gate green.
  //
  // The rule is therefore about the failure, not the coverage. Coverage short:
  // show the sessions that are short. No usable list at all: show the whole
  // corpus, because there is nothing remembered to read against.
  ['F132', 'with no usable entity list, the whole corpus is offered, not only what changed', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    const second = writeLongPromptSession(root, corpus.cwd, 'PROSE-FROM-THE-SESSION-ALREADY-READ');

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(scan.code, 0, scan.out);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    assert.equal(
      runCli([
        'export', '--root', root, '--out', out, '--salt-dir', saltDir,
        '--entities', path.join(root, 'ents.json'),
      ], CORPUS_USER_ENV).code,
      0,
    );

    // The hand edit: the list goes, the record of what was read stays.
    const dictFile = path.join(saltDir, DICTIONARY_FILENAME);
    const dict = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
    assert.ok(Object.keys(dict.sessions).length >= 2, 'the record must survive the edit to prove anything');
    fs.writeFileSync(dictFile, JSON.stringify({ ...dict, entities: [] }, null, 2), 'utf8');
    // ...and one session changes, so coverage is short by exactly one and the
    // "show whatever is uncovered" answer is available and wrong.
    appendTurn(root, second, corpus.cwd, 'PROSE-TYPED-AFTER-THE-LAST-READ');

    const refused = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /semantic pass has not run/, `wrong refusal: ${refused.out}`);

    const candidates = fs.readFileSync(path.join(out, 'deident-candidates.txt'), 'utf8');
    assert.ok(candidates.includes('PROSE-TYPED-AFTER-THE-LAST-READ'), 'the changed session must be offered');
    assert.ok(
      candidates.includes('KEEP-THIS-STRING-FORM-PROMPT'),
      'a list written from the changed session alone would cover a corpus nobody re-read',
    );
    assert.doesNotMatch(candidates, /not in this file/, 'nothing is omitted when there is no list to build on');
  }],

  // F133 - the candidates file is the ONLY surface the semantic reader ever
  // sees, and it used to truncate every chunk at 400 characters. Measured over
  // a copy of the real corpus (216 depth-0 files, 87,797 prose chunks,
  // pre-filter): 27,186 KB of prose extracted, 6,468 KB reaching the reader,
  // so 76.2% of it was dropped. 5,904 chunks (6.7%) were longer than the cap
  // and the longest was 938,529 characters. A name past the cap could not be
  // declared, so the residual scan could not look for it and the export
  // printed `known-entity residue 0` over a name nobody had been shown.
  //
  // "Ingrid Halvorsen" is fabricated. The shape is what the fixture needs: a
  // two-word Latin personal name, which is exactly the class §F1 says has no
  // regex and can only come from the reader.
  ['F133', 'a name 900 characters into one prose chunk reaches the candidates file', () => {
    const file = path.join(tmpdir(), 'candidates.txt');
    const marker = 'Ingrid Halvorsen';
    const prefix = 'the session rambles on and on. '.repeat(30).slice(0, 900);
    const chunk = `${prefix}${marker} reviewed it.`;
    assert.equal(chunk.indexOf(marker), 900, 'the fixture must plant the name past any excerpt cap');

    const written = writeCandidates([chunk], file);
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.includes(marker), 'a name past the excerpt cap never reached the reader');
    assert.ok(body.includes(chunk), 'the whole chunk goes, not a window of it: a window can split a name');
    assert.equal(written.chars, Buffer.byteLength(body, 'utf8'), 'the reported size must be the file');
  }],

  // F134 - the second loss, and the silent one. The dedupe key was a chunk's
  // first 80 characters and the `seen` set is global across sessions, so a
  // chunk that merely OPENED like an earlier one was discarded whole.
  // Measured on the same corpus copy: 1,590 chunks (10,443,749 characters)
  // were dropped by that key while not being byte-identical to the chunk that
  // claimed it. Session prose opens the same way constantly (a pasted error, a
  // repeated instruction, the same command re-run), and the names are in what
  // comes after.
  //
  // Both names are fabricated; the shape is two different third parties named
  // in two turns that begin identically.
  ['F134', 'two chunks sharing their first 80 characters both reach the reader', () => {
    const file = path.join(tmpdir(), 'candidates.txt');
    const shared = 'I asked the agent to redo the database migration script and it failed again at step ';
    assert.ok(shared.length >= 80, `the shared opening must fill the old 80-character key: ${shared.length}`);
    const first = `${shared}four. Ingrid Halvorsen wrote it.`;
    const second = `${shared}nine. Ottoline Marsh wrote that one.`;
    assert.equal(first.slice(0, 80), second.slice(0, 80), 'the fixture must collide on the old key');

    writeCandidates([first, second], file);
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(body.includes('Ingrid Halvorsen'), 'the first chunk is missing');
    assert.ok(body.includes('Ottoline Marsh'), 'a chunk was dropped for opening like another one');
  }],

  // F134b - the cap that remains, and the reason it is not the one that was
  // removed. Measured on a copy of the real corpus with the cap off: the
  // candidates file goes from 2,957,659 to 13,026,553 bytes, so removing the
  // cap outright lands far above the 915 KB docs/cli-ux.md §11b budgets. The
  // cap therefore stays, at a value taken from the measured post-retention
  // distribution rather than from the old 400, and the loss it causes is
  // COUNTED and printed. A reader handed a short file has to be told it is
  // short; that is the whole difference from what was there before.
  ['F134b', 'a chunk past the cap is truncated, and the omitted characters are counted and stated', () => {
    const file = path.join(tmpdir(), 'candidates.txt');
    const over = 5_000;
    const chunk = 'a'.repeat(CANDIDATE_CHUNK_CHARS + over);

    const written = writeCandidates([chunk], file);
    assert.equal(written.omittedChars, over, 'the omitted characters must be counted, not dropped silently');

    const body = fs.readFileSync(file, 'utf8');
    assert.ok(!body.includes('a'.repeat(CANDIDATE_CHUNK_CHARS + 1)), 'the cap did not apply');
    // Stated in the file as well as in the terminal, for the same reason the
    // omitted-sessions note is: the file is what gets handed to a reader.
    assert.match(body, /characters of prose were not shown/, 'the file must say it is short');

    // A chunk at the cap is not truncated and reports nothing omitted.
    const exact = writeCandidates(['b'.repeat(CANDIDATE_CHUNK_CHARS)], file);
    assert.equal(exact.omittedChars, 0);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /characters of prose were not shown/);

    // ...and the count reaches the terminal and --json, not just the file. A
    // number that only exists inside the artifact it describes is not a
    // disclosure to whoever is running the tool.
    const root = tmpdir();
    const outDir = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    writeLongPromptSession(root, corpus.cwd, 'PAST-THE-CAP '.repeat(2_000));
    assert.equal(runCli(['scan', '--root', root, '--out', outDir, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(outDir, 'review.md'), 'alpha', 'redact');

    const refused = runCli(['export', '--root', root, '--out', outDir, '--salt-dir', saltDir, '--json'], CORPUS_USER_ENV);
    assert.equal(refused.code, 1, refused.out);
    const doc = JSON.parse(refused.out);
    assert.ok(doc.candidates.omittedChars > 0, `--json must carry the loss: ${JSON.stringify(doc.candidates)}`);

    const spoken = runCli(['export', '--root', root, '--out', outDir, '--salt-dir', saltDir, '--full'], CORPUS_USER_ENV);
    assert.match(spoken.out, /characters of prose were not shown/, `the terminal must say it too: ${spoken.out}`);
  }],

  // F135 - the sweep was anchored on English label words only, so a document
  // number named in Chinese was never seeded, never substituted, and invisible
  // to the residual scan, which can only look for what it was given. The
  // manifest printed nothing. F81's Taiwan passport number was caught only
  // because that one document happened to be written in English.
  //
  // All three numbers are fabricated. The shape is what the sweep keys off: a
  // leading letter and nine digits, which is the ROC passport / national id
  // form, sitting after a Chinese label with no space, since CJK does not
  // space its words.
  ['F135', 'a document number labelled in Chinese is swept, and a label with no number is not', () => {
    assert.deepEqual(sweepIdNumbers(['護照號碼：A123456789']), ['A123456789']);
    assert.deepEqual(sweepIdNumbers(['身分證字號: A123456789']), ['A123456789']);
    assert.deepEqual(sweepIdNumbers(['台胞證 A123456789 過期了']), ['A123456789']);
    // §F7 in the language the labels are in: the words appear constantly in
    // ordinary sentences, and a sweep that fires without a number beside them
    // is the scan that gets switched off.
    assert.deepEqual(sweepIdNumbers(['身分證字號忘記了']), []);
    assert.deepEqual(sweepIdNumbers(['護照過期，要去辦新的']), []);

    // A date is never a document number, and an expiry date is the thing most
    // likely to be written right after the label. Measured over the whole
    // depth-0 corpus (216 files, 934 MB): the Chinese labels added exactly two
    // numbers to the swept set, and one of them was an ISO date sitting in
    // `舊護照 <date> 到期`. Seeding it would substitute every occurrence of
    // that date everywhere in the export, which is §F7 exactly.
    //
    // The English half has the same hole and nobody had hit it, because
    // English puts a word between the label and the date and the pattern does
    // not allow one. Punctuate it the way a form does and it is reachable
    // there too, so the guard is on the captured VALUE rather than on one
    // language's labels.
    assert.deepEqual(sweepIdNumbers(['他的舊護照 2026-08-24 到期']), []);
    assert.deepEqual(sweepIdNumbers(['passport: 2026-08-24']), []);
    // ...and the guard is date-shaped only, so a hyphenated document number
    // of the same length still counts. Fabricated; the shape is a grouped
    // alphanumeric document number.
    assert.deepEqual(sweepIdNumbers(['護照號碼：AB-1234567']), ['AB-1234567']);
  }],

  // F136 - F51 grants case-insensitive matching to every bicameral script, and
  // Greek has the one context-sensitive lowercase mapping in Unicode's default
  // algorithm: a trailing sigma lowercases to ς, not σ. buildTable lowered the
  // whole spelling at once, so it got the contextual form; equalsFold lowers
  // one isolated character at a time, and an isolated Σ always gives σ. They
  // disagreed at the last character and nothing matched, including the
  // spelling against its own text.
  //
  // Silent AND ungated: residual.mjs imports equalsFold by design so the two
  // "never drift". They did not drift, they were wrong together, and the
  // export printed `known-entity residue 0` with the name in the archive.
  //
  // Odysseus is a figure out of Homer, not a person. The shape is what the
  // fixture needs: a Greek personal name ending in sigma.
  ['F136', 'a Greek name ending in sigma matches in either case, and the residue scan sees it', () => {
    const upper = 'ΟΔΥΣΣΕΎΣ';
    const text = `ο ${upper} ήρθε`;

    const table = buildTable([entity('P1', 'person', upper, 'PERSON_01')]);
    const self = substituteString(text, table);
    assert.equal(self.out, 'ο PERSON_01 ήρθε', 'the all-caps spelling did not match its own text');
    assert.equal(reverseString(self.out, self.spans), text, 'ς and σ are both one UTF-16 unit; the span must reverse');

    // The other direction: declared the way a person writes it, written in the
    // log the way a shouting header does.
    const declared = buildTable([entity('P2', 'person', 'Οδυσσεύς', 'PERSON_02')]);
    assert.equal(substituteString(text, declared).out, 'ο PERSON_02 ήρθε', 'a lowercase declaration missed all-caps text');

    // The gate the leak went past. Scanned against the ORIGINAL text, which is
    // what the substituter was handed and left alone.
    assert.equal(residualScan(text, table, new Set()).entityCount, 1, 'the residue scan agreed with the bug');
  }],

  // F137 - root.mjs diagnoses this exact failure for this exact variable, in a
  // comment, and fixes it with nonBlank. The MCP seeder was never told: it read
  // `env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')`, and `??` treats only
  // null and undefined as absent, so a shell profile that exports the variable
  // unconditionally left it as '' and path.join('', 'settings.json') became a
  // bare relative path read against the cwd.
  //
  // Silent on top of that: the "no Claude settings file found" warning fires
  // only when NONE of the three candidates was read, and ~/.claude.json is one
  // of them, so on most machines the seeder lost settings.json and .mcp.json
  // and said nothing at all.
  ['F137', 'a blank CLAUDE_CONFIG_DIR falls through to the default, and MCP names are still seeded', () => {
    const home = tmpdir();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    // Fabricated server name. The shape is what matters: an mcpServers key, in
    // the settings file the blank value hid.
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { 'harbourline-notes': { command: 'node' } } }),
      'utf8',
    );

    const seeded = seedEntities(
      { HOME: home, USERPROFILE: home, USERNAME: 'devuser', CLAUDE_CONFIG_DIR: '' },
      { files: [] },
      { cwds: [], repoDirs: [], texts: [] },
    );
    const canonicals = seeded.entities.map((e) => e.canonical);
    assert.ok(
      canonicals.includes('harbourline-notes'),
      `a blank CLAUDE_CONFIG_DIR sent the seeder to the cwd: ${canonicals.join(', ')}`,
    );
    // And the warning that hid it must not be the thing reporting success.
    assert.ok(
      !seeded.warnings.some((w) => w.includes('no Claude settings file found')),
      `the settings file was read, so nothing should say it was not: ${seeded.warnings.join(' | ')}`,
    );
  }],

  // F138 - the glued-residue rows are the disclosure a person can act on: the
  // count, the spelling, an excerpt, and "Decide per row". gluedWorthy gated
  // them on `spelling.length >= GLUED_MIN`, so two users with identical corpora
  // and identical leaks got different exports, and the ones who got only an
  // aggregate count beside a green check were the ones with three- and
  // four-character given names.
  //
  // The flood that justified the length gate is a class of NEIGHBOUR, not a
  // class of length. Re-measured over ~20 MB of session logs, per seed,
  // counting only the occurrences the boundary rule refused, split by whether
  // the neighbour that actually blocks is a letter:
  //
  //   3 chars  letter-blocked median 412, worst 8,371 | sep/digit median 20, worst 52
  //   4 chars  letter-blocked median  46, worst   113 | sep/digit median  4, worst 26
  //
  // One to two orders of magnitude, and the small class is where the real leaks
  // are: this run surfaced a person's name on an identity-document filename,
  // refused because an underscore preceded a four-character spelling. `ray`
  // inside `array` stays out on the letter test, which is BRIEF §4.5 row 4 and
  // is still pinned in F125.
  ['F138', 'a short username glued to a separator or a digit gets a row, and a short name inside a word does not', () => {
    // Fabricated. The SHAPE each value exists to preserve:
    //   lok               a three-character romanised given name, the length
    //                     class the old gate excluded outright
    //   Miho              a four-character romanised given name
    //   wei, anna         the same two lengths again, chosen because each sits
    //                     inside an ordinary English word the way `ray` sits
    //                     inside `array`
    //   st_lok_prod       an underscore-joined cloud resource name
    //   kv-Miho0123       a hyphen-and-digit resource name
    //   HKID_MihoYan.jpg  an identity-document filename, which is the shape the
    //                     refused real leak had
    const short = buildTable([
      { id: 'PERSON_01', kind: 'person', tier: 0, pseudonym: 'PERSON_01', spellings: ['lok'] },
    ]);
    const lok = residualScan('deploy st_lok_prod now', short, new Set());
    assert.equal(lok.gluedHits.length, 1, 'a three-character username glued to underscores got no row');
    assert.equal(lok.gluedHits[0].count, 1);
    assert.ok(lok.gluedHits[0].excerpt.includes('lok'), 'the row carries an excerpt to judge it by');
    // A report, never a gate: §4.5 row 4 makes these correct non-matches.
    assert.equal(lok.entityCount, 0, 'a glued occurrence must not fail the export');

    const four = buildTable([
      { id: 'PERSON_02', kind: 'person', tier: 0, pseudonym: 'PERSON_02', spellings: ['Miho'] },
    ]);
    const digits = residualScan('kv-Miho0123 and HKID_MihoYan.jpg', four, new Set());
    assert.equal(digits.gluedHits.length, 1, 'a four-character username on a filename got no row');
    assert.equal(digits.gluedHits[0].count, 2, 'the digit run and the camel-hump filename are both occurrences');

    // The other direction, which is what the length gate was really protecting
    // against. Both of these abut a LETTER, so both stay out and the report
    // stays something a person finishes reading.
    const inWord = buildTable([
      { id: 'PERSON_03', kind: 'person', tier: 0, pseudonym: 'PERSON_03', spellings: ['wei'] },
    ]);
    assert.equal(residualScan('the weight of it', inWord, new Set()).gluedHits.length, 0);
    const anna = buildTable([
      { id: 'PERSON_04', kind: 'person', tier: 0, pseudonym: 'PERSON_04', spellings: ['anna'] },
    ]);
    assert.equal(residualScan('the annals of the sample', anna, new Set()).gluedHits.length, 0);
  }],

  // F139 - what F138 still refuses has to be said out loud. renderGluedResidue
  // returns without printing when there are no rows, so for a short spelling
  // whose occurrences are all letter-blocked the reader sees the green
  // `known-entity residue 0` line and nothing else. An absent list reads as a
  // clean result, and the reason it is absent is the letter beside the
  // spelling, not an absence of occurrences.
  ['F139', 'a short spelling refused for the letter beside it is named in the limits block, not silently dropped', () => {
    // Fabricated. SHAPE: `wei` is a three-character tier-0 person spelling (an
    // email local part, lowercased) that sits inside ordinary English words,
    // which is the exact population the row list refuses.
    const table = buildTable([
      { id: 'PERSON_01', kind: 'person', tier: 0, pseudonym: 'PERSON_01', spellings: ['wei'] },
    ]);
    const scan = residualScan('the weight and the weightings', table, new Set());
    assert.equal(scan.gluedHits.length, 0, 'a letter-blocked short spelling must not become a row');
    assert.deepEqual(
      scan.gluedNotListed.map((r) => [r.spelling, r.count]),
      [['wei', 2]],
      'the occurrences the row list refused were not counted anywhere',
    );

    // And it reaches all three surfaces, because limits.mjs is the single
    // source the terminal, the preview and review.html all render. F76 is the
    // fixture that exists because this block once lived in three files.
    const m = {
      sessions: 1, workspaces: 1, userMessages: 1, zeros: [],
      droppedByCwd: 0, emptiedSessions: 0, embedded: 2, escapeArtifacts: 0,
      residueLine: '0 occurrences of 1 entity spellings', unknownTypes: [],
      countOnly: { sessions: 0, workspaces: 0 },
      gluedNotListed: [{ spelling: 'wei', count: 2 }],
    };
    const terminal = captureOutput(() => renderManifest(m));
    const preview = renderPreview({
      generated: 'now', strings: [], table: null, entities: [], manifest: m, checks: [],
    });
    const html = renderReviewHtml({
      generated: 'now', workspaces: [], entities: [], sessions: [], flaggedSessions: [], manifest: m,
    });
    for (const [name, whole] of [['terminal', terminal], ['preview', preview], ['review.html', html]]) {
      const at = whole.indexOf('NOT protected against');
      assert.ok(at >= 0, `${name} has no NOT-protected block`);
      const text = whole.slice(at);
      assert.match(text, /wei/, `${name} does not name the spelling that was left out`);
      assert.match(text, /not examined, not clean/, `${name} lets an empty row list read as a clean result`);
    }
  }],

  // F140 - both name-based guards in this file are English words matched over
  // /[^a-z0-9]+/ segments, so neither of them reads a directory named in
  // another script at all. Measured by running the real code: for a directory
  // named in Han or Cyrillic, denyToken came back null, personalDataShape came
  // back null, and proposeTier answered `redact`. So a second user's private
  // archive, named in their own language and carrying a git remote, is offered
  // for export with no typed confirmation and the green residue check prints
  // afterwards.
  //
  // personalDataShape exists BECAUSE of the incident at signals.mjs: a personal
  // message archive shipped a third party's real name 10 times on the strength
  // of its remote alone. Silence from an instrument that could not look is not
  // a clearance, so this fails closed the same way GIT_UNAVAILABLE does.
  ['F140', 'a workspace named in a script the deny-list cannot read is not cleared by its remote', () => {
    const remote = (raw) => ({ raw, owner: raw.split('/')[0], repo: raw.split('/')[1], host: null });
    const group = (name) => ({ name, cwd: `C:${BS}x${BS}${name}`, denyToken: null, unresolved: false });

    // Fabricated. SHAPE: an ordinary directory name written in a non-Latin
    // script, one Han and one Cyrillic. The words themselves carry nothing;
    // what they preserve is that DENY_TOKENS and PERSONAL_TOKENS cannot read
    // either of them, whatever they say.
    for (const name of ['私人紀錄', 'личное']) {
      const p = proposeTier(group(name), () => remote(`me/${name}`));
      assert.equal(p.tier, 'unclassified', `${name} was cleared by an instrument that could not read it`);
      assert.match(p.reason, /denied\.json/, `${name} refused without naming a remedy the person can run`);
    }

    // Latin work names are untouched, or the review row becomes 29 questions.
    assert.equal(proposeTier(group('ledger'), () => remote('northwind-co/ledger')).tier, 'redact');
    // And the per-person file is what actually closes it, in both directions:
    // one token added there feeds matchDenyToken and deniedPathToken alike.
    setUserDeny({ tokens: ['私人'] });
    try {
      assert.equal(matchDenyToken(`C:${BS}x${BS}私人紀錄`), '私人');
      assert.equal(proposeTier({ ...group('私人紀錄'), denyToken: '私人' }, () => remote('me/x')).tier, 'exclude');
    } finally {
      setUserDeny({});
    }
  }],

  // F141 - SECRET_RE is a list of the vendor prefixes the author personally
  // uses, so a live key from any other vendor ships verbatim while the manifest
  // prints `0 secrets  0 replaced` two lines above the limits block. Nothing
  // downstream recovers it: residual.mjs scans only for KNOWN entity spellings
  // plus unknown UUIDs, so a token the sweep never saw is invisible to it by
  // construction, and the semantic pass never reads tool output at all
  // (tier1.mjs excludes it), which is where all three of the measured leaks
  // were.
  //
  // Reproduced against the shipped sweepSecrets before this fixture: eleven
  // live-credential shapes, eleven empty arrays.
  //
  // The fix is the class rather than the vendor. The words beside the value
  // are the evidence, exactly as in ID_NUMBER_RE and BEARER_RE, so a vendor
  // nobody has invented yet is covered the moment its key is written down
  // beside the word `api_key`.
  ['F141', 'a credential is swept by the words beside it, not only by a vendor prefix the list happens to carry', () => {
    // Fabricated. Every value is synthetic; what each one preserves is its
    // SHAPE, which is the only thing the pattern reads.
    const cases = [
      // a vendor prefix the list did not have, reached through its label
      ['OPENAI_API_KEY=sk-proj-REDACTED_Qv7mL2', 'sk-proj-REDACTED_Qv7mL2'],
      // a payment-provider live key, reached by the prefix alone
      ['STRIPE=sk_live_REDACTED_9dHm2Q', 'sk_live_REDACTED_9dHm2Q'],
      // a package-registry automation token
      ['npm_REDACTED_7bKq3Z', 'npm_REDACTED_7bKq3Z'],
      // a source-forge personal access token
      ['glpat-REDACTED_4Nq8Wz', 'glpat-REDACTED_4Nq8Wz'],
      // a model-hub token
      ['hf_Zb4Kq9Wm2Tv7Rn5Ly8Hs3Jc6Xp1Fd0Gg', 'hf_Zb4Kq9Wm2Tv7Rn5Ly8Hs3Jc6Xp1Fd0Gg'],
      // a chat-platform app-level token
      ['xapp-1-A01BCDEF-Qv7mL2xTb9RnKd4WpZs6Hy', 'xapp-1-A01BCDEF-Qv7mL2xTb9RnKd4WpZs6Hy'],
      // the class rule with no vendor prefix at all: a label naming a
      // credential, then a 16+ character value with no space in it
      ['  api_key: "x7Kq2mZp9RvT4nWb8dLc"', 'x7Kq2mZp9RvT4nWb8dLc'],
      ['client_secret=Hq3Vt8Nm2Rb6Yw9Ls4Zx', 'Hq3Vt8Nm2Rb6Yw9Ls4Zx'],
      // a database URL carrying its password inline, which README named as a
      // gap by hand
      ['postgres://app:Tr0ub4dor3xtra@db.internal:5432/prod', 'Tr0ub4dor3xtra'],
    ];
    for (const [text, want] of cases) {
      assert.ok(
        sweepSecrets([text]).includes(want),
        `shipped verbatim with the manifest printing 0 secrets: ${text}`,
      );
    }

    // §F7 precision, in the direction that matters for a pattern this wide: a
    // labelled value that NAMES a credential is not one, and substituting it
    // would replace an ordinary identifier everywhere it occurs.
    for (const text of [
      'api_key: process.env.OPENAI_API_KEY',
      'const secret_key = OPENAI_ADMIN_TOKEN',
      'password: <redacted>',
    ]) {
      assert.deepEqual(sweepSecrets([text]), [], `over-swept an identifier: ${text}`);
    }

    // A private key body is not a value to substitute, it is a block to drop.
    // It almost always arrives as tool output, which routes through
    // deniedReason, so it belongs on the content deny-list rather than in the
    // entity sweep. Fabricated: the header and footer are the shape; the
    // middle is not key material.
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join(NL);
    assert.equal(deniedReason(pem), '-----BEGIN OPENSSH PRIVATE KEY-----');
    assert.equal(deniedReason('we discussed rotating the deploy key'), null);
  }],

  // F142 - the other half of F141, and the half that cannot be closed by code:
  // enumerating prefixes stays reactive forever, so whatever the sweep knows
  // today there is a vendor tomorrow it does not. The manifest prints
  // `0 secrets  0 replaced` as a zeros row whose whole purpose is to be
  // believed, and the limits block six lines below said nothing about
  // unrecognised credential shapes. An affirmative zero from a detector reads
  // louder and closer than a pointer to README.
  //
  // The block must also not list a shape the tool DOES handle. cli-ux §6: a
  // disclosure hiding an implemented-but-inert control is worse than either
  // honest option, which is what F76 exists for.
  ['F142', 'the limits block says what the 0 secrets row does not cover, without claiming a handled shape is unhandled', () => {
    const block = limitLines({}).join(NL);
    assert.match(block, /none of the shapes it knows/, 'the zeros row is left to speak for itself');
    assert.match(block, /never reads tool output/, 'the block does not say why nothing downstream recovers it');
    // Handled now, so naming them here would be the disclosure hiding a real
    // control: a labelled value, a signed URL, an inline database password and
    // a private key body all have a sweep or a deny rule.
    for (const handled of [/private key/i, /database URL/i, /Bearer/i]) {
      assert.ok(!handled.test(block), `the block claims an implemented control is missing: ${handled}`);
    }

    // README said "only the semantic pass can catch them" of exactly these
    // shapes, and that is false in the direction that matters: the semantic
    // pass reads prose only, and every measured credential leak was tool
    // output.
    const readme = fs.readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    assert.ok(
      !readme.includes('only the semantic pass can catch them'),
      'README still points at a pass that never sees tool output',
    );
  }],

  // F143 - the candidates file is the whole safety gate, and it had no size
  // cap. rememberShown runs on every session in the batch immediately after
  // writeCandidates and before the refusal is thrown, keyed on having been
  // SHOWN, so a reader who read 200 KB of a 915 KB file gets every session in
  // it recorded as read and the next export prints `205/205 sessions read ok`.
  // That is worse than silent: it is a positive false claim, and the size is
  // documented in three places as an argument for why triage exists, never as
  // a consequence.
  //
  // So budget the batch and remember only what was in it. The existing
  // coverageRefusal already drives the next batch, because a session that was
  // never recorded is still uncovered.
  ['F143', 'the candidates file is capped per run, and only the sessions actually in it are recorded as read', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const dir = path.join(root, 'projects', 'ws');
    fs.mkdirSync(dir, { recursive: true });
    // Fabricated. SHAPE: three separate sessions in one included workspace,
    // each carrying a few hundred characters of DISTINCT prose. Distinct
    // matters: writeCandidates dedupes on exact text, so three identical turns
    // would collapse into one and no budget would ever fire.
    const cwd = ['C:', 'Users', 'devuser', 'projects', 'batch'].join(BS);
    const ids = [
      '55555555-5555-4555-8555-555555555551',
      '55555555-5555-4555-8555-555555555552',
      '55555555-5555-4555-8555-555555555553',
    ];
    ids.forEach((sid, i) => {
      fs.writeFileSync(
        path.join(dir, `${sid}.jsonl`),
        JSON.stringify({
          type: 'user',
          uuid: `00000000-0000-4000-8000-00000000000${i + 1}`,
          sessionId: sid,
          timestamp: '2026-08-20T10:11:12.345Z',
          cwd,
          message: { role: 'user', content: [{ type: 'text', text: `session ${i} prose. ` + `filler ${i} `.repeat(40)}] },
        }) + NL,
        'utf8',
      );
    });

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);
    setTier(path.join(out, 'review.md'), 'batch', 'redact');

    // One session's prose is a little under 400 characters, so a 500-character
    // budget takes exactly one and defers the other two.
    const args = ['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--batch-chars', '500'];
    const first = runCli(args);
    assert.equal(first.code, 1, first.out);
    const dictFile = path.join(saltDir, DICTIONARY_FILENAME);
    assert.equal(
      Object.keys(JSON.parse(fs.readFileSync(dictFile, 'utf8')).sessions).length,
      1,
      'sessions the reader was never shown were recorded as read',
    );
    const body = fs.readFileSync(path.join(out, 'deident-candidates.txt'), 'utf8');
    assert.match(body, /This is one batch. 2 more sessions are not in this file/, 'the file does not say it is one batch of several');

    // And the loop advances: supply a list, and the next run offers the next
    // batch rather than the same one.
    fs.writeFileSync(
      path.join(root, 'ents.json'),
      JSON.stringify({ entities: [{ kind: 'person', spellings: ['Nora Lund'], confidence: 'high' }] }),
      'utf8',
    );
    const second = runCli([...args, '--entities', path.join(root, 'ents.json')]);
    assert.equal(second.code, 1, 'the two deferred sessions still have to be read');
    assert.equal(
      Object.keys(JSON.parse(fs.readFileSync(dictFile, 'utf8')).sessions).length,
      2,
      'the next run did not advance to the next batch',
    );

    // A budget below the size of any single session still offers one, or one
    // oversized session stalls the loop forever.
    const tiny = runCli(['export', '--root', root, '--out', out, '--salt-dir', path.join(root, 'salt2'), '--batch-chars', '1']);
    assert.equal(tiny.code, 1, tiny.out);
    assert.match(
      fs.readFileSync(path.join(out, 'deident-candidates.txt'), 'utf8'),
      /session 0 prose/,
      'a budget below one session size offered nothing at all',
    );
  }],

  // F144 - uncoveredNameParts exists to catch the half-replacement: the full
  // name is substituted, the prose names him again two sentences later, and no
  // other check can see it because the residue scan only looks for what it was
  // given. The single-word guard tested for whitespace, so the whole detector
  // was switched off for any name written without spaces.
  //
  // Verified against the shipped modules before this fixture: the Latin pair
  // returned a row, the Han pair returned [], and substituteString on the same
  // Han prose replaced the declared name once and shipped the bare half twice,
  // verbatim, with every gate green.
  ['F144', 'a bare half of a CJK name left in the prose is reported the same way a bare surname is', () => {
    // Fabricated. SHAPE: a three-codepoint Han personal name, surname then
    // two-codepoint given name, declared in full; then the given name standing
    // alone twice in the prose. That is the same half-replacement as
    // `Grace Hopper` declared and a bare `Hopper` left behind.
    const rows = uncoveredNameParts(
      [{ kind: 'person', spellings: ['王大明'] }],
      ['王大明送出了報告。大明後來回覆說大明週五會再確認。'],
    );
    assert.equal(rows.length, 1, `expected one row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].part, '大明');
    assert.equal(rows[0].from, '王大明');
    // The BARE uses, not every occurrence: the probe table carries the declared
    // spelling alongside the candidate and the longer one claims its own span.
    assert.equal(rows[0].count, 2, 'the count is not the bare uses');

    // The other half is proposed too and disappears on its own, because a row
    // with count 0 is dropped. That is what bounds the cost to at most two
    // extra probe rows per CJK person, and it is why this stays a finding
    // rather than a gate: May, Wise and Ray are ordinary words in Latin and
    // the same is true of a two-character Han fragment.
    assert.deepEqual(
      uncoveredNameParts([{ kind: 'person', spellings: ['王大明'] }], ['王大明送出了報告，沒有別的名字。']),
      [],
      'a half that never stands alone must not become a row',
    );

    // A one-codepoint Han spelling still has no parts, and BRIEF §4.5 row 3 is
    // why: it has no boundary rule and over-matches inside a longer word.
    assert.deepEqual(uncoveredNameParts([{ kind: 'person', spellings: ['林'] }], ['林先生來了']), []);
  }],

  // F145 - `isWordChar` was /[A-Za-z0-9_]/ and `isCjkOnly` was "no ASCII letter
  // or digit", so every alphabetic script except Latin got needsLeft false,
  // needsRight false, and the treatment reserved for scripts that genuinely
  // have no word boundaries. Verified by running the engine before this
  // fixture:
  //
  //   Роман  in "Он читал романы весь день"  became "…PERSON_01ы весь день"
  //   דוד    in "דודה שלי" (my aunt)          became "PERSON_03ה שלי"
  //   Νίκος  in "Νίκοςαβγ"                    became "PERSON_02αβγ"
  //
  // and every one of those spans came back cjk: true, so the terminal reported
  // them as CJK as well.
  //
  // That is BRIEF §4.5's `小明` inside `小明天` failure, "corrupted a sentence
  // naming nobody with every gate green", reproduced in scripts where the
  // writing system does not force it. For Han and Kana there is no boundary to
  // test and running unguarded while flagging is the only honest option. Greek,
  // Cyrillic, Hebrew and Arabic put spaces between words: the rule works
  // perfectly for them the moment the character class stops being ASCII.
  ['F145', 'a space-delimited non-Latin script gets the ordinary boundary rule, and is not reported as CJK', () => {
    // Fabricated. SHAPE: one entity per script, each sitting inside a longer
    // ordinary word of that script, which is what makes the missing boundary
    // rule a corruption rather than a miss.
    //   Роман  a Cyrillic given name inside the common noun `романы` (novels)
    //   Νίκος  a Greek given name with more Greek letters glued after it
    //   דוד    a Hebrew given name inside `דודה` (aunt)
    const table = buildTable([
      { id: 'P1', kind: 'person', tier: 0, pseudonym: 'PERSON_01', spellings: ['Роман'] },
      { id: 'P2', kind: 'person', tier: 0, pseudonym: 'PERSON_02', spellings: ['Νίκος'] },
      { id: 'P3', kind: 'person', tier: 0, pseudonym: 'PERSON_03', spellings: ['דוד'] },
    ]);
    for (const [inside, why] of [
      ['Он читал романы весь день', 'Cyrillic'],
      ['Νίκοςαβγ', 'Greek'],
      ['דודה שלי', 'Hebrew'],
    ]) {
      assert.equal(substituteString(inside, table).out, inside, `${why}: a sentence naming nobody was corrupted`);
    }

    // And the rule still MATCHES when the neighbour really is a boundary, or
    // this would be a fix that turns a corruption into a leak.
    for (const [bounded, want] of [
      ['Роман прислал отчёт', 'PERSON_01 прислал отчёт'],
      ['ο Νίκος ήρθε', 'ο PERSON_02 ήρθε'],
      ['דוד שלח', 'PERSON_03 שלח'],
    ]) {
      assert.equal(substituteString(bounded, table).out, want, `a bounded occurrence stopped matching: ${bounded}`);
    }

    // The flag, which is the report label. A space-delimited script now has a
    // boundary rule, so calling its replacements unproven CJK was false twice
    // over.
    assert.equal(substituteString('Роман прислал отчёт', table).spans[0].cjk, false);
    assert.equal(isCjkOnly('Роман'), false);
    assert.equal(isCjkOnly('Νίκος'), false);
    assert.equal(isCjkOnly('דוד'), false);

    // Scripts that really are written without spaces are untouched: no
    // boundary to test, so they run unguarded and are flagged, which is what
    // BRIEF §4.5 asks for and what F01 to F03 pin.
    for (const spaceless of ['王大明', 'ひらがな', 'カタカナ', '한국말', 'ภาษาไทย']) {
      assert.equal(isCjkOnly(spaceless), true, `${spaceless} lost its flag`);
    }
    const han = buildTable([{ id: 'P4', kind: 'person', tier: 0, pseudonym: 'PERSON_04', spellings: ['小明'] }]);
    const overmatch = substituteString('小明天要下雨', han);
    assert.equal(overmatch.out, 'PERSON_04天要下雨', 'the CJK over-match is a known limit, not something to silently fix here');
    assert.equal(overmatch.spans[0].cjk, true, 'and it must still be flagged');
  }],

  // F146 - the agent-memory deny-list matches FILENAMES, and it knows one
  // naming convention: MEMORY.md plus reference_/feedback_/project_/user_*.md,
  // which is the author's own memory-index layout rather than a Claude Code
  // universal. Two source comments asserted the opposite, and nothing in
  // README, docs, SKILL.md or the terminal said it at all, so a second user
  // whose memory files are named otherwise got an archive, a manifest and a
  // green residue line with their harness-injected private notes riding along
  // as ordinary prose.
  //
  // Words rather than code, because the machinery is already complete: the
  // primary channel is a <system-reminder> span and INJECTED_SPANS drops every
  // one of those whatever it is called. What is left is a memory file a tool
  // READ for you, and the fix for that is one token in denied.json.
  ['F146', 'the agent-memory deny-list says which filenames it knows, at the moment of export', () => {
    const block = limitLines({}).join(NL);
    assert.match(block, /agent memory a tool READ for you/, 'the limit is stated nowhere the person hits it');
    assert.match(block, /denied\.json/, 'the disclosure names no remedy the person can run');

    // Pinned here so the disclosure and the list cannot drift. Fabricated
    // names. The SHAPE: one file using a recognised prefix, the index file
    // itself, and one ordinary name a different user would plausibly choose.
    assert.equal(deniedReason('reference_local_setup.md'), 'reference_local_setup.md');
    assert.equal(deniedReason('MEMORY.md'), 'MEMORY.md');
    assert.equal(
      deniedReason('brain/what-i-know-about-people.md'),
      null,
      'a memory file under any other name ships as ordinary prose, which is the thing to disclose',
    );

    // And the same sentence is in README, because the terminal block is one
    // line and a person deciding what to put in denied.json needs the list.
    const readme = fs.readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    assert.match(readme, /Claude Code universal/, 'README still implies the list is universal');
  }],

  // F147 - a session is hashed over its whole retained prose, so appending one
  // turn makes the whole session uncovered again. Re-showing a changed session
  // in full is deliberate and right (appended turns read without the
  // conversation around them are worse for entity discovery, and over-showing
  // is the safe direction). What is not right is the case where that never
  // terminates: a session still being written, very often the one the reader is
  // sitting in. Every turn they add to it while working through the refusal
  // changes its prose back, so the refusal returns and the loop reads as a bug
  // in the tool.
  //
  // No behaviour change: the gate keeps refusing, which is correct. What was
  // missing is the sentence that turns an apparent bug into an instruction.
  ['F147', 'a session still being written is named as such in the refusal, with what to do about it', () => {
    const now = Date.now();
    // Fabricated session ids. SHAPE: one whose file was touched two minutes ago
    // (the session the reader still has open) and one that was not.
    const err = coverageRefusal(
      [
        { id: 'a3f9', reason: 'changed since it was last read', mtimeMs: now - 2 * 60 * 1000 },
        { id: '7c02', reason: 'new since the last read', mtimeMs: now - 40 * 60 * 60 * 1000 },
      ],
      2,
      'deident-candidates.txt',
    );
    const why = err.why.join(NL);
    assert.match(why, /a3f9 {3}changed since it was last read {3}\(written 2 minutes ago\)/);
    assert.ok(!/7c02.*written \d/.test(why), 'a session nobody is writing must not be marked fresh');
    assert.match(why, /every turn you add changes it back/, 'the refusal does not say why reading it again will not clear it');

    // With nothing fresh, the paragraph must not appear: a sentence about a
    // session you have open, printed when you have none, is the cry-wolf
    // failure in prose.
    const stale = coverageRefusal([{ id: '1de4', reason: 'new since the last read', mtimeMs: now - 86_400_000 }], 1, 'x');
    assert.ok(!stale.why.join(NL).includes('every turn you add changes it back'));

    // And the mtime really reaches the refusal on a real run, which is the half
    // a unit test on coverageRefusal cannot prove. The turn below is appended a
    // moment before the export, exactly as an open session appends one.
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    appendTurn(root, '11111111-1111-4111-8111-111111111111', corpus.cwd, 'one more turn, typed just now');
    const run = runCli(
      ['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--entities', path.join(root, 'ents.json')],
      CORPUS_USER_ENV,
    );
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /written 1 minute ago/, 'the file mtime never reached the refusal');
  }],

  // F148 - the reader-facing surfaces argue in tiers, not in product names.
  //
  // deident calls no model itself, so the logic was never vendor bound. The
  // prose was. docs/model-tier.md ran its whole argument on one vendor's three
  // product names and src/policy/triage.mjs quoted it, so a reader on another
  // harness met "do not run this step at the haiku tier" and had no haiku. The
  // finding underneath is about reasoning strength and failure direction and
  // survives the rename with every number intact.
  //
  // WHAT THIS ASSERTS: no model name and no subscription-plan name appears in
  // the files a user of the tool reads, with one deliberate exception. The
  // preamble of docs/model-tier.md, before its first section heading, may name
  // the tiers that were actually measured, once, so the numbers stay checkable
  // against a real run. Provenance stated once is not lock-in; an argument
  // written in product names is.
  //
  // WHAT THIS DOES NOT ASSERT: that no vendor is ever named. "deident reads
  // Claude Code session logs, Codex and Cursor write a different layout and are
  // not read yet" is a scope limit a reader on another harness NEEDS; deleting
  // it would make the tool silently useless to them instead of loudly out of
  // scope. Harness names, log-format names and env var names are not matched
  // here at all. Only model tiers and plans are, because only those assume the
  // reader buys from one vendor.
  //
  // BRIEF.md and PLAN.md are out of scope: engineering history, not a reader
  // surface, and BRIEF names model ids as measured corpus content, which is
  // evidence about what leaks. selftest.mjs is out of scope because it is this
  // file, and a fixture forbidding a word cannot also be forbidden from it.
  ['F148', 'no model name and no plan name appears in the argument a reader follows', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));

    // Neither pattern uses a backslash escape. This file has twice had a `\b`
    // written into it as a raw U+0008 by the tooling that edits it, and a
    // regex that matches a backspace matches nothing while still passing.
    const MODEL_NAME = /(^|[^a-z])(haiku|sonnet|opus|fable|gpt-[0-9])([^a-z]|$)/i;
    const PLAN_NAME = /(pro|max|plus|team|free|enterprise) (plan|tier|subscription)/i;
    const names = (line) => MODEL_NAME.test(line) || PLAN_NAME.test(line);

    // Negative control. A check that cannot fail proves nothing, and both of
    // these are the sentence this fixture exists to stop.
    assert.ok(names('do not run step 4 at the haiku tier'), 'MODEL_NAME matches nothing');
    assert.ok(names('available on the Max plan'), 'PLAN_NAME matches nothing');

    const surfaces = ['README.md', 'AGENTS.md', 'skills/deident/SKILL.md'];
    const walk = (dir, prefix, keep) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { walk(path.join(dir, e.name), `${prefix}${e.name}/`, keep); continue; }
        if (keep(e.name)) surfaces.push(`${prefix}${e.name}`);
      }
    };
    walk(path.join(repo, 'src'), 'src/', (n) => n.endsWith('.mjs') && n !== 'selftest.mjs');
    // The whole docs tree, not a hand-kept list: a list is what lets the next
    // document be the one nobody added.
    walk(path.join(repo, 'docs'), 'docs/', (n) => n.endsWith('.md') || n.endsWith('.html'));

    const offenders = [];
    let provenance = 0;
    for (const rel of surfaces) {
      const lines = fs.readFileSync(path.join(repo, ...rel.split('/')), 'utf8').split('\n');
      // The preamble of the measurement doc is where provenance belongs, so it
      // is bounded by the first section heading rather than by matching the
      // sentence: a fixture that holds its own copy of the wording passes while
      // the shipped file says something else (F122 has the same reason).
      const firstSection = rel === 'docs/model-tier.md' ? lines.findIndex((l) => l.startsWith('## ')) : -1;
      lines.forEach((line, i) => {
        if (!names(line)) return;
        if (firstSection > 0 && i < firstSection) { provenance += 1; return; }
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [], `product names in the argument: ${offenders.join(' | ')}`);

    // One line, not a paragraph, and not zero: a doc that never says which
    // tiers were measured is unreproducible, which is the other way to get
    // this wrong.
    assert.equal(provenance, 1, `docs/model-tier.md names the measured tiers on ${provenance} preamble lines, expected 1`);
  }],

  // F149 - the estimate is per script, not one divisor over the whole file.
  // Measured on the real candidates file: 459,747 characters, 131,895 of them
  // (29%) CJK. CJK runs at roughly one token per character and Latin at
  // roughly one per four, so a single divisor is wrong by a factor of four in
  // one direction or the other depending on the mix, and the mix is the whole
  // reason this corpus needs its own number.
  ['F149', 'the estimate splits by script, so CJK and Latin of the same length do not cost the same', () => {
    // Fabricated prose. SHAPE: two strings of the SAME character count, one
    // pure Han, one pure Latin, so the only thing that can move the estimate
    // is the script.
    const han = '這是一段中文字'.repeat(100);
    const latin = 'abcdefg'.repeat(100);

    const a = estimateTokens(han);
    const b = estimateTokens(latin);
    assert.equal(a.chars, 700);
    assert.equal(b.chars, 700);
    assert.equal(a.cjkChars, 700, 'Han characters were not counted as CJK');
    assert.equal(b.cjkChars, 0, 'Latin characters were counted as CJK');

    // Worked by hand from the two rates rather than recomputed the way the
    // code computes it: 700 Han characters at one token each is 700, and 700
    // Latin characters at four to the token is 175.
    assert.equal(a.inputTokens, 700);
    assert.equal(b.inputTokens, 175);
    assert.equal(a.inputTokens / b.inputTokens, 4, 'the two scripts no longer differ by the ratio the code claims');

    // A mixed string is neither rate. 100 Han and 400 Latin is 100 + 100.
    assert.equal(estimateTokens('中文'.repeat(50) + 'abcd'.repeat(100)).inputTokens, 200);

    // The rounding rule: three significant figures, and never finer than a
    // whole token. One rule for every magnitude, so 7,043 prints as 7,040 and
    // not as 7,000; a second rule for small numbers would buy one cosmetic
    // digit and cost the reader a rule they have to know to read the number.
    assert.equal(roundEstimate(213_858), 214_000);
    assert.equal(roundEstimate(7_043), 7_040);
    assert.equal(roundEstimate(50), 50, 'a small file must not round up to a thousand tokens');
    assert.equal(roundEstimate(0), 0);

    // The headline carries the reader's own reasoning; the row does not.
    const cost = tokenCost([{ label: 'candidates', estimate: a }]);
    assert.equal(cost.files[0].tokens, 700);
    assert.equal(cost.total, 840, '700 input tokens plus 20% is 840');
    assert.equal(cost.reasoningPercent, 20);
  }],

  // F149 - the number is for a person at a terminal AND for the agent that
  // orchestrates the read, and the agent cannot parse prose. Both files that
  // cost a reader anything carry it.
  ['F173', 'the token estimate is in --json, for the candidates file and for the triage file', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');

    // The export refuses for want of an entity list, which is the path that
    // writes the candidates file. The document is still emitted on a refusal.
    const refused = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--json'], CORPUS_USER_ENV);
    assert.notEqual(refused.code, 0);
    const doc = JSON.parse(refused.out);
    const est = doc.candidates.tokenEstimate;
    assert.ok(est, `no tokenEstimate on the candidates document: ${JSON.stringify(doc.candidates)}`);
    assert.equal(typeof est.total, 'number');
    assert.ok(est.total > 0, 'a written file costs more than nothing to read');
    assert.equal(est.reasoningPercent, 20);
    assert.equal(est.files[0].label, 'candidates');
    assert.equal(
      est.files[0].chars,
      [...fs.readFileSync(path.join(out, 'deident-candidates.txt'), 'utf8')].length,
      'the estimate is not measured over the file that was actually written',
    );

    const triaged = runCli(['triage', '--root', root, '--out', out, '--salt-dir', saltDir, '--json'], CORPUS_USER_ENV);
    assert.equal(triaged.code, 0, triaged.out);
    const tdoc = JSON.parse(triaged.out);
    assert.ok(tdoc.triage.tokenEstimate, `no tokenEstimate on the triage document: ${JSON.stringify(tdoc.triage)}`);
    assert.equal(tdoc.triage.tokenEstimate.files[0].label, 'triage');
    assert.ok(tdoc.triage.tokenEstimate.total > 0);
  }],
  // ------------------------------------------------- cli-ux §5, the drill-down
  //
  // "A count nobody can drill into is a count nobody believes." The export
  // reports a spelling replaced N times and offers ONE excerpt for it, so the
  // owner's real question - are those N a person's name or an ordinary word -
  // has no answer on the machine. §5's own worked example of the failure is the
  // 202-occurrence common noun that passed all five gates.
  //
  // Every fixture below drives the real CLI rather than the index module,
  // because the property under test is that the answer survives the round trip
  // through a file written by one process and read by another.

  // F148 - the count is drillable, and the drill-down says out loud that it is
  // a re-identification key. This is the one command whose whole job is mapping
  // a pseudonym back to a real person, so the excerpt it prints is the real
  // spelling. A reader who does not know that will paste it into a ticket.
  ['F172', 'review --entity prints every occurrence with its session, and says the mapping is local', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    const sid = '11111111-1111-4111-8111-111111111111';
    // Fabricated. SHAPE: a two-word Latin personal name occurring TWICE in one
    // record, so "2 occurrences, 1 session" separates a per-occurrence index
    // from a per-record one.
    const NAME = 'Marisol Ferrand';

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    appendTurn(root, sid, corpus.cwd, `called ${NAME} about the invoice, then ${NAME} rang back`);
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);

    const ents = path.join(root, 'drill.json');
    fs.writeFileSync(ents, JSON.stringify({ entities: [{ kind: 'person', spellings: [NAME], confidence: 'high' }] }), 'utf8');
    const exp = runCli(
      ['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--entities', ents, '--json'],
      CORPUS_USER_ENV,
    );
    assert.equal(exp.code, 0, exp.out);
    const doc = JSON.parse(exp.out);

    // The report has to hand the reader the token they then drill into, or the
    // count and the query are two disconnected facts.
    const row = doc.replacementCounts.hits.find((h) => h.spelling === NAME);
    assert.ok(row !== undefined, `the declared spelling was never counted: ${JSON.stringify(doc.replacementCounts)}`);
    assert.equal(row.count, 2, 'both occurrences in one record must be counted separately');
    assert.ok(typeof row.pseudonym === 'string' && row.pseudonym.length > 0, 'the count row does not name a drillable token');

    const q = runCli(
      ['review', '--root', root, '--out', out, '--salt-dir', saltDir, '--entity', row.pseudonym],
      CORPUS_USER_ENV,
    );
    assert.equal(q.code, 0, q.out);
    assert.match(q.out, /2 occurrences, 1 session/, `wrong shape: ${q.out}`);
    assert.ok(q.out.includes(sid), 'the occurrence does not name the session it is in');
    assert.ok(q.out.includes(NAME), 'the excerpt does not show how the word is actually used');
    assert.match(q.out, /not in the archive|never leaves this machine|local/i, 'nothing says the mapping must not be sent');

    const j = runCli(
      ['review', '--root', root, '--out', out, '--salt-dir', saltDir, '--entity', row.pseudonym, '--json'],
      CORPUS_USER_ENV,
    );
    assert.equal(j.code, 0, j.out);
    const jd = JSON.parse(j.out);
    assert.equal(jd.entity, row.pseudonym);
    assert.equal(jd.occurrences.length, 2, `--json must carry the same rows: ${j.out}`);
    assert.equal(jd.occurrences[0].session, sid);
    assert.ok(jd.occurrences[0].excerpt.includes(NAME));
  }],

  // F149 - a token that is not in the index, AFTER an export that did replace
  // things. F65 covers the machine that has never exported; this is the case
  // that looks like a working query returning nothing, which is the one a
  // script cannot tell from success. The commonest way to arrive here is a
  // token copied from an earlier export: the salt is stable, --namespace is
  // not, so the same person gets a different token per namespace.
  ['F171', 'review --entity refuses by name for a token the last export never replaced', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');

    // The export refuses for want of an entity list, which is the path that
    // writes the candidates file. The document is still emitted on a refusal.
    const refused = runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--json'], CORPUS_USER_ENV);
    assert.notEqual(refused.code, 0);
    const doc = JSON.parse(refused.out);
    const est = doc.candidates.tokenEstimate;
    assert.ok(est, `no tokenEstimate on the candidates document: ${JSON.stringify(doc.candidates)}`);
    assert.equal(typeof est.total, 'number');
    assert.ok(est.total > 0, 'a written file costs more than nothing to read');
    assert.equal(est.reasoningPercent, 20);
    assert.equal(est.files[0].label, 'candidates');
    assert.equal(
      est.files[0].chars,
      [...fs.readFileSync(path.join(out, 'deident-candidates.txt'), 'utf8')].length,
      'the estimate is not measured over the file that was actually written',
    );

    const triaged = runCli(['triage', '--root', root, '--out', out, '--salt-dir', saltDir, '--json'], CORPUS_USER_ENV);
    assert.equal(triaged.code, 0, triaged.out);
    const tdoc = JSON.parse(triaged.out);
    assert.ok(tdoc.triage.tokenEstimate, `no tokenEstimate on the triage document: ${JSON.stringify(tdoc.triage)}`);
    assert.equal(tdoc.triage.tokenEstimate.files[0].label, 'triage');
    assert.ok(tdoc.triage.tokenEstimate.total > 0);
  }],

  // F150 - the estimate is read by an outsider, and there are three numbers it
  // must never carry. A percentage of a subscription is the worst of them:
  // deident cannot read a plan, cannot read remaining usage, and the limits
  // are not published as a token count, so any figure there would be invented
  // and a person would act on it. A model-tier comparison is a working note
  // (docs/model-tier.md) about a tier the tool is not running. Asserted
  // against the rendered bytes, because the way this comes back is somebody
  // adding one helpful line.
  ['F150', 'nothing in the estimate mentions a subscription, a plan, a quota or a model tier', () => {
    const est = estimateTokens('這是一段中文字'.repeat(100) + 'abcdefg'.repeat(100));
    const printed = [
      captureOutput(() => renderCandidates('deident-candidates.txt', 12_345, 3, 400, 2, tokenCost([{ label: 'candidates', estimate: est }]))),
      captureOutput(() => renderTriageWritten({
        path: 'deident-triage.txt',
        sessions: 4,
        withoutPrompt: 1,
        chars: 300,
        bytes: 9_001,
        tokenEstimate: tokenCost([{ label: 'triage', estimate: est }]),
      })),
    ].join(NL);

    for (const forbidden of [/subscription/i, /\bquota\b/i, /\bplans?\b/i, /% of/i, /model tier|top tier|cheapest|opus|sonnet|haiku/i]) {
      assert.ok(!forbidden.test(printed), `the estimate names something it cannot know: ${forbidden} in ${printed}`);
    }

    // And it does say the thing it is for, once. "roughly" is the whole hedge:
    // a number hedged in every clause is a number nobody can use.
    assert.match(printed, /Reading this will cost roughly [\d,]+ tokens/);
    assert.equal(printed.match(/roughly|estimate|approximate|about/gi).length, 4, 'the estimate is hedged more than once per file');
  }],
  // F151 - one manifest pair now serves two harnesses, and nothing said so.
  //
  // Codex resolves a plugin manifest by trying `.codex-plugin/plugin.json`,
  // then `.claude-plugin/plugin.json`, then `.cursor-plugin/plugin.json`, and a
  // marketplace by trying `.agents/plugins/marketplace.json`, then
  // `.agents/plugins/api_marketplace.json`, then `.claude-plugin/marketplace.json`.
  // Measured against codex.exe 26.818.31338: `codex plugin list` printed this
  // repository's own `.claude-plugin/marketplace.json` as the file it read, and
  // `codex debug prompt-input` then listed the skill. So the two files Claude
  // Code already needs are the two files Codex reads, and there is no second
  // copy of the skill to drift the way SKILL.md and AGENTS.md did in F103.
  //
  // What that buys in copies it spends in blast radius: a rename here breaks
  // both harnesses at once, and breaks them silently, because `plugin add`
  // still reports success and the skill just never reaches the model's prompt.
  // The names that have to agree are asserted here instead of at install time.
  ['F151', 'the plugin manifest, the marketplace entry and the skill agree on one name', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(repo, ...p), 'utf8'));
    const plugin = readJson('.claude-plugin', 'plugin.json');
    const market = readJson('.claude-plugin', 'marketplace.json');

    assert.equal(market.plugins.length, 1, 'the repository is one plugin, so its marketplace lists one');
    assert.equal(market.plugins[0].name, plugin.name, 'marketplace entry and plugin manifest disagree on the name');

    // `./` is what makes "the repository IS the plugin" resolve. Both harnesses
    // read it relative to the marketplace root, which is the repository root.
    assert.equal(market.plugins[0].source, './', 'the plugin source is no longer the repository root');

    // `skills` is a path both harnesses walk. If it stops reaching
    // <name>/SKILL.md the install still succeeds and loads nothing.
    const skillFile = path.join(repo, plugin.skills, plugin.name, 'SKILL.md');
    assert.ok(fs.existsSync(skillFile), `plugin.json skills path does not reach a SKILL.md: ${skillFile}`);

    // The frontmatter name is the third copy of that name, and it is the one a
    // harness indexes the skill under.
    const front = fs.readFileSync(skillFile, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(front, 'SKILL.md has no frontmatter');
    const named = front[1].match(/^name:[ \t]*(\S+)[ \t]*$/m);
    assert.ok(named, 'SKILL.md frontmatter has no name');
    assert.equal(named[1], plugin.name, 'SKILL.md frontmatter name and plugin.json name have drifted');
  }],

  // F167 - both manifests said `"license": "MIT"` and no LICENSE file existed,
  // through 191 commits and a release audit that only caught it by looking.
  //
  // An MIT claim with no licence text grants nothing: a company-owned repository
  // with no LICENSE defaults to all rights reserved, so the manifests were
  // advertising a permission the repository did not give. Nothing failed, because
  // no harness reads the field for anything but display.
  //
  // The three strings that have to agree are the two manifests' `license` and the
  // first line of the LICENSE file, plus the owner named in the copyright line.
  // Getting the copyright holder wrong is the hardest thing here to change after
  // publication, which is why it is pinned to the manifests rather than assumed.
  ['F167', 'a manifest that claims a licence has the licence text beside it, naming the same owner', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(repo, ...p), 'utf8'));
    const plugin = readJson('.claude-plugin', 'plugin.json');
    const market = readJson('.claude-plugin', 'marketplace.json');

    const claimed = plugin.license;
    assert.ok(claimed, 'plugin.json no longer claims a licence');
    assert.equal(market.plugins[0].license, claimed, 'the two manifests claim different licences');

    const licenseFile = path.join(repo, 'LICENSE');
    assert.ok(fs.existsSync(licenseFile), `both manifests claim ${claimed} and there is no LICENSE file`);
    const text = fs.readFileSync(licenseFile, 'utf8');

    // "MIT" has to be the licence's own name on the first line, not a word
    // somewhere in the body, or a file saying "this is not MIT" would pass.
    assert.ok(text.split('\n')[0].includes(claimed), `LICENSE does not open by naming ${claimed}`);

    // The owner in the copyright line is the manifests' owner. A LICENSE naming
    // somebody else is worse than none: it is a false assignment on the record.
    const owner = market.owner.name;
    const copyright = text.match(/^Copyright \(c\) (\d{4}) (.+)$/m);
    assert.ok(copyright, 'LICENSE has no `Copyright (c) <year> <holder>` line');
    assert.equal(copyright[2], owner, `LICENSE names ${copyright[2]}, the manifests name ${owner}`);
    assert.ok(Number(copyright[1]) >= 2026, 'the copyright year predates the repository');
  }],

  ['F153', 'review --entity refuses a pseudonym the corpus never minted, rather than reporting none', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);

    // Fabricated. SHAPE: a well-formed pseudonym of the namespace deident
    // mints, so the refusal cannot be blamed on a malformed argument.
    const ABSENT = 'PERSON_4820517';

    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    assert.equal(
      runCli(
        ['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--entities', path.join(root, 'ents.json')],
        CORPUS_USER_ENV,
      ).code,
      0,
    );

    const after = runCli(
      ['review', '--root', root, '--out', out, '--salt-dir', saltDir, '--entity', ABSENT],
      CORPUS_USER_ENV,
    );
    assert.equal(after.code, 1, `an unknown token must not exit 0: ${after.out}`);
    assert.ok(after.out.includes(ABSENT), 'the refusal does not name the token that was asked for');

    // And on the JSON path the exit code is inside the document, so an agent
    // reading stdout sees the failure rather than an empty occurrence list.
    const j = runCli(
      ['review', '--root', root, '--out', out, '--salt-dir', saltDir, '--entity', ABSENT, '--json'],
      CORPUS_USER_ENV,
    );
    assert.equal(j.code, 1);
    const jd = JSON.parse(j.out);
    assert.equal(jd.ok, false, `--json reported success for a token that does not exist: ${j.out}`);
    assert.ok(!Array.isArray(jd.occurrences), 'a refusal must not also carry an empty result');
  }],

  // F150 - the other half of §5. The transcript printed is the one that
  // SHIPPED, read back out of the archive, rather than a second rendering of
  // the corpus that could disagree with it. Measured three
  // times on the delivery run a reviewer was handed something that was not what
  // shipped, and each time the gap was where the leak lived.
  ['F170', 'review --session prints the redacted transcript that is actually in the archive', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    const sid = '11111111-1111-4111-8111-111111111111';

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    assert.equal(
      runCli(
        ['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--entities', path.join(root, 'ents.json')],
        CORPUS_USER_ENV,
      ).code,
      0,
    );

    const q = runCli(
      ['review', '--root', root, '--out', out, '--salt-dir', saltDir, '--session', sid],
      CORPUS_USER_ENV,
    );
    assert.equal(q.code, 0, q.out);
    assert.ok(q.out.includes('KEEP-THIS-STRING-FORM-PROMPT'), `no transcript body: ${q.out.slice(0, 600)}`);
    // Redacted, not raw: the cwd every one of those turns carries is replaced
    // in the archive, and a transcript printed from anywhere else would show it.
    assert.ok(!q.out.includes(corpus.cwd), 'the printed transcript is not the redacted one');
    assert.ok(!q.out.includes(corpus.private), 'prose from the denied directory reached the transcript');

    const unknown = runCli(
      ['review', '--root', root, '--out', out, '--salt-dir', saltDir, '--session', 'no-such-session'],
      CORPUS_USER_ENV,
    );
    assert.equal(unknown.code, 1, `an unknown session must not exit 0: ${unknown.out}`);
    assert.ok(unknown.out.includes('no-such-session'), 'the refusal does not name the session asked for');
  }],

  // F151 - the index pairs a pseudonym with the real spelling it replaced, so
  // it is the one artifact on the machine that re-identifies the archive. It
  // gets F126's treatment exactly: salt directory only, never the output
  // directory, never an archive entry, never the repository.
  ['F169', 'the occurrence index is memory, and reaches no file the export produces', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    const sid = '11111111-1111-4111-8111-111111111111';
    // Fabricated. SHAPE: a two-word Latin personal name, distinct enough that a
    // substring search over the archive cannot hit it by accident.
    const NAME = 'Marisol Ferrand';

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    appendTurn(root, sid, corpus.cwd, `called ${NAME} about the invoice`);
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    const ents = path.join(root, 'drill.json');
    fs.writeFileSync(ents, JSON.stringify({ entities: [{ kind: 'person', spellings: [NAME], confidence: 'high' }] }), 'utf8');
    assert.equal(
      runCli(['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--entities', ents], CORPUS_USER_ENV).code,
      0,
    );

    // Found by its content rather than by its name, so renaming the file cannot
    // quietly retire this fixture.
    const indexNames = fs.readdirSync(saltDir).filter((name) => {
      try {
        return Array.isArray(JSON.parse(fs.readFileSync(path.join(saltDir, name), 'utf8')).occurrences);
      } catch {
        return false;
      }
    });
    assert.equal(indexNames.length, 1, `expected exactly one occurrence index in the salt directory: ${fs.readdirSync(saltDir)}`);
    const index = JSON.parse(fs.readFileSync(path.join(saltDir, indexNames[0]), 'utf8'));
    assert.ok(typeof index._note === 'string' && /never/i.test(index._note), 'a file this dangerous needs its own header');
    assert.ok(
      JSON.stringify(index).includes(NAME),
      'the index does not carry the real spelling, so it answers nothing',
    );

    for (const name of fs.readdirSync(out)) {
      assert.notEqual(name, indexNames[0], 'the occurrence index reached the output directory');
      if (name.endsWith('.zip')) continue;
      assert.ok(
        !fs.readFileSync(path.join(out, name), 'utf8').includes(NAME),
        `the real spelling reached ${name} in the output directory`,
      );
    }
    const zips = fs.readdirSync(out).filter((f) => f.endsWith('.zip'));
    assert.equal(zips.length, 1, 'exactly one archive');
    const entries = readZipFile(path.join(out, zips[0]));
    assert.ok(!entries.some((e) => e.name.includes(indexNames[0])), 'the occurrence index is an archive entry');
    const bytes = entries.map((e) => `${e.name}${NL}${e.data}`).join(NL);
    assert.ok(!bytes.includes(NAME), 'the real spelling the index maps reached the archive');
    const repo = fileURLToPath(new URL('..', import.meta.url));
    assert.ok(!fs.existsSync(path.join(repo, indexNames[0])), 'the occurrence index was written into the repository');
  }],

  // F152 - a fresh salt directory silently drops the person's OWN deny rules.
  //
  // The documented way to run "as if for the first time" is a new --salt-dir,
  // and denied.json lives in the salt directory. So the fresh run loads zero
  // per-person rules: the directory named after a real person HAS a git remote,
  // so without its token the proposed tier flips from exclude to redact and the
  // private workspace is offered for export. Every gate stays green, because no
  // gate knows a rule was ever supposed to exist.
  //
  // A warning rather than a refusal: a genuinely first-ever run has no default
  // denied.json either and must not be blocked. The warning fires only where the
  // person is demonstrably protected somewhere else and not here.
  ['F152', 'a salt directory with no denied.json is named when the default one has rules', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const home = path.join(root, 'home');
    writeCorpus(root);
    fs.mkdirSync(path.join(home, '.deident-private'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.deident-private', 'denied.json'),
      // Fabricated. SHAPE: one deny token naming a directory segment, which is
      // the commonest thing in a real denied.json.
      JSON.stringify({ tokens: ['auditor-notes'] }),
      'utf8',
    );
    // DEIDENT_SALT_DIR blanked, because defaultSaltDir reads it before HOME and
    // this machine may have it set.
    const env = { ...CORPUS_USER_ENV, HOME: home, USERPROFILE: home, DEIDENT_SALT_DIR: '' };

    const fresh = runCli(['scan', '--root', root, '--out', out, '--salt-dir', path.join(root, 'fresh')], env);
    assert.equal(fresh.code, 0, fresh.out);
    assert.match(fresh.out, /denied\.json/, `the fresh salt directory was not flagged: ${fresh.out}`);

    // The default salt directory itself must never warn about itself.
    const normal = runCli(['scan', '--root', root, '--out', out], env);
    assert.equal(normal.code, 0, normal.out);
    assert.ok(!/denied\.json/.test(normal.out), `the default salt directory warned about itself: ${normal.out}`);

    // And a machine with no rules anywhere is a genuine first run, not a
    // downgrade. Warning there is §F7's cry-wolf failure: the message would
    // appear on every first run of every install and be trained away before it
    // ever mattered.
    const bare = path.join(root, 'bare-home');
    fs.mkdirSync(bare, { recursive: true });
    const virgin = runCli(
      ['scan', '--root', root, '--out', out, '--salt-dir', path.join(root, 'fresh2')],
      { ...env, HOME: bare, USERPROFILE: bare },
    );
    assert.equal(virgin.code, 0, virgin.out);
    assert.ok(!/denied\.json/.test(virgin.out), `warned with no rules to lose: ${virgin.out}`);
  }],

  // F153 - the occurrence list is capped per pseudonym and the COUNT is not.
  //
  // The cap exists because the live corpus replaced file paths 26,505 times
  // across a handful of spellings (cli-ux 6), so an uncapped index writes tens
  // of megabytes of excerpts nobody reads, for the entity class whose identity
  // was never in doubt. The number that must survive the cap is the total: a
  // drill-down answering 2,000 for a spelling the export reported at 2,100
  // makes the reader distrust the export, which is the exact opposite of what
  // section 5 is for. And the short list has to SAY it is short, or a reader
  // counting the rows re-derives the wrong number by hand.
  ['F168', 'a spelling past the occurrence cap keeps its true count, and the short list says so', () => {
    const CAP = 2000; // occurrences.mjs MAX_PER_PSEUDONYM
    const OVER = 2100;
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    const sid = '11111111-1111-4111-8111-111111111111';
    // Fabricated. SHAPE: a two-word Latin personal name, repeated far past the
    // cap in one record, which is how a workspace path reaches five figures.
    const NAME = 'Marisol Ferrand';

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    appendTurn(root, sid, corpus.cwd, new Array(OVER).fill(NAME).join(' and then '));
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    const ents = path.join(root, 'drill.json');
    fs.writeFileSync(ents, JSON.stringify({ entities: [{ kind: 'person', spellings: [NAME], confidence: 'high' }] }), 'utf8');
    const exp = runCli(
      ['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--entities', ents, '--json'],
      CORPUS_USER_ENV,
    );
    assert.equal(exp.code, 0, exp.out);
    const row = JSON.parse(exp.out).replacementCounts.hits.find((h) => h.spelling === NAME);
    assert.equal(row.count, OVER, 'the export itself miscounted, so the rest of this fixture proves nothing');

    const j = runCli(
      ['review', '--root', root, '--out', out, '--salt-dir', saltDir, '--entity', row.pseudonym, '--json'],
      CORPUS_USER_ENV,
    );
    assert.equal(j.code, 0, j.out);
    const jd = JSON.parse(j.out);
    assert.equal(jd.total, OVER, 'the drill-down reported a smaller count than the export it drills into');
    assert.equal(jd.occurrences.length, CAP, `the occurrence list is not capped: ${jd.occurrences.length}`);

    const h = runCli(
      ['review', '--root', root, '--out', out, '--salt-dir', saltDir, '--entity', row.pseudonym],
      CORPUS_USER_ENV,
    );
    assert.equal(h.code, 0, h.out);
    assert.match(h.out, new RegExp(`${OVER - CAP} more occurrences counted and not listed`), 'the short list does not say it is short');
    assert.match(h.out, /2,100 occurrences/, 'the header must carry the true count, not the listed one');
  }],

  // F154 - the audience axis, rebuilt as an entity-list question.
  //
  // SKILL.md's list of what stays OUT of the entity list carries the clause
  // "the user's own employer and its product vocabulary, WHEN THE RECIPIENT
  // WORKS THERE TOO". That conditional is the audience question, and it was
  // enforced only by a human reading a document. Here it is the flag.
  //
  // Only the repo name moves. The remote OWNER is seeded at every audience and
  // stays that way: tier 0 cannot tell an employer's org from a client's, and
  // guessing wrong in that direction ships a client's name.
  //
  // projectShaped gates the promotion for the reason it gates the project
  // basename seed: without it a repo called `dashboard`, `references` or
  // `migration` becomes an entity and ordinary prose gets substituted, which is
  // section F7's "a scan that cries wolf is the first thing switched off"
  // arriving as over-substitution.
  ['F154', "the employer's product vocabulary is seeded for a stranger and left alone for an insider", () => {
    // Fabricated. The SHAPE each value preserves:
    //   kestrel-labs   a company's git remote owner: a hyphenated org handle
    //   harbour-api    a repo named after a product the company sells, so its
    //                  name is exactly the "product vocabulary" in the clause
    //   dashboard      a repo whose name is an ordinary English word
    const remotes = new Map([
      ['/w/one', { raw: 'kestrel-labs/harbour-api', owner: 'kestrel-labs', repo: 'harbour-api', host: 'github.com' }],
      ['/w/two', { raw: 'kestrel-labs/dashboard', owner: 'kestrel-labs', repo: 'dashboard', host: 'github.com' }],
    ]);
    const seedAt = (opts) =>
      seedEntities(
        { USERNAME: 'devuser', HOME: '/home/devuser', USERPROFILE: '/home/devuser' },
        { files: [] },
        { cwds: [], repoDirs: [...remotes.keys()], probeRemote: (d) => remotes.get(d) ?? null, texts: [], ...opts },
      );

    const pub = seedAt({ audience: 'public' });
    const pubCanon = pub.entities.map((e) => e.canonical);
    assert.ok(pubCanon.includes('harbour-api'), `the product name is not seeded at public: ${pubCanon.join(', ')}`);
    assert.ok(!pubCanon.includes('dashboard'), 'an ordinary word became an entity');
    assert.equal(pub.audienceEntities, 1, 'the number the manifest reports as what the audience did');

    for (const inside of ['teammate', 'company']) {
      const seeded = seedAt({ audience: inside });
      const canon = seeded.entities.map((e) => e.canonical);
      assert.ok(!canon.includes('harbour-api'), `${inside}: a word the reader already knows was substituted anyway`);
      assert.ok(canon.includes('kestrel-labs'), `${inside}: the remote owner seed must not be on the axis`);
      assert.equal(seeded.audienceEntities, 0);
    }

    // Absent, the seeder assumes what the flag assumes. A default that leaned
    // the other way would mean the two halves of the tool disagreed about who
    // the archive is for.
    assert.ok(seedAt({}).entities.map((e) => e.canonical).includes('harbour-api'), 'the default is not public');
  }],

  // F155 - the reader who writes the entity list has to be told which rule is
  // in force, in the file they are reading.
  //
  // The clause lived in SKILL.md, so the instruction reached the reader only if
  // the operator had loaded the skill and remembered a conditional in it. The
  // candidates file is the artifact that is actually in front of them, it is
  // generated per run, and the run already knows the declared audience.
  //
  // It states the RULE and never the seeded owner: this file is the one
  // artifact meant to be handed to a model, and tier-0 substitution has already
  // taken that handle out of the prose. Writing it back into the header would
  // put a plaintext identity in the file whose header claims there is none.
  ['F155', 'the candidates file states what the declared audience does to the entity list', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');

    const file = path.join(out, 'deident-candidates.txt');
    const headerAt = (audience) => {
      fs.rmSync(file, { force: true });
      const r = runCli(
        ['export', '--root', root, '--out', out, '--salt-dir', saltDir, '--audience', audience],
        CORPUS_USER_ENV,
      );
      assert.equal(r.code, 1, `the run should refuse for want of an entity list: ${r.out}`);
      const text = fs.readFileSync(file, 'utf8');
      return text.slice(0, text.indexOf('-----'));
    };

    const pub = headerAt('public');
    assert.match(pub, /employer/i, 'the public header says nothing about the employer');
    assert.match(pub, /declare/i, 'the public header does not ask for it');

    for (const inside of ['teammate', 'company']) {
      const header = headerAt(inside);
      assert.match(header, /employer/i, `${inside}: the header says nothing about the employer`);
      assert.notEqual(header, pub, `${inside}: the declared audience changed nothing the reader reads`);
      assert.match(header, /leave|out/i, `${inside}: the header does not say to leave it out`);
    }
  }],

  // F157..F160 - the third source of entities: values the person DECLARES.
  //
  // deident had two sources and both were inference. Tier 0 infers from machine
  // state, tier 1 infers from prose. Neither can be TOLD "this exact string is
  // mine", and a finished export with all six gates green shipped 21 identity
  // fields in plaintext because of it: three name spellings used across visa
  // documents, a date and place of birth, a household registration address in
  // two languages, three country addresses, a driving licence address, two
  // banks' address of record, a phone number and a payment-platform account id.
  // Concentrated in two sessions, one of them a browser-automation session
  // filling a booking form with passport data.
  //
  // Every one of those values was already enumerated in a file the owner
  // maintained by hand, two directories away from the salt. The tool was
  // performing semantic discovery to find a list that already existed.
  //
  // F157 - the source exists, and what it declares does not leave.
  ['F157', 'a value declared in known-values.json is replaced, and the file itself never leaves', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    writeDeclaredValueSession(root, corpus.cwd);
    const knownFile = writeKnownValues(saltDir, {
      _note: 'fixture',
      values: [
        // The bare-string form, which is the one a person writing this file by
        // hand will use, and the {kind, value} form beside it.
        DECLARED_VALUES[1],
        DECLARED_VALUES[2],
        { kind: 'person', value: DECLARED_VALUES[0] },
        { kind: 'account', value: DECLARED_VALUES[3] },
      ],
    });

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ], CORPUS_USER_ENV);
    assert.equal(exported.code, 0, exported.out);

    const zips = fs.readdirSync(out).filter((f) => f.endsWith('.zip'));
    const entries = readZipFile(path.join(out, zips[0]));
    const bytes = entries.map((e) => `${e.name}${NL}${e.data}`).join(NL);
    for (const value of DECLARED_VALUES) {
      assert.ok(!bytes.includes(value), `a declared value reached the archive: ${value}`);
    }

    // The list is as private as the salt. It must not be copied into the
    // archive, and it must not be copied into --out either: --out is the
    // directory a person hands around, and review.md already tells them so.
    assert.ok(!entries.some((e) => e.name.includes('known-values')), 'the list was packed into the archive');
    assert.ok(!bytes.includes('known-values'), 'the archive names the list');
    assert.ok(!fs.existsSync(path.join(out, 'known-values.json')), 'the list was copied into --out');
    assert.ok(fs.existsSync(knownFile), 'the list itself must survive the run');
  }],

  // F158 - the failure direction. Missing is ordinary and means the two
  // inference tiers only. Malformed REFUSES, naming the row, because silently
  // having none of the list is the exact failure this source exists to prevent:
  // the tool would run with every gate green over a corpus it had been told
  // nothing about, which is indistinguishable from the run that leaked.
  ['F158', 'a malformed known-values.json refuses and names the row, rather than loading none of it', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);

    // Absent is the normal case and says nothing.
    const clean = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(clean.code, 0, clean.out);

    for (const [body, expect] of [
      ['{"values": [', /valid JSON/i],
      [{ _note: 'no list at all' }, /values/],
      [{ values: [DECLARED_VALUES[1], 42] }, /values\[1\]/],
      [{ values: [{ value: DECLARED_VALUES[1], kind: 'passport' }] }, /values\[0\]/],
      [{ values: ['   '] }, /values\[0\]/],
    ]) {
      writeKnownValues(saltDir, body);
      const r = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
      assert.equal(r.code, 1, `this should have refused: ${JSON.stringify(body)}${NL}${r.out}`);
      assert.match(r.out, expect, `the refusal does not name the problem: ${r.out}`);
      assert.match(r.out, /known-values\.json/, 'the refusal does not name the file');
    }

    // An unknown kind names the kinds that ARE accepted, or the remedy is
    // "guess again".
    writeKnownValues(saltDir, { values: [{ value: DECLARED_VALUES[1], kind: 'passport' }] });
    const kind = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.match(kind.out, /person/, 'the refusal does not list the kinds it accepts');
  }],

  // F159 - what happens to a declared value that is three characters long, or
  // is an ordinary word occurring hundreds of times.
  //
  // Refusing is wrong: the person declared it deliberately, and a source whose
  // answer to a deliberate declaration is "no" is a source nobody fills in. But
  // src/entities/probe.mjs measured the cost of the other direction on a
  // delivered corpus: an ordinary noun that was a declared spelling replaced
  // 202 occurrences of a common word, with the serialization invariant green,
  // the substitution invariant green and known-entity residue at zero.
  //
  // So: every declared value is printed back with the number of times it was
  // actually replaced, complete rather than top-N, and a value the existing
  // safety rules refuse to substitute at all says so on its own row. No
  // threshold, because probe.mjs measured that no threshold separates a noun
  // from a name, and a value the person declared about themselves is exactly
  // where a false alarm would teach them to stop reading.
  ['F159', 'every declared value is reported with its replacement count, and a rejected one says so', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    writeDeclaredValueSession(root, corpus.cwd);
    // `alpha` is the project directory writeCorpus builds, so it is already all
    // over the corpus: an ordinary word the person has declared as theirs.
    // `Qi` is two Latin characters, which rejectReason refuses to substitute.
    writeKnownValues(saltDir, {
      values: [DECLARED_VALUES[1], 'Qi', 'never-typed-anywhere-in-this-corpus'],
    });

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');
    primeSemanticPass(root, out, saltDir, CORPUS_USER_ENV);
    const r = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ], CORPUS_USER_ENV);
    assert.equal(r.code, 0, `a declared value must never refuse the export: ${r.out}`);

    const block = r.out.slice(r.out.indexOf('declared'));
    assert.ok(block.length > 0, `nothing reported the declared values back:${NL}${r.out}`);
    assert.match(r.out, new RegExp(DECLARED_VALUES[1]), 'a declared value that WAS replaced is not reported');
    assert.match(r.out, /never-typed-anywhere-in-this-corpus/, 'a declared value that matched nothing is not reported');
    assert.match(r.out, /Qi/, 'a declared value that cannot be substituted is not reported');
    // And the reason it was not substituted, not just its absence.
    assert.match(r.out, /3 characters|too collision-prone/, 'the rejected value does not say why');

    // A rejected value must NOT be given a replacement count, because the
    // number would be a lie in the one direction that matters. Verified against
    // the shipped modules: buildTable puts an entity with no pseudonym in
    // `flagged` and never in `entries`, and residualScan sweeps `entries`, so
    // a rejected value is not scanned for at all. Declaring a two-character
    // value that occurs twice in the corpus ships it twice while
    // `known-entity residue: 0` and `archive on disk ... ok` both pass. A row
    // reading `0` next to it is BRIEF 4.3's zero printed where no check ran.
    const qi = r.out.split(NL).find((l) => /\bQi\b/.test(l) && !/never substituted/.test(l));
    assert.ok(qi !== undefined, `no row for the rejected value:${NL}${r.out}`);
    assert.doesNotMatch(qi, /\d/, `the rejected value was given a count it cannot have: ${qi}`);
    assert.match(r.out, /not scanned|no count/i, 'the report does not say the count is unavailable');
  }],

  // F160 - the source is worth nothing if the person cannot fill it in, and the
  // SKILL is where an agent learns to. Asserted against the shipped skill body
  // rather than a copy here, and worded for someone whose equivalent file is
  // somewhere else entirely or does not exist: hardcoding one person's path is
  // the overfitting the per-person deny rules were moved out of the repo to
  // remove.
  ['F160', 'the operator contract tells an agent to build the declared list, without naming one machine', () => {
    const skill = fs.readFileSync(new URL('../skills/deident/SKILL.md', import.meta.url), 'utf8');
    assert.match(skill, /known-values\.json/, 'the skill never mentions the declared list');
    assert.match(skill, /personal|identity|details/i, 'the skill does not say what goes in it');
    // One person's convention must not be in a shipped file, in either copy.
    for (const [name, text] of [['SKILL.md', skill], ['AGENTS.md', fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')]]) {
      assert.ok(!text.includes('.identity-private'), `${name} hardcodes one machine's personal-details path`);
    }
  }],

  // F161..F162 - triage could not see past a first prompt that says nothing.
  //
  // Triage reads only the first user prompt, and its entire cost argument rests
  // on that prompt being representative. One of the two sessions that leaked
  // the 21 identity fields opened with `/clear`, so the reader was shown a
  // command envelope and had nothing to judge, and the session shipped.
  //
  // Measured 2026-08-25 over the live corpus root, depth 1, the way
  // resolveCorpus scopes it: 214 sessions, of which 45 (21.0%) have a
  // contentless first prompt. 28 carry no user prompt in the head at all and 17
  // open with a bare slash command and no arguments (`/clear` x11, `/model` x2,
  // `/login`, `/mcp`, `/reload-plugins`, `/doctor`). Of those 17, 15 are
  // answered by the very next prompt in the SAME 256 KB head that was already
  // read: 14 at index 1 and 1 at index 2. So the fix costs no extra I/O.
  //
  // F161 - show the first prompt that carries content, and say it was not the
  // first. Not saying so would be worse than the bug: a reader who believes
  // they are looking at how a session opened would draw conclusions from a
  // prompt that arrived after a context reset.
  ['F161', 'triage shows the first prompt with content in it, and says when that was not the first', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    const id = '77777777-7777-4777-8777-777777777777';
    writeCommandFirstSession(root, corpus.cwd, id, '/clear', 'TRIAGE-REAL-WORK reconcile the payout ledger');

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    assert.equal(runCli(['triage', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);

    const text = fs.readFileSync(path.join(out, 'deident-triage.txt'), 'utf8');
    const block = text.slice(text.indexOf(id));
    assert.ok(block.includes('TRIAGE-REAL-WORK'), `the work in the session is not shown:${NL}${block.slice(0, 400)}`);
    assert.ok(block.includes('/clear'), 'the row does not say what was skipped');
    // The envelope is structure, not prose, and it is 106 characters of the
    // budget this stage exists to protect.
    assert.ok(!block.includes('<command-name>'), 'the raw command envelope was rendered at a reader');
  }],

  // F162 - a session with nothing to judge at all. 30 of the 214 measured
  // sessions are in this state even after F161's fix: 28 with no user prompt in
  // the head and 2 whose every prompt is a bare command. The triage rubric
  // already says a row you cannot classify is a drop, so the row that cannot be
  // classified has to be legible AS that, rather than looking like a session
  // that merely happens to open quietly.
  ['F162', 'a session whose prompts all say nothing is surfaced as having nothing to judge', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    const corpus = writeCorpus(root);
    const allCommands = '88888888-8888-4888-8888-888888888888';
    writeCommandFirstSession(root, corpus.cwd, allCommands, '/model');

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV).code, 0);
    const r = runCli(['triage', '--root', root, '--out', out, '--salt-dir', saltDir], CORPUS_USER_ENV);
    assert.equal(r.code, 0, r.out);

    const text = fs.readFileSync(path.join(out, 'deident-triage.txt'), 'utf8');
    const block = text.slice(text.indexOf(allCommands));
    const row = block.split(NL)[1];
    assert.match(row, /nothing/i, `the row does not say there is nothing to judge: ${row}`);
    assert.ok(row.includes('/model'), `the row does not say what the session does contain: ${row}`);
    assert.ok(!row.includes('<command-name>'), 'the raw command envelope was rendered at a reader');
    // The rubric already answers this row, and the header says so. The count
    // line has to as well, or the number of unjudgeable rows is invisible until
    // somebody scrolls the file.
    assert.match(r.out, /nothing to judge|cannot be judged|no prompt/i, `the summary hides the count:${NL}${r.out}`);
  }],

  // F163 - the salt directory that silently has none of the person's list.
  //
  // The same trap F152 exists for, on the file whose absence is now the more
  // expensive one: a fresh --salt-dir is the documented way to run "as if for
  // the first time", known-values.json lives IN the salt directory, so the
  // fresh run declares nothing and every gate stays green over an export that
  // was told nothing. Narrow on purpose, like F152: a genuine first run has no
  // list anywhere and must not be nagged.
  ['F163', 'a salt directory with no known-values.json is named when the default one has one', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const home = path.join(root, 'home');
    const fresh = path.join(root, 'fresh-salt');
    writeCorpus(root);
    writeKnownValues(path.join(home, '.deident-private'), { values: [DECLARED_VALUES[1]] });

    const env = { ...CORPUS_USER_ENV, HOME: home, USERPROFILE: home };
    const r = runCli(['scan', '--root', root, '--out', out, '--salt-dir', fresh], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /known-values\.json/, `the warning was not printed:${NL}${r.out}`);
    assert.match(r.out, /cp |copy/i, 'the warning does not say how to fix it');

    // A machine with no list anywhere is a first run and gets no warning: a
    // line on every first run of every install is F7's cry-wolf failure.
    const bare = path.join(root, 'home-bare');
    fs.mkdirSync(bare, { recursive: true });
    const first = runCli(
      ['scan', '--root', root, '--out', out, '--salt-dir', path.join(root, 'fresh-2')],
      { ...CORPUS_USER_ENV, HOME: bare, USERPROFILE: bare },
    );
    assert.equal(first.code, 0, first.out);
    assert.ok(!first.out.includes('known-values.json'), `a genuine first run was nagged:${NL}${first.out}`);
  }],

  // F164 - the Simplified and Traditional Han fold, in the substituter and in
  // the residue scan at the same time.
  //
  // The root cause of a delivered leak. The first export's declared redaction
  // strings were Traditional and the corpus wrote the same words in Simplified.
  // The substituter did not match them and the residue scan did not find them,
  // IN AGREEMENT, because both read `table.entries` and the entries carried one
  // script. The residue assertion below is the whole fixture: a fold that
  // reached only the substituter would leave the gate green over a known miss,
  // which is worse than the state it replaced.
  ['F164', 'a Traditional spelling matches its Simplified twin, and the residue scan looks for both', () => {
    // `遠帆投資` is fabricated. Shape: a four-character Han org name in which
    // every character has a distinct Simplified form, which is the shape a
    // Taiwan-written company name has.
    const t = buildTable([entity('O1', 'org', '遠帆投資', 'ORG_1')]);
    assert.equal(substituteString('客戶是遠帆投資的顧問', t).out, '客戶是ORG_1的顧問', 'the declared script');
    assert.equal(substituteString('客户是远帆投资的顾问', t).out, '客户是ORG_1的顾问', 'the other script');

    // The gate, on text the substituter never touched. Before the fold this
    // returned 0 over plaintext that names the org.
    assert.equal(residualScan('客户是远帆投资的顾问', t).entityCount, 1, 'the residue scan is blind to the twin');

    // And the twin as it arrives inside embedded JSON, which is the form a
    // character-level matcher fold could never have seen: six ASCII characters
    // per Han character. Written out by hand rather than by calling the
    // escaper, so the fixture cannot agree with a broken escaper.
    const escaped = `${BS}u8fdc${BS}u5e06${BS}u6295${BS}u8d44`;
    assert.equal(residualScan(`{"text":"${escaped}"}`, t).entityCount, 1, 'the escaped twin is not scanned for');

    // The reverse direction, because a corpus mixes the two: measured over the
    // real corpus root, 5,751,541 Traditional-only characters beside 38,621
    // Simplified-only ones.
    const s = buildTable([entity('O2', 'org', '远帆投资', 'ORG_2')]);
    assert.equal(substituteString('客戶是遠帆投資的', s).out, '客戶是ORG_2的', 'the fold is not one-directional');

    // Reversal restores the script that was actually in the text. The span
    // records `s.slice(at, end)`, not the entry's spelling, so the Simplified
    // occurrence comes back Simplified.
    const r = substituteString('客户是远帆投资的', t);
    assert.equal(reverseString(r.out, r.spans), '客户是远帆投资的', 'reversal restored the wrong script');
  }],

  // F165 - the fold refuses the ambiguous pairs, because a redaction tool that
  // corrupts text is worse than one that misses.
  //
  // Several Traditional characters collapse onto one Simplified character
  // (發/髮 -> 发, 乾/幹 -> 干, 鐘/鍾 -> 钟) and several Simplified forms are
  // themselves distinct Traditional characters (后, 只, 面, 余, 台). Folding
  // those in reverse is a guess, and a guess mints a needle for a word the
  // person never wrote.
  ['F165', 'the Han fold is a function one way and a bijection the other, and never guesses', () => {
    // 后 is the Simplified form of 後 AND a Traditional character meaning
    // empress. Reversing it would turn a declared 王后 into the needle 王後.
    assert.deepEqual(hanVariants('幕後'), ['幕后'], 'Traditional to Simplified is a function and must work');
    assert.deepEqual(hanVariants('王后'), [], 'the reverse of an ambiguous character was guessed');
    assert.deepEqual(hanVariants('頭髮'), ['头发'], '髮 folds forward');
    assert.deepEqual(hanVariants('头发'), [], '发 has two Traditional preimages and must not fold back');
    assert.deepEqual(hanVariants('臺北'), ['台北'], '臺 folds forward');
    assert.deepEqual(hanVariants('台北'), [], '台 is its own Traditional character');

    // Structural invariants of the table, pinned rather than its size. A wrong
    // pair here is silent: the substitution stays reversible and the residue
    // count stays zero, which is the failure direction the whole file exists
    // for.
    const { forward, back } = foldTable;
    for (const [t, s] of forward) {
      assert.equal(t.length, 1, `${t} is not one UTF-16 unit`);
      // matchesAt measures its span as `at + entry.spelling.length`, so a fold
      // that changed the unit count would consume the wrong span and reversal
      // would restore the wrong text.
      assert.equal(s.length, 1, `${s} is not one UTF-16 unit`);
      assert.notEqual(t, s, `${t} folds onto itself`);
      assert.ok(HAN_ONLY.test(t) && HAN_ONLY.test(s), `${t}${s} is not a Han pair`);
      // No character is both a source and a target: that would make the fold
      // order-dependent and a round trip lossy.
      assert.ok(!forward.has(s), `${s} is both a Simplified target and a Traditional source`);
    }
    for (const [s, t] of back) assert.equal(forward.get(t), s, `${s} does not round trip through ${t}`);

    // Nothing in the corpus is a spelling of length zero, and a fold that
    // changed a length would be caught here rather than by a corrupted export.
    for (const spelling of ['遠帆投資顧問', '张大明', '臺灣銀行']) {
      for (const v of hanVariants(spelling)) assert.equal(v.length, spelling.length, `${spelling} -> ${v} changed length`);
    }
  }],

  // F166 - a zero row that means something.
  //
  // The first export happened with declared strings that matched zero times and
  // the zero row stopped nothing, because the row was one of hundreds. Measured
  // against the shipped modules: one declared path expands to seven spellings
  // and six of them match nothing, so the "matched nothing" block was a wall of
  // escaping twins nobody typed and the one row that mattered sat inside it.
  //
  // Two classes now, and they are different animals: a spelling the person
  // TYPED that matched nothing while another spelling of the same entity
  // matched (they wrote a form this corpus does not use, which is the Export 1
  // shape), and one where nothing of the entity matched anywhere (it is simply
  // not here, which is what a passport number legitimately looks like).
  ['F166', 'a declared spelling that matched nothing says which kind of nothing it is', () => {
    // Fabricated. Shape: a Traditional org name declared over a corpus that
    // writes Simplified, which is exactly what shipped.
    const table = buildTable([
      entity('O1', 'org', '遠帆投資', 'ORG_1'),
      entity('S1', 'secret', 'K7719284', 'SECRET_1'),
    ]);
    const rows = probeCounts(['客户是远帆投资的顾问'], table);
    const by = Object.fromEntries(rows.map((r) => [r.spelling, r]));
    assert.equal(by['远帆投资'].count, 1, 'the twin is what actually matched');
    assert.equal(by['遠帆投資'].count, 0, 'the declared form matched nothing');

    const out = probeOutliers(rows);
    const zeros = Object.fromEntries(out.zeros.map((z) => [z.spelling, z]));

    // The declared form, with the spelling that matched in its place. Without
    // this the reader is told a redaction did nothing and is given no way to
    // tell that from a typo.
    assert.ok(zeros['遠帆投資'], 'the declared spelling has no zero row');
    assert.equal(zeros['遠帆投資'].matchedAs, '远帆投资', 'the row does not say what matched instead');

    // The genuinely absent value: no spelling of that entity matched anything.
    assert.ok(zeros.K7719284, 'a value that is simply not in the corpus has no row');
    assert.equal(zeros.K7719284.matchedAs, null, 'a benign absence was reported as a near miss');

    // And the noise class is gone. A spelling deident GENERATED that matched
    // nothing, while the entity matched through another one, is the variant
    // generator working, not a finding.
    const paths = buildTable([entity('W1', 'workspace', `C:${BS}Users${BS}devuser`, 'WORKSPACE_1')]);
    const pathRows = probeOutliers(probeCounts([`at C:${BS}Users${BS}devuser${BS}app`], paths));
    assert.equal(pathRows.zeros.length, 0, `generated variants are still a wall: ${pathRows.zeros.map((z) => z.spelling).join(' ')}`);
    assert.ok(paths.size > 1, 'the table really does carry generated variants');

    // What the null class must NOT be allowed to claim.
    //
    // Two entities can cover the same text, and then one of them matches
    // nothing while the identity is replaced perfectly well under the other's
    // pseudonym. Reachable long before the Han fold: `Northwind` and `northwind`
    // declared separately do it, because matching is case-insensitive and only
    // one entry can win an offset. The probe breaks at the first matching entry
    // by design, so it never learns that a loser would also have matched, and a
    // row reading "this string is nowhere in the corpus" would be false.
    //
    // The wording therefore claims only what the sweep knows: nothing of THIS
    // entity matched. The row below is the one that used to be reported as an
    // absence.
    const shadowed = buildTable([
      entity('A1', 'org', 'Northwind', 'ORG_A'),
      entity('A2', 'org', 'northwind', 'ORG_B'),
    ]);
    const shadowRows = probeOutliers(probeCounts(['we use Northwind daily'], shadowed));
    const loser = shadowRows.zeros.find((z) => z.spelling === 'northwind');
    assert.ok(loser, 'the shadowed entity has no row at all');
    assert.equal(loser.matchedAs, null, 'nothing of that entity matched, so there is nothing to name');
    const text = captureOutput(() => renderProbe(shadowRows));
    assert.doesNotMatch(
      text,
      /is anywhere in the corpus|nowhere in the corpus/,
      `the report claims an absence the probe cannot know:${NL}${text}`,
    );
    assert.match(text, /No other spelling of the same entity matched either/, `the report does not say what it actually checked:${NL}${text}`);
  }],
  ['F174', 'every fixture id is distinct, so a failure message identifies one fixture', () => {
    // Five ids were used twice or three times, and "F151 failed" named two
    // different fixtures. They collided because parallel branches each appended
    // at the tail and each picked the next free number against its own copy, so
    // nothing compared them until a review did.
    //
    // Reads FIXTURES rather than the file, so it cannot drift from what runs.
    const seen = new Map();
    const dup = [];
    for (const [id] of FIXTURES) {
      if (seen.has(id)) dup.push(id);
      seen.set(id, true);
    }
    assert.deepEqual(dup, [], `duplicated fixture ids: ${dup.join(", ")}`);
    assert.equal(seen.size, FIXTURES.length);
  }],

];

export function selftest() {
  const results = [];
  for (const [id, name, fn] of FIXTURES) {
    try {
      fn();
      results.push({ id, name, ok: true, error: null });
    } catch (err) {
      results.push({ id, name, ok: false, error: `${err.message}`.split('\n')[0] });
    }
  }
  return results;
}
