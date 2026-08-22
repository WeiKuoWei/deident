// Which workspaces may be exported at all.
//
// BRIEF §4.11: per-directory opt-in, never opt-out, plus a seed deny-list.
// The measured hazard is concrete: a personal couples-counselling archive
// (`private-archive`, 42 MB) sits in the same directory as work sessions, and any
// "export recent sessions" default sweeps it in.
//
// Slice 1 implements the hook the four privacy tiers plug into
// (docs/privacy-tiers.md is slice 2) and may treat every included workspace
// as `redact` (BRIEF §7).

import fs from 'node:fs';
import path from 'node:path';
import { RefusalError } from '../cli/errors.mjs';

export const TIERS = Object.freeze(['exclude', 'count-only', 'redact', 'open']);

/** BRIEF §4.11 seed deny-list. Matched case-insensitively as a substring. */
export const DENY_TOKENS = Object.freeze(['private', 'identity', 'payroll', 'redacted-name']);

export const UNCLASSIFIED = 'unclassified';

/** The first deny token this text contains, or null. */
export function matchDenyToken(text) {
  if (typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  for (const token of DENY_TOKENS) {
    if (lower.includes(token)) return token;
  }
  return null;
}

/**
 * Assign a tier to every workspace.
 *
 * Precedence, highest first:
 *   1. deny-list match  -> exclude, unless the exact name is in includeDenied
 *   2. a saved decision -> that tier
 *   3. the signal proposal (privacy-tiers §3)
 *
 * A saved decision never overrides the deny-list without the typed
 * confirmation, so editing review.md cannot quietly re-enable `private-archive`.
 *
 * `unclassified` is what is left when no signal could be read at all. It is
 * the residue, not the default: a default of unclassified means every row is
 * a question, and a person facing 29 questions answers none of them.
 *
 * @param {ReadonlyArray<object>} groups from groupSessions()
 */
export function classifyWorkspaces(groups, saved = {}, opts = {}) {
  const includeDenied = new Set(opts.includeDenied ?? []);
  const propose = opts.propose ?? (() => Object.freeze({ tier: UNCLASSIFIED, reason: 'no signals were read' }));
  const decisions = [];

  for (const ws of groups) {
    const denyToken = ws.denyToken ?? null;
    const proposal = propose(ws);
    let tier;
    let note;

    if (denyToken !== null && !includeDenied.has(ws.name)) {
      tier = 'exclude';
      note = `deny-list matched: "${denyToken}"`;
    } else if (Object.hasOwn(saved, ws.name) && TIERS.includes(saved[ws.name])) {
      tier = saved[ws.name];
      note = denyToken !== null ? `deny-list "${denyToken}" overridden by --include-denied` : ws.cwd;
    } else {
      tier = denyToken !== null ? 'redact' : proposal.tier;
      note = denyToken !== null ? `deny-list "${denyToken}" overridden by --include-denied` : proposal.reason;
    }

    decisions.push(
      Object.freeze({
        key: ws.key,
        name: ws.name,
        cwd: ws.cwd,
        normCwd: ws.normCwd,
        sessionCount: ws.sessionCount,
        bytes: ws.bytes,
        tier,
        note,
        denyToken,
        proposed: proposal.tier,
      }),
    );
  }

  return Object.freeze(decisions);
}

/** Summary rows for the scan census, in a fixed tier order. */
export function summarizeTiers(decisions) {
  const order = [...TIERS, UNCLASSIFIED];
  const rows = [];
  for (const tier of order) {
    const members = decisions.filter((d) => d.tier === tier);
    if (members.length === 0) continue;
    const denied = members.filter((d) => d.denyToken !== null && d.tier === 'exclude').length;
    rows.push(
      Object.freeze({
        tier,
        workspaces: members.length,
        sessions: members.reduce((a, d) => a + d.sessionCount, 0),
        note:
          tier === 'exclude' && denied > 0
            ? `${denied} matched the deny-list`
            : tier === UNCLASSIFIED
              ? 'excluded until you decide'
              : null,
      }),
    );
  }
  return Object.freeze(rows);
}

/** Refusal for unclassified workspaces. cli-ux §8, second example. */
export function unclassifiedRefusal(decisions) {
  const pending = decisions.filter((d) => d.tier === UNCLASSIFIED && d.sessionCount > 0);
  if (pending.length === 0) return null;
  return new RefusalError(
    `${pending.length} workspace${pending.length === 1 ? ' is' : 's are'} unclassified`,
    {
      why: [
        ...pending.map((d) => `  ${d.name}      ${d.sessionCount} sessions`),
        '',
        'New workspaces are excluded by default and never exported silently.',
        'Set a tier for each in review.md, or confirm you want them left out.',
      ],
      remedies: [
        { label: 'Decide in review.md', command: 'deident scan   # then edit review.md' },
        { label: 'Or confirm exclusion', command: 'deident export --skip-unclassified' },
      ],
    },
  );
}

// ------------------------------------------------------------ persistence

export function savedDecisionsPath(saltDir) {
  return path.join(saltDir, 'workspaces.json');
}

/** Missing or corrupt file yields {} — a lost decision re-asks, never guesses. */
export function loadSavedDecisions(saltDir) {
  const file = savedDecisionsPath(saltDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return Object.freeze({});
    throw new RefusalError(`could not read saved workspace decisions at ${file}`, {
      why: [`${err.code}: ${err.message}`, 'deident will not guess tiers it cannot read.'],
      remedies: [{ label: 'Fix or remove the file', command: `del "${file}"` }],
    });
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.freeze({});
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && TIERS.includes(v)) clean[k] = v;
    }
    return Object.freeze(clean);
  } catch {
    return Object.freeze({});
  }
}

export function saveDecisions(saltDir, decisions) {
  const file = savedDecisionsPath(saltDir);
  const map = {};
  for (const d of decisions) {
    if (d.tier !== UNCLASSIFIED) map[d.name] = d.tier;
  }
  fs.mkdirSync(saltDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * Workspaces whose sessions are actually exported, keyed by workspace key.
 * `open` and `redact` both export content in slice 1 (BRIEF §7).
 */
export function exportableTiers(decisions) {
  const map = new Map();
  for (const d of decisions) {
    if (d.tier === 'redact' || d.tier === 'open') map.set(d.key, d.tier);
  }
  return map;
}

/**
 * The per-line gate's lookup table: every workspace's real cwd with its tier,
 * longest path first so the most specific workspace wins.
 *
 * Longest-first is the whole point. The home directory is excluded and is a
 * prefix of every other workspace on the machine, so a plain "is this inside
 * an excluded directory" test would drop every line of every session. What
 * the gate must ask is which workspace this line is in, and then that
 * workspace's tier.
 */
export function cwdTierIndex(decisions) {
  return Object.freeze(
    decisions
      .filter((d) => typeof d.normCwd === 'string' && d.normCwd !== '')
      .map((d) => Object.freeze({ prefix: d.normCwd, tier: d.tier, name: d.name }))
      .sort((a, b) => b.prefix.length - a.prefix.length),
  );
}
