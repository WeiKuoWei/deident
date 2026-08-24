# What ships now, and what waits

Two consumers, and only the first one is real today.

**Now.** The 2026-08-19 Mid Sync-up action item: the team exports recent session
logs, filters anything private, and hands the result to Nora Lund to re-run the
team's AI fluency scoring. Seven people, internal, once. There is no receiving
endpoint and no platform pipeline to attach to yet.

**Later.** Ticket 110 and 114: replace EntireIO with an upload tool that carries
a redaction mechanism, for Fellowship apprentices from September and eventually
for enterprise users. 110 blocks 114.

The rule used to split them: **anything whose absence makes the first run unsafe
or impossible ships now; anything whose consumer does not exist yet waits.** A
third category is called out separately below, because it is neither.

---

## Ships now

| Piece | Why it cannot wait |
|---|---|
| Corpus root resolution, depth-0 enumeration | Nothing works without it. |
| Per-line `cwd` resolution, including `relocated` / `worktree-state` | The slug records only the launch directory. Without this the filter evaluates the wrong directory, and a session that walked into `\private` exports it. |
| Workspace tiers from readable signals, deny-list, per-line `cwd` gate | The safety mechanism. Without proposals the user faces 29 questions and answers none. |
| Longest-match single-pass substitution, lookaround boundaries, escaping variants | The product. |
| Salted pseudonyms, no plaintext map, `--namespace` | Not optional: 23 lines in the live corpus already match `PERSON_n`, put there by the sessions that built this tool. An abort-only implementation cannot export the corpus of the people building it. |
| `structuredPatch` distilled to a true added-line count | A wrong `0` manufactures an "abandoned" session downstream and no existing test catches it. |
| Retention table over all 19 record types, unknown type refuses | A silent drop loses user turns that are scored. |
| Four verification gates, abort before any write | The trust story is these plus the residual scan, and nothing else. |
| Residual scan labelled `known-entity residue` | The label is the security control. A bare "safe" claims more than the mechanism delivers. |
| `review.md` as report and config | The audit record. Someone other than the uploader has to be able to read what was decided. |
| Candidate confirmation for low-confidence names | Replaces the mandatory-LLM constraint. Nobody gets stuck without an agent, and every candidate is seen by a person or a model. |
| Deterministic zip, `.part` then rename | A half-written export is worse than none. |
| `--selftest` with a fixture per fixed bug | The regression floor. |
| Ledger **recording** of what was exported | Record now or the first incremental run is impossible. Reading it is next, writing it is today. |

## Waits, with the trigger that starts it

| Piece | Trigger |
|---|---|
| Browser review GUI | The first uploader who is not on the team. |
| `deident push`, auth, resumable chunked upload | A receiving endpoint exists. Blocked on Nora's pipeline shape, not on us. |
| The receiving endpoint itself | The platform decides what it wants to ingest. |
| `count-only` and `open` tiers | Someone declines to share content but wants to be counted. Slice 1 runs on `exclude` and `redact` alone. |
| Incremental **logic** (new / changed / already sent) | The second export. Cheap once the ledger has entries. |
| Semantic session grouping | The user asks for it, or Nora reports the granularity is actually broken with an example. Until then `unresolved` is the honest value. |
| Any non-Claude-Code adapter | Somebody on the team produces a real log in that format to test against. Vendor docs alone are not enough to write a parser. |
| The subagent and workflow tree | Nora asks for orchestration evidence and says the parent session's `Agent` / `Workflow` records are insufficient. It is 931 MB of machine-to-machine traffic with no human turns. |

## Neither: things that are not ours to fix

Recorded so they are not silently inherited.

- **The OVR null-axis inflation.** `verdict.ts` averages over axes that have a
  reading and skips nulls, so on the shipped demo record a prose-only user scores
  68 against an equally skilled harness user's 63, and a Mid-level user at 58
  becomes Senior at 64 if trouble detection is suppressed. Not caused here, but
  this tool is the first thing that will feed it a large prose-only corpus.
- **The `ai-log-expertise` and `ai-log-csv-quality` prompts.** Four of six axes
  and both hero tiles depend on rules that exist in neither repo. Until they are
  in hand, every truncation threshold stays a named constant in one file and the
  posture is: preserve evidence over shrinking bytes.
- **Comparability across uploaders.** Different people withhold different
  amounts. The manifest states per-uploader tier counts so a recipient can see
  it; deciding what to do about it is the platform's call.

---

## Settled

**Delivery is a file, not an upload.** Seven manual transfers once cost less than
an endpoint nobody owns, and the endpoint's shape depends on a pipeline that is
not designed yet. `push` and the receiver stay on the roadmap.

**The review page uses the machine's own fonts.** The audit rounds removed the
web font to make the self-contained claim unarguable. Embedding a face as a data
URI would restore the intended typography at a few hundred KB and was declined.

**The individual decides, always. There is no organisation policy file.**
A Fellowship participant sets their own tiers exactly as a teammate does; a
programme cannot pre-decide for them, and nor can an employer. This is the
"privacy by design" claim taken literally rather than as a slogan, and it removes
a roadmap item rather than adding one.

Two consequences follow, and neither is optional:

- **Comparability across uploaders can never be fixed by policy.** If everyone
  chooses for themselves, corpora differ in ways no rule can normalise. The
  manifest's per-uploader tier counts therefore stop being a nicety and become
  the only thing standing between a privacy choice and a recipient reading it as
  a skill gap. Ship them, and make them legible.
- **`count-only` gets more important, not less.** It is the one tier that lets
  someone withhold content without shrinking their own denominators. Under a
  policy regime it was a convenience; under free choice it is the main defence
  against the conservative person scoring worse for being conservative.
