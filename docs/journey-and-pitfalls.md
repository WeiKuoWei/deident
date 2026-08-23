# What the first real export cost, and what the person actually did

One machine, 225 sessions, 2026-08-22. Written for the session that is building
the same thing, so it can skip the parts that were expensive to learn.

---

## 1. The funnel, in order

Every number is a session count from a real run.

| Step | Sessions | What changed |
|---|---|---|
| On disk (depth 0) | 225 | |
| Bucketed by topic from prompts | 81 | first classification pass |
| Reviewed against extracted prose | 37 | 39 dropped on content |
| Full-text read of the archive | 35 | 2 more dropped |
| Grep of the shipped bytes | **17** | memory dumps and dictation corpora found |
| Block-level denial added | 40 | the same sessions, minus the injected blocks |
| Value-level redaction added | 48 | amounts and ids removed instead of sessions |
| Audience declared, owner ruled on the rest | **76** | |

The shape is the finding: **it went down to 17 because the tool could only remove
whole sessions, and back to 76 once it could remove parts of one.** Nothing about
the corpus changed between those two numbers.

## 2. The pits, most expensive first

### 2.1 Judging a proxy instead of the artifact

Three separate times, reviewers were given something that was *not* what ships:

1. The first 45 user prompts, truncated to 400 characters, no assistant text.
   Long sessions drift; a session that opens on a build task turns to a personal
   matter two thirds down. Missed.
2. A prose extractor reading `message.content` only. Retention also keeps
   attachment snippets, tool results and conversation summaries. Missed.
3. Only then: grep over the actual zip. Found the owner's own financial
   details quoted verbatim, in a session two rounds of review had cleared.

**Rule: the review reads the bytes that leave.** Anything else is a model of the
artifact, and the gap between the model and the artifact is exactly where the
leak lives. This is worth building into the tool as a hard constraint, not a
habit: the review step should physically read the output file.

### 2.2 The leak channel was the harness, not the person

The private material was not in what the user typed. It arrived as:

- `MEMORY.md` and the memory index, spliced in as an `edited_text_file`
  attachment. Every line of that index is a one-line summary of something the
  owner asked the agent to remember, which is the worst possible thing to ship
  by accident: it is an index of his own sensitive topics, written by him.
- A dictation hint list and a speech corpus, arriving as tool results. Its test
  data is real recorded speech, so the corpus replays whatever was actually
  said, verbatim.
- Google Calendar API dumps with attendee addresses.

None of it was authored in the session it appeared in. All of it was in sessions
that were otherwise clean engineering.

**Rule: strip harness-injected spans and denied files at block level before
anything else.** In this run that alone was worth 17 sessions to 40.

### 2.3 A review you cannot act on is not a review

Every uuid in the archive is rewritten. A reviewer could say "this entry leaks"
and there was no way to map the entry back to a session to hold it back. Fixed
by writing a local `export-map.txt` (`<session id>  <archive entry>`), never
shipped.

**Rule: attribution from the artifact back to the source is part of the artifact.**

### 2.4 Workspace granularity is wrong for anyone who works from home

214 of 225 sessions were launched from the home directory and share one storage
slug. A per-workspace decision put 95% of the corpus behind a single yes/no, and
that directory contains both the company work and everything personal.

Fixed with a per-session section in `review.md` that round-trips. The design doc
had already predicted this ("privacy-tiers §4 level 3"); it just was not built.

### 2.5 Literal substitution does not see encoded forms

A Google Calendar `eid=` is base64 of `<event id> <owner email>`. The email was
replaced everywhere it appeared as text and survived intact inside the base64.

Percent-encoding and JSON escapes were already handled. Base64 was not. There is
no general fix; there is a list, and the list needs the encodings the corpus
actually contains.

### 2.6 A credential with no vendor prefix defeats a vendor-prefix sweep

AWS SigV4 presigned URLs carry `X-Amz-Security-Token=<live session token>`. It
matches no vendor prefix (the prefix is on the key id, not the token), it is not
a JWT, and no `Bearer` precedes it. All three existing sweeps walked past it and
the manifest printed `0 secrets` while a live token sat in the output.

The reviewer could only say "truncated in the quotes, so exact removal cannot be
guaranteed", and that uncertainty cost the whole session. **A gap in the sweep
shows up as a dropped session, not as a leak, so it looks like caution.**

### 2.7 A redaction string containing an already-replaced name can never match

The single most confusing failure. Extracted string:

```
Situation: Acme Inc (my sponsor) has its account frozen.
```

Tier 0 replaces `Acme` first. By the time the tier-1 pass runs, that sentence
does not exist in the text any more, so the replacement never fires and the
residual scan correctly reports 1,096 survivals and refuses to export.

Fix: split every known entity name out of the redaction strings and keep the
fragments. **Any string a human or an agent hands to the substitution table has
to be expressed in post-substitution terms.** The tool should do this splitting
itself rather than making the caller know about tiers.

### 2.8 The namespace burns itself

Each export prints its pseudonym namespace into the terminal, which is logged
into the session, which is part of the corpus for the next export, which then
refuses because the namespace is already present. Eight exports, eight
namespaces. Trivially fixable (exclude the current session, or do not echo it),
but it will hit anyone who exports twice.

### 2.9 Verdicts diverge when the build changes underneath

Seventeen sessions ended up with two opposite verdicts, because the reviewer that
refused them ran before block-level denial existed. Resolving that needed a
dedicated round where each reader was handed **the earlier accusation** and asked
one question: is this specific thing still in the text?

**Rule: a verdict is only valid against a build. Record which one.**

### 2.10 The reviewer's standard is not the owner's standard

36 sessions were held. Asked one at a time, the owner released almost all of
them, and named the reason: the recipient is a colleague who already knows the
company's business and who does what.

That is not carelessness and it is not a bug in the reviewer. It is a fact the
reviewer did not have. See `audience-and-floor.md`; the short version is that the
knob is a declared recipient, over a floor that the knob cannot reach.

Twenty of the 28 remaining holds moved on that setting alone.

### 2.11 Two operational hazards worth designing around

- **A second agent editing the same repository.** `HEAD` moved three times
  during the run and local changes were swept into another session's commits.
- **Sibling agents sharing a scratchpad.** One extraction agent reported its
  `dump.txt` was overwritten by another agent's data and produced false hits
  before it switched to a unique filename. Any fan-out that writes files needs
  per-agent paths.

## 3. What the person actually did

Total human input across the whole run, in order:

1. One sentence of intent.
2. One multiple-choice answer about scope, and one about how to treat
   work-sensitive material.
3. *(long machine phase)*
4. Read a decision list. Not data: 36 rows, one line of reason each.
5. Answered four of those rows one at a time.
6. Said "my standard is looser than yours, there should be a knob".
7. Answered four more rows, now pre-calibrated.
8. Read the verification report.

**Eight interactions. Perhaps fifteen minutes of attention.** Everything else was
machine time: roughly a dozen agent fan-outs, four full re-exports, and several
million tokens of reading.

The distribution matters more than the total. Steps 4 to 7 are where every
decision was made, and step 6 retroactively changed twenty of them. A knob turned
once was worth more than twenty individual answers.

## 4. The four interaction modes, which are not the same problem

The run contained four distinct kinds of exchange. Any interface decision has to
serve all four, and they pull in different directions.

| Mode | What it needs | Chat | Table UI |
|---|---|---|---|
| **Decide a list** (36 rows, keep or drop) | Density, keyboard, see the whole list at once | Poor: nine round trips, no overview | Good |
| **Calibrate** (one setting, re-decides many rows) | A form, and an immediate preview of what moved | Poor | Good |
| **Adjudicate a hard case** | The quoted evidence in front of you, and room to argue | Good | Cramped |
| **Explain a refusal** ("1,096 survivals, here is why") | Prose, causal reasoning, a fix | Good | Poor |

Asking 36 questions four at a time through a conversational prompt worked, and it
was clearly the wrong shape by question five. Explaining why the residue check
refused would have been terrible as a modal.

## 5. Skill, GUI, or neither

The framing "skill or GUI" assumes the interface is the product. On this run it
was not. **The agent did the reading; the person did the deciding; the interface
was only ever in the way of the second one.**

Three observations that decide it:

**The expensive part cannot be a GUI.** Twelve agent fan-outs read 2.2 MB of
transcripts and produced 121 exact redaction strings. No interface does that. So
the question is not "skill or GUI", it is "what renders the decision list".

**The decision list already has a home.** `review.md` is the report and the
config, and it was designed that way for good reasons: greppable, diffable,
reviewable by a second person, survives the session. That property is worth more
than any widget, and a separate app that owns its own state destroys it.

**So the GUI, if it exists, is a renderer over that file.** `deident review
--html` already writes a read-only page. The smallest useful step is to let that
page write decisions back to `review.md` rather than being read-only, and to add
the audience selector to it. Nothing else moves.

Concretely:

- **Skill** owns everything up to the list: scan, classify, extract, redact,
  export, verify, explain refusals. This is where all the value is and it is
  conversational by nature.
- **A local page** owns the list itself: 36 rows, keyboard-navigable, one line of
  reason each, the audience selector at the top, and a live count of what the
  setting moves. It reads and writes `review.md` and starts no server.
- **Chat** keeps the two things it is genuinely better at: arguing a hard case
  with the evidence quoted, and explaining why something was refused.

The thing to build first is not either interface. It is the **decision list
itself**: one row per held-back session, one line of reason, grouped by theme,
with the audience setting at the top. That artifact is what made fifteen minutes
enough. It works pasted into a terminal, rendered in a browser, or read on a
phone, and choosing between those is a much smaller decision than it looks.
