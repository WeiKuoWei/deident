# deident: engineering brief

> **The engineering brief.** This is a design record, not documentation.
> Using the tool needs only `README.md` and `skills/deident/SKILL.md`. It is kept
> because comments throughout `src/` cite its section numbers for the measurement
> behind a decision.

Authoritative handoff for the engineering squad. Everything below is a **decision
already made** or a **finding already verified**. Do not re-litigate; if you
believe one is wrong, say so explicitly in your output with evidence rather than
silently doing something else.

Target repo: . Published under MIT; see LICENSE.

---

## 1. What this is

A CLI that exports a person's AI-coding-agent session logs, de-identifies them,
and produces a zip that is safe to hand to someone else.

Two consumers, in order:

1. **Now (this week).** The 2026-08-19 Mid Sync-up action item: the whole team
   exports recent session logs, filters anything private, zips them, and hands
   them to Nora Lund to re-run the team's AI fluency scoring. Seven people,
   internal, one time.
2. **Later.** Ticket 110 + 114: replace EntireIO with an upload tool that has a
   redaction mechanism, for Fellowship apprentices and eventually enterprise
   users. 110 blocks 114.

The near-term consumer is what ships. The later consumer decides which
abstractions are worth keeping, not which features get built now.

## 2. Non-negotiable constraints

- **It must not throw when Sam runs it.** A traceback on his machine is a
  failed delivery regardless of how correct the logic is. Every path he can
  hit needs a handled error and a useful message.
- **Full git history.** Commit per meaningful step with Conventional Commit
  messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). No squashing.
  **No AI attribution trailers of any kind** (`Co-Authored-By: Claude`,
  `Generated with…`, `Claude-Session:`). Commits are authored by Sam's git
  identity only.
- **Node only, no npm dependencies.** Node v22. Standard library only.
  A dependency is a supply-chain question for a privacy tool; do not open it.
- **Windows first.** Development machine is Windows 11 ARM64, Git Bash
  available. Paths, separators and escaping must be correct there first.
- **No network calls from the tool itself**, ever. It reads local files and
  writes local files. That property is the product.

## 3. Decisions already made

| Question | Decision |
|---|---|
| Pseudonyms reversible? | **Stable salted hash, no plaintext map file.** `pseudonym = hash(salt + entity)`, salt at `~/.deident-private/salt`. Reversal is done by regenerating the local entity list and hashing candidates. A plaintext map is a portable re-identification key for data that has already left the machine; the raw logs are not. Do not write one. **Qualified 2026-08-22:** where two declared entities OVERLAP in the text the substituter replaces the union and emits both tokens, so the token they shared is gone and two different inputs (`the operator Wang`, `the operator Reed Wang`) produce identical output. That collapse is not reversible by the documented path, because the spans that would resolve it exist in memory only. The invariant in §4.7(a) is span-relative and still holds; the export prints the count of merged replacements so the caveat is visible rather than implied. |
| Salt shared across people? | **Per-uploader salt.** Seven teammates uploading to one recipient who also holds the roster is a seven-way guess; a shared salt means cracking one cracks all. AI fluency is scored per person, so cross-uploader entity joins have no consumer. |
| Semantic (LLM) entity discovery | **Mandatory, not optional.** Without it the tool cannot honestly claim safety (see F1 below). If it did not run, **refuse to emit the zip**. |
| Code content | **Never exported.** Replaced by a count. There is no per-workspace "is this client code" question and no UI for it. |
| Session splitting | **Client does not split.** It annotates candidate boundaries as metadata; the platform decides which to honour. Deferred out of slice 1 (see §7). |
| Project grouping | Client captures ground truth (cwd, git remote, branch, timestamps); the platform interprets. Deferred out of slice 1. |
| Review UI | Deferred. Slice 1 has no server and no browser UI. |

## 4. Verified findings that constrain the implementation

Each of these was measured against real Claude Code session logs on this
machine. Treat them as facts, and preserve the evidence in tests.

### 4.1 `toolUseResult` is NOT a duplicate of `tool_result` — do not drop it

For an `Edit`, the `tool_result` content block is prose with **zero** line
information:

```
"The file C:\Users\devuser\projects\...\payroll.md has been updated successfully."
```

while `toolUseResult.structuredPatch` carries `{oldStart, oldLines, newStart,
newLines, lines[]}` with `+`/`-` prefixes. **`structuredPatch` is the only
machine-readable added-line count in the record.**

**Required behaviour:** at export time, compute the added/removed counts from
`structuredPatch`, emit `code_added_lines` as the true **added** count, then
discard the patch body. This preserves scoring and removes the code.

### 4.2 Net line count is not a substitute — measured

511 edits across the 12 largest local session files:

```
true added (+)   9,290
removed (-)      5,338
net              3,952      <- undercounts true added by 57.5%
added>0 but net==0   123 edits (24.1%)
net<0                 40 edits (7.8%)
```

Nearly a third reconstruct as zero or negative. A `<NNNN B, MM lines>`
placeholder on a Write/Edit parameter does **not** carry enough.

### 4.3 `code_added_lines`: `null` and `0` are different, and `0` is dangerous

From `learning-signal-dashboard/lib/fluency/distill.ts:137-139` (repository name
fabricated; the file path under it is what the citation needs):

```ts
failedWithWork:   (s.code_added_lines ?? 0) > 0
abandoned:         s.code_added_lines === 0
unknownTelemetry:  s.code_added_lines === null
```

and `lib/repo/repoSessionLog.ts:107-110`:

```ts
abandoned: code_added_lines === null
  ? null
  : failure_signal >= 3 && outcome === "Failed" && code_added_lines === 0
```

**Emit the true count when known; emit `null` when unknown. Never `0`, never a
reconstructed net.** A wrong `0` manufactures an "abandoned" session and the
existing partition invariant still sums correctly, so no test catches it.

### 4.4 User prompts live in more than `message.content`

There are **16 top-level record types**. At least two carry user text that a
`message`-only reader discards:

- `queue-operation` with a top-level `content` field. Measured: 126 records,
  **42 (33%) appear nowhere else in the log.**
- `attachment` sub-types: `queued_command.prompt` (153), `file.content` +
  `file.filename` (23), `edited_text_file.snippet` (98).

These are exactly the turns where the user supplied the most context, which is
what the Framing axis is scored from. **Enumerate all 16 types and decide each
one deliberately**; do not whitelist by guessing.

Safe to drop: `total_tokens_reminder`, `hook_additional_context`,
`task_reminder`, `output_style`, `snapshot` (`{messageId, timestamp,
trackedFileBackups}`, pure bookkeeping).

### 4.5 Word-boundary `\b` is runtime-dependent and silently leaks

Measured, identical pattern, same inputs:

```
                        Python \b   Node \b   lookaround
因為Dean他想要 / Dean      MISS       HIT        HIT
Ivy跟小語 / Ivy            MISS       HIT        HIT
林先生 / 林                MISS       MISS       HIT
array index / ray         MISS       MISS       MISS   <- correct non-match
```

The four names are fabricated. What each row has to carry is its shape, and
losing the shape loses the row: `Dean` is a Latin name with CJK on the leading
side, `Ivy` is a Latin name with CJK on the trailing side, `林` is a
single-character CJK entity sitting inside a longer CJK word, and `ray` is a
three-character name embedded in a longer Latin word.

`/\w/` matches CJK in Python and not in JS. `\b` can never match a pure-CJK
entity in either runtime.

**Use `(?<![A-Za-z0-9_])X(?![A-Za-z0-9_])`, never `\b`.** For CJK entities
require length >= 2 and flag them for review, because the lookaround does not
prevent over-matching inside a longer CJK word. The length rule shipped and the
flag did not, so `小明` matched inside `小明天` and corrupted a sentence naming
nobody with every gate green. Each CJK occurrence is counted, and the count is in
the manifest. Both cases go in the self-check
with `因為Dean他` and `林先生` as fixtures.

**Correction, measured 2026-08-22 over a real export.** `_` in that character
class is wrong, and the cost is not marginal: 870 known-entity occurrences were
classified "embedded" and shipped verbatim while the gate read `known-entity
residue 0 ok`. They were `mcp__playwright-headless__browser_navigate` and every
other MCP server name in the corpus (the log form is always `mcp__NAME__tool`,
so the §F4 MCP entity class had a 100% miss rate and was inert by
construction), `project_northwind_site_migration.md`, `dm-vance-cpa`,
`KestrelisAI` x187 and `MeetingNora和Ivan` x8. Row 4 above justifies not
FAILING on `ray` inside `array`; it does not justify one bucket for both.

The rule is therefore: `_` is a token boundary for a spelling of five
characters or more, and a camel-case hump is a token boundary always, because
`MeetingNora` is two words in any reading. `ray` inside `array` is untouched
by either exception — three characters, starts lowercase — so row 4 still
holds. Fixture F50 pins both directions.

**Second correction, same measurement.** "case-variant only 7" understated the
case, because the variant table generated case variants only for a path's drive
letter. The org entity is seeded from the git remote `northwind-co/ledger`, the
company writes itself `Northwind`, and `Northwind` survived **1,804 times** in a
real export with the scan unaware it existed. Enumerating lower/UPPER/Title does
not help: `NorthWind` is none of them. Spellings of four characters or more are
matched case-insensitively, and the span records the text that was actually
there so reversal stays exact. Fixture F51.

### 4.6 Substitution must be structured, longest-match, single-pass

- `JSON.parse` -> `JSON.stringify` round-trips these logs byte-identically:
  **27,545 / 27,545 lines**, including 1,206 non-BMP strings. So parse the line,
  substitute inside decoded strings, re-serialize. Assert this per line at
  runtime and abort loudly if a future writer changes format.
- Path forms found **in already-decoded strings**: `C:\Users\devuser` 26,505;
  `C:/Users/devuser` 1,838; `/c/Users/devuser` 306; still-doubled
  `C:\\Users\\devuser` inside embedded JSON 94; case-variant only 7. Also present:
  URL-encoded (`%3Ddevuser%40northwind.example`) and `\uXXXX`-escaped CJK inside
  embedded JSON.
- Real prefix collisions in the seed set: `northwind` is a prefix of
  `northwind-agentic`; `devuser` is a prefix of `devuser` and `devuser@northwind.example`
  (4,511 substring occurrences in a 40-file sample).

**Sort entities by decoded length descending, single left-to-right scan with an
already-replaced interval mask, never re-scan a replaced region.** Sequential
`String.replaceAll` per entity is order-dependent and can re-match its own
output.

### 4.7 The round-trip test as originally stated cannot pass — split it

Retention drops most bytes, so byte-equality against the original file is false
by construction. Two separate invariants:

- **(a) Substitution invariant.** At the string level, before serialization, for
  every retained string `s`: `reverse(substitute(s)) === s`. This is the one that
  catches ordering, overlap and collision bugs. It is **span-relative**: it
  reverses using the spans the pass produced, and §3 forbids persisting those, so
  a green result is not a claim that the documented reversal path can undo an
  absorbed overlap. Say so in the report, and count the merges.
- **(b) Serialization invariant.** Per line, `stringify(parse(line)) === line`
  on the untouched input. Abort if it ever fails.
- **(c) Namespace collision check.** Reversal is ambiguous if the log already
  contains a token matching the pseudonym pattern. Currently 0 pre-existing
  `(PERSON|WORKSPACE|ORG|CLIENT)_\d+` in the sample, but scan and abort (or shift
  the namespace) on a hit.

### 4.8 `cwd` is not on every line, and one file spans many cwds

Measured on the largest session file (5,259 lines):

```
3,501 lines (67%) carry cwd. Absent on: last-prompt, bridge-session, mode,
permission-mode, ai-title, queue-operation, file-history-snapshot/-delta.

11 distinct cwd values in ONE file:
  1257  C:\Users\devuser\projects\ops-handover\private   <- payroll
   828  C:\Users\devuser\projects\ops-handover
   622  C:\Users\devuser
   307  C:\Users\devuser\Projects\ops-handover           <- case variant
```

The directory slug reflects the **launch** directory only; the agent `cd`s
mid-session. So directory-level opt-in is **not sufficient** — filter on the
per-line `cwd` value as well.

### 4.9 The slug is not reversible and not guaranteed path-derived

`:`, `\`, `/` and `.` all collapse to `-`. Observed collisions:
`C--Users-devuser--claude-skills` could be `.claude\skills` or `-claude-skills`;
`...-note-vault-src` is ambiguous (the name is fabricated; the shape is a
hyphenated basename with a further segment after it, which is what makes the
`-` unreadable); case is preserved so `projects` and
`Projects` are two directories for one Windows path.

Storage root is overridable by `CLAUDE_CONFIG_DIR` (official). Since Claude Code
v2.1.234, `CLAUDE_CODE_PROJECT_DIR_NAME` (set together with `CLAUDE_CONFIG_DIR`)
chooses the `projects/` subdirectory name outright, so the slug need not be
path-derived at all.

**Resolve the root from the environment. Read `cwd` from the record. Never parse
the slug.**

### 4.10 Most of the corpus is not human sessions

```
depth 0:   225 files   817.6 MB   <- human sessions
depth 2:   138 files    60.8 MB   <- <uuid>/subagents/
depth 4:  3863 files   931.1 MB   <- <uuid>/subagents/workflows/wf_*/agent-*.jsonl
```

A naive recursive glob ships 2.2x the payload, and the extra half contains zero
human turns. **Slice 1 reads depth-0 only.** Orchestration remains visible via
the parent session's `Agent`/`Workflow` `tool_use` blocks.

Byte composition, depth-0 human sessions only: `text` **2.30%**. The rest is
tool output, images and harness bookkeeping.

### 4.11 Private material sits in the same directory

```
C--Users-devuser-Projects-private-archive                          4 files   42 MB
C--Users-devuser--identity-private                           0 files
C--Users-devuser-projects-ops-handover-private-payroll   0 files
```

`private-archive` is a personal couples-counselling chat archive. Any "export recent
sessions" default sweeps it in.

**Per-directory opt-in, never opt-out.** Additionally, a seed deny-list: a
directory name or a per-line `cwd` containing `private`, `identity`, `payroll`,
a person's own added token is excluded by default and requires a typed confirmation to include.

## 5. Security findings that change the product, not just the code

### F1 — the residual scan proves less than its label claims

The residual scan searches for **known** entities. A third-party name that the
seed sources never knew about and the semantic pass missed is, by construction,
undetectable by it. Measured: 230 distinct emails across a 90-file sample, **228
of them not the user** (`legal@kestrelis.ai`, `norbrookvanceadvisory.com`,
`northsky-hr.com`, `ledgerpost.com`, `ironvale.com`). Emails have a regex. **Names do not.**

Required:
- The indicator must read **`known-entity residue: 0`**, never a bare green
  "safe" or "0 leaks".
- If the semantic pass did not run, **refuse to emit the zip**. Graceful
  degradation here is silent failure.

### F2 — third parties never consented

The consent model is "the individual chooses what to upload", but what the
individual is choosing about is **other people's** identities: company counsel,
outside lawyers, HR vendors, clients. Scoring AI fluency does not need any of
them.

**Third-party entities are force-replaced with no opt-out checkbox.** Only the
uploader's own pseudonym is optional. This is one fewer UI control, not one more.

### F3 — bare username outside any path

`devuser` distribution in a 25-file sample: 4,520 inside paths, 130 in emails, 28
in GitHub handles, **296 bare** — the owner column of `ls -l` output:

```
-rw-r--r-- 1 devuser 197609    929 ...
```

Longest-prefix path substitution never fires on these. `197609` is a stable
Windows UID and is itself an identifier. The substitution invariant does not
catch this class, because it verifies that what *was* replaced reverses, not
that everything that *should* be replaced was.

**The username is its own entity, and a chunk of `ls -l` output is a required
test fixture.**

### F4 — device fingerprint survives entirely

Present verbatim and not covered by any entity rule: the MCP server set, the
model mix (`claude-opus-5` 4653 / `claude-fable-5` 631 / `claude-opus-4-8` 527),
the Claude Code version sequence (2.1.215 -> 2.1.238), millisecond timestamps,
localhost ports.

**Quantise timestamps to the minute. Add MCP server names to the entity list.**
Leave the version sequence; the cost is not worth it. Document that this class
exists rather than implying it is solved.

MCP server names were added to the entity list and then never matched, because
of the `_` boundary bug corrected in §4.5 — while the "NOT protected against"
block went on listing them as unprotected. A disclosure that hides an
implemented-but-inert control is worse than either honest option. Both are
fixed: the names are replaced, and the block now names only what actually
survives (localhost ports, the model mix, the CLI version sequence).

### F5 — account UUIDs match no detector

```json
{"type":"bridge-session","bridgeSessionId":"cse_01HZQK4M...",
 "ownerAccountUuid":"bbbbbbbb-...","ownerOrganizationUuid":"cccccccc-..."}
```

The three ids are fabricated. What each has to carry is its shape: `cse_01…` is
a prefixed ULID, and the other two are bare v4 uuids sitting on a record type
with no other content.

Not path-shaped, not name-shaped, not high-entropy-secret-shaped. **Drop the
record type, and seed the residual scan with "any UUID that is not a known
message or session uuid".**

### F6 — collapsed review categories are the categories nobody opens

A `names 12 items [expand]` row is a button that never gets expanded. When a
review surface exists, high-confidence and low-confidence candidates must not
share a list; low-confidence is per-item or it blocks the export. Not slice 1,
but do not design the surface the other way and inherit the problem.

### F6b — credentials and phone numbers are entity classes, measured

Added 2026-08-22, after a real export shipped a **93-character GitHub
fine-grained PAT** twice in plain text, at full length, with no `secrets`
counter and no `secrets` line in the manifest — while `docs/cli-ux.md` §6 shows
`0 secrets   8 replaced` as part of the contract. Silently omitting the line
while shipping a live token is the worst of the available options.

Same export: at least 10 distinct E.164 phone numbers, 40+ occurrences, the
uploader's and third parties' personal mobiles, in no entity class and named in
no "NOT protected against" line — so a reader of the manifest had no way to know
they were in the file.

Both are implemented as force-replaced entity classes, and both are exactly the
precision profile §F7 asks for. Credentials are matched only on unambiguous
vendor prefixes (`github_pat_`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `sk-ant-`,
`xoxb-`, `AKIA`, `ntn_`, `AIza`); an entropy heuristic would fire on every hash
and uuid in the corpus. Phone numbers require a leading `+`, a country code and
8-15 digits, which does not fire on version numbers, part numbers or
timestamps.

The stable Windows owner id §F3 already calls "itself an identifier" is seeded
the same way, from the column beside the username in `ls -l` output. It had
survived 786 times, in the exact shape fixture F05 exists to guard.

### F7 — false positives kill the scan

A passport-shaped regex matched `M1019757`, a Microsoft thermal-paste part
number. A scan that cries wolf is the first thing switched off. **Tune for
precision, not recall.**

## 6. Open questions — blocked on someone else

Four of six scoring axes and both hero tiles depend on rules that are not in any
local repo. The dashboard consumes a `SessionLog` produced by two upstream runs,
`ai-log-expertise` and `ai-log-csv-quality`; neither implementation nor prompt
is available here.

Unresolved, do not guess:

1. What `success_signal` and `failure_signal` are counted from. If truncating
   `tool_result` reduces `failure_signal` below 3, `hits_trouble` becomes false,
   Resilience goes null, and **OVR rises** — the tool would silently inflate
   scores. Measured: an 800+400 byte cap destroys 98.7% of `tool_result` bytes;
   23.9% of blocks exceed 1200 B; `is_error` is a block-level flag and survives.
2. Whether the prompt-quality run reads only user messages.
3. The definition of a "decision point" (the floor that excludes sessions from
   Framing / Precision / Rigor).
4. Whether the Expertise classifier reads code content.

**Implementation posture until these are answered:** prefer preserving evidence
over shrinking bytes wherever the two conflict, and make every truncation
threshold a named constant in one file so it can be changed without a rewrite.

Separately, and not this tool's bug to fix: `verdict.ts:47-52` computes OVR as a
straight mean over axes that have a reading, skipping nulls. On the shipped demo
record a prose-only user scores **68** against an equally skilled harness user's
**63**, and a Mid-level user at 58 becomes Senior at 64 if trouble detection is
suppressed. Flag it upstream; do not work around it here.

## 7. Slice plan

**The CLI surface is part of slice 1 and is specified in
`docs/cli-ux.md`. Read it before writing the entry point and build to it.** The
tool's job is to make an engineer willing to hand over their session logs, and
that willingness is produced by the interface, not by the substitution
algorithm. In particular: three commands where the first two write nothing
dangerous; `review.md` is both the report and the config, edited as text;
low-confidence entities are listed individually and never collapsed; the export
gate prints a "leaving this machine" manifest and a "not protected against"
block; the residue line says `known-entity residue`, never "safe"; every refusal
names its reason and its remedy; any non-zero exit leaves no output file behind.

`docs/privacy-tiers.md` describes the four workspace tiers (`exclude` /
`count-only` / `redact` / `open`) and is **slice 2**. Slice 1 implements the hook
it plugs into: per-directory opt-in, the deny-list, and per-line `cwd` filtering.
Slice 1 may treat every included workspace as `redact`.

Vertical slices, each independently verifiable, each its own commit series.

**Slice 1 — the substitution core.** One CLI entry point, depth-0 sessions only,
no server, no browser UI.

1. Resolve the storage root from the environment.
2. Per-directory opt-in plus the deny-list; also filter on per-line `cwd`.
3. Seed entities: OS username (bare, not only in paths), `git config user.name`
   / `user.email`, project directory names, git remotes, MCP server names.
4. Expand each root into its escaping variants; longest-match single-pass
   substitution with an interval mask; salted-hash pseudonyms.
5. Retention: enumerate all 16 record types deliberately; compute
   `code_added_lines` from `structuredPatch` then discard the patch body; keep
   the three user-bearing `attachment` sub-types; keep `is_error`; quantise
   timestamps.
6. Verification: substitution invariant, serialization invariant, namespace
   collision check, residual scan. **Any failure aborts before any output file
   is written.**
7. `--preview` writes a diff to a file for inspection in the user's own editor;
   otherwise write the zip.
8. One `--selftest` with assert-based fixtures covering, at minimum: `因為Dean他`,
   `林先生`, `array`/`ray` non-match, an `ls -l` line, a prefix-collision pair, an
   `Edit` record whose net line count is 0 but whose added count is not.

Test data is Sam's own real mixed zh/en sessions, not synthetic fixtures.

**Slice 2 and beyond — do not build until triggered.**

| Deferred | Trigger |
|---|---|
| Browser review UI | the first uploader who is not on the team |
| Plaintext reversible map | an uploader who does not retain the original files |
| `boundary_signals` annotation | Nora reports a real granularity failure with an example |
| manifest + merge script | the platform has merge logic that consumes it |
| Any non-Claude-Code adapter | see §8 |
| subagent/workflow tree | Nora asks for orchestration evidence and says the parent session's tool_use records are insufficient |

## 8. Adapter research — do this from vendor sources, not from this machine

**This machine is not evidence about other products.** Cursor here has four
empty draft conversations and was never really used; Codex is installed and
authed but has zero threads and zero rollouts; Antigravity was downloaded on
2026-07-07 and never installed. Conclusions such as "Cursor does not store
message text locally" are conclusions about an unused install, not about Cursor.

Establish each format from the vendor's own source or documentation, and where
neither exists, say so and stop rather than building a parser from blog posts.

Known so far:

- **Codex** — open source. `codex-rs/rollout/src/lib.rs` defines
  `SESSIONS_SUBDIR = "sessions"`; `codex-rs/rollout/src/list.rs` documents
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
  `codex-rs/protocol/src/items.rs` carries `CommandExecutionItem{command,
  aggregated_output, exit_code, duration}`. Newer builds add a
  `~/.codex/state_5.sqlite` `threads` index with `cwd`, `git_sha`, `git_branch`,
  `git_origin_url`, `rollout_path`. Codex is the **only** source observed to
  carry a git remote. `CODEX_HOME` overrides the root; `--ephemeral` suppresses
  rollout files.
- **Antigravity** — `~/.gemini/antigravity-cli/cache/last_conversations.json`
  maps absolute workspace paths to conversation ids (official). So storage is
  flat and cwd scoping is a separate index; both statements are true. **The
  on-disk transcript format is not documented by the vendor** and third-party
  claims (`.pb` protobuf vs per-conversation SQLite vs JSONL) contradict each
  other. Unresolved.
- **Cursor** — closed source. Nothing established.
- **ChatGPT export** — the export flow is documented
  (Settings > Data Controls > Export Data). The internal structure of
  `conversations.json` is **not** published by OpenAI; the message-tree claim is
  third-party only.
- **Gemini Takeout** — the My Activity JSON schema is documented, but that page
  **does not mention Gemini at all**. The "My Activity > Gemini Apps" path is
  third-party only.

Capability floor, which decides whether an adapter is worth writing at all:
outcome-based scoring (Execution, Resilience) needs tool calls **and** tool
results. Only Claude Code and Codex are known to carry both. ChatGPT and Gemini
exports carry prose and timestamps only, so they can support Framing / Precision
/ Rigor and nothing outcome-based.

## 9. Definition of done

- `node deident.mjs --selftest` passes.
- `node deident.mjs --preview` runs to completion on Sam's real corpus with no
  unhandled exception.
- A full export produces a zip, and the residual scan reports zero known-entity
  residue.
- Deliberately corrupted input (truncated JSONL line, unknown record type,
  missing `cwd`, empty file, a file with a pre-existing `PERSON_1` token) each
  produce a handled error with a clear message, not a stack trace.
- README states plainly what the tool does **not** protect against: §F4
  fingerprinting, §F6 verbatim quoted documents, and the §6 open questions.
