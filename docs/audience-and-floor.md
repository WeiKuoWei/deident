# The tightness knob: a declared audience, over a floor

**Status: design, from a live export on 2026-08-22.** Nothing here ships yet. It replaces
the assumption in privacy-tiers §5 that there is no dial at all.

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

## 2. The axis is the audience, not a number

A 1-to-10 slider would be the obvious shape and it is the wrong one. A number cannot be
audited, cannot explain itself, and gives the person no way to know what moved between 6
and 7.

Declare the recipient instead:

| Setting | Recipient | What it assumes |
|---|---|---|
| `teammate` | a named colleague on the same team | Knows the projects, the people and who does what. |
| `company` | anyone inside the organisation | Knows the org exists and who works there, not every deal. |
| `public` | anyone, forever, including after a re-share | Knows nothing, and the archive may outlive the relationship. |

Default `public`, because an archive that leaves a machine has left it, and the person who
receives it is not the last person who will hold it.

Each setting is a claim about what the reader already knows, which is what makes it
checkable. "Is this something Nora already knows?" is a question the owner can answer in
two seconds per row. "Is this a 6 or a 7?" is not.

## 3. What the setting moves

At `teammate` and `company`, these stop being disclosures:

- Company-confidential business: deals, finances, strategy, cap-table structure, org
  changes, who is handing over which duties.
- **Re-identification by role.** This is the important one and it is invisible until you
  look for it. Substitution replaces the name, so the archive says `PERSON_6891158`, and
  the tool's residual scan correctly reports zero. But "the person who runs finance,
  payroll, investor relations and legal" resolves to exactly one human at a small company.
  Tokenisation does not anonymise a role. At `public` that is a leak; at `company` the
  reader already knew.
- The owner's own affairs that his employer already sees: his payroll arrangement, the
  company accounts he administers, a work visa that this employer sponsors.

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

The floor is why the setting is safe to expose. Loosening it cannot reach anything that
belongs to someone who is not in the room.

## 5. Consequences for the report

The manifest already has to state how much each uploader withheld (privacy-tiers §6), or a
privacy choice reads downstream as a skill gap. Add one line to that: **the declared
audience**. A corpus exported at `teammate` and one exported at `public` are not
comparable, and the recipient has no way to tell them apart from the contents.

A row should also separate the two reasons a session was held:

```
held back    12 sessions  by the floor
             19 sessions  by the audience setting (public)
```

The second number is the one that changes if the person turns the knob. Showing them
merged hides the only actionable half.

## 6. When to ask, which is not the same as where it lives

The obvious answer is "at the start, it is a setting". The run says otherwise, and
the reason is worth keeping.

The owner did not know his own answer until he had seen four concrete rows. Asked
cold, before any reading, he would have guessed, and a guess about a privacy line
is worse than no setting because it looks like a decision. What actually happened
is that four rows in a row got released for the same reason, and only then did he
name the axis himself.

So: **a setting that re-decides many rows belongs at the moment its effect can be
counted, not at the moment it is first needed.**

Three stages, and all three are cheap:

1. **At scan, as an envelope field.** Who is this for? Default `public`. It costs
   one line and it prevents the tool from spending a review pass holding things
   that a declared insider already knows.
2. **After classification, with the count.** "This setting is holding 28 sessions.
   20 of them move if you say `company`. Here are three of them." That is when the
   question is answerable, because the answer now has a size.
3. **From behaviour, mid-review.** After several consecutive releases that all
   trip the same held-for reason, propose the setting rather than asking the next
   row. Calibration by example costs the person nothing and is how they discovered
   the axis in the first place.

The whole pipeline downstream of the setting is deterministic given the
classifications, so re-asking is nearly free. Treat the setting as re-askable at
any point rather than as a thing chosen once at the top.

## 7. What is still open

- Whether `teammate` needs to name the teammate. A per-recipient setting is more precise
  and much more state to keep.
- Whether the floor should be per-person-configurable at all, or whether allowing anyone
  to lower it defeats it. Current position: not configurable.
- Where the setting lives: a flag, a line in `review.md`, or saved in `workspaces.json`
  next to the tier decisions. `review.md` is the file the decision is already made in.
