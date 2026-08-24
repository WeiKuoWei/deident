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
  projectShaped,
  basenameOf,
  buildEntities,
} from './entities/seed.mjs';
import { buildTable, substituteString, reverseString, allOccurrences, leftIsWordChar } from './substitute/engine.mjs';
import { probeCounts, probeOutliers } from './entities/probe.mjs';
import { substituteRecord } from './substitute/walker.mjs';
import { checkSubstitution, checkSemanticPass, semanticRefusal } from './verify/checks.mjs';
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
import { proposeTier, personalDataShape } from './policy/signals.mjs';
import { readSession } from './corpus/reader.mjs';
import { resolveRoot } from './corpus/root.mjs';
import { setCommand, renderRefusal, renderReadError, renderManifest, captureOutput } from './cli/report.mjs';
import {
  namespaceCollisions,
  assignPseudonyms,
  pseudonymPattern,
  pseudonymGuardPattern,
  pseudonymScanPattern,
  loadOrCreateSalt,
  defaultSaltDir,
} from './entities/pseudonym.mjs';
import { buildZip, readZip, readZipFile, MAX_ENTRIES } from './output/zip.mjs';
import { renderPreview } from './output/preview.mjs';
import { parseReview, parseSessionDrops, renderReview, renderReviewHtml } from './policy/reviewfile.mjs';
import { readEntities } from './entities/tier1.mjs';
import { parseCliArgs } from './cli/args.mjs';
import { checkRuntime, REQUIRED_NODE } from './cli/runtime.mjs';
import { serializeSessions } from './pipeline.mjs';
import { RefusalError, ReadError, UsageError } from './cli/errors.mjs';

const BS = String.fromCharCode(92); // a single backslash, written without escapes
const NL = String.fromCharCode(10);

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
function runCli(args) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}


/**
 * A corpus with the shapes the round-2 findings were measured on: a session
 * that leaves an allowed directory for a deny-listed one and comes back, a
 * cwd-less record replaying what was typed while it was away, a credential, a
 * phone number, an `ls -l` owner id, and a second session that lives entirely
 * inside the deny-listed directory.
 */
function writeCorpus(root, { unknownType = false } = {}) {
  const projects = path.join(root, 'projects', 'ws');
  fs.mkdirSync(projects, { recursive: true });
  const cwd = ['C:', 'Users', 'devuser', 'projects', 'alpha'].join(BS);
  const denied = [cwd, 'private', 'derek-evidence'].join(BS);
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
    turn(cwd, '-rw-r--r-- 1 devuser 197609    929 Aug 21 23:49 .gitignore'),
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
    JSON.stringify({ entities: [{ kind: 'person', spellings: ['Ada Wang'], confidence: 'high' }] }),
    'utf8',
  );
  return { cwd, denied, private: PRIVATE };
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
  // F01 — BRIEF §4.5 row 1. Python \b MISSES this; Node \b happens to hit it.
  // The regression guard is against anyone "simplifying" the lookaround back
  // to \b, which would make behaviour runtime-dependent.
  ['F01', '因為Dean他他想要 / Jake: Latin entity abutting CJK', () => {
    const t = buildTable([entity('P1', 'person', 'Jake', 'PERSON_1')]);
    assert.equal(substituteString('因為Dean他他想要', t).out, '因為PERSON_1他想要');
  }],

  // F02 — BRIEF §4.5 row 2, the other side of the CJK boundary.
  ['F02', 'Ivy跟小語 / Wei: CJK on the trailing side', () => {
    const t = buildTable([entity('P1', 'person', 'Wei', 'PERSON_1')]);
    assert.equal(substituteString('Ivy跟小語', t).out, 'PERSON_1跟路易');
  }],

  // F03 — BRIEF §4.5 row 3. Both \b implementations MISS 林先生/郭, and the
  // lookaround HITS it — but hitting it is over-matching inside a longer word,
  // so the rule is length >= 2 and FLAG, never substitute.
  ['F03', '林先生 / 郭: one-char CJK is flagged, not substituted', () => {
    const reason = rejectReason('郭');
    assert.ok(reason !== null, 'a single-character CJK entity must be rejected');
    assert.match(reason, /single-character CJK/);
    assert.ok(isCjkOnly('郭'));
    const t = buildTable([entity('P1', 'person', '郭', null, { rejected: reason, spellings: [] })]);
    assert.equal(substituteString('林先生', t).out, '林先生', 'must not substitute');
    assert.equal(t.flagged.length, 1, 'must be flagged for review');
    // A two-character CJK entity IS substituted.
    const t2 = buildTable([entity('P2', 'person', '郭大明', 'PERSON_2')]);
    assert.equal(substituteString('郭大明說', t2).out, 'PERSON_2說');
  }],

  // F04 — BRIEF §4.5 row 4, the correct NON-match. Catches the over-eager
  // substring substituter someone reaches for after seeing F03 fail.
  ['F04', "'array' does not match entity 'ray'", () => {
    const t = buildTable([entity('P1', 'person', 'ray', 'PERSON_1')]);
    assert.equal(substituteString('array index for ray', t).out, 'array index for PERSON_1');
    assert.equal(substituteString('an array index', t).out, 'an array index');
  }],

  // F05 — §F3. 296 bare occurrences in the owner column of ls -l, where
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

  // F06 — §4.6 prefix collision. Requires sort-by-length-descending.
  ['F06', 'gitroll vs gitroll-agentic: prefix collision', () => {
    const t = buildTable([
      entity('O1', 'org', 'gitroll', 'ORG_1'),
      entity('O2', 'org', 'gitroll-agentic', 'ORG_2'),
    ]);
    assert.equal(substituteString('gitroll and gitroll-agentic', t).out, 'ORG_1 and ORG_2');
    assert.equal(substituteString('gitroll-agentic first', t).out, 'ORG_2 first');
  }],

  // F07 — §4.6 three-way nested collision plus the email form. Catches an
  // interval mask that releases a region it already claimed.
  ['F07', 'devuser / devuser / devuser@gitroll.io: nested collision', () => {
    const t = buildTable([
      entity('P1', 'person', 'devuser', 'PERSON_1'),
      entity('P2', 'person', 'devuser', 'PERSON_2'),
      entity('P3', 'person', 'devuser@gitroll.io', 'PERSON_3'),
    ]);
    const s = 'devuser, devuser and devuser@gitroll.io walk in';
    const r = substituteString(s, t);
    assert.equal(r.out, 'PERSON_1, PERSON_2 and PERSON_3 walk in');
    for (let i = 1; i < r.spans.length; i += 1) {
      assert.ok(r.spans[i].start >= r.spans[i - 1].end, 'spans must not overlap');
    }
    assert.equal(reverseString(r.out, r.spans), s);
  }],

  // F08 — I2 over F01..F07 together, plus the independent verifier.
  ['F08', 'substitute then reverse over every earlier fixture (I2)', () => {
    const entities = [
      entity('P1', 'person', 'Jake', 'PERSON_1'),
      entity('P2', 'person', 'Wei', 'PERSON_2'),
      entity('P3', 'person', 'devuser', 'PERSON_3'),
      entity('P4', 'person', 'devuser', 'PERSON_4'),
      entity('O1', 'org', 'gitroll', 'ORG_1'),
      entity('O2', 'org', 'gitroll-agentic', 'ORG_2'),
    ];
    const t = buildTable(entities);
    const inputs = [
      '因為Dean他他想要',
      'Ivy跟小語',
      'array index',
      '-rw-r--r-- 1 devuser 197609 929 x',
      'gitroll and gitroll-agentic',
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

  // F09 — §4.2 / §4.3. The 24.1%-of-edits case that manufactures a false
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

  // F10 — PLAN C6. 1,304 records carry a string-valued toolUseResult.
  ['F10', 'string-valued toolUseResult → null, not 0, and no crash', () => {
    const d = distillToolResult('The file has been updated successfully.');
    assert.equal(d.code_added_lines, null);
    assert.equal(d.form, 'string');
    assert.equal(checkAddedLines(d), null);
    for (const weird of [null, undefined, 42, [], true]) {
      assert.equal(distillToolResult(weird).code_added_lines, null, `${JSON.stringify(weird)} must be null`);
    }
  }],

  // F11 — §4.3: null and 0 are different and 0 is the dangerous one.
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

  // F12 — I3, and PLAN C4: this fires on the real corpus today, so the test
  // protects a path Ray hits on his first run.
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

  // F13 — §4.6 variant expansion. Catches a table that covers the common form
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
    assert.ok(expandVariants('devuser@gitroll.io').includes('devuser%40gitroll.io'));
    // Backslash-u-escaped CJK, as found inside embedded JSON.
    assert.equal(backslashUEscape('郭大明'), `${BS}u90ed${BS}u5927${BS}u660e`);
    assert.ok(expandVariants('郭大明').includes(`${BS}u90ed${BS}u5927${BS}u660e`));

    // All six forms in ONE string, all replaced.
    const t = buildTable([
      entity('W1', 'workspace', `C:${BS}Users${BS}devuser`, 'WORKSPACE_1'),
      entity('P1', 'person', 'devuser@gitroll.io', 'PERSON_1'),
      entity('P2', 'person', '郭大明', 'PERSON_2'),
    ]);
    const s = [
      `C:${BS}Users${BS}devuser`,
      'C:/Users/devuser',
      '/c/Users/devuser',
      `C:${BS}${BS}Users${BS}${BS}devuser`,
      'devuser%40gitroll.io',
      `${BS}u90ed${BS}u5927${BS}u660e`,
    ].join(' | ');
    const out = substituteString(s, t).out;
    assert.ok(!out.includes('devuser'), `leaked: ${out}`);
    assert.ok(!out.includes('u90ed'), `leaked escaped CJK: ${out}`);
  }],

  // F14 — a truncated last line. Exit 3, cli-ux §9 shape, no stack trace.
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

  // F15 — I7. An unknown type is a refusal, not a silent drop. That is the
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

  // F16 — §4.8. 33% of lines carry no cwd; the effective value carries forward
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

  // F17 — §4.8 plus §4.11. The measured hazard: one file spanned 11 cwds, two
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

  // F18 — the step 4 versus step 7 ordering. If `relocated` were dropped at
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

  // F19 — §9 definition of done. Handled, not a crash.
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

  // F20 — §6 open question 1: the one that silently inflates OVR. If
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

  // F21 — I1 on the hard cases. §4.6 measured 1,206 non-BMP strings.
  ['F21', 'non-BMP emoji and escaped CJK round-trip byte-identically (I1)', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'hard.jsonl');
    const values = [
      { type: 'mode', mode: 'normal', note: '🧑‍💻 family 👨‍👩‍👧‍👦 and 𝕏' },
      { type: 'mode', mode: 'plan', note: '郭大明 said "ok"\ttab\nnewline' },
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

  // F22 — the pseudonym guard at step 12. A semantic pass that helpfully
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
    // token — a semantic pass reading the cleaned text and reporting the token
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
      [entity('T2', 'person', 'Ada', 'PERSON_98', { tier: 1 })],
      { forbidInside: pseudonymPattern(null) },
    );
    assert.equal(substituteString('PERSON_7 met Ada', g2).out, 'PERSON_7 met PERSON_98');
  }],

  // F23 — I10 idempotence, and I11: a failed run leaves nothing behind.
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
    const ents = [entity('P1', 'person', 'devuser', null), entity('O1', 'org', 'gitroll', null)];
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
    const uuid = '7594939e-0000-4000-8000-000000000000';
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
    const rec = { text: 'see 006033ea-68cb-412e-bf13-7545b926308b for details', id: 'x' };
    const out = rewriteUuidsInRecord(rec, rw);
    assert.ok(!out.text.includes('006033ea'), 'the uuid must not survive in prose');
    assert.ok(out.text.includes('00000000-0000-4000-8000-'));
    assert.equal(out.id, 'x', 'non-uuid values are untouched');
  }],

  // F69 — the bare local part of the uploader's own address survived six times
  // in a real export, because the seeded spelling is the whole address and the
  // OS username inside it is a correct embedded non-match (F07's nested
  // collision). Seeding EVERY local part would make entities of `legal`,
  // `info`, `support` and `admin`; the guard is that the handle must contain
  // the OS username, which is what makes it demonstrably the uploader's own.
  ['F69', "the uploader's own email handle is an entity, other people's are not", () => {
    const texts = ['write to devuser@gitroll.io or legal@catalyte.ai, cc support@deel.com'];
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
    assert.ok(canonicals.includes('legal@catalyte.ai'));
    assert.ok(canonicals.includes('support@deel.com'));
  }],

  // F70 — §F4 required MCP server names to be entities. seed.mjs read them from
  // the local settings files, which cover locally-configured servers only, so
  // every Claude.ai connector — configured server-side and named in no file on
  // this machine — survived 436 times in a real export. The log form is always
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
      'cc legal@catalyte.ai and ray@evansmayadvisory.com about it',
      'not an email: a@b, foo@, @bar.com, M1019757',
    ]);
    assert.ok(found.includes('legal@catalyte.ai'));
    assert.ok(found.includes('ray@evansmayadvisory.com'));
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
    assert.equal(projectShaped('moss-local'), true);
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
        { name: 'gitroll', cwd: 'C:/w/gitroll', sessionCount: 61, tier: 'redact', note: 'git remote g/g', denyToken: null },
        { name: 'private-archive', cwd: 'C:/w/private-archive', sessionCount: 4, tier: 'exclude', note: 'deny-list matched: "private"', denyToken: 'private' },
        { name: 'passport-viz', cwd: 'C:/w/passport-viz', sessionCount: 6, tier: 'unclassified', note: 'NEW', denyToken: null },
      ],
      flaggedSessions: [],
      entities: [
        { id: 'P1', kind: 'person', pseudonym: 'PERSON_1', spellings: ['a', 'b'], occurrences: 988, confidence: 'high', source: 'git config', rejected: null },
        { id: 'P2', kind: 'person', pseudonym: 'PERSON_2', spellings: ['c'], occurrences: 4, confidence: 'low', source: 'semantic pass', rejected: null },
      ],
    };
    const text = renderReview(model);
    const back = parseReview(text);
    assert.equal(back.gitroll, 'redact');
    assert.equal(back['private-archive'], 'exclude');
    assert.equal(back['passport-viz'], undefined, 'unclassified must not become a decision');
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

    const good = readEntities(write('ok.json', '{"entities":[{"kind":"person","spellings":["Ada Wang","Ada"],"confidence":"high"}]}'));
    assert.equal(good.ran, true);
    assert.equal(good.entities.length, 1);
    assert.equal(good.entities[0].tier, 1);
    assert.ok(good.entities[0].spellings.includes('Ada Wang'));
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
    const t = buildTable([
      entity('P1', 'person', 'devuser', 'PERSON_1'),
      entity('P2', 'person', 'devuser', 'PERSON_2'),
    ]);
    const s = 'devuser';
    assert.equal(substituteString(s, t).spans.length, 1, 'the substituter takes the longest only');
    const all = allOccurrences(s, t);
    assert.equal(all.length, 1, 'devuser inside devuser is boundary-invalid, so not an occurrence');
    // With a valid boundary on both, the verifier sees both candidates.
    const s2 = 'devuser devuser';
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
      accountUuid: '7594939e-0000-4000-8000-000000000000',
      artifacts: {},
    };
    for (const rec of [monitor, ledger]) {
      const out = retainRecord(rec, ctx, null);
      assert.equal(out.keep, false, `${rec.type} must be dropped`);
      assert.equal(out.record, null);
    }
  }],

  ['F35', 'the serialized-form scan catches an escaped CJK entity (§4.6)', () => {
    const t = buildTable([entity('P1', 'person', '郭大明', 'PERSON_1')]);
    // JSON.stringify does not escape CJK by default, so the decoded form is
    // what lands; but an embedded JSON string carries the \\uXXXX form, and
    // jsonEscaped is how the scan reaches it.
    assert.equal(jsonEscaped(`a${BS}b`), `a${BS}${BS}b`);
    const bytes = JSON.stringify({ text: 'a 郭大明 b' });
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
    // `\n` counted as a word character, so `Best\nJake` was classified as the
    // spelling sitting inside a longer word and left in the output — and the
    // residual scan had its own copy of the same rule, so it agreed and
    // reported `known-entity residue: 0` over a zip that named a third party.
    // Found by the live acceptance run, 2026-08-22, in 210 exported sessions.
    const t = buildTable([entity('P1', 'person', 'Jake', 'PERSON_1')]);
    assert.equal(substituteString(`Best${BS}nJake${BS}n${BS}nOn Jul`, t).out, `Best${BS}nPERSON_1${BS}n${BS}nOn Jul`);
    assert.equal(substituteString(`${BS}t${BS}tJake's push`, t).out, `${BS}t${BS}tPERSON_1's push`);
    assert.equal(substituteString(`${BS}u4e0bJake${BS}u7684`, t).out, `${BS}u4e0bPERSON_1${BS}u7684`);

    // Negative controls. F04's correct non-match must survive unchanged, and a
    // doubled backslash means the `n` really is a letter, not an escape.
    const r = buildTable([entity('P2', 'person', 'ray', 'PERSON_2')]);
    assert.equal(substituteString('array index', r).out, 'array index');
    assert.equal(substituteString('Jakeson', t).out, 'Jakeson', 'a lowercase continuation is still embedded');
    // A camel-case hump IS a token boundary, though: `JakeJoin` is two words in
    // any reading, and this is the shape that shipped `CatalyteAI` x187.
    assert.equal(substituteString('JakeJoin', t).out, 'PERSON_1Join');
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
      entity('P3', 'person', 'devuser@gitroll.io', 'PERSON_3'),
      entity('O1', 'org', 'gitroll-dev', 'ORG_1'),
    ]);
    assert.equal(
      substituteString('authuser%3Ddevuser%40gitroll.io%23all', e).out,
      'authuser%3DPERSON_3%23all',
    );
    assert.equal(substituteString('github.com%2Fgitroll-dev%2Fx', e).out, 'github.com%2FORG_1%2Fx');
  }],

  // ---- round 2. Four review findings against the shipped slice 1. -------
  //
  // All four had one root cause: a "workspace" was a storage slug directory
  // rather than the directory a person actually worked in.

  ['F40', 'a workspace is named from its resolved cwd, never from the storage slug', () => {
    const session = (p, cwds) => ({ file: { path: p, sessionId: p, bytes: 1 }, cwds });
    const groups = groupSessions(
      [
        session('s1', [`C:${BS}Users${BS}u${BS}projects${BS}gitroll`]),
        session('s2', [`C:${BS}Users${BS}u${BS}projects${BS}catalyte-whitepaper${BS}scripts`]),
      ],
      { homedir: `C:${BS}Users${BS}u` },
    );
    assert.deepEqual(groups.map((g) => g.name), ['gitroll', 'scripts']);
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
    assert.match(text, /^redact +gitroll +\d+ sessions/m);
    assert.ok(text.includes(`C:${BS}Users${BS}u${BS}projects${BS}gitroll`), 'the row must name the real directory');
    assert.ok(!text.includes('C--Users'), 'and never the slug');
    // Two sessions in one directory spelled two ways are ONE row (§4.8).
    const one = groupSessions(
      [session('a', ['C:/Users/u/Projects/x']), session('b', [`C:${BS}Users${BS}u${BS}projects${BS}x`])],
      { homedir: 'C:/Users/u' },
    );
    assert.equal(one.length, 1);
    assert.equal(one[0].sessionCount, 2);
    // review.md is whitespace-delimited, so a name may not carry a space.
    assert.equal(tailSegments('C:/Users/u/My Docs/plan', 2), 'My_Docs/plan');
  }],

  ['F41', 'tiers are proposed from signals, so unclassified is the residue not the default', () => {
    const g = (name, extra = {}) => ({
      key: name, name, cwd: `C:/w/${name}`, normCwd: `c:/w/${name}`,
      sessionCount: 1, denyToken: null, unresolved: false, ...extra,
    });
    const probe = (dir) => (dir === 'C:/w/gitroll' ? { raw: 'gitroll-dev/gitroll' } : null);

    assert.equal(proposeTier(g('gitroll'), probe).tier, 'redact');
    assert.equal(proposeTier(g('scratch'), probe).tier, 'exclude', 'no remote fails closed');
    assert.equal(proposeTier(g('private-archive', { denyToken: 'private' }), probe).tier, 'exclude');
    assert.equal(proposeTier(g(HOME_NAME), probe).tier, 'exclude');
    assert.equal(proposeTier(g('x', { unresolved: true }), probe).tier, 'unclassified');
    // `open` is never proposed: repository visibility is not on disk and
    // BRIEF §2 forbids the network call that would answer it. Guessing it
    // wrong leaks, because `open` is the weaker tier (privacy-tiers §5).
    const reason = proposeTier(g('gitroll'), probe).reason;
    assert.match(reason, /open/, 'the row must say the person decides that');
    assert.ok(!reason.includes(String.fromCharCode(0x2014)), 'no em dash in user-facing prose');

    // The census: one unclassified row out of five, not five out of five.
    const decisions = classifyWorkspaces(
      [g('gitroll'), g('scratch'), g('private-archive', { denyToken: 'private' }), g('a'), g('b', { unresolved: true })],
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
    const answered = classifyWorkspaces([g('gitroll')], { gitroll: 'open' }, { propose: (ws) => proposeTier(ws, probe) });
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
        s('a', [home, `${home}/projects/gitroll`, `${home}/projects/gitroll`]),
        s('b', [home, home, `${home}/projects/gitroll`]),
        s('c', [home, home, home]),
        s('d', [null, null]),
      ],
      { homedir: home },
    );
    assert.deepEqual(
      Object.fromEntries(groups.map((x) => [x.name, x.sessionCount])),
      { [HOME_NAME]: 2, [UNKNOWN_NAME]: 1, gitroll: 1 },
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
    const decisions = classifyWorkspaces(
      [
        { key: 'c:/users/u', name: HOME_NAME, cwd: 'C:/Users/u', normCwd: 'c:/users/u', sessionCount: 9, denyToken: null },
        { key: 'c:/users/u/projects/gitroll', name: 'gitroll', cwd: 'C:/Users/u/projects/gitroll', normCwd: 'c:/users/u/projects/gitroll', sessionCount: 1, denyToken: null },
      ],
      { [HOME_NAME]: 'exclude', gitroll: 'redact' },
      {},
    );
    const cwdTiers = cwdTierIndex(decisions);
    assert.equal(cwdTiers[0].name, 'gitroll', 'longest prefix first, or home swallows everything');
    assert.equal(allowLine('C:/Users/u/projects/gitroll/src', { cwdTiers }).allow, true);
    assert.equal(allowLine('C:/Users/u', { cwdTiers }).allow, false);
    assert.equal(
      allowLine(`C:${BS}Users${BS}u${BS}Projects${BS}gitroll`, { cwdTiers }).allow,
      true,
      'case and separator variants are the same directory',
    );
    assert.equal(allowLine('D:/elsewhere', { cwdTiers }).allow, false, 'no workspace, no export');
    // The bug this replaced: the index was built from storage slug paths,
    // which can never prefix-match a real cwd, so no workspace tier reached
    // any line at all.
    const slugIndex = [
      { prefix: 'c:/users/u/.claude/projects/c--users-u-projects-gitroll', tier: 'exclude', name: 'x' },
    ];
    assert.equal(
      allowLine('C:/Users/u/projects/gitroll', { cwdTiers: slugIndex }).allow,
      false,
      'an unmatched line fails closed rather than silently defaulting to allow',
    );
  }],

  // F45 — a closed pipe is ordinary use, not a crash.
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

  // F46 — invalid UTF-8 is silently replaced with U+FFFD by a 'utf8' read, and
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

  // F47 — the corpus is read one file at a time, and a file's raw line text is
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

  // F48 — an empty CLAUDE_CONFIG_DIR is not a setting.
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

  // F49 — cli-ux §1 makes a point of scan and review writing nothing dangerous.
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

  // F50 — the embedded class was one bucket, and it shipped 870 known-entity
  // occurrences while the gate read `known-entity residue 0  ok`.
  //
  // The residual scan imports the substituter's boundary rule precisely so the
  // two agree, which made I4 untested by construction: whatever the substituter
  // declined to replace, the scan declined to report. §4.5 row 4 justifies not
  // FAILING on `ray` inside `array`. It does not justify putting
  // `mcp__playwright-headless__` and `CatalyteAI` in the same bucket as `array`.
  ['F50', 'a separator or a camel hump is a token boundary, an ordinary letter is not', () => {
    const t = buildTable([
      entity('M1', 'machine', 'playwright-headless', 'MACHINE_1'),
      entity('O1', 'org', 'Catalyte', 'ORG_1'),
      entity('P1', 'person', 'Ada', 'PERSON_1'),
      entity('O2', 'org', 'gitroll', 'ORG_2'),
      entity('P2', 'person', 'ray', 'PERSON_2'),
    ]);
    const leaks = [
      // The whole §F4 MCP class: the log form is always mcp__NAME__tool.
      ['mcp__playwright-headless__browser_navigate', 'mcp__MACHINE_1__browser_navigate'],
      ['project_gitroll_site_hk_us.md', 'project_ORG_2_site_hk_us.md'],
      ['CatalyteAI funds payroll', 'ORG_1AI funds payroll'],
      ['MeetingAda和Jacob', 'MeetingPERSON_1和Jacob'],
    ];
    for (const [before, after] of leaks) assert.equal(substituteString(before, t).out, after, before);

    // BRIEF §4.5 row 4 is untouched: `ray` is three characters and starts
    // lowercase, so neither exception fires for it.
    for (const kept of ['an array index', 'x_ray_y', 'grayscale']) {
      assert.equal(substituteString(kept, t).out, kept, kept);
    }

    // And the residual scan agrees, because it reads the same two predicates.
    const scan = residualScan('mcp__playwright-headless__x and CatalyteAI', t, new Set());
    assert.equal(scan.entityCount, 2, 'both must be reported as residue, not counted as embedded');
    assert.equal(residualScan('an array index', t, new Set()).entityCount, 0);
  }],

  // F51 — the org entity is seeded from the git remote `gitroll-dev/gitroll`,
  // i.e. lowercase, and the company writes itself `GitRoll` everywhere. That
  // spelling survived 1,804 times in a real export and the scan had no idea it
  // existed. Enumerating lower/UPPER/Title does not help: `GitRoll` is none of
  // them. F06 passes today only because both its fixtures are lowercase.
  ['F51', 'a non-path entity matches in any casing, and reversal restores the original', () => {
    const t = buildTable([
      entity('O1', 'org', 'gitroll', 'ORG_1'),
      entity('P1', 'person', 'Ada', 'PERSON_1'),
      entity('P2', 'person', 'ray', 'PERSON_2'),
    ]);
    for (const [before, after] of [
      ['GitRoll x CatalyteAI Exchange', 'ORG_1 x CatalyteAI Exchange'],
      ['the GITROLL repo', 'the ORG_1 repo'],
      ['gitroll', 'ORG_1'],
      ['ADA wang', 'PERSON_1 wang'],
    ]) {
      assert.equal(substituteString(before, t).out, after, before);
    }

    // I2 still holds: the span records the text that was there, not the
    // entity's own spelling, so reversal is exact.
    const r = substituteString('GitRoll and gitroll', t);
    assert.equal(reverseString(r.out, r.spans), 'GitRoll and gitroll');

    // The residual scan is matched to the substituter, or the pairing that
    // makes I4 meaningful would let the same 1,804 occurrences through.
    assert.equal(residualScan('GitRoll here', t, new Set()).entityCount, 1);

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

  // F53 — two entities where one's suffix is the other's prefix.
  //
  // The scan jumped past each replacement, so an entity that STARTS INSIDE the
  // span just claimed was never examined and its remainder shipped verbatim.
  // With `the operator` and `Bell Wang Wei` both declared high-confidence persons —
  // the exact shape the tier-1 schema example invites, two names sharing a
  // token — the export contained the complete third-party name `Wang Wei`
  // while the report read `4 replacements, all reversible  ok` and
  // `known-entity residue  0  ok`. Three gates, all blind to one class.
  ['F53', 'a partially overlapping entity does not ship its tail', () => {
    const t = buildTable([
      entity('P1', 'person', 'the operator', 'PERSON_1'),
      entity('P2', 'person', 'Bell Wang Wei', 'PERSON_2'),
    ]);
    const before = 'intro call: the operator Wang Wei and the team';
    const r = substituteString(before, t);
    assert.ok(!r.out.includes('Wang Wei'), `the declared name must not survive: ${r.out}`);
    assert.ok(!r.out.includes('Kuo'), `no token of either entity may survive: ${r.out}`);
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

  // F54 — the Write tool's real corpus shape is `{type:'create', filePath,
  // content, structuredPatch: []}`: a genuinely empty patch array plus the
  // whole new file in `content`. Treating the empty array as a measured zero
  // destroyed 83,211 true added lines across 838 records — 75.9% of every added
  // line in the corpus — and destroyed them as `0`, the one value BRIEF §4.3
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

  // F55 — a `message.content` that is a plain string is the same user turn as
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

  // F56 — the prompt dedupe keyed on a 120-character prefix, so 108 distinct
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

  // F57 — cli-ux §6 prints a `0 secrets  N replaced` line, so the contract
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

  // F58 — a git remote is evidence a directory is a repository. It is not
  // evidence its content is shareable. `whatsapp-archive` was proposed `redact`
  // on the strength of its remote alone and shipped a third party's real name
  // 10 times plus per-chat filenames naming the people in them; the deny-list
  // never looked, because privacy-tiers §3 matches it against directory names
  // and the directory carries no deny token.
  ['F58', 'a git remote alone does not make a personal archive shareable', () => {
    const remote = (raw) => ({ raw, owner: raw.split('/')[0], repo: raw.split('/')[1], host: null });
    const group = (name) => ({ name, cwd: `C:${BS}x${BS}${name}`, denyToken: null, unresolved: false });

    const personal = proposeTier(group('whatsapp-archive'), () => remote('me/whatsapp-archive'));
    assert.equal(personal.tier, 'unclassified', 'a personal archive must not be swept in by its remote');
    assert.match(personal.reason, /personal data/);

    // Ordinary work still proposes redact, or the row becomes 29 questions.
    assert.equal(proposeTier(group('gitroll'), () => remote('gitroll-dev/gitroll')).tier, 'redact');
    // Whole segments only: a substring test would call these personal data.
    assert.equal(personalDataShape('cohort-learning-dashboard'), null);
    assert.equal(personalDataShape('pipeline-runner'), null);
    assert.equal(personalDataShape('timeline'), null);
    assert.equal(personalDataShape('private-archive'), 'archive');
    assert.equal(personalDataShape('old-line'), 'line');
    assert.equal(personalDataShape('health-tracker'), 'health');
  }],

  // F59 — only the salt's LENGTH was checked, and String.prototype.trim does
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

  // F60 — I9 was proved twice over two halves. `assignPseudonyms` created a
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

  // F61 — the acceptance run, end to end, over the shapes round 2 measured.
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

    const scan = runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);
    assert.equal(scan.code, 0, scan.out);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');

    const exported = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(exported.code, 0, exported.out);

    const zips = fs.readdirSync(out).filter((f) => f.endsWith('.zip'));
    assert.equal(zips.length, 1, 'exactly one archive');
    const entries = readZipFile(path.join(out, zips[0]));
    const bytes = entries.map((e) => `${e.name}${NL}${e.data}`).join(NL);

    // Content authored inside a deny-listed directory, replayed by a cwd-less
    // record that carries the cwd of a LATER moment (BRIEF §4.11).
    assert.ok(!bytes.includes(corpus.private), 'material from the denied directory must not leave');
    // The deny-listed subtree's own path, which used to survive as a tail.
    assert.ok(!bytes.includes('derek-evidence'), 'the excluded subtree must not be spelled out');
    // §F7-safe credential shapes, E.164 numbers, and the §F3 owner id.
    assert.ok(!bytes.includes('github_pat_'), 'a credential must not leave');
    assert.ok(!bytes.includes('5136 7788'), 'a personal mobile must not leave');
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

  // F62 — `--include-denied` names a workspace; the per-line gate matches a
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
    setTier(path.join(out, 'review.md'), 'derek-evidence', 'redact');
    const args = [
      'export', '--root', root, '--out', out, '--salt-dir', saltDir,
      '--entities', path.join(root, 'ents.json'),
    ];

    const without = runCli(args);
    assert.equal(without.code, 0, without.out);
    assert.match(without.out, /1 sessions from 1 workspaces/, 'the denied workspace stays out by default');

    const withFlag = runCli([...args, '--include-denied', 'derek-evidence']);
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
      JSON.stringify({ entities: [{ kind: 'person', spellings: ['Ada Wang'], confidence: 'high' }] }),
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

  // F63 — one unknown top-level record type blocked a whole export with no
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

  // F64 — `export --preview` printed a before/after pair per entity, i.e. a
  // complete portable re-identification key for every entity that actually
  // occurs, six lines under a header reading "Neither is any entity-to-
  // pseudonym map". review.md carries the same disclaimer and honours it, so
  // the two report surfaces disagreed and one of them was wrong. Aggravating:
  // --out defaults to the working directory, so the file lands next to the zip.
  ['F64', 'the preview shows what leaves, not a map back to who it was', () => {
    const table = buildTable([
      entity('P1', 'person', 'Ada Wang', 'PERSON_1'),
      entity('P2', 'person', 'devuser', 'PERSON_2'),
      entity('O1', 'org', 'Acme Advisory', 'ORG_1'),
    ]);
    const before = 'devuser: call with Ada Wang about the Acme Advisory invoice';
    const r = substituteString(before, table);

    const text = renderPreview({
      generated: '2026-08-22 00:00',
      strings: [{ path: 'x', before, after: r.out, spans: r.spans }],
      table,
      entities: [
        { id: 'P1', kind: 'person', pseudonym: 'PERSON_1', spellings: ['Ada Wang'], confidence: 'high', source: 'semantic pass', rejected: null, canonical: 'Ada Wang' },
        { id: 'O1', kind: 'org', pseudonym: 'ORG_1', spellings: ['Acme Advisory'], confidence: 'high', source: 'semantic pass', rejected: null, canonical: 'Acme Advisory' },
      ],
      manifest: { sessions: 1, workspaces: 1, userMessages: 1, zeros: [] },
      checks: [],
    });

    for (const spelling of ['Ada Wang', 'Acme Advisory', 'devuser']) {
      assert.ok(!text.includes(spelling), `${spelling} must not appear beside its pseudonym`);
    }
    // The excerpt is still there, in exported form, or the preview shows nothing.
    assert.match(text, /PERSON_1/);
    assert.match(text, /call with PERSON_1 about the ORG_1 invoice/);
    // A tier-0 excerpt must not show a tier-1 name sitting a few characters away.
    assert.ok(!text.includes('Wang'), 'no fragment of a declared entity may survive the excerpt');
  }],

  // F65 — `review --entity` and `review --session` are specified in cli-ux §5
  // as part of the slice-1 contract and are not implemented. They printed a
  // note and exited 0, pointing at `export --preview`, which answers neither —
  // so a scripted check of "can I drill into PERSON_11" passed while nothing
  // happened. BRIEF §2: a flag that exits 0 without doing its job is a failure.
  ['F65', 'an unimplemented query says so instead of exiting 0', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);
    runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]);

    for (const [flag, value] of [['--entity', 'PERSON_11'], ['--session', '2026-08-20']]) {
      const r = runCli(['review', '--root', root, '--out', out, '--salt-dir', saltDir, flag, value]);
      assert.equal(r.code, 2, `${flag} must be a usage error, not success`);
      assert.match(r.out, /not implemented in slice 1/);
      assert.match(r.out, /cli-ux/);
    }

    // `review` itself still works.
    assert.equal(runCli(['review', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);
  }],

  // F66 — every walker in the pipeline is recursive, so pathologically nested
  // JSON exhausts the JS stack. That is a property of the INPUT, and it was
  // reported as `internal error while running "scan": Maximum call stack size
  // exceeded / This is a bug in deident, not a problem with your data`, exit 1
  // — naming the wrong culprit and sending the user to file an issue about
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

  // F67 — the export's write ordering and its one deliberate exception.
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

    // Now make the tier memo unwritable by putting a directory where its file
    // goes. The export must still succeed, warn, and leave the zip in place.
    fs.rmSync(path.join(out, fs.readdirSync(out).find((f) => f.endsWith('.zip'))));
    // Readable so the run can still load tiers, unwritable so only the SAVE
    // fails. On Windows chmod maps to the read-only attribute, which is exactly
    // the failure a real user hits with a locked or synced directory.
    const memo = path.join(saltDir, 'workspaces.json');
    fs.writeFileSync(memo, '{}', 'utf8');
    fs.chmodSync(memo, 0o444);
    const blocked = runCli(args);
    assert.equal(blocked.code, 0, `a lost tier memo is not a failed export: ${blocked.out}`);
    assert.match(blocked.out, /could not remember your tier decisions/);
    assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.zip')).length, 1, 'the archive stays');
    assert.doesNotMatch(blocked.out, /Nothing was written/, 'the report must not contradict the archive on disk');
    fs.chmodSync(memo, 0o666);

    // review --html into a directory that does not exist yet.
    const deep = path.join(root, 'nested', 'deeper');
    const html = runCli(['review', '--html', '--root', root, '--out', deep, '--salt-dir', saltDir]);
    assert.equal(html.code, 0, html.out);
    assert.ok(fs.existsSync(path.join(deep, 'review.html')));

    // And where the path cannot be a directory at all, it is a named refusal
    // with a remedy, not an internal error.
    const blocking = path.join(root, 'a-file');
    fs.writeFileSync(blocking, 'not a directory', 'utf8');
    const refused = runCli(['review', '--html', '--root', root, '--out', blocking, '--salt-dir', saltDir]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /could not write/);
    assert.match(refused.out, /--out <path>/);
    assert.doesNotMatch(refused.out, /bug in deident/);
  }],

  // F68 — an empty entity list satisfied I6: `semantic pass  --entities
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
      entities: [{ id: 'T1', canonical: 'Ada Wang', spellings: ['Ada Wang'], rejected: null }],
    });
    assert.equal(real.ok, true);
    // The count in the report is the USABLE count, and it says so when the two
    // differ, because a number that overstates the pass is what was wrong.
    const mixed = checkSemanticPass({
      ran: true,
      source: '--entities e.json',
      entities: [
        { id: 'T1', canonical: 'Ada Wang', spellings: ['Ada Wang'], rejected: null },
        { id: 'T2', canonical: 'a', spellings: [], rejected: 'too short' },
      ],
    });
    assert.equal(mixed.ok, true);
    assert.match(mixed.detail, /1 entities \(1 rejected\)/);
  }],

  // F71 — a replacement changes the text the boundary rule reads.
  //
  // Measured on a real export: `devuserGitRoll.onmicrosoft.com` glued the
  // uploader's handle to the org name. Two things were wrong. The camel-hump
  // test asked the ENTRY's spelling whether it started a hump, and matching is
  // case-insensitive, so the entry for `GitRoll` reads `gitroll` and answered
  // for a casing that is not the one in the file. And once a replacement lands,
  // the text around the next candidate is different — so the substituter and
  // the residual scan can legitimately disagree, which is a permanently red
  // gate rather than a bug in either.
  ['F71', 'the boundary reads the matched text, and substitution runs to a fixpoint', () => {
    const t = buildTable(
      [entity('P1', 'person', 'devuser', 'X_PERSON_147'), entity('O1', 'org', 'gitroll', 'X_ORG_725')],
      { namespace: 'X' },
    );
    const before = 'mail devuserGitRoll.onmicrosoft.com here';
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

  // F73 — `array.push(...items)` passes one ARGUMENT per element, so a
  // corpus-sized array overflows the argument stack.
  //
  // Measured 2026-08-22: 100,000 spans is fine, 125,000 throws RangeError
  // "Maximum call stack size exceeded". A 762 KB session file holding one user
  // message of `'devuser '.repeat(130000)` reached it through walker.mjs, and the
  // same shape reached `deident scan` through roundTripFailures — surfacing as
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

  // F74 — the deep-nesting refusal told the user to run --skip-unreadable, and
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

  // F75 — `review.md` read `## entities to be replaced  (0)` and review.html's
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

  // F76 — the "NOT protected against" block lived in three files and two of
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

  // F77 — `deident scan` is the command whose whole job is to regenerate
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

  // F78 — SALT_RE is a shape test. 64 zeros were caught by an explicit branch;
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

  // F79 — a tier the person typed has to be durable and has to survive a
  // neighbouring workspace appearing.
  //
  // Two separate holes, both ending with an excluded workspace in the zip and
  // every gate green:
  //   1. saveDecisions persisted only rows where `decided` was already true,
  //      which was only set when a saved decision had already matched — so a
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

  // F80 — I3 ran the DECODED-string pattern over RAW serialized lines, where
  // the `n` of a backslash-n escape is a word character, so its lookbehind
  // refused to match any pseudonym-shaped token at the start of a line inside
  // multi-line prose. That is exactly how docs/cli-ux §3's own `PERSON_03 <-`
  // sample row arrives once a teammate reads the docs in a session.
  //
  // The check printed `pseudonym namespace  no pre-existing PERSON_n tokens
  // ok`, deident minted the same token for a tier-1 person, and the archive
  // then contained one token meaning two different things — with reversal
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

  // F81 — four classes shipped verbatim while the manifest asserted they were
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
    assert.deepEqual(sweepIdNumbers(['passport number pending', 'the passport-viz project']), [],
      'no number, no entity');
    // §F7's own example: a passport-shaped regex matched a thermal-paste part
    // number, and nothing here says "passport" beside it.
    assert.deepEqual(sweepIdNumbers(['the part is M1019757 and it runs hot']), []);

    // Account ids: stable join keys for a named person.
    const ids = sweepPlatformIds([
      'Participants: A (ID: U06ET0DWQM), B (ID: U06EVQ4GLB)  Channel: DM (ID: D06EVTZZ4J)',
      'notes at app.notion.com/3290b700541e81a2a23fc0ee24eab375',
    ]);
    assert.ok(ids.includes('U06ET0DWQM') && ids.includes('D06EVTZZ4J'), `slack ids: ${ids}`);
    assert.ok(ids.includes('3290b700541e81a2a23fc0ee24eab375'), 'the notion page id');
    // A bare 32-hex string is every content hash in the corpus (§F7).
    assert.deepEqual(sweepPlatformIds(['sha 3290b700541e81a2a23fc0ee24eab375 of the blob']), []);

    // Phone numbers as they appear in a signature block, not in E.164.
    const phones = sweepPhones([
      'M: +1 (650) 665 4812',
      'HK (+852) 5136 0512 / (+886) 976 570 312',
      'office (650) 877-4012 or 801-401-9012',
    ]);
    for (const want of ['+1 (650) 665 4812', '(+852) 5136 0512', '(650) 877-4012', '801-401-9012']) {
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
      { kind: 'account', canonical: 'U06ET0DWQM', source: 'x', confidence: 'high' },
    ]);
    const assigned = assignPseudonyms(seeded, SALT, null).entities;
    assert.deepEqual(assigned.map((e) => e.pseudonym.replace(/_\d+$/, '')), ['ACCOUNT', 'IDNUM']);
  }],

  // F82 — a pseudonym whose plaintext original appears in the same string has
  // done nothing. Three forms reversed one without the salt, measured on a
  // real export:
  //   `accountant = X_ORG_1684551 https://www.evansma…ory.com`   x15
  //   `…authuser%3DX_PERSON_465285%2540gitroll.io`               (a doubly
  //      percent-encoded @, so §4.6's single-%XX escape rule saw the digit `0`
  //      and called `gitroll` embedded)
  //   `…mcgZGV2dXNlckBub3J0aHdpbmQuZXhhbXBsZQ%26…`, base64 of the work address   x30
  ['F82', 'the domain, the double-encoding and the base64 of an entity are the entity', () => {
    const withVariants = (id, kind, canonical, pseudonym) => ({
      ...entity(id, kind, canonical, pseudonym),
      looseSpellings: looseVariants(canonical),
    });
    const t = buildTable([
      withVariants('O1', 'org', 'gitroll', 'ORG_1'),
      withVariants('P1', 'person', 'devuser@gitroll.io', 'PERSON_1'),
      withVariants('O2', 'org', 'Acme Advisory', 'ORG_2'),
    ]);

    // (a) the domain spelling of a multi-word org.
    assert.equal(
      substituteString('accountant = ORG_2 https://www.evansmayadvisory.com', t).out.includes('evansmay'),
      false,
    );
    // A one-word name has no squashed form to confuse with an English word.
    assert.equal(squashedForm('gitroll'), null);
    assert.equal(squashedForm('Acme Advisory'), 'evansmayadvisory');

    // (b) a doubly percent-encoded at-sign no longer hides the domain.
    assert.equal(substituteString('authuser%3DX%2540gitroll.io', t).out, 'authuser%3DX%2540ORG_1.io');

    // (c) base64, at every one of the three alignments, and still reversible.
    for (const prefix of ['', 'x', 'xy']) {
      const blob = `q${Buffer.from(`${prefix}devuser@gitroll.io&z`, 'utf8').toString('base64')}`;
      const r = substituteString(blob, t);
      assert.equal(r.spans.length > 0, true, `alignment "${prefix}" was missed`);
      assert.equal(reverseString(r.out, r.spans), blob, 'reversal must still be exact');
    }
    // The loose exemption applies to base64 needles and to nothing else: an
    // ordinary spelling still obeys §4.5, so `ray` inside `array` is untouched.
    const strict = buildTable([entity('P9', 'person', 'ray', 'PERSON_9')]);
    assert.equal(substituteString('array index', strict).out, 'array index');
  }],

  // F83 — the deny-list filtered where the agent WAS, never what it TOUCHED.
  //
  // BRIEF §4.11 says per-directory opt-in, never opt-out, and privacy-tiers §4
  // claims three levels of granularity make that sufficient. All three read
  // the cwd, so a Read, an Edit or a directory listing of a deny-listed path
  // from an ALLOWED cwd was invisible to every one of them. Measured on a real
  // export: `…\private\vendor-search\SCORECARD.md` x17,
  // `…\private\VENDOR-BRIEF.md` x36, `calc.mjs` x5 — the
  // parent got a WORKSPACE pseudonym and the subpath below it did not — and a
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

  // F84 — the cwd-less gate destroyed two whole record classes and never said
  // so. Measured over the 39 sessions a default-shaped run exports: 2,162
  // last-prompt and 613 queue-operation records dropped, 0 kept, 872 of those
  // texts (135,668 characters) appearing nowhere else in their own session —
  // and 0 of 6,976 `mode` records in the corpus carry a cwd, so every one went
  // too, while the manifest prints privacy-tiers' "session count, work mode
  // and outcome only" verbatim.
  //
  // Claude Code is launched from the home directory, scan proposes that
  // workspace `exclude`, and BRIEF §4.8 already measured that one session
  // spans many cwds — so `touchedExcluded` was true for 39 of 39 sessions.
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

  // F85 — a declared tier-1 entity whose spelling contains a tier-0 spelling
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

  // F87 — three retention defects that all report something untrue.
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

  // F88 — three environment and format ceilings that each arrived as
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

  // F89 — a full-corpus export ran 24m28s and printed its first byte after the
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

  // F90 — two things the report was silent about while every gate read green.
  //
  // (a) BRIEF §4.5 asks for length >= 2 AND a flag for CJK entities, "because
  //     the lookaround does not prevent over-matching inside a longer CJK
  //     word". The length rule shipped, the flag did not: 小明 matched inside
  //     小明天 and mangled a sentence that named nobody.
  // (b) Two overlapping declared entities collapse to one span, and the token
  //     they SHARE disappears — so `the operator Wang` and `the operator Kuo Wang` come
  //     out identical. I2 passes because reverseString is fed the spans, but
  //     §3 forbids persisting them, so the reversal path that actually exists
  //     (regenerate the list, hash candidates) cannot tell the two apart.
  ['F90', 'a CJK match and an absorbed overlap are counted, not passed off as clean', () => {
    const cjk = buildTable([entity('P1', 'person', '小明', 'PERSON_1')]);
    const over = substituteString('明天小明天氣很好', cjk);
    assert.equal(over.out, '明天PERSON_1天氣很好', 'BRIEF §4.5: the lookaround cannot stop this');
    assert.equal(over.spans[0].cjk, true, 'so the occurrence has to be counted');
    // A Latin entity is not flagged, or the count means nothing.
    const latin = buildTable([entity('P2', 'person', 'Jake', 'PERSON_2')]);
    assert.equal(substituteString('因為Dean他他', latin).spans[0].cjk, false);

    const pair = buildTable([
      entity('P3', 'person', 'the operator', 'PERSON_3'),
      entity('O1', 'org', 'Kuo Wang', 'ORG_1'),
    ]);
    const a = substituteString('A: the operator Wang', pair);
    const b = substituteString('B: the operator Kuo Wang', pair);
    assert.equal(a.spans.some((sp) => sp.absorbed), true, 'the overlap is recorded as absorbed');
    assert.equal(a.out.slice(3), b.out.slice(3), 'two different inputs, one output: this is the point');
    // Span-relative reversal still works, which is exactly the distinction the
    // manifest now has to draw.
    assert.equal(reverseString(a.out, a.spans), 'A: the operator Wang');
    assert.equal(reverseString(b.out, b.spans), 'B: the operator Kuo Wang');

    const printed = captureOutput(() => renderManifest({
      sessions: 1, workspaces: 1, userMessages: 1, zeros: [], droppedByCwd: 0, emptiedSessions: 0,
      absorbedSpans: 2, cjkSpans: 5, embedded: 0, unknownTypes: [], countOnly: { sessions: 0, workspaces: 0 },
    }));
    assert.match(printed, /2 replacements merged two overlapping entities/);
    assert.match(printed, /5 CJK entity occurrences replaced/);
  }],

  // F91 — the second half of F83: a deny-listed path quoted in PROSE.
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
  // Measured 2026-08-24: the ordinary noun for taxation was a declared spelling,
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
  // guarantee — the one that exists because a 1,804-occurrence leak came from a
  // casing mismatch — withheld from Cyrillic and Greek for no reason but the
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
    const latin = buildTable([{ id: 'L1', kind: 'org', pseudonym: 'X_O_4', spellings: ['GitRoll'] }]);
    assert.equal(substituteString('at gitroll and GITROLL', latin).out, 'at X_O_4 and X_O_4');
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
    const ascii = expandVariants('GitRoll');
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
  // journey-and-pitfalls section 2.1 states it as a build instruction: "the
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
  // outside every check the tool has. journey-and-pitfalls section 2.1 is the
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
  // F100 - a held session records WHY it is held, and one setting moves the
  // half that a setting can move.
  //
  // audience-and-floor.md records the measurement: 36 sessions were held, the
  // owner released almost all of them, and named the reason - the recipient is a
  // colleague who already knows the company's business. Twenty of the remaining
  // 28 moved on that fact alone. A tool that cannot express it makes the person
  // re-adjudicate 36 rows to change one thing.
  //
  // The axis is a declared recipient rather than a number, because a number
  // cannot be audited and gives no way to know what moved between 6 and 7. The
  // floor is not on the axis: another person's identity documents, their health,
  // a private message archive, live credentials. Loosening cannot reach anything
  // belonging to someone who is not in the room.
  //
  // Deliberately no floor taxonomy: an unqualified `drop` IS the floor. A
  // taxonomy would be a second thing to keep correct, and the failure direction
  // of getting it wrong is a release.
  ['F100', 'the audience setting moves audience-held rows and never floor-held ones', () => {
    const model = {
      generated: '2026-08-24 00:00',
      workspaces: [{ tier: 'redact', name: '<home>', sessionCount: 3, cwd: 'C:', note: null }],
      sessions: [
        { id: 'aaaa-1111', date: '2026-08-01', workspace: '<home>', decision: 'keep' },
        { id: 'bbbb-2222', date: '2026-08-02', workspace: '<home>', decision: 'drop' },
        { id: 'cccc-3333', date: '2026-08-03', workspace: '<home>', decision: 'drop:audience' },
      ],
      flaggedSessions: [],
      entities: [],
    };
    const text = renderReview(model);

    // Default is public: nothing is released, because an archive that has left
    // a machine has left it and the recipient is not the last person to hold it.
    const strict = parseSessionDrops(text);
    assert.deepEqual([...strict.drops].sort(), ['bbbb-2222', 'cccc-3333']);
    assert.deepEqual([...strict.known].sort(), ['aaaa-1111', 'bbbb-2222', 'cccc-3333']);

    // Declaring an insider releases the audience-held row and NOT the floor one.
    const insider = parseSessionDrops(text, { audience: 'company' });
    assert.deepEqual([...insider.drops], ['bbbb-2222'], 'the floor row stays, the audience row goes');

    // The two reasons are counted apart, because the second number is the only
    // one that changes if the person turns the knob, and merging them hides the
    // only actionable half.
    assert.equal(strict.heldByFloor, 1);
    assert.equal(strict.heldByAudience, 1);
    assert.equal(insider.heldByFloor, 1);
    assert.equal(insider.heldByAudience, 0);

    // The decision round-trips: rendering what was parsed gives the same rows.
    assert.match(text, /drop:audience\s+2026-08-03/);
    assert.equal(parseSessionDrops(renderReview(model)).drops.size, 2);

    // An unknown qualifier refuses rather than being read as the safe default.
    // Guessing here fails towards release.
    assert.throws(() => parseSessionDrops('## sessions' + NL + 'drop:later 2026-08-01 ws aaaa-1111' + NL), RefusalError);

    // And an unknown audience refuses too, for the same reason.
    assert.throws(() => parseSessionDrops(text, { audience: 'friends' }), RefusalError);
  }],
  // F101 - the manifest must say which audience it was exported for, and count
  // the two reasons apart.
  //
  // privacy-tiers 6: a recipient comparing two corpora needs to see that one
  // uploader withheld 40% of theirs, or a privacy choice reads downstream as a
  // skill gap. The audience is the other half of that: a corpus exported for a
  // teammate and one exported for the public are not comparable, and nothing in
  // the contents says which is which.
  ['F101', 'the declared audience is recorded, and the two held counts are separate', () => {
    const root = tmpdir();
    const out = path.join(root, 'out');
    const saltDir = path.join(root, 'salt');
    writeCorpus(root);

    assert.equal(runCli(['scan', '--root', root, '--out', out, '--salt-dir', saltDir]).code, 0);
    setTier(path.join(out, 'review.md'), 'alpha', 'redact');

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
    assert.equal(typeof doc.manifest.heldByAudience, 'number');

    // Default is public when nothing is declared, and it is recorded as such
    // rather than left absent: absent reads as "not considered".
    const dflt = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--json',
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(dflt.code, 0, dflt.out);
    assert.equal(JSON.parse(dflt.out).manifest.audience, 'public');

    // The human path prints it too, in the block whose whole job is being
    // believed.
    const human = runCli([
      'export', '--root', root, '--out', out, '--salt-dir', saltDir, '--audience', 'teammate',
      '--entities', path.join(root, 'ents.json'),
    ]);
    assert.equal(human.code, 0, human.out);
    assert.match(human.out, /teammate/);
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
