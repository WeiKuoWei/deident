# Three architecture rulings, and why

Ten advocates, ten cross-examinations, three judges, one synthesis, 2026-08-24. Every
position was required to read the source; every judge re-ran the decisive claims rather
than weighing the prose. What follows is the reasoning, not the transcript.

---

## M1. The operator is an agent. Extend the CLI, or rewrite it from a spec?

**Ruling: extend. Rewrite and strangler were both judged non-viable, on measurement.**

The rewrite case was: the command surface, the interaction model and the review file were
all designed for a human at a terminal, so bolting a machine surface onto a human-shaped
core leaves a permanent impedance mismatch. It is a good argument and it lost for three
reasons, each checked rather than argued.

**There is no interactive surface to rewrite.** `grep -rn "readline|prompt(|stdin|question("
src/ deident.mjs` returns nothing. Every decision already arrives as a file or a flag, and
`main(argv, env)` is a pure function of argv and env returning an exit code. Exactly three
lines in 7,671 touch a stream, all in `src/cli/report.mjs`. Every command already builds one
frozen object and hands it to a pure renderer. The thing a rewrite would be commissioned to
build is the thing that shipped.

**The rewrite would rewrite the code that produced none of the run's failures.** The five
structurally uncatchable findings were fixed in two commits touching `entities/seed.mjs`,
`pseudonym.mjs`, `tier1.mjs`, `verify/checks.mjs`, `retain/constants.mjs` and
`retain/records.mjs`. Zero lines in `src/cli/`. The defects were never in the shape.

**The fixtures are the specification and it exists nowhere else.** 91 fixtures, 48 of 96
commits are `fix:`. The load-bearing ones are the ones nobody writes from a document: an
entity preceded by a JSON escape is a real occurrence; bijectivity holds across the tier-0
and tier-1 passes rather than within each; the boundary reads the matched text and
substitution runs to a fixpoint; a tier-1 entity that tier-0 half-replaced must still be
replaced. That last one is the 1,096-survival refusal turned into a rule. They came from
405M tokens of reading a real corpus. A rewrite re-derives them or ships without them, and
ships-without is the realistic outcome.

The strangler position (extract the verified core into a library, make the CLI one caller
among several) failed on its own net: zero fixtures call `runScan`/`runReview`/`runExport`
in-process, and those three orchestration functions are exactly what the extraction edits.
The change would be untested by construction, which is this run's named failure mode
arriving through the fix.

**What the losers were right about, and the winner must absorb.** Value-level redaction has
no data home. Measured on the entity file: 242 of 431 spellings sat in 23 `secret` entities,
and every spelling longer than 40 characters was in `secret`. Those are dictated sentences
and email paragraphs being pushed through a table built for names. That is a real design
gap, and it caused a real defect (see the postscript).

---

## M2. What is the delivery shape?

**Ruling: the CLI process boundary is the contract. The operator ships as an installable
skill over that unchanged CLI. Distribution is a pinned clone or git ref, not npx.**

This is a hybrid only because the two advocates conceded each other's core claim. The CLI
wins the contract question outright: no in-process shape can hold the EPIPE handler attached
to the real stdout at module load, the typed exit codes, or the containment of a V8
heap-limit abort that no `try/catch` can catch. The plugin wins the operator question: the
agent is the operator and the harness is where consent and attention already live.

Two measurements decided the packaging half.

**npx does not work today, and the failure is silent.** Through a real symlink named
`deident` with no extension, which is exactly npm's POSIX bin-link shape, `node bin/deident
--version`, `--help` and `scan` each printed zero bytes and exited 0. The ESM loader
realpaths the main module while `process.argv[1]` stays the link path, so the entry guard is
false and `main()` never runs. **A privacy tool reporting success while doing nothing is the
worst available failure**, and all twelve process-boundary fixtures spawn the repo file, so
the proven surface would not have been the shipped surface.

**The mandatory gate's own first remedy is undiscoverable.** `semanticRefusal` prints
`{label: 'Inside Claude Code', command: '/deident-scan'}` as the first remedy on both
branches, and that command only exists when cwd is inside this repo. The hardest gate in the
tool tells you to run something you do not have.

Library lost: the settled operator reaches deident through Bash and cannot hold a JS object,
so a `prepare()` handle makes the agent author its own printer, which is stdout parsing with
the disclosure format moved out of the one greppable file.

Service lost on timing, not merit. `docs/scope.md` gates `deident push` on "a receiving
endpoint exists," and none does.

### The platform roadmap, which the ruling does not close off

The service position lost on sequencing, and nothing in this ruling forecloses it. What it
does is name the three things that must be true first, and one that must never be.

1. **A receiver with an owner.** A named person accountable for the endpoint, its retention
   policy and its deletion path, with a date. Until that name exists, "delivery is a file"
   stands.
2. **A machine-readable envelope.** `--json` and `manifest.json` in the archive are
   prerequisites for any assisted submission, because a receiver that cannot read what it
   received cannot enforce anything.
3. **A consent mechanism sized to the payload.** Viberank's OAuth-then-upload is defensible
   because a person can eyeball 42 distinct strings. deident's payload is transcripts and
   this run needed twelve passes before the archive was clean. The shape transfers; the
   consent model does not.

The one that must never be true: **a destination must not bind identity across several
pseudonymised corpora.** Per-uploader salt exists because a shared roster is a re-identification
substrate, and it is precisely the role-based finding that would fall out of it. A platform
can hold many corpora; it must not hold the key that joins them.

**The single highest-value item on the whole board came from cross-examination, not from any
position:** `.claude/commands/deident-scan.md` told the operator that `kind` is one of five,
while `VALID_KINDS` has eight. The three missing ones are `secret`, `idnumber` and `account`
— the value-level redaction that took the archive from 48 back toward 76. The doc had
drifted 62 commits behind the constant it copied. Fixed by pointing at the live header
instead of restating it.

---

## M3. Literal matching missed a script variant and shipped. What replaces it?

**Ruling: fold inside the engine, but only the Han rung, and only after an occurrence probe
exists.**

The motion asked for normalized matching. The winning advocate refused to defend the
motion's own wording and that is why it won: it verified that NFKC does **not** fold Han
simplification (萬/万, 個/个, 應/应 all survive NFKC unchanged and unequal) and said so,
splitting the motion into a Unicode half that does not fix this incident and a non-Unicode
half that does.

The candidate-generation position — keep the engine literal, expand each spelling into
variants, keep only those that occur — lost as the primary answer on three counts. Its
thesis is literal matching over a bigger literal set, argued against a settled constraint
that says the guarantee must not rely on literal matching. Its headline yield was
over-reported by 2x. And its own falsifier was satisfied by the shipped bytes.

But it supplied the thing the winner lacks, and the ruling takes it whole: **the occurrence
probe.** `residualScan` already derives its probe set from `table.entries`, and `buildTable`
reads the same list, so widening the needle set is free for the residue gate. The probe is
roughly 40 lines reusing the existing bucketed sweep.

**Why the probe must exist before the fold.** A wrong fold is silent. Every gate stays green
because the substitution is still reversible and the residue count is still zero. The probe
is the only instrument proposed anywhere in the debate that makes a wrong fold loud, which
is the exact failure direction the winner concedes the tool cannot detect.

**And the probe corrects the winner's own plan.** The fold proposal wanted a frequency
threshold as the gate. Measured: 課稅 (an ordinary noun meaning taxation) at 202 occurrences
must fail, 小凱拉 (a name) at 17 must pass, and 富途 (a brokerage) at 255 sits between them
and is a legitimate identity. Frequency separates the noun from the name only sometimes. So
the probe prints counts into `review.md` for adjudication and does not auto-refuse.

The declare-your-languages position lost outright — its own cost bullets contradict each
other, and `\p{Script=Han}` cannot distinguish simplified from traditional, so the census it
proposed as the mitigation cannot detect the incident that opened the question. But it found
the second half of the same bug: `caseInsensitive()` gates folding on `/[A-Za-z]/`, so every
bicameral non-Latin script gets no folding at all. Greek and Cyrillic are denied the
guarantee that Latin has, for no reason but the regex.

---

## Postscript: what the debate found in the operator's own work

The synthesis measured the live entity file and found that `課稅`, `健身日報`, `富途`, `QQQ`
and `Baltimore` were all spellings of **one** entity carrying 31 of them, whose canonical was
a sentence fragment. One pseudonym stood for taxation, a newsletter, a brokerage, an ETF
ticker and a city, and 202 occurrences of an ordinary noun were being replaced in prose.

The cause was mechanical chunking: an agent's redaction list was sliced twenty at a time into
`secret` entities with no regard for whether the strings were the same identity. Han needles
get no boundary rule, because `isWordChar` is `/[A-Za-z0-9_]/`.

**All five aborting gates were green**, because the substitution was reversible and the
residue count was zero. A reversible wrong replacement satisfies every check the tool has.

Twelve agent fan-outs, 168 agents and roughly 405M tokens did not find it. A 40-line probe
would have printed it on the first run. That is the argument for instrumentation over
headcount, stated as a measurement rather than as a preference.

Fixed: ordinary words removed, the bags split so one fact mints one pseudonym, duplicate
spellings deduped after the split — caught, correctly, by the bijectivity gate refusing the
export. 294 entities, 421 spellings. The ordinary words are back in the prose (課稅 11, 健身
日報 21, 境外所得 10, 扣繳憑單 10) and everything that should be gone still is.
