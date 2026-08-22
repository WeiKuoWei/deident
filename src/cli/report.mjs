// Every byte deident prints. cli-ux §7: wording is a security control, so it
// lives in one greppable file. No other module writes to stdout or stderr.
//
// Rules enforced here and nowhere else:
//   - the residue line reads "known-entity residue", never "safe"/"0 leaks"
//   - status is the word "ok" or "FAILED", never colour and never an emoji
//     carrying meaning on its own
//   - every refusal names a reason and a remedy

import { DeidentError, ReadError, UsageError } from './errors.mjs';

export const VERSION = '0.1.0';

const OUT = [];
let capturing = false;

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
  stream.write(text + '\n');
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
  const { fileCount, bytes, dateRange, workspaceCount, tiers, reviewPath, unreadable } = census;
  say('');
  say(`  Claude Code sessions   ${n(fileCount)} files · ${humanBytes(bytes)}${dateRange ? ` · ${dateRange}` : ''}`);
  say(`  Workspaces             ${n(workspaceCount)}`);
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
  say('');
  say('  NOT protected against    (README § Limits)');
  say('    device fingerprint: MCP server names, model mix, CLI version sequence');
  say('    verbatim documents you pasted into your own messages');
  say('    third-party names the semantic pass did not recognise');
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

/** cli-ux §8. Exit 1. */
export function renderRefusal(err) {
  warn('');
  warn(`  ✗ Refusing to export: ${err.reason}`);
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
  warn(`    ${d.likelyCause ?? 'The file may still be being written.'} Skip the file with --skip-unreadable.`);
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
