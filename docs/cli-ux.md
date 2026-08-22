# CLI user experience — the slice 1 contract

**This is part of slice 1, not a later polish pass.** The tool's job is to make
an engineer willing to hand over their session logs. That willingness is produced
by the interface, not by the substitution algorithm. Build to this.

The browser review UI is deferred (trigger: the first uploader who is not on the
team). Everything below is terminal plus plain files, and is sufficient for the
seven-person internal run.

---

## 1. Three commands, and the first two write nothing dangerous

```
deident scan      survey what is here and propose tiers.  Writes review.md only.
deident review    render review.md as a readable HTML file. Writes nothing else.
deident export    run every check, then produce the zip.
```

Bare `deident` and `deident --help` print usage and exit 0. **Bare `deident`
never exports.** The default action of a tool that ships data off a machine is to
show you what it would do.

## 2. `scan` — the census comes before any question

Nobody can consent to something whose scale they cannot see.

```
$ deident scan

  Claude Code sessions   225 files · 818 MB · 2026-05-02 → 2026-08-22
  Workspaces             31

  Proposed tiers
    redact          16 workspaces   161 sessions
    open             1 workspace      9 sessions
    exclude         12 workspaces    47 sessions   (3 matched the deny-list)
    unclassified     2 workspaces     8 sessions   (excluded until you decide)

  Nothing has been written except review.md.
  Next:  deident review        (look at it)
         deident export        (after you have)
```

Counts, sizes and a date range. No progress bars.

## 3. `review.md` is both the report and the config

The decision is made by **editing a text file**, not by answering prompts.
Engineers trust a file they can grep, diff and keep. A prompt sequence cannot be
reviewed by a second person; a file can.

```markdown
# deident review · 2026-08-22
# Edit the tier in column 1, save, then run: deident export
# Tiers: exclude | count-only | redact | open

## workspaces
redact       gitroll                   61 sessions   gitroll-dev/gitroll (private)
redact       treasury-fde-bpa          22 sessions   gitroll-dev/... (private)
open         moss-local                 9 sessions   no remote  ← consider redact
exclude      private-archive                  4 sessions   deny-list matched: "redacted-name"
exclude      ops-handover-private   0 sessions   deny-list matched: "private"
exclude      <home>                    47 sessions   no remote, outside projects/
unclassified passport-viz               6 sessions   NEW since last export

## sessions worth a second look
drop   2026-08-14  gitroll   "幫我看一下這個月薪水怎麼算"      cwd touched \private
keep   2026-08-15  gitroll   "把 passport 的 hero section 重做"
keep   2026-08-16  gitroll   "這個 residual scan 要怎麼寫"

## entities to be replaced  (47)
PERSON_03   ← 3 spellings, 988 occurrences   confidence: high   (seeded from git config)
ORG_01      ← 2 spellings, 412 occurrences   confidence: high   (seeded from git remote)
PERSON_11   ← 1 spelling,   4 occurrences    confidence: LOW    (semantic pass)  ← check me
```

Rules this shape enforces:

- **Low-confidence entities are listed individually and marked.** They never share
  a collapsed row with high-confidence ones. A row reading `names 12 items
  [expand]` is a button nobody presses; that is how the review becomes theatre.
- **The per-session list exists** and is the last escape hatch, because no
  classification scheme is right the first time. Sessions whose `cwd` touched a
  deny-listed path are pre-marked `drop`.
- **`unclassified` is visible and excluded.** New workspaces are never swept in.

## 4. `review --html` — read in the browser, decide in the text file

One self-contained HTML file, written to disk, opened by the user. **No local
server.** That sidesteps the whole localhost-CSRF and port-binding threat surface
for zero loss: viewing needs no interactivity, and the decision already lives in
`review.md`.

It renders side-by-side before/after for a sample of every replacement class, and
lets the reader search. That is the visualisation that makes someone comfortable;
the writing side stays in a text file they control.

## 5. Every number is traceable back to evidence

A count nobody can drill into is a count nobody believes.

```
$ deident review --entity PERSON_11
  4 occurrences, 3 sessions:
    2026-08-14  gitroll  turn 47   "...跟 <PERSON_11> 約了 call..."
    2026-08-14  gitroll  turn 51   "...<PERSON_11> 說他下週..."
```

```
$ deident review --session 2026-08-14-a3f9
  full redacted transcript of one session, to stdout
```

## 6. `export` — the gate is a manifest of what leaves, not a spinner

```
$ deident export

  Checks
    serialization           27,545 / 27,545 lines byte-identical    ok
    substitution invariant  1,284 replacements, all reversible      ok
    pseudonym namespace     no pre-existing PERSON_n tokens         ok
    known-entity residue    0 occurrences of 47 entities            ok
    semantic pass           ran 2026-08-22 03:41 · 12 entities      ok

  Leaving this machine
    170 sessions from 17 workspaces
    2,104 user messages
    0 lines of code       18,402 counted, none included
    0 images              73 replaced with placeholders
    0 file paths          26,505 replaced
    0 secrets             8 replaced

  Counted but not shared   (count-only tier)
    14 sessions from 2 workspaces: session count, work mode and outcome only

  NOT protected against    (README § Limits)
    device fingerprint: MCP server names, model mix, CLI version sequence
    verbatim documents you pasted into your own messages

  → deident-export-2026-08-22.zip    14.2 MB
    salt stays at ~/.deident-private/salt — do not share it, do not commit it
```

Three blocks do the work:

- **"Leaving this machine"** is the trust mechanism. Zeros where zeros are the
  point, with the suppressed count beside each so the reader sees the material
  existed and was handled.
- **"Counted but not shared"** makes the `count-only` tier legible rather than
  looking like data went missing.
- **"NOT protected against"** is the honesty mechanism. A tool that only lists its
  strengths gets over-trusted, and the first surprise destroys it permanently.

## 7. Wording is a security control

- The residue line reads **`known-entity residue    0`**. Never "safe", never
  "0 leaks", never a bare green check. The scan can only find entities it already
  knows about; the label must not claim more than the mechanism delivers.
- No emoji or colour carries meaning on its own. `ok` / `FAILED` in words, because
  colour does not survive a pasted screenshot or a colour-blind reader.

## 8. Refusals name the reason and the remedy

Not a stack trace, not a bare exit code.

```
  ✗ Refusing to export: the semantic pass has not run.

    Entity discovery from prose is required. The residual scan can only find
    entities it already knows about, so without this pass a "0 residue" result
    would be meaningless.

    Inside Claude Code:   /deident-scan
    Or supply a list:     deident export --entities entities.json
```

```
  ✗ Refusing to export: 2 workspaces are unclassified.

      passport-viz      6 sessions
      fde-factory       2 sessions

    New workspaces are excluded by default and never exported silently.
    Set a tier for each in review.md, or run with --skip-unclassified to
    confirm you want them left out.
```

## 9. Errors name the file, the line, and the fix

Every failure the user can hit is caught and reported in this shape. A traceback
reaching the terminal is a bug, tracked as such.

```
  ✗ Could not read session file
      C:\Users\devuser\.claude\projects\C--Users-devuser\a3f9....jsonl
      line 4,102 is not valid JSON (unexpected end of input)

    This usually means the session was still being written. Close that Claude
    Code session, or skip the file with --skip-unreadable.
```

## 10. Exit codes

| Code | Meaning |
|---:|---|
| 0 | success, or an informational command |
| 1 | a check failed, or the export was refused. Nothing was written. |
| 2 | bad usage. Usage text printed. |
| 3 | an input could not be read and `--skip-unreadable` was not given |

**Any non-zero exit leaves no output file behind.** Verification happens before
anything is written, never after.

## 11. Idempotence and the second run

Running `export` twice with the same input and the same salt produces
byte-identical output. Nothing prompts twice: tier decisions live in
`~/.deident-private/workspaces.json` and are reused, so the second export is one
command with no review step unless a new workspace appeared.

If a new workspace did appear, `export` refuses (see §8) rather than guessing.
