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
redact       gitroll                   61 sessions   northwind-co/ledger (private)
redact       billing-recon-ui          22 sessions   northwind-co/... (private)
open         note-vault                 9 sessions   no remote  ← consider redact
exclude      private-archive                  4 sessions   deny-list matched: "private"
exclude      ops-handover-private   0 sessions   deny-list matched: "private"
exclude      <home>                    47 sessions   no remote, outside projects/
unclassified passport-map               6 sessions   NEW since last export

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

That 915 KB predates the candidates file carrying whole prose chunks, which was
measured over the whole depth-0 corpus at **3.95x** the old size (2,957,659
bytes to 11,684,461, with 1,336,271 characters cut by the per-chunk limit and
reported). The 35x argument only gets stronger; the number to budget against is
the larger one.

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

Both queries read an index the export writes. The export already sweeps every
retained string with the shipped matcher to produce `replacementCounts`; that
sweep records each occurrence as it goes, so the drill-down costs no extra pass
over the corpus and cannot disagree with the number that sent the reader to it.

```
$ deident review --entity PERSON_11

  PERSON_11   person   "Grace Hopper"
  4 occurrences, 3 sessions:

    2026-08-14  gitroll            a3f91c04-6b2e-4d7a-9f10-2c5581bb8f21
        turn    47   ...跟 Grace Hopper 約了 call...
        turn    51   ...Grace Hopper 說他下週...

  Read one of these sessions in full:   deident review --session <id above>
```

```
$ deident review --session a3f91c04-6b2e-4d7a-9f10-2c5581bb8f21
  full redacted transcript of one session, to stdout
```

Three properties, each load-bearing:

- **The excerpts are the text BEFORE substitution.** That is the only form that
  answers the question the reader actually has, which is whether a spelling
  replaced 991 times is a person's name or an ordinary word. It also makes this
  the one command whose whole job is re-identification, so every answer ends
  with a paragraph saying the output is local and must not be sent.
- **The transcript is read back out of the archive**, not re-rendered from the
  corpus. journey-and-pitfalls 2.1: three times on the delivery run a reviewer
  was handed something that was not what shipped, and each time the gap was
  where the leak lived.
- **Neither query reads the corpus, and neither can answer before an export.**
  These counts are what the substituter DID; a read-only pass over the corpus
  would produce a different number under the same name. With no index on the
  machine both refuse and name `deident export`, because "0 occurrences" here
  reads as "this entity is clean".

The index lives at `~/.deident-private/occurrences.json`, beside the salt and
the dictionary. It pairs pseudonyms with real spellings AND with real session
ids, which is strictly more than either `entities.json` or `export-map.txt`
holds on its own, so it gets the same handling as both: never an archive entry,
never the output directory, never the repository.

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
    14 occurrences of your own username or git identity are joined to
      letters or digits (yourname-prod) and were left alone by the same rule

  → deident-export-2026-08-22.zip    14.2 MB
    salt stays at ~/.deident-private/salt — do not share it, do not commit it
```

### 6b. Two findings that print beside the gate and are not gates

Both exist because a check that only reports what it was given cannot report
what it was not, and both were found by grepping a zip that had passed all six
checks.

**Parts of a declared spelling that still stand alone.** `Grace Hopper`
replaced and a bare `Morgan` left behind is a half replacement: the pseudonym
appears once and the prose names him two sentences later. The same shape
reaches every other kind through multi-word spellings. An office address
declared as one comma-separated string shipped its street on its own, because
only the whole string was ever a needle.

A single word is proposed only from a `person`, because a word taken out of a
person's name is still a name. From every other kind only a contiguous run of
two or more words is proposed, because a word taken out of anything else is a
noun. That is what admits a street such as `Bramble Road` (fabricated; the
real one was a line of a registered office address) while never proposing
`Road`, `Centre` or `Advisory`. Measured 2026-08-24 on the live entity list: proposing
single words from every kind produced 16 rows led by `and` at 337 occurrences,
followed by `Pro`, `Commercial`, `USD`, `Road`, `Industry` and `South`. Runs
added none of that, and found five real half-replacements the person rule
could not see.

A word starting with a lowercase Latin letter never joins a run. `Founders and
Ivy` proposed `and Ivy` at 7 occurrences, every one of them the declared name
`Ivy`: the longer run outranks the declared spelling in the probe table and
claims spans that are already covered.

**Seed spellings that are glued to alphanumerics.** The word-boundary rule is
correct and does not change (§4.5 row 4 makes `ray` inside `array` a required
non-match), but it means a seed joined to letters or digits can never match.
Measured 2026-08-24: the OS username survived in a shipped archive 14 times
inside cloud resource names, and the export printed `known-entity residue 0`.

```
  ! 14 occurrences of your own username or git identity are still in the
    output, joined to letters or digits (yourname-prod, kv-yourname01234).
    The substituter did not replace them and that is deliberate: the word
    boundary rule cannot tell them from your name inside an ordinary word.
        14  yourname                 PERSON_01
            …storageAccounts styourname3756557093578778…

    Decide per row. A resource name you can rename before exporting is one
    fix; declaring the glued spelling itself in the entity list is another.
```

Scoped so it does not cry wolf, and the scope is the whole design. Tier-0
`person` spellings only (the OS username, the git identity and the handles
derived from it), because those are the spellings a reader can act on. A
workspace path is already substituted as a path and matches its own longer
form; an org name glued to a digit is a repo or a bucket the org already puts
its name on; a tier-1 name belongs to a third party the reader cannot rename.
Measured over the same archive, four seeds together produced 25
boundary-refused occurrences and the scope reports 14 of them.

Five characters and up is a row whatever is beside it, measured rather than
guessed. Over 18.8 MB of exported bytes, ten plausible seeds at each length:
three characters gave a median of 643 boundary-refused occurrences and a worst
case of 1,996; four gave 13 and 270; five gave 0 and 14, and the 14 were the
leak. §7 and §F7 both say what happens to a check that fires constantly.

Below five, the row is earned on the NEIGHBOUR instead, because that average
was over two populations. Re-measured over ~20 MB of session logs, splitting
the refused occurrences by whether the character that blocks is a letter:
three characters gave a letter-blocked median of 412 and a worst case of 8,371
against a separator/digit median of 20 and worst of 52; four gave 46 and 113
against 4 and 26. The flood is the letter class entirely, and the small class
is where the leaks are (`project_<name>_notes.md`, `kv-<name>0123`,
`HKID_<Name>Yan.jpg`). A length gate here denied the disclosure to every user
with a three- or four-character given name, which is the common case for
Chinese, Korean and Japanese romanisations.

What the neighbour test still withholds is disclosed rather than dropped. The
spellings and their counts go in the manifest as `gluedNotListed` and one line
of the "NOT protected against" block names them, because
`renderGluedResidue` prints nothing when there are no rows and an absent list
beside a green residue figure reads as a clean result. Do not delete that line
as redundant with this paragraph: a limit stated in a doc is not a disclosure
at the moment of export.

Both print to stderr as findings, carry `uncoveredNameParts` and
`gluedResidue` in `--json`, and neither can fail an export. A gate on the
second would refuse every export forever over behaviour §4.5 demands. The
manifest carries the second as a count, `gluedOccurrences`, and prints it in
the "NOT protected against" block.

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

      passport-map      6 sessions
      demo-runner       2 sessions

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

### 11b. `~/.deident-private/entities.json`, the remembered dictionary

Stage 3 is the only stage whose cost grows with the corpus: 205 sessions and
915 KB of prose, measured 2026-08-24. A second run days later has a handful of
new sessions in it and must not cost the same as the first.

```json
{
  "_note": "deident remembers the identities you have already declared, and which sessions you have already read …",
  "version": 1,
  "updated": "2026-08-24T09:14:02.117Z",
  "entities": [
    { "kind": "person", "spellings": ["Grace Hopper", "Grace"], "confidence": "high" }
  ],
  "sessions": {
    "a3f9…": { "hash": "6b1c…", "read": "2026-08-24T09:14:02.117Z" }
  }
}
```

Plaintext, deliberately, and beside the salt. It is local-only on the owner's
own machine, and plaintext is what lets them open it and add an entry by hand.
**Hand-editing is a first-class use.** So the shape is stable, the file states
its own rules in `_note`, and a refusal names the line for a syntax error and
the entry index for a schema one.

`entities` is the same shape as `deident-entities.json`, so a row can be
copied either way. It holds the spellings **as typed**, never the escaping
variants deident expands them into: a hand-editor shown a backslash-doubled
twin of a string they never wrote cannot act on it.

`sessions` records what has been put in front of a reader. The hash is taken
over the session's **retained prose before tier-0 substitution**, because the
cleaned text carries pseudonyms and `--namespace` takes a fresh value every
run, so a hash of the cleaned text would report every session as changed every
time while looking like it worked.

Rules:

- **Merged by identity, never by position.** Two entries that share any
  spelling are one identity and their spellings union, transitively and
  case-insensitively. Two that share nothing stay separate. Merging any other
  way mints two pseudonyms for one person.
- **`--entities` is optional once this file exists.** Absent, the dictionary
  supplies the list. Present, the file wins on the identities it names and the
  dictionary supplies the rest. Dropping an identity on purpose is a hand edit
  of this file, not an omission from the flag's file: a reader answering a
  repeat run writes about the handful of sessions they were shown, and applying
  only that would drop every identity the earlier runs established with every
  gate green.
- **Missing is a first run. Unreadable or malformed refuses.** Continuing with
  no dictionary means an empty entity list and every session reported as never
  read, which looks like a corpus problem rather than a broken file.
- **It is memory, never output.** Not an archive entry, not in the output
  directory, not in the repository. It pairs real spellings with real session
  ids, so treat it the way you treat `review.md` and `export-map.txt`.

### 11c. The semantic-pass gate is per session

The gate used to be all-or-nothing: supplying `--entities` satisfied it for the
whole corpus, however much of that corpus anybody had read. A remembered
dictionary makes that insufficient, because a repeat run could satisfy it
having read nothing new.

**Every session in an export must have been through a semantic pass, in this
run or in a recorded earlier one.** A session that is new, or whose retained
prose changed since it was read, has not been, and the export refuses naming
it:

```
  ✗ Refusing to export: 3 sessions have not been through a semantic pass

      a3f9…   new since the last read
      7c02…   new since the last read
      1de4…   changed since it was last read   (written 2 minutes ago)

    A session is covered once its prose has been put in front of a reader and
    the answer is remembered. Exporting one that never was would mean claiming
    a semantic pass covered text nobody has seen.

    The other 202 sessions are covered and were left out of the file below.
    The tier-0-cleaned prose to read is at:  deident-candidates.txt
```

This is **stricter** than the old gate, including in a direction that has
nothing to do with the dictionary: `export --entities an-old-list.json` over a
corpus that has grown used to ship the new sessions on the strength of a list
written before they existed.

A session that is still being written cannot be covered, and the row says so
with `(written N minutes ago)`. The hash is over the whole retained prose, so
every turn added to a session somebody has open changes it back and the same
refusal returns. Reading it again is not the fix. Close that session, or leave
its workspace out at the review step, then export again. The refusal prints
that paragraph only when a row really is fresh, because a sentence about a
session you have open, printed when you have none, is §F7 in prose.

What it checks is that deident put the prose in front of a reader, not that the
reader read it. That is the same limit the old gate had, one session at a time
instead of one corpus at a time.

So the file is capped, at `--batch-chars` characters (120,000 by default,
roughly 30k tokens against a corpus measured at 915 KB and 250k). The cap is
not about the file being awkward to open. It is that "shown" is the only thing
this gate can observe, and a 915 KB file nobody could read in one pass turned
that into a false claim: every session in it was recorded as read and the next
export printed `205/205 sessions read ok`. Only the sessions actually written
into the batch are remembered, so the rest stay uncovered and the same refusal
offers them next run. At least one session always goes in, so a single
oversized session cannot stall the loop. The file and the terminal both say how
many were deferred and that they are not recorded as read.

`deident-candidates.txt` then carries only the uncovered sessions, and says so
in its own header, because the file is what a reader is handed and a short one
has to explain why it is short:

```
# 202 more sessions are not in this file. Their content has not changed
# since you last read them, and deident remembers what you declared then.
# To read the whole corpus again:  deident export --full
```

The check row carries the count:

```
    semantic pass   the dictionary at ~/.deident-private/entities.json · 47 entities · 205/205 sessions read   ok
```

A session is also re-offered when the run's own settings change what it
retains: a tier moved, or `--include-denied` added a directory back. The prose
a reader would see is not the prose they saw last time, so it is not covered.

### 11d. `--full`

Ignores the record and puts the whole corpus in front of a reader again, for a
person who has changed their mind about what counts as an identity. Without it
the only route back is deleting a file whose path they would have to be told.

It refuses the export and writes the full `deident-candidates.txt`, then the
next run supplies the list as usual. `--full` with `--entities` is a usage
error: one says "show me everything again" and the other says "here is my
answer", so a run carrying both would read the answer and then decline to use
it.
