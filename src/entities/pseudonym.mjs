// Salted-hash pseudonyms, and the namespace the pseudonyms live in.
//
// BRIEF §3: stable salted hash, NO plaintext map file, ever. A map is a
// portable re-identification key for data that has already left the machine;
// the raw logs are not. Reversal is done by regenerating the local entity list
// and hashing candidates — which is why the hash must be deterministic given
// (salt, kind, canonical).
//
// BRIEF §3 also fixes the salt as per-uploader, not shared: seven teammates
// uploading to one recipient who also holds the roster is a seven-way guess,
// and a shared salt means cracking one cracks all.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { RefusalError } from '../cli/errors.mjs';

/** The four families the pseudonym namespace uses. */
export const NAMESPACE_PREFIXES = Object.freeze([
  'PERSON',
  'WORKSPACE',
  'ORG',
  'CLIENT',
  'MACHINE',
  'SECRET',
  'PHONE',
]);

const KIND_TO_PREFIX = Object.freeze({
  person: 'PERSON',
  workspace: 'WORKSPACE',
  org: 'ORG',
  client: 'CLIENT',
  machine: 'MACHINE',
  secret: 'SECRET',
  phone: 'PHONE',
});

/** Pseudonym tokens, optionally namespace-shifted: `X_PERSON_1`. */
export function pseudonymPattern(namespace = null) {
  const prefix = namespace ? `${escapeRe(namespace)}_` : '';
  return new RegExp(`(?<![A-Za-z0-9_])${prefix}(?:${NAMESPACE_PREFIXES.join('|')})_\\d+(?![A-Za-z0-9_])`, 'gu');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exactly what randomBytes(32).toString('hex') produces, and nothing else.
const SALT_RE = /^[0-9a-f]{64}$/;

/** Say what the file holds without printing it: a salt is never printed. */
function describeSalt(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) return 'it is empty';
  const nul = String.fromCharCode(0);
  if (text.length > 0 && [...text].every((ch) => ch === nul)) return `${bytes} zero bytes`;
  return `${bytes} bytes, not 64 hex characters`;
}

export function defaultSaltDir(env) {
  return env.DEIDENT_SALT_DIR ?? path.join(os.homedir(), '.deident-private');
}

/**
 * Load the salt, creating it 0600 on first run.
 * PLAN §4.2: an unreadable or unwritable salt is a refusal, never a fallback
 * to an unsalted or in-memory value — that would make two exports
 * non-reversible against each other.
 */
export function loadOrCreateSalt(saltDir) {
  const file = path.join(saltDir, 'salt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    // Shape, not length. `String.prototype.trim` does not strip U+0000, so a
    // salt file of 64 NUL bytes — an interrupted write, filesystem corruption,
    // a file someone touched — passed a length check and produced pseudonyms
    // derived from an all-zero salt: predictable to anyone who guesses that,
    // which is the whole per-uploader salt decision in BRIEF §3 undone in
    // silence. deident writes exactly 64 lowercase hex characters, so anything
    // else was not written by deident.
    if (SALT_RE.test(existing)) return existing;
    throw new RefusalError(`the salt at ${file} is not a salt deident wrote`, {
      why: [
        'deident writes 64 hexadecimal characters. This file holds something else,',
        `so it is truncated, zeroed or from another tool (${describeSalt(existing)}).`,
        'Replacing it silently would break reversal against every earlier export;',
        'using it as-is could mean pseudonyms derived from an all-zero salt.',
      ],
      remedies: [{ label: 'Inspect, then remove it', command: `del "${file}"` }],
    });
  } catch (err) {
    if (err instanceof RefusalError) throw err;
    if (err.code !== 'ENOENT') {
      throw new RefusalError(`could not read the salt at ${file}`, {
        why: [
          `${err.code}: ${err.message}`,
          'deident will not fall back to an unsalted or in-memory pseudonym; that',
          'would make two exports non-reversible against each other.',
        ],
        remedies: [{ label: 'Fix permissions, or', command: 'deident export --salt-dir <path>' }],
      });
    }
  }

  const salt = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(saltDir, { recursive: true });
    fs.writeFileSync(file, `${salt}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw new RefusalError(`could not create the salt directory ${saltDir}`, {
      why: [
        `${err.code}: ${err.message}`,
        'deident will not fall back to an unsalted or in-memory pseudonym; that',
        'would make two exports non-reversible against each other.',
      ],
      remedies: [{ label: 'Choose a writable path', command: 'deident export --salt-dir <path>' }],
    });
  }
  return salt;
}

/**
 * Deterministic index for one entity. The salt never appears in the output;
 * only this derived integer does.
 */
export function pseudonymIndex(canonical, kind, salt) {
  // JSON-encoded rather than joined with a separator character: a separator is
  // ambiguous (kind "a" + canonical "bc" would hash the same as kind "ab" +
  // canonical "c" if the separator were ever lost), and an invisible separator
  // is exactly the kind of thing an editing round-trip mangles without anyone
  // noticing. This form has no separator to lose.
  const digest = createHash('sha256').update(JSON.stringify([salt, kind, canonical]), 'utf8').digest();
  // 24 bits keeps the printed token short while making an accidental collision
  // across a few dozen entities negligible; assignPseudonyms proves bijectivity
  // rather than assuming it (I9).
  return digest.readUInt32BE(0) & 0xffffff;
}

/**
 * Assign a pseudonym to every non-rejected entity.
 *
 * I9: the mapping must be bijective. A hash collision is resolved by walking
 * the index forward deterministically, so the result stays stable for a given
 * (salt, entity set) without ever silently merging two people.
 *
 * `opts.taken` threads the tokens an EARLIER pass already minted through this
 * one. Without it each call proved bijectivity over its own half: the pipeline
 * calls this twice, once for tier 0 and once for tier 1, and the merged table
 * silently kept the first entry per pseudonym — so two different people could
 * carry one token and no refusal fired. The index is 24 bits and sweepEmails
 * admits up to 5,000 addresses, each a `person`; 5,000 tier-0 persons against
 * ~50 tier-1 persons is order 1.5% per export, not one in sixteen million.
 *
 * @returns {Readonly<{entities: object[], namespace: string|null, taken: Set<string>}>}
 */
export function assignPseudonyms(entities, salt, namespace = null, opts = {}) {
  const taken = new Set(opts.taken ?? []);
  const out = [];

  // Sort by canonical so assignment order does not depend on discovery order:
  // idempotence (I10) requires the same input to produce the same tokens.
  const ordered = [...entities].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0,
  );

  for (const e of ordered) {
    if (e.rejected) {
      out.push(Object.freeze({ ...e, pseudonym: null }));
      continue;
    }
    const prefix = KIND_TO_PREFIX[e.kind] ?? 'CLIENT';
    let index = pseudonymIndex(e.canonical, e.kind, salt);
    let token = format(namespace, prefix, index);
    let guard = 0;
    while (taken.has(token)) {
      index = (index + 1) & 0xffffff;
      token = format(namespace, prefix, index);
      guard += 1;
      if (guard > 1000) {
        throw new RefusalError('could not assign a unique pseudonym', {
          why: ['The pseudonym space is exhausted, which should be impossible.', 'Nothing was written.'],
          remedies: [{ label: 'Report this', command: 'file an issue against deident' }],
        });
      }
    }
    taken.add(token);
    out.push(Object.freeze({ ...e, pseudonym: token }));
  }

  // I9 both directions, proved rather than assumed.
  const byPseudonym = new Map();
  const byCanonical = new Map();
  for (const e of out) {
    if (e.pseudonym === null) continue;
    if (byPseudonym.has(e.pseudonym)) {
      throw new RefusalError(`two entities share the pseudonym ${e.pseudonym}`, {
        why: ['The pseudonym mapping must be one-to-one or reversal is ambiguous.', 'Nothing was written.'],
        remedies: [{ label: 'Report this', command: 'file an issue against deident' }],
      });
    }
    byPseudonym.set(e.pseudonym, e);
    const key = JSON.stringify([e.kind, e.canonical]);
    if (byCanonical.has(key)) {
      throw new RefusalError(`entity ${e.canonical} was assigned two pseudonyms`, {
        why: ['The pseudonym mapping must be one-to-one or reversal is ambiguous.', 'Nothing was written.'],
        remedies: [{ label: 'Report this', command: 'file an issue against deident' }],
      });
    }
    byCanonical.set(key, e);
  }

  return Object.freeze({ entities: Object.freeze(out), namespace, taken });
}

function format(namespace, prefix, index) {
  const body = `${prefix}_${index}`;
  return namespace ? `${namespace}_${body}` : body;
}

/**
 * I3, and PLAN §2's ordering constraint: this must run BEFORE any pseudonym is
 * minted, not merely before the zip. Run it after minting and PERSON_3 has
 * already been assigned into a corpus that already contained PERSON_3, and
 * from that moment reversal is permanently ambiguous.
 *
 * PLAN C4: this fires on the real corpus today — 23 lines in the session where
 * deident itself is being built. The namespace-shift remedy is therefore part
 * of slice 1, not a deferred nicety.
 *
 * @param {Iterable<{file:string, line:number, text:string}>} lines
 */
export function namespaceCollisions(lines, namespace = null) {
  const pattern = pseudonymPattern(namespace);
  const hits = [];
  for (const { file, line, text } of lines) {
    pattern.lastIndex = 0;
    const m = pattern.exec(text);
    if (m) hits.push(Object.freeze({ file, line, token: m[0] }));
  }
  return Object.freeze(hits);
}

export function namespaceRefusal(hits, namespace, total = null) {
  const files = [...new Set(hits.map((h) => h.file))];
  const suggestion = namespace ? `${namespace}Z` : 'X';
  // `hits` is a bounded sample; `total` is how many lines actually matched.
  const count = total === null ? hits.length : total;
  return new RefusalError(
    `${count} input line${count === 1 ? ' already contains' : 's already contain'} a token in the pseudonym namespace`,
    {
      why: [
        `for example ${hits[0].token}, in ${files.length} file${files.length === 1 ? '' : 's'}`,
        '',
        'If deident minted its own tokens into a corpus that already contains',
        'tokens of the same shape, the residual scan could not tell the two apart',
        'and reversal would be permanently ambiguous. Shifting the namespace is free.',
      ],
      remedies: [{ label: 'Shift the namespace', command: `deident export --namespace ${suggestion}` }],
      detail: { hits: count, files: files.length },
    },
  );
}
