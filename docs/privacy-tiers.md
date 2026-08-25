# Workspace privacy tiers

**Status: design for slice 2.** Slice 1 already ships the hook this plugs into
(per-directory opt-in, the deny-list, and per-line `cwd` filtering). Nothing here
changes slice 1's data path.

---

## 1. The axis is not ownership

The obvious model is "client work vs personal work". It is wrong, and it is wrong
in both directions on real data.

- `note-vault` is personal, and it is one of the better demonstrations of skill
  in the corpus. It should be exported.
- `private-archive` is personal, and it holds another person's messages. It must
  never leave the machine.

(Workspace names throughout this document are fabricated. What each one has to
carry is the shape the argument turns on: here, one personal directory that
should ship and one that must not.)

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
| the workspace directory name matches the deny-list (`private`, `identity`, `payroll`, plus any token the person adds in their own file beside the salt) | `exclude` |
| no git remote | `exclude` |
| git remote is a public repository | `open` |
| git remote org is not one the user belongs to | `redact` (third-party work) |
| git remote in the user's own org, private | `redact` |
| no `cwd` was ever recorded, so no signal could be read | `unclassified` |

**Unclassified fails closed**, and it is the residue rather than the default. A
default of unclassified is not a conservative choice, it is 29 questions, and a
person facing 29 questions answers none of them. Every row that carries a
readable signal gets a proposal and the person corrects the ones that are wrong.

Three notes on what the table can and cannot do, measured while implementing it
(2026-08-22, the operator's corpus, 43 workspaces).

**`open` is never proposed.** Repository visibility is not on disk. A remote URL
says nothing about who may read it, and BRIEF §2 forbids the network call that
would answer it. `open` is the *weaker* tier (§5), so a wrong guess leaks. Every
remote is therefore proposed `redact`, and the row says so, which also removes
any need to work out whether the remote's org is one the user belongs to: both
of those rows were `redact` anyway.

**The deny-list is read from the workspace's own directory, not from every line
that passed through it.** Applying it to any per-line `cwd` was tried and
reverted: it excluded the home directory, `ops-handover` and
`home-budget` outright, and labelled the last of those `deny-list matched:
"private"`, which is not true of that workspace: its own name carries no deny
token, which is the whole reason the label was wrong. §4 below has three levels for
exactly this reason. The wandering line is caught by level 2, twice over: by its
own deny token, and because the directory it moved into is itself an excluded
workspace.

**"Not under the projects root" was dropped from the second row.** It changed
nothing: a directory with no remote proposes `exclude` whether or not it sits
under `~/projects`, so the clause only added a machine-specific concept.

The answers are stored at `~/.deident-private/workspaces.json` and reused, so the
review happens once rather than every export. A workspace whose signals change
(a remote added, visibility flipped) is re-proposed and reverts to unclassified,
which means excluded, until confirmed.

## 4. Workspace granularity alone is not enough

Measured on the largest real session file: 5,259 lines, **11 distinct `cwd`
values**, including `C:\Users\<you>\projects\ops-handover\private` for 1,257
of them, inside a session whose directory slug looked unremarkable. The agent
`cd`s mid-session, and the slug records only the launch directory.

So three levels of granularity are all required, and each catches what the level
above it misses:

1. **Workspace tier**, the coarse decision, made once, remembered. The
   workspace is the directory the sessions actually worked in, taken from their
   `cwd` records. It is not the storage slug: 214 of 224 real sessions were
   launched from the home directory and share one slug, so a slug-shaped
   workspace would have put 95% of the corpus behind a single decision.
2. **Per-line `cwd` filter**, catches private subdirectories reached mid-session.
   Already in slice 1.
3. **Per-session drop, after preview**, the escape hatch. The preview lists each
   session with a one-line redacted summary (its first user message, truncated),
   and anything that still looks wrong is dropped before the zip is written.

Level 3 is what makes the whole thing safe to use: no classification scheme will
be right the first time, so there has to be a last look.

**Level 3 only works if the reader can see the session.** Measured 2026-08-25
over the live corpus at depth 1: of 214 sessions, 45 (21.0%) opened with
something that told a reader nothing. 28 carried no user prompt at all and 17
opened with a bare slash command, `/clear` eleven times. Triage showed the
command envelope, the reader had nothing to judge, and the session went through.
One of the two sessions that leaked 21 identity fields was one of those.

The last look now shows the first prompt that says something, and says on the row
when that was not the first. It reads no further into any file to do it: 15 of
the 17 are answered by the very next prompt in the head that was already read.
The remaining 30 sessions that still have nothing to judge say so explicitly,
because the triage rubric already answers a row nobody can classify and its
answer is `drop`. `docs/cli-ux.md` §4b has the distribution.

### 4b. Granularity is about what is EXCLUDED. It says nothing about what is FOUND

The three levels above all answer "does this material leave". None of them
answers "was everything that should have been substituted, substituted", and a
value in a session that is kept at `redact` is protected only if some source
named it.

There were two such sources and both were inference: tier 0 from machine state,
tier 1 from prose. A finished archive whose six checks were all green shipped 21
identity fields in plaintext, in sessions that were correctly tiered and
correctly kept. Nothing about the tiers was wrong. The values were simply never
named.

`~/.deident-private/known-values.json` is the third source and the only one that
is not a guess: a list of literal strings the person declares are theirs, read at
tier 0 and seeded as entities. It is orthogonal to the tiers, which is why it is
here rather than in the list above: it does not change what leaves, it changes
what is replaced in what leaves. `docs/cli-ux.md` §12 has the file shape, the
refusal behaviour and the reason no path to anybody's personal-details file is
hardcoded.

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
