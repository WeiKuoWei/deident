# CLI user experience — the slice 1 contract

**This is part of slice 1, not a later polish pass.** The tool's job is to make
an engineer willing to hand over their session logs. That willingness is produced
by the interface, not by the substitution algorithm. Build to this.

The browser review UI is deferred (trigger: the first uploader who is not on the
team). Everything below is terminal plus plain files, and is sufficient for the
seven-person internal run.

---

## 1. Four commands, and the first three write nothing dangerous

```
deident scan      survey what is here and propose tiers.  Writes review.md only.
deident review    render review.md as a readable HTML file. Writes nothing else.
deident triage    offer each still-kept session's first prompt; apply verdicts.
                  Writes deident-triage.txt, and review.md with --apply.
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
exclude      private-archive                  4 sessions   deny-list matched: "private"
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

### Layout reference, with one hard constraint

https://vibeprompts.dev is a prompt library that emits Tailwind markup. Three of
its fifteen categories are relevant here and are worth reading for layout ideas:
**Dashboards** (data tables, admin panels), **Stats Bars** (metrics, progress
indicators) and **Onboarding** (setup wizards, checklists — the scan → review →
export flow is exactly a three-step checklist). The rest are marketing-page
sections and do not apply.

**Do not take the markup literally.** The page must be a single self-contained
file: no CDN `<script>`, no external stylesheet, no remote font, no image URL.
Two reasons, and the second is the one that matters:

1. The tool makes no network calls, by design.
2. A page that renders somebody's redacted session log while fetching a script
   from a third-party CDN is the wrong optic for a privacy tool, even though the
   data itself never leaves. The first person who opens devtools and sees an
   outbound request stops trusting the whole thing, and they are right to.

So: borrow the layout, write the CSS inline, keep the file standalone. Any prompt
output that arrives with `class="..."` Tailwind utilities has to be translated,
not pasted.

Accordions from that library are usable for high-confidence classes only.
Low-confidence entities are never collapsed (§3).

## 4b. `triage`: the cheap stage, and the only one that may only ever remove

Sits between `scan` and the entity list. It exists because of one measurement
(2026-08-24, live corpus): 205 sessions, and each session's workspace plus its
first user prompt truncated to 300 characters is a 23,302-character payload,
about 7k tokens. The entity pass that follows reads 915 KB, about 250k tokens.
A 35x difference for the stage that decides whether a session ships at all is
worth a command.

The same measurement decided the shape: **0 of those 205 sessions carry an
`ai-title` record.** Titles are not available. The first user prompt is the
surface; 161 of 205 have one, and a session that has none says so on its row
rather than being hidden.

```
$ deident triage --out <workdir>

  164 sessions still proposed keep, 300 characters of first prompt each
    3 of them carry no first user prompt and say so in the file

  → deident-triage.txt    23.4 KB
    Raw prose: tier-0 substitution has not run over it. Local only, like review.md
    A verdict can only ever drop a session. There is no keep verdict
```

`deident-triage.txt` holds one block per session the review still proposes to
`keep`: id, date, workspace, and the truncated first prompt. Only the HEAD of
each session file is read (256 KB), never the whole thing. A triage that reads
the whole session is the expensive stage wearing a hat. `--triage-chars <n>`
moves the limit, bounded at 2,000, because a limit high enough to carry whole
sessions undoes the command quietly with every check still green.

The reader writes `deident-triage.json` beside it:

```json
{"verdicts": [{"id": "<session id>", "verdict": "drop", "reason": "one line"}]}
```

### The constraint, which is the whole design

**A triage verdict may only ever move a session toward `drop`.** It may never
propose `keep` and it may never overturn an existing `drop`. Both halves are
enforced in code: `keep` is a refusal naming the row, and a verdict against a
row that already reads `drop` is a counted no-op.

That is what makes a cheap model acceptable at this stage and nowhere else.
`docs/model-tier.md` disqualifies the low tier for the entity pass because its
failures are MISSES, and a miss there is a disclosure. Here the only power on
offer is removal, so a wrong verdict costs coverage and never privacy. The
moment a verdict can release a session, that argument is gone, which is why the
rule lives in the parser rather than in the header.

`unsure` is the second accepted value and changes nothing. It exists so a row
somebody looked at and left alone does not read the same as a row nobody
reached.

```
$ deident triage --apply --verdicts deident-triage.json --out <workdir>

  ! verdict for "a3f9..." was not applied: no session with that id, and none in
    the corpus either. It was probably deleted between runs

  12 verdicts read
    9 applied
    2 changed nothing (already dropped, or "unsure")
    1 matched no row in review.md (see the warnings above)

  → review.md
```

`--apply` writes `drop` into column 1 of the `## sessions` section and appends
the reason to that row, then remembers the drop in
`~/.deident-private/workspaces.json` beside the tiers, so a later `scan` into a
different directory does not lose it (§11).

A verdict naming a session that is not in the corpus is a **warning, not a
refusal.** Sessions get deleted between runs, and refusing would throw away
every other verdict in the same file over somebody tidying a directory.

Two properties of the file that a reader has to be told, and the file tells
them itself:

- It carries **raw prose**. Unlike `deident-candidates.txt`, tier-0 substitution
  has not run over it, so handing it to a model sends untouched session text to
  that model. That is the cost, and it is why the payload is one truncated line
  per session rather than a transcript. Local only, like `review.md`.
- It offers only sessions currently proposed `keep`. Paying a reader to look at
  a session that is already out is the waste the command exists to remove.

## 5. Every number is traceable back to evidence

A count nobody can drill into is a count nobody believes.

**Not implemented in slice 1.** Both queries below need an occurrence index the
export pass builds and throws away; neither is wired up. They exit 2 with a
usage error naming this section, because a flag that exits 0 without doing its
job is worse than a flag that is not accepted: a scripted check of "can I drill
into PERSON_11" passes.

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
    0 secrets             8 replaced (3 distinct)
    0 phone numbers       41 replaced (10 distinct)

    11,523 lines dropped: outside an included directory
    2 sessions retained nothing and are not in the archive

  Counted but not shared   (count-only tier)
    14 sessions from 2 workspaces: session count, work mode and outcome only

  NOT protected against    (README § Limits)
    device fingerprint: localhost ports, model mix, CLI version sequence
    verbatim documents you pasted into your own messages

  → deident-export-2026-08-22.zip    14.2 MB
    salt stays at ~/.deident-private/salt — do not share it, do not commit it
```

Three blocks do the work:

- **"Leaving this machine"** is the trust mechanism. Zeros where zeros are the
  point, with the suppressed count beside each so the reader sees the material
  existed and was handled. A count that is not a zero-where-zero-is-the-point
  gets its own line shape: `0 dropped by cwd   3 lines outside an included
  directory` asserts a number and then contradicts it, in the one block whose
  whole job is being believed.
- **"Counted but not shared"** makes the `count-only` tier legible rather than
  looking like data went missing.
- **"NOT protected against"** is the honesty mechanism. A tool that only lists its
  strengths gets over-trusted, and the first surprise destroys it permanently.
  It must also not list something the tool *does* handle. MCP server names sat
  in this block while `seed.mjs` was adding them to the entity list and the
  boundary rule was guaranteeing none of them ever matched — a disclosure
  hiding an implemented-but-inert control, which is worse than either honest
  option.

## 7. Wording is a security control

- The residue line reads **`known-entity residue    0`**. Never "safe", never
  "0 leaks", never a bare green check. The scan can only find entities it already
  knows about; the label must not claim more than the mechanism delivers.
- No emoji or colour carries meaning on its own. `ok` / `FAILED` in words, because
  colour does not survive a pasted screenshot or a colour-blind reader.

## 8. Refusals name the reason and the remedy

Not a stack trace, not a bare exit code.

```
  ✗ Refusing to export: the semantic pass has not run

    Entity discovery from prose is required. The residual scan can only find
    entities it already knows about, so without this pass a "0 residue" result
    would be meaningless.

    The tier-0-cleaned prose to review is at:  deident-candidates.txt

    Produce the prose to read:   node deident.js export --preview
    Then supply the list:        node deident.js export --entities deident-entities.json
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
      C:\Users\<you>\.claude\projects\C--Users-<you>\a3f9....jsonl
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

Two deliberate exceptions, stated rather than hidden.

The first: the semantic-pass refusal writes `deident-candidates.txt` and then
points at it, because the whole remedy is "read this file and write an entity
list". It is written on that refusal path
and on no other, it holds tier-0-cleaned prose that the semantic pass has not
seen yet — third-party names included, by design — and the tier-0 residual scan
runs over it before it is written. Treat it the way you treat `review.md`: local
only, never shared, never committed.

The second: a SUCCESSFUL export writes `export-map.txt` beside the zip, one
`<real session id>  <archive entry>` line per exported session. privacy-tiers §4
level 3 is the last look, and a last look cannot act without attribution: every
id inside the archive has already been rewritten, so nothing on the machine
otherwise says which entry is which session. It maps a local id to a local id
rather than a pseudonym to a name, so it is not a re-identification key for the
data that left — but it is local only, never shared, never committed, and it is
removed along with the zip if anything after it fails.

## 11. Idempotence and the second run

Running `export` twice with the same input and the same salt produces
byte-identical output. Nothing prompts twice: tier decisions live in
`~/.deident-private/workspaces.json` and are reused, so the second export is one
command with no review step unless a new workspace appeared.

If a new workspace did appear, `export` refuses (see §8) rather than guessing.
