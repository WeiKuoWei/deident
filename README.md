# deident

A CLI that exports your AI-coding-agent session logs, de-identifies them, and
produces a zip you can hand to someone else.

Node v22, standard library only, **no npm dependencies and no network calls**.
It reads local files and writes local files. That property is the product.

Status: slice 1. Claude Code logs only, depth-0 sessions only, no server and no
browser UI.

---

## The three-step workflow

Three commands. The first two write nothing that can leave the machine.

```
1.  node deident.mjs scan
       Surveys the corpus and writes review.md. Nothing else.
       Open review.md and set a tier for each workspace: exclude, count-only,
       redact or open. A workspace you do not touch stays excluded.

2.  node deident.mjs export --preview
       Runs every check, writes deident-candidates.txt (tier-0-cleaned prose)
       and a before/after .diff. No zip.
       Then fill in the entity list: run /deident-scan inside Claude Code, or
       write deident-entities.json by hand.

3.  node deident.mjs export --entities deident-entities.json
       The real thing. Every check runs again first; any failure means nothing
       is written.
```

`deident` with no arguments prints usage and exits 0. **It never exports by
default.** The default action of a tool that ships data off a machine is to show
you what it would do.

## Commands

| Command | Writes | Notes |
|---|---|---|
| `scan` | `review.md` | A census plus a proposed tier per workspace. |
| `review` | `review.html` with `--html` | Read in the browser, decide in the text file. No local server is ever started. |
| `export` | the zip, or a `.diff` with `--preview` | Runs every check first. Any failure means nothing is written. |

`review.md` is both the report and the config. The decision is made by editing a
text file, not by answering prompts: an engineer trusts a file they can grep,
diff and keep, and a prompt sequence cannot be reviewed by a second person.

## Every flag

| Flag | Commands | Meaning |
|---|---|---|
| `--root <path>` | all | Override the resolved session-storage root. Default: `CLAUDE_CONFIG_DIR`, else `~/.claude`. Sessions are read from `<root>/projects/*/*.jsonl`, depth 0 only. |
| `--out <path>` | all | Output directory. Default: the current directory. |
| `--salt-dir <path>` | all | Override `~/.deident-private`. The salt and your saved tier decisions live here. |
| `--html` | `review` | Write one self-contained `review.html`. Cannot be combined with `--entity` or `--session`. |
| `--entity <ID>` | `review` | Print the occurrences of one entity. |
| `--session <id>` | `review` | Print one full redacted transcript. |
| `--preview` | `export` | Write a `.diff` for inspection in your own editor instead of a zip. |
| `--entities <file>` | `export` | Supply the tier-1 (semantic) entity list as JSON. Without it the export is refused. |
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
       {"kind": "person", "spellings": ["Ada Wang", "AdaWang", "Ada"], "confidence": "high"},
       {"kind": "org",    "spellings": ["Acme Advisory"],                  "confidence": "low"}
     ]
   }
   ```

   `kind` is one of `person | org | client | workspace | machine`.
   `confidence` is `high` or `low`; low-confidence entities are listed
   individually in the review and are never collapsed into a count.

   List every spelling you actually see, including run-together forms that turn
   up in filenames and handles. The boundary rule treats `Ada Wang` and
   `AdaWang` as different strings and will not find the second from the first.
3. `export --entities deident-entities.json`.

Inside Claude Code, `/deident-scan` does step 2 for you. It is a project slash
command in `.claude/commands/`, so it is available when you run deident from
this repository.

The candidates file carries **cleaned** prose, never the raw records. Handing raw
text to a discovery pass would ship unredacted paths, your username and your
emails into the discovery context: a privacy tool leaking inside its own privacy
step.

A malformed entity list is refused, never silently treated as an empty one. An
empty list would satisfy "the pass ran" while delivering nothing.

## Opt-in, never opt-out

A workspace deident has not seen before is `unclassified`, which means excluded.
It is never swept in. Beyond that, a workspace whose name (or whose per-line
`cwd`) contains `private`, `identity`, `payroll` or `redacted-name` is excluded and needs
`--include-denied <exact-name>` typed out to include.

The per-line `cwd` filter matters more than it sounds. The largest session file
on the development machine spans **11 distinct working directories**, two of them
under `\private`, inside a workspace that is not itself deny-listed. Opting in at
the directory level alone would have exported payroll material. In the acceptance
run, 4,553 lines were dropped by this filter from workspaces that were otherwise
included.

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
created file shows only inherited entries. That is honest rather than fixed —
`%USERPROFILE%` is already user-scoped and any local administrator can read the
file regardless — but do not read `mode: 0600` in the source as a guarantee. If
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

**A name touching a letter or a digit is left alone.** The boundary rule is
`(?<![A-Za-z0-9])X(?![A-Za-z0-9])`, with two exceptions: an underscore is a
token boundary for spellings of five characters or more, and a camel-case hump
always is. That is what makes `mcp__<server>__tool`, `project_<org>_notes.md`
and `<Org>AI` real matches while keeping `ray` inside `array` a correct
non-match — the case a tool without the rule would get wrong, destroying prose
and being switched off within a day.

What is still left alone is a spelling abutting an ordinary letter or digit:
`<name>son`, `<org>123`. The manifest reports that count and it is not zero. If
your sessions discuss files or handles built out of people's names, read the
preview before you send the zip.

**Credentials and phone numbers are matched by shape, and only by shape.**
Anything with an unambiguous vendor prefix (`github_pat_`, `ghp_`, `sk-ant-`,
`xoxb-`, `AKIA`, `ntn_`, `AIza`) is force-replaced, and so is any `+<country
code><8-15 digits>` phone number. Both are tuned for precision: an entropy
heuristic would fire on every hash and uuid in your logs, and a scan that cries
wolf is the first thing switched off. **A credential in a shape not on that list
is not detected.** A password typed in prose, a bearer token with no prefix, a
private key body: those are text, and only the semantic pass can catch them.

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
node deident.mjs --selftest
```

39 fixtures, plain `node:assert`, no framework and no network. Each one exists
because it catches a specific bug, named in the fixture. Several carry a negative
control, because a check that cannot fail proves nothing.

`docs/cli-ux.md` is the interface contract, `docs/privacy-tiers.md` is the
slice-2 tier design, and `docs/adapters-research.md` records what is and is not
established about other vendors' log formats. `BRIEF.md` is the engineering brief
and `PLAN.md` the slice-1 implementation plan; the section numbers quoted
throughout the source refer to them.

Never commit a session log, an export, a preview diff or the salt. `.gitignore`
covers all of them; do not weaken it.
