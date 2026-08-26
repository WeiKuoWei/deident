# deident

A CLI that reads your AI-coding-agent session logs, removes the identities from
them, and produces a zip you can hand to someone else.

Node 20.15+ or 22.2+, standard library only, **no npm dependencies and no
network calls**. It reads local files and writes local files. That property is
the product: nothing about your logs leaves the machine unless you are the one
who sends the zip.

Status: slice 1. Claude Code logs only, depth-0 sessions only, no server and no
browser UI. MIT licensed.

## What deident does NOT protect against

A tool that only lists its strengths gets over-trusted, and the first surprise
destroys it permanently. Two of these decide whether you should run it at all,
so they are here rather than a click away.

**The check reads `known-entity residue    0 occurrences of N entity
spellings`, not "safe".** It searches only for entities it already knows about.
On a 90-file sample of the development corpus there were 230 distinct email
addresses, 228 of them not the user's. Emails have a regex and are swept
automatically. **Names do not have a regex.** That is what the semantic pass is
for, and why it is mandatory.

**Every byte in the archive is either a value from a vocabulary this tool
defines in its own source, or a line of prose that a person read on screen.
The one exception is the parameters of your tool calls, and it is named
below.** Tool results used to be the bulk of the export, capped head-and-tail
and read by nobody. They now leave as shape alone: which tool, whether it
failed, how many bytes came back. Nothing a program printed reaches the zip as
text.

That is the point of the exercise. Before, the archive was the corpus minus
whatever the detectors caught, and every miss was invisible. Now it is empty
plus admissions, and material written in a language, an encoding or a format
nobody anticipated is unrecognised, and unrecognised means absent.

**The cost, plainly: a consumer whose scoring reads result CONTENT will get
less than it did.** If your pipeline greps tool output for build failures,
counts test names, or reads a diff body out of a result, that input is gone.
What survives is `is_error`, `result_bytes`, the tool name on the paired
`tool_use` block, and the `code_added_lines` / `code_removed_lines` /
`patch_hunks` counts distilled from `structuredPatch`. Scoring that reads
result SHAPE is unaffected.

**The exception: the parameters of your tool calls are not read by anybody.**
The candidates file is built from prose blocks, so the path you read, the
command you ran and the brief you gave a subagent go in front of no reader and
the semantic pass never sees them. Measured on an archive built from the live
corpus, they are 1.48 MB of 9.08 MB, 16.3%. A third-party name that appears
only there, or only in a code block, still cannot be declared, and the residue
scan cannot look for what was never declared.

The other twelve are in [`docs/limits.md`](docs/limits.md) with the measurement
behind each, and the same list prints at the moment of export: a name touching a
letter or a digit is left alone, and so is a spelling whose case change alters
its length; credentials and phone numbers are matched by shape and by label,
never by entropy, and one with neither is not detected at all; document numbers
need an English or Chinese label; device fingerprint survives; documents you
pasted into a prompt are prose; the agent-memory deny-list knows one person's
naming convention, not a Claude Code universal, though it now gates only tool
parameters and attachments, since nothing a tool read ships as text; an entity
can survive as a fragment of itself; export scores are unverified against
raw-log scores; and subagent transcripts are not exported.

### The check deident cannot run on itself

Both real leaks were found the same way: someone opened the finished archive and
compared it against something they already held. Nothing inside the tool does
that, and no check it has can, because every one of them compares the output
against the same table the substitution used.

So the last step is a person, or a fresh agent that has not seen the corpus:
hand it a sample of the archive and ask it to name the person, the employer and
three colleagues from that alone. What comes back is the finding. The skill
carries this as a step; if you are driving the CLI yourself, it is yours to run.

### The one list deident cannot infer

All of the above is inference, and inference cannot be told "this exact string is
mine". A finished archive whose six checks were all green shipped 21 identity
fields in plaintext because of it: name spellings, a date and place of birth, six
addresses, a phone number, a payment account id. Write yours down instead, in
`~/.deident-private/known-values.json`:

```json
{ "values": ["1974-11-03", {"kind": "person", "value": "Aurelio Ferreira-Nkemdirim"}] }
```

Local only, never committed. A bare string is enough, `kind` only changes which
pseudonym the value gets, and no file at all is the normal case. A malformed one
refuses the run and names the row, because an export that silently declared
nothing is indistinguishable, in every check deident has, from one that leaked.

### Nothing is admitted until you say so

The first `scan` proposes `exclude` for every workspace, including the ones with
a git remote, and an export with nothing admitted refuses and names the file and
the word to type. That is the design rather than a failure: every archive that
leaked did so from a session an allowlist would never have admitted, so what
this buys is a bound. Whatever the tool still misses can only be missed inside a
directory you typed out by hand.

Open `review.md`, change `exclude` to `redact` on the workspaces whose work may
leave, and run again.

## Install

You do not have to. `node <repo>/deident.js` from any directory is the whole
tool. Installing adds the skill that teaches an agent to drive it. The repository
is its own marketplace and one checkout serves both harnesses, so one `git pull`
updates both:

```
claude plugin marketplace add https://github.com/gitroll-dev/deident
claude plugin install deident@deident
claude plugin details deident            # -> Skills (1)  deident

codex plugin marketplace add https://github.com/gitroll-dev/deident
codex plugin add deident@deident
codex debug prompt-input | grep deident  # -> deident:deident: <description>
```

The third command in each block is the verification, not a formality: it prints
the harness's own view of what it parsed, and a file on disk proves nothing. The
skill appears only in a session started **after** the install. For an agent that
is neither harness, `AGENTS.md` points at the same skill file.

## Run it

Ask. In a session started after the install, say what you want, in any wording
and any language: the skill matches on what is being asked for, not on a phrase.

```
export my session logs
幫我導出 session log
```

It drives the whole flow and stops to ask you what it cannot decide: which
workspaces may leave, which sessions to drop on sight, and the prose to read for
the identities no machine can find. Nothing is written until the last step.

### Or drive it yourself

The CLI is the whole tool and the skill only types into it. `node
<repo>/deident.js` works from any directory, installed or not:

```
node deident.js scan                  # survey, and write review.md
                                      # then edit review.md: give each workspace a
                                      # tier. A workspace you do not touch stays out.
node deident.js triage                # optional, cheap: drop whole sessions on sight
node deident.js export --preview      # writes deident-candidates.txt, the prose to read
                                      # then write deident-entities.json from it
node deident.js export --entities deident-entities.json
```

Only the last line writes an archive. `deident` with no arguments prints usage
and exits 0. Every flag and every exit code is in
[`docs/flags.md`](docs/flags.md); `--help` prints the short form.

Nothing is swept in. A workspace deident has not seen is `unclassified`, which
means excluded, and one whose name or per-line `cwd` contains `private`,
`identity`, `payroll` or a token you add to `~/.deident-private/denied.json` needs
`--include-denied <exact-name>` typed out to include
([why](docs/design-rationale.md#opt-in-never-opt-out)). A pseudonym is a sha256
over the entity, its kind and a salt in `~/.deident-private` that is
**never** written into any output: it is the only thing standing between a
pseudonym and the name behind it, so it must never be shared or committed
([and what reversal cannot do](docs/design-rationale.md#reversal-and-the-salt)).

## The four-stage funnel

Each stage costs more than the one before and hands the next a shorter list.
Nothing expensive should ever read a session that was never going to be exported.

| Stage | Reads | Writes |
|---|---|---|
| `scan` | one pass, no reader | `review.md`: a census and a proposed tier per workspace |
| `triage` | 23 KB, the head of each session only | `deident-triage.txt`: one first prompt per still-kept session |
| `export --preview` | about 3.5 MB, roughly 900k tokens | `deident-candidates.txt` and a before/after `.diff` |
| `export --entities` | the same again | the zip, and `export-map.txt` |

Measured 2026-08-24 on a 205-session corpus; triage is optional and a verdict may
only ever **drop** a session ([the arithmetic, and why stage 3's figure is a
budget rather than a measurement](docs/design-rationale.md#what-the-stages-cost)).
A per-chunk limit of 20,000 characters applies, which on that corpus cut
1,336,271 characters, 10.3% of the prose. **That number is printed**, because a
reader handed a short file has to be told it is short. `export` runs every check
before it writes anything and any failure means nothing is written; `review`, the
fifth entry point, only renders `review.md` for the browser with `--html`, and no
local server is ever started.

At stage 3 you, or an agent, read `deident-candidates.txt` and answer it with
`deident-entities.json`, a list of `{kind, spellings, confidence}`. That file's
own header states the format and the valid kinds, which is where they live so
they cannot fall behind the code. List every spelling you actually see, including
run-together forms from filenames and handles: the boundary rule treats `Nora
Lund` and `NoraLund` as different strings and will not find the second from the
first.

**The funnel has a memory**, in `~/.deident-private/entities.json` beside the
salt, hashed per session, so a second run reads only what is new or changed:
211.0 KB on the first run of a synthetic 60-session corpus and 12.2 KB days later
for three new sessions. The gate is per session, so a changed one refuses the
export by name even under an entity list written before it existed, and
`export --full` re-reads everything. [Why the pass is mandatory at
all.](docs/design-rationale.md#the-semantic-pass-is-mandatory)

### Three files that stay on your machine

`review.md` holds raw paths and workspace names (and `deident-candidates.txt`
holds prose the semantic pass has not seen yet), `export-map.txt` pairs each real
session id with its archive entry, and `~/.deident-private/occurrences.json`
pairs every pseudonym with the real text behind it, which makes it the most
re-identifying thing deident writes. All of them are **local only, never shared,
never committed.** The occurrence index is what `review --entity PERSON_11` and
`review --session <id>` read back, and it answers "is this spelling replaced 991
times a person's name or an ordinary word", which no check can answer, because a
wrong replacement that is reversible passes every one of them.

## What is in the zip

One `.jsonl` per session under `sessions/<pseudonym>/<rewritten-uuid>.jsonl`. The
entry name is de-identified too, because the raw one carries your username and
the real session uuid where no JSON body does.

**Kept**: user prose, agent prose, thinking blocks, tool names, tool call
parameters, `is_error`, `result_bytes`, otherwise-unseen prompts from
`queue-operation` and `last-prompt`, timestamps quantised to the minute.
**Dropped**: every byte of tool result text, all code content, all images, all
pasted documents, account and organisation uuids, session titles, harness
bookkeeping, hook output, the local skill/agent/MCP inventories.

A tool result leaves as shape and nothing else:

```json
{"type":"tool_result","tool_use_id":"<rewritten>","is_error":true,"result_bytes":48213}
```

The tool NAME is on the `tool_use` block this id pairs with. Uuid rewriting is
deterministic, so that join still resolves inside the archive; there is no
second copy of the name to fall out of step.

Code is replaced by a **count**: `code_added_lines`, taken from
`structuredPatch`, `null` when unknown and never `0`. Measured over 511 edits, a
net figure undercounts true added by 57.5% and 123 of them (24.1%) have added > 0
with net == 0, so a net figure is not a substitute.

## Development

```
node deident.js --selftest      # 189 fixtures, plain node:assert, no framework
```

The suite is `test/selftest.mjs`. Each fixture exists because it catches a
specific bug, named in the fixture, and several carry a negative control, because
a check that cannot fail proves nothing.

In `docs/`: [`design-rationale.md`](docs/design-rationale.md) is why the tool
refuses what it refuses (including [why editing the installed skill appears to do
nothing](docs/design-rationale.md#installing-copies-the-repository-and-updating-does-not-re-copy-it)),
[`limits.md`](docs/limits.md) the full list of what it does not protect against,
[`flags.md`](docs/flags.md) the full CLI reference, and beside them `cli-ux.md`,
`scope.md`, `privacy-tiers.md`, `audience-and-floor.md` and `model-tier.md`.
`BRIEF.md` and `PLAN.md` are the engineering brief and the slice-1 plan, and the
section numbers quoted throughout the source refer to them.

Never commit a session log, an export, a preview diff or the salt. `.gitignore`
covers all of them; do not weaken it.
