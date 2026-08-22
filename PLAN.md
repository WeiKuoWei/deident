# deident — Slice 1 implementation plan

Derived from `BRIEF.md`. Where this plan differs from BRIEF, §0 says so explicitly with
the measurement behind it. Everything else in BRIEF is treated as settled.

Node v22, ESM (`.mjs`), standard library only, no network, Windows first.

---

## 0. Corrections and additions to BRIEF, with evidence

Re-measured on **the full depth-0 corpus, 2026-08-22**: `~/.claude/projects/*/*.jsonl`,
**225 files, 134,758 records, 0 unparseable lines**. Measurement script was a throwaway in
the session scratchpad, not committed. Nothing below reproduces log content beyond field
names and counts.

**C1 — §4.4 says "16 top-level record types". There are 19.**
Measured: `assistant` 42,969 · `user` 25,798 · `attachment` 18,671 · `last-prompt` 7,315 ·
`mode` 7,141 · `permission-mode` 6,862 · `bridge-session` 6,763 · `ai-title` 6,753 ·
`system` 5,546 · `file-history-snapshot` 2,141 · `queue-operation` 2,025 ·
`file-history-delta` 1,090 · `atis-latch` 897 · `agent-name` 420 · `agent-setting` 143 ·
`frame-link` 110 · `pr-link` 50 · `relocated` 32 · `worktree-state` 32.

Separately, §4.4's "safe to drop" list names things at **two different levels**:
`total_tokens_reminder`, `hook_additional_context`, `task_reminder` and `output_style` are
`attachment` **sub-types** (26 distinct sub-types exist), and `snapshot`
`{messageId, timestamp, trackedFileBackups}` is the **inner object** of the top-level
`file-history-snapshot`. Every drop decision in that list is correct; the enumeration is
just bigger than 16 and lives at two levels. §3 enumerates both.

**C2 — §4.4's `queue-operation` measurement understates the case.**
BRIEF: 126 records, 42 (33%) appearing nowhere else. Full depth-0: **2,025 records, 1,486
carrying `content`, of which 1,044 (70.3%)** do not appear in any `user` message or
`attachment` in the same file (120-character prefix match). Decision unchanged, evidence
stronger.

**C3 — `last-prompt` is a fourth user-bearing type and BRIEF does not list it as one.**
§4.8 mentions `last-prompt` only as a type that lacks `cwd`. Measured: **6,939 records
carry non-empty `lastPrompt`, of which 2,236 (32.2%)** do not appear in any `user` message
or `attachment` in the same file. Same class as `queue-operation`, same treatment. Some of
it overlaps `queue-operation` content, so dedupe at export; do not drop the type.

**C4 — §4.7(c) "currently 0 pre-existing `(PERSON|WORKSPACE|ORG|CLIENT)_(digits)`" is no
longer true, and how it became untrue is the point.**
Measured today: **23 matching lines, all 23 in one file** — the log of the Claude Code
session in which deident itself is being built, where the pattern appears inside quoted
BRIEF and cli-ux text. The namespace collision check is therefore not a theoretical guard.
It fires deterministically for **any uploader who has ever discussed this tool in a
session**, which will include all seven teammates the moment they read the README.
**Consequence: the namespace-shift remedy must ship in slice 1, not be deferred.** An
abort-only implementation cannot export the corpus of the people building it.

**C5 — §4.6's serialization round-trip confirmed at full scale.**
`stringify(parse(line)) === line` holds on **134,758 / 134,758** depth-0 lines, non-BMP
included. Keep the per-line runtime assertion anyway; §4.6 already requires it.

**C6 — `toolUseResult` is not always an object.** 20,569 object-valued, **1,303
string-valued**, 3,191 carrying `structuredPatch`. A `typeof` guard is required before any
field access, and the string form must not be mistaken for "no result".

**C7 — §4.10 confirmed.** 225 depth-0 files, matching BRIEF exactly. No drift.

---

## 1. Module breakdown

One responsibility per file. Every function returns new objects; no input is mutated. Line
counts are targets; 800 is the hard ceiling.

### Entry and CLI

| File | Lines | Public function | Responsibility |
|---|---:|---|---|
| `deident.mjs` | ~140 | `main(argv, env)` | The only entry point. Dispatch to `scan` / `review` / `export` / `--selftest`, own the process exit code, and be the single `try/catch` that turns any escaped error into a §6.4-shaped message. Contains no logic of its own. |
| `src/cli/args.mjs` | ~110 | `parseArgs(argv)` | Wrap `node:util.parseArgs` with the flag table, reject unknown flags and illegal combinations, return a frozen options object or a `UsageError`. |
| `src/cli/report.mjs` | ~320 | `renderScan`, `renderChecks`, `renderManifest`, `renderRefusal`, `renderReadError` | Every byte the tool prints. Words not colour, `known-entity residue` not "safe", the "NOT protected against" block. Wording is a security control (cli-ux §7), so it lives in one greppable file. |
| `src/cli/errors.mjs` | ~90 | `DeidentError`, `UsageError`, `ReadError`, `RefusalError` | Typed errors carrying `{code, reason, remedy, file?, line?}`. The exit code is a property of the error, never a call-site decision. |

### Corpus

| File | Lines | Public function | Responsibility |
|---|---:|---|---|
| `src/corpus/root.mjs` | ~130 | `resolveCorpus(env)` | Resolve the storage root from `CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_PROJECT_DIR_NAME`, else `~/.claude`. Enumerate `projects/*/*.jsonl` at **depth 0 only** (§4.10). Never parses a slug (§4.9). Returns `{root, workspaceDirs[], files[]}`. |
| `src/corpus/reader.mjs` | ~220 | `readSession(path)` | Read one file, split lines, `JSON.parse` each, assert `stringify(parse(line)) === line` per line (§4.6). Returns `{records[], badLines[], bytes}`. A bad line becomes a `ReadError` naming file and line number, never an escaping `SyntaxError`. |
| `src/corpus/cwdtrack.mjs` | ~160 | `resolveLineCwd(records)` | The effective `cwd` per record index. Carries the previous known value forward across the 33% of lines that have none (§4.8), and applies `relocated.relocatedCwd` and `worktree-state.worktreePath` as cwd changes before those two types are dropped. |

### Policy — what is allowed to be exported at all

| File | Lines | Public function | Responsibility |
|---|---:|---|---|
| `src/policy/grouping.mjs` | ~130 | `groupSessions(sessions)` | A workspace is the directory a session actually worked in: the dominant per-line `cwd`, not the storage slug it was launched from (§4.9). Names each group from its own path and keeps the resolved `cwd` for the review row. |
| `src/policy/signals.mjs` | ~90 | `proposeTier(group, probe)` | The privacy-tiers §3 proposal: deny-list to `exclude`, a git remote to `redact`, no remote to `exclude`. `open` is never proposed, because repository visibility is not on disk and BRIEF §2 forbids the call that would answer it. |
| `src/policy/workspaces.mjs` | ~260 | `classifyWorkspaces(groups, saved, opts)` | Assign each workspace a tier: deny-list first, then a saved decision from `~/.deident-private/workspaces.json`, then the proposal. `unclassified` is the residue for a workspace with no readable signal, never the default. Opt-in only, never opt-out (§4.11). |
| `src/policy/linefilter.mjs` | ~140 | `allowLine(cwd, policy)` | The per-line gate. A record is resolved to its **most specific** workspace by longest path prefix and takes that workspace's tier, so it is dropped **even inside an included workspace** (§4.8: 11 cwds in one file, one of them `\private`). Longest-first matters: the excluded home directory prefixes every workspace on the machine. |
| `src/policy/reviewfile.mjs` | ~300 | `renderReview(model)`, `parseReview(text)` | `review.md` is both report and config, so the two directions round-trip. Low-confidence entities are individual rows and are never collapsed into a count (§F6). |

### Entities

| File | Lines | Public function | Responsibility |
|---|---:|---|---|
| `src/entities/seed.mjs` | ~250 | `seedEntities(env, corpus)` | Tier-0 sources: OS username **as a bare token, not only inside paths** (§F3), `git config user.name` / `user.email` via `execFileSync` (failure non-fatal and reported), workspace directory names, git remotes, MCP server names (§F4). Returns `{kind, spellings[], source, confidence}`. |
| `src/entities/variants.mjs` | ~220 | `expandVariants(spelling)` | Expand one spelling into every form observed **in already-decoded strings** (§4.6): `C:\`, `C:/`, `/c/`, still-doubled `C:\\`, case variants, URL-encoded (`%40`, `%3D`), and backslash-u-escaped CJK. Pure, no I/O, exhaustively self-tested. |
| `src/entities/pseudonym.mjs` | ~150 | `loadOrCreateSalt(dir)`, `pseudonymFor(entity, salt, namespace)` | `sha256(salt + kind + canonical)` truncated to a stable index. Salt at `~/.deident-private/salt`, created 0600, never written into any output. Applies the C4 namespace prefix. No plaintext map, ever (§3). |

### Substitution

| File | Lines | Public function | Responsibility |
|---|---:|---|---|
| `src/substitute/engine.mjs` | ~280 | `buildTable(entities)`, `substituteString(s, table)`, `reverseString(s, table)` | The algorithm. Sort by decoded length descending, one left-to-right scan, an interval mask, and never re-scan a replaced region (§4.6). Boundary rule `(?<![A-Za-z0-9_])X(?![A-Za-z0-9_])`, **never `\b`** (§4.5); CJK spellings need length >= 2 and are flagged low-confidence. `reverseString` lives here because it must share the table — a reversal defined elsewhere drifts from the substituter it is meant to invert. |
| `src/substitute/walker.mjs` | ~180 | `substituteRecord(rec, table)` | Walk a parsed record immutably, applying `substituteString` to every retained string value **and to object keys that can carry a path**. Returns `{record, spans[]}`; `spans` feeds the substitution invariant. |

### Retention

| File | Lines | Public function | Responsibility |
|---|---:|---|---|
| `src/retain/constants.mjs` | ~70 | (named exports) | Every threshold, cap and toggle in one file, per §6's posture: `TOOL_RESULT_HEAD_BYTES`, `TOOL_RESULT_TAIL_BYTES`, `KEEP_THINKING_BLOCKS`, `TIMESTAMP_QUANTUM_MS`. No literal number appears anywhere else in the codebase. |
| `src/retain/records.mjs` | ~340 | `retainRecord(rec, ctx)` | The §3 table as code: a field projection per top-level type and per `attachment` sub-type. An **unknown type is a refusal, not a silent drop** — that is the entire point of §4.4. Quantises timestamps to the minute (§F4). |
| `src/retain/toolresult.mjs` | ~230 | `distillToolResult(rec)` | §4.1 / §4.2 / §4.3. Type-guard the string form (C6), compute added and removed counts from `structuredPatch`, emit `code_added_lines` as the **true added count** and `null` when unknown, **never `0`** for "could not tell". Then discard the patch body. Preserve `is_error` (§6 open question 1). |

### Verification and output

| File | Lines | Public function | Responsibility |
|---|---:|---|---|
| `src/verify/checks.mjs` | ~300 | `runAllChecks(state)` | The four gates: substitution invariant, serialization invariant, namespace collision, residual scan. Returns a report; **writes nothing, repairs nothing**. Any failure becomes a `RefusalError`. |
| `src/verify/residual.mjs` | ~200 | `residualScan(bytes, entities)` | Scan the **final serialized bytes** for every entity spelling and variant, plus "any UUID that is not a known message or session uuid" (§F5). Reports `known-entity residue: N`, never "safe". Tuned for precision (§F7) — no passport-shaped or generic-ID regexes. |
| `src/output/zip.mjs` | ~260 | `writeZip(entries, outPath)` | Minimal ZIP writer over `node:zlib.deflateRawSync`: local headers, central directory, EOCD, UTF-8 name flag, fixed DOS timestamp so cli-ux §11 idempotence holds. Writes `outPath + '.part'`, then renames; the `.part` is unlinked on any throw. |
| `src/output/preview.mjs` | ~170 | `writePreview(state, outPath)` | `--preview`: a plain-text before/after diff over a sample of every replacement class, for the user's own editor, with the same "leaving this machine" accounting as a real export. |
| `src/selftest.mjs` | ~340 | `selftest()` | The `--selftest` fixture suite (§5). Plain `node:assert`, no framework, no fixture files outside `test/fixtures/`. |

**22 files.** No interface with one implementation, no factory, no config for a value that
never changes. Each file is a distinct algorithm, a distinct I/O boundary, or the wording
surface.

---

## 2. The pipeline, and why this is the only correct order

`state` is threaded through as a frozen object; each step returns a new one.

```
 1  resolveCorpus            corpus/root.mjs
 2  readSession (per file)   corpus/reader.mjs      + serialization invariant, per line
 3  namespace collision      verify/checks.mjs      BEFORE any pseudonym is minted
 4  resolveLineCwd           corpus/cwdtrack.mjs    consumes relocated / worktree-state
 5  groupSessions +          policy/grouping.mjs    + policy/signals.mjs,
    classifyWorkspaces       policy/workspaces.mjs    then review.md round-trip
 6  allowLine                policy/linefilter.mjs  per-line cwd gate
 7  retainRecord             retain/records.mjs     + distillToolResult + timestamp quantise
 8  seedEntities             entities/seed.mjs      + expandVariants
 9  buildTable + pseudonyms  substitute/engine.mjs, entities/pseudonym.mjs
10  tier-0 substitution      substitute/walker.mjs  -> cleaned records
11  tier-1 semantic discovery                       INPUT: the cleaned text from step 10
12  tier-1 substitution      substitute/walker.mjs  INPUT: the same cleaned records, step 10
13  substitution invariant   verify/checks.mjs      string level, before serialization
14  serialize                                       records -> output bytes
15  residualScan             verify/residual.mjs    on the bytes from step 14
16  renderManifest           cli/report.mjs
17  writeZip                 output/zip.mjs         only if 3, 13 and 15 all passed
```

### Why each step cannot move

**Serialization invariant (2) is first, on untouched input.** §4.7(b) says "on the
untouched input" for a reason: once one string has been substituted, the check is testing
our serializer against our own output and can only pass. Its job is to detect a *future
Claude Code writer* whose format we fail to round-trip. Run it late and it detects nothing.

**Namespace collision (3) must precede pseudonym minting (9), not merely precede the zip.**
BRIEF lists it among the invariants without fixing its position. Run it after minting and
the tool has already assigned `PERSON_3` into a corpus that already contained `PERSON_3`;
from that moment the residual scan cannot tell the two apart and reversal is permanently
ambiguous. Run it first and the remedy — shift the namespace — is free. Per C4 this check
fires on the real corpus today, so this ordering is load-bearing, not hypothetical.

**cwd resolution (4) must precede retention (7), because retention drops the records that
carry the cwd changes.** `relocated` and `worktree-state` are DROP records that are also
the only evidence the effective directory moved. Drop them first and the per-line filter
(6) evaluates the wrong directory for every line after the move — which, given §4.11 and
the measured `...\ops-handover\private` cwd inside an otherwise ordinary workspace,
means exporting payroll material from an included workspace. This is the
highest-consequence ordering constraint in the pipeline.

**Retention (7) must precede substitution (10).** Three independent reasons:

1. **Code must never be substituted-and-kept.** `structuredPatch.lines[]` is code. If
   substitution ran first, pseudonymised code bodies exist in memory and in any
   intermediate state, and the only thing between them and the zip is a later step a bug
   could skip. Retention-first means the code is gone before an output path exists at all.
2. **Entity discovery would be polluted.** Running tier-1 over unretained text hands the
   semantic pass ~97.7% harness bookkeeping (§4.10: `text` is 2.30% of bytes). Every false
   entity invented there is then force-applied to the kept text — §F7's "a scan that cries
   wolf", arriving through the discovery pass instead of the residual pass.
3. **The invariant surface would be needlessly enormous.** The substitution invariant (13)
   must verify reversibility for every retained string. Retaining first shrinks that set by
   more than an order of magnitude and makes a failure legible instead of a needle hunt.

**Seeding (8) must precede substitution (10) and must read pre-substitution values.** Seeds
derive from workspace directory names, git remotes and per-line `cwd`. Run seeding after
substitution and those values are already pseudonyms: seeding becomes a no-op, the entity
table is empty, and the tool exports the corpus while reporting a triumphant
`known-entity residue: 0`. That is exactly the failure §F1 warns about, produced by an
ordering mistake rather than a missing feature.

Seeding may run before or after retention with no correctness difference for the
environment- and git-sourced entities. It is placed after retention so the workspace names
it seeds are exactly the ones being exported, and so a workspace excluded at step 5 does
not contribute an entity that appears nowhere and pads the review.

**Tier-1 discovery (11) reads the output of step 10, and tier-1 substitution (12) writes to
that same output of step 10.** This is the constraint most easily got wrong, so, precisely:

- The **input to discovery** is `cleaned = walker(retained, tier0Table)`. Not the raw
  records. Handing raw text to the semantic pass ships unredacted paths, the username and
  emails into the discovery context — a privacy tool leaking inside its own privacy step.
  It also wastes the pass's attention on 26,505 path occurrences it cannot help with.
- The **target of tier-1 substitution** is that **same `cleaned` object**, producing
  `final = walker(cleaned, tier1Table)`. It is *not* a re-run from raw with a merged
  `tier0 ∪ tier1` table.

  Re-running from raw is wrong for two separate reasons. **(a) Longest-match resolution
  changes.** The mask algorithm resolves overlaps by decoded length, so adding tier-1
  spellings to the table changes which entity wins at a given offset — the measured
  collisions are real (`gitroll` vs `gitroll-agentic`, `devuser` vs `devuser` vs
  `devuser@gitroll.io`). A merged single pass can therefore emit different output than the
  two-pass sequence, which means `review.md` — the thing the human approved — no longer
  describes the artifact being shipped. **The reviewed artifact must be the shipped
  artifact.** **(b) Tier-1 candidates are observations about cleaned text.** A candidate
  string extracted from cleaned text need not exist in the raw text at all, because tier-0
  created the surrounding context. Searching raw text for it is searching for something
  that was never there.
- Tier-1 substitution runs with a **pseudonym guard**: a tier-1 spelling that would match
  inside an already-emitted pseudonym token is rejected rather than applied. Without it, a
  semantic pass that helpfully returns `PERSON` as a name destroys every tier-0
  replacement in the corpus.
- If the tier-1 pass **did not run**, the export is refused (§3, §F1). Checked at step 11
  and again at step 17, because a refusal that a single skipped code path can bypass is not
  a refusal.

**Substitution invariant (13) runs at string level, before serialization (14).** §4.7(a) is
explicit. Run it after serialization and it tests the JSON escaper rather than the
substituter, and the bug class it exists for — ordering, overlap, prefix collision —
becomes invisible once the strings are back inside a serialized line.

**Residual scan (15) runs on the serialized bytes, not on the in-memory records.** This is
the one place where later is strictly more correct. Serialization re-introduces escaping
forms the in-memory scan never sees: a CJK entity re-emitted as a backslash-u escape, a
Windows path re-doubled to `C:\\Users\\...`. §4.6 recorded both forms on the way *in*; the
same transformation applies on the way *out*. Scan the exact bytes that enter the zip and
no other bytes.

**Zip (17) is last and is the only step that writes an output file.** cli-ux §10: any
non-zero exit leaves no output file behind. Enforced structurally — the writer is
unreachable until 3, 13 and 15 have returned pass — and defensively, via `.part` + rename
+ unlink-on-throw.

`review.md` (5) is the only file `scan` writes, and the preview file is the only file
written before an approved export. Neither contains raw entities.

---

## 3. Complete record-type enumeration

Measured over the full depth-0 corpus, 2026-08-22: 225 files, 134,758 records. Counts are
records, not bytes. See C1 for why this is 19 and not 16.

### 3.1 Top-level types

| # | Type | Count | Decision | Reason |
|---:|---|---:|---|---|
| 1 | `assistant` | 42,969 | KEEP-PARTIAL | Agent turns. Keep `text`, `thinking`, and `tool_use` name plus distilled input; drop `requestId` and raw `attributionMcp*` ids. |
| 2 | `user` | 25,798 | KEEP-PARTIAL | The primary user turn. Keep `message.content`; distil `toolUseResult` (§4.1) and keep `is_error`; drop `sourceToolAssistantUUID`, `promptId`, `mcpMeta`. |
| 3 | `attachment` | 18,671 | KEEP-PARTIAL | 26 sub-types, three of which carry user text (§4.4). Sub-table below. |
| 4 | `last-prompt` | 7,315 | KEEP-PARTIAL | Carries user prompt text found nowhere else 32.2% of the time (C3). Keep `lastPrompt`, drop `leafUuid`, dedupe against `queue-operation`. |
| 5 | `mode` | 7,141 | KEEP-PARTIAL | A bare enum with no PII; plan-vs-normal is a plausible Framing signal. Keep one value per session as metadata, drop the 7,141 repeats. |
| 6 | `permission-mode` | 6,862 | DROP | Harness bookkeeping, no user text, and the mode sequence is a behavioural fingerprint (§F4-adjacent) with no documented consumer. |
| 7 | `bridge-session` | 6,763 | DROP | §F5 verbatim: `ownerAccountUuid` / `ownerOrganizationUuid` match no detector and no axis reads it. |
| 8 | `ai-title` | 6,753 | DROP | Model-generated session title: derived, not a user turn, and it distils the subject matter (payroll, named people) into one high-signal string. |
| 9 | `system` | 5,546 | KEEP-PARTIAL | Keep `compact_boundary` only (15 records) — it explains gaps in a transcript. Drop every other sub-type, notably `away_summary` (564), which is prose naming third parties (§F2). |
| 10 | `file-history-snapshot` | 2,141 | DROP | §4.4 "pure bookkeeping"; inner object is `{messageId, timestamp, trackedFileBackups}`. |
| 11 | `queue-operation` | 2,025 | KEEP-PARTIAL | §4.4. Keep `content` and `operation`; 70.3% of contents appear nowhere else (C2). |
| 12 | `file-history-delta` | 1,090 | DROP | Backup file paths, no turn content. |
| 13 | `atis-latch` | 897 | DROP | Opaque harness latch; observed payload is an empty string. |
| 14 | `agent-name` | 420 | DROP | Subagent naming: no user turn, and user-authored agent names are themselves identifying. |
| 15 | `agent-setting` | 143 | DROP | Single enum value; bookkeeping. |
| 16 | `frame-link` | 110 | DROP | Absolute local file path plus artifact URL plus document title. Pure identity surface, zero scoring value. |
| 17 | `pr-link` | 50 | DROP | `prRepository` / `prUrl` are org identity and there is no user turn. The org is already an entity, so keeping it teaches nothing. |
| 18 | `relocated` | 32 | DROP-AFTER-USE | `relocatedCwd` is consumed by `cwdtrack.mjs` at step 4, then the record is dropped. Dropping earlier breaks the per-line cwd filter (§4.8). |
| 19 | `worktree-state` | 32 | DROP-AFTER-USE | Same: `originalCwd` / `worktreePath` / branch feed the cwd filter, then the record is dropped. |

**An unknown 20th type is a refusal, not a silent drop.** `retainRecord` raises a
`RefusalError` naming the type, the file and the line. A new Claude Code version adding a
record type is precisely the case §4.4 was written about.

### 3.2 `attachment` sub-types (26)

| Sub-type | Count | Decision | Reason |
|---|---:|---|---|
| `queued_command` | 455 | KEEP-PARTIAL | `prompt` is user text (§4.4). |
| `edited_text_file` | 313 | KEEP-PARTIAL | `snippet` is user-supplied context (§4.4). |
| `file` | 52 | KEEP-PARTIAL | `content` + `filename` are user-supplied context (§4.4); filename is substituted, content is retained as text and counted if it is code. |
| `total_tokens_reminder` | 6,412 | DROP | §4.4 names it explicitly safe to drop. |
| `hook_additional_context` | 2,858 | DROP | §4.4 names it explicitly safe to drop. |
| `hook_success` | 2,511 | DROP | Hook bookkeeping; frequently embeds local paths from hook output. |
| `task_reminder` | 1,878 | DROP | §4.4 names it explicitly safe to drop. |
| `output_style` | 1,550 | DROP | §4.4 names it explicitly safe to drop. |
| `skill_listing` | 542 | DROP | Local skill inventory: a device fingerprint (§F4) with no user turn. |
| `goal_status` | 405 | DROP | Harness bookkeeping. |
| `deferred_tools_delta` | 359 | DROP | Tool inventory; fingerprint (§F4). |
| `ultra_effort_enter` | 358 | DROP | Harness state flag. |
| `mcp_instructions_delta` | 321 | DROP | MCP server instructions; fingerprint (§F4). The server *names* are handled as entities instead. |
| `agent_listing_delta` | 234 | DROP | Local agent inventory; fingerprint. |
| `command_permissions` | 129 | DROP | Local permission config; fingerprint and path-bearing. |
| `date_change` | 90 | DROP | Bookkeeping; timestamps are quantised regardless. |
| `async_hook_response` | 62 | DROP | Hook output; path-bearing, no user turn. |
| `auto_mode` | 44 | DROP | Harness state flag. |
| `nested_memory` | 29 | DROP | CLAUDE.md content: user-authored but not a session turn, and densely personal. |
| `compact_file_reference` | 21 | DROP | Pointer into a compaction file, unresolvable after export. |
| `read_truncation_notice` | 14 | DROP | Bookkeeping. |
| `invoked_skills` | 11 | DROP | Fingerprint. |
| `hook_system_message` | 9 | DROP | Hook output. |
| `hook_cancelled` | 7 | DROP | Hook output. |
| `workflow_size_guideline_change` | 5 | DROP | Bookkeeping. |
| `dynamic_skill` | 2 | DROP | Skill body: fingerprint, no turn. |

An unknown sub-type triggers the same refusal as an unknown top-level type.

### 3.3 Content-block types inside `user` / `assistant`

| Block | Count | Decision | Reason |
|---|---:|---|---|
| `user.tool_result` | 21,872 | KEEP-PARTIAL | Head and tail capped by `constants.mjs`; `is_error` preserved verbatim (§6 open question 1 — truncation must not suppress `failure_signal`). |
| `assistant.tool_use` | 21,848 | KEEP-PARTIAL | Tool name kept, `input` substituted, code-valued parameters (`content`, `new_string`, `old_string`) counted and dropped. |
| `assistant.thinking` | 13,664 | KEEP | §6 posture: prefer preserving evidence over shrinking bytes. Substituted like any other text. This is the single largest byte lever if size ever bites, hence the `KEEP_THINKING_BLOCKS` constant. |
| `assistant.text` | 7,466 | KEEP | Agent prose. |
| `user.text` | 604 | KEEP | User prose — the Framing axis. |
| `user.image` | 378 | DROP-COUNTED | Replaced by a placeholder; the manifest reads `0 images / 378 replaced`. |
| `user.document` | 29 | DROP-COUNTED | Pasted documents are §F6's verbatim-document risk and are never exported. |

---

## 4. Invariants and abort conditions

An **invariant** is checked and must hold. An **abort** is what happens when one does not:
a refusal printed in the cli-ux §8 shape (reason plus remedy), exit 1, **no output file**.

### 4.1 Invariants

| # | Invariant | Step | Source |
|---:|---|---|---|
| I1 | **Serialization.** For every input line, `stringify(parse(line)) === line`, on untouched input. | 2 | §4.7(b) |
| I2 | **Substitution reversibility.** For every retained string `s`, `reverseString(substituteString(s, T), T) === s`, at string level before serialization. | 13 | §4.7(a) |
| I3 | **Namespace disjointness.** No input line contains a token matching the active pseudonym namespace. | 3 | §4.7(c), C4 |
| I4 | **Known-entity residue = 0.** No spelling or variant of any known entity survives in the serialized output bytes. | 15 | §F1 |
| I5 | **UUID residue.** No UUID appears in the output that is not a rewritten message or session uuid. | 15 | §F5 |
| I6 | **Semantic pass ran.** Tier-1 discovery produced a result for this run. | 11 and 17 | §3, §F1 |
| I7 | **Exhaustive typing.** Every top-level type, `attachment` sub-type and content block encountered has an explicit decision in §3. | 7 | §4.4 |
| I8 | **`code_added_lines` is the true added count or `null`.** Never `0` standing in for unknown, never a reconstructed net. | 7 | §4.3 |
| I9 | **Pseudonym table is bijective.** No pseudonym for two entities, no entity with two pseudonyms. | 9 | §4.7(a) implied |
| I10 | **Idempotence.** Same input, salt and namespace produce a byte-identical zip. | selftest | cli-ux §11 |
| I11 | **No output file exists on any non-zero exit.** | 17 and entry catch | cli-ux §10 |

### 4.2 Abort conditions

| Trigger | Exit | What the message says |
|---|---:|---|
| I1 fails | 1 | File and line whose round-trip failed. "Claude Code's log format has changed in a way deident does not round-trip. Do not export; report this." |
| I2 fails | 1 | The entity pair and the offending string redacted to 40 characters. "A replacement is not reversible — this is an ordering or overlap bug, not a configuration problem." |
| I3 fails | 1 | Files and line count (23 today, C4). Remedy: `--namespace <TAG>`, producing e.g. `X_PERSON_1`. |
| I4 or I5 fails | 1 | `known-entity residue    N` plus the first five locations by session and turn. "Nothing was written." |
| I6 fails | 1 | The cli-ux §8 refusal verbatim: entity discovery from prose is required; remedy `/deident-scan` or `--entities entities.json`. |
| I7 fails | 1 | The unknown type or sub-type, file and line. "deident refuses to guess whether a record it has never seen carries user text." |
| Unclassified workspaces exist | 1 | The cli-ux §8 list of workspaces and session counts. Remedy: set a tier in `review.md`, or `--skip-unclassified`. |
| Unreadable line, no `--skip-unreadable` | 3 | The cli-ux §9 shape: file, line number, parser message, likely cause, and the flag. |
| Deny-listed workspace included without typed confirmation | 1 | The workspace and the matched deny token. Remedy: `--include-denied <workspace-name>`, typed exactly. |
| Salt directory unwritable, or salt unreadable | 1 | The path and the OS error. "deident will not fall back to an unsalted or in-memory pseudonym; that would make two exports non-reversible against each other." |
| `git` not on PATH | 0 | Warning only. Git-sourced seeds are skipped and listed as missing in the review. Not fatal (§2: it must not throw). |
| Bad flag or bad combination | 2 | One line naming the flag, then usage. |

### 4.3 Never

- Never repair an input file.
- Never write a plaintext entity-to-pseudonym map (§3).
- Never write the salt into any output, manifest, preview or log line.
- Never degrade gracefully past I6 (§F1: "graceful degradation here is silent failure").
- Never print "safe", "0 leaks", or a bare green check (cli-ux §7).

---

## 5. Self-test fixtures

`node deident.mjs --selftest`. Plain `node:assert`, no framework, no network, no real log
content. Each fixture exists because it catches one specific bug.

| # | Fixture | The bug it catches |
|---:|---|---|
| F01 | `因為Dean他他想要` with entity `Jake` | A `\b` boundary silently missing a Latin entity abutting CJK (§4.5 row 1). Regression guard if anyone "simplifies" the lookaround back to `\b`. |
| F02 | `Ivy跟小語` with entity `Wei` | Same class, other side of the CJK boundary (§4.5 row 2). |
| F03 | `林先生` with entity `郭` | A one-character CJK entity over-matching inside a longer word. Asserts the length >= 2 rule rejects it and flags it for review instead of substituting (§4.5 row 3). |
| F04 | `array index` with entity `ray` | The correct **non**-match (§4.5 row 4). Catches the over-eager substring substituter someone reaches for after seeing F03 fail. |
| F05 | An `ls -l` line: `-rw-r--r-- 1 devuser 197609    929 ...` | §F3. Bare username outside any path, where longest-prefix path substitution never fires. Also asserts the stable Windows UID is treated as an identifier. |
| F06 | `gitroll` and `gitroll-agentic` in one string | §4.6 prefix collision: a short entity eating the prefix of a longer one. Requires sort-by-length-descending. |
| F07 | `devuser`, `devuser` and `devuser@gitroll.io` in one string | §4.6 three-way nested collision plus the email form. Catches an interval mask that releases a region it already claimed. |
| F08 | Substitute then reverse over F01–F07 | I2. Catches any replacement that is not invertible, which is how ordering bugs actually surface. |
| F09 | An `Edit` record: added 7, removed 7, net 0 | §4.2 / §4.3. Asserts `code_added_lines === 7`, not `0`. This is the 24.1%-of-edits case that manufactures a false "abandoned" session. |
| F10 | An `Edit` record whose `toolUseResult` is a **string** (C6) | Asserts `code_added_lines === null`, not `0`, and no crash on the non-object form. |
| F11 | A `Write` record with no `structuredPatch` | Asserts `null`, not `0` (§4.3: the two are different and `0` is the dangerous one). |
| F12 | A line containing `PERSON_1` | I3. Asserts abort, then asserts `--namespace X` succeeds. This fires on the real corpus today (C4), so the test protects a path Ray will hit on his first run. |
| F13 | One string carrying `C:\Users\devuser`, `C:/Users/devuser`, `/c/Users/devuser`, `C:\\Users\\devuser`, `%3Ddevuser%40gitroll.io`, and a backslash-u-escaped CJK name | §4.6 variant expansion. Catches a variant table that covers the common form and leaks the other five. |
| F14 | A file whose last line is a truncated JSON object | Exit 3 with the cli-ux §9 message shape, no stack trace (§9 definition of done). |
| F15 | A record with `"type":"future-thing"` | I7. Asserts refusal, not a silent drop. |
| F16 | A record with no `cwd`, following one that has one | §4.8. Asserts the effective cwd carries forward rather than defaulting to the workspace root. |
| F17 | Two records, `...\projects\x` then `...\projects\x\private` | §4.8 plus §4.11. Asserts the second is dropped even though the workspace is included. |
| F18 | A `relocated` record between two user records | Asserts the cwd change is applied **before** the record is dropped — the step 4 versus step 7 ordering. |
| F19 | An empty `.jsonl` file | §9 definition of done. Handled, not a crash. |
| F20 | A `tool_result` with `is_error: true` that exceeds the truncation cap | Asserts `is_error` survives truncation (§6 open question 1 — the one that silently inflates OVR). |
| F21 | A line with a non-BMP emoji and an escaped CJK codepoint | I1 round-trip on the hard cases (§4.6: 1,206 non-BMP strings). |
| F22 | A tier-1 entity string that overlaps an emitted pseudonym | The pseudonym guard at step 12. Catches a semantic pass returning `PERSON` and destroying every tier-0 replacement. |
| F23 | Full pipeline run twice over the same three-record fixture, second run forced to fail | I10 idempotence, and I11: no `.part`, no zip, nothing left behind. |

Beyond `--selftest`, per BRIEF §7 and §9: `--preview` over Ray's real corpus is the
acceptance run. Real mixed zh/en sessions, not synthetic fixtures.

---

## 6. CLI surface

Built to `docs/cli-ux.md`; this section is the flag-level contract only.

### 6.1 Commands

```
deident                     usage, exit 0.  Never exports.
deident --help              usage, exit 0.
deident --version           version, exit 0.
deident --selftest          fixture suite, exit 0 or 1.
deident scan                census plus review.md, exit 0.
deident review              render review.md, exit 0.
deident export              all checks, then the zip.
```

### 6.2 Flags

| Flag | Commands | Effect |
|---|---|---|
| `--root <path>` | all | Override the resolved storage root. Still depth-0 only. |
| `--out <path>` | scan, review, export | Output directory. Default: cwd. |
| `--html` | review | Write one self-contained HTML file. No server (cli-ux §4). |
| `--entity <ID>` | review | Print occurrences of one entity with session and turn (cli-ux §5). |
| `--session <id>` | review | Print one full redacted transcript to stdout. |
| `--preview` | export | Write a diff file instead of a zip. Runs every check first. |
| `--entities <file>` | export | Supply tier-1 entities as JSON instead of running the pass. Satisfies I6. |
| `--namespace <TAG>` | export | Shift the pseudonym namespace after an I3 collision. `TAG` matches `[A-Z][A-Z0-9]{0,7}`. |
| `--skip-unclassified` | export | Confirm that unclassified workspaces are to be left out. Does not include them. |
| `--skip-unreadable` | scan, export | Continue past an unparseable line, counting it in the manifest. |
| `--include-denied <name>` | export | Typed confirmation for one deny-listed workspace (§4.11). Repeatable, exact-match only, no globs. |
| `--salt-dir <path>` | all | Override `~/.deident-private`. |

Unknown flags, and any flag on a command that does not accept it, exit 2 with usage.

### 6.3 Exit codes

| Code | Meaning | Guarantee |
|---:|---|---|
| 0 | Success, or an informational command | |
| 1 | A check failed, or the export was refused | Nothing written |
| 2 | Bad usage; usage text printed | Nothing written |
| 3 | An input could not be read and `--skip-unreadable` was not given | Nothing written |

### 6.4 Message shapes

Three shapes only, so no failure ever reaches the terminal as a traceback.

**Refusal** (exit 1), per cli-ux §8:

```
  ✗ Refusing to export: <one-line reason>

    <two or three lines on why this is a refusal and not a warning>

    <remedy label>:   <the exact command to run>
```

**Read error** (exit 3), per cli-ux §9:

```
  ✗ Could not read session file
      <absolute path>
      line <n> is not valid JSON (<parser message>)

    <the likely cause>. <the fix, naming --skip-unreadable>.
```

**Usage error** (exit 2): one line naming the flag, then the usage block.

Every message is produced by `src/cli/report.mjs`. No module outside it writes to stdout or
stderr, which makes cli-ux §7 ("wording is a security control") enforceable by grep.

---

## 7. Commit sequence

One commit per step, Conventional Commits, no AI trailers, `-c commit.gpgsign=false`.

1. `docs: slice 1 implementation plan` and `docs: adapter research findings`
2. `feat: CLI entry, arg parsing and typed errors`
3. `feat: corpus root resolution and depth-0 enumeration`
4. `feat: session reader with per-line serialization invariant`
5. `feat: effective-cwd tracking across relocated and worktree records`
6. `feat: workspace tiers, deny-list and per-line cwd filter`
7. `feat: entity seeding and escaping-variant expansion`
8. `feat: salted pseudonyms and namespace collision check`
9. `feat: longest-match single-pass substitution with interval mask`
10. `feat: record retention table and structuredPatch distillation`
11. `feat: verification gates and residual scan`
12. `feat: deterministic zip writer and preview output`
13. `test: selftest fixtures F01-F23`
14. `docs: README with the limits section`
