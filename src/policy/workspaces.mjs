// Which workspaces may be exported at all.
//
// BRIEF §4.11: per-directory opt-in, never opt-out, plus a seed deny-list.
// The measured hazard is concrete: a 42 MB archive of one person's private
// messages sat in the same directory as work sessions, and any "export
// recent sessions" default sweeps it in. It also had a git remote, so the
// remote signal alone would have proposed it for export.
//
// Slice 1 implements the hook the four privacy tiers plug into
// (docs/privacy-tiers.md is slice 2) and may treat every included workspace
// as `redact` (BRIEF §7).

import fs from 'node:fs';
import path from 'node:path';
import { RefusalError } from '../cli/errors.mjs';
import { userDenyTokens } from './userdeny.mjs';

export const TIERS = Object.freeze(['exclude', 'count-only', 'redact', 'open']);

/**
 * BRIEF §4.11 seed deny-list. Matched case-insensitively as a substring.
 *
 * Only words that are true of anyone. A token naming one person's directory
 * belongs in the per-person file beside the salt, not in a shared repository.
 */
export const DENY_TOKENS = Object.freeze(['private', 'identity', 'payroll']);

export const UNCLASSIFIED = 'unclassified';

/**
 * macOS resolves /tmp, /var and /etc into /private, and process.cwd() returns
 * the physical path. So a Mac session started from /tmp records a cwd of
 * /private/var/folders/..., and a substring test reads the symlink root as the
 * word the person meant. That force-excluded the workspace, dropped its lines,
 * and told them `deny-list matched: "private"` about a directory they never
 * called that.
 *
 * Only these three roots, and only as the leading segment. `/private/notes` is
 * still a private directory; so is anything called private further down.
 */
const MACOS_PRIVATE_ROOT = /^[/\\]private(?=[/\\](var|tmp|etc)(?=[/\\]|$))/i;

/** The first deny token this text contains, or null. */
export function matchDenyToken(text) {
  if (typeof text !== 'string') return null;
  const lower = text.replace(MACOS_PRIVATE_ROOT, '').toLowerCase();
  for (const token of [...DENY_TOKENS, ...userDenyTokens()]) {
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

  // A decision is keyed by the workspace's normalised cwd, not by its display
  // label. The label is derived from whatever OTHER workspaces exist in the
  // same run: assignNames() escalates `proj` to `deident-attack/proj` the
  // moment a second `proj` appears, and claim() suffixes `~2`. Measured on the
  // attack corpus: adding one unrelated workspace renamed the row, the saved
  // entry no longer matched, classifyWorkspaces fell through to the proposal,
  // and a workspace the user had set to `exclude` shipped with every gate
  // green. privacy-tiers §3 says a workspace whose signals change reverts to
  // unclassified; nothing says a workspace whose NEIGHBOUR changes reverts to
  // the proposal.
  //
  // review.md is still edited by name, because a name is what a person can
  // recognise, so the name map wins where both answer: it is the edit the user
  // just made, and the key map is the memory of an older one.
  const byName = normalizeSaved(saved.byName ?? (saved.byKey === undefined ? saved : {}));
  const byKey = normalizeSaved(saved.byKey ?? {});
  const savedTier = (ws) => byName[ws.name] ?? byKey[ws.key] ?? null;

  for (const ws of groups) {
    const denyToken = ws.denyToken ?? null;
    const proposal = propose(ws);
    let tier;
    let note;

    let decided = false;

    const remembered = savedTier(ws);
    if (denyToken !== null && !includeDenied.has(ws.name)) {
      tier = 'exclude';
      note = `deny-list matched: "${denyToken}"`;
    } else if (remembered !== null) {
      tier = remembered;
      // A tier the person typed is a DECISION and is persisted, whether it
      // arrived from review.md this run or from workspaces.json two runs ago.
      // `decided` used to be set only when a saved decision already matched,
      // so the first time somebody typed a tier it was never written down,
      // and `export` with a different --out than `scan` wrote to silently
      // applied the proposal instead. cwd: --out defaults to the current
      // directory, so `scan` / `cd elsewhere` / `export` reproduced it with no
      // flags at all.
      decided = true;
      note =
        denyToken !== null
          ? `deny-list "${denyToken}" overridden by --include-denied`
          : `${proposal.reason}  ·  you set this`;
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
        decided,
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

/** Tier words only, so a hand-edited file cannot inject a tier that is not one. */
function normalizeSaved(map) {
  const clean = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (typeof v === 'string' && TIERS.includes(v)) clean[k] = v;
  }
  return clean;
}

/**
 * Saved decisions, or empty ones. A lost decision re-asks, never guesses.
 *
 * @returns {Readonly<{workspaces: object, sessionDrops: ReadonlySet<string>}>}
 *   `workspaces` is keyed by normalised cwd for anything written by a version
 *   that knew about keys, and by display name for the v1 flat form.
 */
export function loadSavedDecisions(saltDir) {
  const file = savedDecisionsPath(saltDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY_SAVED;
    throw new RefusalError(`could not read saved workspace decisions at ${file}`, {
      why: [`${err.code}: ${err.message}`, 'deident will not guess tiers it cannot read.'],
      remedies: [{ label: 'Fix or remove the file', command: `remove ${file}` }],
    });
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_SAVED;
    // v1 was a flat {name: tier} map. It is still read, keyed by name, so an
    // upgrade does not silently forget every decision on the machine.
    const raw = parsed.version === undefined ? parsed : (parsed.workspaces ?? {});
    const drops = Array.isArray(parsed.sessionDrops) ? parsed.sessionDrops.filter((v) => typeof v === 'string') : [];
    return Object.freeze({
      workspaces: Object.freeze(normalizeSaved(raw)),
      sessionDrops: Object.freeze(new Set(drops)),
    });
  } catch {
    return EMPTY_SAVED;
  }
}

const EMPTY_SAVED = Object.freeze({ workspaces: Object.freeze({}), sessionDrops: Object.freeze(new Set()) });

/**
 * Persist only what the person actually decided, never a bare proposal.
 *
 * A proposal is recomputed from the same signals on every run, so writing it
 * down buys nothing and costs the thing privacy-tiers §3 asks for: a
 * workspace whose signals change is re-proposed. Saved as a decision, a repo
 * that later loses its remote would keep exporting on a `redact` nobody chose.
 *
 * Keeping a review.md and exporting against it IS deciding every row in it,
 * so after that first export the file does hold a full set. What this rule
 * stops is an export with no review.md silently promoting the whole proposal
 * to a permanent answer.
 */
export function saveDecisions(saltDir, decisions, sessionDrops = new Set()) {
  const file = savedDecisionsPath(saltDir);
  const workspaces = {};
  for (const d of decisions) {
    // Keyed by the normalised cwd, which does not move when a neighbouring
    // workspace appears. `key` is exactly that for every resolved group.
    if (d.decided && d.tier !== UNCLASSIFIED) workspaces[d.key] = d.tier;
  }
  // Per-session `drop` rows lived only in the review.md the run happened to
  // read, so a run with a different --out silently un-dropped every one of
  // them. privacy-tiers 4 level 3 calls this the last look; a last look that
  // does not persist is not one.
  const body = { version: 2, workspaces, sessionDrops: [...sessionDrops].sort() };
  fs.mkdirSync(saltDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * Saved decisions that match no workspace in this run.
 *
 * Reported rather than dropped: an orphan means either a directory went away
 * or a key stopped matching, and the second is how a typed `exclude` silently
 * became the proposal again.
 */
export function orphanedDecisions(saved, groups) {
  const live = new Set();
  for (const g of groups) {
    live.add(g.key);
    if (g.name !== undefined) live.add(g.name);
  }
  return Object.freeze(Object.keys(saved ?? {}).filter((k) => !live.has(k)));
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
