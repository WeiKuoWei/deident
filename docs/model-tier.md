# Which model can do the entity step

Step 4 of the skill, the entity pass, is the one thing the tool cannot do: read
the tier-0-cleaned prose and name the identities a machine cannot find. It is
also the only step whose cost scales with the corpus. So: does it need the top
tier?

Measured 2026-08-24. One corpus, one prompt, three tiers, two runs each.

## Setup

14 sessions (7 MB) copied to a throwaway root, scanned, every workspace set to
`redact`, `export --preview` run. That produced a 46 KB `deident-candidates.txt`.
Six agents each got the step-4 prompt from `skills/deident/SKILL.md` **verbatim**
and returned `deident-entities.json`. No agent saw another's answer.

Scoring is deliberately not taste. Two things are counted:

- **High-harm recall.** Seven items in the corpus that are the value itself: a
  live phone number, a Google Meet join code, two Notion page ids, a receipt
  number, an invoice number, a private host name. These are the ones where a
  miss is a disclosure rather than an untidy transcript.
- **Ordinary words declared as identities**, scored with the shipped probe
  (`src/entities/probe.mjs`) over the raw corpus, so the number is what would
  actually be replaced.

## Result

| | haiku-1 | haiku-2 | sonnet-1 | sonnet-2 | opus-1 | opus-2 |
|---|---|---|---|---|---|---|
| entities | 27 | 27 | 29 | 30 | 35 | 30 |
| high-harm recall | **0/7** | **1/7** | 4/7 | 7/7 | 7/7 | 7/7 |
| recall vs union | 42% | 45% | 53% | 48% | 73% | 65% |
| entries marked low | 0 | 2 | 6 | 11 | 10 | 9 |
| entries with a note | 0/27 | 1/27 | 28/29 | 25/30 | 32/35 | 30/30 |
| run-to-run agreement | 61% | | 77% | | 71% | |

## What the numbers say

**The low tier fails on exactly the class of item that matters.** haiku found
zero and one of the seven values-that-are-the-secret. It was not idle: it
returned 27 entities both times. It spent them on company names it could see
repeated - Vapi, Retell, Anthropic, Pine AI - and never noticed that a
ten-digit number in a Slack quote was a phone number. That is a recall failure
that reads like a full answer, which is the worst shape a failure can have here:
the operator sees a populated list and ships.

**The low tier also produces the false positive this project already shipped
once.** Probe counts over the corpus for spellings only haiku declared:

```
Vapi 346   Retell 240   Anthropic 292   1Password 159
Eleven 138   SFO 107   Delaware 95   Bland 67   Baltimore 58
```

`Eleven`, `Bland`, `Baltimore`, `Delaware` and `SFO` are ordinary words and
place names; haiku-1 filed the last three under `kind: machine`. Declaring them
replaces a common word hundreds of times, and every gate stays green, because a
reversible wrong replacement is still reversible. This is the 202-occurrence
failure that motivated the probe, reproduced by changing nothing but the model.

**Confidence and notes are the mechanism the skill relies on, and the low tier
does not produce them.** Step 2 puts low-confidence entries in front of a person
individually. haiku marked 0 and 2 entries low out of 27, and wrote a note on 1
of 54 entries across both runs. It also emitted `"confidence": "medium"`, which
is not a value the format has (`tier1.mjs` degrades anything that is not `high`
to `low`, so it fails safe, but nothing in the answer was calibrated). Without
the low marks there is nothing for a person to review, and the operator is
adjudicating an undifferentiated list of 27.

**Between the two upper tiers the gap is real but not categorical.** sonnet
found 4/7 and 7/7; opus found 7/7 twice, with the highest recall of the union
and notes on nearly every entry explaining *why* a bare surname was left out.
sonnet's run-to-run agreement was actually the highest (77%), which says its
answer is stable, not that it is complete: the two sonnet runs disagreed about
three of the seven high-harm items.

Both upper tiers hit the same false positives - `Wise`, `Fearless`, `Treasury`,
`Foundry` - but marked them `low`, which is what the format is for. The
difference between "declared `Treasury` as high confidence" and "declared it low
with a note saying treasury is an ordinary word" is the whole review step.

## Recommendation

Step 4 runs at the mid tier or above, and only ever produces a proposal.

- **Do not run step 4 at the low tier.** Not as an optimisation, not on a small
  corpus. It misses the values that are the secret and files ordinary words as
  identities, in the same run, with no low-confidence marks to catch either.
- **Mid tier is sufficient when a person reads the low-confidence list**, which
  the skill requires anyway. Its misses were high-harm items, so a second
  independent run at the same tier is worth more than one run one tier up:
  sonnet-1 and sonnet-2 between them found 7/7.
- **Top tier buys recall and reasoning about it**, not a different kind of
  answer. Worth it on a corpus going outside the company; not required for a
  teammate hand-off that a person will still review.

Nothing here changes the floor. Every tier missed something, every tier declared
an ordinary word, and the export refuses without step 4 regardless of who ran
it. The probe exists because no model tier removes the need to read the counts.

## The one step where the low tier IS the right answer

Step 3, triage, inverts every sentence above, and it inverts them for exactly
one reason: its only power is removal.

The argument against the low tier here is that its failures are MISSES, and a
miss in the entity pass is a disclosure. A miss in triage is a session that
ships and gets read by step 4 anyway. So a wrong verdict costs coverage, never
privacy, and the failure direction is the whole basis for the choice.

That inversion is not a judgement call left to the operator. `deident triage`
refuses a `keep` verdict and ignores a verdict that would overturn an existing
`drop`, in code, because the moment a verdict can release a session the
asymmetry is gone and so is the case for a cheap reader.

The cost side is measured too: on a 205-session corpus the triage payload is
23 KB, about 7k tokens, against 915 KB and about 250k tokens for step 4. Paying
the top tier to decide which sessions are worth reading is spending the
expensive resource on the cheap question.

## Reproducing

`skills/deident/SKILL.md` step 4, unchanged, against a `deident-candidates.txt`.
Score with the probe: build a table from the union of all runs' spellings, run
`probeCounts` over the raw corpus, and read the top of the distribution.
