# Open problems on the review screen

Status: a list of problems and the choices they force, not a redesign. Every
number below came from a run against `docs/ui-prototype.html` or against the live
corpus at `C:/Users/devuser/.claude/projects`, not from reading the source. Where a
fix is proposed it is proposed as two or three options with what each costs,
because the choice is the owner's.

---

## 1. What is not up for debate

The genre change was right, and the parts that make it work should survive every
option below. Rows are the person's own first sentence already substituted, so
"Work out what my pay should be this month" is identified as dangerous in under a
second with no instruction, which no workspace name or count can do. Substitutions
render as visible inline pills (`<PERSON_03>`, `<PATH_412>`) rather than silently
clean text, so the reader watches the machine act instead of assuming it did. The
"Not checked" block states three inspectable classes in plain words next to the
claim it qualifies, and the sentence "Whole documents you pasted into your own
messages. The names in them are replaced. The text is still there." is the best
writing on the page. Denominators sit beside every zero: "0 lines of code (88
counted)", "known-entity residue: 0 across 54 entities", never a bare zero and
never a colour carrying meaning alone. Asymmetric friction is priced per decision
rather than per list, so holding a session back is one click and sending a refused
one costs a typed word, and that property does not degrade at 1,600 sessions.
Low-confidence names are individual rows with the matched quote inline, never
collapsed, which is F6 and L3.2 satisfied as written. And there is one derived
state table, so no stored total can drift from what the list says, which is why
most of what follows is cheap to change.

---

## 2. The problems, ranked

### P1. The line the row shows is the one line that cannot contain the thing the person is looking for

**Fatal.** A person scans 161 openers, recognises every one of them, sees nothing
alarming, and concludes they have looked. The sample they were shown is
structurally incapable of containing the material the tool exists to catch.

**Evidence.** Measured on the 187 non-sidechain sessions on this machine (sidechain
files excluded, matching `scope.md`). 109 of 187, or 58%, contain an E.164 phone
number or a third-party email address. Of those 109, the number where that material
first appears in record 1, the record the row renders, is zero. Only 4% have it
anywhere in the first user turn. Median first occurrence is record 56; 51% are past
record 50; p90 is record 320; maximum 1,353. Median session length is 711 records,
p90 5,229. The fixture proves the same thing in both directions: "Bring the domain
classification cost down" reaches "Does Kaito want this monthly or weekly?" at turn
4, while "Pull out the key terms of this contract" turns out to be one harmless
line. Separately, for 36% of real rows there is no sentence to recognise at all:
13.4% are a bare slash command (19 of them identical), 10.2% are under 25 characters
("really?"), 7.5% open with a pasted image, 4.8% are over 400 characters so the row
shows only a leading file path. Rendering the real length distribution at 1440px,
the sentence column is 741px, 62 of 187 rows (33%) truncate, and 8% of the
characters the person typed reach the screen. 16.6% of rows duplicate another row's
first 60 visible characters. The escape hatch, "open any row to read the whole
conversation", costs about 711 rendered lines and 10,900 characters of the person's
own prose per session at the median, so it is not a thing anyone does 161 times.

**Options.**

*A. Put the detector's own deepest hit in the row.* A second line under the opener:
the highest-severity mechanically unambiguous match in that session, quoted, with
its record number ("phone number, turn 56"). Build cost: the scan already finds
these spans in order to substitute them, so this is retaining the occurrence offset
instead of discarding it, the same discipline BRIEF §4.1 already applies to
`structuredPatch`. `cli-ux.md` §5 records that the index is currently built and
thrown away, and that `--entity` exits 2 because of it, so this is the work that
unblocks that flag too. Cost to the person: the row grows from one line to two, no
extra decision. Research: Kim et al. (arXiv:2212.06823, five experiments, N=731)
found explanations reduce overreliance only when they lower the cost of
verification, and a quoted line at a stated turn number is cheaper to check than
re-deriving it. Failure mode: F7. A marker that fires wrongly turns every row into
an alarm and the scan is the first thing switched off, so it must run only on the
precision-tuned classes (E.164 shape, third-party email, vendor credential prefixes,
the `ls -l` owner column). Worse, it inherits F1: an empty second line means "no
known detector fired", a person will read it as "nothing here", and that
manufactures a second, better-dressed false confidence.

*B. Leave the row alone, change the claim, and force a sample.* Relabel the column
as openers, state on the page that an opening line is not evidence about the rest,
and before the gate put N records drawn at random from the sending pile in front of
the person to read. Build cost: sampling is trivial, a reader for N records is
small. Cost to the person: N records, honestly stated as a sample. Research: elusion
testing is the accepted way to validate an unread pile (EDRM TAR Guidelines,
Sedona); EDRM's own statistical-sampling guide gives the price of a real confidence
claim, 385 items for 95%/±5% and 2,401 for ±2%. Failure mode: ten records out of
134,758 supports no confidence statement whatsoever, and a 2024 study cited by ACEDS
found elusion-only estimates overstating recall by 20 to 36 percentage points,
because elusion cannot see what was marked handled and misjudged, which is exactly
F1's class. So the attestation either states a sample too thin to reassure, or
overclaims.

*C. Show a better single line: the longest human-typed message rather than the
first.* Build cost: one line of code, no new detector, no retained index. Cost to
the person: none. Research: none, this is a heuristic with nothing behind it.
Failure mode: length is not correlated with exposure, and it destroys the one
property that works, because a person recognises their own opener and does not
recognise turn 40 out of context.

**Recommendation.** A, with the second line labelled as what a detector found rather
than as a verdict, and with silence never rendered as reassurance. Pick B instead if
retaining occurrence offsets through the export pass turns out to be expensive,
since B needs no new machinery and buys honesty rather than coverage. Do not pick C.

---

### P2. The attestation is produced by clicking, and the one interruption on the page is disarmed by the same click

**Fatal.** A person clicks one row out of curiosity and thereby signs a statement,
shipped inside the archive to the person who will score them, that they read a
session in full, while simultaneously switching off the only thing that would have
stopped them.

**Evidence.** Read state is `seen[id] = !seen[id]` and is counted with
`Object.keys(seen).length`, so the key survives closing. Open one row and close it
again: zero transcripts on screen, internal state `{"s5":false}`, attestation reads
"1 session in full". Clicking the text of seven rows in a loop took 366 ms and
produced "8 sessions in full". Opening 20 rows and closing all 20 leaves zero rows
visibly marked and the line still reading "20 sessions in full". The export gate's
`confirm()` fires only when `Object.keys(seen).length` is zero, so one click
anywhere in the list means an archive of 1,600 sessions builds with no dialog at
all. The gate is armed once per export and defeated by the cheapest gesture
available, which is also the gesture that inflates the claim. The line carries no
denominator, so "20 sessions in full" reads identically against a corpus of 8 or
1,600, where `ui-directions.md` Direction C specified the denominator as the point
of the mechanism. The `thin` warning class on `#a-read` drops off after the first
click and never returns, so 1-of-158 and 158-of-158 are styled identically. And
"2,178 messages you typed" is a hardcoded constant, unchanged across the 8, 161 and
1,600-session forks.

**Options.**

*A. Count something the page can actually witness, and use the word that applies.*
"Opened 8 of 158 sessions", with the count incrementing only when the last turn of a
transcript has been scrolled into view, and the warning style scaling with the ratio
rather than switching off after the first click. Build cost: an IntersectionObserver
on the final turn, plus the denominator, plus deleting the hardcoded message total
in favour of the derived one. Cost to the person: they must scroll each session they
want counted. Research: Bravo-Lillo et al. (SOUPS 2013/2014) found attractors that
require interacting with the changed field survive habituation where passive
salience does not. Failure mode: the GitHub "Viewed" checkbox, where the fastest way
to shrink the remaining-file count is to check it (community discussions 5303,
10830, 183812, still open after six years). Scrolling is not reading either, so the
wording has to stay "opened and scrolled", which is honest and ugly.

*B. Stop claiming reading.* The attestation states only what the tool can witness:
what is in the archive, what was held back and why, what was overridden, which names
were declined, which searches ran. Delete the "you read" line. Build cost: deletion,
the cheapest option on this page. Cost to the person: none. Research: the
signature-honesty result this mechanism is intuitively borrowed from does not
replicate. Kristal et al. (PNAS 2020, five conceptual replications plus one
pre-registered direct replication, combined N about 5,800) found no effect of
signing position, and the adjacent field experiment in the original 2012 paper was
retracted after Data Colada #98 found fabricated data. What does have a model is
Rule 26(g) and FOIA transmittal letters, which state what was produced, what was
withheld, and why, tied to a signer. Failure mode: the recipient loses any signal
about how carefully the corpus was reviewed, which may well be the correct outcome,
but it should be chosen rather than inherited.

*C. Let the person write it.* One free-text field, "how much of this did you
actually read?", shipped verbatim in the attestation. Build cost: one input. Cost:
five seconds. Research: Obar and Oeldorf-Hirsch (Information, Communication &
Society 2018, N=543) found 74% took the one-click fast path, and the readers who did
not spent 51 seconds against the 15 to 17 minutes required, so expect inflation; Ma
et al. (arXiv:2604.09518, N=293) found 97.3% of participants who failed a
comprehension check consented anyway when consent was not gated on it. Failure mode:
the audience for the sentence is the person assigning the score, which is a textbook
social-desirability setup, so the claim will be generous. It is at least the person's
own claim rather than one the tool wrote in their voice.

**Recommendation.** B, because the tool cannot witness reading and every option that
pretends otherwise is defeated at one click. Pick A instead if the owner has decided
that a depth-of-review signal genuinely should reach the recipient, in which case the
word is "opened" and the denominator is mandatory.

Separately, and under all three options: the gate's precondition has to stop being
"no row has ever been clicked". Either it always fires and states the numbers, or it
does not exist. A single-use interruption defeated by the cheapest gesture on the
page is worse than none, because it certifies the thin case away.

---

### P3. Every decision that increases exposure leaves no trace; only the ones that flatter are counted

**Fatal.** The person believes the enclosed record explains what they did. It records
effort, which is cheap and self-serving, and erases the three moments a recipient
would need.

**Evidence.** Overrode all three refused sessions by typing `send`. The tally moved
to "sending 161 · holding 0" and the attestation changed only its session count: no
word "overridden", no "anyway", and the reasons ("Entered a private directory")
vanish from the page entirely, so the row becomes indistinguishable from one that was
never flagged. Searched the attestation for "overrid" or "anyway": nothing. Setting
all eight flagged names to "Leave as written" moved "51 entities replaced" to "46"
with no label and no change to the Not checked block. Searching "Kaito", being told it
survives in two sessions, and shipping anyway leaves the internal state at
`searches:[]` and the attestation still reading "searched for no names"; a term is
recorded only if Replace is clicked, while a search that finds nothing is recorded and
credited. Clicking "Leave as written" on "Rosa Barnard" and "Marta Alvarez", both
rendered in context as people, is one click each, no prompt, no banner, against a typed
word for overriding a session.

**Options.**

*A. An append-only decision log, rendered in the attestation and shipped.* Every
override, every declined replacement, every search whose hit was not acted on, each
with a timestamp and a one-sentence reason captured at the moment of the decision.
Build cost: the state table already derives every figure, so this is an events array
plus a reason field on the override prompt. Cost to the person: one sentence per
override. Research: Rule 26(g) and FOIA transmittal practice, where a withholding
captures its basis at the moment it is made; AWS IAM Policy Simulator's
`MatchedStatements`, which names the policy and statement rather than the allow/deny
bit. Failure mode: a reason field people type "ok" into, and a record on which the
careful person looks worse than the careless one, since the careless person never
overrides anything. That is the same inversion `scope.md` names when it calls
`count-only` "the main defence against the conservative person scoring worse for being
conservative".

*B. Price the exposure direction like the protective one, and keep the marking.* An
overridden session keeps a permanent "refusal overridden" marker with its original
reason instead of reverting to a plain tick, and "Leave as written" costs the typed
word that "Send it anyway" costs. Build cost: small. Cost: a typed word per name,
eight in the fixture. Research: the EDPB asymmetry test the project already carries as
L2.7, is the more-exposure direction easier than the less-exposure one. Failure mode:
it builds friction for a control that BRIEF §5 F2 says should not exist at all.

*C. Remove the opt-out, as F2 already specifies.* Third-party entities are
force-replaced with no opt-out; only the uploader's own pseudonym is optional. The
override of a session refusal stays, and is recorded per option A. Build cost: deleting
two buttons. Cost to the person: fewer decisions. Research: F2 verbatim, "one fewer UI
control, not one more", on the ground that the person consenting is not the person being
exposed. Failure mode: F7's false positives become unfixable. `M1019757`, a thermal
paste part number, would have no remedy except holding the whole session back, which
shrinks the corpus the export exists to produce.

**Recommendation.** C for the entity opt-out, because the screen currently contradicts
a written policy decision, plus A for the session override. Pick B over C only if a
false-positive rate measured on a real corpus turns out high enough that forced
replacement damages the transcripts.

---

### P4. The only detector for names the tool does not know dead-ends, and the preview contradicts what the page says it did

**Fatal.** Person 2's entire task is "be sure it is gone". The screen tells them it is
gone and then shows it still there, so the person who checks their own work is the one
punished.

**Evidence.** Typed "Kaito": "Kaito survives in 2 sessions you are about to send. The
tool does not know this one." Zero `<mark>` elements appeared in the list, because the
highlighter runs over each row's first message while the matcher searches the whole
transcript; the list did not filter; all rows stayed. There is no affordance to reach
either session. Clicked "Replace it everywhere": the banner cleared, the search box
emptied, the attestation read "1 found something, now replaced". Then opened the session
it was in, and the transcript still renders "Does Kaito want this monthly or weekly?"
verbatim. Re-typed "Kaito": the original alarm returned, live on the same page as the
claim that it was replaced. The same class of failure runs the other way: clicked "Leave
as written" on Marta Alvarez, opened s5, and the transcript still shows "<PERSON_03>
ships hers next week", still redacted after the person switched the redaction off. At
1,600 sessions the banner reads "PERSON_03 survives in 1445 sessions" with one button,
"Replace it everywhere", which is a blind bulk mutation of the whole corpus, the exact
gesture the design refuses everywhere else. A miss reads "Nothing leaving this machine
still says Zelenko.", the strongest claim on the page, with no denominator and no
statement of scope, after searching 8 of 161 sessions. Hit and miss render the identical
yellow. The banner is not sticky while the search box is: scrolled to Build with "Kaito"
still in the pinned input, `#hit` sat at top -968px, off screen, class still "hit on",
while the attestation on screen read "searched for no names".

**Options.**

*A. Close the loop.* A hit filters the list to the hitting sessions and highlights
inside transcripts, not just first lines; replace acts on the state the transcript
renders from, so re-searching returns zero and the person can watch it return zero.
Build cost: the transcript renderer has to read from the substitution state instead of
the fixture string. That is the real work, and it is the same work P1's excerpt and P5's
score need, so it is one job serving three problems. Cost to the person: strictly cheaper
than today. Research: Chrome DevTools' Computed panel keeps the rule and the resulting
value in one always-visible trace with no separate command; L1.4, Everlaw's burn-in and
re-OCR, verify against the produced artifact rather than the display layer, which is
precisely the invariant this bug violates. Failure mode: none for the fix. The honest
caveat is that a search returning zero still says nothing about the names the person did
not think to type.

*B. Turn recall into recognition.* Beside the box, clickable chips of candidate terms
drawn from the corpus at scan time: capitalised tokens appearing three or more times that
are not already known entities. Build cost: a frequency pass, cheap, and the candidate
list already exists on disk as `deident-candidates.txt`. Cost: reading twenty chips.
Research: engagement with a search box sits around 14% of users starting with search
(MeasuringU, 90% CI 11 to 21%), with other studies putting use near 30% where one is
present; NN/g's finding that composing a query costs more than clicking through
navigation; and the data-donation think-aloud (n=20, Information, Communication & Society
2025) where most participants missed the option to inspect and delete their data despite
being told through three separate channels. Failure mode: that chip list is the semantic
pass's candidate list under another name, so it re-imports F6's collapsed-category problem
and, by Person 3's fourth run, the same twenty chips get clicked through together with the
one new name among them.

*C. Fix only the wording.* "X does not appear in the 158 sessions in this archive. This
searched the messages you typed, not tool output." Build cost: a string. Cost: none.
Research: `cli-ux.md` §7, wording is a security control, and L4.5 (Solove), a reassuring
claim needs an inspectable instance beside it on the same screen. Failure mode: it fixes
the overclaim and none of the dead-end. Person 2 still cannot reach the two sessions.

**Recommendation.** A, because this is a defect rather than a design choice and every
other option builds on top of a preview that lies. Take C's wording under all options;
add B only if the owner accepts that the chip list will habituate across runs.

---

### P5. The list is ordered by the decision the tool already made, and beneath that by nothing at all

**Serious.** The person spends their freshest attention on the pile that is already
safe, then works down a list that claims to be in date order and is not, using the only
bounding strategy available to them, "review the recent ones carefully", which the screen
quietly makes select the wrong rows.

**Evidence.** The sort is `if (a.out !== b.out) return a.out ? -1 : 1` and then
`a.d < b.d ? 1 : -1` over a string of the form `MM-DD`, and the row renders `MM-DD` with
the year nowhere on screen. At 1,600 sessions spanning three years: 524 inversions
against true date order across the 1,507 sending rows, 35% of adjacent pairs out of
order; the genuinely newest session sits at row 558; the top ten rows all read "12-31"
and are 233, 598, 233, 598, 598, 964, 598, 964, 598 and 234 days old. Because the year is
not rendered there is no signal available to the reader that anything is wrong. At 161
sessions over 113 days the same code is correct, so this passes every test at today's
scale and fails silently the first time a corpus crosses a calendar year. On the refusal
block: at 1,600 sessions rows 1 through 93 are sessions already held back and the first
row that will actually leave the machine is row 94; at 161 it is rows 1 to 11. In the
8-row fixture the top three rows contain no identifying material at all ("Clause 4 caps
the indemnity at.") while the only two sessions containing an unredacted real name render
at positions 7 and 8, ticked to send, with an empty badge column.

**Options.**

*A. Sort the sending pile by a computed exposure score, descending, with the score's
reason on the row, and move the refusals to the end as a receipt.* Build cost: the same
retained occurrence index as P1 and P4, no new detector. Cost to the person: none.
Research: NN/g's eye-tracking (original study, 21 users, 541 pages, 57,453 fixations,
80.3% of viewing time above the fold; 2018 replication, 120 users, about 130,000
fixations, more than 42% of time in the top 20% of a page and more than 65% in the top
40%, "regardless of the length of the page"), so the top of the list is the resource being
allocated; SmartBear's Cisco study (2,500 reviews, 3.2M LOC, 50 developers) found defect
detection falling off sharply past roughly 500 LOC per hour, so the highest-value review
minutes have to come first. Failure mode: a static heuristic ranking asserts "the risky
ones are at the top", which makes everything below it read even less carefully, and F1's
undetectable class lands in the tail by construction. This is a ranking claim the tool
cannot back.

*B. Fix the defect only: parse the date properly and render the year.* Build cost: one
line plus a column. Cost: none. Research: none needed, it is a defect. Failure mode: the
list is then truly in date order and still not in risk order, so "review the recent ones"
becomes executable and remains the wrong strategy unless recency correlates with exposure,
which nobody here has measured.

*C. Do not sort, group.* Workspace headings with counts, refusals in one collapsed block
at the end, and the person chooses which workspace to work through, since they know better
than the tool which of their own workspaces frightens them. Build cost: small. Cost: none.
Research: Bunt et al. (IUI 2012, n=21 interviews plus a 14-participant two-week diary
study) found participants wanted an explanation in only 7% of entries and judged the effort
of reading one usually not worth it, which argues against annotating all 161 rows with a
reason nobody asked for. Failure mode: Microsoft Research's email-triage study (CHIIR 2019)
documents the bulk-rationalisation failure precisely, important messages lost in archives
because the container-level action felt like handling; nothing would distinguish "I kept
this workspace" from "I read one row inside it".

**Recommendation.** B unconditionally and immediately, because the date sort is a defect
rather than a choice, and then A only if the occurrence index is being retained for P1
anyway, since the two share the work. Choose C if the owner decides not to build any
ranking at all, because grouping is honest about having no opinion where a weak score
pretends to have one.

---

### P6. Opening one session destroys the list, and there is no way to work in more than one sitting or on more than one row

**Serious.** The gesture the whole design rests on can be performed two or three times
before the page becomes an unnavigable document, and a person who stops halfway has no
record of where they stopped.

**Evidence.** At 1,600 sessions opening a single row injects 1,201 turns and 39,456px
between that row and the next, so the distance from the opened row to the following row is
22,207px, 25 full 900px screens, with no collapse-all and no route back. At 161 the same
gesture injects 773 to 1,510 turns (25,323 to 49,795px, 28 to 55 screens). Opening 20 rows
takes the page to 893 to 1,276 screens and 75,184 to 105,417 DOM nodes, and the 20th click
costs 199 to 268ms. Opening 40 rows at 1,600 sessions reaches 2,275,164px and 210,035
nodes, at which point each further click costs 1,475ms because every click rebuilds the
whole list through `innerHTML`. There is no multi-select of any kind: 1,600 individual
hold/send buttons, and exactly one checkbox on the page, the New filter. The largest single
workspace in the 1,600 fork holds 110 sessions, each needing its own click to exclude. The
workspace dropdown offers 4 options against 17 workspaces present in the data. The tally
("Showing 1600 · sending 1507 · holding 93") reports the filter selection and is unchanged
after opening 40 sessions; closing a row removes its `.opened` highlight, so after working
through 20 sessions the number of rows visibly marked as looked-at is zero, and nothing on
the page ever says "you have looked at 12 of 161". Keyboard tab order runs search,
workspace, date, New, then straight into consecutive fate-flipping row buttons; rows are
plain divs with no tabindex and the open-transcript behaviour is a delegated click handler,
so the reading half of the screen is unreachable without a mouse.

**Options.**

*A. Transcript in a pane, marks that persist, one bulk gesture in the safe direction only.*
Clicking a row opens its transcript in a fixed overlay or side pane so the list never moves;
rows keep a persistent looked-at mark; one line states "looked at 12 of 161"; "exclude
everything in this filter" is one gesture while re-including stays per row. Build cost:
layout work, plus the resume problem. `cli-ux.md` §4 forbids a local server, so "where I
stopped" has to be written to `review.md` or to a file the person keeps and re-opens. Cost
to the person: none per row, and the resume path costs them a file. Research: GitHub's
per-file "Viewed" checkbox is the closest deployed analogue, and its jump-to-next-unreviewed
complaint has been open since 2019 across three community threads and survived the
2026-01-22 Files Changed rework, so a static-file version should budget for partial rather
than solved; Englefield and Beale (BCS HCI 2025, n=51) measured median adoption of deletion
as a tactic at 0.25 against 0.875 for filing and coverage tactics, so people under-remove
and the bulk gesture belongs on the exclude side, which also preserves the asymmetry.
Failure mode: the same GitHub checkbox failure, marks clicked to shrink the remainder, and a
visible progress number invites optimising the number.

*B. Do not solve resume; make the transcript cheap.* Lazily render turns, cap the initial
render, add collapse-all and a close control that restores scroll position. Build cost:
small. Cost: none. Research: the measurement itself, since 1,600 rows paint in 30ms and the
entire cost is expanded transcripts, so this is the correct layer and pagination of the row
list is the wrong one. Failure mode: navigation is fixed and stopping halfway still costs
the whole pass, so a person who quits at row 40 restarts at row 1.

*C. Shrink the unit: review and export one workspace at a time.* Build cost: an export shape
change, outside this screen. Cost: several handovers instead of one. Research: SmartBear's
200 to 400 LOC per review ceiling, with effectiveness falling off a cliff past it, so the
batch has to be small enough to finish. Failure mode: the recipient gets N archives, and the
largest workspace here is still 110 sessions, past any ceiling this cites.

**Recommendation.** A's pane and B's lazy transcript are one job and both belong; take A's
persisted marks only if the owner accepts a state file on disk, since without a server there
is nowhere else for them to live. The keyboard gap is not an option, it is a fix: rows need a
role and a tabindex, and the reading affordance has to be reachable.

---

### P7. The two decisions with the largest blast radius are not on this screen

**Serious.** The person believes the row list is the decision surface. The decision that
moved most of their corpus was made in a file they were never shown, and the one filter
addressed to a repeat user silently means the opposite of what they need.

**Evidence.** `privacy-tiers.md` calls the workspace tier the coarse decision "made once,
remembered", and 43 of them have already been passed before the page opens. Searched the
rendered text for the tier vocabulary: `exclude` false, `count-only` false, `redact` false,
`tier` false. Loading a realistic 224-session corpus into the page's own state table gives
224 rows, 14,291px tall, with 47 `<home>` sessions each carrying an identical "No repository,
undecidable" chip rather than that fact appearing once as a workspace property, and the first
row that is actually leaving at y=3,780px. The three `reason` strings that do exist are
restated conclusions ("Entered a private directory") rather than the matched deny-list token
or the offending `cwd` line. Meanwhile the "New since last export" filter renders 3 rows while
the tally reads "Showing 156 · sending 156 · holding 0" and the attestation reads "Leaving:
158 sessions"; pressing Build produces "16.2 MB · 158 sessions · attestation enclosed".
Nothing marks the filter as a view rather than a scope. The filter's predicate is a
per-session `isnew` flag, so a session already exported that has since gained new turns never
appears under it and is re-shipped in full, and the same eight name decisions are
re-presented undifferentiated on every run despite the note promising "anything you turn off
stays off on every future export".

**Options.**

*A. Put the tier table on the screen.* Each workspace with its tier, session count, and the
literal signal that decided it (the matched deny-list token, the absent remote, the `cwd`
path), each editable in place. Build cost: the data already exists in `review.md` and
`workspaces.json`, so this is rendering it, plus carrying the matched value through instead of
collapsing it to a label. Cost to the person: 43 rows glanced at once. Research: Norman's gulf
of evaluation, where a tick reports the outcome and not the rule; AWS IAM's
`MatchedStatements`; Kim et al. again, an explanation helps only when it is cheaper than
re-deriving the fact, which "Entered a private directory" is not, because the reader has to go
find `review.md` to check it. Failure mode: uBlock Origin ships exactly this level of
per-decision traceability in its logger and almost nobody opens it, so a second surface
inherits that; and putting it first costs the top of the page, which P5 wants for the risky
rows.

*B. Name the file and the number, in one line.* "63 sessions in 12 workspaces are excluded
before this list. That decision lives in review.md." Build cost: one line. Cost: none.
Research: `cli-ux.md` §3, the decision is made by editing a text file that can be grepped,
diffed and reviewed by a second person, and `scope.md` ships `review.md` as the audit record.
Failure mode: it points at a second surface most people will not open, but the screen at least
stops implying that the row list is the whole decision.

*C. Filter honesty, unconditionally and separately from A or B.* Any active filter renders the
archive count beside the shown count ("showing 3 of 158 leaving"), and the Build button names
what it will include. Build cost: small. Cost: none. Research: this is the
arithmetic-contradiction fix, and `cli-ux.md` §6 already makes the point that a block whose
whole job is being believed must not assert a number and then contradict it. Failure mode:
none known.

**Recommendation.** C today, because Person 3 currently signs an attestation for a delta they
did not export, then B. Do A when the first uploader outside the team appears, which is
`scope.md`'s own trigger for the browser GUI, since duplicating the tier table on screen before
then creates two sources of truth for a decision `review.md` was built to hold.

---

### Below the line

Real, measured, and not worth one of the seven slots. Listed so they are not lost.

- The remote font is back. Commit `d73d475` reintroduced one `fonts.googleapis.com` stylesheet
  and two `fonts.gstatic.com` woff2 requests on `file://` load, reversing `scope.md`'s Settled
  entry and the prohibition named in `cli-ux.md` §4. One-line fix, and it should have a test.
- A selected "Leave as written" button computes to `rgb(159,232,112)`, identical to "I have read
  this. Build the archive.". The more-exposure direction wears the terminal action's colour, and
  three of eight names ship pre-set to it.
- At 680px `.rz` and `.dt` compute to `display: none`, so a refused row keeps its cross and its
  "Send it anyway" button while the reason for the refusal disappears.
- "153 more rows, same shape, keep scrolling" is a summary of the unexamined bulk, in the tool's
  own voice, granting permission to stop, placed exactly where the reader would otherwise have
  had to start working.
- An entity row shows one snippet for eleven occurrences with no drill-in, so the person decides
  about ten strings they were never shown. `cli-ux.md` §5 already specifies `review --entity` for
  this and it currently exits 2.
- 97.7% of the export is tool output, and neither the reading path nor the search path touches
  it: activity renders as "Read 6 files · cleaned" with nothing behind the word, and the search
  box matches only those summary strings. F3's 296 bare usernames arrive exactly there. This is
  below the line only because Direction A knew and accepted it in writing, not because it is
  small.
- 164 MB at 1,600 sessions with transcripts embedded (7.0 MB at 161 at BRIEF's density, 17.2 MB
  at the density measured on this machine), 5.1s load, 290 MB JS heap. Worth knowing before the
  cheapest fix, dropping embedded transcripts, gets chosen by file size and quietly deletes the
  only answer to P1.

---

## 3. What I would not do

**A "you have read N of 161" progress bar as a motivator.** No study measures gaming of a
within-session completion counter; the closest evidence is GitHub's Viewed checkbox, where the
fastest route to shrinking the remainder is to check it. Goodhart applies, and the predicted
failure is the one that killed the dashboard: a visible number invites optimising the number. A
denominator inside the attestation is a different thing and is wanted.

**Moving the signature to the top of the flow to increase honesty.** The effect does not exist.
Kristal et al., PNAS 2020, N about 5,800, null; the adjacent field study in the 2012 paper was
retracted for fabricated data. Treat the attestation as a record, never as a lever.

**Building Direction B's sequential doubt queue now.** Anderson et al. (CHI 2015, longitudinal
fMRI and eye-tracking) measured visual-processing response to a same-shaped warning dropping
sharply after the second exposure, and nothing in that literature measured tens of sequential
decisions in one sitting. Thirty-four same-shaped items is a queue nobody finishes.
`ui-directions.md` already gates this to slice 2, and that is right.

**Gating export on a comprehension check.** Ma et al. (arXiv:2604.09518, N=293, six conditions):
the best condition got 41.7% past an 80% threshold on the first attempt against 17.4% for plain
text, and median review time rose roughly sevenfold. Where consent was not gated on the check,
97.3% of participants who failed it consented anyway. Sevenfold time for four in ten is not a
trade this product can make, and gating is the "wizard of confirm dialogs" objection L4.8 already
raises.

**A one-command path that skips review.** Obar and Oeldorf-Hirsch: 74% took the fast path when
one existed. `cli-ux.md` §1 already forbids bare `deident` exporting, and no flag should reopen
it.

**Paginating or virtualising the row list.** Measured: 1,600 rows paint in 30ms, 161 in 3 to 5ms.
The cost is entirely expanded transcripts. Fixing the row list is fixing the wrong layer.

**Continuous Active Learning, or any relevance-ranking model, in slice 1.** Grossman and Cormack
(SIGIR 2014, eight real matters; arXiv:1504.06868) show CAL reaching high recall at a labelling
cost asymptotically proportional to the number of relevant documents rather than to collection
size, which is exactly the property this list wants. It requires a classifier retrained on every
human decision. deident's confidence is a static heuristic tag computed once. This is a materially
larger build than "make the confidence field smarter" and belongs where `ui-directions.md` put it.

**Claiming a confidence level from a small elusion sample.** ±5% needs 385 items, ±2% needs 2,401
(EDRM statistical sampling). A 2024 study cited by ACEDS found elusion-only estimates overstating
recall by 20 to 36 points, because elusion samples what was set aside and never what was kept and
misjudged, which is F1's class exactly. "We looked at ten" is an honest sentence; any percentage
attached to it is not.

**Reopening the vocabulary.** "known-entity residue: 0 across 54 entities", "Nothing leaving this
machine still says X", "X survives in N sessions you are about to send. The tool does not know
this one.", the Not checked block. Three audit rounds produced these and they should stand. The
single wording change proposed anywhere above is adding the scope clause to the negative result in
P4.

---

## 4. Appendix: research, with sources

**Redaction review at scale.** Grossman & Cormack, "Evaluation of Machine-Learning Protocols for
Technology-Assisted Review", SIGIR 2014, https://dl.acm.org/doi/10.1145/2600428.2609601, and the
follow-up https://arxiv.org/pdf/1504.06868 (CAL labelling cost proportional to relevant documents,
not collection size). EDRM TAR Guidelines,
https://edrm.net/wp-content/uploads/2019/02/TAR-Guidelines-Final.pdf, and the Sedona Conference, on
elusion testing as the accepted validation of an unread pile. ACEDS, "The Elusion Illusion and the
AI Revolution", https://aceds.org/the-elusion-illusion-and-the-ai-revolution-aceds-blog/ (2024
study: elusion-only recall estimates overstated by 20 to 36 percentage points). EDRM statistical
sampling guide,
https://edrm.net/resources/project-guides/edrm-statistical-sampling-applied-to-electronic-discovery/
(385 items for 95%/±5%, 2,401 for ±2%, and review effort scaling with yield). Rule 26(g) and FOIA
transmittal letters, already summarised at L1.7: the sign-off states what was produced, what was
withheld, and why, tied to a signer.

**Consent, comprehension and self-report.** Kristal, Whillans, Bazerman, Gino, Shu, Mazar & Ariely,
"Signing at the beginning versus at the end does not decrease dishonesty", PNAS 2020, combined N
about 5,800, null result; Data Colada #98 on the fabricated data in the adjacent 2012 field
experiment. Ma, Majumdar, Rajtmajer & Frischmann, "Demonstrably Informed Consent in Privacy Policy
Flows", https://arxiv.org/abs/2604.09518, N=293: best condition 41.7% comprehension on first attempt
versus 17.4% for plain text, median review time about sevenfold, and 97.3% of below-threshold
participants consenting where consent was not gated. Obar & Oeldorf-Hirsch, "The Biggest Lie on the
Internet", Information, Communication & Society 2018, N=543: 74% took the one-click path, readers
averaged 51 seconds against 15 to 17 minutes required. Data-donation think-aloud study (n=20,
Information, Communication & Society 2025): most participants missed the option to inspect and
delete their data before donating, despite being told in the recruitment post, a follow-up email
and the consent form. The primary text returned HTTP 403, so this is from the abstract and indexing
and is flagged thin. Solove on the consent dilemma, already carried as L4.5.

**Attention, habituation and where a list stops being read.** Anderson et al., CHI 2015,
longitudinal fMRI plus eye-tracking: response to a same-shaped warning drops sharply after the
second exposure, and a polymorphic warning resists that across five days. Bravo-Lillo et al., SOUPS
2013/2014: attractors requiring interaction with the changed field survive habituation where passive
salience does not. Nielsen Norman Group, original scrolling study (21 users, 541 pages, 57,453
fixations, 80.3% of viewing time above the fold),
https://www.nngroup.com/articles/scrolling-and-attention-original-research/, and the 2018 replication
(120 users, about 130,000 fixations, more than 42% of time in the top 20% of a page, more than 65% in
the top 40%, regardless of page length), https://www.nngroup.com/articles/scrolling-and-attention/.
SmartBear's Cisco code-review study (2,500 reviews, 3.2M LOC, 50 developers): review 200 to 400 LOC at
a time, detection falls off sharply past about 500 LOC per hour,
https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/. The original PDF would
not decode on two fetch attempts, so those figures are vendor-published and not independently
re-verified.

**Search, browsing and bulk triage.** MeasuringU on search-first behaviour, about 14% (90% CI 11 to
21%), with other studies putting search-box use near 30% where one is present; NN/g on the interaction
cost of composing a query exceeding that of clicking through navigation. Sarrafzadeh et al., "Exploring
Email Triage: Challenges and Opportunities", CHIIR 2019,
https://www.microsoft.com/en-us/research/uploads/prod/2019/02/Email_Triage_CHIIR19.pdf: bulk archiving
loses important messages inside a pile that looks handled. Englefield & Beale, "Deletion Considered
Harmful", BCS HCI 2025, n=51, https://arxiv.org/abs/2512.23907: median adoption of deletion as a tactic
0.25 against 0.875 for filing, timeliness and coverage tactics, so people retain by default and a strike
gesture works against the grain rather than with it. No study was found measuring regretted disclosure
from a bulk-triage interaction, so that transfer is a directional inference and is marked as one.

**Showing the rule rather than the outcome.** Norman's gulf of evaluation,
https://www.nngroup.com/articles/two-ux-gulfs-evaluation-execution/. AWS IAM Policy Simulator's
`MatchedStatements`, which names the policy and statement that produced an allow or deny,
https://docs.aws.amazon.com/IAM/latest/APIReference/API_SimulateCustomPolicy.html, and which declines to
do so for SCPs, so even IAM concedes that rule transparency is not universal. Chrome DevTools' Computed
panel, rule and winning value in one always-visible trace,
https://devtoolstips.org/tips/en/find-why-css-property-is-overridden/. uBlock Origin's logger, full
per-request traceability behind a second surface that most users never open,
https://github.com/gorhill/uBlock/wiki/The-logger. Bunt, Lount & Lauzon, "Are Explanations Always
Important?", IUI 2012, https://dl.acm.org/doi/10.1145/2166966.2166996: an explanation was wanted in 7%
of diary entries and the comprehension effort was usually judged not worth it, measured on low-stakes
reversible systems, which is the opposite of this one. Kim et al., "Explanations Can Reduce Overreliance
on AI Systems During Decision-Making", https://arxiv.org/abs/2212.06823, five experiments, N=731:
explanations reduce overreliance when, and only when, they lower the cost of verification.

**Per-item review state in a shipped product.** GitHub's per-file "Viewed" checkbox and the
jump-to-next-unreviewed gap, open since 2019 across
https://github.com/orgs/community/discussions/5303, https://github.com/orgs/community/discussions/10830
and https://github.com/orgs/community/discussions/183812, still open after the 2026-01-22 Files Changed
rework,
https://github.blog/changelog/2026-01-22-improved-pull-request-files-changed-page-on-by-default/. A
well-resourced team with a live server has not fully solved resume for a large reviewable set, which is
the budget a static single-file page should plan against.

**Method for the measurements in section 2.** Playwright CLI, headless Chromium, `file://` load of
`docs/ui-prototype.html`, scratch files under the session temp directory only. Scale figures come from
generated forks at 8, 161 and 1,600 sessions, built at both BRIEF's implied density (134,758 records
over 224 sessions) and the density measured on this machine (p50 711 records, p90 5,229), with both
quoted wherever the answer differs. Corpus figures come from `C:/Users/devuser/.claude/projects`: 4,041
`.jsonl` files, 1,811 MB, of which 187 are non-sidechain sessions with a human first message.
Sensitive-material depth was measured with mechanically unambiguous markers only (E.164 phone shape,
third-party email addresses excluding the user's own); an earlier pass using loose keyword markers
returned 100% of sessions and was discarded. A ripgrep pass for literal credential prefixes
(`github_pat_`, `sk-ant-`, `xoxb-`, `AKIA`, `ntn_`) returned zero files, so F6b's shipped PAT is not
currently in this corpus and nothing above leans on it. No reading rate was invented: where a time claim
appears it uses the design's own stated bet from `ui-directions.md`, identification in under a second,
which puts the 1,507 sending rows at about 25 minutes of unbroken scanning at 1,600 sessions and about
2.5 minutes at 161. Scanning is not the expensive part. P1 is that scanning does not work.
