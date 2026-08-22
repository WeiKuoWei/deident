// The tier-1 (semantic) pass, implemented as a FILE CONTRACT, not an API
// client. The CLI makes no network calls, ever (BRIEF §2) — that property is
// the product.
//
// The contract, in both directions:
//
//   1. deident writes  deident-candidates.txt  — tier-0-CLEANED prose only.
//      PLAN §2: the input to discovery is the output of tier-0 substitution,
//      not the raw records. Handing raw text to a semantic pass would ship
//      unredacted paths, the username and emails into the discovery context —
//      a privacy tool leaking inside its own privacy step.
//
//   2. A host agent (or a human) reads it and writes  entities.json.
//
//   3. deident export --entities entities.json  applies it.
//
// If no entity list is supplied, the export is REFUSED (BRIEF §3, §F1).
// Graceful degradation here is silent failure.

import fs from 'node:fs';
import { RefusalError } from '../cli/errors.mjs';
import { expandVariants, looseVariants } from './variants.mjs';
import { rejectReason } from './seed.mjs';
import { CANDIDATE_EXCERPT_CHARS } from '../retain/constants.mjs';
import { residualScan, entityExamples } from '../verify/residual.mjs';

export const CANDIDATES_FILENAME = 'deident-candidates.txt';
export const ENTITIES_FILENAME = 'deident-entities.json';

// 'secret' is here so the semantic pass can name a VALUE, not only an identity.
// Reviewing the 2026-08-22 archive, most of what a reader had to remove was a
// balance, a rate, a meeting id or a sentence stating a figure — none of which
// is a person, an org or a machine. Without a kind for it the choice was to
// mislabel it or to drop the whole session, and dropping sessions is what
// took that archive from 35 to 17. It also makes the manifest's `secrets`
// row mean something, since that row counts this kind.
const VALID_KINDS = Object.freeze([
  'person', 'org', 'client', 'workspace', 'machine', 'secret', 'idnumber', 'account',
]);

const HEADER = `# deident tier-1 candidates
#
# Below is the PROSE from your sessions, after tier-0 substitution has already
# replaced your username, paths, git identity, git remotes and MCP server
# names. What remains is what a machine cannot find on its own: third-party
# names, client names, company names, and any other identity in the text.
#
# BRIEF §F2: third parties never consented. They are force-replaced with no
# opt-out. Only your own pseudonym is optional.
#
# Read this file and write ${ENTITIES_FILENAME} next to it:
#
#   {
#     "generated": "<ISO timestamp>",
#     "entities": [
#       {"kind": "person", "spellings": ["Ada Wang", "Ada"], "confidence": "high"},
#       {"kind": "org",    "spellings": ["Acme Advisory"],    "confidence": "high"}
#     ]
#   }
#
# kind is one of: ${VALID_KINDS.join(' | ')}
# confidence is "high" or "low". Low-confidence entities are listed
# individually in the review and never collapsed into a count (§F6).
#
# Then:  deident export --entities ${ENTITIES_FILENAME}
#
# ---------------------------------------------------------------------------
`;

/**
 * Write the candidates file. Prose only: tool output, harness bookkeeping and
 * code are excluded, because BRIEF §4.10 measured `text` at 2.30% of bytes and
 * feeding a semantic pass the other 97.7% is how it starts inventing entities
 * (§F7, arriving through the discovery pass instead of the residual pass).
 */
export function writeCandidates(proseChunks, outPath, opts = {}) {
  const seen = new Set();
  const parts = [HEADER];
  for (const chunk of proseChunks) {
    if (typeof chunk !== 'string') continue;
    const text = chunk.trim();
    if (text.length === 0) continue;
    const key = text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(text.length > CANDIDATE_EXCERPT_CHARS ? `${text.slice(0, CANDIDATE_EXCERPT_CHARS)}…` : text);
    parts.push('');
  }
  const prose = parts.slice(1).join(String.fromCharCode(10));
  const body = HEADER + prose;

  // The same gate the zip gets. This file's header states that the username,
  // paths, git identity, git remotes and MCP server names have already been
  // replaced, and it is the one artifact meant to be read by an LLM — so a
  // tier-0 entity surviving in it is the §F1 failure with the shortest route
  // off the machine.
  //
  // The PROSE is scanned, not the header. The header is deident's own text and
  // it names the tool: on the real corpus the tool's own name is a seeded
  // entity (the repo is `gitroll-dev/deident`), so scanning the header refused
  // every export over deident's own boilerplate — §F7's cry-wolf failure
  // arriving as a gate that can never go green.
  //
  // Only entity residue gates here. UUIDs are not rewritten until
  // serialization, so the cleaned prose still carries the real ones and an
  // I5-style check would report thousands of hits the zip does not contain.
  if (opts.table) {
    const scan = residualScan(prose, opts.table, new Set());
    if (scan.entityCount > 0) {
      throw new RefusalError(`${scan.entityCount} known-entity occurrences would be written to ${outPath}`, {
        why: [
          'The candidates file claims tier-0 substitution has already run over it.',
          'It has, and something survived anyway, so the claim in its header would',
          'be false. Nothing was written.',
          '',
          ...entityExamples(scan),
        ],
        remedies: [{ label: 'Report with the lines above', command: 'file an issue against deident' }],
      });
    }
  }

  try {
    fs.writeFileSync(outPath, body, 'utf8');
  } catch (err) {
    throw new RefusalError(`could not write the candidates file ${outPath}`, {
      why: [`${err.code}: ${err.message}`],
      remedies: [{ label: 'Choose a writable directory', command: 'deident export --out <path>' }],
    });
  }
  return { path: outPath, chars: Buffer.byteLength(body, 'utf8'), chunks: seen.size };
}

/**
 * Read and validate an entity list. Every failure names the file and the
 * problem; a malformed list must never silently become an empty list, because
 * an empty list passes I6 while delivering nothing.
 *
 * @returns {Readonly<{ran: true, source: string, entities: object[]}>}
 */
export function readEntities(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new RefusalError(`could not read the entity list ${filePath}`, {
      why: [
        `${err.code}: ${err.message}`,
        'The semantic pass is mandatory, so deident will not continue without it.',
      ],
      remedies: [{ label: 'Produce one first', command: 'deident export --preview' }],
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RefusalError(`${filePath} is not valid JSON`, {
      why: [err.message, 'A malformed entity list must not silently become an empty one.'],
      remedies: [{ label: 'Fix the file', command: `notepad "${filePath}"` }],
    });
  }

  const raw = Array.isArray(parsed) ? parsed : parsed?.entities;
  if (!Array.isArray(raw)) {
    throw new RefusalError(`${filePath} has no "entities" array`, {
      why: ['Expected either a bare array, or an object with an "entities" array.'],
      remedies: [{ label: 'Fix the file', command: `notepad "${filePath}"` }],
    });
  }

  const entities = [];
  const counters = new Map();
  for (const [i, item] of raw.entries()) {
    const at = `${filePath} entities[${i}]`;
    if (item === null || typeof item !== 'object') throw badEntity(at, 'is not an object');

    const kind = item.kind ?? 'person';
    if (!VALID_KINDS.includes(kind)) {
      throw badEntity(at, `has kind "${kind}"; expected one of ${VALID_KINDS.join(', ')}`);
    }

    const spellings = Array.isArray(item.spellings)
      ? item.spellings
      : typeof item.spelling === 'string'
        ? [item.spelling]
        : null;
    if (spellings === null || spellings.length === 0) throw badEntity(at, 'has no spellings');
    for (const s of spellings) {
      if (typeof s !== 'string' || s.length === 0) throw badEntity(at, 'has a non-string spelling');
      // A whitespace-only spelling passed both the non-string test and the
      // empty test, and three spaces are three characters, so rejectReason let
      // it through as well. It substitutes every run of three spaces.
      if (s.trim().length === 0) throw badEntity(at, 'has a blank spelling');
    }

    const canonical = spellings[0];
    const rejected = rejectReason(canonical);
    const nextIndex = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, nextIndex);

    entities.push(
      Object.freeze({
        id: `T1_${kind.toUpperCase()}_${String(nextIndex).padStart(2, '0')}`,
        kind,
        canonical,
        spellings: rejected
          ? Object.freeze([])
          : Object.freeze([...new Set(spellings.flatMap((s) => expandVariants(s)))].sort(
              (a, b) => b.length - a.length || (a < b ? -1 : 1),
            )),
        looseSpellings: rejected
          ? Object.freeze([])
          : Object.freeze([...new Set(spellings.flatMap((v) => looseVariants(v)))]),
        sources: Object.freeze(['semantic pass']),
        source: 'semantic pass',
        // §F6: low confidence stays low, and is never merged into a count.
        confidence: item.confidence === 'high' ? 'high' : 'low',
        tier: 1,
        rejected,
      }),
    );
  }

  return Object.freeze({
    ran: true,
    source: `--entities ${filePath}`,
    generated: typeof parsed?.generated === 'string' ? parsed.generated : null,
    entities: Object.freeze(entities),
  });
}

function badEntity(at, problem) {
  return new RefusalError(`${at} ${problem}`, {
    why: [
      'deident will not guess what a malformed entity was meant to mean.',
      'Applying half a list is worse than applying none, because the report would',
      'claim the pass ran.',
    ],
    remedies: [{ label: 'Fix the entry', command: 'see the schema in deident-candidates.txt' }],
  });
}
