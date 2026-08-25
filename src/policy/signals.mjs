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
// `redact` (privacy-tiers §5), so guessing it wrong leaks.
//
// No proposal is exportable at all. `redact` and `open` are reached only by a
// person typing one of them, and every proposal here is `exclude` or
// `unclassified`. The reason is measured rather than cautious: `scan` writes
// the proposal into column 1 of review.md, so a proposal read back is
// indistinguishable from a decision, and two exports shipped on that with all
// six gates green. See the remote branch below for the whole argument.

import { execFileSync } from 'node:child_process';
import { parseRemote } from '../entities/seed.mjs';
import { HOME_NAME } from './grouping.mjs';

/**
 * Returned instead of null when git itself could not be run, so a caller can
 * tell "this directory has no remote" from "nobody ever looked".
 */
export const GIT_UNAVAILABLE = Object.freeze({ unavailable: true });

/**
 * The first remote of the repository containing `dir`, null if there is none,
 * or `GIT_UNAVAILABLE` if git could not be run at all.
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
  } catch (err) {
    // ENOENT is git missing from PATH, which is a different fact from a
    // directory without a remote, and this catch used to flatten both to null.
    // Measured on this repository with PATH stripped: every workspace was
    // proposed with the reason "no git remote" while the checkout in front of
    // it had one. seed.mjs draws the same line at its own git call, and a
    // proposal is only correctable if its stated reason is true.
    if (err.code === 'ENOENT') return GIT_UNAVAILABLE;
    return null; // Not a repo, or git refused. Expected for most directories.
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
  if (remote === GIT_UNAVAILABLE) {
    // Still `exclude`, and deliberately not softened to a warning the person
    // can skim past: with no remote readable, no signal below distinguishes a
    // public checkout from a client's source tree, and the failure direction of
    // guessing is a release. Checked before the branch below so the sentinel
    // can never be read as if it were a parsed remote.
    return frozen('exclude', 'could not run git (not on PATH), so no remote could be read');
  }
  if (remote !== null) {
    // A git remote is evidence a directory is a REPOSITORY. It is not evidence
    // its content is shareable, and this row was the only thing standing
    // between a 187-chat personal message archive and the zip: measured on a
    // real export, a personal message archive (`chat-archive` in F58) was
    // proposed `redact` on the strength of its remote alone and shipped a third
    // party's real name 10 times, plus per-chat filenames naming the people in
    // them. The deny-list never looked,
    // because privacy-tiers §3 matches it against directory names and the
    // directory does not carry a deny token.
    const personal = personalDataShape(group.name) ?? personalDataShape(remote.repo);
    if (personal !== null) {
      return frozen(
        'unclassified',
        `git remote ${remote.raw}, but "${personal}" reads like personal data, so decide this one yourself`,
      );
    }
    // Both guards above are English words matched over `/[^a-z0-9]+/`
    // segments, so neither of them reads a name written in another script at
    // all. Measured by running this function: a directory named in Han or in
    // Cyrillic got denyToken null, personalDataShape null and a `redact`
    // proposal, so a second user's private archive named in their own language
    // is offered for export with no typed confirmation. That is the incident
    // above with the instrument removed rather than answered, and silence from
    // an instrument that could not look is not a clearance. Fails closed the
    // same way GIT_UNAVAILABLE does.
    //
    // The remedy is named here because this is the moment the person is
    // deciding, and because one token in that file feeds both matchDenyToken
    // and deniedPathToken, so it closes the per-line path gate too.
    const unreadable = [group.name, remote.repo].find((s) => typeof s === 'string' && NON_ASCII.test(s));
    if (unreadable !== undefined) {
      return frozen(
        'unclassified',
        `git remote ${remote.raw}, but the deny-list is English words and could not read ` +
          `"${unreadable}": decide this one yourself, or add a token to denied.json beside your salt`,
      );
    }
    // Default-deny, and this is the whole of it.
    //
    // This row used to read `redact`, and `scan` writes the proposal into
    // column 1 of review.md, so reading the file back was indistinguishable
    // from reading a tier the person had typed. `scan` then `export` therefore
    // admitted every remote-bearing workspace on the machine with nobody
    // agreeing to anything. Two exports shipped that way with all six gates
    // green and both leaked, and neither leak was in a work repository.
    //
    // A remote is evidence that a directory is a repository. It is not evidence
    // that its contents may be handed to someone, and this is the one branch
    // where the difference is load-bearing: every other proposal is already
    // `exclude` or `unclassified`. Making it `exclude` costs the person one
    // typed word per workspace they actually want, and buys the manifest a
    // sentence it could not previously make: whatever the tool still misses can
    // only be missed inside a workspace that was named by hand.
    //
    // `admissible` is what stops that from becoming 31 questions. The row is
    // still the candidate the census counts and the refusal lists; it is just
    // not the answer.
    return frozen('exclude', `git remote ${remote.raw}: type "redact" here to include it, or "open" if it is public`, true);
  }
  if (group.name === HOME_NAME) {
    // 129 sessions on the real corpus. They are not one piece of work and the
    // per-line cwd filter, not this row, is what protects the material in them.
    return frozen('exclude', 'your home directory: no repo, sessions here are individually undecidable');
  }
  return frozen('exclude', 'no git remote');
}

// Whole segments only, split on the separators a repository name uses. A
// substring test would call `pipeline` and `timeline` personal data, which is
// §F7's over-reporting arriving as noise in the review.
// A name with any non-ASCII character in it is outside what either English
// word list can read.
const NON_ASCII = /[^\x00-\x7F]/;

const PERSONAL_TOKENS = new Set([
  'archive', 'archives', 'chat', 'chats', 'line', 'whatsapp', 'wechat', 'telegram',
  'messages', 'sms', 'dm', 'dms', 'journal', 'diary', 'health', 'medical',
  'therapy', 'counselling', 'counseling', 'personal',
]);

/** The segment that reads like personal data, or null. */
export function personalDataShape(name) {
  if (typeof name !== 'string') return null;
  for (const segment of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (PERSONAL_TOKENS.has(segment)) return segment;
  }
  return null;
}

/**
 * `admissible` marks a row a person would plausibly want to admit, so the
 * census and the refusal can name it. It is never a tier and never an answer:
 * only a typed decision reaches an exportable tier.
 */
function frozen(tier, reason, admissible = false) {
  return Object.freeze({ tier, reason, admissible });
}
