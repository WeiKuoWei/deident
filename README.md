# deident

A CLI that reads your AI-coding-agent session logs, removes the identities from
them, and produces a zip you can hand to someone else.

Node v22, standard library only, **no npm dependencies and no network calls**. It
reads local files and writes local files. That property is the product: nothing
about your logs leaves the machine unless you are the one who sends the zip.

Status: slice 1. Claude Code logs only, depth-0 sessions only, no server and no
browser UI. MIT licensed.

## Install

You do not have to. `node <repo>/deident.js` from any directory is the whole
tool. Installing adds the skill that teaches an agent to drive it, which is the
one step deident cannot do for itself. The repository is its own marketplace and
one checkout serves both harnesses, so one `git pull` updates both:

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
skill appears in a session started **after** the install, so restart an open one.
For an agent that is neither, `AGENTS.md` carries the same contract.

## Run it

Ask. In a session started after the install, say what you want:

```
export my session logs
幫我導出 session log
```

Any wording, any language. The skill matches on what is being asked for, not on
a phrase, so a translation of either line is the same request.

It then drives the whole flow and stops to ask you the things it cannot decide:
which workspaces may leave, which sessions to drop on sight, and it hands you
the prose to read for the identities no machine can find. Nothing is written
until the last step, and you are the one who sends the file.

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
and exits 0. The reading step in the middle is the one thing deident cannot do
for itself, which is what the skill is for; `AGENTS.md` is the same contract for
an agent that reads the repository directly.

Nothing is swept in. A workspace deident has not seen is `unclassified`, which
means excluded, and one whose name or per-line `cwd` contains `private`,
`identity`, `payroll` or a token you add to `~/.deident-private/denied.json` needs
`--include-denied <exact-name>` typed out to include
([why](docs/design-rationale.md#opt-in-never-opt-out)). Pseudonyms are
`sha256(salt + kind + entity)` against a salt in `~/.deident-private`, which is
**never** written into any output and must never be shared or committed: it is the
only thing standing between a pseudonym and the name behind it
([why, and what reversal cannot do](docs/design-rationale.md#reversal-and-the-salt)).

## What deident does NOT protect against

A tool that only lists its strengths gets over-trusted, and the first surprise
destroys it permanently. So, plainly, before you run this on your own logs:

- **The check reads `known-entity residue    0 occurrences of N entity
  spellings`, not "safe".** It searches only for entities it already knows about.
  On a 90-file sample of the development corpus there were 230 distinct email
  addresses, 228 of them not the user's. Emails have a regex and are swept
  automatically. **Names do not have a regex.** That is what the semantic pass is
  for, and why it is mandatory.
- **The semantic pass only ever sees prose, which is 2.30% of the bytes.** The
  candidates file is built from `text` blocks and nothing else, because feeding a
  discovery pass the other 97.7% is how it starts inventing entities. A
  third-party name that appears only in a tool result, a directory listing or a
  code block never reaches the reader: they cannot declare it, and the residue
  scan cannot look for what was never declared.
- **A name touching a letter or a digit is left alone.** The boundary rule is
  `(?<!\w)X(?!\w)`, with an underscore counting as a boundary for spellings of
  five characters or more and a camel-case hump always counting, which is what
  makes `mcp__<server>__tool` and `<Org>AI` real matches while keeping `ray`
  inside `array` a correct non-match. What survives is a spelling abutting an
  ordinary letter or digit: `<name>son`, `<org>123`. The manifest reports that
  count and it is not zero. Scripts written without spaces between words (Chinese,
  Japanese, Korean, Thai) have no boundary to test at all and are flagged in the
  manifest instead.
- **Case-insensitive matching is withheld from a few spellings.** Spellings of
  four characters or more match in any casing. The exception is one whose case
  change alters its **length**: Turkish dotted capital I lowercases to two code
  units, German sharp s uppercases to two. Folding those would consume the wrong
  span, so they stay literal. A miss rather than a corruption, which is the right
  way round.
- **Credentials and phone numbers are matched by shape, and only by shape.**
  Anything with an unambiguous vendor prefix (`github_pat_`, `ghp_`, `sk-ant-`,
  `xoxb-`, `AKIA`, `ntn_`, `AIza`, `sk-proj-`, `sk_live_`, `npm_`, `glpat-`,
  `hf_`, `xapp-`, and the rest of one greppable list in `src/entities/seed.mjs`)
  is force-replaced, and so is any `+<country code><8-15 digits>` phone number. So
  is a value whose **label** says what it is: `api_key`, `secret_key`,
  `access_token`, `auth_token`, `client_secret`, `password`, a `Bearer ` header,
  an `X-Amz-` parameter in a signed URL, a password inline in a database URL. A
  `-----BEGIN … PRIVATE KEY-----` block is dropped whole, because half a key is
  still a key. An entropy heuristic would fire on every hash and uuid in your
  logs, and a scan that cries wolf is the first thing switched off.
- **A credential with neither a listed prefix nor a label beside it is not
  detected, and nothing downstream recovers it.** The semantic pass reads your
  prose and the model's, never tool output, so a key printed by a command you ran
  is caught by shape or not at all. The `0 secrets` row means "none of the shapes
  deident knows", not "no secrets", and the export block says so as you run it.
- **Identity-document numbers are found by their label, in English and Chinese
  only**: `passport`, `national id`, `identity card`, `id card`, `driver's
  licence`, `social security`, `ssn`, `tax id`, `fein`, and 護照, 护照, 身分證,
  身份證, 台胞證, 居留證. Anchoring on the label is a measured precision decision:
  a passport-shaped regex on its own matched a thermal-paste part number. **A
  number labelled in any other language, or with no label near it, is not
  detected.** Only the semantic pass can catch that one.
- **`review.md` is full of raw identity, on purpose.** Real absolute paths, real
  workspace names, real git remotes including other people's handles, and the
  deny-list token that matched each excluded directory. It has to be, or you could
  not recognise the rows you are deciding about. Treat it like the salt: local
  only, never pasted into a ticket, never committed. Same for
  `deident-candidates.txt`, which holds prose the semantic pass has not seen yet.
- **Device fingerprint survives.** MCP server names are replaced, but the model
  mix, the harness version sequence, the tool inventory and localhost ports remain
  inferable. Timestamps are quantised to the minute, which removes
  millisecond-level correlation and nothing more.
- **Verbatim documents you pasted into your own messages are not detected.** A
  contract, a résumé, a bank statement or someone else's email pasted into a
  prompt is prose, and the semantic pass will only catch the identities it
  recognises inside it. Quoted third-party writing survives as writing.
- **The agent-memory deny-list matches filenames, and it knows one naming
  convention**: `MEMORY.md`, and files named `reference_*.md`, `feedback_*.md`,
  `project_*.md`, `user_*.md`. That is one person's memory-index layout, not a
  Claude Code universal. Harness injections inside `<system-reminder>` spans are
  stripped whatever they are called, so the gap is narrower than it sounds: it is
  a memory file a tool **read** for you, under another name, shipping as ordinary
  prose. Put your own filenames in `~/.deident-private/denied.json`, a JSON array
  of regex strings or `{"patterns": [...], "tokens": [...]}`. A malformed one
  refuses the export rather than running with none of your rules.
- **Fragments of an entity survive.** Tool results are capped head-and-tail, and a
  cap can land in the middle of an email address or a name. The remaining fragment
  matches no spelling, so neither the substituter nor the scan sees it.
- **Four of six upstream scoring axes depend on rules that are not published.**
  Nobody outside the scoring pipeline knows what `failure_signal` is counted from,
  what a "decision point" is, whether the prompt-quality run reads only user
  messages, or whether the expertise classifier reads code content. If truncating
  `tool_result` pushed `failure_signal` below its threshold, `hits_trouble` would
  go false, Resilience would go null and the overall score would **rise**: the tool
  would silently inflate scores. deident therefore caps tool results generously,
  preserves `is_error` verbatim regardless of truncation, and keeps every
  threshold named in `src/retain/constants.mjs`. Until those rules are published,
  treat scores from a deident export as unverified against scores from raw logs.
- **Subagent and workflow transcripts are not exported.** Only depth-0 human
  sessions are read; the rest of the corpus is 2.2x the payload with zero human
  turns. Orchestration stays visible through the parent session's `Agent` and
  `Workflow` tool calls.

### The one list deident cannot infer

All of the above is inference. Tier 0 works out what it can from this machine,
tier 1 asks a reader to work out the rest from your prose. Neither can be told
"this exact string is mine", and a finished archive whose six checks were all
green shipped 21 identity fields in plaintext because of it: document name
spellings, a date and place of birth, six addresses, a phone number and a payment
account id, most out of one browser-automation session filling in a booking form.
Write them down instead, at `~/.deident-private/known-values.json`:

```json
{
  "_note": "Values that are mine. Local only. Never commit this, never share it.",
  "values": [
    "1974-11-03",
    "Flat 6B, 219 Marlowe Crescent, Ashford Bay",
    {"kind": "person", "value": "Aurelio Ferreira-Nkemdirim"},
    {"kind": "account", "value": "pm-8842-31770"}
  ]
}
```

A bare string is enough; `kind` only changes which pseudonym the value gets. No
file is the normal case and means the two inference tiers alone. A malformed one
refuses the run and names the row, because an export that silently declared
nothing is indistinguishable, in every check deident has, from the export that
leaked. Every export prints the list back with each value's occurrence count: zero
means a typo or a value the corpus never held, and a high count means a value of
yours that is also an ordinary word, which is a fact for you and never a refusal.
deident reads nobody's personal-details file and hardcodes no path to one, so if
you keep one, turning it into this file is the fastest thing you can do before an
export.

## The four-stage funnel

Each stage costs more than the one before and hands the next a shorter list.
Nothing expensive should ever read a session that was never going to be exported.

| Stage | Reads | Writes |
|---|---|---|
| `scan` | one pass, no reader | `review.md`: a census and a proposed tier per workspace |
| `triage` | 23 KB, the head of each session only | `deident-triage.txt`: one first prompt per still-kept session |
| `export --preview` | about 3.5 MB, roughly 900k tokens | `deident-candidates.txt` and a before/after `.diff` |
| `export --entities` | the same again | the zip, and `export-map.txt` |

Measured 2026-08-24 on a 205-session corpus. Triage is optional; skipping it just
means stage 3 reads sessions a person would have thrown out, and it was already
35x cheaper than stage 3 before the change that made stage 3 four times heavier
([the arithmetic](docs/design-rationale.md#what-the-stages-cost), which is also
why stage 3's figure above is a budget rather than a measurement). A per-chunk
limit of 20,000 characters applies, which on that corpus cut 1,336,271
characters, 10.3% of the prose. **That number is printed** beside the file path,
written into the file itself and carried as `candidates.omittedChars` in `--json`,
because a reader handed a short file has to be told it is short.

At stage 2 a verdict can only ever **drop** a session: there is no keep verdict
and a verdict cannot overturn a drop, which is why a cheap model is the right one
here (`docs/model-tier.md`). At stage 3 you, or an agent, read the candidates file
and write `deident-entities.json`:

```json
{
  "generated": "2026-08-22T06:20:00Z",
  "entities": [
    {"kind": "person", "spellings": ["Nora Lund", "NoraLund", "Nora"], "confidence": "high"},
    {"kind": "org",    "spellings": ["Acme Advisory"],                  "confidence": "low"}
  ]
}
```

`kind` is one of `person | org | client | workspace | machine`. `confidence` is
`high` or `low`; low-confidence entities are listed individually in the review and
never collapsed into a count. List every spelling you actually see, including
run-together forms from filenames and handles: the boundary rule treats `Nora
Lund` and `NoraLund` as different strings and will not find the second from the
first.

**The funnel has a memory.** What you declared is remembered in
`~/.deident-private/entities.json`, beside the salt, with a content hash of every
session that has been put in front of a reader, so a second run reads only what is
new or changed: on a synthetic 60-session corpus, 211.0 KB on the first run and
12.2 KB days later for three new sessions. When nothing changed at all, `node
deident.js export` is the whole of stage 4, because `--entities` is optional once
the dictionary exists. The dictionary is plaintext and you may edit it by hand; it
is local only, it pairs real spellings with real session ids, and it never reaches
the archive, the output directory or this repository. The semantic-pass gate is
**per session**, so one that is new or changed refuses the export by name even
under an entity list written before it existed, and `export --full` re-reads
everything for when you have changed your mind about what counts as an identity.
[Why the pass is mandatory at
all.](docs/design-rationale.md#the-semantic-pass-is-mandatory)

## Commands

| Command | Writes | Notes |
|---|---|---|
| `scan` | `review.md` | A census plus a proposed tier per workspace. |
| `review` | `review.html` with `--html` | Read in the browser, decide in the text file. No local server is ever started. |
| `triage` | `deident-triage.txt`, or `review.md` with `--apply` | One truncated first prompt per still-kept session, and the verdicts on it. |
| `export` | the zip and `export-map.txt`, or a `.diff` with `--preview` | Runs every check first. Any failure means nothing is written. |

`export-map.txt` sits beside the zip with one `<real session id>  <archive entry>`
line per exported session. It exists so you can act on the last look: every id
inside the archive has been rewritten, so without it nothing on your machine says
which entry is which session. It pairs a local id with a local id, never a
pseudonym with a name, but treat it like `review.md`: **local only, never shared,
never committed.** A failed export removes it along with the zip.

A successful export also writes `~/.deident-private/occurrences.json`, beside the
salt rather than the zip, recording every occurrence the substituter replaced with
its session and surrounding text, so a count can be checked instead of believed:

```
node deident.js review --entity PERSON_11    every occurrence, grouped by session
node deident.js review --session <id>        one full transcript, read back out of the zip
```

That answers "is this spelling replaced 991 times a person's name or an ordinary
word", which no check can answer, because a wrong replacement that is reversible
passes every one of them. Both queries refuse until an export has run. The
excerpts are the text **before** substitution, so the file pairs pseudonyms with
real names AND real session ids: it is the most re-identifying thing deident
writes, it is never an archive entry and never in the output directory, and it
must not be shared or committed.

## Every flag

| Flag | Commands | Meaning |
|---|---|---|
| `--root <path>` | all | Override the resolved session-storage root. Default: `CLAUDE_CONFIG_DIR`, else `~/.claude`. Sessions are read from `<root>/projects/*/*.jsonl`, depth 0 only. |
| `--out <path>` | all | Output directory. Default: the current directory. |
| `--salt-dir <path>` | all | Override `~/.deident-private`, which holds the salt, your saved tier decisions, the entity dictionary, `denied.json`, `known-values.json` and the occurrence index. Pointing it at an empty directory starts you over completely, so **copy `denied.json` and `known-values.json` across first**: without the first, none of your deny rules load and a directory you expect to be excluded is proposed at `redact` with every check green; without the second, every value you declared as your own goes back to being something a reader has to spot. deident warns when the directory in use is missing either one and the default one has it. |
| `--json` | all | Emit the result as JSON instead of padded columns, for an agent driving the tool. |
| `--html` | `review` | Write one self-contained `review.html`. Cannot be combined with `--entity` or `--session`. |
| `--entity <ID>` | `review` | Print every occurrence of one entity. Refuses until an export has run. |
| `--session <id>` | `review` | Print one full redacted transcript. Refuses until an export has run. |
| `--triage-chars <n>` | `triage` | Characters of the first user prompt to show per session. Default 300, maximum 2,000. A limit high enough to carry whole sessions turns triage back into the expensive stage. |
| `--apply` | `triage` | Merge a verdicts file into `review.md` instead of writing the triage file. Needs `--verdicts`. |
| `--verdicts <file>` | `triage` | The verdicts file to apply. `verdict` is `drop` or `unsure`; `keep` is refused, because a triage verdict may only ever move a session toward `drop`. |
| `--preview` | `export` | Write a `.diff` to inspect in your own editor instead of a zip. |
| `--entities <file>` | `export` | The tier-1 (semantic) entity list, as JSON. Optional once `~/.deident-private/entities.json` holds one: absent, the dictionary supplies the list; present, the file wins on the identities it names and the dictionary supplies the rest. Without either, the export is refused. |
| `--audience <who>` | `export` | `teammate`, `company` or `public`. Default `public`. Decides one thing: whether your own repository name, which is your employer's product vocabulary, becomes an entity. It never holds a session back, and every kept session ships at every audience ([why it used to, and what that measured](docs/design-rationale.md#the-declared-audience-moves-the-entity-list-not-the-sessions)). |
| `--full` | `export` | Ignore what deident remembers you having read and put the whole corpus in front of a reader again. Refuses the export and writes the full `deident-candidates.txt`. Cannot be combined with `--entities`. |
| `--namespace <TAG>` | `export` | Shift the pseudonym namespace: `X` gives `X_PERSON_01`. Must match `[A-Z][A-Z0-9]{0,7}`. For a corpus that already contains tokens of the default shape. |
| `--batch-chars <n>` | `export` | How much prose one run puts in `deident-candidates.txt` before deferring the rest. Default 120,000 characters, roughly 30k tokens. Only the sessions actually in the file are recorded as read, so a smaller number means more rounds, never a weaker claim. |
| `--skip-unclassified` | `export` | Confirm that workspaces you never gave a tier stay out. Without it, an unclassified workspace refuses the export rather than being silently dropped. |
| `--skip-unreadable` | `scan`, `export` | Continue past a line that is not valid JSON instead of exiting 3. Each skipped line is reported. |
| `--skip-unknown-types` | `scan`, `export` | Drop records whose type deident has never seen instead of refusing. The dropped types and counts are printed in the "NOT protected against" block. Refusal stays the default; this exists because a harness ships a new record type every few weeks and one such line should not block a whole export. |
| `--include-denied <name>` | `export` | Typed confirmation for one deny-listed workspace. Exact name, no globs. Repeatable. |
| `--selftest` | global | Run the fixture suite and exit. |
| `--help` | global | Print usage and exit 0. |
| `--version` | global | Print the version and exit 0. |

A flag a command does not accept is an error, not a silent no-op.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | success, or an informational command |
| 1 | a check failed, or the export was refused. Nothing was written. |
| 2 | bad usage. Usage text printed. |
| 3 | an input could not be read and `--skip-unreadable` was not given |

Any non-zero exit leaves no output file behind. Verification happens before
anything is written, never after.

## What is in the zip

One `.jsonl` per session under `sessions/<pseudonym>/<rewritten-uuid>.jsonl`.
Entry names are de-identified too and uuids inside them are rewritten: the raw
name would carry your username in the directory slug and the real session uuid in
the filename, neither of which is inside any JSON body.

**Kept**: user prose, agent prose, thinking blocks, tool names, tool results
(head-and-tail capped, with the omission stated), `is_error`, prompts from
`queue-operation` and `last-prompt` that appear nowhere else, and timestamps
quantised to the minute. **Dropped**: all code content, all images, all pasted
documents, account and organisation uuids, session titles, harness bookkeeping,
hook output, and the local skill/agent/MCP inventories.

Code is replaced by a **count**. `code_added_lines` is the true added-line count
from `structuredPatch`, and it is `null` when unknown, never `0`. On the
development corpus the reconstructed net undercounts the true added count by
44.5%, and 31.9% of edits have added > 0 with net == 0, so a net figure is not a
substitute.

## Development

```
node deident.js --selftest      # 175 fixtures, plain node:assert, no framework
```

Each fixture exists because it catches a specific bug, named in the fixture.
Several carry a negative control, because a check that cannot fail proves nothing.
Editing the skill and wondering why nothing changed? Installing copies the
repository into a version-keyed cache, and updating does not re-copy it: [the way
out](docs/design-rationale.md#installing-copies-the-repository-and-updating-does-not-re-copy-it).

[`docs/design-rationale.md`](docs/design-rationale.md) is why the tool refuses
what it refuses. Beside it, `cli-ux.md` is the interface contract, `scope.md` what
ships now and what waits, `privacy-tiers.md` the slice-2 tier design,
`audience-and-floor.md` the measurement that moved the audience axis off the
session decision, and `model-tier.md` which model tiers can do the one step a
person or an agent has to do by reading. `BRIEF.md` and `PLAN.md` are the
engineering brief and the slice-1 plan; the section numbers quoted throughout the
source refer to them.

Never commit a session log, an export, a preview diff or the salt. `.gitignore`
covers all of them; do not weaken it.
