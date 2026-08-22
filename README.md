# deident

A CLI that exports your AI-coding-agent session logs, de-identifies them, and
produces a zip that is safe to hand to someone else.

Node v22, standard library only, **no npm dependencies and no network calls**.
It reads local files and writes local files. That property is the product.

---

## Quick start

```
node deident.mjs scan          # survey what is here. Writes review.md only.
                               # then edit review.md and set a tier per workspace
node deident.mjs export --preview
                               # runs every check, writes a before/after diff
                               # and the tier-1 candidates file. No zip.
node deident.mjs export --entities deident-entities.json
                               # the real thing
```

`deident` with no arguments prints usage and exits. **It never exports by
default.** The default action of a tool that ships data off a machine is to show
you what it would do.

## The three commands

| Command | Writes | Notes |
|---|---|---|
| `scan` | `review.md` | A census plus a proposed tier per workspace. Nothing else. |
| `review` | `review.html` with `--html` | Read in the browser, decide in the text file. No local server is ever started. |
| `export` | the zip, or a `.diff` with `--preview` | Runs every check first. Any failure means nothing is written. |

`review.md` is both the report and the config. The decision is made by editing a
text file, not by answering prompts: engineers trust a file they can grep, diff
and keep, and a prompt sequence cannot be reviewed by a second person.

## The semantic pass is mandatory

Entity discovery from prose is required, and if it did not run the export is
**refused**. This is not a nag. The residual scan can only find entities it
already knows about, so without the semantic pass a "0 residue" result would be
meaningless.

deident makes no network calls, so the pass is a **file contract**:

1. `deident export --preview` writes `deident-candidates.txt` — the prose from
   your sessions **after** tier-0 substitution has already removed your
   username, paths, git identity, git remotes, emails and MCP server names.
2. A host agent, or you, reads it and writes `deident-entities.json`:

   ```json
   {
     "generated": "2026-08-22T04:50:00Z",
     "entities": [
       {"kind": "person", "spellings": ["Ada Wang", "Ada"], "confidence": "high"},
       {"kind": "org",    "spellings": ["Acme Advisory"],    "confidence": "high"}
     ]
   }
   ```

   `kind` is one of `person | org | client | workspace | machine`.
   `confidence` is `high` or `low`; low-confidence entities are listed
   individually in the review and are never collapsed into a count.
3. `deident export --entities deident-entities.json`.

The candidates file carries **cleaned** prose, never the raw records. Handing raw
text to a discovery pass would ship unredacted paths, your username and your
emails into the discovery context: a privacy tool leaking inside its own privacy
step.

## Opt-in, never opt-out

A workspace deident has not seen before is `unclassified`, which means excluded.
It is never swept in. Beyond that, a workspace whose name — or whose per-line
`cwd` — contains `private`, `identity`, `payroll` or `redacted-name` is excluded and needs
`--include-denied <exact-name>` typed out to include.

The per-line `cwd` filter matters more than it sounds. The largest session file
on the development machine spans **11 distinct working directories**, two of them
under `\private`, inside a workspace that is not itself deny-listed. Opting in at
the directory level alone would have exported payroll material.

## What is in the zip

One `.jsonl` per session under `sessions/<pseudonym>/<rewritten-uuid>.jsonl`.
Entry names are de-identified too — the raw name would carry your username in
the directory slug and the real session uuid in the filename.

Kept: user prose, agent prose, thinking blocks, tool names, tool results
(head-and-tail capped, with the omission stated), `is_error`, prompts from
`queue-operation` and `last-prompt` that appear nowhere else, and timestamps
quantised to the minute.

Dropped: all code content, all images, all pasted documents, account and
organisation uuids, session titles, harness bookkeeping, hook output, and the
local skill/agent/MCP inventories.

Code is replaced by a **count**. `code_added_lines` is the true added-line count
taken from `structuredPatch`, and it is `null` when unknown — never `0`. On the
development corpus, the reconstructed net undercounts the true added count by
44.5%, and 31.9% of edits have added > 0 with net == 0.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | success, or an informational command |
| 1 | a check failed, or the export was refused. Nothing was written. |
| 2 | bad usage. Usage text printed. |
| 3 | an input could not be read and `--skip-unreadable` was not given |

Any non-zero exit leaves no output file behind. Verification happens before
anything is written, never after.

## Reversal, and the salt

Pseudonyms are `sha256(salt + kind + entity)`. The salt lives at
`~/.deident-private/salt`, mode 0600, and is **never** written into any output,
manifest, preview or log line. Do not share it and do not commit it.

There is deliberately **no plaintext entity-to-pseudonym map**. Such a file is a
portable re-identification key for data that has already left the machine, and
the raw logs are not. To reverse, regenerate the entity list locally and hash the
candidates.

The salt is per-uploader. Seven people uploading to one recipient who also holds
the roster is a seven-way guess, and a shared salt would mean cracking one cracks
all.

## Limits — what deident does NOT protect against

A tool that only lists its strengths gets over-trusted, and the first surprise
destroys it permanently. So, plainly:

**The residue indicator says `known-entity residue: 0`, not "safe".** It searches
for entities it already knows about. A third-party name that the seed sources
never knew and the semantic pass missed is, by construction, undetectable by it.
On a 90-file sample of the development corpus there were 230 distinct email
addresses, 228 of them not the user's. Emails have a regex and are swept
automatically. **Names do not have a regex.** That is what the semantic pass is
for, and it is why it is mandatory rather than optional.

**Device fingerprint survives.** The MCP server names are replaced, but the model
mix, the Claude Code version sequence, the tool inventory and localhost ports are
all still inferable from what remains. Timestamps are quantised to the minute,
which removes millisecond-level correlation and nothing more.

**Verbatim documents you pasted into your own messages are not detected.** If you
pasted a contract, a résumé or a bank statement into a prompt, that text is
prose, and only the semantic pass can catch what is in it.

**Entity spellings inside longer words are left alone, by design.** `ray` inside
`array` is a correct non-match, and a tool that replaced it would destroy prose
and be switched off within a day. The export tells you how many such occurrences
there were rather than letting you assume the number is zero.

**Four of six upstream scoring axes depend on rules that are not published.** In
particular, nobody outside the scoring pipeline knows what `failure_signal` is
counted from. If truncating `tool_result` were to push it below its threshold,
`hits_trouble` would go false, Resilience would go null and the overall score
would **rise**. deident therefore caps tool results generously rather than
tightly, preserves `is_error` verbatim regardless of truncation, and keeps every
threshold as a named constant in `src/retain/constants.mjs`.

**Subagent and workflow transcripts are not exported.** Only depth-0 human
sessions are read. Orchestration is still visible through the parent session's
`Agent` and `Workflow` tool calls.

## Development

```
node deident.mjs --selftest
```

35 fixtures, plain `node:assert`, no framework and no network. Each one exists
because it catches a specific bug, named in the fixture. Three carry a negative
control, because a check that cannot fail proves nothing.

`docs/cli-ux.md` is the interface contract, `docs/privacy-tiers.md` is the
slice-2 tier design, and `docs/adapters-research.md` records what is and is not
established about other vendors' log formats.
