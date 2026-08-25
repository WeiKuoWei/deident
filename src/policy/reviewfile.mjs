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
import path from 'node:path';
import { RefusalError } from '../cli/errors.mjs';
import { TIERS, UNCLASSIFIED } from './workspaces.mjs';
import { limitLines } from '../cli/limits.mjs';

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

  // privacy-tiers §4 level 3: the last look. A workspace tier is a coarse
  // decision and the home directory proves why one is not enough — 130 of this
  // corpus's sessions share it, and they are not one decision. Every session
  // gets a line so any single one can be held back without excluding the
  // directory it ran in.
  push('## sessions');
  push(`# Column 1: ${SESSION_DECISIONS.join(' | ')}`);
  push('#   drop   held back. Someone else’s documents, health, private messages,');
  push('#          live credentials, or anything else you will not send.');
  push('# A session whose workspace is excluded is already out; this is on top of that.');
  push('# --audience does NOT move these rows. It decides what gets substituted;');
  push('# every kept session ships at every audience.');
  for (const s of model.sessions ?? []) {
    push(`${s.decision.padEnd(6)} ${s.date}  ${s.workspace.padEnd(26)} ${s.id}`);
  }
  push('');

  push('## sessions worth a second look');
  if (model.flaggedSessions.length === 0) {
    push('# (none: no session touched a deny-listed directory)');
  }
  for (const s of model.flaggedSessions) {
    push(`drop   ${s.date}  ${s.workspace.padEnd(20)} cwd touched ${s.reason}`);
  }
  push('');

  push(`## entities to be replaced  (${model.entities.filter((e) => e.pseudonym !== null).length})`);
  push('# This is a report, not an input: third-party entities are force-replaced');
  push('# with no opt-out (BRIEF §F2), so editing a row here changes nothing.');
  if (model.entities.length === 0) {
    push('# (none: no cwd was resolved, so nothing could be seeded)');
  }
  for (const e of model.entities) {
    if (e.pseudonym === null) {
      push(`# FLAGGED, not substituted: ${e.kind}  ${e.rejected}`);
      continue;
    }
    const conf = e.confidence === 'low' ? 'LOW ' : e.confidence;
    // `occurrences: null` means nobody counted, which is not the same as zero.
    // A zero printed where nothing was measured is the §4.3 mistake in a
    // report instead of a field.
    const seen = typeof e.occurrences === 'number' ? `${String(e.occurrences).padStart(6)} occurrences` : '   not yet counted';
    push(
      `${e.pseudonym.padEnd(20)} ← ${String(e.spellings.length).padStart(2)} spellings, ${seen}   ` +
        `confidence: ${conf}   (${e.source})${e.confidence === 'low' ? '  ← check me' : ''}`,
    );
  }
  push('');
  push('# Classes swept out of session TEXT (emails, credentials, phone numbers,');
  push('# platform ids, MCP server names) are not listed above: finding them needs');
  push('# the full retention pass, which is what `deident export` does. Occurrence');
  push('# counts and per-class excerpts come from:  deident export --preview');
  push('');
  push('# The salt is NOT in this file and never will be. Neither is any');
  push('# entity-to-pseudonym map: that would be a portable re-identification key');
  push('# for data that has already left the machine.');
  push('#');
  push('# But this file IS full of raw identity: real absolute paths, real');
  push('# workspace names, real git remotes including other people\'s handles, and');
  push('# the deny-list token that matched each excluded directory. It has to be,');
  push('# or you could not recognise the rows you are deciding about.');
  push('# Do not share this file, do not paste it into a ticket, do not commit it.');
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
export function parseReview(text, opts = {}) {
  // `onProblem` turns a refusal into a reported, skipped line.
  //
  // `deident scan` is the command whose whole job is to REGENERATE this file,
  // and it was the one command a hand-broken review.md could block: it read
  // the old file before writing the new one, refused, and left the broken file
  // exactly as the user broke it. The only way out was knowing to delete it.
  // Recovery commands read what they can parse and say what they could not.
  const onProblem = typeof opts.onProblem === 'function' ? opts.onProblem : null;
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
      if (onProblem !== null) {
        onProblem(`${REVIEW_FILENAME}: "${tier}" is not a tier, so that line was ignored`);
        continue;
      }
      throw new RefusalError(`"${tier}" is not a tier`, {
        why: [
          `In review.md:  ${trimmed.slice(0, 60)}`,
          `Tiers are: ${TIERS.join(', ')}.`,
        ],
        remedies: [{ label: 'Fix the line', command: `edit ${REVIEW_FILENAME}` }],
      });
    }
    if (!name) continue;
    if (tier !== UNCLASSIFIED) decisions[name] = tier;
  }

  return Object.freeze(decisions);
}

/**
 * A session is kept or it is held. There is no third decision and no floor
 * taxonomy: a taxonomy is a second thing to keep correct, and the failure
 * direction of getting it wrong is a release.
 *
 * There WAS a third, `drop:audience`, held at `public` and released for a
 * declared insider. Measured on the live corpus at audience=teammate:
 * heldByFloor 151, heldByAudience 0, and zero occurrences of the token in the
 * review.md the tool produced. Nothing writes it (buildReviewModel emits keep
 * or drop; triage only moves a row toward drop), so it asked the operator to
 * classify every held row against a distinction that changed nothing, while
 * defining `public` as the setting that ships the FEWEST sessions. The expected
 * user publishes publicly, so the design gave its main case the worst archive,
 * using the instrument measured on this corpus as the expensive
 * mistake: whole-session removal took that funnel from 35 to 17, and removing
 * parts of a session instead took it back to 76.
 *
 * The axis now moves what goes INTO the entity list (seed.mjs, `audience`) and
 * never which sessions ship, so more privacy and more sessions stop competing.
 */
export const SESSION_DECISIONS = Object.freeze(['keep', 'drop']);

/**
 * Read, never written, never offered. A review.md written before the change
 * above still has these rows: refusing would strand the file, and reading the
 * value as unknown would RELEASE a session someone held. It is the drop its
 * author meant.
 */
const LEGACY_AUDIENCE_DROP = 'drop:audience';

/** Every column-1 value the parser accepts, including the retired one. */
function isSessionDecision(value) {
  return SESSION_DECISIONS.includes(value) || value === LEGACY_AUDIENCE_DROP;
}

/**
 * Who the archive is for, which is a claim about what the reader already knows.
 *
 * Ordered, and `public` is the default: an archive that has left a machine has
 * left it, and the person who receives it is not the last person who will hold
 * it. A declared recipient rather than a number, because a number cannot be
 * audited and gives the person no way to know what moved between 6 and 7.
 */
export const AUDIENCES = Object.freeze(['teammate', 'company', 'public']);

/**
 * The session id on a `## sessions` row: column 4, not the last word.
 *
 * renderReview writes `decision  date  workspace  id` and nothing else, so
 * "the last word on the line" was the same answer and was what the parser used.
 * `deident triage --apply` appends the reason a session was dropped after the
 * id, which makes those two answers different: the last word becomes the last
 * word of the reason, the real id is never seen, and the export silently stops
 * recognising a row triage itself wrote.
 *
 * One function so the writer and the reader cannot disagree about where the id
 * is. The fallback covers a hand-made row with fewer columns, which is the only
 * shape where the old rule was the better one.
 */
export function sessionRowId(parts) {
  return parts.length >= 4 ? parts[3] : parts[parts.length - 1];
}

/**
 * Parse the per-session decisions back out of `## sessions`. Separate from
 * parseReview because the two answer different questions and every caller of
 * parseReview wants only the workspace map; widening that return value would
 * have made four call sites care about a thing three of them do not.
 *
 * Returns both the drops AND the set of ids the file mentions at all.
 *
 * The second half is what makes the decision fail closed. A session created
 * after the last scan appears in no row, and a drops-only reading treats "not
 * mentioned" as "keep": on 2026-08-23 three sessions written since the scan
 * walked into a verified archive that way, and earlier the same hole put a
 * session into an archive that had already been checked by hand. Opt-in has to
 * mean opt-in, or the review is a snapshot the corpus quietly grows out of.
 *
 * @returns {{drops: ReadonlySet<string>, known: ReadonlySet<string>}}
 */
export function parseSessionDrops(text, opts = {}) {
  const onProblem = typeof opts.onProblem === 'function' ? opts.onProblem : null;
  const audience = opts.audience ?? 'public';
  if (!AUDIENCES.includes(audience)) {
    throw new RefusalError(`"${audience}" is not an audience`, {
      why: [
        `Audiences are: ${AUDIENCES.join(', ')}.`,
        'Refusing rather than falling back, because the fallback direction is a release.',
      ],
      remedies: [{ label: 'Declare one', command: `deident export --audience ${AUDIENCES[0]}` }],
    });
  }
  const drops = new Set();
  const known = new Set();
  let heldByFloor = 0;
  let legacyAudienceRows = 0;
  let inSessions = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('## ')) {
      inSessions = line.trim() === '## sessions';
      continue;
    }
    if (!inSessions) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    const decision = parts[0];
    const id = sessionRowId(parts);
    if (!isSessionDecision(decision)) {
      if (onProblem !== null) {
        onProblem(`${REVIEW_FILENAME}: "${decision}" is not a session decision, so that line was ignored`);
        continue;
      }
      throw new RefusalError(`"${decision}" is not a session decision`, {
        why: [
          `In review.md:  ${trimmed.slice(0, 60)}`,
          `Session decisions are: ${SESSION_DECISIONS.join(', ')}.`,
        ],
        remedies: [{ label: 'Fix the line', command: `edit ${REVIEW_FILENAME}` }],
      });
    }
    if (!id) continue;
    known.add(id);
    if (decision === LEGACY_AUDIENCE_DROP) legacyAudienceRows += 1;
    if (decision !== 'keep') {
      heldByFloor += 1;
      drops.add(id);
    }
  }

  // `audience` rides along because the manifest records it (privacy-tiers §6),
  // not because it moved anything here. It cannot: it is an entity-list
  // setting now.
  return Object.freeze({
    drops: Object.freeze(drops),
    known: Object.freeze(known),
    audience,
    heldByFloor,
    legacyAudienceRows,
  });
}

/**
 * Every `## sessions` row, whole.
 *
 * parseSessionDrops answers "which sessions are held back" and four callers
 * want only that; widening its return value would make all four care about
 * fields three of them do not. `deident triage` needs the date and the
 * workspace as well, because those are two of the four things it puts in front
 * of a reader, and reading them out of the file the person edited costs one
 * read where re-deriving them costs the whole corpus.
 *
 * Malformed rows are skipped rather than refused: this is a report-building
 * read, and parseSessionDrops is the one that gets to refuse over column 1.
 *
 * @returns {ReadonlyArray<{decision, date, workspace, id}>}
 */
export function parseSessionRows(text) {
  const rows = [];
  let inSessions = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('## ')) {
      inSessions = line.trim() === '## sessions';
      continue;
    }
    if (!inSessions) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4 || !isSessionDecision(parts[0])) continue;
    rows.push(Object.freeze({ decision: parts[0], date: parts[1], workspace: parts[2], id: sessionRowId(parts) }));
  }
  return Object.freeze(rows);
}

/**
 * Missing review.md means nothing has been decided yet, not an error.
 *
 * `known` is empty in that case, and an empty `known` means "this file said
 * nothing about sessions", which callers must treat as no opinion rather than
 * as everything unknown. Only a review file that HAS a sessions section can
 * make a session's absence meaningful.
 */
export function readSessionDrops(filePath, opts = {}) {
  try {
    return parseSessionDrops(fs.readFileSync(filePath, 'utf8'), opts);
  } catch (err) {
    if (err instanceof RefusalError) throw err;
    if (err.code === 'ENOENT') {
      return Object.freeze({
        drops: Object.freeze(new Set()),
        known: Object.freeze(new Set()),
        audience: opts.audience ?? 'public',
        heldByFloor: 0,
        legacyAudienceRows: 0,
      });
    }
    throw new RefusalError(`could not read ${filePath}`, {
      why: [`${err.code}: ${err.message}`],
      remedies: [{ label: 'Regenerate it', command: 'deident scan' }],
    });
  }
}

export function writeReview(model, outPath) {
  const text = renderReview(model);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
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
export function readReview(filePath, opts = {}) {
  try {
    return parseReview(fs.readFileSync(filePath, 'utf8'), opts);
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
  const NLC = String.fromCharCode(10);
  // `occurrences: null` means nobody counted, which is not zero. Printing 0
  // where nothing was measured is BRIEF §4.3's mistake in a report.
  const seen = (e) => (typeof e.occurrences === 'number' ? String(e.occurrences) : 'not yet counted');
  const rows = model.entities
    .map(
      (e) =>
        `<tr class="${e.confidence === 'low' ? 'low' : ''}"><td>${esc(e.pseudonym ?? 'FLAGGED')}</td><td>${esc(e.kind)}</td>` +
        `<td>${e.spellings.length}</td><td>${esc(seen(e))}</td><td>${esc(e.confidence)}</td><td>${esc(e.source)}</td></tr>`,
    )
    .join(NLC);
  const ws = model.workspaces
    .map(
      (w) =>
        `<tr><td>${esc(w.tier)}</td><td>${esc(w.name)}</td><td>${w.sessionCount}</td>` +
        `<td>${esc(w.cwd ?? '')}</td><td>${esc(w.note ?? '')}</td></tr>`,
    )
    .join(NLC);

  return `<!doctype html>
<meta charset="utf-8">
<title>deident review ${esc(model.generated)}</title>
<style>
 body{font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;margin:2rem;max-width:70rem}
 table{border-collapse:collapse;width:100%;margin-bottom:2rem}
 th,td{border-bottom:1px solid #ccc;padding:.3rem .6rem;text-align:left}
 tr.low{background:#fff6e0}
 tr.hidden{display:none}
 .warn{border:1px solid #999;padding:1rem;margin-bottom:2rem}
 .note{color:#555}
 input[type=search]{font:inherit;padding:.3rem .5rem;width:22rem;margin-bottom:.6rem}
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
<input type="search" id="q" placeholder="filter entities: pseudonym, kind, source">
<table id="ents"><tr><th>pseudonym</th><th>kind</th><th>spellings</th><th>occurrences</th><th>confidence</th><th>source</th></tr>
${rows}</table>
<p class="note">Classes swept out of session text (emails, credentials, phone
numbers, platform ids, MCP server names) are found by the retention pass, so
they appear only after <code>deident export</code>. Occurrence counts and a
before/after excerpt per replacement class come from
<code>deident export --preview</code>, which writes them to a file beside this one.</p>
<h2>NOT protected against</h2>
<ul>
${limitLines(model.manifest ?? {}).map((l) => `<li>${esc(l)}</li>`).join(NLC)}
</ul>
<script>
// No network, no CDN, no framework (cli-ux §4): one listener over the rows
// already in the document.
document.getElementById('q').addEventListener('input', (ev) => {
  const needle = ev.target.value.toLowerCase();
  for (const row of document.querySelectorAll('#ents tr')) {
    if (row.querySelector('th')) continue;
    row.classList.toggle('hidden', needle !== '' && !row.textContent.toLowerCase().includes(needle));
  }
});
</script>
`;
}
