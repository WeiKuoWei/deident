// Every byte deident prints. cli-ux §7: wording is a security control, so it
// lives in one greppable file. No other module writes to stdout or stderr.
//
// Rules enforced here and nowhere else:
//   - the residue line reads "known-entity residue", never "safe"/"0 leaks"
//   - status is the word "ok" or "FAILED", never colour and never an emoji
//     carrying meaning on its own
//   - every refusal names a reason and a remedy

import path from 'node:path';

import { DeidentError, ReadError, UsageError } from './errors.mjs';
import { limitLines } from './limits.mjs';

export const VERSION = '0.1.0';

// How to type this tool, worked out from how this process was actually started.
//
// Every command deident printed named a bare `deident`, which is on nobody's
// PATH: there is no package.json and no bin, and README.md and SKILL.md both
// tell the reader to run `node <repo>/deident.mjs`. So the tool's own output
// contradicted its own instructions, and an agent told to act on a remedy got
// command-not-found. cli-ux §8: a remedy that cannot be run is worse than none.
//
// Derived, not hardcoded, because this now ships to a team on Windows and
// macOS whose checkouts are not all named the same thing, and a second
// hardcoded string is the same bug waiting for the first rename.
const INVOCATION = (() => {
  const script = process.argv[1];
  if (typeof script !== 'string' || script === '') return 'deident';
  const name = path.basename(script);
  const argv0 = process.argv[0] ?? '';
  // basename with the extension stripped, so Windows' node.exe and macOS' node
  // print the same word.
  const runner = path.basename(argv0, path.extname(argv0));
  // A single-file executable reports itself in both slots. Only a runner plus a
  // script needs two words.
  return runner === '' || runner === name ? name : `${runner} ${name}`;
})();

/**
 * A remedy string made runnable, at the one seam that prints.
 *
 * The 30 remedies across src/ are written as `deident ...` because that is what
 * the tool is called; what to actually type is a rendering question, and
 * answering it here cannot miss one the way 30 hand edits can. A command that
 * does not open with the tool's name (`edit <file>`, `node --version`, `file an
 * issue against deident`) is left exactly as its author wrote it.
 */
function runnable(command) {
  return typeof command === 'string' && command.startsWith('deident ')
    ? INVOCATION + command.slice('deident'.length)
    : command;
}

const OUT = [];
let capturing = false;

// A closed pipe is ordinary use, not a crash.
//
// `deident scan | head -0` closes stdout while we are still writing. The EPIPE
// arrives as an ASYNCHRONOUS 'error' event on the stdout socket, so it never
// passes through main()'s try/catch — a synchronous try/catch cannot catch it,
// and Node's default handler turns it into a full V8 traceback. BRIEF §2: a
// traceback on Sam's machine is a failed delivery.
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

// --- Machine mode -----------------------------------------------------------
//
// One document per run, emitted once at the end, carrying the values that were
// ALREADY frozen at each render call: the census, the manifest, the checks
// array, the typed error. Nothing is recomputed and no second code path exists,
// which is why the human output is byte-identical when the flag is absent.
//
// Collected rather than streamed because an agent reads stdout whole: a
// progress line interleaved with a document makes JSON.parse throw on a run
// that succeeded.
let machine = null;

/** Start collecting instead of printing. Called once, from the command. */
export function beginMachine(command) {
  machine = { deident: VERSION, command, ok: true };
}

export function inMachineMode() {
  return machine !== null;
}

/** Merge fields into the pending document. */
export function machineAdd(fields) {
  if (machine !== null) Object.assign(machine, fields);
}

/**
 * Emit the document. Returns true if it wrote, so the caller can tell whether
 * the human path still owes a line.
 */
export function endMachine() {
  if (machine === null) return false;
  const doc = machine;
  machine = null;
  // After the reset, so the guard in say() is already open again.
  say(JSON.stringify(doc, null, 2));
  return true;
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

// While a document is pending, prose is suppressed at the primitive rather
// than in each renderer. An agent reads stdout whole, so one progress line
// interleaved with the document makes JSON.parse throw on a run that succeeded
// - which is exactly how this was found, from renderProbe writing to stderr
// after the document had been emitted. Guarding here means a renderer added
// tomorrow cannot reintroduce it, which auditing twenty call sites could not
// promise.
const say = (text = '') => {
  if (machine !== null) return;
  emit(process.stdout, text);
};
const warn = (text = '') => {
  if (machine !== null) return;
  emit(process.stderr, text);
};

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
  say(`deident ${VERSION}: de-identify AI coding-agent session logs

  ${INVOCATION} scan      survey what is here and propose tiers. Writes review.md only.
  ${INVOCATION} review    render review.md as a readable HTML file.
  ${INVOCATION} triage    offer each still-kept session's first prompt, and apply
                     the verdicts. A verdict can only ever drop a session.
  ${INVOCATION} export    run every check, then produce the zip.

  Bare "${INVOCATION}" never exports.

Flags
  --root <path>            override the resolved session-storage root
  --out <path>             output directory (default: current directory)
  --salt-dir <path>        override ~/.deident-private
  --html                   review: write one self-contained HTML file
  --entity <ID>            review: print occurrences of one entity
  --session <id>           review: print one full redacted transcript
  --triage-chars <n>       triage: characters of the first prompt to show
  --apply                  triage: merge a verdicts file into review.md
  --verdicts <file>        triage: the verdicts file to apply
  --preview                export: write a diff file instead of a zip
  --entities <file>        export: supply the tier-1 entity list as JSON.
                           Optional once ~/.deident-private/entities.json has one
  --full                   export: ignore what deident remembers you having read
                           and put the whole corpus in front of a reader again
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
  if (machine !== null) { machineAdd(census); return; }
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
  say(`  Next:  ${INVOCATION} review        (look at it)`);
  say(`         ${INVOCATION} export        (after you have)`);
  say('');
}

// ---------------------------------------------------------------- triage

export function renderTriageWritten(t) {
  if (machine !== null) { machineAdd({ triage: t }); return; }
  say('');
  say(`  ${n(t.sessions)} session${t.sessions === 1 ? '' : 's'} still proposed keep, ${n(t.chars)} characters of first prompt each`);
  if (t.withoutPrompt > 0) {
    // Not a failure. Measured on the live corpus, 44 of 205 sessions carry no
    // first user prompt at all, so an absent one is the ordinary case. Said out
    // loud because a reader who sees the marker on a row should know it is a
    // property of the corpus and not a truncated read.
    say(`    ${n(t.withoutPrompt)} of them ${t.withoutPrompt === 1 ? 'carries' : 'carry'} no first user prompt and ${t.withoutPrompt === 1 ? 'says' : 'say'} so in the file`);
  }
  say('');
  say(`  → ${t.path}    ${humanBytes(t.bytes)}`);
  say('    Raw prose: tier-0 substitution has not run over it. Local only, like review.md');
  say('    A verdict can only ever drop a session. There is no keep verdict');
  say('');
}

export function renderTriageApplied(t) {
  if (machine !== null) { machineAdd({ triage: t }); return; }
  say('');
  say(`  ${n(t.verdicts)} verdict${t.verdicts === 1 ? '' : 's'} read`);
  say(`    ${n(t.applied)} applied`);
  // Named, not merged into the applied count. A verdict that changed nothing
  // because the session was already dropped is a different fact from one that
  // held a session back, and a single total hides which happened.
  say(`    ${n(t.unchanged)} changed nothing (already dropped, or "unsure")`);
  if (t.unmatched > 0) say(`    ${n(t.unmatched)} matched no row in review.md (see the warnings above)`);
  say('');
  say(t.applied > 0 ? `  → ${t.path}` : `  Nothing was written. ${t.path} is unchanged`);
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
  if (machine !== null) return;
  say(`  ${text}`);
}

/** A counter inside a long phase. Same rule: appended, never redrawn. */
export function renderProgress(done, total, noun) {
  say(`    ${n(done)} / ${n(total)} ${noun}`);
}

export function renderChecks(checks) {
  if (machine !== null) { machineAdd({ checks }); return; }
  say('');
  say('  Checks');
  for (const c of checks) {
    say(`    ${pad(c.label, 23)} ${pad(c.detail, 44)} ${c.ok ? 'ok' : 'FAILED'}`);
  }
}

export function renderManifest(m) {
  if (machine !== null) { machineAdd({ manifest: m }); return; }
  say('');
  say('  Leaving this machine');
  // The recipient claim, in the block whose whole job is being believed.
  // privacy-tiers 6: a corpus exported for a teammate and one for the public
  // are not comparable, and nothing in the contents says which is which.
  say(`    declared audience: ${m.audience ?? 'public'}`);
  say(`    ${n(m.sessions)} sessions from ${n(m.workspaces)} workspaces`);
  say(`    ${n(m.userMessages)} user messages`);
  // Two reasons, two numbers. Only the second moves if the knob is turned, and
  // a merged total hides the half the person can act on.
  if ((m.heldByFloor ?? 0) > 0 || (m.heldByAudience ?? 0) > 0) {
    say(`    held back  ${n(m.heldByFloor ?? 0)} by the floor, ${n(m.heldByAudience ?? 0)} by the audience setting`);
  }
  const zeroWidth = Math.max(18, ...m.zeros.map((z) => z.label.length));
  for (const z of m.zeros) {
    say(`    0 ${pad(z.label, zeroWidth)} ${z.suppressed}`);
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
    say(`      directory and carry no cwd of their own${byType ? `:  ${byType}` : ''}`);
  }
  if (m.absorbedSpans > 0) {
    // BRIEF §4.7(a) presents I2 as the invariant that catches overlap bugs. It
    // does, at span level — and the spans are never persisted (§3 forbids a
    // map file), so the only reversal path that exists cannot distinguish two
    // inputs that collapsed to the same output. Saying "all reversible" and
    // nothing else would let that pass as green.
    say(`    ${n(m.absorbedSpans)} replacements merged two overlapping entities: those spans`);
    say('      reverse from the span record only, not from the entity list');
  }
  if (m.cjkSpans > 0) {
    // BRIEF §4.5 asks for length >= 2 AND a flag. This is the flag.
    say(`    ${n(m.cjkSpans)} CJK entity occurrences replaced: the boundary rule cannot`);
    say('      prove they were not inside a longer CJK word');
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
  if (machine !== null) { machineAdd({ wrote: { path, bytes } }); return; }
  say(`  → ${path}    ${humanBytes(bytes)}`);
  say(`    salt stays at ${saltPath}. Do not share it, do not commit it`);
  say('');
}

export function renderCandidates(path, chars, omitted = 0) {
  if (machine !== null) { machineAdd({ candidates: { path, chars, omitted } }); return; }
  say('');
  say('  Tier-1 candidates written');
  say(`    ${path}    ${humanBytes(chars)} of tier-0-cleaned prose`);
  // The number that says a repeat run is cheap. Without it a short file looks
  // like a corpus that shrank rather than like a memo that worked.
  if (omitted > 0) {
    say(`    ${n(omitted)} session${omitted === 1 ? '' : 's'} left out: unchanged since you last read them`);
  }
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
  warn(`    the spelling. Check the row in "${runnable('deident export --preview')}".`);
  warn('');
}

/**
 * How often each declared spelling would be replaced, both tails, no verdict.
 *
 * stderr, like every other finding about the run. Deliberately not a gate: on
 * the 2026-08-24 corpus the ordinary noun for "meeting" counted 202 and had to
 * be refused, a real brokerage counted 255 and had to be kept, and a personal
 * name counted 17. No threshold orders those three correctly, so printing the
 * number beside an excerpt and letting a reader decide is the only honest
 * shape. The middle of the distribution is omitted because it is unremarkable
 * by construction, and a list nobody finishes reading is a list nobody reads.
 */
export function renderProbe({ hits, zeros }) {
  if (machine !== null) { machineAdd({ replacementCounts: { hits, zeros } }); return; }
  if (hits.length === 0 && zeros.length === 0) return;
  warn('');
  warn('  Replacement counts, highest first. A common word here is a false positive');
  warn('  that every gate will pass, because a reversible wrong replacement is still');
  warn('  reversible.');
  for (const h of hits) {
    warn(`      ${String(h.count).padStart(6)}  ${pad(h.kind, 9)} ${h.spelling.slice(0, 46)}`);
    if (h.excerpt) warn(`              ${h.excerpt.slice(0, 96)}`);
  }
  if (zeros.length > 0) {
    warn('');
    warn(`  ! ${n(zeros.length)} declared spelling${zeros.length === 1 ? '' : 's'} matched nothing, so ${zeros.length === 1 ? 'it protects' : 'they protect'} nothing:`);
    for (const z of zeros.slice(0, 12)) warn(`      ${pad(z.kind, 9)} ${z.spelling.slice(0, 60)}`);
    if (zeros.length > 12) warn(`      ... and ${n(zeros.length - 12)} more`);
  }
  warn('');
}

/**
 * Pieces of a declared spelling that still stand alone in the exported text.
 *
 * Substituting "Grace Hopper" and leaving the bare "Morgan" is a half
 * replacement: the pseudonym appears once and the prose names him again two
 * sentences later. The same shape reaches every other kind through multi-word
 * spellings. An office address declared as one string shipped its street
 * on its own. No gate can catch either, because the residue scan only
 * looks for what it was given, and every check stays green.
 *
 * Printed rather than fixed, because the fix is not mechanical: in this corpus
 * May, Wise and Ray are all parts of real names and all ordinary words. The
 * count and one excerpt is what a reader needs to decide in a second.
 */
export function renderNameParts(rows) {
  if (machine !== null) { machineAdd({ uncoveredNameParts: rows }); return; }
  if (rows.length === 0) return;
  warn('');
  warn(`  ! ${n(rows.length)} part${rows.length === 1 ? '' : 's'} of a declared entity still stand${rows.length === 1 ? 's' : ''} alone in the text.`);
  warn('    The full spelling was replaced; these were not, so the text still carries them.');
  for (const r of rows.slice(0, 12)) {
    warn(`      ${String(r.count).padStart(6)}  ${pad(r.part, 18)} from "${r.from}"`);
    if (r.excerpt) warn(`              ${r.excerpt.slice(0, 96)}`);
  }
  if (rows.length > 12) warn(`      ... and ${n(rows.length - 12)} more`);
  warn('');
  warn('    Add the ones that really are this entity to the entity list and re-run.');
  warn('    Leave out any that are ordinary words: that costs nothing, and adding');
  warn('    one replaces a common word everywhere with every check still green.');
  warn('');
}

/**
 * Spellings of the uploader that are still in the output, glued to letters or
 * digits so the boundary rule could never match them.
 *
 * Measured 2026-08-24 over a shipped archive: the OS username survived inside
 * cloud resource names, glued on both sides, while the export printed
 * `known-entity residue 0`. The boundary rule is correct and does not change.
 * BRIEF §4.5 row 4 makes `ray` inside `array` a required non-match, so the
 * only honest handling is to say which spellings it refused and let the reader
 * decide.
 *
 * A finding, not a gate, and stderr like every other finding. The wording has
 * to say that the substituter DECIDED not to replace these, or a reader reads
 * the block as a bug report against deident and files it instead of acting.
 */
export function renderGluedResidue(rows) {
  if (machine !== null) { machineAdd({ gluedResidue: rows }); return; }
  if (rows.length === 0) return;
  const total = rows.reduce((a, r) => a + r.count, 0);
  warn('');
  warn(`  ! ${n(total)} occurrence${total === 1 ? '' : 's'} of your own username or git identity are still in the`);
  warn('    output, joined to letters or digits (yourname-prod, kv-yourname01234).');
  warn('    The substituter did not replace them and that is deliberate: the word');
  warn('    boundary rule cannot tell them from your name inside an ordinary word.');
  for (const r of rows.slice(0, 12)) {
    warn(`      ${String(r.count).padStart(6)}  ${pad(r.spelling, 24)} ${r.entityId}`);
    if (r.excerpt) warn(`              ${r.excerpt.slice(0, 96)}`);
  }
  if (rows.length > 12) warn(`      ... and ${n(rows.length - 12)} more`);
  warn('');
  warn('    Decide per row. A resource name you can rename before exporting is one');
  warn('    fix; declaring the glued spelling itself in the entity list is another.');
  warn('');
}

/**
 * The gate that opened the file, named so a reader can tell it apart.
 *
 * Every other residue line covers a string assembled in memory. A reader who
 * sees one "residue" row cannot tell which artifact it covered, and the whole
 * point of this one is that it covered a different artifact from all the rest.
 */
export function renderOnDiskResidue(entryCount, check) {
  if (machine !== null) {
    machineAdd({
      checks: [
        ...(machine.checks ?? []),
        { label: 'archive on disk', ok: check.ok, detail: check.detail, entries: entryCount },
      ],
    });
    return;
  }
  say(`    ${pad('archive on disk', 23)} ${n(entryCount)} entries read back, ${check.detail}${check.ok ? '   ok' : '   FAILED'}`);
}

export function renderNote(text) {
  say(`  ${text}`);
}

export function renderWarning(text) {
  if (machine !== null) { machineAdd({ warnings: [...(machine.warnings ?? []), text] }); return; }
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
const REFUSAL_VERB = Object.freeze({ scan: 'scan', review: 'continue', triage: 'triage', export: 'export' });
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
    for (const line of err.why) warn(line === '' ? '' : `    ${line}`);
  }
  if (err.remedies.length > 0) {
    warn('');
    const width = Math.max(...err.remedies.map((r) => r.label.length)) + 1;
    for (const r of err.remedies) warn(`    ${pad(r.label + ':', width + 1)}  ${runnable(r.command)}`);
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
  // A usage error that took the trouble to say WHY was throwing that away, and
  // the usage block is only the right remedy for a bad flag. For a runtime that
  // cannot run the tool at all, the usage text answers a question nobody asked.
  if (err.why.length > 0) {
    warn('');
    for (const line of err.why) warn(`    ${line}`);
  }
  if (err.remedies.length > 0) {
    warn('');
    for (const r of err.remedies) warn(`    ${pad(`${r.label}:`, 26)} ${runnable(r.command)}`);
  }
  warn('');
  // Usage still follows for the case it was written for: a flag typed wrong,
  // where the list of flags IS the answer.
  if (err.why.length === 0) renderUsage();
}

/** The single dispatch used by the entry point's catch. */
export function renderError(err) {
  if (machine !== null) {
    const code = err && typeof err.code === 'number' ? err.code : 1;
    machineAdd({
      ok: false,
      error: {
        kind: err && err.constructor ? err.constructor.name : 'Error',
        reason: err && err.reason ? err.reason : (err && err.message) || String(err),
        why: (err && err.why) || [],
        // Machine mode is read by an agent, which is the reader most likely to
        // run a remedy verbatim rather than read around it.
        remedies: ((err && err.remedies) || []).map((r) => ({ ...r, command: runnable(r.command) })),
        detail: (err && err.detail) || null,
        code,
      },
    });
    endMachine();
    return code;
  }
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
