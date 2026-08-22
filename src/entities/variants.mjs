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
export function expandVariants(spelling) {
  if (typeof spelling !== 'string' || spelling.length === 0) return Object.freeze([]);

  const out = new Set([spelling]);

  if (looksLikePath(spelling)) {
    for (const form of pathForms(spelling)) out.add(form);
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
    }
  }

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
function pathForms(spelling) {
  const forms = new Set();

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

/** True when a spelling contains no ASCII letter or digit at all (CJK etc.). */
export function isCjkOnly(s) {
  return !/[A-Za-z0-9]/.test(s) && /[^\x00-\x7F]/.test(s);
}
