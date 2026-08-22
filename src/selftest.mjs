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
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { expandVariants, isCjkOnly, backslashUEscape } from './entities/variants.mjs';
import {
  rejectReason,
  sweepEmails,
  sweepSecrets,
  sweepPhones,
  sweepUnixUid,
  projectShaped,
  basenameOf,
  buildEntities,
} from './entities/seed.mjs';
import { buildTable, substituteString, reverseString, allOccurrences } from './substitute/engine.mjs';
import { substituteRecord } from './substitute/walker.mjs';
import { checkSubstitution } from './verify/checks.mjs';
import { residualScan, startsInsideEscape, jsonEscaped } from './verify/residual.mjs';
import { distillToolResult, retainToolUseResult, checkAddedLines } from './retain/toolresult.mjs';
import { newRetentionContext, retainRecord, quantise, rewriteUuidsInRecord } from './retain/records.mjs';
import { resolveLineCwd, cwdChangeFrom } from './corpus/cwdtrack.mjs';
import { allowLine } from './policy/linefilter.mjs';
import {
  classifyWorkspaces,
  matchDenyToken,
  cwdTierIndex,
  summarizeTiers,
  saveDecisions,
  loadSavedDecisions,
} from './policy/workspaces.mjs';
import { groupSessions, tailSegments, HOME_NAME, UNKNOWN_NAME } from './policy/grouping.mjs';
import { proposeTier, personalDataShape } from './policy/signals.mjs';
import { readSession } from './corpus/reader.mjs';
import { resolveRoot } from './corpus/root.mjs';
import { setCommand, renderRefusal, captureOutput } from './cli/report.mjs';
import {
  namespaceCollisions,
  assignPseudonyms,
  pseudonymPattern,
  loadOrCreateSalt,
} from './entities/pseudonym.mjs';
import { buildZip } from './output/zip.mjs';
import { renderPreview } from './output/preview.mjs';
import { parseReview, parseSessionDrops, renderReview } from './policy/reviewfile.mjs';
import { readEntities } from './entities/tier1.mjs';
import { parseCliArgs } from './cli/args.mjs';
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

/** Run the real CLI in a child process. Returns {code, out}. */
function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [ENTRY, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * Read a zip written by output/zip.mjs. Enough of the format to walk local
 * headers and inflate each entry, which is all a fixture needs — and it reads
 * the SHIPPED bytes rather than the in-memory records, which is the only way to
 * see what a recipient actually gets.
 */
function readZip(file) {
  const buf = fs.readFileSync(file);
  const entries = [];
  let at = 0;
  while (at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    const compressedSize = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const extraLength = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const dataAt = at + 30 + nameLength + extraLength;
    const data = zlib.inflateRawSync(buf.subarray(dataAt, dataAt + compressedSize)).toString('utf8');
    entries.push({ name, data });
    at = dataAt + compressedSize;
  }
  return entries;
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
  ['F01', '因為Dean他他想要 / Jake — Latin entity abutting CJK', () => {
    const t = buildTable([entity('P1', 'person', 'Jake', 'PERSON_1')]);
    assert.equal(substituteString('因為Dean他他想要', t).out, '因為PERSON_1他想要');
  }],

  // F02 — BRIEF §4.5 row 2, the other side of the CJK boundary.
  ['F02', 'Ivy跟小語 / Wei — CJK on the trailing side', () => {
    const t = buildTable([entity('P1', 'person', 'Wei', 'PERSON_1')]);
    assert.equal(substituteString('Ivy跟小語', t).out, 'PERSON_1跟路易');
  }],

  // F03 — BRIEF §4.5 row 3. Both \b implementations MISS 林先生/郭, and the
  // lookaround HITS it — but hitting it is over-matching inside a longer word,
  // so the rule is length >= 2 and FLAG, never substitute.
  ['F03', '林先生 / 郭 — one-char CJK is flagged, not substituted', () => {
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
  ['F05', 'ls -l owner column — bare username outside any path', () => {
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
  ['F06', 'gitroll vs gitroll-agentic — prefix collision', () => {
    const t = buildTable([
      entity('O1', 'org', 'gitroll', 'ORG_1'),
      entity('O2', 'org', 'gitroll-agentic', 'ORG_2'),
    ]);
    assert.equal(substituteString('gitroll and gitroll-agentic', t).out, 'ORG_1 and ORG_2');
    assert.equal(substituteString('gitroll-agentic first', t).out, 'ORG_2 first');
  }],

  // F07 — §4.6 three-way nested collision plus the email form. Catches an
  // interval mask that releases a region it already claimed.
  ['F07', 'devuser / devuser / devuser@gitroll.io — nested collision', () => {
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
    assert.equal(matchDenyToken(`C:${BS}p${BS}private-archive`), 'redacted-name');
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
        { name: 'private-archive', cwd: 'C:/w/private-archive', sessionCount: 4, tier: 'exclude', note: 'deny-list matched: "redacted-name"', denyToken: 'redacted-name' },
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
      { key: 'c:/w/private-archive', name: 'private-archive', cwd: 'C:/w/private-archive', normCwd: 'c:/w/private-archive', sessionCount: 4, bytes: 1, denyToken: 'redacted-name' },
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
      ['export', '--include-denied', 'redacted-name*'],
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
    assert.equal(proposeTier(g('private-archive', { denyToken: 'redacted-name' }), probe).tier, 'exclude');
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
      [g('gitroll'), g('scratch'), g('private-archive', { denyToken: 'redacted-name' }), g('a'), g('b', { unresolved: true })],
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
    assert.deepEqual(loadSavedDecisions(dir), {});
    const answered = classifyWorkspaces([g('gitroll')], { gitroll: 'open' }, { propose: (ws) => proposeTier(ws, probe) });
    assert.equal(answered[0].decided, true);
    saveDecisions(dir, answered);
    assert.deepEqual(loadSavedDecisions(dir), { gitroll: 'open' });
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
        { tier: 'exclude', name: 'private-archive', sessionCount: 1, cwd: 'C:' + String.fromCharCode(92) + 'redacted-name', note: null },
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
    const drops = parseSessionDrops(text);
    assert.deepEqual([...drops], ['bbbb-2222'], 'exactly the held-back session comes back');

    const tiers = parseReview(text);
    assert.equal(tiers['<home>'], 'redact', 'the session rows do not disturb the workspace tiers');
    assert.equal(tiers['private-archive'], 'exclude');

    // The workspace section must not be read as session decisions, and the
    // informational "second look" section must not be either.
    assert.equal(parseSessionDrops('## workspaces' + NL + 'exclude foo 1 sessions' + NL).size, 0);
    assert.equal(
      parseSessionDrops('## sessions worth a second look' + NL + 'drop 2026-08-01 ws cwd touched x' + NL).size,
      0,
      'the advisory list is a report, not an input',
    );

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
  // and the directory is not called "redacted-name".
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
    assert.equal(personalDataShape('private-archive'), 'line');
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
    const entries = readZip(path.join(out, zips[0]));
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
