#!/usr/bin/env node
/* eslint-disable */
'use strict';
//
// The version gate, in ES5, because the version it exists to reject cannot
// parse anything newer.
//
// Measured 2026-08-24 in a clean Ubuntu 20.04 container. `apt-get install
// nodejs` there gives Node 10.19, which is what a teammate on a stock LTS box
// actually has. Running the tool on it printed:
//
//     /root/deident/deident.mjs:9
//     import { parseCliArgs } from './src/cli/args.mjs';
//            ^
//     SyntaxError: Unexpected token {
//         at Module._compile (internal/modules/cjs/loader.js:723:23)
//         ... 7 more frames
//
// src/cli/runtime.mjs exists to stop exactly that picture, and it never got to
// run: it lives inside the ESM the old parser choked on. A guard that cannot
// load on the runtime it guards against is not a guard. BRIEF section 2: a
// traceback reaching the terminal is a failed delivery, and this was the first
// thing a new user would see.
//
// Two rules for this file, both load-bearing:
//
//   1. ES5 only. No const, no let, no arrow, no template literal, no
//      destructuring, no optional chaining. Node 0.10 must be able to parse it.
//   2. The `import()` below is built with `new Function`, so the token is never
//      seen by the parser. Written literally, `import('./deident.mjs')` is
//      itself a syntax error on Node 10 and this file would fail the same way
//      the file it protects does.
//
var REQUIRED = { major: 20, minors: { 20: 15, 22: 2 } };

function versionParts() {
  var raw = (process && process.versions && process.versions.node) || '';
  var m = /^(\d+)\.(\d+)\./.exec(raw);
  if (m === null) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), raw: raw };
}

function supported(v) {
  if (v === null) return false;
  if (v.major < REQUIRED.major) return false;
  var floor = REQUIRED.minors[v.major];
  if (floor !== undefined && v.minor < floor) return false;
  return true;
}

function refuse(v) {
  var found = v === null ? '(unreadable)' : v.raw;
  var pairs = [];
  for (var maj in REQUIRED.minors) {
    if (Object.prototype.hasOwnProperty.call(REQUIRED.minors, maj)) {
      pairs.push(maj + '.' + REQUIRED.minors[maj]);
    }
  }
  // Deliberately not the renderer in src/cli/report.mjs, which is ESM and
  // therefore unreachable from here. Same three parts as every other refusal:
  // what happened, why, and something to run.
  var lines = [
    '',
    '  deident cannot run on Node ' + found + '.',
    '',
    '    It needs node:zlib crc32, used to write the archive, which arrived in',
    '    Node ' + pairs.join(' or ') + '. Nothing has been read and nothing was written.',
    '',
    '    On Ubuntu and Debian the packaged nodejs is often far older than this.',
    '    Check what you have:      node --version',
    '    Or point at a newer one:  path/to/newer/node deident.js --version',
    '',
  ];
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(1);
}

var v = versionParts();
if (!supported(v)) refuse(v);

// Past the gate, so ESM is safe to reach for. `new Function` keeps the parser
// away from the dynamic import token on the runtimes that would reject it.
var load = new Function('p', 'return import(p);');
var url = require('url').pathToFileURL(require('path').join(__dirname, 'deident.mjs')).href;
load(url).then(function (mod) {
  return mod.run();
}).catch(function (err) {
  process.stderr.write('deident failed to start: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
