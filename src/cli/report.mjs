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
// passes through main()'s try/catch, a synchronous try/catch cannot catch it,
// and Node's default handler turns it into a full V8 traceback. BRIEF §2: a
// traceback on the operator's machine is a failed delivery.
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
    // Not a failure. Measured 2026-08-25 on the live corpus, 30 of 214 sessions
    // have nothing a reader can judge even after the shown prompt is allowed to
    // be a later one: 28 carry no user prompt in the head at all and 2 open with
    // commands and never say anything else. Said out loud because a reader who
    // sees the marker on a row should know it is a property of the corpus and
    // not a truncated read, and because the rubric already answers those rows.
    say(`    ${n(t.withoutPrompt)} of them ${t.withoutPrompt === 1 ? 'has' : 'have'} nothing to judge and ${t.withoutPrompt === 1 ? 'says' : 'say'} so in the file`);
  }
  if ((t.shownLater ?? 0) > 0) {
    // The first prompt of a session that opens with /clear is a command
    // envelope, and showing it is how a session with 21 identity fields in it
    // passed triage. Reported because the reader must not read the OPENING of a
    // session into a prompt that arrived after a context reset.
    say(`    ${n(t.shownLater)} of them ${t.shownLater === 1 ? 'opens' : 'open'} with a bare command, so a later prompt is shown and the row says so`);
  }
  say('');
  say(`  → ${t.path}    ${humanBytes(t.bytes)}`);
  renderTokenCost(t.tokenEstimate ?? null);
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
  //
  // Said with what it DID. This line used to be followed by "held back N by the
  // floor, 0 by the audience setting", and the second number was 0 on every
  // measured run because nothing ever wrote the decision it counted: a check
  // that never ran, printed as a passing one.
  const audience = m.audience ?? 'public';
  const did = audience === 'public'
    ? `${n(m.audienceEntities ?? 0)} employer names substituted because of it`
    : 'employer vocabulary left in place';
  say(`    declared audience: ${audience}  (${did})`);
  say(`    ${n(m.sessions)} sessions from ${n(m.workspaces)} workspaces`);
  say(`    ${n(m.userMessages)} user messages`);
  // Sessions are held by the floor and by nothing else. The audience setting
  // cannot reach them: it moves what goes into the entity list.
  if ((m.heldByFloor ?? 0) > 0) {
    say(`    held back  ${n(m.heldByFloor)} by the floor`);
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
    // text found nowhere else, which is what makes guessing them expensive.
    // Reported rather than dropped quietly, because the cost is real.
    // Named by CLASS, not as one anonymous number. PLAN C2/C3 measure
    // queue-operation and last-prompt as carrying user text found nowhere else
    // 70.3% and 32.2% of the time, and the Framing axis is scored from exactly
    // that text, so "3,784 records dropped" beside "5,821 user messages" read
    // as though the user prose was intact while two classes were at zero.
    const byType = (m.droppedCwdlessByType ?? []).map((t) => `${t.type} (${n(t.count)})`).join(', ');
    say(`    ${n(m.droppedCwdless)} records dropped: they replay text typed inside an excluded`);
    say(`      directory and carry no cwd of their own${byType ? `:  ${byType}` : ''}`);
  }
  if (m.absorbedSpans > 0) {
    // BRIEF §4.7(a) presents I2 as the invariant that catches overlap bugs. It
    // does, at span level, and the spans are never persisted (§3 forbids a
    // map file), so the only reversal path that exists cannot distinguish two
    // inputs that collapsed to the same output. Saying "all reversible" and
    // nothing else would let that pass as green.
    say(`    ${n(m.absorbedSpans)} replacements merged two overlapping entities: those spans`);
    say('      reverse from the span record only, not from the entity list');
  }
  if (m.cjkSpans > 0) {
    // BRIEF §4.5 asks for length >= 2 AND a flag. This is the flag.
    //
    // It said "CJK" while the flag was set for every non-Latin script, so a
    // Cyrillic or Hebrew replacement was reported under a label that named the
    // wrong writing system and the wrong reason. The count is now genuinely
    // spaceless-script only, so it says which scripts and why.
    say(`    ${n(m.cjkSpans)} entity occurrences in a script written without spaces (Chinese,`);
    say('      Japanese, Korean, Thai and the rest): there is no word boundary to test,');
    say('      so the rule cannot prove they were not inside a longer word');
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

/**
 * What reading a file deident just wrote will cost, in tokens.
 *
 * One headline, then the rows behind it. Three things it must never carry:
 *
 *   - A percentage of anyone's subscription. deident cannot read a plan and
 *     cannot read remaining usage, and the limits are not published as a token
 *     count, so any figure there would be invented. That is worse than no
 *     number, because a person would act on it.
 *   - A model-tier comparison. docs/model-tier.md is where the tiers are
 *     weighed up; the tool runs one, and telling a reader about a tier they
 *     are not using is process rather than result.
 *   - A second hedge. "roughly" is the whole disclaimer, said once. A number
 *     qualified in every clause is a number nobody can use.
 */
export function renderTokenCost(cost) {
  if (cost === null || cost === undefined) return;
  say(`    Reading this will cost roughly ${n(cost.total)} tokens.`);
  const width = Math.max(12, ...cost.files.map((f) => f.label.length));
  for (const f of cost.files) {
    // The character count is the evidence for the row. The CJK share appears
    // only when there is one, because "0% CJK" beside a pure-Latin file is a
    // clause that answers a question the reader did not have.
    const mix = f.cjkPercent > 0 ? `${n(f.chars)} characters, ${f.cjkPercent}% CJK` : `${n(f.chars)} characters`;
    say(`      ${pad(f.label, width)} ${padLeft(n(f.tokens), 9)}   (${mix})`);
  }
  say(`      the reader's own reasoning adds about ${cost.reasoningPercent}%`);
}

export function renderCandidates(path, chars, omitted = 0, omittedChars = 0, deferred = 0, tokenEstimate = null) {
  if (machine !== null) { machineAdd({ candidates: { path, chars, omitted, omittedChars, deferred, tokenEstimate } }); return; }
  say('');
  say('  Tier-1 candidates written');
  say(`    ${path}    ${humanBytes(chars)} of tier-0-cleaned prose`);
  renderTokenCost(tokenEstimate);
  // The number that says a repeat run is cheap. Without it a short file looks
  // like a corpus that shrank rather than like a memo that worked.
  if (omitted > 0) {
    say(`    ${n(omitted)} session${omitted === 1 ? '' : 's'} left out: unchanged since you last read them`);
  }
  // The per-chunk cap, said out loud. Its predecessor cut 76.2% of the prose
  // and printed nothing, so the person asked to declare the names in this file
  // had no way to know how much of it they were not being given.
  if (omittedChars > 0) {
    say(`    ${n(omittedChars)} characters of prose were not shown: one chunk ran past the per-chunk limit`);
  }
  // The batch budget. Said here as well as in the file because this is the
  // number that stops "I read the file" meaning "I read the corpus": what is
  // not in this file is not recorded as read, and comes back next run.
  if (deferred > 0) {
    say(`    ${n(deferred)} session${deferred === 1 ? ' is' : 's are'} not in this file and not yet recorded as read:`);
    say('      run the export again after you supply the list, and the next batch arrives');
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
  // Two classes, printed apart and labelled, because they are different
  // animals and the first export sorted them together. A spelling that matched
  // nothing while ANOTHER spelling of the same entity matched says the person
  // wrote a form this corpus does not use, and that is the Export 1 shape: the
  // declared strings were Traditional and the prose was Simplified. A spelling
  // whose entity matched nothing anywhere says only that the value is not here,
  // which is what an unused passport number looks like.
  //
  // Neither is a gate, and the near-miss class is the one that most invites
  // being made one. It must not be: the same shape covers a path typed with the
  // other separator, where the entity WAS replaced everywhere it occurs and
  // nothing is wrong at all. No test orders those two, so a refusal would turn
  // correct behaviour into a red gate, which is F7's failure and the reason
  // renderProbe is a report in the first place. The row names the spelling that
  // matched instead, and a reader tells them apart in a second.
  const near = zeros.filter((z) => z.matchedAs);
  const absent = zeros.filter((z) => !z.matchedAs);
  if (near.length > 0) {
    warn('');
    warn(`  ! ${n(near.length)} spelling${near.length === 1 ? '' : 's'} you declared matched nothing, but the same entity matched`);
    warn('    through a spelling deident generated. This corpus writes it the other way:');
    for (const z of near.slice(0, 12)) {
      warn(`      ${pad(z.kind, 9)} ${z.spelling.slice(0, 34)}   matched as   ${z.matchedAs.slice(0, 34)}`);
    }
    if (near.length > 12) warn(`      ... and ${n(near.length - 12)} more`);
    warn('    Harmless for a path written with the other separator. Not harmless for a');
    warn('    name or a company: anything else you declare in that form will be missed.');
  }
  if (absent.length > 0) {
    warn('');
    warn(`  ! ${n(absent.length)} declared spelling${absent.length === 1 ? '' : 's'} matched nothing, so ${absent.length === 1 ? 'it protected' : 'they protected'} nothing:`);
    for (const z of absent.slice(0, 12)) warn(`      ${pad(z.kind, 9)} ${z.spelling.slice(0, 60)}`);
    if (absent.length > 12) warn(`      ... and ${n(absent.length - 12)} more`);
    warn('    No other spelling of the same entity matched either.');
    // Claims only what the sweep knows, and the difference is not pedantry.
    // Two entities can cover the same text, and then one matches nothing while
    // the identity is replaced under the other's pseudonym. Reachable long
    // before the Han fold: `Northwind` and `northwind` declared separately do it,
    // because matching is case-insensitive and only one entry wins an offset.
    // The sweep breaks at the first matching entry by design, so it never
    // learns a loser would also have matched, and "this string is nowhere in
    // the corpus" would be a false statement in the one block whose job is
    // being believed.
    warn('    Usually a typo in your list, or a value you have never typed here. If the');
    warn('    same identity is also declared as a separate entity, that one may already');
    warn('    be covering it.');
  }
  warn('');
}

/** How many declared values are printed with a count before the tail is summarised. */
const DECLARED_SHOWN = 12;

/**
 * The values the person declared as their own, and what each one replaced.
 *
 * Printed for every export that had a list, including the rows where the answer
 * is "nothing", because those are the two ways a declaration silently does
 * nothing: a value the corpus never contained, and a value the safety rules
 * refuse to substitute. Both currently pass every gate.
 *
 * No verdict and no threshold. The person wrote this list by hand about
 * themselves; if one of their own values turns out to be an ordinary word
 * occurring five hundred times, that is a fact for them to act on and not a
 * reason for the tool to argue with a deliberate declaration. renderProbe makes
 * the same argument for the same measurement.
 */
export function renderDeclared(rows) {
  if (machine !== null) { machineAdd({ declaredValues: rows }); return; }
  if (rows.length === 0) return;
  const silent = rows.filter((r) => r.count === 0 || r.rejected);
  warn('');
  warn(`  ${n(rows.length)} value${rows.length === 1 ? '' : 's'} you declared in known-values.json, and what each replaced.`);
  warn('  A high count on a value of yours is not an error: it is a word that is also');
  warn('  yours, and only you can tell those apart.');
  for (const r of rows.slice(0, DECLARED_SHOWN)) {
    // A rejected value gets no number, because every number available here
    // would be a lie in the one direction that matters. buildTable puts an
    // entity with no pseudonym in `flagged` and never in `entries`, and
    // residualScan sweeps `entries`, so a rejected value is never substituted
    // AND never scanned for. Verified against the shipped modules: a declared
    // two-character value occurring twice in the corpus ships twice, while
    // known-entity residue and the on-disk rescan both report ok. Printing `0`
    // beside it is a zero where no check ran, which is the shape of failure
    // BRIEF 4.3 names.
    const count = r.rejected ? padLeft('-', 6) : String(r.count).padStart(6);
    warn(`      ${count}  ${pad(r.kind, 9)} ${r.value.slice(0, 46)}${r.alsoInferred ? '   (deident found this one too)' : ''}`);
  }
  const hidden = rows.length - Math.min(rows.length, DECLARED_SHOWN);
  if (hidden > 0) warn(`      ... and ${n(hidden)} more, every one of them replaced at least once`);
  if (silent.length > 0) {
    warn('');
    warn(`  ! ${n(silent.length)} of them replaced nothing, so ${silent.length === 1 ? 'it protects' : 'they protect'} nothing:`);
    for (const r of silent) {
      warn(`      ${pad(r.kind, 9)} ${r.value.slice(0, 60)}`);
      // The two cases read the same on the row above and are not the same
      // problem: one is a value the corpus never contained, usually a typo in
      // the list; the other is a value deident will not substitute at any
      // count, which the person asked for and did not get.
      if (r.rejected) {
        warn(`        never substituted: ${r.rejected}`);
        // The sentence that makes the dash in the count column mean something.
        // A value the substituter refused is also a value the residue scan
        // never looks for, so "not scanned" is the whole state and the archive
        // may well still carry it.
        warn('        and not scanned for either, so this value may still be in the archive');
      } else {
        warn('        no occurrence of this string is anywhere in the exported text');
      }
    }
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

/**
 * Every occurrence of one entity, so a count can be checked rather than
 * believed.
 *
 * The excerpts are the text BEFORE substitution, which is the only form that
 * answers the question the reader has: whether a spelling replaced N times is
 * a person's name or an ordinary word. That makes this output a
 * re-identification key, so it says so. A person who does not know that will
 * paste it into a ticket, and unlike the archive there is no gate between this
 * and a chat window.
 */
export function renderEntityOccurrences(rec, source) {
  if (machine !== null) {
    machineAdd({
      entity: rec.pseudonym,
      kind: rec.kind,
      spellings: rec.spellings,
      total: rec.total,
      occurrences: rec.occurrences,
      source,
      localOnly: true,
    });
    return;
  }
  // Grouped by session rather than one flat table with a session column. The
  // id is 36 characters and identical down a run of rows, so repeating it
  // pushed the excerpt off the right of an 80-column terminal, and the excerpt
  // is the only column that answers the question. Grouping also puts the id on
  // its own line, which is the argument for the --session query below it.
  const bySession = new Map();
  for (const o of rec.occurrences) {
    if (!bySession.has(o.session)) bySession.set(o.session, []);
    bySession.get(o.session).push(o);
  }
  say('');
  say(`  ${rec.pseudonym}   ${rec.kind}   ${rec.spellings.map((s) => JSON.stringify(s)).join(', ')}`);
  say(`  ${n(rec.total)} occurrence${rec.total === 1 ? '' : 's'}, ${n(bySession.size)} session${bySession.size === 1 ? '' : 's'}:`);
  for (const [session, list] of bySession) {
    say('');
    say(`    ${list[0].date}  ${pad(list[0].workspace, 18)} ${session}`);
    for (const o of list) say(`        turn ${padLeft(o.turn, 5)}   ${o.excerpt.slice(0, 110)}`);
  }
  if (rec.occurrences.length < rec.total) {
    say('');
    say(`    ... ${n(rec.total - rec.occurrences.length)} more occurrences counted and not listed`);
  }
  say('');
  say('  Read one of these sessions in full:   deident review --session <id above>');
  say('');
  sayLocalOnly(source);
}

/**
 * The paragraph that has to be on every drill-down answer.
 *
 * §5's two queries are the only ones whose whole job is joining what shipped
 * back to a real person, so their output is as sensitive as export-map.txt and
 * gets the same sentence the skill already gives that file. Unlike the archive
 * there is no gate between this and a chat window.
 */
function sayLocalOnly(source) {
  say(`  Read from ${source}.`);
  say('  Local only: this is not in the archive and must not be sent with it. It joins');
  say('  what shipped back to the real names and session ids on this machine, which is');
  say('  the join the archive exists to break.');
  say('');
}

/**
 * One session as it actually shipped, read back out of the archive.
 *
 * Read from the zip rather than re-rendered from the corpus, for the reason
 * Measured on the delivery run: a reviewer was handed
 * something that was not what shipped three separate times, and each time the
 * gap was where the leak lived.
 */
export function renderSessionTranscript(id, entry, body, source) {
  if (machine !== null) {
    machineAdd({ session: id, entry, transcript: body, source, localOnly: true });
    return;
  }
  say('');
  say(`  ${id}   ->   ${entry}`);
  say('');
  for (const line of body.split('\n')) say(line);
  say('');
  sayLocalOnly(source);
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
