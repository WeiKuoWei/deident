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
import { expandVariants, looseVariants, isCjkOnly } from './variants.mjs';
import { homeDir, nonBlank } from '../corpus/root.mjs';

export const KINDS = Object.freeze([
  'person', 'org', 'workspace', 'client', 'machine', 'secret', 'phone', 'idnumber', 'account',
]);

/**
 * The `source` string a declared value carries.
 *
 * Defined here rather than in src/policy/knownvalues.mjs, which is where the
 * rest of that feature lives, because knownvalues.mjs imports KINDS from this
 * file and the other direction would be a cycle. It is the token the report
 * filters on to print the declared list back with its counts, so it has to be
 * one string in one place.
 */
export const DECLARED_SOURCE = 'declared in known-values.json';

/**
 * The OS username, or null. NEVER throws.
 *
 * This was written `os.userInfo?.().username`, which guards nothing that
 * matters: optional chaining protects against a null RESULT, and os.userInfo()
 * THROWS. Node raises a SystemError (`uv_os_get_passwd returned ENOENT`, or
 * "user has no username") in a container with no passwd entry, on a
 * locked-down CI runner and on some managed Windows profiles, and the throw
 * came straight back out of seedEntities as a traceback rather than deident's
 * own refusal shape. BRIEF §2: a traceback is a failed delivery.
 *
 * The only caller is seedEntities, and the value is a tier-0 seed, so a
 * failure here is REPORTED and never swallowed: §F3 measured 296 BARE
 * occurrences of the username in the `ls -l` owner column, which longest-prefix
 * path substitution never fires on. Losing it silently loses a leak vector
 * while every gate stays green. The caller degrades the way it already degrades
 * for a missing home directory: seed nothing, warn, carry on.
 *
 * The injected userInfo exists for the same reason probeCaseFolding takes an
 * injected stat: a fixture has to state both answers on a machine that only
 * has one of them.
 */
export function osUsername(env, userInfo = () => os.userInfo()) {
  for (const name of ['USERNAME', 'USER']) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  try {
    const name = userInfo()?.username;
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
  } catch {
    return null;
  }
}

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
  const username = osUsername(env, opts.userInfo);
  if (username) {
    add('person', username, 'os username (bare)');
  } else {
    warnings.push('could not determine the OS username; bare-username occurrences will not be replaced');
  }

  // --- Home directory as a path root, separate from the bare username.
  const home = homeDir(env);
  if (home) add('workspace', home, 'home directory');
  else warnings.push('no home directory in this environment; the home path was not seeded');

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
  const addGitEmail = (email, source) => {
    add('person', email, source);
    const local = email.split('@')[0];
    if (local && local.length >= 3 && local !== username) {
      add('person', local, `${source} (local part)`, 'low');
    }
  };
  if (gitEmail) addGitEmail(gitEmail, 'git config user.email');

  // --- The identity configured INSIDE each repository, which the two calls
  // above cannot see.
  //
  // `git config --get` runs with no `-C`, so it reads the config of whatever
  // directory deident was launched from. Verified on a real checkout: the
  // GLOBAL name and email were seeded and the in-repo ones were not seeded at
  // all. A per-repository `user.email` is the ordinary setup for anyone keeping
  // work and personal identities apart, so the identity most likely to be in
  // the exported material is precisely the one tier 0 could not see.
  //
  // This rides on the remote probe rather than on spawns of its own. git costs
  // ~85 ms per spawn, gitRemoteAt already pays for one per repository, and
  // makeRemoteProbe memoises it, so reading the identity out of the same probe
  // result costs nothing. A probe that carries no identity, which is every
  // injected one, contributes nothing rather than failing.
  const repoIdentity = gitIdentities(opts.repoDirs ?? [], opts.probeRemote ?? null);
  for (const name of repoIdentity.names) add('person', name, 'git config user.name inside a repository');
  for (const email of repoIdentity.emails) addGitEmail(email, 'git config user.email inside a repository');

  // --- Per-line cwd values seen in the exported material: real directories,
  // not slugs (§4.9). Longest first so nested projects both get an entity.
  for (const cwd of opts.cwds ?? []) {
    if (typeof cwd === 'string' && cwd.length > 0) add('workspace', cwd, 'session cwd');
  }

  // --- git remotes, for every workspace directory that is a checkout.
  //
  // `audience` is the declared recipient (audience-and-floor.md). It moves ONE
  // thing here and it is the clause the operator contract used to enforce by
  // hand: "the user's own employer and its product vocabulary stay out of the
  // entity list WHEN THE RECIPIENT WORKS THERE TOO". Absent, `public`, which is
  // the flag's own default: the two halves of the tool must not disagree about
  // who the archive is for.
  const audience = opts.audience ?? 'public';
  // A Set, not a counter: buildEntities dedupes on (kind, canonical), so two
  // remotes with the same repo name under different owners are one entity and
  // a bare increment would report two.
  const audienceNames = new Set();
  const remoteWords = new Set();
  // The probe is shared with the tier proposal when the caller has one: git
  // costs ~85 ms per spawn on this machine, and classify() had already asked
  // the same question of the same directories from a separate cache.
  for (const remote of gitRemotes(opts.repoDirs ?? [], warnings, opts.probeRemote ?? null)) {
    add('org', remote.host ? `${remote.owner}/${remote.repo}` : remote.raw, 'git remote');
    // The owner is seeded at EVERY audience and is deliberately not on the
    // axis. Tier 0 cannot tell an employer's own org from a client's org that
    // the person has a checkout under, and the failure direction of guessing
    // wrong is shipping a client's name to a stranger.
    if (remote.owner) add('org', remote.owner, 'git remote owner');
    // The bare repo name is the product vocabulary: what the employer builds,
    // written the way it is written in the prose. At `public` it identifies the
    // employer to a reader who does not already know it; at `teammate` or
    // `company` it is a word the reader uses daily, and substituting it wrecks
    // the sentence while hiding nothing.
    //
    // Gated by projectShaped for the reason the project-basename seed below is:
    // without it a repo called `dashboard`, `references` or `migration` becomes
    // an entity and ordinary prose gets substituted, which is §F7's "a scan
    // that cries wolf is the first thing switched off" arriving as
    // over-substitution. The length floor is the basename seed's, for the same
    // collision reason.
    if (audience === 'public' && remote.repo && remote.repo.length >= 4 && projectShaped(remote.repo)) {
      add('org', remote.repo, 'git repository name (declared audience: public)', 'low');
      audienceNames.add(remote.repo);
    }
    for (const word of `${remote.owner ?? ''} ${remote.repo ?? ''}`.split(/[^A-Za-z0-9]+/)) {
      if (word.length >= 4) remoteWords.add(word.toLowerCase());
    }
  }

  // --- Project directory basenames, taken from real cwd values, never from a
  // slug (§4.9). `northwind` vs `northwind-agentic` collide by design (§4.6) and
  // the engine's longest-match rule is what resolves them.
  //
  // A basename is only seeded when it is project-shaped: it carries a hyphen,
  // a digit or a non-ASCII character, or a word of it also appears in a git
  // remote. Without that gate the seed set picks up `dashboard`, `references`
  // and `migration`, which are ordinary English words, §F7's "a scan that
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
  // servers only, so every Claude.ai connector, `claude_ai_Gmail`,
  // `claude-in-chrome` and the rest, which are configured server-side and
  // appear in no file on this machine, survived 436 times. The log form is
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
  // the user. The domains below are fabricated stand-ins for the real
  // counterparties; the shape they carry is the only thing under discussion,
  // which is that a third-party domain looks exactly like the uploader's own:
  // legal@kestrelis.ai, norbrookvanceadvisory.com, northsky-hr.com,
  // ledgerpost.com, ironvale.com. §F2 says third parties never consented and
  // are force-replaced with no opt-out. §F1 also says the thing that makes
  // this tractable: "Emails have a regex. Names do not."
  //
  // This is not in BRIEF §7.3's seed list, and without it the tool leaks. The
  // measured case on this corpus: `devuser@northwind.example` and
  // `devuser@brightfern.ai` have no tier-0 source at all, git config carries
  // only the personal address, so the local part survived tier 0 in 46
  // places. An email regex is also precisely the shape §F7 asks for: it
  // cannot match a thermal-paste part number.
  const ownHandles = new Set();
  for (const email of sweepEmails(opts.texts ?? [])) {
    add('person', email, 'email found in session text');
    // The bare local part, but ONLY when it contains the OS username, i.e.
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
  // them, because none is UUID-shaped: the same gap §F5 names for the
  // `cse_01…` bridge-session id. They are stable cross-corpus join keys for named people: the
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

  // --- Values the person DECLARED, from known-values.json beside the salt.
  //
  // The only source in this file that is not inference, and the last one to
  // run, which is what lets it borrow a kind. Every other seed above answers
  // "what can this machine work out"; this one answers "what has this person
  // written down as theirs". A finished export with all six gates green shipped
  // 21 identity fields that no rule above could reach: document name orderings,
  // a date and place of birth, six addresses, a phone number, a payment-platform
  // account id. See src/policy/knownvalues.mjs.
  //
  // A declared value whose canonical string was ALREADY collected takes the
  // kind it was collected under, rather than its own. buildEntities keys on
  // (kind, canonical), so the same string under two kinds is two entities with
  // one spelling between them; buildTable then sorts them together and the
  // loser matches nothing, which the probe reports as "this declared spelling
  // protects nothing" about a value that is in fact protected. Borrowing the
  // kind collapses them into one entity carrying both sources instead, which is
  // also the honest record: the tool found it AND was told about it.
  const collectedKind = new Map(collected.map((c) => [c.canonical, c.kind]));
  for (const declared of opts.knownValues ?? []) {
    if (typeof declared?.value !== 'string') continue;
    add(collectedKind.get(declared.value) ?? declared.kind, declared.value, DECLARED_SOURCE);
  }

  return Object.freeze({
    entities: buildEntities(collected),
    warnings: Object.freeze(warnings),
    // What the declared audience actually added, so the manifest can report a
    // number that moves. The field it replaces was `heldByAudience`, which was
    // 0 on every measured run because nothing ever wrote the decision it
    // counted, and a zero printed where no check ran is §4.3's mistake.
    audienceEntities: audienceNames.size,
  });
}

// Deliberately conservative: a TLD of 2+ letters, no leading/trailing dot, and
// no consecutive dots. Tuned for precision, not recall (§F7).
const EMAIL_RE = /[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}/g;

// An email written with no domain: `devuser@ / ivy.lin@ / ...`. The local part
// is the identity and the at-sign is what makes it an email rather than a word,
// so the negative lookahead keeps it off `pkg@1.2.3` and off an @mention.
//
// Measured: deident-candidates.txt, the one artifact meant to be read by an
// LLM, and therefore the one most likely to leave the machine, contained
// "All 3 invites (devuser@ / ivy.lin@ / X_PERSON_2736243) are still Pending"
// under a header stating the username had already been replaced.
const EMAIL_LOCAL_RE = /[A-Za-z0-9](?:[A-Za-z0-9._%+-]{2,}[A-Za-z0-9])@(?![A-Za-z0-9])/g;

// The same address with its at-sign percent-encoded, which is how it is written
// when it sits in a URL query.
//
// Measured: sweepEmails returned [] on text containing `%40`, so an address
// seen ONLY inside a URL was never seeded at all. That is upstream of every
// other control: expandVariants already generates the percent-encoded and the
// double-encoded twins of a seeded address, so the machinery to REPLACE the URL
// form has been there all along and there was simply nothing to expand.
//
// What is added to the sweep is therefore the DECODED address, not the matched
// bytes: seeding `ada%40x.example` would protect the one URL it came from and
// leave every plain occurrence of the same address alone, and expandVariants
// run over an encoded string produces twins of an encoding.
//
// It eats nothing else, but it did eat part of its own neighbour. The two
// lookbehinds stop the local part from starting inside the PRECEDING percent
// escape: measured on real text, `…authuser%3Draykuo%40gitroll.io` seeded
// `3Draykuo@gitroll.io`, because `3D` is `[A-Za-z0-9]` and the escape it
// belongs to is invisible to a pattern that starts at the wrong character. A
// spelling with two stray characters welded to the front protects nothing and
// reports itself as protection. `%3D` before an address is the shape
// variants.mjs already names, so this is where it actually arrives.
const EMAIL_ENCODED_RE =
  /(?<!%)(?<!%[0-9A-Fa-f])([A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?)%40((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,})/gi;

/** Distinct email addresses appearing in `texts`, full and domainless. */
export function sweepEmails(texts) {
  const found = new Set();
  for (const text of texts) {
    // The `@` fast path used to be the whole guard, and it is the reason a
    // percent-encoded address was never seeded: a URL that carries one has no
    // literal at-sign in it anywhere, so the string was skipped before any
    // pattern below ever looked at it.
    if (typeof text !== 'string') continue;
    if (!text.includes('@') && !text.includes('%40')) continue;
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
    if (text.includes('%40')) {
      EMAIL_ENCODED_RE.lastIndex = 0;
      while ((m = EMAIL_ENCODED_RE.exec(text)) !== null) {
        found.add(`${m[1]}@${m[2]}`);
        if (found.size > 5000) return [...found];
      }
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
    // Temporary credentials. Same shape as AKIA, different first letter, and
    // the one that actually turned up: a presigned S3 URL carries an ASIA key
    // id beside the session token below.
    'ASIA[0-9A-Z]{16}',
    'ntn_[A-Za-z0-9]{20,}',
    // Scheduled-trigger ids. Found by grepping the SHIPPED archive rather than
    // the report: one sat in plaintext in an export that had passed all six
    // checks, because the reader listed two of the three trigger ids in the
    // corpus and nothing else was looking. A fixed prefix plus a 26-character
    // base62 id is a machine's job, and an entity list is precisely the thing
    // that misses one of three.
    'trig_[A-Za-z0-9]{20,}',
    'AIza[0-9A-Za-z_-]{30,}',
    // A gcloud OAuth2 access token, which is what `gcloud auth
    // print-access-token` prints and what then gets pasted into a curl line.
    // Measured: sweepSecrets returned [] on one. A fixed vendor prefix is
    // exactly what this list is for, so it is one line and not a mechanism.
    'ya29[.][A-Za-z0-9_-]{20,}',
    // Added because a re-measurement ran ten live-credential shapes through
    // this sweep and got ten empty arrays. Each of these is the one line the
    // comment above promises; none of them is a heuristic.
    'sk-proj-[A-Za-z0-9_-]{20,}',
    '[sr]k_(?:live|test)_[A-Za-z0-9]{20,}',
    'npm_[A-Za-z0-9]{36}',
    'glpat-[A-Za-z0-9_-]{20,}',
    'xapp-[0-9]-[A-Za-z0-9-]{20,}',
    'hf_[A-Za-z0-9]{30,}',
    'dop_v1_[a-f0-9]{60,}',
    'dckr_pat_[A-Za-z0-9_-]{20,}',
    'SG[.][A-Za-z0-9_-]{20,}[.][A-Za-z0-9_-]{20,}',
  ].join('|'),
  'g',
);

// The class rule the vendor list above cannot be.
//
// Enumerating prefixes stays reactive forever: it covers the tools the author
// personally uses, and every other live key ships verbatim while the manifest
// prints `0 secrets  0 replaced` two lines above the limits block. Nothing
// downstream recovers it. residual.mjs scans for KNOWN entity spellings only,
// so a token this sweep never saw is invisible to it by construction, and
// tier1.mjs excludes tool output from the semantic pass, which is where all
// three of the measured leaks were.
//
// Same posture as ID_NUMBER_RE and BEARER_RE: the words beside the value are
// the evidence. A label naming a credential, then a 16+ character value with
// no space in it. The vendor list stays for keys that arrive with no label at
// all, such as a bare AKIA in a URL.
//
// The label was itself an enumerated list of COMPOUNDS: api_key, secret_key,
// access_token, auth_token, client_secret. Measured: `aws_secret_access_key`
// matches none of them, because `secret[_-]?key` cannot cross the `access` in
// the middle, so the AKIA key id beside it was seeded and the secret half of
// the same pair shipped. Enumerating one more compound leaves the same hole one
// vendor over, and `gcp_service_account_key` and `azure_client_secret` are the
// same sentence again.
//
// The shape underneath the list: a credential label is a credential NOUN
// carrying at least one qualifier word. That is what separates it from a bare
// `key:`, which is the form that cries wolf. Two ways a qualifier attaches, and
// the list is now of nouns rather than of compounds:
//   1. separator-joined, any depth up to three: aws_secret_access_key, x-api-key
//   2. run together or camel-cased, which needs the small qualifier list
//      because there is no separator to find: apiKey, clientsecret
const CREDENTIAL_LABEL_RE =
  /(?:[A-Za-z][A-Za-z0-9]*[_-]){1,3}(?:key|token|secret|password|passwd)|(?:api|access|auth|client|secret|private|refresh|session)[_-]?(?:key|token|secret)|password|passwd/
    .source;
const LABELLED_SECRET_RE = new RegExp(
  `(?:${CREDENTIAL_LABEL_RE})["' ]*[:=][ ]*["']?([A-Za-z0-9_.~+/=-]{16,})`,
  'gi',
);

// A URL that carries its password in the authority. Vendor-independent, and
// README named it by hand as a shape nothing swept.
//
// A scheme is required, so `git@host:owner/repo` is not a match, and the
// password run excludes `/`, so `https://host:8080/path` cannot reach the `@`
// that this needs.
const URL_PASSWORD_RE = /[a-z][a-z0-9+.-]*:[/][/][^\s/@:]+:([^\s/@]{6,})@/gi;

// A labelled value that is not a credential: one that NAMES a credential, and
// one that is a path.
//
// The dominant shape a wide label pattern hits in source and config is an
// environment lookup or the variable holding it, and substituting one of those
// replaces an ordinary identifier everywhere it occurs, which is §F7's
// over-reporting with a wide blast radius. Same kind of cheap post-filter as
// ID_NUMBER_MIN_DIGITS and DATE_SHAPED_RE, and for the same reason.
//
// The path branch is what the wider CREDENTIAL_LABEL_RE above costs, priced
// rather than argued away: a noun-plus-qualifier label admits `s3_key`,
// `object_key` and `blob_path`, whose values are object paths, and the value
// class already allows `/` and `.` because base64 secrets contain both. A value
// carrying a slash and ending in a file extension is a filename, and seeding
// one substitutes that filename throughout the export.
const SECRET_REFERENCE_RE =
  /^(?:process[.]env|os[.]environ|import[.]meta|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|[^ ]*[/][^ /]*[.][A-Za-z0-9]{1,5}$)/;

// A token presented after `Bearer ` in an Authorization header is a credential
// whatever vendor minted it.
//
// Measured on a real export: two live credentials shipped verbatim while the
// manifest printed `0 secrets`. One was a `Bearer v2.…` API token; one was a
// Notion MCP upload JWT whose base64 payload decodes to a purpose, a file
// upload id, a bot id and a space id, so it also carries org UUIDs and
// defeats §F5's UUID residue check. Neither matches any vendor prefix above.
//
// This is the §F7 precision profile rather than an entropy heuristic: the word
// `Bearer` immediately before it is the evidence, and `Bearer` followed by 20
// or more token characters does not occur by accident. Only the token is
// captured, so the word stays and a reader can still see a header was there.
const BEARER_RE = /[Bb]earer[ ]+([A-Za-z0-9][A-Za-z0-9._~+/=-]{19,})/g;

// AWS SigV4 query credentials in a presigned URL.
//
// Measured on the 2026-08-22 corpus: a session held presigned S3 URLs whose
// `X-Amz-Security-Token` is a live session token. It matches no vendor prefix
// (the prefix is on the key id, not the token), it is not a JWT, and no
// `Bearer` precedes it, so all three sweeps above walked past it and the
// manifest printed `0 secrets`. The reviewer could only say "truncated in the
// quotes, so exact removal cannot be guaranteed", which is how a session gets
// dropped for a value the tool could have taken.
//
// Same §F7 posture as BEARER_RE: the parameter name is the evidence and it
// stays, so a reader still sees a signed URL was there. Only the value goes.
const AWS_SIGV4_RE = /X-Amz-(?:Security-Token|Signature|Credential)=([A-Za-z0-9%._~+/-]{20,})/g;

// A JSON Web Token anywhere, header included: `eyJ` is base64 of `{"`. Three
// dot-separated base64url runs is not a shape ordinary prose produces.
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]*/g;

// An identity-document number, taken only where the words beside it say what
// it is. The digit floor is what keeps `U.S. TIN: none` out.
//
// A Latin label must not run straight into its value with no separator at all.
// Every part between label and number is optional, so `dni` matched inside a
// base64 blob: measured over 2 real session files, 13 of the 13 numbers the
// wider label list added were fragments of base64 image data, led by
// `…//dni3t3u5x9y0fsaf…` and `…CDNI627r94nhS…`. The lookahead is on the Latin
// branch only, because it is the one whose labels are short Latin runs, and it
// admits the connector words so that a JSON key like `"passportNumber"` still
// matches. It closes the same hole on the labels that were already here: `ssn`,
// `tin` and `fein` are three, three and four characters of base64 alphabet.
//
// CJK labels need no such guard: base64 is ASCII.
const ID_NUMBER_RE = new RegExp(
  '(?:(?:passport|national id|identity card|id card|driver.?s licen[sc]e|social security|ssn|u[.]?s[.]? tin|tax id|fein|employer identification(?: number)?' +
    // Spanish, measured as returning [] while the English labels beside it
    // worked. It sits in the Latin branch rather than beside the other two new
    // languages below, so that one lookahead covers every Latin label.
    '|pasaporte|dni|c[ée]dula' +
    // The lookahead the comment above this constant explains: a separator, or
    // one of the connector words, so that `passportNumber` still matches and
    // `dni` inside base64 does not.
    ')(?=[^A-Za-z0-9]|no[.]?|number|card)' +
    // The same labels in Chinese. The sweep knew English label words only, so
    // a number named in Chinese was never seeded, never substituted, and
    // invisible to the residual scan, which only looks for what it was given.
    // The Taiwan passport number §F6b records as having shipped 13 times
    // across 5 files was found only because that document was in English.
    //
    // The label-anchored posture is unchanged, which is what keeps §F7's
    // precision: measured over every depth-0 session file on this machine
    // (216 files, 934 MB), these six labels add 2 numbers to the swept set.
    // One is a real national-id number. The other was an ISO date in
    // `舊護照 <date> 到期`, which DATE_SHAPED_RE below now rejects.
    //
    // CJK does not space its words, and every segment between label and number
    // is already optional, so nothing else in the pattern has to change. The
    // fullwidth colon is already in the character class.
    '|護照(?:號碼)?|护照|身分證(?:字號)?|身份證|台胞證|居留證(?:號碼)?' +
    // Japanese, Korean and Spanish, measured as returning [] while the English
    // and Chinese labels beside them worked.
    //
    // There is no shape here, and this is the honest version of that. What is
    // being detected is a MEANING carried by a word, and a word list is what a
    // meaning reduces to. A national-number shape was tried and §F7 records the
    // result: it matched `M1019757`, a thermal-paste part number. So the list
    // stays a list, and it is inherently incomplete: this file now reads six
    // languages, and a passport named in the seventh is invisible to it in
    // exactly the way a passport named in Japanese was invisible until now.
    //
    // The escape hatch for the seventh language already exists and is the one
    // mechanism in this file that is not inference: a number the machine cannot
    // name can be written into known-values.json beside the salt, and arrives
    // through DECLARED_SOURCE. That is where an unlisted language belongs,
    // rather than in a list that grows one incident at a time.
    '|パスポート(?:番号)?|旅券(?:番号)?|マイナンバー' +
    '|여권(?:번호)?|주민등록(?:번호)?)' +
    // Quotes are allowed in the gap for the reason LABELLED_SECRET_RE allows
    // them in its own: the label arrives as a JSON key at least as often as it
    // arrives as prose, and `{"passportNumber": "…"}` matched nothing because
    // the closing quote sat between the connector word and the colon. Only
    // quotes and spaces, so an intervening WORD still breaks the match.
    '["\' ]*(?:no[.]?|number|#|card)?["\' ]*[:：]?["\' ]*([A-Za-z0-9-]{6,14})(?![A-Za-z0-9])',
  'gi',
);
const ID_NUMBER_MIN_DIGITS = 5;

// A date is never a document number, and an expiry date is the thing most
// likely to sit right after the label. English puts a word in between and the
// pattern refuses that, so nobody hit this; Chinese does not space its words,
// and `舊護照 2026-08-24 到期` matched the moment the Chinese labels were
// added. Seeding it would substitute every occurrence of that date across the
// whole export, which is §F7's cry-wolf failure with a very wide blast radius.
const DATE_SHAPED_RE = /^(?:19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/;

// Slack object ids (user, bot, channel, DM, group, team) and Notion page ids.
//
// Slack's shape is a kind letter, a `0`, then 7-9 uppercase alphanumerics.
// Notion's is a bare 32-hex id, taken ONLY after a notion host, because 32 hex
// characters on their own are every content hash in the corpus (§F7).
const SLACK_ID_RE = /(?<![A-Za-z0-9])[UWBCDGT]0[0-9A-Z]{7,9}(?![A-Za-z0-9])/g;
const NOTION_ID_RE = /(?:app[.]notion[.]com|notion[.]so)[/](?:[A-Za-z0-9-]*-)?([0-9a-f]{32})/g;

// Cloud account identifiers: an AWS account id, a GCP project id, an Azure
// subscription id.
//
// Measured: sweepSecrets, sweepIdNumbers, sweepPlatformIds and sweepEmails all
// returned [] on text carrying all three, and seedEntities produced nothing.
// That is a whole class with no producer, not a missing prefix, and it is the
// same join-key hazard the Slack ids above are here for: the pair (pseudonym,
// account id) re-identifies an organisation whose name never appears.
//
// They live in sweepPlatformIds rather than in a new sweep because they are the
// question it already answers: an id of a service these sessions talk to, taken
// only from beside its vendor's own syntax. The Notion rule right above takes a
// bare 32-hex id ONLY after a notion host, for exactly this reason.
//
// This is the class most likely to cry wolf, so every branch is anchored on
// something prose does not produce, and what each one still eats is stated:
//
//   ARN account slot     eats nothing: `arn:` plus four colon-separated fields
//                        plus twelve digits is not a shape prose reaches.
//   `account` + 12 digits
//                        eats a twelve-digit ORDER number labelled `account`,
//                        and a bank account number of that length. Both are
//                        account identifiers, so the failure is benign.
//   GCP project id       eats a hyphenated slug written after `--project` or
//                        `project_id`, including a non-GCP one: a CI config's
//                        `project_id: acme-frontend` becomes an entity. The
//                        projectShaped gate below is what keeps the ordinary
//                        English word out, which is the §F7 case.
//   Azure subscription   eats nothing: a UUID in a literal `subscriptions/`
//                        segment is Azure's own resource-id grammar.
//
// A BARE twelve-digit run with no label is deliberately not matched: twelve
// digits are an order number, an invoice number and a phone number, and §F7
// already records what a shape-only numeric rule costs. A GCP project id after
// a bare `projects/` is not matched either, because `projects/` is the most
// ordinary directory name there is and the id slot would eat the repo name out
// of every path on this machine.
const LABEL_GAP = /[^0-9\n]{0,8}/.source;
const SLUG_GAP = /["' :=]{1,6}/.source;
const CLOUD_ID_RE = new RegExp(
  [
    'arn:[a-z0-9-]+:[a-z0-9-]*:[a-z0-9-]*:([0-9]{12})[:/]',
    `(?:aws[_ -]?)?account(?:[_ -]?id)?${LABEL_GAP}([0-9]{12})(?![0-9])`,
    `(?:--project[ =]|(?:gcp[_-]?)?project[_-]?id${SLUG_GAP})([a-z][a-z0-9-]{4,28}[a-z0-9])(?![a-z0-9-])`,
    'subscriptions/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
  ].join('|'),
  'gi',
);

// Cheap pre-test, the same one `text.includes('notion')` is below: the sweep
// above is four alternations wide and most strings contain none of them.
const CLOUD_HINT_RE = /arn:|account|--project|project[_-]?id|subscriptions[/]/i;

// The only form an MCP tool name takes in these logs. The name itself may
// contain single underscores (`claude_ai_Gmail`); the separator is a double.
const MCP_TOOL_RE = /mcp__([A-Za-z0-9][A-Za-z0-9_-]*?)__[A-Za-z0-9]/g;

// The same name written in prose without a tool after it, `mcp__plugin_
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
  const sweep = (text, re, group, reject = null) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = group === 0 ? m[0] : m[group];
      if (typeof value === 'string' && value.length > 0 && (reject === null || !reject.test(value))) {
        found.add(value);
      }
      if (found.size > 1000) return true;
    }
    return false;
  };
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    if (sweep(text, SECRET_RE, 0)) break;
    if (/earer/.test(text) && sweep(text, BEARER_RE, 1)) break;
    if (text.includes('eyJ') && sweep(text, JWT_RE, 0)) break;
    if (text.includes('X-Amz-') && sweep(text, AWS_SIGV4_RE, 1)) break;
    if (/key|token|pass|secret/i.test(text) && sweep(text, LABELLED_SECRET_RE, 1, SECRET_REFERENCE_RE)) break;
    if (text.includes('://') && sweep(text, URL_PASSWORD_RE, 1)) break;
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
      if (DATE_SHAPED_RE.test(m[1])) continue;
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
    if (CLOUD_HINT_RE.test(text)) {
      CLOUD_ID_RE.lastIndex = 0;
      while ((m = CLOUD_ID_RE.exec(text)) !== null) {
        // One alternation, four capture groups, exactly one of them defined.
        const value = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (value === undefined) continue;
        // Group 3 is the GCP project id, the only branch whose value can be an
        // ordinary English word. Same gate the project-basename seed uses, for
        // the same reason: without it `project_id: dashboard` makes an entity
        // of `dashboard` and substitutes it throughout the prose.
        if (m[3] !== undefined && !projectShaped(value)) continue;
        found.add(value);
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
// contact table. The digits below are fabricated (the 555-01xx reserved
// range); the four PUNCTUATION shapes are the real ones and are the whole
// point, because §F6b matched none of them:
// `(+852) 5550 0142`, `M: +1 (650) 555 0148`, `(650) 555-0173`,
// `801-555-0119`. §F6b required a leading `+`, a country code and 8-15 digits
// CONTIGUOUSLY, so it fired only on the one form that does not appear in a
// signature block.
//
// Two shapes, both §F7-precise:
//   1. a parenthesised country or area code, which prose does not produce;
//   2. a bare 3-3-4 with a consistent `-` or `.` separator, bounded so a date
//      (2026-08-22) and a longer digit run cannot match.
const PHONE_PAREN_RE = /(?:[+][0-9]{1,3}[ ]?)?[(][+]?[0-9]{1,4}[)][ ]?[0-9]{2,4}(?:[ .-][0-9]{2,4}){1,3}/g;
const PHONE_DASHED_RE = /(?<![0-9-.])[0-9]{3}([-.])[0-9]{3}\1[0-9]{4}(?![0-9-.])/g;

// A number written in its own country's NATIONAL format, which by definition
// carries no country code.
//
// Measured: sweepPhones('0912-345-678') and sweepPhones('0912345678') both
// returned []. Every rule above is anchored on a leading `+`, on parentheses,
// or on the North American 3-3-4, and a national number has none of those. The
// three rules were the author's own three formats.
//
// The trunk prefix is the anchor. Outside North America a national number is
// written with a leading `0` that is not part of the number, and prose does not
// start a grouped digit run with a zero: `in 2024 300 000 units` is three
// space-separated groups totalling ten digits and is rejected on its first
// character. So is a date, which starts with `19` or `20`.
//
// The two bounds are both measured rather than assumed. Run over 2 real session
// files, a first draft with `(?<![0-9])` and 2-to-4-digit groups added 71
// numbers, and 68 of them were fragments of UUIDs: `…-5d03-4325-8145-…` yields
// `03-4325-8145`, because the character before the `03` is a hex LETTER and a
// digit-only lookbehind lets it through. Playwright snapshot filenames
// (`page-2026-08-08T03-54-27-281Z`) supplied most of the rest. That is §F7's
// cry-wolf failure with the widest possible blast radius, since every session
// file is mostly UUIDs.
//
//   letters and hyphens in the boundaries   kills the UUID fragment: a real
//                                           number is not glued to hex.
//   groups of 3 or 4 digits, never 2        kills the timestamp shape, whose
//                                           groups are hours, minutes, seconds.
//
// What it still eats: a grouped digit run of 9 to 11 digits that starts with a
// zero and is not a phone number, such as a zero-padded reference written
// `0123-456-789`. Nothing in the corpus produced one.
const PHONE_TRUNK_RE = /(?<![0-9A-Za-z-])0[0-9]{1,3}([-. ])[0-9]{3,4}(?:\1[0-9]{3,4}){1,2}(?![0-9A-Za-z-])/g;

// The same number written with no separator at all, taken only where a word
// beside it says it is a telephone number.
//
// A contiguous ten-digit run is also a unix timestamp, an order number and a
// part number, so there is nothing in the SHAPE to match on: `0912345678`
// carries no more evidence than `1755820800` does. §F7 is why this is
// label-anchored, which is the same answer ID_NUMBER_RE gives to the same
// question about a passport number.
//
// What it wrongly eats: a digit run after a word that contains a phone label,
// such as `phone_number_id: 123456789012345`, a WhatsApp Business API
// identifier. That is an identifier of the same person, so the failure is
// benign. The label list is English plus the two CJK spellings, and it is
// inherently incomplete for the reason ID_NUMBER_RE's is.
//
// Parentheses are deliberately NOT in the value class. With them in, measured
// on real text, `Helpdesk (852) 2748 8288` captured `852) 2748 8288`: a needle
// starting inside a bracket pair, which substitutes half a punctuation mark.
// PHONE_PAREN_RE already owns the parenthesised form, so the label rule leaving
// it alone costs nothing.
//
// The boundaries are PHONE_TRUNK_RE's, for the reason measured there: without
// them the value runs into a UUID or a hex digest sitting next to a label.
//
// `whatsapp` was in the label list and came out. It is the name of an app, not
// a word for a telephone number, and it turns up in filenames: measured on real
// text, `WhatsApp Video 2026-07-11 at 12.25.2` in a directory listing seeded
// the DATE as a phone number. The two survivors of that shape are rejected by
// DATE_SHAPED_RE in sweepPhones, which is the same filter sweepIdNumbers
// already applies for the same reason.
//
// A backslash is excluded from the gap for a related reason. These records hold
// JSON-escaped prose, so a line break between a label and a number is the two
// characters `\` and `n`, which a class excluding a real newline lets straight
// through. Measured: a label crossed two escaped line breaks and a bullet
// marker to reach the timestamp of the NEXT paragraph. A backslash between a
// label and a value means a boundary was crossed, whatever the boundary was.
const PHONE_LABEL_RE =
  /(?:(?<![A-Za-z])(?:telephone|mobile|phone|tel|cell|fax)(?![A-Za-z])|手機|手机|電話|电话)[^0-9+\n\\]{0,12}(?<![A-Za-z-])([+]?[0-9][0-9 .-]{5,18}[0-9])(?![0-9A-Za-z-])/gi;

/**
 * Distinct E.164-shaped phone numbers in `texts`.
 *
 * The one shape that would over-match is a unified-diff added line, which also
 * begins with a plus and can be all digits, so a separatorless run at the start
 * of a line is not treated as a number. §F7: precision over recall.
 */
// The cheap pre-test for PHONE_LABEL_RE, which is the widest rule here.
const PHONE_LABEL_HINT_RE = /tel|phone|mobile|cell|fax|手機|手机|電話|电话/i;

export function sweepPhones(texts) {
  const newline = String.fromCharCode(10);
  const found = new Set();
  // `group` is 1 for the label-anchored rule, whose match includes the label
  // word: seeding `Mobile: 0912345678` would substitute the word `Mobile` too.
  const take = (text, re, min, max, group = 0) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = (group === 0 ? m[0] : m[group] ?? '').trim();
      const digits = value.replace(/[^0-9]/g, '').length;
      if (digits < min || digits > max) continue;
      // An ISO date is eight digits with two separators and sits next to a word
      // like `phone` more often than it should. Same filter, same reason, as
      // sweepIdNumbers: seeding a date substitutes every occurrence of it in
      // the export, which is §F7's cry-wolf failure at its widest.
      //
      // Tested on the first ten characters rather than on the whole value,
      // because a date arrives with a time glued to it: measured on real text,
      // a phone label reached `2026-08-21 01:58 UTC` in the next paragraph and
      // seeded `2026-08-21 01`, which an anchored test walks straight past.
      if (DATE_SHAPED_RE.test(value.slice(0, 10))) continue;
      // The diff-line guard applies to the shape-only rules only. A match that
      // begins with a label word cannot be a unified-diff `+` marker, and the
      // guard misfired on it: `Mobile: 0912345678` at the start of a line has
      // no separator in its VALUE, so every label-anchored number on a first
      // line was thrown away.
      const atLineStart = m.index === 0 || text[m.index - 1] === newline;
      if (group === 0 && atLineStart && !SEPARATOR_RE.test(value)) continue;
      found.add(value);
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
    // A national number is 9 to 11 digits including the trunk `0`.
    if (text.includes('0') && take(text, PHONE_TRUNK_RE, 9, 11)) break;
    if (PHONE_LABEL_HINT_RE.test(text) && take(text, PHONE_LABEL_RE, 7, 15, 1)) break;
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
        // Matched with no boundary test (see looseVariants).
        looseSpellings: rejected ? Object.freeze([]) : looseVariants(e.canonical),
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
      if (!parsed) continue;
      // `all` is every remote of that checkout; the bare object is the first
      // one. Two paths answered one question differently: the loop below reads
      // every line of `git remote -v`, and the SHIPPED export path hands this
      // function the shared probe, which answered with one. Measured on a fork
      // checkout, the `upstream` owner and repo were never entities on the path
      // the tool actually runs.
      //
      // The fallback keeps a probe that carries no `all` meaning "one remote",
      // which is what proposeTier's own callers and every injected test probe
      // pass.
      for (const remote of parsed.all ?? [parsed]) {
        if (remote && !seen.has(remote.raw)) seen.set(remote.raw, remote);
      }
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

/**
 * Every distinct `user.name` and `user.email` configured across `dirs`.
 *
 * Read off the SAME memoised probe gitRemotes uses, so no repository is spawned
 * for twice. Names and emails are separate sets rather than pairs: git reports
 * every level that sets a key, so one checkout can report a personal identity
 * and a work one, and both are entities. Deduped because forty checkouts under
 * one employer share one identity and would otherwise be added forty times.
 */
function gitIdentities(dirs, probeRemote) {
  const names = new Set();
  const emails = new Set();
  if (probeRemote !== null) {
    for (const dir of dirs) {
      const probed = probeRemote(dir);
      if (!probed || typeof probed !== 'object') continue;
      for (const [from, into] of [[probed.names, names], [probed.emails, emails]]) {
        for (const value of from ?? []) {
          if (typeof value === 'string' && value.trim() !== '') into.add(value.trim());
        }
      }
    }
  }
  return Object.freeze({ names: [...names], emails: [...emails] });
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
  const home = homeDir(env);
  // nonBlank, not `??`: `??` treats only null and undefined as absent, so an
  // empty CLAUDE_CONFIG_DIR survived and path.join('', 'settings.json') became
  // a bare relative path read against the cwd. root.mjs diagnoses this exact
  // failure for this exact variable and fixes it the same way; the fix had not
  // been propagated to its sibling. The warning below could not report it
  // either, because ~/.claude.json is one of the three candidates and sets the
  // found flag, so the seeder silently lost only settings.json and .mcp.json.
  const configDir = nonBlank(env.CLAUDE_CONFIG_DIR) ?? (home === null ? null : path.join(home, '.claude'));
  if (configDir === null) {
    warnings.push('no home directory and no CLAUDE_CONFIG_DIR; MCP server names were not seeded');
    return [];
  }
  const candidates = [
    ...(home === null ? [] : [path.join(home, '.claude.json')]),
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
