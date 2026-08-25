// The reusable entity dictionary, beside the salt and never committed.
//
// Measured on the live corpus (2026-08-24): 205 sessions, 915 KB of prose in
// deident-candidates.txt. Reading it is the only stage that scales with corpus
// size, and every run started from zero, so a second run days later, with a
// handful of new sessions in it, cost the same as the first for almost no new
// information. This file is what makes the second run cheap: the entity list
// the owner wrote, plus a per-session record of what has already been put in
// front of them.
//
// PLAINTEXT, deliberately. It is local-only, on the owner's own machine, and
// plaintext is what lets them open it and add an entry by hand. Hand-editing
// is a first-class use, not an accident, which is why the shape is stable, the
// file carries its own instructions in `_note`, and every refusal below names
// the line or the entry rather than the file alone.
//
// It holds real spellings and real session ids, so it is MEMORY and never
// output: never an archive entry, never in the output directory, never in the
// repository. F126 asserts all three.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RefusalError } from '../cli/errors.mjs';

export const DICTIONARY_FILENAME = 'entities.json';

export function dictionaryPath(saltDir) {
  return path.join(saltDir, DICTIONARY_FILENAME);
}

// Written into the file itself rather than into a document nobody opens
// beside it. The reader of this header is a person who has just opened the
// file to add a name.
const NOTE = [
  'deident remembers the identities you have already declared, and which sessions',
  'you have already read, so a repeat run reads far less than the first one.',
  'You may edit this file by hand: add an entry to "entities", or delete one that',
  'was wrong. Keep every spelling of one identity inside ONE entry, or that person',
  'gets two pseudonyms. Delete a row from "sessions" to be shown that session again',
  '(or run: deident export --full). This file is local only. Never share it, never',
  'commit it: it pairs real spellings with real session ids.',
].join(' ');

const EMPTY = Object.freeze({
  path: '',
  exists: false,
  entities: Object.freeze([]),
  sessions: Object.freeze({}),
});

/**
 * Read the dictionary, or report that there is not one yet.
 *
 * Missing is the normal case and means a first run. Unreadable or malformed
 * REFUSES, the way loadUserDeny refuses: silently continuing with no
 * dictionary means the entity list is empty and every session reports as never
 * read, which reads to the person as a corpus problem rather than as a broken
 * file, and is how somebody ships an export they believed was covered.
 *
 * @returns {Readonly<{path, exists, entities: object[], sessions: object}>}
 *   `entities` are the DECLARED spellings, in the shape a person typed them
 *   and the shape deident-entities.json uses. Validation of their contents is
 *   the entity reader's job and happens where that runs.
 */
export function loadDictionary(saltDir) {
  const file = dictionaryPath(saltDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return Object.freeze({ ...EMPTY, path: file });
    throw new RefusalError(`could not read the entity dictionary ${file}`, {
      why: [
        `${err.code}: ${err.message}`,
        'This file holds the identities you have already declared. Continuing without',
        'it would export against an empty entity list.',
      ],
      remedies: [{ label: 'Fix or remove it', command: `edit ${file}` }],
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RefusalError(`${file} is not valid JSON${at(text, err)}`, {
      why: [
        err.message,
        'It is a plain file you may edit by hand, so this is usually a missing comma',
        'or a stray bracket. deident will not guess what it was meant to say.',
      ],
      remedies: [{ label: 'Fix it', command: `edit ${file}` }],
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RefusalError(`${file} is not an object`, {
      why: ['Expected {"entities": [...], "sessions": {...}}.'],
      remedies: [{ label: 'Fix it', command: `edit ${file}` }],
    });
  }

  const entities = Array.isArray(parsed.entities) ? parsed.entities : null;
  if (entities === null) {
    throw new RefusalError(`${file} has no "entities" array`, {
      why: [
        'Read as written it would contribute nothing, and an entity list that is',
        'silently empty is the failure this tool exists to prevent.',
      ],
      remedies: [{ label: 'Fix it', command: `edit ${file}` }],
    });
  }

  const sessions = {};
  const raw = parsed.sessions;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new RefusalError(`${file} has a "sessions" value that is not an object`, {
      why: ['Expected {"<session id>": {"hash": "...", "read": "<ISO timestamp>"}}.'],
      remedies: [{ label: 'Fix it', command: `edit ${file}` }],
    });
  }
  for (const [id, value] of Object.entries(raw ?? {})) {
    // A row that carries no hash is not a record of anything, and treating it
    // as one would mark a session read on the strength of its id alone.
    // Dropped rather than refused: the effect is that the session is offered
    // again, which is the safe direction and is what a hand-editor deleting
    // half a row meant.
    const hash = typeof value === 'string' ? value : value?.hash;
    if (typeof hash !== 'string' || hash.length === 0) continue;
    sessions[id] = Object.freeze({ hash, read: typeof value?.read === 'string' ? value.read : null });
  }

  return Object.freeze({
    path: file,
    exists: true,
    entities: Object.freeze(entities),
    sessions: Object.freeze(sessions),
  });
}

/** "  (line 4, column 5)" for a JSON.parse failure, or "". */
function at(text, err) {
  const m = /position (\d+)/.exec(err.message ?? '');
  if (m === null) return '';
  const upto = text.slice(0, Number(m[1]));
  const line = upto.split('\n').length;
  const column = upto.length - (upto.lastIndexOf('\n') + 1) + 1;
  return `  (line ${line}, column ${column})`;
}

/**
 * Merge an entity list into a stored one, BY IDENTITY rather than by position.
 *
 * Two entries that share any spelling are the same identity and their
 * spellings union; two that share nothing stay separate. Merging by position,
 * or by first spelling, mints two pseudonyms for one person: the failure
 * entities/tier1.mjs already warns the operator about ("One identity per
 * entry, or one person gets two pseudonyms and the prose stops making sense").
 * A dictionary turns that from a one-run mistake into a permanent one.
 *
 * The match is transitive within one call: an incoming entry that touches two
 * stored ones proves those two are also the same identity, so all three
 * collapse. Comparison is case-insensitive, because §4.5 measured `Northwind`
 * surviving 1,804 times when a case variant was treated as a different string;
 * two dictionary rows for one org is that mistake one layer up. The original
 * casing of every spelling is kept, since that is what the substituter and the
 * reader both need to see.
 *
 * `kind` and `confidence` come from the INCOMING entry where they disagree: it
 * is the more recent decision by the same person.
 *
 * @returns {{entities: object[], added: number, merged: number}}
 */
export function mergeEntities(stored, incoming) {
  const out = (stored ?? []).map((e) => ({
    kind: e.kind ?? 'person',
    spellings: [...spellingsOf(e)],
    confidence: e.confidence === 'high' ? 'high' : 'low',
  }));
  let added = 0;
  let merged = 0;

  for (const entry of incoming ?? []) {
    const spellings = spellingsOf(entry);
    if (spellings.length === 0) continue;
    const keys = new Set(spellings.map(fold));

    const hits = [];
    for (let i = 0; i < out.length; i += 1) {
      if (out[i].spellings.some((s) => keys.has(fold(s)))) hits.push(i);
    }

    if (hits.length === 0) {
      out.push({
        kind: entry.kind ?? 'person',
        spellings: [...spellings],
        confidence: entry.confidence === 'high' ? 'high' : 'low',
      });
      added += 1;
      continue;
    }

    // Collapse every entry the incoming one touched into the first of them,
    // then remove the rest. Removed from the back so the earlier indices stay
    // valid.
    const target = out[hits[0]];
    for (const i of hits.slice(1).reverse()) {
      // A loop, not push(...arr): F73 pins the shape everywhere, because a
      // spread into push is an argument-stack overflow on a large enough array.
      for (const s of out[i].spellings) target.spellings.push(s);
      out.splice(i, 1);
      merged += 1;
    }
    for (const s of spellings) target.spellings.push(s);
    target.kind = entry.kind ?? target.kind;
    target.confidence = entry.confidence === 'high' ? 'high' : target.confidence;
    target.spellings = dedupe(target.spellings);
  }

  return {
    entities: out.map((e) => Object.freeze({ ...e, spellings: Object.freeze(dedupe(e.spellings)) })),
    added,
    merged,
  };
}

function spellingsOf(entry) {
  const raw = Array.isArray(entry?.spellings)
    ? entry.spellings
    : typeof entry?.spelling === 'string'
      ? [entry.spelling]
      : [];
  return raw.filter((s) => typeof s === 'string' && s.trim().length > 0);
}

function fold(s) {
  return s.trim().toLowerCase();
}

/**
 * First-wins de-duplication on the EXACT string, so `Northwind` and `northwind`
 * both survive: they are one identity, and the substituter needs each written
 * form to match what is actually in the text (§4.5).
 */
function dedupe(spellings) {
  const seen = new Set();
  const out = [];
  for (const s of spellings) {
    const key = `${s}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * The content hash of one session's prose.
 *
 * Taken over the RETAINED prose, before tier-0 substitution, for one reason
 * that decides the whole feature: the cleaned text carries pseudonyms, and
 * `--namespace` has to take a fresh value on every run (cli-ux §5), so every
 * token in it changes run to run. Hashing the cleaned text would report every
 * session as changed, every time, and the reader would be handed 915 KB again
 * with the record looking like it worked.
 *
 * The raw prose is what the question is actually about: has this session's
 * content changed since somebody read it.
 */
export function proseHash(chunks) {
  const h = createHash('sha256');
  for (const chunk of chunks) {
    // The length before the text, rather than a separator character. Without
    // one, ["ab", "c"] and ["a", "bc"] hash identically and a session that only
    // re-split its turns would read as unchanged; with a literal separator, the
    // separator is one more character that has to survive every editor and
    // escape layer between here and the file.
    h.update(String(chunk.length));
    h.update(chunk);
  }
  return h.digest('hex').slice(0, 32);
}

/**
 * The sessions in this export that nobody has read.
 *
 * @param {object} sessionRecord the dictionary's `sessions` map
 * @param {ReadonlyArray<{id: string, hash: string}>} sessions the ones shipping
 * @param {{ignoreRecord?: boolean}} opts `--full` ignores the record entirely
 * @returns {ReadonlyArray<{id, hash, reason}>}
 */
export function uncoveredSessions(sessionRecord, sessions, opts = {}) {
  const out = [];
  for (const s of sessions) {
    if (opts.ignoreRecord === true) {
      out.push(Object.freeze({ ...s, reason: '--full: re-reading every session' }));
      continue;
    }
    const known = sessionRecord?.[s.id];
    if (known === undefined) out.push(Object.freeze({ ...s, reason: 'new since the last read' }));
    else if (known.hash !== s.hash) out.push(Object.freeze({ ...s, reason: 'changed since it was last read' }));
  }
  return Object.freeze(out);
}

/**
 * Write the dictionary. Mode 0600, beside the salt, like the tier decisions.
 *
 * Whole-file rewrite rather than a patch: the file is a few hundred entries at
 * most, and a partial writer is the thing most likely to corrupt a file a
 * person also edits by hand.
 */
export function saveDictionary(saltDir, { entities, sessions }) {
  const file = dictionaryPath(saltDir);
  const body = {
    _note: NOTE,
    version: 1,
    updated: new Date().toISOString(),
    entities,
    sessions,
  };
  fs.mkdirSync(saltDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}
