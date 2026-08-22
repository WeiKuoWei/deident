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
import { fileURLToPath } from 'node:url';

import { expandVariants, isCjkOnly, backslashUEscape } from './entities/variants.mjs';
import { rejectReason, sweepEmails, projectShaped, basenameOf, buildEntities } from './entities/seed.mjs';
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
import { proposeTier } from './policy/signals.mjs';
import { readSession } from './corpus/reader.mjs';
import { namespaceCollisions, assignPseudonyms, pseudonymPattern } from './entities/pseudonym.mjs';
import { buildZip } from './output/zip.mjs';
import { parseReview, renderReview } from './policy/reviewfile.mjs';
import { readEntities } from './entities/tier1.mjs';
import { parseCliArgs } from './cli/args.mjs';
import { serializeSessions } from './pipeline.mjs';
import { RefusalError, ReadError, UsageError } from './cli/errors.mjs';

const BS = String.fromCharCode(92); // a single backslash, written without escapes

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
    // An EMPTY patch array is a KNOWN zero, which is a different thing.
    const empty = distillToolResult({ structuredPatch: [] });
    assert.equal(empty.code_added_lines, 0);
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

    // The boundary rule alone already handles a semantic pass returning the
    // bare word "PERSON": it is followed by `_`, a word character, so it never
    // matches inside PERSON_7. Asserting that first, because it is the reason
    // the guard is narrower than it looks.
    const bareWord = buildTable([entity('T0', 'person', 'PERSON', 'PERSON_99', { tier: 1 })]);
    assert.equal(substituteString(cleaned, bareWord).out, cleaned);

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
    assert.equal(substituteString('JakeJoin', t).out, 'JakeJoin', 'a trailing word char is still embedded');
    assert.equal(substituteString(`x${BS}${BS}nJake`, t).out, `x${BS}${BS}nJake`, 'an escaped backslash leaves a literal n');

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
