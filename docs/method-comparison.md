# The tool's method against the run's method

Written after the first real export, with the design session and every design
document read alongside what actually happened on 2026-08-22.

The question was "which method is better". They are not the same kind of thing,
and the run produced hard evidence about both.

---

## 1. Verdict

**The tool's method is the load-bearing half, and it is not the unreliable part.**

Its checks caught three of my mistakes and refused to write an archive each time.
Nothing in my method proves anything; it produces findings, and a finding is not a
guarantee until it becomes a rule the tool enforces.

**My method is the discovery layer the tool does not have, and on its own it is
dangerous.** I made the same class of error three times, and the only reason a
leak did not ship is that the tool refused to cooperate.

The two are not competing. Discovery generates rules; verification enforces them.
Everything I found on this run ended as a constant in this repository, which is
the correct end state and also the proof that the pipeline between them works.

## 2. What the tool proved, on real data

Five checks that abort, not warn:

| Check | Result on the real corpus |
|---|---|
| Per-line serialization invariant | 134,071 / 134,071 byte-identical |
| String-level substitution invariant | 49,063 replacements, all reversible |
| Pseudonym namespace collision | refused twice, correctly |
| Known-entity residue over serialized bytes | refused at 1,096 survivals |
| Semantic pass mandatory | refused when absent |

Six properties verified rather than asserted: no output survives a failed run
(tested with a forced write-time failure after serialization); idempotence on a
growing corpus (same sha256, twenty minutes apart, 84 lines added); the salt never
appears in any shipped byte; typed exit codes with every printed remedy actually
run; the review page fires no network request; 91 self-test fixtures, each pinned
to a defect found on real data.

**This is unusually good.** Most tools in this category assert their guarantees.
This one fails closed and has the transcripts to show it.

### It caught me three times

1. **Namespace collision.** The corpus already contained `PERSON_n` tokens,
   written there by the sessions that built the tool. The design session names
   this exact problem and calls it the one nobody would have predicted. It fired.
2. **1,096 known-entity survivals.** I had handed the substitution table strings
   containing an organisation name that tier 0 replaces first, so the tier-1
   sentences could never match. The residue scan caught a class of error I did not know existed.
3. **Refuse-on-empty.** Reachable the moment the cwd gate happens to drop
   everything, which my early tier edits nearly did.

Without check 2 I would have shipped an archive believing it was clean.

## 3. What the tool cannot do, in its author's own words

From `docs/ux-open-problems.md`, closing line:

> Scanning is not the expensive part. P1 is that scanning does not work.

And on the residue scan:

> structurally incapable of finding a third-party name it was never given

The measurement behind it: 230 distinct email addresses in a 90-file sample, 228
of them not the uploader's. Emails have a regex. Names do not.

The accepted, documented blind spot: 97.7% of the corpus is tool output, and the
design knowingly accepts it. Not because it is small.

**So the tool's weakness is not reliability. It is coverage of the unknown.** The
author already knew this and wrote it down. Losing confidence in the tool because
of it is drawing the wrong conclusion from a correct observation.

## 4. What the run found that the checks could not

Every one of these falls inside the class the author already named. The run's
contribution is that it produced the specific list rather than the category.

| Finding | Why no check could have fired |
|---|---|
| `MEMORY.md` arriving as an `edited_text_file` attachment | Retention deliberately keeps the attachment sub-types that carry user text. The record was doing exactly what it was designed to do. |
| Dictation corpora and a hint word list arriving as tool results | Head+tail truncation preserves both ends. Nothing was malformed. |
| `X-Amz-Security-Token` in a presigned URL | No vendor prefix, not a JWT, no `Bearer` before it. All three sweeps walked past it and the manifest printed `0 secrets`. |
| An email surviving inside a base64 calendar `eid` | Percent-encoding and JSON escapes were handled. Base64 was not on the list. |
| Re-identification by role | Substitution replaced the name and the residue scan correctly reported zero. "The person who runs finance, payroll and legal" resolves to one human anyway. |

The fifth one is the sharpest. **The scan was right and the archive still
identified someone.** No amount of tightening the scan reaches it, because it is
not a string.

## 5. What my method got wrong

Stated plainly, because it is the reason my method cannot stand alone.

**I judged a proxy instead of the artifact, three times.** First the leading 45
prompts truncated to 400 characters with no assistant text. Then a prose
extractor reading `message.content` only, which misses attachments, tool results
and summaries. Only the third attempt read the shipped bytes, and it immediately
found the owner's own financial details quoted verbatim inside a session that two
rounds of review had cleared.

**It is not reproducible.** Twelve agent fan-outs, 405 M tokens processed, 168
agents. Run it again and the verdicts differ. The tool's checks give the same
answer every time.

**Roughly 29% of that was rework** caused by the proxy mistake and by verdicts
made against a build that then changed underneath them.

**It produced no guarantee.** It produced 121 exact strings and three rules. The
strings and rules are only worth something because the tool enforces them and
proves the result.

## 6. Where both were wrong: the human loop

The tool's design settled on a contact sheet: every session rendered as the
recipient will see it, worst first, expandable. The author tested it against real
data and concluded:

> this design is not informing, it is manufacturing confidence. Reading 161 rows
> feels safe, and those 161 rows never had a chance to show the thing that would
> go wrong.

My version was worse in a different direction: 36 sessions, four questions at a
time, through a conversational prompt. It was clearly the wrong shape by question
five, and only nine rounds of it would have finished.

What actually worked was neither. It was **a decision list of 36 rows with one
line of reason each, plus one setting that re-decided twenty of them at once.**
Fifteen minutes of attention. Neither design predicted it, and it is now written
up in `audience-and-floor.md` and `journey-and-pitfalls.md`.

## 7. The four layers, which is the real answer

Neither method is four layers. Together they are, and each layer is doing work the
next one cannot.

1. **Narrow, mechanically.** Cheap patterns over the shipped bytes, to separate
   the sessions worth a reader from the ones that are not. Precision does not
   matter here; recall does. On this run it took 76 sessions down to the 55 worth
   reading, at roughly a 50% false-positive rate, and that was fine.
2. **Judge, with a model.** One reader per session, given the marker contexts, not
   the whole corpus. This is where "is this a real disclosure or the word
   `invoice` in a schema" gets answered, and it is the only layer that can answer
   it.
3. **Set the line, with the person.** Not per row. One declared audience, over a
   floor the setting cannot reach. This is the highest-leverage human input in the
   whole process and it took one sentence.
4. **Guarantee, mechanically.** Every string and every rule the layers above
   produced, enforced by substitution and proved by the residue scan, with the
   export refusing rather than degrading.

The tool owns 1 and 4 and is strong at both. It has no 2, and its 3 was the wrong
shape. My run was 2 and 3 and had no 1 or 4 worth the name, which is why it
produced a leak three times before the tool's layer 4 stopped it.

## 8. What to do about the confidence

The design session records twenty-five places where the author reversed himself:
the deliverable's shape three times, reversibility, the mapping table's threat
model, the headline round-trip check, Tier 1 from optional to mandatory, the
corpus measurements twice, the biggest slimming saving, two external facts stated
as fact and then withdrawn, and a workflow that reported `cleanRound: true` from an
agent that had crashed and returned an empty array.

That is not a record of unreliability. **That is what a design process looks like
when it is actually checking itself**, and the last item is the one to keep in
view: the failure mode here is not a wrong decision, it is a green light nobody
earned.

The thing worth distrusting is not the tool. It is any sentence that says the tool
is finished. Its own documents already say it is not, and they say exactly where.
