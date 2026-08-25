// Per-session triage: the cheap stage that runs BEFORE the expensive semantic
// entity pass, so a reader never pays to read sessions that were never going to
// be exported.
//
// The measurement (2026-08-24, live corpus). 205 sessions. Each session's cwd
// plus its first user prompt truncated to 300 characters is a 23,302-character
// payload, about 7k tokens. The entity pass that follows reads 915 KB, about
// 250k tokens. That is a 35x difference for the stage that decides whether a
// session ships at all.
//
// The same measurement said what to build it on: 0 of those 205 sessions carry
// an `ai-title` record. Titles do not exist on this corpus. 161 of 205 carry a
// first user prompt, so the prompt is the surface and a title, if one ever
// appears, is a bonus.
//
// THE ONE PROPERTY THIS FILE EXISTS TO ENFORCE
//
// A triage verdict may only ever move a session toward `drop`. It may never
// propose `keep`, and it may never overturn an existing `drop`.
//
// docs/model-tier.md disqualifies the cheapest tier for the entity pass because
// its failures are MISSES, and a miss there is a disclosure: across two runs it
// found 0 and 1 of the seven values that were themselves the secret, and
// returned a full-looking list of 27 entities either way. The measurement is
// about reasoning strength, so it transfers to whichever ladder of tiers the
// reader can actually call. Triage inverts that, and only
// because removal is the only power on offer: a wrong verdict here costs
// coverage, never privacy. The moment a verdict can release a session, the
// whole argument for a cheap reader is gone. So the constraint is in the code,
// not in the header. A header is a request; this is a constraint.

import fs from 'node:fs';
import { RefusalError } from '../cli/errors.mjs';
import { REVIEW_FILENAME, sessionRowId } from './reviewfile.mjs';

export const TRIAGE_FILENAME = 'deident-triage.txt';
export const VERDICTS_FILENAME = 'deident-triage.json';

/**
 * `unsure` exists so a reader can be explicit rather than silent. A row nobody
 * wrote down and a row somebody looked at and left alone should not look the
 * same to the next person reading the verdicts file.
 */
export const TRIAGE_VERDICTS = Object.freeze(['drop', 'unsure']);

export const DEFAULT_TRIAGE_CHARS = 300;

/**
 * The cap exists because the flag can undo the whole stage.
 *
 * At 2,000 characters over 205 sessions the payload is 410 KB, which is already
 * within reach of the 915 KB the entity pass reads. A limit high enough to carry
 * whole sessions turns triage back into the expensive stage, and it would do it
 * quietly, because every check would still pass.
 */
export const MAX_TRIAGE_CHARS = 2000;

const HEADER_RULE = '# ---------------------------------------------------------------------------';

/**
 * The header a reader acts on.
 *
 * Same shape as the tier-1 candidates header in src/entities/tier1.mjs: what
 * the file is, what to write back, and the one rule that is not negotiable. F122
 * asserts the drop-only sentences against this rendered text rather than against
 * a copy, because a fixture holding its own copy passes while the shipped file
 * says something else.
 */
function header(chars) {
  return `# deident triage
#
# One block per session your review currently proposes to KEEP. Each block is a
# session id, its date, the directory the sessions ran in, and the first thing
# the person typed, truncated to ${chars} characters. Nothing else is read.
#
# Measured 2026-08-24 on a 205-session corpus: this file is about 23 KB, about
# 7k tokens. The entity pass that runs after it reads 915 KB, about 250k tokens.
# The point of this stage is to spend the cheap 7k before the expensive 250k.
#
# YOUR VERDICT MAY ONLY EVER MOVE A SESSION TOWARD "drop".
#
# There is no "keep" verdict, and there is no way to release a session that is
# already dropped. Both are enforced in code, not by convention. That is what
# makes a cheap reader acceptable here: docs/model-tier.md disqualifies the low
# tier for the entity pass because its failures are misses and a miss there is a
# disclosure, but the only power on offer here is removal, so a wrong verdict
# costs coverage and never privacy.
#
# Drop a session when:
#   - it is about somebody else's private life, health, money or documents
#   - it is one long paste with no work in it
#   - its first prompt is a credential, a key or a recovery kit
#   - you cannot classify it. A drop costs one session of coverage, and that is
#     the cheaper mistake in both directions.
#
# Leave everything else alone. Write "unsure" rather than nothing when you looked
# at a row and decided not to act, so the next reader can tell a considered row
# from a skipped one.
#
# Write ${VERDICTS_FILENAME} next to this file:
#
#   {
#     "verdicts": [
#       {"id": "<session id>", "verdict": "drop", "reason": "one line"}
#     ]
#   }
#
# verdict is one of: ${TRIAGE_VERDICTS.join(' | ')}
# reason is required for "drop": a held-back session whose row says nothing is a
# decision the next person cannot check.
#
# Then:  deident triage --apply --verdicts ${VERDICTS_FILENAME}
#
# This file carries RAW prose. Unlike deident-candidates.txt, tier-0
# substitution has NOT run over it: the paths, the names and the values are
# exactly as they were typed. Treat it the way you treat ${REVIEW_FILENAME}:
# local only, never shared, never committed.
#
${HEADER_RULE}
`;
}

/**
 * Render the triage payload.
 *
 * @param {ReadonlyArray<{id, date, workspace, prompt: string|null}>} rows
 * @param {{chars?: number}} opts
 * @returns {string}
 */
export function renderTriage(rows, opts = {}) {
  const chars = opts.chars ?? DEFAULT_TRIAGE_CHARS;
  const parts = [header(chars)];
  for (const row of rows) {
    parts.push(`${row.id}  ${row.date}  ${row.workspace}`);
    // A session whose prompt could not be read is still offered, and the row
    // says so. It is the row most worth a look: nobody can see what is in it,
    // and hiding it would quietly ship every session that has no first prompt.
    parts.push(
      row.prompt === null || row.prompt === ''
        ? '  (no first user prompt in this session)'
        : `  ${truncate(row.prompt, chars)}`,
    );
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * The ellipsis is a character of its own, so the cap is the cap.
 *
 * `slice(0, n) + '…'` returns n + 1 characters, which is how a limit becomes an
 * off-by-one that only shows up as a fixture measuring the wrong number.
 */
function truncate(text, chars) {
  return text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;
}

/**
 * Read and validate a verdicts file.
 *
 * Every failure names the file and the row. A malformed verdicts file must
 * never silently become an empty one: an empty one applies nothing while the
 * report says the stage ran, which is the shape of failure BRIEF §2 is about.
 *
 * @returns {ReadonlyArray<{id, verdict, reason}>}
 */
export function readVerdicts(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new RefusalError(`could not read the verdicts file ${filePath}`, {
      why: [`${err.code}: ${err.message}`],
      remedies: [
        { label: 'Produce one first', command: 'deident triage --out <workdir>' },
        { label: 'Or point at the right file', command: `deident triage --apply --verdicts <path to ${VERDICTS_FILENAME}>` },
      ],
    });
  }
  return parseVerdicts(text, filePath);
}

/** Validation, with no I/O in it. Same split as readReview and parseReview. */
export function parseVerdicts(text, source = VERDICTS_FILENAME) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RefusalError(`${source} is not valid JSON`, {
      why: [err.message, 'A malformed verdicts file must not silently become an empty one.'],
      remedies: [{ label: 'Fix the file', command: `edit ${source}` }],
    });
  }

  const raw = Array.isArray(parsed) ? parsed : parsed?.verdicts;
  if (!Array.isArray(raw)) {
    throw new RefusalError(`${source} has no "verdicts" array`, {
      why: ['Expected either a bare array, or an object with a "verdicts" array.'],
      remedies: [{ label: 'Fix the file', command: `edit ${source}` }],
    });
  }

  const out = [];
  const seen = new Set();
  for (const [i, item] of raw.entries()) {
    const at = `${source} verdicts[${i}]`;
    if (item === null || typeof item !== 'object') throw badRow(at, 'is not an object', source);

    const id = item.id;
    if (typeof id !== 'string' || id.trim() === '') throw badRow(at, 'has no "id"', source);

    const verdict = item.verdict;
    if (verdict === 'keep') throw keepRefusal(at, id, source);
    if (!TRIAGE_VERDICTS.includes(verdict)) {
      throw badRow(at, `("${id}") has verdict "${verdict}"; expected ${TRIAGE_VERDICTS.join(' or ')}`, source);
    }

    // Collapsed to one line before anything else sees it. The reason is appended
    // to a row in review.md, and review.md is whitespace-delimited: a reason
    // carrying a newline would split one decision into two lines, the second of
    // which is not a session decision, and the next export would refuse over a
    // file triage itself wrote.
    const reason = typeof item.reason === 'string' ? item.reason.replace(/\s+/g, ' ').trim() : '';
    if (verdict === 'drop' && reason === '') {
      throw badRow(at, `("${id}") drops a session with no "reason"`, source);
    }

    // A file that says both `drop` and `unsure` about one session has not made
    // a decision, and picking either one for the person is guessing.
    if (seen.has(id)) throw badRow(at, `names "${id}" a second time`, source);
    seen.add(id);

    out.push(Object.freeze({ id: id.trim(), verdict, reason }));
  }
  return Object.freeze(out);
}

/**
 * The refusal that is the constraint.
 *
 * Its own function, with its own wording, because it is not a typo the way the
 * other bad rows are: somebody asked triage to release a session, and the
 * answer is that this stage has no such power by construction.
 */
function keepRefusal(at, id, source) {
  return new RefusalError(`${at} asks to keep "${id}", and "keep" is not a triage verdict`, {
    why: [
      'A triage verdict may only ever move a session toward drop.',
      'It cannot release a session and it cannot overturn a drop, so there is',
      'nothing for a keep verdict to do.',
      '',
      'That asymmetry is the reason a cheap reader is acceptable at this stage:',
      'the only power on offer is removal, so a wrong verdict costs coverage and',
      'never privacy. See docs/model-tier.md. Nothing was applied.',
      '',
      'Sessions stay kept by being absent from the verdicts file, or by "unsure".',
    ],
    remedies: [
      { label: 'Say nothing instead', command: `remove that row from ${source}` },
      { label: 'Or say it explicitly', command: `set its verdict to "unsure" in ${source}` },
    ],
  });
}

function badRow(at, problem, source) {
  return new RefusalError(`${at} ${problem}`, {
    why: [
      'deident will not guess what a malformed verdict was meant to mean.',
      'Applying half a verdicts file is worse than applying none, because the',
      'report would claim the stage ran. Nothing was applied.',
    ],
    remedies: [{ label: 'Fix the row', command: `edit ${source}` }],
  });
}

/**
 * Merge verdicts into the `## sessions` section of a review.md.
 *
 * Rewritten line by line rather than re-rendered from a model, so an edit the
 * person made since the last scan survives. A re-render would silently discard
 * every hand-typed tier in the same file.
 *
 * The drop-only constraint appears here for the second time, and the two are
 * not redundant: parseVerdicts stops a `keep` from being written down, and this
 * stops any verdict at all from moving a row that already reads `drop`. A
 * refusal one code path can bypass is not a refusal (PLAN §2, I6).
 *
 * @returns {{text, applied, unchanged, unmatched}} the three id lists are what
 *   the report prints; a caller never has to re-derive them from the text.
 */
export function applyVerdicts(reviewText, verdicts) {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const applied = [];
  const unchanged = [];
  let inSessions = false;

  const lines = reviewText.split('\n').map((rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('## ')) {
      inSessions = line.trim() === '## sessions';
      return rawLine;
    }
    if (!inSessions) return rawLine;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return rawLine;

    const parts = trimmed.split(/\s+/);
    // Four columns is the shape renderReview writes. A row with fewer is
    // hand-made and cannot be rebuilt without inventing a date and a workspace,
    // so it is left exactly as its author wrote it.
    if (parts.length < 4) return rawLine;
    const id = sessionRowId(parts);
    const verdict = byId.get(id);
    if (verdict === undefined) return rawLine;

    const decision = parts[0];
    // `unsure` never moves anything, and a row already at the floor is where a
    // verdict was going to put it anyway. A retired `drop:audience` row from an
    // older review.md IS rewritten to a plain `drop`, which is where it already
    // resolves and is the spelling the file now uses.
    if (verdict.verdict !== 'drop' || decision === 'drop') {
      unchanged.push(id);
      return rawLine;
    }
    applied.push(id);
    // Rebuilt in renderReview's own shape, so a triaged row and a scanned row
    // are the same row. The reason goes after the id, which is why the id is
    // read from column 4 and not from the end of the line.
    const row = `${'drop'.padEnd(6)} ${parts[1]}  ${parts[2].padEnd(26)} ${id}`;
    return verdict.reason === '' ? row : `${row}   # ${verdict.reason}`;
  });

  const touched = new Set([...applied, ...unchanged]);
  return Object.freeze({
    text: lines.join('\n'),
    applied: Object.freeze(applied),
    unchanged: Object.freeze(unchanged),
    unmatched: Object.freeze(verdicts.map((v) => v.id).filter((id) => !touched.has(id))),
  });
}
