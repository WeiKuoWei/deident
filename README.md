# deident

A CLI that reads your AI-coding-agent session logs, removes the identities, and
produces a zip you can hand to someone else. Node 20.15+ or 22.2+, standard library
only, **no npm dependencies and no network calls**: it reads local files, writes
local files, and nothing about your logs leaves the machine unless you send it.
Slice 1, Claude Code logs only, depth-0 sessions only, MIT licensed.

**The promise.** Every byte in the archive is either a value from a vocabulary this
tool defines in its own source, or a line of prose a person read on screen. The one
exception is your tool call parameters: 12.2% and 16.3% of the archive on the two
corpora measured so far, and the export prints the figure for yours.

**The cost, plainly.** A consumer whose scoring reads tool result CONTENT gets
less than it did. Results leave as shape alone, so a pipeline that greps result
bodies for build failures loses that input. Scoring that reads SHAPE is unaffected.

## What deident does NOT protect against

A tool that only lists its strengths gets over-trusted, and the first surprise
destroys it permanently. Each line links to its measurement in
[`docs/limits.md`](docs/limits.md); a live version prints at the moment of export.

- [The residue check proves less than its label.](docs/limits.md#the-residue-check-proves-less-than-its-label) It searches only for entities it already knows about. On a 90-file sample of the development corpus there were 230 distinct email addresses, 228 of them not the user's. Emails have a regex and are swept automatically. **Names do not have a regex.** That is what the semantic pass is for, and why it is mandatory.
- [The parameters of your tool calls are read by nobody.](docs/limits.md#the-parameters-of-your-tool-calls-are-read-by-nobody) The candidates file is built from prose, so the path you read and the brief you gave a subagent go in front of no reader, and a name appearing only there cannot be declared.
- [A name touching a letter or a digit is left alone](docs/limits.md#a-name-touching-a-letter-or-a-digit-is-left-alone), and so is [a spelling whose case change alters its length](docs/limits.md#case-insensitive-matching-is-withheld-from-a-few-spellings). [Document numbers need an English or Chinese label.](docs/limits.md#identity-document-numbers-are-found-by-their-label-in-english-and-chinese-only)
- [Credentials and phone numbers are matched by shape and by label, never by entropy](docs/limits.md#credentials-and-phone-numbers-are-matched-by-shape-and-only-by-shape), and [one with neither is not detected at all](docs/limits.md#a-credential-with-no-listed-prefix-and-no-label-beside-it-is-not-detected).
- [Device fingerprint survives](docs/limits.md#device-fingerprint-survives) (model mix, harness version sequence, localhost ports), and [documents you pasted into a prompt are prose](docs/limits.md#verbatim-documents-you-pasted-into-your-own-messages-are-not-detected).
- [The agent-memory deny-list knows one person's naming convention](docs/limits.md#the-agent-memory-deny-list-matches-filenames-and-knows-one-naming-convention), not a Claude Code universal, and now gates only tool parameters and attachments, since nothing a tool read ships as text.
- [Export scores are unverified against raw-log scores](docs/limits.md#four-of-six-upstream-scoring-axes-depend-on-rules-that-are-not-published), [subagent transcripts are not exported](docs/limits.md#subagent-and-workflow-transcripts-are-not-exported), and [`review.md` holds raw identity on purpose](docs/limits.md#reviewmd-is-full-of-raw-identity-on-purpose).
- [deident cannot infer the list of your own literal values](docs/limits.md#deident-cannot-infer-the-list-of-your-own-literal-values) (declare them, below), and [it cannot run the one check that matters on itself](docs/limits.md#the-check-deident-cannot-run-on-itself): both real leaks were found by a person who compared the finished archive against something they already held. That last step is yours.

## Install

You do not have to: `node <repo>/deident.js` is the whole tool. Installing adds
the skill that teaches an agent to drive it. The repository is its own marketplace
and one checkout serves both harnesses, so one `git pull` updates both:

```
claude plugin marketplace add https://github.com/gitroll-dev/deident
claude plugin install deident@deident
claude plugin details deident            # -> Skills (1)  deident
codex plugin marketplace add https://github.com/gitroll-dev/deident
codex plugin add deident@deident
codex debug prompt-input | grep deident  # -> deident:deident: <description>
```

The third command in each block is the verification, not a formality: a file on disk
proves nothing, so it prints the harness's own parse. The skill appears only in a
session started **after** the install; `AGENTS.md` points any other agent at it.

## Run it

Ask. `export my session logs`, or `幫我導出 session log`: any wording, any
language. The skill drives the flow and stops to ask what it cannot decide: which
workspaces may leave, which sessions to drop, and the prose to read.

Or drive it yourself, from any directory, installed or not. Only the last line here
writes an archive, and a bare `deident` prints usage and exits 0. Every flag and exit
code is in [`docs/flags.md`](docs/flags.md); `--help` prints the short form.

```
node deident.js scan              # survey, then tier each workspace in review.md.
                                  # One you do not touch stays out.
node deident.js triage            # optional, cheap: drop whole sessions on sight
node deident.js export --preview  # writes deident-candidates.txt, the prose to read
node deident.js export --entities deident-entities.json
```

**Your first export will refuse, and that is the design.** `scan` proposes `exclude`
for every workspace, git remote or not, and one matching `private`, `identity`,
`payroll` or a token in `~/.deident-private/denied.json` also needs `--include-denied
<exact-name>`. What it buys is a bound: whatever the tool misses can only be missed
inside a directory you typed by hand ([why](docs/design-rationale.md#opt-in-never-opt-out)).

**Declare what deident cannot infer**, in `~/.deident-private/known-values.json`.
A bare string is enough, `{"values": ["1974-11-03", {"kind": "person", "value":
"Nora Lund"}]}`, and no file is the normal case, but it is the one list no inference
reaches: an archive whose six checks were all green shipped 21 identity fields in
plaintext for want of it ([story](docs/limits.md#deident-cannot-infer-the-list-of-your-own-literal-values)).

## The four-stage funnel

Each stage costs more than the one before and hands the next a shorter list, so
nothing expensive ever reads a session that was never going to be exported.

| Stage | Reads | Writes |
|---|---|---|
| `scan` | one pass, no reader | `review.md`: a census and a proposed tier per workspace |
| `triage` | 23 KB, the head of each session only | `deident-triage.txt`: one first prompt per still-kept session |
| `export --preview` | about 3.5 MB, roughly 900k tokens | `deident-candidates.txt` and a before/after `.diff` |
| `export --entities` | the same again | the zip, and `export-map.txt` |

Measured 2026-08-24 on a 205-session corpus. Triage is optional and a verdict may
only ever **drop** a session; `export` runs every check before writing anything, and
any failure means nothing is written; `review`, the fifth entry point, renders
`review.md` with `--html` and starts no local server. A per-chunk limit of 20,000
characters cut 1,336,271 characters there, 10.3% of the prose, and **that number is
printed** ([the arithmetic](docs/design-rationale.md#what-the-stages-cost)).

At stage 3 you, or an agent, answer `deident-candidates.txt` with
`deident-entities.json`, a list of `{kind, spellings, confidence}` whose format lives
in that file's own header so it cannot fall behind the code. The pass is remembered
per session: a second run reads only what is new or changed, a changed session
refuses by name, and `export --full` re-reads everything ([why it is
mandatory](docs/design-rationale.md#the-semantic-pass-is-mandatory)).

### Files that stay on your machine

`review.md` (raw paths and workspace names), `deident-candidates.txt` (prose the
semantic pass has not seen yet), `known-values.json` (what you declared as your
own), `export-map.txt` (real session ids against archive entries),
`deident-preview-<date>.diff` (the original text beside the redacted text, written
into the output directory, so move it before you send that directory), and
`~/.deident-private/occurrences.json`, the most re-identifying thing deident writes,
which pairs every pseudonym with its real text and so backs `review --entity
PERSON_11`, the only way to tell a name replaced 991 times from an ordinary word.
Beside them, the salt: never written into any output, and the only thing between a
pseudonym and the name behind it ([and what reversal cannot
do](docs/design-rationale.md#reversal-and-the-salt)). All of it is **local only,
never shared, never committed.**

## What is in the zip

One `.jsonl` per session under `sessions/<pseudonym>/<rewritten-uuid>.jsonl`. The
entry name is de-identified too: the raw one carries your username and the real
uuid where no JSON body does.

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

The tool NAME is on the `tool_use` block this id pairs with, and uuid rewriting is
deterministic, so that join still resolves. Code is replaced by a **count**:
`code_added_lines`, from `structuredPatch`, `null` when unknown and never `0`, since
over 511 measured edits a net figure undercounts true added by 57.5% and 24.1% of
edits have added > 0 with net == 0 (BRIEF §4.2).

## Development

`node deident.js --selftest` runs 215 fixtures on plain `node:assert`, no framework,
in `test/selftest.mjs`; each catches a specific bug, named in the fixture. Section
numbers in the source refer to `BRIEF.md` and `PLAN.md`. Never commit a session log,
an export, a preview diff or the salt; `.gitignore` covers all of them.
