// The third source of entities: values the person DECLARES.
//
// deident had two sources and both of them were inference. Tier 0 infers from
// machine state (the username, paths, git config, credential shapes); tier 1
// infers from prose (what a reader can see). Neither can be TOLD "this exact
// string is mine", so the only way a value got protected was for the tool, or a
// model reading the prose, to work out on its own that it mattered.
//
// The measured cost of having no third source: a finished export with all six
// gates green shipped 21 identity fields in plaintext. Passport name orderings
// and three name spellings used across visa documents, a date and place of
// birth, a household registration address in two languages, three country
// addresses, a driving licence address, two banks' address of record, a phone
// number and a payment-platform account id. Concentrated in two sessions, one
// of them a browser-automation session filling a booking form with passport
// data. Every one of those values was already written down, by hand, in a
// personal-details file the same person maintained: the tool was performing
// semantic discovery to find a list that already existed.
//
// Same directory as the salt and denied.json, and the same properties: local,
// never committed, never written into the archive, never into --out. The shape
// follows denied.json's precedent, including the bare-array shorthand for the
// common case, because a second file with a third convention is a file people
// get wrong.

import fs from 'node:fs';
import path from 'node:path';
import { RefusalError } from '../cli/errors.mjs';
import { KINDS } from '../entities/seed.mjs';
// Imported rather than reimplemented: the four existence tests are identical
// for every file that lives beside the salt, and the consequence sentence is
// the only part that differs per file.
import { missingFromSaltDir } from './userdeny.mjs';

/** Filename read from the salt directory. */
export const KNOWN_VALUES_FILENAME = 'known-values.json';

/**
 * The kind a bare string gets.
 *
 * `secret` and not `person`, for the reason src/entities/tier1.mjs gives for
 * having the kind at all: it exists "so the semantic pass can name a VALUE, not
 * only an identity". A date of birth, a postal address and an account handle
 * are values, not identities, and they are most of what leaked. It also keeps
 * them out of the single-word path in src/entities/probe.mjs, which proposes
 * bare words only from a `person` and would otherwise offer `Road`, `Crescent`
 * and `Bay` out of every declared address.
 *
 * A person who wants a better pseudonym writes {"kind": "person", "value": ...}
 * and gets one. Nothing else about the run changes.
 */
export const DEFAULT_KIND = 'secret';

/**
 * Read the declared values from the salt directory.
 *
 * Missing is the normal case: most people have no such file and get the two
 * inference tiers, exactly as before. Malformed REFUSES, the way loadUserDeny
 * refuses, and for a sharper version of the same reason: an export that
 * silently loaded none of this list is indistinguishable, in every check the
 * tool has, from the export that leaked. Degrading to an empty list here would
 * turn the one source that cannot miss into the one that misses silently.
 *
 * @returns {ReadonlyArray<{value: string, kind: string}>}
 */
export function loadKnownValues(saltDir) {
  const file = path.join(saltDir, KNOWN_VALUES_FILENAME);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return Object.freeze([]);
    throw new RefusalError(`could not read ${file}`, {
      why: [
        `${err.code}: ${err.message}`,
        'This file is the only list of your own values deident does not have to guess at.',
      ],
      remedies: [{ label: 'Fix or remove it', command: `edit ${file}` }],
    });
  }
  return parseKnownValues(text, file);
}

/** Validation, with no I/O in it. Same split as readVerdicts and parseVerdicts. */
export function parseKnownValues(text, source = KNOWN_VALUES_FILENAME) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RefusalError(`${source} is not valid JSON`, {
      why: [err.message, 'Refusing rather than exporting with none of the values you declared.'],
      remedies: [{ label: 'Fix it', command: `edit ${source}` }],
    });
  }

  // A bare array is the values, because that is the common case. Same
  // shorthand denied.json accepts, for the same reason.
  const raw = Array.isArray(parsed) ? parsed : parsed?.values;
  if (!Array.isArray(raw)) {
    throw new RefusalError(`${source} has no "values" array`, {
      why: [
        'Expected either a bare array of strings, or an object with a "values" array.',
        'Read as written it would declare nothing, and silence here is a leak.',
      ],
      remedies: [{ label: 'Fix it', command: `edit ${source}` }],
    });
  }

  const out = [];
  const seen = new Set();
  for (const [i, item] of raw.entries()) {
    const at = `${source} values[${i}]`;
    const isObject = item !== null && typeof item === 'object' && !Array.isArray(item);
    if (typeof item !== 'string' && !isObject) {
      throw badValue(at, 'is neither a string nor {"value": "...", "kind": "..."}', source);
    }

    const value = typeof item === 'string' ? item : item.value;
    if (typeof value !== 'string' || value.trim() === '') {
      // A blank declared value is not a harmless no-op: a spelling of
      // whitespace matches every space in the corpus, which is the condition
      // rejectReason names first. Refused here so the person sees the row they
      // typed, rather than a flagged entity in the export map three steps on.
      throw badValue(at, 'has no non-blank "value"', source);
    }

    const kind = (typeof item === 'string' ? undefined : item.kind) ?? DEFAULT_KIND;
    if (!KINDS.includes(kind)) {
      throw badValue(at, `has kind "${kind}"; expected one of ${KINDS.join(', ')}`, source);
    }

    // A repeated line is a typo in a hand-written file, not a decision worth
    // refusing over, and buildEntities would collapse it anyway.
    const key = JSON.stringify([kind, value.trim()]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze({ value: value.trim(), kind }));
  }
  return Object.freeze(out);
}

function badValue(at, problem, source) {
  return new RefusalError(`${at} ${problem}`, {
    why: [
      'deident will not guess what a malformed declaration was meant to mean.',
      'Loading half this list is worse than loading none, because every check',
      'would still pass over the values it dropped. Nothing was read.',
    ],
    remedies: [{ label: 'Fix the row', command: `edit ${source}` }],
  });
}

/**
 * The warning for a salt directory that silently has none of the list.
 *
 * The same trap missingDenyWarning exists for, on the file whose absence is the
 * more expensive one: `--salt-dir` at a fresh directory is the documented way
 * to run as if for the first time, this file lives IN the salt directory, and a
 * run that declares nothing passes every gate. Narrow for the same reason: a
 * machine with no list anywhere is a genuine first run and must not be nagged,
 * which is F7's cry-wolf failure arriving on every install.
 */
export function missingKnownValuesWarning(saltDir, defaultDir) {
  const found = missingFromSaltDir(saltDir, defaultDir, KNOWN_VALUES_FILENAME);
  if (found === null) return null;
  return (
    `${saltDir} has no ${KNOWN_VALUES_FILENAME}, so none of the values you declared as your own ` +
    `are loaded, while ${found.fallback} has some. They will be replaced only if a reader happens to ` +
    `spot them in the prose, and no check will say otherwise. ` +
    `Copy it first: cp "${found.fallback}" "${found.here}"`
  );
}
