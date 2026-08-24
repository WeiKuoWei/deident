---
name: deident
description: De-identify the user's own Claude Code session logs and pack them into an archive they can hand to someone else. Reads Claude Code's own log layout only; Codex and Cursor logs are not read yet. Use when the user asks to export, share, hand over, submit or donate their session logs or transcripts, when a colleague has asked them for their logs for a benchmark or an evaluation, or when they say 導出 session log, 匯出對話紀錄, deident, or paste a request for their coding history. Drives the whole flow: survey, decide what leaves, redact, export, verify. Not for exporting someone else's logs and not for ordinary file archiving.
---

# deident

Turn a machine full of AI coding-agent session logs into one archive that is
safe to hand to a named recipient, and prove it.

The tool does the mechanics and refuses when a check fails. You do the two
things it cannot: read prose for identities a machine cannot find, and put a
decision list in front of the person.

## Before anything

Everything below is one CLI. Find it once and reuse the path:

```
node <repo>/deident.js --version
```

`<repo>` is wherever this plugin's repository is checked out. If the command
prints a version, you are ready. If it says the Node version is too low, stop
and tell the person the version it named; nothing else will work.

Three rules that hold for the whole flow:

- **Never pass `--include-denied`, `--skip-unclassified` or `--skip-unknown-types`
  unless the person has just asked for that specific thing.** Each one turns off
  a refusal that exists because something went wrong once.
- **Never write into the repository.** Use `--out <somewhere else>`; the files
  this produces carry real paths and real names.
- **Add `--json` to every command.** You get the same values as structured data
  instead of aligned columns, including on a refusal, where the exit code is
  inside the document.

## 1. Survey

```
node <repo>/deident.js scan --out <workdir> --json
```

This writes `review.md` in `<workdir>` and changes nothing else. The JSON
carries `workspaces` (one row per directory the sessions ran in, with a proposed
tier) and `sessions` (one row per session, with a keep or drop decision).

Read the counts back to the person. A corpus of a few hundred sessions is
normal.

## 2. Decide what leaves

This is the step that matters and it is the one you must not do alone.

A workspace tier is `exclude` or `redact`. A session row is `keep`, `drop` or
`drop:audience`. The proposals are derived from signals the tool can read; the
person corrects them.

**Present a decision list, not the data.** One line per held-back session with
one line of reason. The person answers a list; they do not read transcripts.

**`drop` versus `drop:audience` is the important distinction.**

- `drop` means held whatever the recipient knows. Someone else's identity
  documents, health, private messages, live credentials. This is the floor and
  no setting releases it.
- `drop:audience` means held only because of who this is going for. Company
  business, a role that identifies a colleague, the owner's own arrangements
  that the employer already sees.

Mark them differently as you go. Getting this wrong in the safe direction costs
nothing; a row you cannot classify is a `drop`.

**Ask the person who the archive is for**, and pass it in step 5:
`teammate`, `company`, or `public`. Default is `public`, which releases nothing
extra. This one answer moves every `drop:audience` row at once, which is why it
is worth asking rather than adjudicating those rows one by one.

Write decisions back by editing `review.md` in place: column 1 of the
`## workspaces` and `## sessions` sections.

## 3. Triage: cut the list before anything expensive reads it

```
node <repo>/deident.js triage --out <workdir> --json
```

That writes `deident-triage.txt`: one block per session your review still
proposes to keep, carrying the session id, its date, the workspace, and the
first thing the person typed truncated to 300 characters. Nothing else, and only
the head of each session file is read.

Measured 2026-08-24 on a 205-session corpus: 23 KB, about 7k tokens, against
915 KB and about 250k tokens for step 4. That 35x is the whole reason this step
exists, and it is why it runs before step 4 rather than after.

Read it and write `deident-triage.json` beside it:

```json
{
  "verdicts": [
    { "id": "<session id>", "verdict": "drop", "reason": "one line" }
  ]
}
```

`verdict` is `drop` or `unsure`. **There is no `keep`.** A triage verdict may
only ever move a session toward `drop`: the tool refuses a `keep` naming the row
it came from, and a verdict cannot overturn a session that is already dropped.
Both are enforced in code. `unsure` means "I looked and I am not acting", and it
exists so a considered row does not look like a skipped one.

**A low-tier model is appropriate here, and this is the one step where that is
true.** `docs/model-tier.md` disqualifies the low tier for step 4 because its
failures are misses and a miss there is a disclosure. Here the only power on
offer is removal, so a wrong verdict costs coverage and never privacy. Use the
rubric in the file's own header rather than a stricter one of your own.

Then apply them:

```
node <repo>/deident.js triage --apply --verdicts <workdir>/deident-triage.json \
  --out <workdir> --json
```

That writes `drop` into column 1 of `review.md`, puts the reason on the row, and
remembers the drop beside the tiers so a later scan elsewhere does not lose it. A
verdict naming a session that is no longer in the corpus warns and is skipped;
sessions get deleted between runs.

`deident-triage.txt` carries raw prose. Unlike `deident-candidates.txt`, tier-0
substitution has NOT run over it, so handing it to a model sends untouched
session text to that model. That is a real cost, and it is why the payload is one
truncated line per session rather than a transcript. Never commit it, and never
paste it into a ticket.

## 4. Find the identities a machine cannot

The export refuses without this. Run:

```
node <repo>/deident.js export --out <workdir> --preview --json
```

That writes `deident-candidates.txt`: the session prose after the tool has
already replaced usernames, paths, git identity, git remotes, emails and MCP
server names. What remains is what needs a reader.

It is a PROSE extract, and the export substitutes over everything it keeps, so
the file shows you less than what ships. Measured 2026-08-24: a name-part check
over the candidates file found 8 uncovered surnames and the same check over the
export found 17. Step 6 is where that gap closes, so do not treat this file as
the whole surface.

Every UUID in it is already a pseudonym: session and message ids were replaced
before it was written. Do not declare one. Doing so made the export refuse
against deident's own output.

**Read it yourself. Do not hand this step to a cheap subagent.** Measured across
three model tiers on one corpus (`docs/model-tier.md`): the low tier found 0 and
1 of the seven values that were themselves the secret, while filing `Delaware`,
`Baltimore` and `SFO` as identities and marking almost nothing low-confidence. It
returns a full-looking list of 27 entities either way, which is why the failure
does not announce itself.

Read it and write `deident-entities.json` beside it:

```json
{
  "generated": "<ISO timestamp>",
  "entities": [
    { "kind": "person", "spellings": ["Ada Lovelace", "AdaLovelace", "Ada"], "confidence": "high" },
    { "kind": "org",    "spellings": ["Acme Advisory"],                      "confidence": "low" }
  ]
}
```

`kind` is one of the kinds listed in the candidates file's own header. Read it
there rather than from this document: the header interpolates the live list, and
a copy in prose drifts.

What goes in the list:

- Every named human: colleagues, clients, accountants, candidates, family.
  Third parties never consented, so include them; do not ask which to skip.
- External organisations, banks and services tied to an account.
- Real host names.
- Every spelling you actually see for one identity, in ONE entity's
  `spellings` array: full name, given name, surname, the run-together forms that
  appear in handles and filenames, other scripts, and dictation errors. One
  identity per entry, or one person gets two pseudonyms and the prose stops
  making sense.

What stays out:

- The user's own employer and its product vocabulary, when the recipient works
  there too. Substituting words the reader already knows wrecks the prose and
  hides nothing.
- Generic technology and platforms mentioned as technology.
- Ordinary words. **This is the one that has actually gone wrong**: a common
  noun was declared once and replaced 202 times across a corpus that had already
  been delivered, with every gate green, because a reversible wrong replacement
  is still reversible. If a spelling is a word someone might write by accident,
  leave it out or mark it `"confidence": "low"`.
- Values, unless the value itself is the secret. A figure, a balance or an
  account number belongs here as `kind: "secret"`; a sentence does not.

Set `"confidence": "low"` whenever you are guessing. Low-confidence entries are
listed individually for the person rather than collapsed into a count.

## 5. Export

```
node <repo>/deident.js export --out <workdir> --json \
  --entities <workdir>/deident-entities.json \
  --audience <teammate|company|public> \
  --namespace <two letters nobody has used yet>
```

**Run this detached and poll.** On a corpus of a few hundred sessions it takes
more than ten minutes, which is longer than most command timeouts. Launch it in
the background rather than waiting on it.

`--namespace` needs a fresh value each run. The tool prints its namespace, the
terminal is logged into the session, and the session is part of the next run's
corpus, so a namespace used before will collide and refuse.

## 6. Read the report before saying it worked

The JSON document carries `checks`. Every one must be `ok`. Two of them are
worth naming to the person:

- `known-entity residue` — zero occurrences of everything the table knew.
- `archive on disk` — the same scan, over the file that was actually written.
  This is the only check whose subject is the artifact the recipient opens.

Also carry back:

- `manifest.audience`, `manifest.heldByFloor`, `manifest.heldByAudience`. The
  second number is the only one that moves if the person changes their mind
  about the recipient.
- `replacementCounts.hits` — how many times each spelling was replaced, highest
  first. **Read the top rows.** A common word near the top is a false positive
  that every gate will pass. A workspace path or the user's own name at the top
  is expected.
- `replacementCounts.zeros` — spellings that matched nothing, so they protected
  nothing. Usually a typo in the entity list.
- `uncoveredNameParts`: pieces of a spelling you declared that still stand
  alone in the text. `Grace Hopper` replaced and a bare `Morgan` left behind is
  a half replacement, and no check catches it: the residue scan only looks for
  what it was given. The same shape reaches every other kind through multi-word
  spellings. An office address declared as one comma-separated string shipped
  its street on its own, because only the whole string was ever a needle. A
  single word is proposed only from a `person`; from any other kind only a
  contiguous run of two or more words is, which is what admits the street out
  of an address without ever proposing `Road`. Add the ones that really are that entity and re-run.
  Leave out any that are ordinary words.

If the export refuses, the JSON has `ok: false` and an `error` with `reason`,
`why` and runnable `remedies`. Act on the remedy; do not retry the same command.

## 7. Hand it over

The archive is a file. The tool does not upload it and has no receiver.

Tell the person: the file, its size, the session count, the declared audience,
and what was held back. Then let them send it. A privacy decision is theirs to
execute, not yours.

`export-map.txt` is written beside the archive and maps each original session id
to its entry inside. It is local, it is not in the archive, and it must not be
sent: it is the only thing on the machine that says which entry is which
session.

## Things that are not bugs

- **It refuses a lot.** Every refusal names a remedy. That is the design: a
  check nobody can bypass is worth more than a check that degrades quietly.
- **The archive contains no code**, only line counts. Tool output is truncated.
  That is deliberate; the export exists to show how a person works, not to ship
  their repository.
- **Sessions written since the last `scan` are held back**, counted as
  `never reviewed`. Re-run `scan` to decide them. Opt-in has to mean opt-in.

## What it does not protect against

Say this plainly when handing over, because the tool prints it and a person
reading a summary will not see it:

- Names the reader did not find. The residue scan can only look for what it was
  given.
- Facts that are not names: a shareholding, a rate, a balance.
- Re-identification by role. Substitution replaces the name; "the person who
  runs finance and payroll" still resolves to one human at a small company.
- Device fingerprint: model mix, CLI version sequence, local ports.
