// The retention vocabulary, as versioned DATA rather than four literals.
//
// Why this exists. Every Claude Code release that adds a record type makes
// every user's export refuse until deident ships a new version carrying the
// decision. Measured 2026-08-27 on one 261-session corpus: twelve types with
// no decision, all of them shipped between 2026-06 and 2026-08. The refusal
// is correct -- a silent drop is how the best user turns disappear -- but the
// remedy should not require a release.
//
// Three properties, in priority order:
//
//   1. FAIL-CLOSED IS UNCHANGED. A name that appears in no schema file and no
//      local overlay is still refused, never guessed. Nothing here widens what
//      deident will accept on its own; it only changes who can record a
//      decision and how fast.
//   2. VERSIONS UNION, they do not supersede. Logs are historical: a corpus
//      written last quarter still contains the types that existed then. A
//      loader that took only the newest file would start refusing records it
//      used to handle. Two files disagreeing about the same name is a
//      contradiction and refuses at load, rather than letting file order pick
//      a winner.
//   3. AGENTS ARE SEPARATE. schemas/<agent>/ keeps one vocabulary per tool, so
//      adding Codex or Cursor is a directory plus a reader, not a rewrite.
//      src/corpus/root.mjs notes they "write a different layout and are not
//      read yet"; this is the half of that work that does not need their
//      layout to be understood first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RefusalError } from '../cli/errors.mjs';

const SHIPPED_ROOT = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'schemas');

/** Decisions deident actually acts on. Anything else is a typo, not a policy. */
const RECORD_DECISIONS = Object.freeze(['keep', 'drop', 'drop-after-use']);
const SIMPLE_DECISIONS = Object.freeze(['keep', 'drop']);
const BLOCK_DECISIONS_ALLOWED = Object.freeze(['keep', 'drop', 'drop-counted', 'shape-only']);

const SECTIONS = Object.freeze([
  ['recordTypes', RECORD_DECISIONS],
  ['attachmentTypes', SIMPLE_DECISIONS],
  ['systemSubtypes', SIMPLE_DECISIONS],
  ['contentBlocks', BLOCK_DECISIONS_ALLOWED],
]);

function badSchema(file, problem) {
  return new RefusalError(`the schema at ${file} ${problem}`, {
    why: [
      'A retention vocabulary deident cannot trust is not one it will export against.',
      'Nothing was written.',
    ],
    remedies: [{ label: 'Fix the file above, or report it', command: 'file an issue against deident' }],
  });
}

function readOne(file) {
  let doc;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) { throw badSchema(file, `could not be read: ${err.code}`); }
  try { doc = JSON.parse(text); }
  catch (err) { throw badSchema(file, `is not valid JSON: ${err.message}`); }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw badSchema(file, 'is not an object');
  }
  for (const [section, allowed] of SECTIONS) {
    const v = doc[section];
    if (v === undefined) continue;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw badSchema(file, `has a "${section}" that is not an object`);
    }
    for (const [name, decision] of Object.entries(v)) {
      if (!allowed.includes(decision)) {
        throw badSchema(file, `gives ${section}.${name} the decision ${JSON.stringify(decision)}, which deident does not act on`);
      }
    }
  }
  return doc;
}

function listSchemaFiles(agent, root) {
  const dir = path.join(root, agent);
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return []; }
  // Sorted so a contradiction reports the same pair of files every run, which
  // makes the refusal reproducible rather than dependent on directory order.
  return names.filter((n) => n.endsWith('.json')).sort().map((n) => path.join(dir, n));
}

/**
 * Load one agent's vocabulary: every version file unioned, then any local
 * overlay the operator wrote beside their salt.
 *
 * The overlay is how a user unblocks themselves the day a new Claude Code
 * release lands, without waiting for deident to cut a version. It is still an
 * explicit, recorded decision per name -- it cannot say "accept anything".
 */
export function loadSchema(agent = 'claude-code', overlayPath = null, root = SHIPPED_ROOT) {
  const files = listSchemaFiles(agent, root);
  if (files.length === 0) {
    throw new RefusalError(`no retention schema for ${agent}`, {
      why: [
        `Nothing under schemas/${agent}/ describes what to keep, so every record would be unknown.`,
        'Nothing was written.',
      ],
      remedies: [{ label: 'Report this', command: 'file an issue against deident' }],
    });
  }

  const merged = { recordTypes: {}, attachmentTypes: {}, systemSubtypes: {}, contentBlocks: {} };
  const origin = new Map();
  const sources = [];

  const absorb = (doc, file, isOverlay) => {
    sources.push({ file, version: doc.version ?? null, overlay: isOverlay });
    for (const [section] of SECTIONS) {
      for (const [name, decision] of Object.entries(doc[section] ?? {})) {
        const key = `${section}.${name}`;
        const prior = origin.get(key);
        // An overlay is allowed to be the FIRST decision for a name, never a
        // second one: silently overriding a shipped decision from a file
        // outside the repo is how an export starts keeping something a
        // reviewer had decided to drop.
        if (prior !== undefined && merged[section][name] !== decision) {
          throw badSchema(file, `says ${key} is ${JSON.stringify(decision)} but ${prior} already says ${JSON.stringify(merged[section][name])}`);
        }
        if (prior === undefined) {
          merged[section][name] = decision;
          origin.set(key, file);
        }
      }
    }
  };

  for (const f of files) absorb(readOne(f), f, false);
  if (overlayPath !== null && fs.existsSync(overlayPath)) absorb(readOne(overlayPath), overlayPath, true);

  return Object.freeze({
    agent,
    sources: Object.freeze(sources),
    recordTypes: Object.freeze(merged.recordTypes),
    attachmentTypes: Object.freeze(merged.attachmentTypes),
    systemSubtypes: Object.freeze(merged.systemSubtypes),
    contentBlocks: Object.freeze(merged.contentBlocks),
  });
}

/** Agents that have a vocabulary on disk. */
export function knownAgents(root = SHIPPED_ROOT) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && listSchemaFiles(d.name, root).length > 0)
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

/**
 * Where an operator may record a decision for a type deident has not shipped
 * one for yet. Beside the salt, because that directory is already the private,
 * per-machine, never-committed one.
 *
 * This is the whole point of the extraction: the day a new Claude Code release
 * adds a record type, the person holding the logs can decide it and export,
 * instead of waiting for a deident release. It cannot say "accept anything" --
 * it records an explicit decision per name, exactly like a shipped file, and
 * it may only be the FIRST decision for a name, never an override of one.
 */
export function schemaOverlayPath(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? null;
  if (typeof home !== 'string' || home.trim().length === 0) return null;
  return path.join(home, '.deident-private', 'schema-overlay.json');
}
