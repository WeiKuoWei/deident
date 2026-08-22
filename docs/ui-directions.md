# Three directions for the review interface

**Status: a decision to make, not a spec.** This document exists because the
current prototype (`docs/ui-prototype.html`) is the wrong genre, and three rounds
of audit could not see that because they were auditing inside the genre. What
follows is three interaction models that disagree with each other about the one
question that decides everything else: **what is the unit of review?**

The evidence they rest on is preserved in the appendix, with sources.

---

## 0. What is actually wrong, in one paragraph

The prototype is a statement of account. It opens with three balances
(`選進範圍 153` / `需要你決定 8` / `不會交出去 64`) and its most prominent prose is a
reconciliation: `48 ＝ 45 個從沒送過 ＋ 3 個送過但之後又有新對話(重送完整版)。`
Measured on screen 1 alone: 2,819 px collapsed, 4,318 px expanded, 3,642 CJK
characters, 137 numeric tokens, 32 interactive controls, and **nineteen** verbatim
fragments of the user's own corpus across all three screens. One hundred and
thirty-seven numbers against nineteen fragments of the thing being released.

The reader's role in that genre is auditor of totals, and the action it invites is
agreeing the arithmetic. But nobody is anxious about the arithmetic. The anxiety is
"am I willing to let a stranger read the sentences I actually typed", which is a
reading task. Every research strand gathered for this decision converged on the
same finding independently: **a summary is not a genre that can produce informed
consent, no matter how well built** (L2.1, L1.1, L4.2). It gets scanned, believed,
and not cross-checked against the underlying content.

So the question is not how to improve the dashboard. It is what replaces it.

---

## Direction A. The Contact Sheet

> **Thesis.** The unit of review is the conversation, so the screen is the list of
> conversations rendered in their released form, and every count in the product is
> just the length of a filtered selection of that list.

### What you see first, concretely

No header. No totals. The first paint is rows, sorted worst-first:

```
✕  08-14   幫我看一下這個月薪水怎麼算            碰到私密目錄     [其實要送]
✕  08-13   幫我改一下這封給房東的信              碰到私密目錄     [其實要送]
✓  08-16   這個 residual scan 要怎麼寫                            [改成不送]
✓  08-15   把 passport 的 hero section 重做                       [改成不送]
✓  08-14   CI 一直在 flaky,幫我找根因                            [改成不送]
   …157 more, same shape, scroll
```

Above them, one filter bar and nothing else: workspace, date range, "only new since
last export", and a search field. The counts live inside the filter bar, describing
a selection the reader can see below it: `顯示 161 筆 · 選進 153 · 不交 8`.

Each row is that session's own first user message, already substituted. Clicking a
row opens the **full redacted transcript** of that one session, which is precisely
what `cli-ux.md` §5 already specifies (`deident review --session 2026-08-14-a3f9`)
and which the prototype implements in no form whatsoever.

### Unit of review, and the path through it

**The session.** Workspace stops being a screen and becomes a filter plus a bulk
gesture over the row list: `payments-api … 改成不交` becomes "select these 59 rows,
exclude". Entity review stops being a separate step and becomes a rendering mode of
the same list, with substitutions highlighted inline and clickable to toggle. The
turn is the drill-down. Four competing units become one unit with three zoom levels.

Path: land on rows, scan the top (worst-first), open the two or three that look
alarming, strike what must not go, export.

### What it bets on, what it costs

It bets that **recognition is cheap and instant**. `幫我看一下這個月薪水怎麼算` is
identified as dangerous in under a second by anyone, engineer or not, with zero
instruction; `acme-payroll-2026` requires you to already know what is in it. It also
bets the arithmetic is genuinely uninteresting, which the prototype's own defensive
prose suggests it is: three separate paragraphs there exist only to stop its numbers
contradicting each other.

The cost is that the tool must render a redacted transcript on demand, in the
browser, from the same state table. That is real work the prototype has never done.
It also gives up saying anything crisp about the 97.7% of bytes that are not human
speech, because those bytes have no row.

### Research support

L4.1 (terraform plan, apt-get remove): both put the itemized list first and the
aggregate count last, as a closing line, before an irreversible action. L4.2 (Few):
a dashboard serves a recurring glance, a release gate is read once carefully, and
the genres are opposites. L1.1 (Relativity, Everlaw, Reveal, DISCO): nobody's
primary screen is a dashboard of aggregate statistics, it is a queue plus the
document itself. L3.6 and L4.7 (serial position): sort by stakes, not by discovery
order.

### What it does badly, honestly

A list of 161 rows is still a list of 161 rows, and L2.5 (Anderson et al., fMRI plus
eye tracking) measured attention to a repeated same-shaped widget collapsing within a
handful of exposures. Rows 15 to 35 will be read least carefully no matter how they
are styled. A dropped session is visible; a **missing** entity inside a kept session
is not, and this direction gives the reader no systematic way to find one except
reading. It is also silent on tool output, which is where the corpus actually lives.

### At ten times the corpus

1,610 rows. Degrades gracefully in structure and badly in practice: the filter bar
and the worst-first sort keep the top of the list useful, the scroll becomes
decorative below roughly row 60, and "I looked at my sessions" quietly stops being
true. The honest mitigation is that the filter bar must then carry a **stated
sample** rather than pretending the list was read, which is Direction C's gate.

---

## Direction B. The Doubt Queue

> **Thesis.** The unit of review is one detected span in its context, clustered with
> its near-duplicates, and the human's scarce attention is spent only where the
> detector is unsure, never on what it is already certain about.

### What you see first, concretely

One item, full width, blocking. Nothing else on screen.

```
  1 of 34 decisions            低信心 · 出現 4 次 · 3 個 session

  …跟 <PERSON_11> 約了 call,他說 sprint 那邊…            08-14 gitroll turn 47
  …<PERSON_11> 說他下週把 schema 交出來…                  08-14 gitroll turn 51
  …照 <PERSON_11> 的講法應該是 rate limit…                08-16 gitroll turn 12

  模型覺得這是節日不是人,它不確定。預設先換掉。

  [ 是人名,換掉 ]   [ 不是人名,原文保留 ]   [ 我不確定,一併換掉 ]
```

Behind it, a small status strip that never grows:
`34 待決定 · 13 已決定 · 47 高信心已確認`. The 47 high-confidence entities are one
collapsed line the reader affirms as a block, because replacing them is harmless and
certain.

After the doubt queue empties, one more screen the reader cannot skip: **the elusion
sample**. Ten records drawn at random from the bucket the detectors never flagged,
shown as they are, with the question "did we miss anything here?" and a field that
adds an entity.

### Unit of review, and the path through it

**The detected span, clustered.** Near-identical occurrences collapse into one
representative decision that propagates to the cluster, which is exactly how
e-discovery makes an unreadable corpus reviewable (L1.2). The 134,758 records
collapse to a queue of tens, ordered by cost-of-being-wrong: low confidence and high
occurrence first, everything certain at the back or gone entirely.

Path: affirm the certain block, work the doubt queue one item at a time, answer the
elusion sample, export.

### What it bets on, what it costs

It bets that **the risk lives at the detector's boundary** rather than spread evenly
through the corpus, and that a bounded queue of tens is finishable where a list of
hundreds is not. It also bets the thing to protect against is the detector being
wrong in both directions, which BRIEF §5 supports on both counts: F7 (a
passport-shaped regex matched `M1019757`, a thermal-paste part number) and F1 (230
distinct emails in a 90-file sample, 228 of them not the user, and emails have a
regex while names do not).

The cost is clustering and confidence scoring the pipeline does not have yet, plus an
elusion sampler that has to draw from the never-flagged bucket, which is the bucket
nothing currently indexes.

### Research support

L1.3 (Relativity Redact QC panel): every automated markup is individually accepted or
rejected, never summed into an aggregate. L1.5 (EDRM TAR elusion testing): validation
must sample the bucket the system decided was safe, because that is where a false
negative survives unexamined. L3.1 (Dependabot, Google DLP, Purview, Semgrep): never
let the person face the raw count, route it through confidence buckets and make only
the low bucket demand individual reading. L3.2: the evidence sits in the row, not
behind a second command. L2.6 (Egelman et al., CHI 2008): 79% did not click through an
actively blocking warning, versus 13% for a passive one.

### What it does badly, honestly

It never shows the person their own sentences. The whole review can complete without
the reader ever reading one of their own conversations, which means it answers "is
the redaction correct" and leaves "am I willing to release this at all" entirely
untouched. Those are different questions and only the second is the product. L4.8
(USENIX 2023: over 90% of consent dialogs carry a dark pattern; plus the Android
runtime-permission work on reluctant hot-state consent) also warns directly that a
sequence of small blocking confirmations degrades into rubber-stamping, and 34 of them
in a row is a sequence.

### At ten times the corpus

**Best of the three, and it is not close.** Queue length is a function of detector
uncertainty, not corpus size, so ten times the data might yield 60 decisions instead
of 34. Elusion sample size is set by a confidence level, not by N (L1.6: no magic
coverage percentage exists, state the statistical basis instead). This is the only
direction here whose review cost does not scale with the corpus.

---

## Direction C. The Galley

> **Thesis.** The unit of review is the released artifact itself, read as one
> continuous document, and the release decision terminates not in a button but in a
> written record of what the person actually looked at.

### What you see first, concretely

The zip's contents, rendered as one scrolling document in released form, starting at
the first session, with substitutions live in the text:

```
  ────────────────────────────────────────────────  2026-08-14 · <WS_01> · 1/161
  你      CI 一直在 flaky,幫我找根因
  Claude  先看 <PATH_412> 這支測試的 setup…
  [ 讀了 3 個檔案 · 已清理 ]
  你      跟 <PERSON_03> 約禮拜四,<PERSON_03> 說她下週交
  ────────────────────────────────────────────────  2026-08-14 · <WS_01> · 2/161
```

The most prominent control on the page is a **search box**, pinned, with a
placeholder that says what it is for: `搜尋你自己知道、但工具可能不知道的名字`.
Typing a real name that survives anywhere in the payload is the point. Any hit is one
click from being added to the entity list.

The export gate is not a checkbox. It is a rendered attestation the reader can read
before signing, and which ships next to the zip:

```
  這次要出去的是:161 個 session,2,178 則你自己打的訊息。
  你實際看過:6 個 session 的全文,搜尋了 4 個詞(其中 1 個有命中,已加入替換)。
  自動檢查:序列化通過、替換可還原、代號沒撞名、已知實體殘留 0 命中(共 54 個實體)。
  沒有檢查到的:工具不認識的人名、裝置指紋、你自己貼進訊息裡的整份文件。
  簽下去的是你。                                            2026-08-22 14:07
  [ 我看過上面這些,產出檔案 ]
```

### Unit of review, and the path through it

**The artifact, navigated by query.** There is no list of objects and no queue of
decisions. There is one document and a search box, and the search query is the
navigation primitive. Scope filters exist but are secondary; striking a session is a
gesture inside the flow of reading, not a row control in a table.

Path: read from the top for as long as you like, search the names only you know,
strike inline, read the attestation, sign.

### What it bets on, what it costs

It bets that **the only honest consent artifact is a record of what was actually
looked at**, and that stating "you read 6 of 161" plainly is more trustworthy than any
interface implying more. It also bets that search is not a convenience but the single
available detector for the unknown-entity class: F1 says the residual scan finds only
entities it already knows, so a human searching for a name they alone know is the only
mechanism that exists for the rest. `cli-ux.md` §4 already promises this ("lets the
reader search") and the prototype has no search field on any screen.

The cost is that it is the least directive of the three. It asks the reader to decide
how much reading is enough, which many will answer with "none", and the attestation
will then say so honestly and let them proceed anyway.

### Research support

L1.7 (Rule 26(g), FOIA transmittal letters): the sign-off in mature practice is a
specific written statement of what was and was not done, tied to a signer, not a
generic confirm button. L1.6 (EDRM and Sedona): state the statistical basis rather
than implying a coverage guarantee. L2.2 (Xiong et al., systematic review): consent
text gets skim-read, so the thing that must be read is the material itself, not a claim
about it. L4.5 (Solove, the consent dilemma): a reassuring summary produces the
appearance of informed consent unless every reassuring claim has an inspectable
instance behind it on the same screen. L1.4 (Everlaw burn-in plus re-OCR): verify
against the produced artifact, not the display layer, which is why the reader is shown
the released form rather than a preview of it.

### What it does badly, honestly

It has no opinion about where to look, so it spends the reader's attention on the safe
95% and depends on them stumbling into the dangerous 5%. Reading order is
chronological, so the worst session is as likely to sit at position 140 as position 1,
and L4.7 says position 140 will not be read. It also does nothing at all about the
97.7% of bytes that are tool output: `已清理` is a word, not evidence, and this
direction renders it as a word.

### At ten times the corpus

**Worst of the three by structure, best by honesty.** The document becomes 1,610
sessions long and the fraction read collapses toward zero, but nothing breaks and
nothing lies: the attestation simply reads `你實際看過:6 個 session 的全文,共 1,610 個`,
and the reader sees exactly how thin that is. Search does not degrade with N at all,
and at ten times the corpus search is doing essentially all of the work.

---

## Recommendation

**Ship Direction A as the screen, graft on Direction C's two mechanisms, and hold
Direction B for slice 2.** A is the only one of the three that answers the question
the product exists for, which is not "is the redaction correct" but "am I willing to
release this", and it answers in the cheapest possible currency: recognition of your
own sentences. B answers a narrower question very well, and its review cost does not
scale with the corpus, which is the right long-term property, but it can complete
without the reader ever seeing one of their own conversations, so shipping it first
would be building the second product before the first. C is less a rival to A than two
missing organs: the **search box**, which F1 makes the only available detector for
names the tool does not know, and the **attestation**, which is what turns clicking
into consent and which the prototype currently reduces to
`alert('原型:開啟 review.md')`. Take both into A. From B take only the ordering rule,
worst-first by cost-of-being-wrong, applied to the session rows; the queue itself, the
near-duplicate clustering and the elusion sample are slice 2, triggered by the first
uploader who is not on the team, exactly as `scope.md` already gates the browser GUI.

Concretely, what survives from the prototype: **the before/after pair renderer**
(`原文 …跟 Marta Alvarez 約禮拜四,Marta 說她下週交… / 送出 …跟 PERSON_03 約禮拜四…`),
promoted from a hardcoded five-item sample into the way every row and every transcript
is drawn; **the pre-dropped session row**
(`✕ 08-14 幫我看一下這個月薪水怎麼算 碰到私密目錄 [其實要送]`), promoted from six
instances behind a link into the entire screen; **every asymmetric-friction control**
and the principle behind it, that the less-exposure direction stays one click while the
more-exposure direction makes you type `send-anyway`; **`擋不住的東西`** and its four
bullets, kept verbatim but moved so each bullet sits adjacent to the claim it qualifies
instead of 800 px away from it; the refusal to guess (`沒有 repo 的我們不猜`); the
recipient paragraph's second half (`你把檔案寄出去之後,這個工具就管不到它了`); and
**the single state table**, which is why this restructuring is cheap, because the data
model is already sound and only the surface is the wrong genre. What dies: the three
balance figures, all three reconciliation paragraphs, the
`1 · 檢查 / 2 · 確認名字 / 3 · 產出` rail, the eight pre-checked candidate boxes as a
separate screen, the four hardcoded pixel-width bars, and every expander wired to an
`alert()`.

---

# Appendix: research lessons, with sources

Four strands were gathered independently: mature redaction-review practice
(e-discovery and FOIA), the empirical literature on consent and comprehension,
data-heavy triage consoles, and progressive disclosure before irreversible actions.
They were gathered separately and agreed with each other, which is why the
recommendation above is stated as plainly as it is.

## A1. E-discovery and FOIA redaction review

**L1.1. The primary screen is a document viewer, not a summary dashboard.**
Relativity, Everlaw, Reveal and DISCO converge on a three-pane layout: a results grid
or queue, the actual document rendered in a viewer in the centre, a coding and
redaction panel on the other side. Nobody's primary screen is a dashboard of aggregate
statistics.
Sources: https://www.everlaw.com/training/workflow/reviewing-documents/ ,
https://help.relativity.com/RelativityOne/Content/Relativity/Relativity_Redact/Redact.htm

**L1.2. Corpus-scale reduction is done by collapsing near-duplicates, not by reading
faster.** Email threading and near-duplicate clustering let a reviewer code one
representative and propagate the decision to the group, cutting review volume by as
much as half in practice.
Sources: https://www.logikcull.com/blog/threading-emails-in-ediscovery-faster-cleaner-review ,
https://www.logikcull.com/blog/never-read-the-same-email-twice-with-thread-detection ,
https://blog.specialcounsel.com/ediscovery/use-email-threading-and-near-duplication-workflows-to-review-less-data/

**L1.3. Automated redactions are an individually actionable queue, not an aggregate
count.** Relativity's Quality Control panel accepts or rejects each flagged markup
entry individually before production.
Source: https://help.relativity.com/RelativityOne/Content/Relativity/Relativity_Redact/Redact.htm

**L1.4. Verify against the produced artifact, not the display layer.** The classic
failure is a mask drawn over content while the underlying data object survives
beneath it. The field's fix is burn-in plus re-extraction: burn the redaction into the
image and re-OCR the result to confirm no residual text returns. For a JSON corpus the
equivalent failure is a field the UI shows as masked while the raw string still sits in
the exported bytes, in a nested field the display never walked into or a duplicate copy
inside tool-call arguments.
Sources: https://api.foia.gov/sites/default/files/2022-10/Everlaw%20Redaction.pdf ,
https://support.everlaw.com/hc/en-us/articles/204813279-Redaction

**L1.5. Validation samples the bucket the system decided was safe.** TAR's elusion test
specifically samples documents set aside as non-responsive and never reviewed by a
human, because that is where a false negative survives unexamined. deident marks
roughly 97.7% of bytes as not sensitive and currently never shows that bucket at all.
Source: https://edrm.net/wp-content/uploads/2019/02/TAR-Guidelines-Final.pdf

**L1.6. There is no magic coverage percentage.** The accepted move is a stated,
risk-weighted statistical basis (commonly a simple random sample at 95% confidence and
2% margin of error, with richness disclosed), not a fixed percentage, and not "read
everything".
Source: https://edrm.net/2024/03/privilege-logs-new-techniques-to-achieve-proportionality-the-certification-log/

**L1.7. The sign-off is a written statement tied to a signer.** Rule 26(g) certifies
that a reasonable inquiry was made; FOIA productions ship with a Bates log and a
transmittal letter stating what is produced, what is withheld, and why.
Sources: https://www.caseiq.com/resources/the-role-of-rule-26g-in-e-discovery ,
https://www.dlapiper.com/en-us/insights/publications/2020/08/rule-26gg-certification-means-more-than-guide-and-advise--key-takeaways

**L1.8. Rubber-stamping is the default failure of large-volume linear review, not an
edge case.** Professionals believed they had achieved roughly 75% recall while actually
achieving about 20% (Blair and Maron, 1985); a later large-scale study found human
review teams agreeing with an authoritative review only 72 to 76% of the time. Humans
systematically overestimate their own thoroughness under exactly this condition, which
is the argument against polishing the dashboard genre at all.
Sources: https://dl.acm.org/doi/10.1145/3166.3197 ,
https://www.logikcull.com/blog/blair-and-maron-must-die

Further sources for this strand:
https://www.logikcull.com/blog/from-request-to-release-building-a-repeatable-foia-response-workflow-for-government-agencies ,
https://www.logikcull.com/blog/what-is-document-review-a-qa-framework-for-privilege-review ,
https://foia.wiki/wiki/Vaughn_Indices

## A2. Consent, comprehension and data donation

**L2.1. A summary of what a system found gets believed, not checked.** In a think-aloud
study of data-donation flows (n=20, across Google, YouTube, Facebook, X, Instagram,
TikTok, LinkedIn), participants interpreted the visualizations as objective
representations of their own platform use even when the data were incomplete or
contradicted their own beliefs, and most misunderstood or overlooked the option to
search through and delete their data before donating. Note: the full text returned HTTP
403, so this summary comes from the publisher's abstract and indexing rather than a
primary-text read.
Source: https://www.tandfonline.com/doi/full/10.1080/1369118X.2025.2540915 (doi
10.1080/1369118X.2025.2540915)

**L2.2. Consent text is skim-read, and that is the normal case.** A systematic review of
data-donation participation found participants skim-reading or misunderstanding the
informed consent, which led to refusals; among those who consented then abandoned
mid-process, 24% cited privacy concerns and 20% feared data misuse.
Source: https://journals.sagepub.com/doi/10.1177/08944393251395958

**L2.3. Compact standardized labels speed lookup and still under-inform.** Usability
studies of Apple's App Privacy label and Google Play's Data Safety section find lay
users misunderstanding the categories, and a 1.1M-app audit finds the underlying
declarations themselves frequently inaccurate or incomplete.
Sources: https://arxiv.org/pdf/2312.03918 , https://arxiv.org/abs/2306.08111 ,
https://dl.acm.org/doi/10.1145/3491101.3519739

**L2.4. Bulk upfront permission requests are not understood; contextual ones are better
and still produce regret when they name a category rather than the instance.** This is
why Android moved from install-time to runtime prompts, and why runtime prompts still
yield regretted grants.
Sources: https://cups.cs.cmu.edu/soups/2012/proceedings/a3_Felt.pdf ,
https://arxiv.org/pdf/1504.03747

**L2.5. Repeated same-shaped widgets destroy attention within days, measurably.**
Simultaneous fMRI and eye-tracking over a five-day workweek showed visual-processing
activity to a repeated warning dropping sharply, with habituation setting in after only
a few exposures and progressing rapidly thereafter.
Sources: https://dl.acm.org/doi/10.25300/MISQ/2018/14124 ,
https://www.researchgate.net/publication/325361021_Tuning_Out_Security_Warnings_A_Longitudinal_Examination_of_Habituation_Through_fMRI_Eye_Tracking_and_Field_Experiments

**L2.6. Active interruption works; passive display does not.** 79% of participants did
not click through a workflow-blocking interstitial warning, versus 13% who heeded a
passive in-page warning that blocked nothing.
Source: https://www.researchgate.net/publication/221514650_You've_Been_Warned_An_Empirical_Study_of_the_Effectiveness_of_Web_Browser_Phishing_Warnings

**L2.7. The EDPB dark-pattern taxonomy read backwards is a design checklist.**
Overloading, skipping, stirring, hindering, fickle, and leaving people in the dark.
57.4% of studied consent notices contained at least one. Usable as a concrete pass/fail
list: is "release everything" visually easier than "exclude this workspace"; is the
exclude control one click or buried; does the same control mean the same thing on every
screen.
Source: https://arxiv.org/pdf/2001.02479

**L2.8. Trust in automated PII detection is warranted only where the human can inspect
and individually approve, reject or edit specific instances.** An aggregate "X items
redacted" count is explicitly insufficient for governance, because detectors both
over-flag and under-flag.
Sources: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10492176/ ,
https://philterd.ai/open-source-software/

Further source for this strand:
https://cups.cs.cmu.edu/soups/2010/proceedings/a1_motiee.pdf

## A3. Data-heavy triage consoles

**L3.1. Never make the person face the raw count; route it through confidence buckets
and make only the low bucket demand individual reading.** Dependabot groups by a CVSS
by EPSS matrix into four action buckets rather than a severity-sorted list; Google
Cloud DLP assigns a coarse likelihood tier; Microsoft Purview assigns a confidence
level per match; Semgrep's AI triage auto-splits into provisionally ignored versus
needs-a-look and reports 95% human agreement with that split.
Sources: https://github.blog/security/application-security/cutting-through-the-noise-how-to-prioritize-dependabot-alerts/ ,
https://docs.cloud.google.com/sensitive-data-protection/docs/concepts-infotypes ,
https://learn.microsoft.com/en-us/purview/sit-sensitive-information-type-learn-about ,
https://semgrep.dev/docs/semgrep-assistant/overview

**L3.2. "Why did this fire" is evidence inside the row, not a second command.** Google
DLP's finding carries the matched quote, infoType and location; Purview explains a
match by its primary element plus its supporting element. deident's
`PERSON_11 confidence: LOW ← check me` currently requires a separate
`deident review --entity PERSON_11` invocation to see the turn text that triggered it.
Sources: https://docs.cloud.google.com/sensitive-data-protection/docs/reference/rest/v2/InspectConfig ,
https://seppala365.cloud/2024/07/21/purview-under-the-hood-sit-confidence-scoring-and-rule-packs/

**L3.3. Group raw signal into one card per real-world entity, keeping the raw count as
a drill-in.** `review.md`'s entity table already does this
(`PERSON_03 ← 3 spellings, 988 occurrences`); its session list does not, showing 3
sessions out of 161 with no stated rule and no screened-versus-surfaced denominator.
Source: https://www.vmray.com/siem-alerts-guide/

**L3.4. Bulk select-all is safe only when the action is reversible.** For a one-way
release the analogue is terraform plan, whose premise is that a misread plan causes an
irreversible change, so the guidance is that every review include the full plan output
and never a summary. Gmail's select-all-and-delete is acceptable only because mail
deletion is cheap to reverse.
Sources: https://developer.hashicorp.com/terraform/cli/commands/plan ,
https://oneuptime.com/blog/post/2026-02-23-how-to-review-terraform-plan-output-in-pull-requests/view ,
https://mailmeteor.com/blog/how-to-select-all-in-gmail

**L3.5. A dismissal captures a reason at the moment it is made.** Both because it is the
audit record a second reader needs, and because writing the reason is itself friction
that catches a wrong call. Snyk requires a reason category and a duration before an
ignore takes effect.
Sources: https://docs.snyk.io/manage-risk/prioritize-issues-for-fixing/ignore-issues ,
https://nhimg.org/glossary/audit-trail-of-decisioning/ ,
https://www.cisdem.com/resource/google-photos-remove-duplicates.html

**L3.6. Order the queue by where judgment is needed, not by discovery order.** Google's
code-review practice treats sequencing as its highest-ROI process change; Semgrep's
group-by-rule default exists so a reviewer clears one mechanical class in a pass instead
of hunting a rare finding through a flat list.
Sources: https://google.github.io/eng-practices/review/developer/small-cls.html ,
https://docs.semgrep.dev/semgrep-code/triage-remediation

**L3.7. Design for several short passes with resumable position, not one sitting.**
Reviewers find five minutes several times far easier than one 30-minute block, and large
reviews are where comments get missed or dropped. A plain text `review.md` supports this
by accident; a one-shot static HTML render does not, which means any browser view must
read decision state back or it is strictly worse than the text file for exactly the
volume problem it exists to solve.
Source: https://google.github.io/eng-practices/review/developer/small-cls.html

**L3.8. The mark-as-done affordance must live where the decision is made, and its state
must be queryable.** GitHub's "Viewed" checkbox sits at the top of a file's diff, forcing
a scroll back up after reading, with no way to jump to the next unreviewed file. A direct
warning for any future GUI layer.
Sources: https://github.com/orgs/community/discussions/5303 ,
https://github.com/orgs/community/discussions/10830 ,
https://github.com/orgs/community/discussions/183812 ,
https://github.blog/changelog/2026-01-22-improved-pull-request-files-changed-page-on-by-default/

**L3.9. Priority scoring as a first-class field.**
Source: https://docs.snyk.io/manage-risk/prioritize-issues-for-fixing/priority-score

## A4. Progressive disclosure before an irreversible action

**L4.1. The itemized list comes first, the aggregate count last.** terraform plan prints
every resource's diff block and only then `Plan: 1 to add, 0 to change, 0 to destroy.`
apt-get remove prints `The following packages will be REMOVED:` with the actual package
names, then the count and disk-space delta, then the yes/no prompt. Neither tool opens
with a number. (The apt behaviour is consistent across every documentation source
checked, but was not re-verified against Debian source.)
Sources: https://spacelift.io/blog/terraform-plan ,
https://developer.hashicorp.com/terraform/cli/commands/plan ,
https://ioflood.com/blog/apt-get-remove/

**L4.2. A dashboard is the wrong genre for a one-time irreversible decision.** Few's own
framing of a dashboard is at-a-glance monitoring of a recurring state. A release review
is read once, carefully, before something that cannot be undone. A dashboard compresses
for a recurring glance; a decision-review artifact expands for a single careful read.
(The PDF's text could not be extracted directly; the argument is reconstructed from
indexed summaries of the standard reference.)
Source: https://www.perceptualedge.com/articles/misc/WhyMostDashboardsFail.pdf

**L4.3. Collapsed content is measurably unread.** A first-click test found 28% clicking a
"Read More" link versus 71% clicking the title or image directly, and NN/g's accordion
research says users cannot scan what is hidden. This is the measured basis for
`cli-ux.md`'s rule that low-confidence entities never share a collapsed row with
high-confidence ones, and for BRIEF F6.
Sources: https://sparkbox.com/foundry/are_read_more_links_necessary_easier_to_use_best_article_listing_layout_first_click_test_usibility_ux_research ,
https://www.nngroup.com/articles/accordions-on-desktop/

**L4.4. Two disclosure levels is a ceiling, not a preference.** "Designs exceeding two
disclosure levels typically have low usability because users often get lost." A category
card, to subcategory counts, to individual item is three levels.
Source: https://www.nngroup.com/articles/progressive-disclosure/

**L4.5. Notice-and-choice structurally cannot deliver comprehension.** Meaningful consent
requires understanding scope and consequence, not merely seeing that a disclosure exists.
A reassuring summary produces the appearance of informed consent unless every reassuring
claim has an inspectable instance behind it on the same screen. deident's export gate
already does this correctly (`known-entity residue 0 occurrences of 47 entities`, with
the denominator beside the zero); the review screen must carry the same discipline.
Source: https://harvardlawreview.org/wp-content/uploads/2013/05/vol126_solove.pdf

**L4.6. Timing is an independent design lever.** A disclosure shown too early is
forgotten by the moment of consequence. This validates the existing three-command
separation: the review is shown again, fresh, immediately before the irreversible
export, and folding review into a combined scan-plus-export flow would destroy work the
timing gap is doing.
Source: https://dl.acm.org/doi/pdf/10.1145/3054926

**L4.7. Serial position.** On a list of 47 entities or 170 sessions, positions roughly 15
to 35 are read least carefully regardless of styling. Applied here by inference from
general list-recall research, not from a study of this task.
Sources: https://en.wikipedia.org/wiki/Serial-position_effect ,
https://www.simplypsychology.org/primacy-recency.html

**L4.8. Frequent interruptive consent asks train habituation, not comprehension.** Over
90% of studied mobile consent dialogs implement at least one dark pattern, and research
on Android runtime permissions found roughly 10% of grants given reluctantly under
hot-state interruption. A direct argument against decomposing the review into a wizard of
per-item confirm dialogs.
Sources: https://www.usenix.org/system/files/usenixsecurity23-koch.pdf ,
https://onlinelibrary.wiley.com/doi/10.1111/joca.70044
