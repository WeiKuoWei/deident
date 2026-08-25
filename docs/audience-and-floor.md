# The tightness knob: a declared audience, over a floor

**Status: shipped, rewritten 2026-08-25 after the first version was measured.** The
first version put the audience on the session decision and it never fired once. §2
records the measurement; §3 onward describes what replaced it.

---

## 1. What the live run actually showed

Two people reviewed the same 36 held-back sessions. The tool's reviewer held all 36. The
owner, asked one at a time, released the first four categories it had refused and said so
plainly: *my standard is looser than yours, and every person's standard is different.*

He was not being careless. He was applying a fact the tool did not have: the recipient is
a colleague at his own company. "The person who runs finance is handing over" is a
disclosure to a stranger and a Tuesday to a teammate.

privacy-tiers §5 says the only question is "does this leave at all, and at what
granularity", and that there is no strength setting. That was right about *redaction
strength* and wrong about *the line*. Redaction strength genuinely has no dial. Where the
line between release and hold sits genuinely does, and refusing to expose it does not
remove it. It just means the tool picks a point on the axis silently and calls it the
only one.

## 2. The first version, and the measurement that killed it

The axis was built as a third session decision. `drop:audience` in `review.md` meant
"held only because of who this is going to", and declaring `teammate` or `company`
released those rows while plain `drop` held whatever the recipient knew.

Measured on the live corpus:

```
audience=teammate   heldByFloor=151   heldByAudience=0
occurrences of "drop:audience" in the produced review.md:  0
```

Zero, on both counts. Nothing in the tool writes the value: the scan proposes `keep` or
`drop`, and `triage --apply` only ever moves a row toward `drop`. So the setting asked
the operator to sort every held row into two buckets, and the sort changed nothing.

Worse than useless, it pointed the wrong way. `public` was defined as the setting under
which the most sessions are held. The expected user of this tool publishes publicly, so
the design handed its main case the worst archive, and privacy and usefulness were in
direct competition: the more careful the recipient claim, the fewer sessions shipped.

They were only in competition because the axis removed whole sessions. That instrument is
already measured in this repository, in journey-and-pitfalls §1:

| Step | Sessions |
|---|---|
| Full-text read of the archive | 35 |
| Grep of the shipped bytes | **17** |
| Block-level denial added | 40 |
| Value-level redaction added | 48 |

It went to 17 because whole-session removal was the only instrument, and back up once
parts of a session could be removed instead. Nothing about the corpus changed between
those two numbers. The audience axis was repeating that mistake with a new door.

## 3. What the setting moves now

**The audience changes what goes INTO the entity list. It never changes which sessions
ship.**

| audience | the employer's own name and product vocabulary | sessions |
|---|---|---|
| `teammate` | stays out of the list | all kept |
| `company` | stays out | all kept |
| `public` | **goes in, and is substituted** | all kept |

Each setting is still a claim about what the reader already knows, which is what makes it
checkable. "Is this something a colleague already knows?" is a question the owner can
answer in two seconds. "Is this a 6 or a 7?" is not.

Default `public`, because an archive that leaves a machine has left it, and the person who
receives it is not the last person who will hold it. Under the new mechanism the default
is also the safe one in both directions at once: `public` substitutes the most and keeps
every session.

### The clause this replaces

The operator contract's list of what stays OUT of the entity list carried:

> The user's own employer and its product vocabulary, when the recipient works there too.
> Substituting words the reader already knows wrecks the prose and hides nothing.

"When the recipient works there too" *is* the audience question. It was enforced only by
a human reading a document, and it reached that human only if the operator had loaded the
skill and remembered a conditional buried in a bullet list. It is now the flag.

### How the tool knows the employer's name

It does not ask, and it should not have to. Tier 0 already seeds every git remote of every
exported workspace (`src/entities/seed.mjs`), which gives it two things for free:

- `owner` from `owner/repo`. This is the employer identifier in most cases. It is seeded
  at **every** audience and is deliberately not on the axis: tier 0 cannot tell an
  employer's own org from a client's org the person has a checkout under, and the failure
  direction of guessing wrong is shipping a client's name to a stranger.
- `repo`, the bare repository name. This is the product vocabulary, literally: the names
  of the things the employer builds, spelled the way they are spelled in the prose. This
  is what `public` promotes, and it is the whole mechanical difference between the
  settings.

The repo name is gated by `projectShaped` (it carries a hyphen, a digit or a non-ASCII
character) and a four-character floor, which are the gates the project-directory seed
already uses. Without them a repository called `dashboard`, `references` or `migration`
becomes an entity and ordinary prose gets substituted, which is §F7's "a scan that cries
wolf is the first thing switched off" arriving as over-substitution.

**The gap, stated rather than papered over.** A company's written-out trading name is not
its GitHub handle, and tier 0 has no source for it. This is the same shape as the display
name: `git config user.name` is a handle on many machines, so the written-out name had no
tier-0 source and survived 293 times in a real export. So at `public` the candidates file
asks the reader for it directly, in a header the run generates:

```
# DECLARED AUDIENCE: public. Your own employer IS an identity here.
# Declare its written-out name, its products and its internal service names
# alongside the third-party ones. A reader who does not work there learns
# where you work, and what it sells, from those words alone.
```

and at `teammate` or `company` it says the opposite, in the same place. The header states
the rule and never the employer's name: this is the one artifact meant to be handed to a
model, tier-0 substitution has already taken the remote out of the prose, and writing the
company back into the header would put a plaintext identity in the file whose header
claims there is none.

## 4. What the setting must never move

The floor. Not a preference, not tunable downward, and the reason is that the person whose
data it is never agreed to any of this. BRIEF §F2 already says third parties are
force-replaced with no opt-out; this is the same principle applied to inclusion.

- Another named person's identity documents, ID numbers, date of birth, home address or
  personal phone.
- Another person's health, bereavement, relationship or family matter.
- Anyone's private message archive quoted verbatim.
- Live or recently-live credentials: vault contents, recovery kits, tokens, session keys,
  card numbers, 2FA codes, or a map of where any of those live on a machine. A trusted
  recipient is not a reason to hand over keys, and a key does not care who is holding it.
- A third party's immigration matter that is personal to them rather than sponsored by
  this employer: their own application, its rejection, their school place.
- The owner's personal finances outside the employment relationship: brokerage positions,
  personal mortgage, personal tax-residency strategy, personal purchases.

A session carrying any of that is `drop`, which is the only session decision that holds
anything, at every audience. The floor is why the setting is safe to expose: loosening it
cannot reach anything that belongs to someone who is not in the room, because the setting
no longer touches sessions at all.

## 5. Consequences for the report

The manifest already has to state how much each uploader withheld (privacy-tiers §6), or a
privacy choice reads downstream as a skill gap. It carries the **declared audience** for
the same reason: a corpus exported at `teammate` and one exported at `public` are not
comparable, and the recipient has no way to tell them apart from the contents.

Beside it, the number that says what the setting did:

```
declared audience: public  (14 employer names substituted because of it)
declared audience: teammate  (employer vocabulary left in place)
```

`manifest.heldByAudience` is gone. It was 0 on every measured run, and a zero printed
where no check ran is BRIEF §4.3's mistake landing in the block whose whole job is being
believed. `manifest.audienceEntities` replaces it and can be non-zero.

Zero `audienceEntities` at `public` on a machine with no git remote is a gap, not a clean
bill. The entity list from the semantic pass is the only thing that can carry the
employer there.

### Migration

`SESSION_DECISIONS` is `keep | drop`. A `review.md` written before this change still has
`drop:audience` rows, and those are read as the drop their author meant, at every
audience, and counted in `heldByFloor`. Refusing would strand the file; reading the value
as unknown would release a session someone held. The export warns once, names the count,
and says to rewrite them.

## 6. When to ask, which is not the same as where it lives

The obvious answer is "at the start, it is a setting". The run says otherwise, and
the reason is worth keeping.

The owner did not know his own answer until he had seen four concrete rows. Asked
cold, before any reading, he would have guessed, and a guess about a privacy line
is worse than no setting because it looks like a decision.

The rewrite makes this cheaper rather than solving it. The setting no longer decides
whether a session ships, so getting it wrong costs prose quality in one direction and
some substitution in the other, not a corpus. It is asked at the review step, before the
entity list is written, and it is re-askable: the whole pipeline downstream is
deterministic given the classifications.

Two things must be said at the moment it is asked, not after the archive exists, because
no setting fixes either and both bear directly on the answer:

- **Re-identification by role.** Substitution replaces the name, so the archive says
  `PERSON_6891158` and the residual scan correctly reports zero. But "the person who runs
  finance, payroll, investor relations and legal" resolves to exactly one human at a small
  company. Tokenisation does not anonymise a role.
- **The shape of the log itself.** A published work log shows the domain the person works
  in and the kind of client they work for, whatever the names are replaced with.

They are in the limits block that ships with the archive. That is too late to be part of
the decision, so the operator contract puts them beside the question.

## 7. What is still open

- Whether `teammate` needs to name the teammate. A per-recipient setting is more precise
  and much more state to keep.
- Whether the floor should be per-person-configurable at all, or whether allowing anyone
  to lower it defeats it. Current position: not configurable.
- The employer's own email domain. Correlating the local git address against the remote
  owner would identify it without a list of consumer mail providers, but `gitConfig` has
  no injection point, so it cannot be put under a fixture as it stands. An unfixtured
  seeding path in a privacy tool is worth less than the leak it closes.
- `--audience` is an `export` flag. `scan` takes none, so the entity list `review.md`
  shows is rendered as if `public`: for an insider export it lists repository names that
  the export will not substitute. It overstates rather than understates, which is the safe
  direction for a report, but it is still a report that does not match the run.
