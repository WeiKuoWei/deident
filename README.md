# deident

A CLI that exports your AI-coding-agent session logs, de-identifies them, and
produces a zip you can hand to someone else.

Node v22, standard library only, **no npm dependencies and no network calls**.
It reads local files and writes local files. That property is the product.

Status: slice 1. Claude Code logs only, depth-0 sessions only, no server and no
browser UI.

---

## The four-stage funnel

Each stage costs more than the one before it and hands the next one a shorter
list. That ordering is the design: nothing expensive should ever read a session
that was never going to be exported.

```
1.  node deident.js scan                              cheap: one pass, no reader
       Surveys the corpus and writes review.md. Nothing else.
       Open review.md and set a tier for each workspace: exclude, count-only,
       redact or open. A workspace you do not touch stays excluded.

2.  node deident.js triage                            ~7k tokens of reading
       Writes deident-triage.txt: one block per session still proposed keep,
       carrying its first user prompt truncated to 300 characters. Only the
       head of each session file is read.
       A reader writes deident-triage.json, then:
         node deident.js triage --apply --verdicts deident-triage.json
       A verdict can only ever DROP a session. There is no keep verdict and a
       verdict cannot overturn a drop, which is why a cheap model is the right
       one here (docs/model-tier.md).

3.  node deident.js export --preview                  ~1M tokens of reading
       Runs every check, writes deident-candidates.txt (tier-0-cleaned prose)
       and a before/after .diff. No zip.
       Then fill in the entity list: hand this step to an agent, or write
       deident-entities.json by hand. An agent's instructions ship twice,
       as skills/deident/SKILL.md and as AGENTS.md, with the same text in
       both.

4.  node deident.js export --entities deident-entities.json
       The real thing, and the only stage that writes an archive. Every check
       runs again first; any failure means nothing is written. Measured at
       more than ten minutes on a few hundred sessions.
```

Measured 2026-08-24 on a 205-session corpus: stage 2 reads 23 KB and stage 3
reads 915 KB, a 35x difference for the stage that decides whether a session
ships at all. Stage 2 is optional; skipping it just means stage 3 reads
sessions a person would have thrown out.

That 915 KB was measured while the candidates file truncated every prose chunk
at 400 characters and deduplicated on the first 80 of each. It no longer does
either, because both losses were silent and neither was counted. Measured over
the whole depth-0 corpus with the same workspace decisions before and after,
the change multiplies stage 3 by **3.95** (2,957,659 bytes to 11,684,461), so
budget stage 3 near 3.5 MB and about 900k tokens on a 205-session corpus.
Stage 2 got cheaper relative to it by the same factor, so the argument for
running it is now much stronger than 35x.

A per-chunk limit of 20,000 characters remains, which on that corpus cut
1,336,271 characters, 10.3% of the prose. **That number is printed** beside the
file path, written into the file itself and carried as `candidates.omittedChars`
in `--json`, because a reader handed a short file has to be told it is short.

### The funnel has a memory

Stage 3 is the only stage whose cost grows with the corpus, and it used to be
paid in full every time. What a person declared is now remembered in
`~/.deident-private/entities.json`, beside the salt, along with a content hash
of every session that has been put in front of a reader.

So a second run reads only the sessions that are new or that changed:

```
   first run    deident-candidates.txt   211.0 KB    every session
   days later   deident-candidates.txt    12.2 KB    three new sessions
```

(measured on a synthetic 60-session corpus; on the live 205-session one the
first read is 915 KB.) And when nothing changed at all, stage 4 is one command
with no reading in front of it:

```
   node deident.js export          # --entities is optional once the dictionary exists
```

The dictionary is plaintext and you may edit it by hand: add a spelling, or
delete an entry that was wrong. It is local only, it pairs real spellings with
real session ids, and it is never written into the archive, the output
directory or this repository. `docs/cli-ux.md` §11b has the shape.

The safety half of the same change: the gate that says a semantic pass ran is
now **per session**. Every session in an export must have been through one, in
this run or in a recorded earlier one, and one that is new or changed refuses
the export by name. That is stricter than what it replaced, including for runs
that use no dictionary at all: `export --entities an-old-list.json` over a
corpus that has grown used to ship the new sessions on the strength of a list
written before they existed. `deident export --full` re-reads everything, for
when you have changed your mind about what counts as an identity.

`deident` with no arguments prints usage and exits 0. **It never exports by
default.** The default action of a tool that ships data off a machine is to show
you what it would do.

## Commands

| Command | Writes | Notes |
|---|---|---|
| `scan` | `review.md` | A census plus a proposed tier per workspace. |
| `review` | `review.html` with `--html` | Read in the browser, decide in the text file. No local server is ever started. |
| `triage` | `deident-triage.txt`, or `review.md` with `--apply` | One truncated first prompt per still-kept session, and the verdicts on it. A verdict can only ever drop a session. |
| `export` | the zip and `export-map.txt`, or a `.diff` with `--preview` | Runs every check first. Any failure means nothing is written. |

`export-map.txt` sits beside the zip and holds one `<real session id>  <archive
entry>` line per exported session. It exists so you can act on the last look:
every id inside the archive has been rewritten, so without it nothing on your
machine says which entry is which session. It pairs a local id with a local id,
never a pseudonym with a name, but treat it like `review.md`: **local only,
never shared, never committed.** A failed export removes it along with the zip.

`review.md` is both the report and the config. The decision is made by editing a
text file, not by answering prompts: an engineer trusts a file they can grep,
diff and keep, and a prompt sequence cannot be reviewed by a second person.

## Every flag

| Flag | Commands | Meaning |
|---|---|---|
| `--root <path>` | all | Override the resolved session-storage root. Default: `CLAUDE_CONFIG_DIR`, else `~/.claude`. Sessions are read from `<root>/projects/*/*.jsonl`, depth 0 only. |
| `--triage-chars <n>` | `triage` | Characters of the first user prompt to show per session. Default 300, maximum 2,000. A limit high enough to carry whole sessions turns triage back into the expensive stage. |
| `--apply` | `triage` | Merge a verdicts file into `review.md` instead of writing the triage file. Needs `--verdicts`. |
| `--verdicts <file>` | `triage` | The verdicts file to apply. `verdict` is `drop` or `unsure`; `keep` is refused, because a triage verdict may only ever move a session toward `drop`. |
| `--out <path>` | all | Output directory. Default: the current directory. |
| `--salt-dir <path>` | all | Override `~/.deident-private`. The salt, your saved tier decisions and the remembered entity dictionary live here. |
| `--html` | `review` | Write one self-contained `review.html`. Cannot be combined with `--entity` or `--session`. |
| `--entity <ID>` | `review` | Print the occurrences of one entity. |
| `--session <id>` | `review` | Print one full redacted transcript. |
| `--preview` | `export` | Write a `.diff` for inspection in your own editor instead of a zip. |
| `--entities <file>` | `export` | Supply the tier-1 (semantic) entity list as JSON. Optional once `~/.deident-private/entities.json` holds one: absent, the dictionary supplies the list; present, the file wins on the identities it names and the dictionary supplies the rest. Without either, the export is refused. |
| `--full` | `export` | Ignore what deident remembers you having read and put the whole corpus in front of a reader again. Refuses the export and writes the full `deident-candidates.txt`. Cannot be combined with `--entities`. |
| `--namespace <TAG>` | `export` | Shift the pseudonym namespace, e.g. `X` gives `X_PERSON_01`. Must match `[A-Z][A-Z0-9]{0,7}`. Use it when the corpus already contains tokens of the default shape. |
| `--skip-unclassified` | `export` | Confirm that workspaces you never gave a tier stay out. Without it, an unclassified workspace refuses the export rather than being silently dropped. |
| `--skip-unreadable` | `scan`, `export` | Continue past a line that is not valid JSON instead of exiting 3. Each skipped line is reported. |
| `--skip-unknown-types` | `scan`, `export` | Drop records whose type deident has never seen instead of refusing. The dropped types and their counts are printed in the "NOT protected against" block. Refusal stays the default; this exists because Claude Code ships a new record type every few weeks and one such line in one session should not block a whole export. |
| `--include-denied <name>` | `export` | Typed confirmation for one deny-listed workspace. Exact name, no globs. Repeatable. |
| `--selftest` | global | Run the fixture suite and exit. |
| `--help` | global | Print usage and exit 0. |
| `--version` | global | Print the version and exit 0. |

A flag that a command does not accept is an error, not a silent no-op. That is
deliberate: `--preview` quietly ignored by `scan` is how a surprise export
happens.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | success, or an informational command |
| 1 | a check failed, or the export was refused. Nothing was written. |
| 2 | bad usage. Usage text printed. |
| 3 | an input could not be read and `--skip-unreadable` was not given |

Any non-zero exit leaves no output file behind. Verification happens before
anything is written, never after.

## The semantic pass is mandatory

Entity discovery from prose is required, and if it did not run the export is
**refused**. This is not a nag. The residual scan can only find entities it
already knows about, so without the semantic pass a zero-residue result would be
meaningless.

deident makes no network calls, so the pass is a **file contract**:

1. `export --preview` writes `deident-candidates.txt`: the prose from your
   sessions **after** tier-0 substitution has already removed your username,
   paths, git identity, git remotes, emails and MCP server names.
2. You, or a host agent, read it and write `deident-entities.json`:

   ```json
   {
     "generated": "2026-08-22T06:20:00Z",
     "entities": [
       {"kind": "person", "spellings": ["Nora Lund", "NoraLund", "Nora"], "confidence": "high"},
       {"kind": "org",    "spellings": ["Acme Advisory"],                  "confidence": "low"}
     ]
   }
   ```

   `kind` is one of `person | org | client | workspace | machine`.
   `confidence` is `high` or `low`; low-confidence entities are listed
   individually in the review and are never collapsed into a count.

   List every spelling you actually see, including run-together forms that turn
   up in filenames and handles. The boundary rule treats `Nora Lund` and
   `NoraLund` as different strings and will not find the second from the first.
3. `export --entities deident-entities.json`.

An agent can do step 2 for you. What it needs to know is one document shipped in
two places, because harnesses disagree about where to look: Claude Code loads
`skills/deident/SKILL.md` as a skill through `.claude-plugin/plugin.json`, and
every other agent reads `AGENTS.md`. The two carry the same text and a fixture
checks they have not drifted, so an agent that is not Claude Code is covered by
pointing it at `AGENTS.md`. Nothing harness-specific has to be installed, and
there is no slash command to run.

The candidates file carries **cleaned** prose, never the raw records. Handing raw
text to a discovery pass would ship unredacted paths, your username and your
emails into the discovery context: a privacy tool leaking inside its own privacy
step.

A malformed entity list is refused, never silently treated as an empty one. An
empty list would satisfy "the pass ran" while delivering nothing.

## Opt-in, never opt-out

A workspace deident has not seen before is `unclassified`, which means excluded.
It is never swept in. Beyond that, a workspace whose name (or whose per-line
`cwd`) contains `private`, `identity`, `payroll` or a token you add to
`~/.deident-private/denied.json` (`{"tokens": ["私人"]}`, any script) is excluded and needs
`--include-denied <exact-name>` typed out to include.

The three shipped tokens are English words and match nothing else, and the
"reads like personal data" check beside them is English words too. So a
workspace whose name contains any non-ASCII character is proposed
`unclassified`, which means excluded until you decide it, however ordinary the
name is: neither list can read it, and silence from an instrument that could
not look is not a clearance. Decide it once in `review.md`, or put your own
token in `denied.json` and it is excluded for good. One token there feeds the
workspace check and the per-line `cwd` check alike.

The per-line `cwd` filter matters more than it sounds. The largest session file
on the development machine spans **11 distinct working directories**, two of them
under `\private`, inside a workspace that is not itself deny-listed. Opting in at
the directory level alone would have exported payroll material. In the delivery
run of 2026-08-22, 612 lines were dropped by this filter from workspaces that
were otherwise included, and a further 32 records were withheld because they
replay text typed inside an excluded directory and carry no cwd of their own.

## What is in the zip

One `.jsonl` per session under `sessions/<pseudonym>/<rewritten-uuid>.jsonl`.
Entry names are de-identified too, and uuids inside them are rewritten. The raw
name would carry your username in the directory slug and the real session uuid in
the filename, neither of which is inside any JSON body.

Kept: user prose, agent prose, thinking blocks, tool names, tool results
(head-and-tail capped, with the omission stated), `is_error`, prompts from
`queue-operation` and `last-prompt` that appear nowhere else, and timestamps
quantised to the minute.

Dropped: all code content, all images, all pasted documents, account and
organisation uuids, session titles, harness bookkeeping, hook output, and the
local skill/agent/MCP inventories.

Code is replaced by a **count**. `code_added_lines` is the true added-line count
taken from `structuredPatch`, and it is `null` when unknown, never `0`. On the
development corpus the reconstructed net undercounts the true added count by
44.5%, and 31.9% of edits have added > 0 with net == 0, so a net figure is not a
substitute.

## Reversal, and the salt

Pseudonyms are `sha256(salt + kind + entity)`. The salt lives at
`~/.deident-private/salt` and is **never** written into any output, manifest,
preview or log line. It is 64 hexadecimal characters, and deident refuses to use
a file that is anything else: a zeroed or truncated salt would silently produce
predictable pseudonyms, which is this whole mechanism defeated in a way nothing
downstream could see.

**On Windows the file's protection is the directory it sits in, and nothing
else.** deident asks for mode `0600`, and NTFS ignores it: `icacls` on the
created file shows only inherited entries. That is honest rather than fixed
(`%USERPROFILE%` is already user-scoped and any local administrator can read the
file regardless), but do not read `mode: 0600` in the source as a guarantee. If
you want more, set an explicit ACL on `~/.deident-private` yourself.

**Do not share the salt and do not commit it.** Anyone who has both the salt and
a guess at your entity list can confirm the guess. It is the only thing standing
between a pseudonym and the name behind it, and it is per-uploader for that
reason: seven people uploading to one recipient who also holds the roster is a
seven-way guess, and a shared salt would mean cracking one cracks all.

There is deliberately **no plaintext entity-to-pseudonym map**. Such a file is a
portable re-identification key for data that has already left the machine, and
the raw logs are not. To reverse, regenerate the entity list locally and hash the
candidates.

**That reversal path has one blind spot, and the manifest names it.** Where two
declared entities overlap in the text, the substituter replaces the union and
emits both tokens, so the token they shared is gone: `the operator Wang` and
`the operator Reed Wang` produce the same output. The substitution invariant still
passes, because it reverses from the spans the pass produced, but the spans
live in memory and are never written down, so regenerating the entity list
cannot tell those two inputs apart. The export prints the count of merged
replacements for exactly this reason.

## Limits: what deident does NOT protect against

A tool that only lists its strengths gets over-trusted, and the first surprise
destroys it permanently. So, plainly:

**The check reads `known-entity residue    0 occurrences of N entity spellings`,
not "safe".** It searches for entities it already knows about. A third-party name
that the seed sources never knew and the semantic pass missed is, by
construction, undetectable by it. On a 90-file sample of the development corpus
there were 230 distinct email addresses, 228 of them not the user's. Emails have a
regex and are swept automatically. **Names do not have a regex.** That is what the
semantic pass is for, and it is why it is mandatory rather than optional.

**The semantic pass only ever sees prose, which is 2.30% of the bytes.** The
candidates file is built from `text` blocks and nothing else, because feeding a
discovery pass the other 97.7% is how it starts inventing entities. So a
third-party name that appears only inside a tool result, a directory listing or
a code block never reaches the reader at all: they cannot declare it, and the
residue scan cannot look for what was never declared. Whole prose chunks now go
into that file rather than the first 400 characters of each, which closes a
loss inside the prose. It does not widen what counts as prose.

**A name touching a letter or a digit is left alone.** The boundary rule is
`(?<![A-Za-z0-9])X(?![A-Za-z0-9])`, with two exceptions: an underscore is a
token boundary for spellings of five characters or more, and a camel-case hump
always is. That is what makes `mcp__<server>__tool`, `project_<org>_notes.md`
and `<Org>AI` real matches while keeping `ray` inside `array` a correct
non-match: the case a tool without the rule would get wrong, destroying prose
and being switched off within a day.

What is still left alone is a spelling abutting an ordinary letter or digit:
`<name>son`, `<org>123`. The manifest reports that count and it is not zero. If
your sessions discuss files or handles built out of people's names, read the
preview before you send the zip.

**Case-insensitive matching is withheld from a few spellings, on purpose.**
Spellings of four characters or more match in any casing, which is what catches
`GitRoll` when the seeded spelling is `gitroll`. The exception is a spelling
whose case change alters its **length**: Turkish dotted capital I lowercases to
two code units, German sharp s uppercases to two. The matcher computes its span
from the spelling's length, so folding those would consume the wrong span and
reversal would restore the wrong text. They stay on the literal path instead:
the exact casing still matches, the other casing simply does not. That is a
miss rather than a corruption, and it is the right way round.

**Credentials and phone numbers are matched by shape, and only by shape.**
Anything with an unambiguous vendor prefix (`github_pat_`, `ghp_`, `sk-ant-`,
`xoxb-`, `AKIA`, `ntn_`, `AIza`, `sk-proj-`, `sk_live_`, `npm_`, `glpat-`,
`hf_`, `xapp-`, and the rest of one greppable list in `src/entities/seed.mjs`)
is force-replaced, and so is any `+<country code><8-15 digits>` phone number.
So is a value whose **label** says what it is, which is the rule the prefix
list cannot be: `api_key`, `secret_key`, `access_token`, `auth_token`,
`client_secret`, `password`, a `Bearer ` header, an `X-Amz-` parameter in a
signed URL, a password written inline in a database URL. A
`-----BEGIN … PRIVATE KEY-----` block is dropped whole rather than replaced,
because half a key is still a key. All of it is tuned for precision: an entropy
heuristic would fire on every hash and uuid in your logs, and a scan that cries
wolf is the first thing switched off.

**A credential with neither a listed prefix nor a label beside it is not
detected, and nothing downstream recovers it.** The residue scan only searches
for entities it already knows. The semantic pass reads your prose and the
model's, never tool output, so a key printed by a command you ran is caught by
shape or it is not caught at all. The `0 secrets` row in the manifest means
"none of the shapes deident knows", not "no secrets", and the export block says
so at the moment you run it.

**Identity-document numbers are found by their label, in English and Chinese
only.** A number is seeded when a label word sits beside it: `passport`,
`national id`, `identity card`, `id card`, `driver's licence`, `social
security`, `ssn`, `tax id`, `fein`, and 護照, 护照, 身分證, 身份證, 台胞證,
居留證. Anchoring on the label is the same precision decision as the credential
prefixes, and for the same measured reason: a passport-shaped regex on its own
matched a thermal-paste part number. **A document number labelled in any other
language, or written with no label near it, is not detected.** Only the semantic
pass can catch that one.

**`review.md` is full of raw identity, on purpose.** It lists real absolute
paths, real workspace names, real git remotes including other people's GitHub
handles, and the deny-list token that matched each excluded directory. It has to,
or you could not recognise the rows you are deciding about. Treat it like the
salt: local only, never pasted into a ticket, never committed. The same goes for
`deident-candidates.txt`, which holds prose the semantic pass has not seen yet.

**Device fingerprint survives.** MCP server names are replaced, but the model mix,
the Claude Code version sequence, the tool inventory and localhost ports are all
still inferable from what remains. Timestamps are quantised to the minute, which
removes millisecond-level correlation and nothing more. There is no attempt to
make two machines look alike.

**Verbatim documents you pasted into your own messages are not detected.** If you
pasted a contract, a résumé, a bank statement or someone else's email into a
prompt, that text is prose. Only the semantic pass can catch what is inside it,
and it will only catch the identities it recognises. Quoted third-party writing
survives as writing.

**Fragments of an entity survive.** Tool results are capped head-and-tail, and a
cap can land in the middle of an email address or a name. The remaining fragment
matches no spelling, so neither the substituter nor the scan sees it.

**Four of six upstream scoring axes depend on rules that are not published.**
Nobody outside the scoring pipeline knows what `failure_signal` is counted from,
what a "decision point" is, whether the prompt-quality run reads only user
messages, or whether the expertise classifier reads code content. If truncating
`tool_result` were to push `failure_signal` below its threshold, `hits_trouble`
would go false, Resilience would go null and the overall score would **rise**:
the tool would silently inflate scores. deident therefore caps tool results
generously rather than tightly, preserves `is_error` verbatim regardless of
truncation, and keeps every threshold as a named constant in
`src/retain/constants.mjs` so it can be changed without a rewrite. Until those
rules are published, treat scores computed from a deident export as unverified
against scores computed from raw logs.

**Subagent and workflow transcripts are not exported.** Only depth-0 human
sessions are read; the rest of the corpus is 2.2x the payload with zero human
turns. Orchestration is still visible through the parent session's `Agent` and
`Workflow` tool calls.

## Development

```
node deident.js --selftest
```

138 fixtures, plain `node:assert`, no framework and no network. Each one exists
because it catches a specific bug, named in the fixture. Several carry a negative
control, because a check that cannot fail proves nothing.

`docs/cli-ux.md` is the interface contract, `docs/privacy-tiers.md` is the
slice-2 tier design, and `docs/adapters-research.md` records what is and is not
established about other vendors' log formats. `docs/model-tier.md` measures
which model tiers can do the one step a person or an agent has to do by reading. `BRIEF.md` is the engineering brief
and `PLAN.md` the slice-1 implementation plan; the section numbers quoted
throughout the source refer to them.

Never commit a session log, an export, a preview diff or the salt. `.gitignore`
covers all of them; do not weaken it.
