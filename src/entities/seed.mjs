// Tier-0 entity sources: the ones this machine can answer without a model.
//
// BRIEF §7.3: OS username (bare, not only inside paths), git config user.name
// and user.email, project directory names, git remotes, MCP server names.
//
// §F3 is the reason the bare username is its own entity: in a 25-file sample
// `devuser` appeared 4,520 times inside paths but 296 times bare, in the owner
// column of `ls -l`. Longest-prefix path substitution never fires on those.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expandVariants, isCjkOnly } from './variants.mjs';

export const KINDS = Object.freeze([
  'person', 'org', 'workspace', 'client', 'machine', 'secret', 'phone', 'idnumber', 'account',
]);

/**
 * @returns {Readonly<{entities: object[], warnings: string[]}>}
 *   entity = {id, kind, canonical, spellings[], source, confidence}
 */
export function seedEntities(env, corpus, opts = {}) {
  const warnings = [];
  const collected = [];
  const add = (kind, canonical, source, confidence = 'high') => {
    if (typeof canonical !== 'string') return;
    const trimmed = canonical.trim();
    if (trimmed.length === 0) return;
    collected.push({ kind, canonical: trimmed, source, confidence });
  };

  // --- OS username, bare. §F3.
  const username = env.USERNAME || env.USER || os.userInfo?.().username || null;
  if (username) {
    add('person', username, 'os username (bare)');
  } else {
    warnings.push('could not determine the OS username; bare-username occurrences will not be replaced');
  }

  // --- Home directory as a path root, separate from the bare username.
  const home = os.homedir();
  if (home) add('workspace', home, 'home directory');

  // --- git identity. Failure is non-fatal (PLAN §4.2: git absent -> exit 0).
  const gitName = gitConfig('user.name', warnings);
  const gitEmail = gitConfig('user.email', warnings);
  if (gitName) {
    add('person', gitName, 'git config user.name');
    // A git identity that is a handle is not a display name, and tier 0 has no
    // other source for the latter: Node's os.userInfo() carries no full name on
    // any platform. Rather than imply a control that is not there, say which one
    // is missing. Measured on this machine `git config user.name` is a handle,
    // so the written-out name had no tier-0 source at all and survived 293 times
    // in a real export. Any teammate whose git identity is a handle has the
    // same gap.
    if (!/\s/.test(gitName)) {
      warnings.push(
        'git config user.name is a handle rather than a written-out name, so your ' +
          'display name is replaced only if the semantic pass finds it',
      );
    }
  }
  if (gitEmail) {
    add('person', gitEmail, 'git config user.email');
    const local = gitEmail.split('@')[0];
    if (local && local.length >= 3 && local !== username) {
      add('person', local, 'git config user.email (local part)', 'low');
    }
  }

  // --- Per-line cwd values seen in the exported material: real directories,
  // not slugs (§4.9). Longest first so nested projects both get an entity.
  for (const cwd of opts.cwds ?? []) {
    if (typeof cwd === 'string' && cwd.length > 0) add('workspace', cwd, 'session cwd');
  }

  // --- git remotes, for every workspace directory that is a checkout.
  const remoteWords = new Set();
  // The probe is shared with the tier proposal when the caller has one: git
  // costs ~85 ms per spawn on this machine, and classify() had already asked
  // the same question of the same directories from a separate cache.
  for (const remote of gitRemotes(opts.repoDirs ?? [], warnings, opts.probeRemote ?? null)) {
    add('org', remote.host ? `${remote.owner}/${remote.repo}` : remote.raw, 'git remote');
    if (remote.owner) add('org', remote.owner, 'git remote owner');
    for (const word of `${remote.owner ?? ''} ${remote.repo ?? ''}`.split(/[^A-Za-z0-9]+/)) {
      if (word.length >= 4) remoteWords.add(word.toLowerCase());
    }
  }

  // --- Project directory basenames, taken from real cwd values, never from a
  // slug (§4.9). `gitroll` vs `gitroll-agentic` collide by design (§4.6) and
  // the engine's longest-match rule is what resolves them.
  //
  // A basename is only seeded when it is project-shaped: it carries a hyphen,
  // a digit or a non-ASCII character, or a word of it also appears in a git
  // remote. Without that gate the seed set picks up `dashboard`, `references`
  // and `migration`, which are ordinary English words — §F7's "a scan that
  // cries wolf is the first thing switched off", arriving as over-substitution
  // of prose instead of over-reporting.
  for (const base of new Set((opts.cwds ?? []).map(basenameOf).filter(Boolean))) {
    if (base.length < 4) continue;
    if (projectShaped(base) || remoteWords.has(base.toLowerCase())) {
      add('workspace', base, 'project directory name', 'low');
    }
  }

  // --- MCP server names. §F4: they survive verbatim and fingerprint the device.
  //
  // Read from the local settings files AND swept out of the corpus itself.
  // Measured on a real export: the settings files cover locally-configured
  // servers only, so every Claude.ai connector — `claude_ai_Gmail`,
  // `claude-in-chrome` and the rest, which are configured server-side and
  // appear in no file on this machine — survived 436 times. The log form is
  // always `mcp__NAME__tool`, which is exactly the §F7 precision profile: it
  // cannot match anything by accident, and it is the only form that occurs.
  for (const name of mcpServerNames(env, warnings)) {
    add('machine', name, 'MCP server name', 'low');
  }
  for (const name of sweepMcpNames(opts.texts ?? [])) {
    add('machine', name, 'MCP server name seen in session text', 'low');
  }

  // --- Emails found in the retained text itself.
  //
  // §F1 measured 230 distinct emails across a 90-file sample, 228 of them NOT
  // the user: legal@catalyte.ai, evansmayadvisory.com, deel.com, nowcfo.com,
  // fearless.com. §F2 says third parties never consented and are
  // force-replaced with no opt-out. §F1 also says the thing that makes this
  // tractable: "Emails have a regex. Names do not."
  //
  // This is not in BRIEF §7.3's seed list, and without it the tool leaks. The
  // measured case on this corpus: `devuser@gitroll.io` and
  // `devuser@example.net` have no tier-0 source at all — git config carries
  // only the personal address — so the local part survived tier 0 in 46
  // places. An email regex is also precisely the shape §F7 asks for: it
  // cannot match a thermal-paste part number.
  const ownHandles = new Set();
  for (const email of sweepEmails(opts.texts ?? [])) {
    add('person', email, 'email found in session text');
    // The bare local part, but ONLY when it contains the OS username — i.e.
    // when it is demonstrably one of the uploader's own handles.
    //
    // Measured on a real export: `devuser` survived six times as a bare handle,
    // because the seeded spelling is the full address and `devuser` inside
    // `devuser` is a correct embedded non-match (F07's nested collision). The
    // guard is what keeps this from being §F7 over-substitution: seeding every
    // local part would make entities of `legal`, `info`, `support` and `admin`
    // and substitute them throughout the prose.
    const local = email.split('@')[0];
    if (
      username &&
      local.length >= 5 &&
      local.toLowerCase() !== username.toLowerCase() &&
      local.toLowerCase().includes(username.toLowerCase())
    ) {
      ownHandles.add(local);
    }
  }
  for (const handle of ownHandles) add('person', handle, 'your own handle, from an email in the text');

  // --- Credentials. cli-ux §6 prints a `0 secrets   N replaced` line, so the
  // contract already promised this; nothing in the pipeline looked for one.
  // Measured on a real export: a 93-character GitHub fine-grained PAT survived
  // twice in plain text, full length, not a truncated display form.
  //
  // Only unambiguous vendor prefixes are matched. §F7 asks for precision, and
  // these cannot occur by accident: an entropy heuristic would fire on hashes,
  // uuids and base64 tool output, and a scan that cries wolf is the first thing
  // switched off.
  for (const secret of sweepSecrets(opts.texts ?? [])) {
    add('secret', secret, 'credential shape in session text');
  }

  // --- Phone numbers in E.164 form. Also §F7's profile: a leading plus, a
  // country code and 8-15 digits does not fire on version numbers, part numbers
  // or timestamps. Measured on a real export: 10 distinct numbers, 40+
  // occurrences, the uploader's and third parties' personal mobiles, covered by
  // no entity class and named in no NOT-protected line.
  for (const phone of sweepPhones(opts.texts ?? [])) {
    add('phone', phone, 'phone number in session text');
  }

  // --- Identity-document numbers, and only where the text says what they are.
  //
  // Measured on a real export: a Taiwan passport number shipped 13 times
  // across 5 session files, arriving through a pdftotext tool_result of the
  // uploader's own support pack. It was in no entity class and in no
  // "NOT protected against" line, so a reader of the manifest had no way to
  // know it was in the file.
  //
  // §F7 is why this is label-anchored and not shape-anchored: a
  // passport-shaped regex matched M1019757, a thermal-paste part number. The
  // number is taken only when the words beside it say it is an identity
  // document, which is exactly how it arrives in a document a tool read aloud.
  for (const id of sweepIdNumbers(opts.texts ?? [])) {
    add('idnumber', id, 'identity-document number named in session text');
  }

  // --- Account identifiers of the services these sessions talk to.
  //
  // Measured on a real export: 8+ distinct Slack user ids (255 occurrences of
  // the uploader's own), a DM channel id, a shared channel id, and five Notion
  // page ids sharing one workspace prefix. §F5 seeds the residual scan with
  // "any UUID that is not a known message or session uuid" and catches none of
  // them, because none is UUID-shaped — the same gap §F5 names for
  // cse_01SuFwJN. They are stable cross-corpus join keys for named people: the
  // pair (pseudonym, Slack id) re-identifies someone whose name never appears.
  for (const id of sweepPlatformIds(opts.texts ?? [])) {
    add('account', id, 'account or workspace id in session text');
  }

  // --- The numeric owner id beside the username in `ls -l` output. §F3 says in
  // terms that the stable Windows UID "is itself an identifier"; nothing
  // produced one, and it survived 786 times in a real export, in the exact
  // shape fixture F05 exists to guard. It is a machine-stable value that joins
  // two exports from the same laptop after every name has been replaced.
  for (const uid of sweepUnixUid(opts.texts ?? [], username)) {
    add('machine', uid, 'owner id beside your username in ls -l output');
  }

  return Object.freeze({
    entities: buildEntities(collected),
    warnings: Object.freeze(warnings),
  });
}

// Deliberately conservative: a TLD of 2+ letters, no leading/trailing dot, and
// no consecutive dots. Tuned for precision, not recall (§F7).
const EMAIL_RE = /[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}/g;

// An email written with no domain: `devuser@ / ivy.lin@ / ...`. The local part
// is the identity and the at-sign is what makes it an email rather than a word,
// so the negative lookahead keeps it off `pkg@1.2.3` and off an @mention.
//
// Measured: deident-candidates.txt — the one artifact meant to be read by an
// LLM, and therefore the one most likely to leave the machine — contained
// "All 3 invites (devuser@ / ivy.lin@ / X_PERSON_2736243) are still Pending"
// under a header stating the username had already been replaced.
const EMAIL_LOCAL_RE = /[A-Za-z0-9](?:[A-Za-z0-9._%+-]{2,}[A-Za-z0-9])@(?![A-Za-z0-9])/g;

/** Distinct email addresses appearing in `texts`, full and domainless. */
export function sweepEmails(texts) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.includes('@')) continue;
    EMAIL_RE.lastIndex = 0;
    let m;
    while ((m = EMAIL_RE.exec(text)) !== null) {
      if (m[0].includes('..')) continue;
      found.add(m[0]);
      if (found.size > 5000) return [...found];
    }
    EMAIL_LOCAL_RE.lastIndex = 0;
    while ((m = EMAIL_LOCAL_RE.exec(text)) !== null) {
      found.add(m[0]);
      if (found.size > 5000) return [...found];
    }
  }
  return [...found];
}

// Vendor prefixes that cannot occur by accident. One greppable list, so adding
// a provider is one line and never a heuristic.
const SECRET_RE = new RegExp(
  [
    'github_pat_[A-Za-z0-9_]{22,}',
    'gh[pousr]_[A-Za-z0-9]{16,}',
    'sk-ant-[A-Za-z0-9_-]{20,}',
    'xox[baprse]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{16}',
    'ntn_[A-Za-z0-9]{20,}',
    'AIza[0-9A-Za-z_-]{30,}',
  ].join('|'),
  'g',
);

// A token presented after `Bearer ` in an Authorization header is a credential
// whatever vendor minted it.
//
// Measured on a real export: two live credentials shipped verbatim while the
// manifest printed `0 secrets`. One was a `Bearer v2.…` API token; one was a
// Notion MCP upload JWT whose base64 payload decodes to a purpose, a file
// upload id, a bot id and a space id — so it also carries org UUIDs and
// defeats §F5's UUID residue check. Neither matches any vendor prefix above.
//
// This is the §F7 precision profile rather than an entropy heuristic: the word
// `Bearer` immediately before it is the evidence, and `Bearer` followed by 20
// or more token characters does not occur by accident. Only the token is
// captured, so the word stays and a reader can still see a header was there.
const BEARER_RE = /[Bb]earer[ ]+([A-Za-z0-9][A-Za-z0-9._~+/=-]{19,})/g;

// A JSON Web Token anywhere, header included: `eyJ` is base64 of `{"`. Three
// dot-separated base64url runs is not a shape ordinary prose produces.
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]*/g;

// An identity-document number, taken only where the words beside it say what
// it is. The digit floor is what keeps `U.S. TIN: none` out.
const ID_NUMBER_RE = new RegExp(
  '(?:passport|national id|identity card|id card|driver.?s licen[sc]e|social security|ssn|u[.]?s[.]? tin|tax id)' +
    '[ ]*(?:no[.]?|number|#|card)?[ ]*[:：]?[ ]*([A-Za-z0-9-]{6,14})(?![A-Za-z0-9])',
  'gi',
);
const ID_NUMBER_MIN_DIGITS = 5;

// Slack object ids (user, bot, channel, DM, group, team) and Notion page ids.
//
// Slack's shape is a kind letter, a `0`, then 7-9 uppercase alphanumerics.
// Notion's is a bare 32-hex id, taken ONLY after a notion host, because 32 hex
// characters on their own are every content hash in the corpus (§F7).
const SLACK_ID_RE = /(?<![A-Za-z0-9])[UWBCDGT]0[0-9A-Z]{7,9}(?![A-Za-z0-9])/g;
const NOTION_ID_RE = /(?:app[.]notion[.]com|notion[.]so)[/](?:[A-Za-z0-9-]*-)?([0-9a-f]{32})/g;

// The only form an MCP tool name takes in these logs. The name itself may
// contain single underscores (`claude_ai_Gmail`); the separator is a double.
const MCP_TOOL_RE = /mcp__([A-Za-z0-9][A-Za-z0-9_-]*?)__[A-Za-z0-9]/g;

// The same name written in prose without a tool after it — `mcp__plugin_
// context7_context7__` on its own. Measured: three such fragments survived a
// real export after 2,864 complete names had been replaced, because no
// seeded spelling matched a name with nothing following the closing pair.
const MCP_BARE_RE = /mcp__([A-Za-z0-9][A-Za-z0-9_-]{2,})__(?![A-Za-z0-9])/g;

/** Distinct MCP server names appearing in `texts`, from the tool-name form. */
export function sweepMcpNames(texts) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.includes('mcp__')) continue;
    let m;
    for (const re of [MCP_TOOL_RE, MCP_BARE_RE]) {
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[1].length >= 3) found.add(m[1]);
        if (found.size > 200) return [...found];
      }
    }
  }
  return [...found];
}

/** Distinct credential-shaped strings in `texts`. */
export function sweepSecrets(texts) {
  const found = new Set();
  const sweep = (text, re, group) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = group === 0 ? m[0] : m[group];
      if (typeof value === 'string' && value.length > 0) found.add(value);
      if (found.size > 1000) return true;
    }
    return false;
  };
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    if (sweep(text, SECRET_RE, 0)) break;
    if (/earer/.test(text) && sweep(text, BEARER_RE, 1)) break;
    if (text.includes('eyJ') && sweep(text, JWT_RE, 0)) break;
  }
  return [...found];
}

/** Distinct identity-document numbers named as such in `texts`. */
export function sweepIdNumbers(texts) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    ID_NUMBER_RE.lastIndex = 0;
    let m;
    while ((m = ID_NUMBER_RE.exec(text)) !== null) {
      // "U.S. TIN: none" and "passport number pending" carry no number.
      if ((m[1].match(/[0-9]/g) ?? []).length < ID_NUMBER_MIN_DIGITS) continue;
      found.add(m[1]);
      if (found.size > 200) return [...found];
    }
  }
  return [...found];
}

/** Distinct Slack and Notion object ids in `texts`. */
export function sweepPlatformIds(texts) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    SLACK_ID_RE.lastIndex = 0;
    let m;
    while ((m = SLACK_ID_RE.exec(text)) !== null) {
      found.add(m[0]);
      if (found.size > 1000) return [...found];
    }
    if (text.includes('notion')) {
      NOTION_ID_RE.lastIndex = 0;
      while ((m = NOTION_ID_RE.exec(text)) !== null) {
        found.add(m[1]);
        if (found.size > 1000) return [...found];
      }
    }
  }
  return [...found];
}

const PHONE_RE = /[+][1-9][0-9]{0,3}[-. ]?(?:[0-9][-. ]?){6,13}[0-9]/g;
const SEPARATOR_RE = /[-. ]/;

// The forms humans actually write, which E.164 never matches.
//
// Measured on a real export: 12 distinct numbers survived beside a printed
// `0 phone numbers   103 replaced (36 distinct)`, including the uploader's own
// mobile in a resume header. Every one came out of a signature block or a
// contact table: `(+852) 5136 0512`, `M: +1 (650) 665 4812`, `(650) 877-4012`,
// `801-401-9012`. §F6b required a leading `+`, a country code and 8-15 digits
// CONTIGUOUSLY, so it fired only on the one form that does not appear in a
// signature block.
//
// Two shapes, both §F7-precise:
//   1. a parenthesised country or area code, which prose does not produce;
//   2. a bare 3-3-4 with a consistent `-` or `.` separator, bounded so a date
//      (2026-08-22) and a longer digit run cannot match.
const PHONE_PAREN_RE = /(?:[+][0-9]{1,3}[ ]?)?[(][+]?[0-9]{1,4}[)][ ]?[0-9]{2,4}(?:[ .-][0-9]{2,4}){1,3}/g;
const PHONE_DASHED_RE = /(?<![0-9-.])[0-9]{3}([-.])[0-9]{3}\1[0-9]{4}(?![0-9-.])/g;

/**
 * Distinct E.164-shaped phone numbers in `texts`.
 *
 * The one shape that would over-match is a unified-diff added line, which also
 * begins with a plus and can be all digits, so a separatorless run at the start
 * of a line is not treated as a number. §F7: precision over recall.
 */
export function sweepPhones(texts) {
  const newline = String.fromCharCode(10);
  const found = new Set();
  const take = (text, re, min, max) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const digits = m[0].replace(/[^0-9]/g, '').length;
      if (digits < min || digits > max) continue;
      const atLineStart = m.index === 0 || text[m.index - 1] === newline;
      if (atLineStart && !SEPARATOR_RE.test(m[0])) continue;
      found.add(m[0]);
      if (found.size > 1000) return true;
    }
    return false;
  };
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    if (text.includes('+') && take(text, PHONE_RE, 8, 15)) break;
    if (text.includes('(') && take(text, PHONE_PAREN_RE, 8, 15)) break;
    // Exactly ten digits: a 3-3-4 run of any other length is not this shape.
    if (take(text, PHONE_DASHED_RE, 10, 10)) break;
  }
  return [...found];
}

/**
 * The numeric owner id sitting beside `username` in `ls -l` output.
 *
 * Five digits minimum: a POSIX uid of `1000` is four characters that occur
 * everywhere in ordinary text, and substituting every `1000` in the corpus
 * would be §F7 over-substitution. The Windows value this exists for is six.
 */
export function sweepUnixUid(texts, username) {
  if (typeof username !== 'string' || username.length === 0) return [];
  const re = new RegExp(
    '(?:^|' + String.fromCharCode(10) + ')[-dlbcps][rwxSsTt-]{9}[.+@]?[ \\t]+[0-9]+[ \\t]+' +
      escapeRe(username) +
      '[ \\t]+([0-9]{5,})(?![0-9])',
    'g',
  );
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.includes(username)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      found.add(m[1]);
      if (found.size > 20) return [...found];
    }
  }
  return [...found];
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Group raw seeds into entities: one entity per canonical string, carrying
 * every escaping variant as a spelling.
 *
 * A one-character CJK canonical is dropped and reported, never substituted
 * (§4.5: the lookaround cannot stop it over-matching inside a longer word).
 */
export function buildEntities(collected) {
  const byCanonical = new Map();
  for (const c of collected) {
    const key = JSON.stringify([c.kind, c.canonical]);
    if (!byCanonical.has(key)) byCanonical.set(key, { ...c, sources: [c.source] });
    else {
      const e = byCanonical.get(key);
      if (!e.sources.includes(c.source)) e.sources.push(c.source);
      // Any high-confidence source promotes the entity.
      if (c.confidence === 'high') e.confidence = 'high';
    }
  }

  const counters = new Map();
  const out = [];
  for (const e of [...byCanonical.values()].sort(
    (a, b) => b.canonical.length - a.canonical.length || (a.canonical < b.canonical ? -1 : 1),
  )) {
    const rejected = rejectReason(e.canonical);
    const nextIndex = (counters.get(e.kind) ?? 0) + 1;
    counters.set(e.kind, nextIndex);
    out.push(
      Object.freeze({
        id: `${e.kind.toUpperCase()}_${String(nextIndex).padStart(2, '0')}`,
        kind: e.kind,
        canonical: e.canonical,
        spellings: rejected ? Object.freeze([]) : expandVariants(e.canonical),
        sources: Object.freeze([...e.sources]),
        source: e.sources[0],
        confidence: rejected ? 'flagged' : e.confidence,
        tier: 0,
        rejected,
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Why this spelling must not be substituted, or null.
 * The CJK length rule is BRIEF §4.5's second half and is a fixture (F03).
 */
export function rejectReason(canonical) {
  if (typeof canonical !== 'string' || canonical.trim().length === 0) {
    return 'blank: a spelling of whitespace matches every space in the corpus';
  }
  if (isCjkOnly(canonical) && [...canonical].length < 2) {
    return 'single-character CJK entity: the lookaround boundary cannot stop it over-matching inside a longer word (BRIEF §4.5)';
  }
  if (canonical.length < 3 && !isCjkOnly(canonical)) {
    return 'shorter than 3 characters: too collision-prone to substitute safely';
  }
  if (PATH_ROOT_RE.test(canonical)) return PATH_ROOT_REASON;
  return null;
}

// A bare filesystem root identifies nobody: every Windows machine has `C:\`.
// It reaches the seed set because §4.8's per-line cwd can BE the drive root,
// and `add('workspace', cwd)` does not know the difference.
//
// Measured on the real corpus (2026-08-22): one session ran with cwd `C:\`,
// which seeded the variants `c:\` and `c:/`. In the SERIALIZED bytes the three
// characters `c:\` occur inside ordinary Python and prose. `if r != c:` newline
// serializes as `c:` followed by the escape `\n`, so the residual scan reported
// 12 leaks that were not leaks, and the export was refused. §F7: a scan that
// cries wolf is the first thing switched off.
const PATH_ROOT_RE = /^(?:[A-Za-z]:[\\/]?|[\\/]+|\/[A-Za-z]\/?)$/;
const PATH_ROOT_REASON =
  'a bare filesystem root, not an identifier: every machine has one, and its escaping variants match ordinary text (§F7)';

// ------------------------------------------------------------------ probes

function gitConfig(key, warnings) {
  try {
    const out = execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim() || null;
  } catch (err) {
    if (err.code === 'ENOENT') {
      warnings.push('git is not on PATH; git-sourced entities were skipped');
    } else if (err.status !== 1) {
      warnings.push(`git config ${key} failed (${err.status ?? err.code}); that entity was skipped`);
    }
    return null;
  }
}

function gitRemotes(dirs, warnings, probeRemote = null) {
  const seen = new Map();
  if (probeRemote !== null) {
    for (const dir of dirs) {
      const parsed = probeRemote(dir);
      if (parsed && !seen.has(parsed.raw)) seen.set(parsed.raw, parsed);
    }
    return [...seen.values()];
  }
  for (const dir of dirs) {
    let out;
    try {
      out = execFileSync('git', ['-C', dir, 'remote', '-v'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        warnings.push('git is not on PATH; git remotes were skipped');
        return [];
      }
      continue; // Not a repo. Expected for most directories.
    }
    for (const line of out.split('\n')) {
      const url = line.split(/\s+/)[1];
      if (!url) continue;
      const parsed = parseRemote(url);
      if (parsed && !seen.has(parsed.raw)) seen.set(parsed.raw, parsed);
    }
  }
  return [...seen.values()];
}

/** github.com:owner/repo.git and https://github.com/owner/repo both parse. */
export function parseRemote(url) {
  const m = /(?:[:/])([^/:\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url.trim());
  if (!m) return null;
  const host = /^[a-z]+:\/\//.test(url) || url.includes('@') ? url.split(/[/:@]/)[0] : null;
  return Object.freeze({ raw: `${m[1]}/${m[2]}`, owner: m[1], repo: m[2], host });
}

/**
 * MCP server names from the user's Claude settings. Read-only, and a missing
 * or unreadable file is a warning, never a throw (BRIEF §2).
 */
function mcpServerNames(env, warnings) {
  const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const candidates = [
    path.join(os.homedir(), '.claude.json'),
    path.join(configDir, 'settings.json'),
    path.join(configDir, '.mcp.json'),
  ];
  const names = new Set();
  let readAny = false;
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    readAny = true;
    try {
      const cfg = JSON.parse(text);
      for (const key of Object.keys(cfg?.mcpServers ?? {})) names.add(key);
      for (const project of Object.values(cfg?.projects ?? {})) {
        for (const key of Object.keys(project?.mcpServers ?? {})) names.add(key);
      }
    } catch {
      warnings.push(`${file} is not valid JSON; MCP server names from it were skipped`);
    }
  }
  if (!readAny) warnings.push('no Claude settings file found; MCP server names were not seeded');
  return [...names];
}

/** Last segment of a real path. Not a slug (§4.9). */
export function basenameOf(cwd) {
  if (typeof cwd !== 'string') return null;
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 && !/^[A-Za-z]:$/.test(last) ? last : null;
}

/** Looks like a project name rather than an ordinary English word. */
export function projectShaped(name) {
  // No letter at all means a version number or a date (`6.2.0`, `2026-08`),
  // not a project. Seeding one substitutes every version string in the prose,
  // which is §F7 over-substitution, and §F4 says leave the version sequence
  // alone anyway. Non-ASCII names carry no ASCII letter and are kept.
  if (!/[A-Za-z]/.test(name) && !/[^\x00-\x7F]/.test(name)) return false;
  return /[-_.0-9]/.test(name) || /[^\x00-\x7F]/.test(name);
}
