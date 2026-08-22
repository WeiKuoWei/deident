# Workspace privacy tiers

**Status: design for slice 2.** Slice 1 already ships the hook this plugs into
(per-directory opt-in, the deny-list, and per-line `cwd` filtering). Nothing here
changes slice 1's data path.

---

## 1. The axis is not ownership

The obvious model is "client work vs personal work". It is wrong, and it is wrong
in both directions on real data.

- `moss-local` is personal, and it is one of the better demonstrations of skill
  in the corpus. It should be exported.
- `private-archive` is personal, and it is a couples-counselling chat archive. It must
  never leave the machine.

Same category, opposite treatment. The same failure runs the other way: work on
our own product is not the same exposure as work on a client's data.

Two independent questions are being conflated:

**A. Who is harmed if this leaks?** Nobody / me / a third party who never
consented / my employer.

**B. Does it demonstrate skill?** Yes, this is exactly what I want counted /
neutral / not work at all.

What a person is willing to upload is high-B and low-A. Everything else is a
different decision. Most of a real corpus is low-B, which is why the default has
to be exclude rather than include.

## 2. Four tiers, one per workspace

| Tier | What leaves | For |
|---|---|---|
| `exclude` | nothing at all | personal life, health, finances, another person's data, anything under a deny-listed path |
| `count-only` | session count, work mode, outcome, timestamps. **No text, no tool calls, no paths.** | work that should be counted but whose content is not shareable |
| `redact` | full de-identified content. The default for work. | ordinary work in our own or a client's repo |
| `open` | content with secrets stripped, entities left alone | already-public repos, open source |

### Why `count-only` exists

It is not a nicety, it is the fairness fix.

If a privacy-conservative person simply excludes half their corpus, their session
counts drop, and session count is load-bearing downstream: domain confidence
shrinks a thin record toward the prior (`PRIOR_WEIGHT = 6`), and under 8 sessions
a domain gets no level at all. **A person who protects more of their life scores
as less experienced.** That is the same shape of bug as the null-axis OVR
inflation recorded in BRIEF.md §6, and it is introduced by us rather than
inherited.

`count-only` keeps the denominators honest while exposing nothing.

## 3. Classification is proposed, not asked

Nobody is going to answer 31 questions. The tool derives a proposal from signals
it can read, and the person corrects the rows that are wrong.

| Signal | Proposed tier |
|---|---|
| directory name or any per-line `cwd` matches the deny-list (`private`, `identity`, `payroll`, `redacted-name`, `health`, `medical`, `tax`, `finance-personal`) | `exclude` |
| no git remote, and not under the projects root | `exclude` |
| git remote is a public repository | `open` |
| git remote org is not one the user belongs to | `redact` (third-party work) |
| git remote in the user's own org, private | `redact` |
| anything else, including every newly seen workspace | **`exclude`** |

The last row is the important one. **Unclassified fails closed.** A new repo
appearing between exports is never swept in by default.

The answers are stored at `~/.deident-private/workspaces.json` and reused, so the
review happens once rather than every export. A workspace whose signals change
(a remote added, visibility flipped) is re-proposed and reverts to unclassified,
which means excluded, until confirmed.

## 4. Workspace granularity alone is not enough

Measured on the largest real session file: 5,259 lines, **11 distinct `cwd`
values**, including `C:\Users\devuser\projects\ops-handover\private` for 1,257
of them, inside a session whose directory slug looked unremarkable. The agent
`cd`s mid-session, and the slug records only the launch directory.

So three levels of granularity are all required, and each catches what the level
above it misses:

1. **Workspace tier** — the coarse decision, made once, remembered.
2. **Per-line `cwd` filter** — catches private subdirectories reached mid-session.
   Already in slice 1.
3. **Per-session drop, after preview** — the escape hatch. The preview lists each
   session with a one-line redacted summary (its first user message, truncated),
   and anything that still looks wrong is dropped before the zip is written.

Level 3 is what makes the whole thing safe to use: no classification scheme will
be right the first time, so there has to be a last look.

## 5. There is no strength dial, only an inclusion decision

Worth stating because it is a natural thing to assume: "client work needs
stronger de-identification" does not map onto anything the tool can do.

Redaction is already at full strength for everything in `redact`. Code content is
never exported at all, only its line count; every seeded entity is replaced; the
residual scan aborts the export on any known-entity residue. There is no stronger
setting to turn on.

The dial that exists only runs the other way: `open` is *weaker*, for work that is
already public.

So the question is never "how hard should this be scrubbed". It is "does this
leave at all, and at what granularity". Framing it as inclusion rather than
strength is what makes the tiers simple.

## 6. Differing tolerance is a comparability problem, not just a preference

Each person's `workspaces.json` is theirs, so tolerance is respected by
construction. But the corpora are then not comparable, and whoever consumes them
needs to know that.

Two things follow:

- Prefer `count-only` over `exclude` wherever the person is willing, so the
  denominators survive.
- The export manifest must state, per uploader, how many sessions fell into each
  tier. A recipient comparing two people needs to see that one of them withheld
  40% of their corpus. Hiding that turns a privacy choice into a silent skill
  gap.
