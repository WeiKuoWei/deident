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
import { RefusalError } from '../cli/errors.mjs';
import { EXAMPLES_PER_REPORT } from '../retain/constants.mjs';
import { safeUnlink } from './zip.mjs';

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
      why: [`${err.code}: ${err.message}`, 'Nothing was left behind.'],
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
  push('The salt is never written here. Neither is any entity-to-pseudonym map.');
  push('');

  push('== replacement classes ==');
  push('');
  const byEntity = groupByEntity(state.strings);
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
      push(`    - ${sample.before}`);
      push(`    + ${sample.after}`);
    }
    push('');
  }

  push('== flagged, never substituted ==');
  push('');
  const flagged = state.entities.filter((e) => e.pseudonym === null);
  if (flagged.length === 0) push('    (none)');
  for (const e of flagged) push(`    ${e.canonical}  —  ${e.rejected}`);
  push('');

  push('== checks ==');
  push('');
  for (const c of state.checks) push(`    ${c.label.padEnd(23)} ${c.detail.padEnd(44)} ${c.ok ? 'ok' : 'FAILED'}`);
  push('');

  push('== leaving this machine ==');
  push('');
  push(`    ${state.manifest.sessions} sessions from ${state.manifest.workspaces} workspaces`);
  push(`    ${state.manifest.userMessages} user messages`);
  for (const z of state.manifest.zeros) push(`    0 ${z.label.padEnd(18)} ${z.suppressed}`);
  push('');
  push('== NOT protected against ==');
  push('');
  push('    device fingerprint: MCP server names, model mix, CLI version sequence');
  push('    verbatim documents you pasted into your own messages');
  push('    third-party names the semantic pass did not recognise');
  push('');

  return `${lines.join('\n')}\n`;
}

/**
 * One excerpt per replacement, keyed by entity, so every class is represented.
 */
function groupByEntity(strings) {
  const map = new Map();
  for (const s of strings) {
    for (const span of s.spans) {
      if (!map.has(span.entityId)) map.set(span.entityId, []);
      const list = map.get(span.entityId);
      if (list.length >= EXAMPLES_PER_REPORT * 4) {
        list.push(PLACEHOLDER);
        continue;
      }
      list.push(excerptPair(s, span));
    }
  }
  return map;
}

const PLACEHOLDER = Object.freeze({ before: '', after: '' });

function excerptPair(s, span) {
  const from = Math.max(0, span.start - CONTEXT_CHARS);
  const to = Math.min(s.before.length, span.end + CONTEXT_CHARS);
  const lead = s.before.slice(from, span.start);
  const trail = s.before.slice(span.end, to);
  const flat = (x) => x.replace(/\s+/g, ' ');
  return Object.freeze({
    before: `${from > 0 ? '…' : ''}${flat(lead)}${span.spelling}${flat(trail)}${to < s.before.length ? '…' : ''}`,
    after: `${from > 0 ? '…' : ''}${flat(lead)}${span.pseudonym}${flat(trail)}${to < s.before.length ? '…' : ''}`,
  });
}
