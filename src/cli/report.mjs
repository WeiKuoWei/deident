// Every byte deident prints. cli-ux §7: wording is a security control, so it
// lives in one greppable file. No other module writes to stdout or stderr.
//
// Rules enforced here and nowhere else:
//   - the residue line reads "known-entity residue", never "safe"/"0 leaks"
//   - status is the word "ok" or "FAILED", never colour and never an emoji
//     carrying meaning on its own
//   - every refusal names a reason and a remedy

import { DeidentError, ReadError, UsageError } from './errors.mjs';
import { limitLines } from './limits.mjs';

export const VERSION = '0.1.0';

const OUT = [];
let capturing = false;

// A closed pipe is ordinary use, not a crash.
//
// `deident scan | head -0` closes stdout while we are still writing. The EPIPE
// arrives as an ASYNCHRONOUS 'error' event on the stdout socket, so it never
// passes through main()'s try/catch — a synchronous try/catch cannot catch it,
// and Node's default handler turns it into a full V8 traceback. BRIEF §2: a
// traceback on Ray's machine is a failed delivery.
//
// Attached here rather than in the entry point because this is the only module
// that writes to either stream, so a future entry point cannot forget.
let pipeClosed = false;
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) {
      pipeClosed = true;
      return;
    }
    throw err;
  });
}

/** Capture printed output instead of writing it. Used by the selftest. */
export function captureOutput(fn) {
  capturing = true;
  OUT.length = 0;
  try {
    fn();
    return OUT.join('\n');
  } finally {
    capturing = false;
    OUT.length = 0;
  }
}

function emit(stream, text) {
  if (capturing) {
    OUT.push(text);
    return;
  }
  if (pipeClosed) return;
  try {
    stream.write(text + '\n');
  } catch (err) {
    // The same failure can also arrive synchronously once the fd is gone.
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) pipeClosed = true;
    else throw err;
  }
}

/** True once the reader closed the pipe. Exported so the selftest can pin it. */
export function outputPipeClosed() {
  return pipeClosed;
}

const say = (text = '') => emit(process.stdout, text);
const warn = (text = '') => emit(process.stderr, text);

const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v));

function pad(s, width) {
  const str = String(s);
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function padLeft(s, width) {
  const str = String(s);
  return str.length >= width ? str : ' '.repeat(width - str.length) + str;
}

export function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------- usage

export function renderUsage() {
  say(`deident ${VERSION} — de-identify AI coding-agent session logs

  deident scan      survey what is here and propose tiers. Writes review.md only.
  deident review    render review.md as a readable HTML file.
  deident export    run every check, then produce the zip.

  Bare "deident" never exports.

Flags
  --root <path>            override the resolved session-storage root
  --out <path>             output directory (default: current directory)
  --salt-dir <path>        override ~/.deident-private
  --html                   review: write one self-contained HTML file
  --entity <ID>            review: print occurrences of one entity
  --session <id>           review: print one full redacted transcript
  --preview                export: write a diff file instead of a zip
  --entities <file>        export: supply the tier-1 entity list as JSON
  --namespace <TAG>        export: shift the pseudonym namespace, e.g. X
  --skip-unclassified      export: confirm unclassified workspaces stay out
  --skip-unreadable        scan/export: continue past an unparseable line
  --skip-unknown-types     scan/export: drop records of a type deident has
                           never seen, and list them in the manifest
  --include-denied <name>  export: typed confirmation for one denied workspace
  --selftest               run the fixture suite
  --help, --version

Exit codes
  0 success or informational   1 check failed / refused (nothing written)
  2 bad usage                  3 an input could not be read`);
}

export function renderVersion() {
  say(VERSION);
}

// ---------------------------------------------------------------- scan

export function renderScan(census) {
  const { fileCount, bytes, dateRange, workspaceCount, emptyDirs, tiers, reviewPath, unreadable } = census;
  say('');
  say(`  Claude Code sessions   ${n(fileCount)} files · ${humanBytes(bytes)}${dateRange ? ` · ${dateRange}` : ''}`);
  say(`  Workspaces             ${n(workspaceCount)}   (the directories the sessions ran in, not the storage slugs)`);
  if (emptyDirs > 0) {
    // A workspace with no sessions cannot contribute anything to an export, so
    // it must not consume a decision. One line, not one row each.
    say(`                         ${n(emptyDirs)} empty storage director${emptyDirs === 1 ? 'y' : 'ies'} held no sessions and are not listed`);
  }
  say('');
  say('  Proposed tiers');
  for (const t of tiers) {
    const ws = `${n(t.workspaces)} workspace${t.workspaces === 1 ? '' : 's'}`;
    say(`    ${pad(t.tier, 15)} ${padLeft(ws, 14)}   ${padLeft(n(t.sessions), 4)} sessions${t.note ? `   (${t.note})` : ''}`);
  }
  if (unreadable > 0) {
    say('');
    say(`  ${n(unreadable)} unreadable line${unreadable === 1 ? '' : 's'} skipped (--skip-unreadable).`);
  }
  say('');
  say(`  Nothing has been written except ${reviewPath}`);
  say('  Next:  deident review        (look at it)');
  say('         deident export        (after you have)');
  say('');
}

// ---------------------------------------------------------------- export

/**
 * One line per phase, so a long run is visibly alive.
 *
 * cli-ux §2 says no progress bars. It does not say no output: measured, a
 * full-corpus export ran 24m28s and the first byte it printed was the Checks
 * block after the whole pipeline had finished. Twenty-four minutes of silence
 * on a tool whose acceptance test is "does it work" is indistinguishable from
 * a hang, and two runs were killed in the belief that it had wedged.
 *
 * A phase line is not a progress bar: it is written once, never redrawn, and
 * it survives being pasted into a bug report.
 */
export function renderPhase(text) {
  say(`  ${text}`);
}

/** A counter inside a long phase. Same rule: appended, never redrawn. */
export function renderProgress(done, total, noun) {
  say(`    ${n(done)} / ${n(total)} ${noun}`);
}

export function renderChecks(checks) {
  say('');
  say('  Checks');
  for (const c of checks) {
    say(`    ${pad(c.label, 23)} ${pad(c.detail, 44)} ${c.ok ? 'ok' : 'FAILED'}`);
  }
}

export function renderManifest(m) {
  say('');
  say('  Leaving this machine');
  say(`    ${n(m.sessions)} sessions from ${n(m.workspaces)} workspaces`);
  say(`    ${n(m.userMessages)} user messages`);
  for (const z of m.zeros) {
    say(`    0 ${pad(z.label, 18)} ${z.suppressed}`);
  }
  if (m.countOnly && m.countOnly.sessions > 0) {
    say('');
    say('  Counted but not shared   (count-only tier)');
    say(`    ${n(m.countOnly.sessions)} sessions from ${n(m.countOnly.workspaces)} workspaces: session count, work mode and outcome only`);
  }
  if (m.droppedByCwd > 0) {
    // NOT a "zeros" row. `0 dropped by cwd  3 lines outside…` asserts a number
    // and then contradicts it, in the block cli-ux §6 calls the trust
    // mechanism.
    say(`    ${n(m.droppedByCwd)} lines dropped: outside an included directory`);
  }
  if (m.droppedCwdless > 0) {
    // Records that carry no cwd of their own, in a session that at some point
    // worked inside a directory this export excludes. They cannot be attributed
    // to a turn, and §C3 kept these types precisely because they carry user
    // text found nowhere else — which is what makes guessing them expensive.
    // Reported rather than dropped quietly, because the cost is real.
    // Named by CLASS, not as one anonymous number. PLAN C2/C3 measure
    // queue-operation and last-prompt as carrying user text found nowhere else
    // 70.3% and 32.2% of the time, and the Framing axis is scored from exactly
    // that text — so "3,784 records dropped" beside "5,821 user messages" read
    // as though the user prose was intact while two classes were at zero.
    const byType = (m.droppedCwdlessByType ?? []).map((t) => `${t.type} (${n(t.count)})`).join(', ');
    say(`    ${n(m.droppedCwdless)} records dropped: they replay text typed inside an excluded`);
    say(`      directory and carry no cwd of their own${byType ? `  —  ${byType}` : ''}`);
  }
  if (m.emptiedSessions > 0) {
    // A session that retained nothing used to vanish with no counter at all, so
    // the shipped session count silently disagreed with the count in review.md.
    say(`    ${n(m.emptiedSessions)} sessions retained nothing and are not in the archive`);
  }
  say('');
  say('  NOT protected against    (README § Limits)');
  // One source of truth, shared with review.html and the --preview file
  // (src/cli/limits.mjs). Three copies of a disclosure is three chances to be
  // wrong, and two of them were.
  for (const line of limitLines(m)) say(`    ${line}`);
  say('');
}

export function renderWrote(path, bytes, saltPath) {
  say(`  → ${path}    ${humanBytes(bytes)}`);
  say(`    salt stays at ${saltPath} — do not share it, do not commit it`);
  say('');
}

export function renderCandidates(path, chars) {
  say('');
  say('  Tier-1 candidates written');
  say(`    ${path}    ${humanBytes(chars)} of tier-0-cleaned prose`);
  say('');
}

/**
 * Declared entities the export replaced nowhere.
 *
 * stderr, like every other warning: it is a finding about the run, not part of
 * the manifest. Names its own canonical spelling because the reader supplied
 * it and this is a local terminal, and because "one entity matched nothing" is
 * not actionable without knowing which.
 */
export function renderUnmatched(entities) {
  warn('');
  warn(`  ! ${n(entities.length)} declared entit${entities.length === 1 ? 'y' : 'ies'} matched nothing and replaced nothing:`);
  for (const e of entities.slice(0, 20)) warn(`      ${pad(e.kind, 10)} ${e.canonical}`);
  if (entities.length > 20) warn(`      ... and ${n(entities.length - 20)} more`);
  warn('    Either it is not in this corpus, or tier 0 had already replaced part of');
  warn('    the spelling. Check the row in "deident export --preview".');
  warn('');
}

export function renderNote(text) {
  say(`  ${text}`);
}

export function renderWarning(text) {
  warn(`  ! ${text}`);
}

// ---------------------------------------------------------------- review

export function renderEntityOccurrences(id, occurrences) {
  say(`  ${n(occurrences.length)} occurrences, ${n(new Set(occurrences.map((o) => o.session)).size)} sessions:`);
  for (const o of occurrences) {
    say(`    ${o.date}  ${pad(o.workspace, 20)} turn ${padLeft(o.turn, 4)}   ${o.excerpt}`);
  }
}

export function renderTranscript(lines) {
  for (const line of lines) say(line);
}

// ---------------------------------------------------------------- failures

// What deident is refusing to DO. cli-ux §1 makes a point of scan and review
// writing nothing dangerous, so telling the user that `scan` is "refusing to
// export" contradicts the model the interface is trying to teach.
const REFUSAL_VERB = Object.freeze({ scan: 'scan', review: 'continue', export: 'export' });
let refusalVerb = 'continue';

/** Set by the entry point before dispatch, so every refusal names its command. */
export function setCommand(command) {
  refusalVerb = REFUSAL_VERB[command] ?? 'continue';
}

/** cli-ux §8. Exit 1. */
export function renderRefusal(err) {
  warn('');
  warn(`  ✗ Refusing to ${refusalVerb}: ${err.reason}`);
  if (err.why.length > 0) {
    warn('');
    for (const line of err.why) warn(`    ${line}`);
  }
  if (err.remedies.length > 0) {
    warn('');
    const width = Math.max(...err.remedies.map((r) => r.label.length)) + 1;
    for (const r of err.remedies) warn(`    ${pad(r.label + ':', width + 1)}  ${r.command}`);
  }
  warn('');
}

/** cli-ux §9. Exit 3. */
export function renderReadError(err) {
  const d = err.detail ?? {};
  warn('');
  warn('  ✗ Could not read session file');
  if (d.file) warn(`      ${d.file}`);
  if (d.line !== undefined && d.line !== null) {
    warn(`      line ${n(d.line)} is not valid JSON (${d.parserMessage ?? 'parse failed'})`);
  } else if (d.parserMessage) {
    warn(`      ${d.parserMessage}`);
  }
  warn('');
  // The remedy is named by the error, because a remedy that cannot work is
  // worse than none (cli-ux §8). This line used to append "Skip the file with
  // --skip-unreadable" to EVERY read error, including one the flag could not
  // suppress at all.
  warn(`    ${d.likelyCause ?? 'The file may still be being written.'} ${d.remedy ?? 'Skip the file with --skip-unreadable.'}`);
  warn('');
}

/** Exit 2. */
export function renderUsageError(err) {
  warn('');
  warn(`  ✗ ${err.reason}`);
  warn('');
  renderUsage();
}

/** The single dispatch used by the entry point's catch. */
export function renderError(err) {
  if (err instanceof UsageError) {
    renderUsageError(err);
    return err.code;
  }
  if (err instanceof ReadError) {
    renderReadError(err);
    return err.code;
  }
  if (err instanceof DeidentError) {
    renderRefusal(err);
    return err.code;
  }
  // Unreachable: deident.mjs wraps everything. Kept so a bug still prints a
  // sentence rather than a traceback.
  warn('');
  warn(`  ✗ deident failed unexpectedly: ${err && err.message ? err.message : String(err)}`);
  warn('    Nothing was written. Please report this.');
  warn('');
  return 1;
}

// ---------------------------------------------------------------- selftest

export function renderSelftest(results) {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    say(`  ${r.ok ? 'ok  ' : 'FAIL'} ${pad(r.id, 5)} ${r.name}`);
    if (!r.ok) say(`         ${r.error}`);
  }
  say('');
  say(`  ${n(results.length - failed.length)} / ${n(results.length)} fixtures passed`);
  say('');
  return failed.length === 0;
}
