// Expand one spelling into every form observed IN ALREADY-DECODED STRINGS.
//
// BRIEF §4.6 measured, in decoded strings:
//   C:\Users\devuser   26,505     C:/Users/devuser    1,838
//   /c/Users/devuser      306     C:\\Users\\devuser     94  (inside embedded JSON)
//   case-variant only     7
// plus URL-encoded (%3Ddevuser%40gitroll.io) and \uXXXX-escaped CJK inside
// embedded JSON.
//
// Pure. No I/O. Every branch is covered by fixture F13.

/** Does this look like a Windows/POSIX absolute path rather than a bare name? */
export function looksLikePath(s) {
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.includes('\\') || s.includes('/');
}

/**
 * @param {string} spelling
 * @returns {ReadonlyArray<string>} the spelling plus every variant, deduped,
 *   longest first. The input is always element 0 of the deduped set.
 */
export function expandVariants(spelling, opts = {}) {
  if (typeof spelling !== 'string' || spelling.length === 0) return Object.freeze([]);

  const out = new Set([spelling]);

  // Unicode normalisation, both directions.
  //
  // The macOS case, and there it is the default rather than an edge: APFS and
  // HFS+ store filenames DECOMPOSED, so every path and filename read off a Mac
  // arrives in NFD while the same name typed by the person, returned by
  // `git config`, or pasted into an entity list is NFC. Measured before this
  // existed: an entity declared NFC matched nothing in NFD text and the reverse
  // matched nothing either, with zero normalize() calls in the source.
  //
  // Both forms are carried as SPELLINGS rather than folded in the matcher,
  // because matchesAt measures its span as `at + entry.spelling.length` and
  // the two forms have different lengths. As spellings each keeps its own, the
  // matcher stays literal, and reversal restores whichever form was actually
  // in the text — which matters for a path, since a Mac filename put back
  // recomposed no longer names the file it came from.
  //
  // Free for ASCII: both normalisations return the identical string and the Set
  // absorbs it.
  for (const form of [spelling.normalize('NFC'), spelling.normalize('NFD')]) out.add(form);

  if (looksLikePath(spelling)) {
    for (const form of pathForms(spelling, opts.home ?? null)) out.add(form);
  }

  // URL/percent encoding, for non-path spellings only. The measured case is
  // `%3Ddevuser%40gitroll.io` — an email inside a URL query. Percent-encoding
  // every separator of every path root as well would multiply the needle set
  // twenty-fold for forms never observed, and §F7 says tune for precision.
  if (!looksLikePath(spelling)) {
    const enc = percentEncode(spelling);
    if (enc !== spelling) {
      out.add(enc);
      out.add(enc.replace(/%([0-9A-F]{2})/g, (m, h) => `%${h.toLowerCase()}`));
      // DOUBLE percent-encoding, which is what a URL that was itself put in a
      // query string looks like. Measured on a real export:
      // `…authuser%3DX_PERSON_465285%2540gitroll.io` — `%2540` is an encoded
      // `%40`, so the domain sat in plaintext beside the pseudonym of the
      // person whose address it is.
      const dbl = enc.replace(/%/g, '%25');
      out.add(dbl);
      out.add(dbl.replace(/%25([0-9A-F]{2})/g, (m, h) => `%25${h.toLowerCase()}`));
    }
  }

  // The domain/URL spelling of a multi-word name.
  //
  // Measured on a real export: `accountant = X_ORG_1684551
  // https://www.norbrookvan…ory.com` — 15 occurrences of the pseudonym and the
  // plaintext identity of the same org on one line. A pseudonym whose original
  // appears in the same sentence has done nothing. The squashed form is what a
  // company writes as its domain and as its handle, and at eight characters or
  // more it cannot collide with an ordinary word.
  const squashed = squashedForm(spelling);
  if (squashed !== null) out.add(squashed);

  // Backslash-u escaping of any non-ASCII codepoint, as seen inside embedded
  // JSON that was itself stored as a string. Applied to the original spelling
  // only: an escaped form of an escaped form does not occur.
  const uEsc = backslashUEscape(spelling);
  if (uEsc !== spelling) {
    out.add(uEsc);
    out.add(uEsc.toUpperCase().replace(/\\U/g, '\\u'));
  }

  return Object.freeze(
    [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The four separator/escaping forms of a path, plus their case variants. */
function pathForms(spelling, home = null) {
  const forms = new Set();

  // POSIX spellings of the same POSIX path. Windows paths take the drive-letter
  // branch below and never reach these.
  //
  // The tilde: `/Users/x/app` and `~/app` are one path, and both appear in the
  // same session, because a shell prompt and a person prefer the short form
  // while realpath and the log records carry the long one. The home directory
  // is the most heavily seeded entity there is, so on macOS and Linux half its
  // spellings were missing.
  //
  // Recognised structurally rather than by consulting os.homedir(), so the
  // generator stays pure and works for a corpus recorded on someone else's
  // machine. A second segment is required: `/Users` alone is not a home
  // directory and giving it a tilde form would be a needle that matches every
  // path on the volume.
  const posixHome = /^\/(Users|home)\/([^/]+)(\/.+)$/.exec(spelling);
  if (posixHome !== null) {
    // Something UNDER the home directory, never the home directory itself.
    // seed.mjs adds the bare home path on every run, and an optional tail here
    // turned that into the one-character needle `~`. A tilde is not a word
    // character, so buildTable gives it no boundary rule, and every tilde in
    // the corpus is replaced: `cd ~`, `~/.zshrc`, and `approx ~5 min` becoming
    // a pseudonym with a digit welded to it. All five gates stay green, because
    // the residue scan looks for the spellings it was handed.
    //
    // The home directory has a full spelling that IS safe to replace, and it is
    // already in the table; it does not need a one-character alias.
    forms.add(`~${posixHome[3]}`);
  } else if (spelling.startsWith('~/') && typeof home === 'string' && home.length > 0) {
    forms.add(home.replace(/\/$/, '') + spelling.slice(1));
  }

  // /var, /tmp and /etc are symlinks into /private on macOS, so realpath
  // returns the long form for a path the person wrote short. Both spellings
  // name the same file and both occur, one from the filesystem and one from
  // the human.
  const PRIVATE_ROOTS = ['var', 'tmp', 'etc'];
  for (const root of PRIVATE_ROOTS) {
    if (spelling.startsWith(`/${root}/`)) forms.add(`/private${spelling}`);
    else if (spelling.startsWith(`/private/${root}/`)) forms.add(spelling.slice('/private'.length));
  }

  // Canonicalise to forward slashes with a drive letter, then re-emit.
  const drive = /^([A-Za-z]):[\\/]/.exec(spelling);
  const gitBash = /^\/([A-Za-z])\//.exec(spelling);

  let letter = null;
  let rest = null;
  if (drive) {
    letter = drive[1];
    rest = spelling.slice(3);
  } else if (gitBash) {
    letter = gitBash[1];
    rest = spelling.slice(3);
  }

  if (letter !== null) {
    const body = rest.replace(/\\/g, '/');
    const bodyBack = body.replace(/\//g, '\\');
    const bodyDoubled = body.replace(/\//g, '\\\\');
    forms.add(`${letter.toUpperCase()}:\\${bodyBack}`);
    forms.add(`${letter.toUpperCase()}:/${body}`);
    forms.add(`${letter.toUpperCase()}:\\\\${bodyDoubled}`);
    forms.add(`${letter.toLowerCase()}:\\${bodyBack}`);
    forms.add(`${letter.toLowerCase()}:/${body}`);
    forms.add(`/${letter.toLowerCase()}/${body}`);
    forms.add(`/${letter.toUpperCase()}/${body}`);
  } else {
    // A relative or POSIX-rooted fragment: separators only.
    forms.add(spelling.replace(/\\/g, '/'));
    forms.add(spelling.replace(/\//g, '\\'));
    forms.add(spelling.replace(/\//g, '\\\\').replace(/(?<!\\)\\(?!\\)/g, '\\\\'));
  }

  return forms;
}

const MIN_SQUASHED_LENGTH = 8;
const MIN_BASE64_LENGTH = 10;

/**
 * `Norbrook Vance Advisory` -> `norbrookvanceadvisory`, the form that becomes a domain,
 * a handle or a slug. Null when the spelling is one word, a path, or too short
 * for the squashed form to be distinctive.
 */
export function squashedForm(spelling) {
  if (looksLikePath(spelling) || !/[ .'&-]/.test(spelling)) return null;
  const squashed = spelling.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
  if (squashed.length < MIN_SQUASHED_LENGTH || squashed === spelling.toLowerCase()) return null;
  return squashed;
}

/**
 * Variants that must match WITHOUT the word-boundary rule.
 *
 * A base64 needle lives inside a longer base64 run by construction, so both of
 * its neighbours are word characters and §4.5's boundary rule refuses it every
 * time. These are kept in their own list, and buildTable applies them with no
 * boundary test, so the exemption is explicit and applies to nothing else.
 *
 * Only spellings carrying an at-sign: the measured case is an address inside a
 * URL (`…mcgZGV2dXNlckBub3J0aHdpbmQuZXhhbXBsZQ%26…`, 30 occurrences, decoding to the
 * uploader's own work address), and base64-expanding every entity would
 * multiply a 2,778-spelling table for forms that do not occur (§F7).
 */
export function looseVariants(spelling) {
  if (typeof spelling !== 'string' || !spelling.includes('@') || spelling.length < MIN_BASE64_LENGTH) {
    return Object.freeze([]);
  }
  return Object.freeze(base64Forms(spelling));
}

/**
 * Substrings guaranteed to appear in ANY base64 encoding that contains `s`.
 *
 * base64 packs three bytes into four characters, so where `s` starts inside
 * the encoded stream decides the alignment. Encoding it at each of the three
 * offsets and trimming the partial characters at both ends gives one needle
 * per alignment, and one of the three always matches.
 */
export function base64Forms(s) {
  const out = new Set();
  for (let pad = 0; pad < 3; pad += 1) {
    const encoded = Buffer.from('#'.repeat(pad) + s, 'utf8').toString('base64');
    const core = encoded.slice(Math.ceil((pad * 4) / 3)).replace(/=+$/, '');
    // The last character encodes bits of whatever follows, so drop it.
    const needle = core.slice(0, Math.max(0, core.length - 1));
    if (needle.length >= MIN_BASE64_LENGTH) out.add(needle);
  }
  return [...out];
}

const PERCENT_MAP = Object.freeze({
  '@': '%40',
  ':': '%3A',
  '/': '%2F',
  '\\': '%5C',
  ' ': '%20',
});

function percentEncode(s) {
  let out = '';
  for (const ch of s) out += PERCENT_MAP[ch] ?? ch;
  return out;
}

/** Non-ASCII -> \uXXXX, matching JSON.stringify's escaping of the same text. */
export function backslashUEscape(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    out += code < 0x80 ? s[i] : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/**
 * Scripts that do not put spaces between words.
 *
 * The predicate below used to mean "contains no ASCII letter or digit", which
 * put every non-Latin script in the same bucket. Measured by running the
 * engine: `Роман` inside `романы` (novels) became `PERSON_01ы`, `דוד` inside
 * `דודה` (aunt) became `PERSON_03ה`, and both spans came back flagged CJK. That
 * is BRIEF §4.5's `小明` inside `小明天` failure reproduced in scripts where the
 * writing system does not force it: Cyrillic, Greek, Hebrew and Arabic are
 * space-delimited and the boundary rule works perfectly for them the moment the
 * character class stops being ASCII.
 *
 * So the test is the writing system, not the alphabet. What is in here has no
 * word boundary to check, runs unguarded, and is flagged for review, which is
 * the honest handling §4.5 asks for. Everything else gets the ordinary rule.
 */
export const SPACELESS_RE =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{sc=Tibetan}]/u;

/** True when a spelling is written in a script that has no word boundaries. */
export function isCjkOnly(s) {
  return !/[A-Za-z0-9]/.test(s) && SPACELESS_RE.test(s);
}
