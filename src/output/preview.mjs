// --preview: a plain-text before/after diff for the user's own editor.
//
// BRIEF §7.7. Same checks as a real export, same "leaving this machine"
// accounting, no zip. The point is that an engineer can read what would leave
// before anything does.
//
// The preview shows a SAMPLE OF EVERY REPLACEMENT CLASS rather than the first
// N replacements: the first N are all the same path root, and a reviewer who
// sees only path substitutions concludes the tool only does paths.

import fs from 'node:fs';
import path from 'node:path';
import { RefusalError, osErrorLine } from '../cli/errors.mjs';
import { EXAMPLES_PER_REPORT } from '../retain/constants.mjs';
import { safeUnlink } from './zip.mjs';
import { substituteString } from '../substitute/engine.mjs';
import { limitLines } from '../cli/limits.mjs';

const CONTEXT_CHARS = 45;

/**
 * @param {object} state  {strings, entities, manifest, checks, namespace}
 * @param {string} outPath
 */
export function writePreview(state, outPath) {
  const text = renderPreview(state);
  const partPath = `${outPath}.part`;
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(partPath, text, 'utf8');
    fs.renameSync(partPath, outPath);
  } catch (err) {
    safeUnlink(partPath);
    safeUnlink(outPath);
    throw new RefusalError(`could not write ${outPath}`, {
      why: [osErrorLine(err), 'Nothing was left behind.'],
      remedies: [{ label: 'Choose a writable directory', command: 'deident export --preview --out <path>' }],
    });
  }
  return { path: outPath, bytes: Buffer.byteLength(text, 'utf8') };
}

export function renderPreview(state) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`deident preview · ${state.generated}`);
  push('');
  push('This file is what an export WOULD contain, in before/after form.');
  push('Nothing has been zipped and nothing has left this machine.');
  push('');
  push('The salt is never written here. Neither is any entity-to-pseudonym map:');
  push('each excerpt below is the text AS IT WOULD BE EXPORTED, so it shows what');
  push('leaves without pairing a pseudonym to the spelling it replaced.');
  push('');

  push('== replacement classes ==');
  push('');
  const byEntity = groupByEntity(state.strings, state.table ?? null);
  for (const entity of state.entities) {
    if (entity.pseudonym === null) {
      push(`${entity.id}  ${entity.kind}  FLAGGED, NOT SUBSTITUTED`);
      push(`    ${entity.rejected}`);
      push('');
      continue;
    }
    const samples = byEntity.get(entity.id) ?? [];
    push(
      `${entity.pseudonym}  ${entity.kind}  ${entity.spellings.length} spelling${entity.spellings.length === 1 ? '' : 's'}, ` +
        `${samples.length.toLocaleString('en-US')} occurrences   confidence: ${entity.confidence === 'low' ? 'LOW' : entity.confidence}` +
        `   (${entity.source})${entity.confidence === 'low' ? '   <- check me' : ''}`,
    );
    for (const sample of samples.slice(0, EXAMPLES_PER_REPORT)) {
      push(`    ${sample.after}`);
    }
    push('');
  }

  push('== flagged, never substituted ==');
  push('');
  const flagged = state.entities.filter((e) => e.pseudonym === null);
  if (flagged.length === 0) push('    (none)');
  for (const e of flagged) push(`    ${e.canonical}  ${e.rejected}`);
  push('');

  push('== checks ==');
  push('');
  // The rows stay here, unlike the terminal. This is a document somebody opens
  // to inspect detail rather than a screen they skim in three seconds, and the
  // per-check attribution is the thing they came for.
  for (const c of state.checks) push(`    ${c.label.padEnd(23)} ${c.detail.padEnd(44)} ${c.ok ? 'ok' : 'FAILED'}`);
  push('');
  // The remainder does NOT stay behind, on any surface. Every row above asks
  // whether the output is consistent with the entity table; none asks whether
  // the table is complete, and a block of `ok` with nothing beside it reads as
  // an answer to the second question. limits.mjs was written because the same
  // disclosure lived in three renderers and was fixed in one of them: this file
  // and review.html both printed a stale "NOT protected against" block for a
  // run whose entity table had already made it false.
  if (state.unverified) {
    const u = state.unverified;
    push(`    unverified: ${u.proseBytes} bytes of these sessions is prose, and prose is the only part`);
    push(`    a reader is ever shown. The archive is ${u.archiveBytes} bytes, of which ${u.unreadPercent}% is not`);
    push('    prose. Most of that cannot hold a name: record scaffolding, and identifiers');
    push(`    deident minted itself. ${u.toolParamBytes} bytes of it (${u.toolParamPercent}%) is the parameters of`);
    push('    your tool calls: free text, shown to no reader, checked by nothing.');
    push('');
  }

  push('== leaving this machine ==');
  push('');
  push(`    ${state.manifest.sessions} sessions from ${state.manifest.workspaces} workspaces`);
  // The same two statements the terminal manifest makes, for the same reason
  // the counters below are duplicated here: the preview is a trust surface and
  // two trust surfaces that disagree about what left are one surface that is
  // wrong. The entry-gate bound and the read count are the two lines a reader
  // of this file most needs, because this file cannot show them either.
  if (state.manifest.admitted) {
    const a = state.manifest.admitted;
    const admitted = `${a.workspaces} workspace${a.workspaces === 1 ? '' : 's'}`;
    push(
      a.notAdmitted > 0
        ? `    every session here is from one of ${admitted} you admitted by name; ${a.notAdmitted} others contributed nothing`
        : `    every session here is from the ${admitted} you admitted by name`,
    );
  }
  if (state.manifest.read) {
    const r = state.manifest.read;
    push(`    ${r.read} of ${r.total} sessions were opened and read here, ${r.unread} are unverified`);
    // Reading this file is not reading a session. It carries one 45-character
    // window per entity class by construction (see excerptAt), so a preview
    // that credited itself with a session read would be the exact number-where-
    // no-check-ran that cli-ux §12b rules out.
    if (r.read === 0) push('      reading this file does not change that: it shows windows, not sessions');
  }
  push(`    ${state.manifest.userMessages} user messages`);
  for (const z of state.manifest.zeros) push(`    0 ${z.label.padEnd(18)} ${z.suppressed}`);
  // Counters, not zeros, the same distinction the terminal manifest makes, so
  // the two trust surfaces cannot disagree about what was dropped.
  if (state.manifest.droppedByCwd > 0) {
    push(`    ${state.manifest.droppedByCwd} lines dropped: outside an included directory`);
  }
  if (state.manifest.emptiedSessions > 0) {
    push(`    ${state.manifest.emptiedSessions} sessions retained nothing and are not in the archive`);
  }
  push('');
  push('== NOT protected against ==');
  push('');
  // The same block report.mjs prints, from src/cli/limits.mjs. This copy still
  // read "MCP server names" for a run whose entity table replaced 2,864 of
  // them, which is exactly the disclosure defect cli-ux §6 names.
  for (const line of limitLines(state.manifest)) push(`    ${line}`);
  push('');

  return `${lines.join('\n')}\n`;
}

/**
 * One excerpt per replacement, keyed by entity, so every class is represented.
 *
 * The window is cut from the SUBSTITUTED string, not the original, so every
 * other entity inside it is already a token. Cutting it from the original left
 * the surrounding text raw: an excerpt centred on one pseudonym showed the
 * username and the full home path a few characters to its left, which pairs
 * those just as effectively as the before/after lines it replaced.
 */
function groupByEntity(strings, table) {
  const map = new Map();
  for (const s of strings) {
    // Offsets in `after` drift from offsets in `before` by the length each
    // earlier replacement changed. Tracked rather than searched for, because
    // searching would find the wrong occurrence of a repeated token.
    let delta = 0;
    for (const span of s.spans) {
      const afterStart = span.start + delta;
      delta += span.pseudonym.length - (span.end - span.start);
      if (!map.has(span.entityId)) map.set(span.entityId, []);
      const list = map.get(span.entityId);
      if (list.length >= EXAMPLES_PER_REPORT * 4) {
        list.push(PLACEHOLDER);
        continue;
      }
      list.push(excerptAt(s.after, afterStart, span.pseudonym.length, table));
    }
  }
  return map;
}

const PLACEHOLDER = Object.freeze({ after: '' });

/**
 * One excerpt, in EXPORTED form only.
 *
 * A before/after pair is a complete, portable re-identification key for every
 * entity that actually occurs, the artifact BRIEF §3 says not to write, and
 * the file's own header stated it contained no such map. review.md carries the
 * same disclaimer and honours it, printing occurrence counts only, so the two
 * report surfaces disagreed with each other and one of them was wrong.
 *
 * The exported form is what the preview is for: reading what would leave. The
 * spelling that was replaced is the one thing a reader does not need in order
 * to judge that, and is exactly the half that turns the file into a key.
 *
 * The merged table is applied once more over the window, because a tier-0
 * excerpt is cut from text that tier 1 has not been applied to yet and would
 * otherwise show a third-party name §F2 force-replaces.
 */
function excerptAt(after, start, length, table) {
  const from = Math.max(0, start - CONTEXT_CHARS);
  const to = Math.min(after.length, start + length + CONTEXT_CHARS);
  const window = after.slice(from, to).replace(/\s+/g, ' ');
  const clean = table ? substituteString(window, table).out : window;
  return Object.freeze({
    after: `${from > 0 ? '…' : ''}${clean}${to < after.length ? '…' : ''}`,
  });
}
