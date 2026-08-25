// The tier-1 (semantic) pass, implemented as a FILE CONTRACT, not an API
// client. The CLI makes no network calls, ever (BRIEF §2), that property is
// the product.
//
// The contract, in both directions:
//
//   1. deident writes  deident-candidates.txt , tier-0-CLEANED prose only.
//      PLAN §2: the input to discovery is the output of tier-0 substitution,
//      not the raw records. Handing raw text to a semantic pass would ship
//      unredacted paths, the username and emails into the discovery context,
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
import { residualScan, entityExamples } from '../verify/residual.mjs';
import { CANDIDATE_CHUNK_CHARS } from '../retain/constants.mjs';
import { estimateTokens } from '../cli/tokens.mjs';

export const CANDIDATES_FILENAME = 'deident-candidates.txt';
export const ENTITIES_FILENAME = 'deident-entities.json';

// 'secret' is here so the semantic pass can name a VALUE, not only an identity.
// Reviewing the 2026-08-22 archive, most of what a reader had to remove was a
// balance, a rate, a meeting id or a sentence stating a figure, none of which
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
# EVERY UUID BELOW IS ALREADY A PSEUDONYM. Session and message ids were
# replaced with values deident minted, so a UUID here identifies nothing and
# must NOT be declared. Measured 2026-08-24: two readers of this file saw one
# recur 49 times, reasonably called it a secret, and the export then refused
# because deident's own output "survived" its own entity table.
#
# Read this file and write ${ENTITIES_FILENAME} next to it:
#
#   {
#     "generated": "<ISO timestamp>",
#     "entities": [
#       {"kind": "person", "spellings": ["Nora Lund", "Nora"], "confidence": "high"},
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
`;

/**
 * The one rule in this file that depends on who the archive is for.
 *
 * The operator contract used to carry it as a conditional in prose ("the user's
 * own employer and its product vocabulary, WHEN THE RECIPIENT WORKS THERE
 * TOO"), which reached the reader only if the operator had loaded the skill and
 * remembered the clause. This file is what the reader actually has in front of
 * them and the run already knows the answer, so the run states it.
 *
 * It states the RULE and never the employer's name. Tier-0 substitution has
 * already taken the git remote out of this prose, and this is the one artifact
 * meant to be handed to a model: naming the company in the header would put a
 * plaintext identity in the file whose header claims there is none.
 */
function audienceRule(audience) {
  const lines = audience === 'public'
    ? [
        '# DECLARED AUDIENCE: public. Your own employer IS an identity here.',
        '# Declare its written-out name, its products and its internal service names',
        '# alongside the third-party ones. A reader who does not work there learns',
        '# where you work, and what it sells, from those words alone.',
      ]
    : [
        `# DECLARED AUDIENCE: ${audience}. Your own employer is NOT an identity here.`,
        '# Leave its name, its products and its internal service names out of the',
        '# list: the reader uses those words daily, so replacing them wrecks the prose',
        '# and hides nothing. Everyone else still goes in, clients included.',
      ];
  return `${lines.join(String.fromCharCode(10))}
#
# ---------------------------------------------------------------------------
`;
}

/**
 * Write the candidates file. Prose only: tool output, harness bookkeeping and
 * code are excluded, because BRIEF §4.10 measured `text` at 2.30% of bytes and
 * feeding a semantic pass the other 97.7% is how it starts inventing entities
 * (§F7, arriving through the discovery pass instead of the residual pass).
 */
export function writeCandidates(proseChunks, outPath, opts = {}) {
  const seen = new Set();
  // Sessions deident remembers you having read, and therefore did not put in
  // front of you again.
  const omitted = opts.omitted ?? 0;
  // Sessions deferred to a later run because this file hit its budget. A
  // different fact from `omitted` above and it needs its own sentence: those
  // were left out because they are already read, these because the reader
  // cannot read everything at once, and only these come back.
  const deferred = opts.deferred ?? 0;
  // Characters the cap below took off the end of a chunk. Counted, because the
  // old cap was not: the reader could not tell a short file from a short
  // corpus, and the pipeline recorded the session as read either way.
  let omittedChars = 0;
  const parts = [];
  for (const chunk of proseChunks) {
    if (typeof chunk !== 'string') continue;
    const text = chunk.trim();
    if (text.length === 0) continue;
    // Dedupe on the EXACT text, not on a prefix of it.
    //
    // The key used to be a chunk's first 80 characters and `seen` is global
    // across sessions, so a chunk that merely OPENED like an earlier one was
    // discarded in full. Measured over a copy of the real corpus (216 depth-0
    // files, 87,797 prose chunks, pre-filter): 1,590 chunks, 10,443,749
    // characters, dropped by that key while not being byte-identical to the
    // chunk that claimed it. Session prose opens the same way constantly (a
    // pasted error, a repeated instruction, the same command re-run), and the
    // names are in what comes after.
    //
    // An exact duplicate is still dropped, and that one is safe: the reader
    // has been shown those bytes, so the session recorded as read really was.
    if (seen.has(text)) continue;
    seen.add(text);
    // The cap, and the thing the old cap did not do: count what it took.
    // The old value was 400 characters and it dropped 76.2% of the prose,
    // 5,904 chunks (6.7%) exceeding it, longest chunk 938,529 characters. None
    // of it was counted, printed, or knowable to the reader who was then asked
    // to declare the names in it. CANDIDATE_CHUNK_CHARS states what the
    // current value is measured against.
    if (text.length > CANDIDATE_CHUNK_CHARS) {
      omittedChars += text.length - CANDIDATE_CHUNK_CHARS;
      parts.push(`${text.slice(0, CANDIDATE_CHUNK_CHARS)}…`);
    } else {
      parts.push(text);
    }
    parts.push('');
  }
  const prose = parts.join(String.fromCharCode(10));

  // Both notes are in the FILE and not only in the terminal, because the file
  // is what gets handed to a reader and a short one has to say why it is
  // short. The sessions figure is measured 2026-08-24 on the live corpus: the
  // first read is 205 sessions and 915 KB, and a second read days later is the
  // handful that changed.
  const NEWLINE = String.fromCharCode(10);
  const note =
    (deferred > 0
      ? [
          `# This is one batch. ${deferred} more session${deferred === 1 ? ' is' : 's are'} not in this file and are NOT`,
          '# recorded as read. Only what is in THIS file is remembered, so read all of',
          '# it: supply your list and run the export again, and the next batch arrives.',
          '# To change how much arrives at once:  deident export --batch-chars <n>',
          '#',
          '',
        ].join(NEWLINE)
      : '') +
    (omitted > 0
      ? [
          `# ${omitted} more session${omitted === 1 ? ' is' : 's are'} not in this file. Their content has not changed`,
          '# since you last read them, and deident remembers what you declared then.',
          '# To read the whole corpus again:  deident export --full',
          '#',
          '',
        ].join(NEWLINE)
      : '') +
    (omittedChars > 0
      ? [
          `# ${omittedChars.toLocaleString('en-US')} characters of prose were not shown: ${CANDIDATE_CHUNK_CHARS.toLocaleString('en-US')} characters`,
          '# is the most of any one chunk that goes in this file, and some chunk ran',
          '# past it. What was cut is the END of a long chunk, so a name only in the',
          '# tail of one cannot be declared from this file.',
          '#',
          '',
        ].join(NEWLINE)
      : '');
  const body = HEADER + audienceRule(opts.audience ?? 'public') + note + prose;

  // The same gate the zip gets. This file's header states that the username,
  // paths, git identity, git remotes and MCP server names have already been
  // replaced, and it is the one artifact meant to be read by an LLM, so a
  // tier-0 entity surviving in it is the §F1 failure with the shortest route
  // off the machine.
  //
  // The PROSE is scanned, not the header. The header is deident's own text and
  // it names the tool: on the real corpus the tool's own name is a seeded
  // entity (the repo is `northwind-co/deident`), so scanning the header refused
  // every export over deident's own boilerplate, §F7's cry-wolf failure
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
  // Measured over the WHOLE file, header included: the header is 30-odd lines
  // of instructions the reader has to read to know what the file is for, and
  // an estimate that quietly excluded them would understate a small batch by a
  // visible margin.
  return {
    path: outPath,
    chars: Buffer.byteLength(body, 'utf8'),
    chunks: seen.size,
    omittedChars,
    estimate: estimateTokens(body),
  };
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
      remedies: [{ label: 'Fix the file', command: `edit ${filePath}` }],
    });
  }

  const raw = Array.isArray(parsed) ? parsed : parsed?.entities;
  if (!Array.isArray(raw)) {
    throw new RefusalError(`${filePath} has no "entities" array`, {
      why: ['Expected either a bare array, or an object with an "entities" array.'],
      remedies: [{ label: 'Fix the file', command: `edit ${filePath}` }],
    });
  }

  return buildEntityList(raw, {
    at: filePath,
    source: `--entities ${filePath}`,
    generated: typeof parsed?.generated === 'string' ? parsed.generated : null,
  });
}

/**
 * Validate and normalise a declared entity list, whatever supplied it.
 *
 * Shared by `--entities` and by the remembered dictionary, so a list that a
 * previous run accepted is held to the same rules when it comes back, and so
 * there is one place that decides what a valid entity is. A second copy of
 * these checks is how a dictionary entry that no reader would be allowed to
 * type gets applied anyway.
 *
 * @param {ReadonlyArray<object>} raw
 * @param {{at: string, source: string, generated?: string|null}} opts
 *   `at` is what a refusal names, so it is a file path for a file and a
 *   description for anything else.
 */
export function buildEntityList(raw, { at: source_at, source, generated = null }) {
  const filePath = source_at;
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
        // The spellings as the person TYPED them, kept beside the expanded
        // ones. The dictionary remembers this array, not the expansion:
        // expandVariants is deterministic and re-derived on every read, so
        // storing its output would bloat a file somebody edits by hand and
        // show them backslash-doubled twins of strings they never wrote.
        declared: Object.freeze([...spellings]),
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
    source,
    generated,
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
