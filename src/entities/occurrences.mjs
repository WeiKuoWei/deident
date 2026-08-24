// The drill-down index: every occurrence the substituter actually replaced,
// with the session it was in.
//
// cli-ux §5: "A count nobody can drill into is a count nobody believes." The
// export reports a spelling replaced N times and offers ONE excerpt for it, so
// the owner's real question (are those N a person's name or an ordinary word)
// has no answer on this machine. Measured 2026-08-24 on the live corpus, that
// is not hypothetical: an ordinary noun meaning "meeting" counted 202 and had
// to fail, a brokerage counted 255 and had to pass, and no threshold separates
// them. Only the occurrences do.
//
// Built by the sweep that was already running. probeCounts walks every retained
// string with the shipped matcher to produce those counts; this file is the
// sink it calls per occurrence, so §5 costs no extra pass over the corpus and
// cannot disagree with the number it is drilling into.
//
// DANGEROUS, and more so than anything else deident writes. It pairs a
// pseudonym with the real spelling it replaced and with the real session id, so
// it is the one artifact on the machine that re-identifies the archive.
// entities.json and export-map.txt each hold half of that; this holds both.
// It gets the same handling as the dictionary and F151 asserts all three
// places it must not be: never an archive entry, never the output directory,
// never the repository.

import fs from 'node:fs';
import path from 'node:path';
import { RefusalError, osErrorLine } from '../cli/errors.mjs';

export const OCCURRENCE_FILENAME = 'occurrences.json';

export function occurrencePath(saltDir) {
  return path.join(saltDir, OCCURRENCE_FILENAME);
}

/** Characters of context kept either side of each occurrence. */
const EXCERPT_CONTEXT = 40;

/**
 * Occurrences recorded for one pseudonym before the rest are counted only.
 *
 * Not a tidiness limit. Measured on the live corpus (cli-ux §6): file paths
 * were replaced 26,505 times across a handful of spellings, so an uncapped
 * index writes tens of megabytes of excerpts nobody will read, for the one
 * entity class whose identity was never in doubt. The cap sits above the
 * counts a person actually drills into (§5's worked example is 991), and the
 * file records the true total beside the rows, so a truncated answer says it
 * is truncated rather than under-reporting the count.
 */
const MAX_PER_PSEUDONYM = 2000;

const NOTE = [
  'Every occurrence deident replaced, and the session it was in, so you can check',
  'that a spelling replaced N times really is an identity. Read it with:',
  'deident review --entity <TOKEN>. This file pairs pseudonyms with the real',
  'spellings AND the real session ids, which makes it the one thing on this machine',
  'that can re-identify the archive. It is local only. Never share it, never commit',
  'it, and never put it in the output directory beside the zip.',
].join(' ');

/**
 * A collector for probeCounts' `sink`.
 *
 * The cap is checked BEFORE the excerpt is sliced, because the spellings that
 * blow past it are the ones with tens of thousands of hits and slicing a string
 * per hit is the whole cost.
 */
export function newOccurrenceIndex() {
  const byPseudonym = new Map();
  return {
    sink(entry, at, s, from, to) {
      let rec = byPseudonym.get(entry.pseudonym);
      if (rec === undefined) {
        rec = { pseudonym: entry.pseudonym, kind: entry.kind, spellings: [], total: 0, occurrences: [] };
        byPseudonym.set(entry.pseudonym, rec);
      }
      rec.total += 1;
      if (!rec.spellings.includes(entry.spelling)) rec.spellings.push(entry.spelling);
      if (rec.occurrences.length >= MAX_PER_PSEUDONYM) return;
      rec.occurrences.push({
        session: at.session,
        workspace: at.workspace,
        date: at.date,
        turn: at.turn,
        excerpt: s
          .slice(Math.max(0, from - EXCERPT_CONTEXT), Math.min(s.length, to + EXCERPT_CONTEXT))
          .replace(/\s+/g, ' '),
      });
    },
    /** Highest count first, the order renderProbe already puts in front of a reader. */
    rows() {
      return [...byPseudonym.values()].sort((a, b) => b.total - a.total || (a.pseudonym < b.pseudonym ? -1 : 1));
    },
  };
}

/**
 * Write the index beside the salt.
 *
 * A warning rather than a refusal on failure, for the reason writeExportMap
 * gives: the archive is already on disk and valid, so losing this costs a
 * re-run of a query, not an export.
 */
export function writeOccurrences(file, doc, onWarning) {
  try {
    fs.writeFileSync(file, `${JSON.stringify({ _note: NOTE, ...doc }, null, 1)}\n`, 'utf8');
  } catch (err) {
    onWarning(`could not write ${file} (${osErrorLine(err)}), so "deident review --entity" has nothing to read`);
  }
}

/**
 * Read the index, or refuse naming the command that builds one.
 *
 * Missing is not an empty result. The counts in here are what the substituter
 * DID, so no read-only pass over the corpus can produce them, and answering
 * `--entity` with "0 occurrences" when the truth is "nobody has asked yet"
 * tells the reader their entity is clean. cli-ux §5 refuses the unimplemented
 * flag for the same reason.
 */
export function readOccurrences(saltDir, query) {
  const file = occurrencePath(saltDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new RefusalError(`could not read ${file}`, {
        why: [osErrorLine(err), `It is what ${query} reads, and deident will not guess at its contents.`],
        remedies: [{ label: 'Remove it and export again', command: `deident export --out <path>` }],
      });
    }
    throw new RefusalError(`nothing to drill into yet, so ${query} cannot be answered`, {
      why: [
        `No export has finished on this machine, so ${file} does not exist.`,
        'These counts are what the substituter actually replaced, not what a search would find,',
        'so they exist only once an export has run. scan and review write nothing that could produce them.',
      ],
      remedies: [{ label: 'Export first, then ask again', command: 'deident export --out <path>' }],
    });
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new RefusalError(`${file} is not valid JSON`, {
      why: [err.message, 'It is written by deident, so a hand edit or a half-written file is the likely cause.'],
      remedies: [{ label: 'Remove it and export again', command: `deident export --out <path>` }],
    });
  }
}
