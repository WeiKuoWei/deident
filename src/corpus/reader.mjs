// Read one session file, parse each line, and assert the serialization
// invariant I1 on the *untouched* input: stringify(parse(line)) === line.
//
// PLAN §2: this runs first, before any substitution. Once a string has been
// substituted the check tests our serializer against our own output and can
// only pass. Its job is to detect a future Claude Code writer whose format we
// fail to round-trip (BRIEF §4.7b), and run late it detects nothing.

import fs from 'node:fs';
import { ReadError, RefusalError } from '../cli/errors.mjs';

/**
 * @param {string} filePath
 * @param {{skipUnreadable?: boolean}} opts
 * @returns {Readonly<{path, records, badLines, bytes, lineCount, roundTripFailures}>}
 *   records: [{index, line, value}] in file order, 1-based `index`.
 */
export function readSession(filePath, opts = {}) {
  const skip = opts.skipUnreadable === true;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
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

  // A BOM is legal in the file but is not part of the first JSON line.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const records = [];
  const badLines = [];
  const roundTripFailures = [];

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
    if (JSON.stringify(value) !== line) {
      roundTripFailures.push(Object.freeze({ file: filePath, line: lineNo }));
    }

    records.push(Object.freeze({ index: lineNo, line, value }));
  }

  return Object.freeze({
    path: filePath,
    records: Object.freeze(records),
    badLines: Object.freeze(badLines),
    roundTripFailures: Object.freeze(roundTripFailures),
    bytes: Buffer.byteLength(raw, 'utf8'),
    lineCount: records.length + badLines.length,
  });
}

/**
 * The I1 refusal. Separated from the reader so the reader stays a pure
 * boundary and the wording stays with the other refusals.
 */
export function roundTripRefusal(failures) {
  const first = failures.slice(0, 5);
  return new RefusalError(
    `${failures.length} line${failures.length === 1 ? '' : 's'} do not round-trip through JSON.parse/stringify`,
    {
      why: [
        "Claude Code's log format has changed in a way deident does not round-trip.",
        'Substituting inside a format we cannot re-serialize byte-identically risks',
        'corrupting the record or silently dropping a field. Do not export; report this.',
        '',
        ...first.map((f) => `  ${f.file}  line ${f.line}`),
      ],
      remedies: [{ label: 'Report with the lines above', command: 'file an issue against deident' }],
      detail: { failures: failures.length },
    },
  );
}
