// Read one session file, parse each line, and assert the serialization
// invariant I1 on the *untouched* input: stringify(parse(line)) === line.
//
// PLAN §2: this runs first, before any substitution. Once a string has been
// substituted the check tests our serializer against our own output and can
// only pass. Its job is to detect a future Claude Code writer whose format we
// fail to round-trip (BRIEF §4.7b), and run late it detects nothing.

import fs from 'node:fs';
import { ReadError, RefusalError } from '../cli/errors.mjs';

// U+FFFD, written without an escape so no editing round-trip can mangle it.
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * @param {string} filePath
 * @param {{skipUnreadable?: boolean, keepRaw?: boolean, inspect?: Function}} opts
 *   keepRaw: false drops each record's raw line text once it has been checked.
 *     The raw text is as large as the file itself, and the export pass has no
 *     use for it, holding it is a second copy of the corpus for nothing.
 *   inspect(line, lineNo): called with the raw text of every parsed line, so a
 *     caller that needs to look at raw lines (the namespace collision check)
 *     can do so without the reader accumulating them.
 * @returns {Readonly<{path, records, badLines, bytes, lineCount, roundTripFailures}>}
 *   records: [{index, line?, value}] in file order, 1-based `index`.
 */
export function readSession(filePath, opts = {}) {
  const skip = opts.skipUnreadable === true;
  const keepRaw = opts.keepRaw !== false;
  const inspect = typeof opts.inspect === 'function' ? opts.inspect : null;

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    throw new ReadError(`could not open ${filePath}`, {
      detail: {
        file: filePath,
        line: null,
        parserMessage: `${err.code}: ${err.message}`,
        likelyCause: 'The file was removed or is locked by another process.',
      },
    });
  }

  const raw = buf.toString('utf8');
  const bytes = buf.length;

  // The serialization invariant is reported as "byte-identical", and it cannot
  // be that while the comparison happens against an already-lossily-decoded
  // string. `readFileSync(path, 'utf8')` replaces every invalid byte with
  // U+FFFD, so `stringify(parse(line)) === line` compares two strings that both
  // already lost the bytes, the check can never see the damage, by
  // construction, and the report still says byte-identical.
  //
  // Re-encoding is the cheap proof: a lossless decode round-trips. It is only
  // attempted when U+FFFD is actually present, so the common path costs one
  // substring search rather than a second copy of the file.
  const lossyUtf8 = raw.includes(REPLACEMENT_CHAR) && Buffer.compare(Buffer.from(raw, 'utf8'), buf) !== 0;
  buf = null;

  // A BOM is legal in the file but is not part of the first JSON line.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const records = [];
  const badLines = [];
  const roundTripFailures = [];
  if (lossyUtf8) {
    roundTripFailures.push(Object.freeze({ file: filePath, line: null, why: 'invalid UTF-8 bytes' }));
  }

  // Split on \n and tolerate a trailing \r (Git Bash / Windows editors) and a
  // trailing newline. An empty file yields zero records, not an error (F19).
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim() === '') continue;

    const lineNo = i + 1;
    let value;
    try {
      value = JSON.parse(line);
    } catch (err) {
      // Pathologically nested JSON exhausts the JS stack rather than failing to
      // parse. That is a property of the INPUT, so it is a read error naming
      // the file and the line (exit 3), not "a bug in deident" (exit 1).
      //
      // The `skip` test comes FIRST. It used to come second, so the refusal
      // told the user to run --skip-unreadable and running it produced the
      // identical exit 3: a remedy that cannot work is worse than none
      // (cli-ux §8). A record nobody can parse is a record nobody can export,
      // so skipping it is exactly what the flag means.
      if (err instanceof RangeError && !skip) throw nestingError(filePath, lineNo, err);
      if (!skip) {
        throw new ReadError('unparseable line', {
          detail: {
            file: filePath,
            line: lineNo,
            parserMessage: err.message,
            likelyCause:
              i === lines.length - 1 || i === lines.length - 2
                ? 'This usually means the session was still being written. Close that Claude Code session.'
                : 'A line in the middle of the file is truncated, which usually means the file was interrupted mid-write.',
          },
        });
      }
      badLines.push(Object.freeze({ line: lineNo, message: err.message }));
      continue;
    }

    // I1. Recorded rather than thrown here so the caller can report every
    // failing line at once; runAllChecks turns a non-empty list into a refusal.
    try {
      if (JSON.stringify(value) !== line) {
        roundTripFailures.push(Object.freeze({ file: filePath, line: lineNo }));
      }
    } catch (err) {
      // Same rule as the parse above: a record too deep to re-serialize is a
      // record too deep to export, so --skip-unreadable skips it rather than
      // offering a remedy that does nothing.
      if (err instanceof RangeError && skip) {
        badLines.push(Object.freeze({ line: lineNo, message: err.message }));
        continue;
      }
      if (err instanceof RangeError) throw nestingError(filePath, lineNo, err);
      throw err;
    }

    if (inspect !== null) inspect(line, lineNo);
    records.push(Object.freeze(keepRaw ? { index: lineNo, line, value } : { index: lineNo, value }));
  }

  return Object.freeze({
    path: filePath,
    records: Object.freeze(records),
    badLines: Object.freeze(badLines),
    roundTripFailures: Object.freeze(roundTripFailures),
    bytes,
    lineCount: records.length + badLines.length,
  });
}

/**
 * A record nested deeply enough to exhaust the JS stack.
 *
 * Every walker in the pipeline is recursive, so this is a property of the
 * input and belongs in the same shape as an unparseable line: exit 3, the file
 * and the line named. Reported as "a bug in deident" it sends the user to file
 * an issue about their own data.
 */
export function nestingError(filePath, lineNo, err) {
  return new ReadError('a record is nested too deeply to process', {
    detail: {
      file: filePath,
      line: lineNo,
      parserMessage: err && err.message ? err.message : 'stack exhausted',
      likelyCause:
        'This record nests JSON thousands of levels deep, which exhausts the stack every walker in deident uses.',
      remedy: 'Skip the record with --skip-unreadable.',
    },
  });
}

/**
 * The I1 refusal. Separated from the reader so the reader stays a pure
 * boundary and the wording stays with the other refusals.
 */
export function roundTripRefusal(failures) {
  const first = failures.slice(0, 5);
  return new RefusalError(
    `${failures.length} input${failures.length === 1 ? '' : 's'} do not round-trip byte-identically`,
    {
      why: [
        "Claude Code's log format has changed in a way deident does not round-trip,",
        'or a file contains bytes that are not valid UTF-8. Substituting inside a',
        'format we cannot re-serialize byte-identically risks corrupting the record',
        'or silently dropping a field. Do not export; report this.',
        '',
        ...first.map((f) =>
          f.line === null || f.line === undefined
            ? `  ${f.file}  ${f.why ?? 'does not round-trip'}`
            : `  ${f.file}  line ${f.line}`,
        ),
      ],
      remedies: [{ label: 'Report with the lines above', command: 'file an issue against deident' }],
      detail: { failures: failures.length },
    },
  );
}
