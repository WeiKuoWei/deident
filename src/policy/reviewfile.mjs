// review.md is BOTH the report and the config, so the two directions must
// round-trip. cli-ux §3.
//
// The decision is made by editing a text file, not by answering prompts.
// Engineers trust a file they can grep, diff and keep; a prompt sequence
// cannot be reviewed by a second person, and a file can.
//
// §F6: low-confidence entities are individual rows and are NEVER collapsed
// into a count. `names 12 items [expand]` is a button nobody presses, and that
// is how the review becomes theatre.

import fs from 'node:fs';
import { RefusalError } from '../cli/errors.mjs';
import { TIERS, UNCLASSIFIED } from './workspaces.mjs';

export const REVIEW_FILENAME = 'review.md';

export function renderReview(model) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`# deident review · ${model.generated}`);
  push('# Edit the tier in column 1, save, then run: deident export');
  push(`# Tiers: ${TIERS.join(' | ')}`);
  push('');
  push('## workspaces');
  push('# name · the directory the sessions actually ran in · why this tier');
  for (const w of model.workspaces) {
    // §4.9: the storage slug never appears here. The name comes from the
    // resolved cwd and the resolved cwd itself is the reason, because a row a
    // person cannot recognise is a row they cannot decide about.
    const because = [w.cwd, w.note].filter((v) => typeof v === 'string' && v !== '').join('  ·  ');
    push(`${w.tier.padEnd(12)} ${w.name.padEnd(26)} ${String(w.sessionCount).padStart(3)} sessions   ${because}`.trimEnd());
  }
  push('');

  push('## sessions worth a second look');
  if (model.flaggedSessions.length === 0) {
    push('# (none — no session touched a deny-listed directory)');
  }
  for (const s of model.flaggedSessions) {
    push(`drop   ${s.date}  ${s.workspace.padEnd(20)} cwd touched ${s.reason}`);
  }
  push('');

  push(`## entities to be replaced  (${model.entities.filter((e) => e.pseudonym !== null).length})`);
  for (const e of model.entities) {
    if (e.pseudonym === null) {
      push(`# FLAGGED, not substituted: ${e.kind}  ${e.rejected}`);
      continue;
    }
    const conf = e.confidence === 'low' ? 'LOW ' : e.confidence;
    push(
      `${e.pseudonym.padEnd(20)} ← ${String(e.spellings.length).padStart(2)} spellings, ${String(e.occurrences ?? 0).padStart(6)} occurrences   ` +
        `confidence: ${conf}   (${e.source})${e.confidence === 'low' ? '  ← check me' : ''}`,
    );
  }
  push('');
  push('# The salt is NOT in this file and never will be. Neither is any');
  push('# entity-to-pseudonym map: that would be a portable re-identification key');
  push('# for data that has already left the machine.');
  push('');

  return `${lines.join('\n')}\n`;
}

/**
 * Parse the workspace tier decisions back out. Only the `## workspaces`
 * section is read: the entity list is a report, not an input, because
 * third-party entities are force-replaced with no opt-out (§F2).
 *
 * @returns {Readonly<Record<string, string>>}
 */
export function parseReview(text) {
  const decisions = {};
  let inWorkspaces = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('## ')) {
      inWorkspaces = line.trim() === '## workspaces';
      continue;
    }
    if (!inWorkspaces) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    const [tier, name] = parts;
    if (!TIERS.includes(tier) && tier !== UNCLASSIFIED) {
      throw new RefusalError(`"${tier}" is not a tier`, {
        why: [
          `In review.md:  ${trimmed.slice(0, 60)}`,
          `Tiers are: ${TIERS.join(', ')}.`,
        ],
        remedies: [{ label: 'Fix the line', command: `notepad ${REVIEW_FILENAME}` }],
      });
    }
    if (!name) continue;
    if (tier !== UNCLASSIFIED) decisions[name] = tier;
  }

  return Object.freeze(decisions);
}

export function writeReview(model, outPath) {
  const text = renderReview(model);
  try {
    fs.writeFileSync(outPath, text, 'utf8');
  } catch (err) {
    throw new RefusalError(`could not write ${outPath}`, {
      why: [`${err.code}: ${err.message}`],
      remedies: [{ label: 'Choose a writable directory', command: 'deident scan --out <path>' }],
    });
  }
  return { path: outPath, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Missing review.md is not an error: scan has simply not been run yet. */
export function readReview(filePath) {
  try {
    return parseReview(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err instanceof RefusalError) throw err;
    if (err.code === 'ENOENT') return Object.freeze({});
    throw new RefusalError(`could not read ${filePath}`, {
      why: [`${err.code}: ${err.message}`],
      remedies: [{ label: 'Regenerate it', command: 'deident scan' }],
    });
  }
}

/** cli-ux §4: one self-contained HTML file. No server, ever. */
export function renderReviewHtml(model) {
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const rows = model.entities
    .map(
      (e) =>
        `<tr class="${e.confidence === 'low' ? 'low' : ''}"><td>${esc(e.pseudonym ?? 'FLAGGED')}</td><td>${esc(e.kind)}</td>` +
        `<td>${e.spellings.length}</td><td>${e.occurrences ?? 0}</td><td>${esc(e.confidence)}</td><td>${esc(e.source)}</td></tr>`,
    )
    .join('\n');
  const ws = model.workspaces
    .map(
      (w) =>
        `<tr><td>${esc(w.tier)}</td><td>${esc(w.name)}</td><td>${w.sessionCount}</td>` +
        `<td>${esc(w.cwd ?? '')}</td><td>${esc(w.note ?? '')}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<meta charset="utf-8">
<title>deident review ${esc(model.generated)}</title>
<style>
 body{font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;margin:2rem;max-width:70rem}
 table{border-collapse:collapse;width:100%;margin-bottom:2rem}
 th,td{border-bottom:1px solid #ccc;padding:.3rem .6rem;text-align:left}
 tr.low{background:#fff6e0}
 .warn{border:1px solid #999;padding:1rem;margin-bottom:2rem}
</style>
<h1>deident review · ${esc(model.generated)}</h1>
<div class="warn">
<strong>Decisions are made by editing review.md, not here.</strong>
This page is for reading. Low-confidence rows are highlighted and listed
individually; they are never collapsed into a count.
</div>
<h2>workspaces</h2>
<table><tr><th>tier</th><th>workspace</th><th>sessions</th><th>directory</th><th>why</th></tr>
${ws}</table>
<h2>entities</h2>
<table><tr><th>pseudonym</th><th>kind</th><th>spellings</th><th>occurrences</th><th>confidence</th><th>source</th></tr>
${rows}</table>
<h2>NOT protected against</h2>
<ul>
<li>device fingerprint: MCP server names, model mix, CLI version sequence</li>
<li>verbatim documents you pasted into your own messages</li>
<li>third-party names the semantic pass did not recognise</li>
</ul>
`;
}
