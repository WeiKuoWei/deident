// The per-line gate.
//
// BRIEF §4.8 measured 11 distinct cwd values inside ONE session file, two of
// them under `\private`. Directory-level opt-in alone would have exported
// payroll material from an otherwise ordinary workspace. So a record whose
// effective cwd matches a deny token is dropped even inside an included
// workspace.

import { matchDenyToken } from './workspaces.mjs';
import { normalizeCwd } from '../corpus/cwdtrack.mjs';

/**
 * @param {string|null} cwd  the effective cwd for this record
 * @param {{deniedDirNames?: Set<string>, excludedPrefixes?: string[]}} policy
 * @returns {{allow: boolean, reason: string|null}}
 */
export function allowLine(cwd, policy = {}) {
  if (cwd === null || cwd === undefined || cwd === '') {
    // Unknown directory is deny. cwdtrack back-fills the head of a file from
    // its first known value, so a null here means the whole file never
    // declared one — which is not a case we are willing to guess about.
    return DENY_UNKNOWN;
  }

  const denyToken = matchDenyToken(cwd);
  if (denyToken !== null && !(policy.allowDenyTokenFor ?? new Set()).has(denyToken)) {
    return Object.freeze({ allow: false, reason: `cwd matched deny token "${denyToken}"` });
  }

  const norm = normalizeCwd(cwd);
  for (const prefix of policy.excludedPrefixes ?? []) {
    if (prefix !== '' && (norm === prefix || norm.startsWith(`${prefix}/`))) {
      return Object.freeze({ allow: false, reason: 'cwd is inside an excluded workspace' });
    }
  }

  return ALLOW;
}

const ALLOW = Object.freeze({ allow: true, reason: null });
const DENY_UNKNOWN = Object.freeze({ allow: false, reason: 'no cwd could be established for this line' });

/**
 * Apply the gate across a whole session.
 * Returns the kept record indices plus a per-reason tally for the manifest —
 * a dropped line the user never hears about is the failure mode this counts
 * against.
 */
export function filterSession(records, cwds, policy) {
  const keep = [];
  const dropped = new Map();
  for (let i = 0; i < records.length; i += 1) {
    const verdict = allowLine(cwds[i], policy);
    if (verdict.allow) {
      keep.push(i);
    } else {
      dropped.set(verdict.reason, (dropped.get(verdict.reason) ?? 0) + 1);
    }
  }
  return Object.freeze({ keep: Object.freeze(keep), dropped: Object.freeze(Object.fromEntries(dropped)) });
}

/** True if any line of this session ever touched a deny-listed directory. */
export function touchedDenied(cwds) {
  for (const cwd of cwds) {
    const token = matchDenyToken(cwd ?? '');
    if (token !== null) return token;
  }
  return null;
}
