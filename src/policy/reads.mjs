// Which shipped sessions a human actually opened, so the manifest can say so.
//
// Two archives shipped with all six gates green and both leaked. Every gate in
// this tool is an internal-consistency check (cli-ux §12b), so not one of them
// can answer "was everything that should have been substituted, substituted".
// The only instrument that can is a person reading a session, and until now the
// export had no way to say whether that ever happened. An archive whose
// manifest is silent about it reads as an archive somebody checked.
//
// This file records nothing about content and nothing about entities. It is a
// list of session ids with the date each was opened, which is strictly less
// than occurrences.json already holds, and it lives beside the salt for the
// same reason: a real session id is a re-identification handle for the archive
// and the output directory is the one the person zips up and sends.
//
// It is NOT a gate. cli-ux §12b argues the case against adding a seventh check
// that repeats what the six already do; the case here is narrower. A gate a
// person clears by opening one arbitrary session buys a checkbox, not a look,
// and a gate that can only ever be red on a 205-session corpus is the first
// thing switched off. The number ships WITH the archive instead, to the
// recipient, who is the person the claim is being made to. The uploader cannot
// make it look better without doing the reading, and cannot hide it.

import fs from 'node:fs';
import path from 'node:path';

export const READS_FILENAME = 'reads.json';

export function readsPath(saltDir) {
  return path.join(saltDir, READS_FILENAME);
}

const NOTE = [
  'Sessions you opened in full with "deident review --session", and when. The export',
  'states this count against the number of sessions it shipped, and states the rest as',
  'unverified. It holds real session ids, so it is local only: never share it, never',
  'commit it, and never put it in the output directory beside the zip.',
].join(' ');

const EMPTY = Object.freeze({ sessions: Object.freeze({}), entities: Object.freeze({}) });

/**
 * The read record, or an empty one.
 *
 * A missing or broken file is an empty record and never a refusal. The opposite
 * choice would make an unreadable bookkeeping file block an export, and the
 * failure direction of that is a person deleting the file to get moving.
 * Reporting 0 reads is always safe: it understates.
 */
export function loadReads(saltDir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(readsPath(saltDir), 'utf8'));
  } catch {
    return EMPTY;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY;
  const sessions = {};
  for (const [id, rec] of Object.entries(parsed.sessions ?? {})) {
    // A hand-edited entry that carries no readable date is dropped rather than
    // read as epoch zero, which would compare as older than every session file
    // and so count as read forever.
    const at = typeof rec?.at === 'string' ? Date.parse(rec.at) : NaN;
    if (!Number.isFinite(at)) continue;
    sessions[id] = Object.freeze({ at: rec.at, atMs: at, via: typeof rec.via === 'string' ? rec.via : 'unknown' });
  }
  const entities = {};
  for (const [token, rec] of Object.entries(parsed.entities ?? {})) {
    if (typeof rec?.at === 'string') entities[token] = Object.freeze({ at: rec.at });
  }
  return Object.freeze({ sessions: Object.freeze(sessions), entities: Object.freeze(entities) });
}

/**
 * Record one read. Never throws: this is bookkeeping about a command that has
 * already done its job, and a read-only query that fails at the end because a
 * directory is not writable has failed for no reason the person can act on.
 *
 * @param {string} kind 'sessions' for a session opened in full, 'entities' for
 *   a drill-down. They are kept apart because they are not the same evidence:
 *   see countReads.
 */
export function recordRead(saltDir, id, via, kind = 'sessions') {
  if (typeof id !== 'string' || id === '') return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(readsPath(saltDir), 'utf8'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  } catch {
    doc = {};
  }
  doc.sessions = typeof doc.sessions === 'object' && doc.sessions !== null ? doc.sessions : {};
  doc.entities = typeof doc.entities === 'object' && doc.entities !== null ? doc.entities : {};
  doc[kind][id] = { at: new Date().toISOString(), via };
  try {
    fs.mkdirSync(saltDir, { recursive: true });
    fs.writeFileSync(
      readsPath(saltDir),
      `${JSON.stringify({ _note: NOTE, version: 1, sessions: doc.sessions, entities: doc.entities }, null, 1)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    return null;
  }
  return readsPath(saltDir);
}

/**
 * The count for the manifest.
 *
 * A read counts only while the session it opened has not changed since. The
 * comparison is against the session file's own mtime, which the export already
 * carries per session, so it costs no extra stat and no extra state: reading a
 * transcript from March says nothing about the four turns appended in August,
 * and BRIEF §4.3 is this repository's own record of what a number that is
 * quietly wrong does downstream.
 *
 * `entities` is reported separately and never folded into `read`. A drill-down
 * shows an 80-character excerpt per occurrence, and crediting a whole session
 * for one matched line is the arithmetic an earlier review killed a
 * random-sample proposal over. The same objection retires `--preview`: it
 * writes one 45-character window per entity class, so it opens no session at
 * all.
 *
 * @param {ReadonlyArray<{id: string, mtimeMs: number}>} shipped
 */
export function countReads(reads, shipped) {
  let read = 0;
  let stale = 0;
  for (const s of shipped) {
    const rec = reads.sessions[s.id];
    if (rec === undefined) continue;
    if (Number.isFinite(s.mtimeMs) && s.mtimeMs > rec.atMs) stale += 1;
    else read += 1;
  }
  return Object.freeze({
    read,
    stale,
    total: shipped.length,
    unread: shipped.length - read,
    entities: Object.keys(reads.entities).length,
  });
}
