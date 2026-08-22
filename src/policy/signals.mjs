// Propose a tier per workspace from signals this machine can read offline.
//
// docs/privacy-tiers.md §3: "Nobody is going to answer 31 questions. The tool
// derives a proposal from signals it can read, and the person corrects the
// rows that are wrong." A tool that proposes nothing has moved the whole cost
// of the design onto the user, and a user facing 29 questions answers none.
//
// One row of that table cannot be honoured offline and is deliberately not
// guessed: "git remote is a public repository -> open". Repository visibility
// is not on disk. A remote URL says nothing about who may read it, and BRIEF
// §2 forbids the network call that would answer it. `open` is weaker than
// `redact` (privacy-tiers §5), so guessing it wrong leaks. Every remote is
// therefore proposed `redact`, and `open` stays a decision the person makes in
// review.md. The row says so, rather than looking like nothing was tried.

import { execFileSync } from 'node:child_process';
import { parseRemote } from '../entities/seed.mjs';
import { HOME_NAME } from './grouping.mjs';

/**
 * The first remote of the repository containing `dir`, or null.
 * `git -C` walks up, so a cwd deep inside a checkout still resolves.
 * A directory that no longer exists is not an error: it is "no remote".
 */
export function gitRemoteAt(dir) {
  if (typeof dir !== 'string' || dir === '') return null;
  let out;
  try {
    out = execFileSync('git', ['-C', dir, 'remote', '-v'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch {
    return null;
  }
  for (const line of out.split('\n')) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    const parsed = parseRemote(url);
    if (parsed) return parsed;
  }
  return null;
}

/** Memoised probe, so 40 workspaces do not shell out 40 times per command. */
export function makeRemoteProbe(probe = gitRemoteAt) {
  const cache = new Map();
  return (dir) => {
    if (!cache.has(dir)) cache.set(dir, probe(dir));
    return cache.get(dir);
  };
}

/**
 * @returns {{tier: string, reason: string}} the proposal for one group.
 *   `unclassified` is the residue, never the default.
 */
export function proposeTier(group, probeRemote) {
  if (group.denyToken !== null && group.denyToken !== undefined) {
    return frozen('exclude', `deny-list matched: "${group.denyToken}"`);
  }
  if (group.unresolved) {
    return frozen('unclassified', 'no cwd was ever recorded, so no signal could be read');
  }
  const remote = probeRemote(group.cwd);
  if (remote !== null) {
    return frozen('redact', `git remote ${remote.raw} (set "open" yourself if it is public)`);
  }
  if (group.name === HOME_NAME) {
    // 129 sessions on the real corpus. They are not one piece of work and the
    // per-line cwd filter, not this row, is what protects the material in them.
    return frozen('exclude', 'your home directory: no repo, sessions here are individually undecidable');
  }
  return frozen('exclude', 'no git remote');
}

function frozen(tier, reason) {
  return Object.freeze({ tier, reason });
}
