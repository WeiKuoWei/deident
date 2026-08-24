// The runtime floor, checked before any work rather than at the last write.
//
// `node:zlib`'s crc32 arrived in Node 20.15 and 22.2, and it is used in exactly
// one place: buildZip, which is step 17 of 17. On an older Node a person reads
// the corpus, classifies it, substitutes, passes all five gates, and only then
// gets `TypeError: crc32 is not a function` - which the entry point wraps as
// "internal error, please report this". That is the shape BRIEF section 2
// forbids, arriving after ten minutes of work, for something knowable in
// microseconds.
//
// A package.json `engines` field does not do this. npm's engine-strict defaults
// to false, so it warns and proceeds, and the documented way to run this is
// `node deident.mjs`, where npm is not involved at all. The check has to be in
// the program.

import { UsageError } from './errors.mjs';

/**
 * Two floors, because Node maintains two lines and the feature landed in both.
 *
 * `major` is the lowest major that can ever work; the per-major minors are what
 * that line actually needs. Rejecting 20.x wholesale for being older than 22
 * would refuse a runtime that works.
 */
export const REQUIRED_NODE = Object.freeze({
  major: 20,
  minors: Object.freeze({ 20: 15, 22: 2 }),
  because: 'node:zlib crc32, used to write the archive',
});

/**
 * @param {{node?: string}} versions usually `{ node: process.version }`
 * @returns {UsageError|null} null when the runtime is supported
 */
export function checkRuntime({ node } = {}) {
  const m = typeof node === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(node) : null;
  if (m === null) {
    // Not treated as fine. The failure direction of guessing here is a
    // ten-minute run that ends in a traceback.
    return refuse(node === undefined ? '(none reported)' : String(node), [
      'deident could not read the Node version it is running on.',
    ]);
  }

  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < REQUIRED_NODE.major) return refuse(node, tooOld(major, minor));
  const floor = REQUIRED_NODE.minors[major];
  if (floor !== undefined && minor < floor) return refuse(node, tooOld(major, minor));
  return null;
}

function tooOld(major, minor) {
  const pairs = Object.entries(REQUIRED_NODE.minors)
    .map(([maj, min]) => `${maj}.${min}`)
    .join(' or ');
  return [
    `deident needs ${REQUIRED_NODE.because}, which arrived in Node ${pairs}.`,
    `This is Node ${major}.${minor}, so the export would run for minutes and then`,
    'fail at the last step, when it writes the archive. Refusing now instead.',
  ];
}

function refuse(found, why) {
  return new UsageError(`Node ${found} is below the version deident needs`, {
    why,
    remedies: [
      { label: 'Check what you have', command: 'node --version' },
      { label: 'Or point at a newer one', command: 'path/to/newer/node deident.mjs --version' },
    ],
  });
}
