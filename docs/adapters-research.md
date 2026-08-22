# Adapter research — non-Claude-Code sources

Per BRIEF §8: **this machine is not evidence about other products.** Every finding here
was established from the vendor's own source code or documentation. Evidence markers are
preserved exactly as the researching agents recorded them:

- `[SOURCE …]` — the vendor's own source code, cited by file and line.
- `[DOC …]` / `[OFFICIAL DOC …]` — the vendor's own published documentation.
- `[THIRD-PARTY]` — a blog post, a reverse-engineering project, a community thread. Not a
  build basis.
- `[COULD NOT DETERMINE]` — nothing vendor-authored was found. Flagged, not guessed.

Nothing here authorises building a parser. §5 states which adapters could responsibly be
written today, and BRIEF §10's deferral table still governs *whether* to write them.

---

## 1. Codex (OpenAI) — verified against `github.com/openai/codex` main branch

Fetched live via raw.githubusercontent.com and `gh search code`, current as of 2026-08-22.

**Headline: BRIEF §8's Codex claims are correct but describe an older/thinner slice of the
codebase.** Every specific fact BRIEF cites (`SESSIONS_SUBDIR`, the
`rollout-<ts>-<uuid>.jsonl` pattern, `CommandExecutionItem{command, aggregated_output,
exit_code, duration}`, `state_5.sqlite` with a `threads` table carrying `rollout_path`)
checks out verbatim against current source. But current `main` has grown substantially past
that: rollout files can be zstd-compressed, there is a second parallel content encoding
(paginated vs legacy), a `history.jsonl` that is a *different, much thinner* file than the
per-session rollout, and an `--ephemeral` flag that fully suppresses persistence. None of
this contradicts BRIEF; it is additive detail BRIEF did not have.

### 1.1 Directory layout and filename pattern

Root: `$CODEX_HOME` (env var), defaulting to `~/.codex`.

`[SOURCE codex-rs/core/src/config/mod.rs:4700-4711]` — if `CODEX_HOME` is set the value
must exist and be a directory, and is canonicalized; if unset, no existence check.

`[SOURCE codex-rs/rollout/src/lib.rs:65-66]`

```rust
pub const SESSIONS_SUBDIR: &str = "sessions";
pub const ARCHIVED_SESSIONS_SUBDIR: &str = "archived_sessions";
```

`[SOURCE codex-rs/rollout/src/recorder.rs:1606-1626]` — `precompute_new_rollout_path`
resolves `codex_home / sessions / YYYY / MM / DD` and joins a rendered filename.

`[SOURCE codex-rs/rollout/src/rollout_file_name.rs:36-73]` — parse and render, both
directions, including the reverted-thread case. Canonical pattern:

```
$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread_id>.jsonl
```

Dashes, not colons, in the timestamp — Windows-filename-safe by construction. A **reverted**
thread carries an extra `_<rollout_id>` suffix where `rollout_id != thread_id`. An
archived/soft-deleted thread's file lives at the identical path under `archived_sessions/`.

**Correction to what a naive tool would assume:** the physical file may be
`rollout-….jsonl` **or** the zstd-compressed `rollout-….jsonl.zst` — see §1.5.

**Sub-agent sessions are not nested by directory depth.** Unlike the Claude Code corpus
BRIEF measured (§4.10, depth-2/depth-4 subagent trees), Codex writes *every* thread — root
or sub-agent — into the same flat `sessions/YYYY/MM/DD/` tree via that one function. What
differentiates them is the `source` field inside `SessionMeta`
(`SessionSource::SubAgent(SubAgentSource::ThreadSpawn{parent_thread_id, depth, …})`), not
directory depth. **A depth-0-only reader strategy, as BRIEF's slice 1 uses for Claude Code,
will not exclude Codex sub-agent transcripts** — filtering must be by the
`source`/`thread_source` field read from each file's first line, or by the sqlite `source`
column. `[SOURCE codex-rs/protocol/src/protocol.rs:2652-2663]` and
`[SOURCE codex-rs/rollout/src/lib.rs:69-76]` (`INTERACTIVE_SESSION_SOURCES` lists only
`Cli, VSCode, Custom("atlas"), Custom("chatgpt")` as human-facing sources).

### 1.2 Line shape and record types

`[SOURCE codex-rs/history/src/lib.rs:201-206]` — every physical line is one `RolloutLine`
with `timestamp`, optional `ordinal`, and a flattened `RolloutItem`.

`[SOURCE codex-rs/rollout/src/recorder.rs:1968-1973]` — written with compact
`serde_json::to_string` plus `\n`, flushed per line. Not pretty-printed.

`[SOURCE codex-rs/history/src/rollout_payload.rs:18-49]` — the on-wire discriminant is a
hand-written wire enum tagged `"type"`, snake_case. **Nine top-level record types:**
`session_meta`, `response_item`, `inter_agent_communication`,
`inter_agent_communication_metadata`, `compacted`, `turn_context`, `world_state`,
`security_risk_score`, `event_msg`.

Smaller than Claude Code's 19 (PLAN.md C1), but two of them (`response_item`, `event_msg`)
are themselves tagged unions carrying most of the substance, so the real branching factor is
comparable.

### 1.3 Which record carries what

**Session meta** — `[SOURCE codex-rs/protocol/src/protocol.rs:2881-2934]`: `SessionMeta`
carries `session_id`, `id`, `forked_from_id`, `parent_thread_id`, `timestamp`, `cwd`,
`originator`, `cli_version`, `source`, `thread_source`, `model_provider`,
`base_instructions`, `history_mode`, and more. Git is a **sibling field on the wrapper
line**, not on `SessionMeta`:
`[SOURCE codex-rs/protocol/src/protocol.rs:2972-2977, 3163-3173]` —
`SessionMetaLine{ meta, git: Option<GitInfo> }` and
`GitInfo{ commit_hash, branch, repository_url }`.

This is git remote as an explicit optional field on the very first line of the file,
populated once at session start by `codex_git_utils::collect_git_info`
`[SOURCE codex-rs/rollout/src/recorder.rs:63,65]`. **BRIEF §8 was right that Codex is the
only observed local source carrying a git remote** — confirmed here as a first-class struct
field, not an inferred string.

**`cwd` drifts mid-session, exactly as in Claude Code (§4.8), by a different mechanism.**
`SessionMeta.cwd` is captured once. Codex re-captures it via `TurnContextItem`
`[SOURCE codex-rs/protocol/src/protocol.rs:3187-3195]`, persisted once per real user turn
and again after mid-turn compaction. A per-directory opt-in filter for a Codex adapter would
have to walk `turn_context` records too, not just the first `session_meta` line.

**User-turn text has two parallel encodings**, chosen by `SessionMeta.history_mode`
(`ThreadHistoryMode::Legacy` default vs `::Paginated`)
`[SOURCE codex-rs/protocol/src/protocol.rs:717-721]`:

- **Legacy**: a `response_item` line whose payload is
  `ResponseItem::Message{role:"user", content: Vec<ContentItem>}`, where `ContentItem` is
  `InputText | InputImage | InputAudio | OutputText`
  `[SOURCE codex-rs/protocol/src/models.rs:837-853]`.
- **Paginated**: an `event_msg` line whose payload is
  `EventMsg::ItemCompleted(ItemCompletedEvent{item: TurnItem::UserMessage(UserMessageItem)})`
  `[SOURCE codex-rs/protocol/src/items.rs:78-83]`.

**Tool call, tool result and exit code**, same split:

- **Legacy**: `ResponseItem::LocalShellCall{call_id, status, action}`
  `[SOURCE codex-rs/protocol/src/models.rs:989-1001]`, paired with a later
  `ResponseItem::FunctionCallOutput{call_id, output: FunctionCallOutputPayload}` where the
  payload is `{ body, success: Option<bool> }`
  `[SOURCE codex-rs/protocol/src/models.rs:2071-2081]`. **There is no structured numeric
  exit code in Legacy mode** — only a boolean and free text, mirroring BRIEF §4.1's
  Claude Code "`tool_result` is prose" problem.
- **Paginated**: `TurnItem::CommandExecution` — the struct BRIEF §8 already cited, confirmed
  verbatim `[SOURCE codex-rs/protocol/src/items.rs:213-240]`: `command: Vec<String>` (real
  argv, structured, not a shell string), `cwd`, `parsed_cmd`, `status`, `stdout`, `stderr`,
  `aggregated_output` (three separate optional strings, not one canonical field),
  `exit_code: Option<i32>`, `duration`, `formatted_output`.

  This is a materially richer tool-result record than Claude Code's prose-only
  `tool_result`. Paginated-mode Codex already has what BRIEF had to reconstruct from
  `structuredPatch`.

**File edits** get their own Paginated-only record with a keyed diff, not a prose
confirmation: `FileChangeItem{ id, changes: HashMap<PathBuf, FileChange>, status,
auto_approved, stdout, stderr }` `[SOURCE codex-rs/protocol/src/items.rs:370-385]`.

**MCP tool calls**, Paginated-only: `McpToolCallItem{ id, server, tool, arguments, status,
result, error, duration }` `[SOURCE codex-rs/protocol/src/items.rs:389-424]`.

**Token counts** — `[SOURCE codex-rs/protocol/src/protocol.rs:2078-2093, 2167-2171]`:
`TokenUsage{ input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens,
reasoning_output_tokens, total_tokens }`, carried as `event_msg` / `token_count`.

**Timestamps** — `[SOURCE codex-rs/rollout/src/recorder.rs:1950-1952]`: millisecond
precision UTC, format fixed at the writer.

**Which record types get persisted at all** — the Codex analogue of BRIEF §4.4's enumerate-
everything requirement. `[SOURCE codex-rs/rollout/src/policy.rs:9-21]` gates by type, and
`[SOURCE codex-rs/rollout/src/policy.rs:83-133]` gates almost the entire `EventMsg`
catalogue by `history_mode`: `ItemCompleted` persists only in Paginated mode; a list of
legacy events (`UserMessage`, `AgentMessage`, `PatchApplyEnd`, `McpToolCallEnd`, …) persists
only in Legacy mode; and a longer list (`Error`, `ExecCommandBegin/End`, `McpToolCallBegin`,
`ExecApprovalRequest`, streaming deltas) is explicitly **never** persisted as "transient,
non-durable events".

### 1.4 The sqlite index — `state_5.sqlite`

BRIEF's specific claim checks out exactly.
`[SOURCE codex-rs/state/src/sqlite.rs:33]` — `const STATE_DB_FILENAME: &str =
"state_5.sqlite";`. `[SOURCE codex-rs/state/migrations/0001_threads.sql]` — the `threads`
table with `id, rollout_path, created_at, updated_at, source, model_provider, cwd, …,
git_sha, git_branch, git_origin_url`.

But this is now one of **49+ numbered migrations**, adding `thread_spawn_edges`,
`thread_sections`, `projects`, and a `rollout_migration_state` /
`rollout_migration_skipped_rollouts` pair (explicit backfill tracking for indexing
pre-existing rollout files). Four other separately-versioned sqlite files share
`$CODEX_HOME`: `logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`, `queue_1.sqlite`,
`thread_history_1.sqlite` `[SOURCE codex-rs/state/src/sqlite.rs:29-33]`. None is a
session-transcript store.

**Whether both layouts must be supported — yes, and the vendor says why**
`[SOURCE codex-rs/thread-store/README.md]`:

> `LocalThreadStore` persists history through `codex-rollout` JSONL files and persists
> queryable metadata through the SQLite state database when available. Local explicit
> metadata mutations also maintain JSONL/name-index compatibility so reading old or
> SQLite-less local storage keeps working.

So JSONL under `sessions/` / `archived_sessions/` remains the **sole source of truth for
transcript content**. The sqlite `threads` table is a queryable *index*, deliberately
optional. **A de-identification tool does not need to touch sqlite for correctness** — but
if it wants fast per-thread cwd/git/source filtering without opening every file, the
`threads` table is the shortcut, with `rollout_path` as the join key. Per
`rollout_migration_state`, a file may have been "skipped" during backfill and be absent from
the index even though it exists on disk, so **the index cannot be trusted as a complete
enumeration either**.

### 1.5 What breaks a naive JSONL reader

1. **Zstd compression of cold files — the single biggest gotcha.**
   `[SOURCE codex-rs/rollout/src/compression.rs:17-18, 41-53]` — `COMPRESSED_SUFFIX =
   ".zst"`, and the vendor's own reader treats plain-vs-compressed as an implementation
   detail callers should not need to know. A tool that globs `*.jsonl` silently skips every
   compressed (typically older) session and undercounts — the analogue of BRIEF §4.10's
   "a naive glob ships the wrong slice". There is also a live plain↔compressed transition
   (materialize-on-append, compress-when-cold), so the same logical file can flip
   representation between two scans.
2. **The two history-mode encodings are not interchangeable.** A reader hard-coded to one
   drops the other file's content outright.
3. **Possible truncated/invalid final line after a crash.**
   `[SOURCE codex-rs/rollout/src/recorder.rs:1918-1929]` — the writer only fixes
   non-newline-termination *on next append*, not proactively. A reader must tolerate one bad
   final JSON line without aborting the file. (Same requirement as PLAN.md F14.)
4. **Reverted threads: one `ThreadId` can map to more than one file.** Not mentioned in
   BRIEF at all. `[SOURCE codex-rs/protocol/src/protocol.rs, HistoryPosition doc comment,
   ~line 2900]`: "a reverted thread's filename carries a distinct rollout ID." A reader
   keying purely off the filename thread id can conflate or miss revert lineages.
5. **Compaction replaces, does not append, history.**
   `[SOURCE codex-rs/history/src/lib.rs:142-149]` — `CompactedItem.replacement_history`
   supersedes prior items for context reconstruction. A naive "concatenate every
   response_item in file order" reader still gets every real turn (nothing is deleted from
   disk) but will not match what the model reconstructed as current history.
6. **`--ephemeral` suppresses persistence entirely — no file, not even a temp one.**
   `[SOURCE codex-rs/exec/src/cli.rs:30-32]` and
   `[SOURCE codex-rs/core/src/session/session.rs:838-842, 927-937]`. Absence of a rollout
   file for a time window is **not** evidence that no session happened — exactly as BRIEF's
   "this machine is not evidence" warning would predict.
7. **`~/.codex/history.jsonl` is a different, thinner file — do not conflate.**
   `[SOURCE codex-rs/message-history/src/lib.rs:1-15, 60-67]` — one line per **user** message
   only: `{"session_id","ts","text"}`. Governed by `history.persistence` and
   `history.max_bytes` in `config.toml` `[SOURCE codex-rs/config/src/types.rs:196-213]`.
   The official config reference
   `[DOC https://learn.chatgpt.com/docs/config-file/config-reference]` describes
   `history.persistence` as `"save-all"` saving "session transcripts", which is **misleading
   relative to the source**: `history.jsonl` holds no assistant replies, no tool calls, no
   cwd/git/model. The real transcripts are the per-session rollout files, whose persistence
   is controlled separately by `--ephemeral`. On its own, `history.jsonl` fails BRIEF §8's
   capability floor outright.

### 1.6 Codex summary

| Question | Answer |
|---|---|
| Root dir | `$CODEX_HOME`, default `~/.codex`; canonicalized-and-must-exist if set |
| Layout | `sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>[_<rollout_id>].jsonl`, mirrored under `archived_sessions/`; sub-agent sessions share the tree, distinguished by an in-file `source` field |
| Compression | cold files may be `.jsonl.zst`; reader must decompress transparently |
| Line shape | `{"timestamp","ordinal"?,"type","payload",["metadata"]}`, one compact JSON object per line |
| Record types | 9: `session_meta, response_item, inter_agent_communication, inter_agent_communication_metadata, compacted, turn_context, world_state, security_risk_score, event_msg` |
| Session meta | `SessionMeta{cwd, originator, cli_version, model_provider, source, history_mode, …}` + sibling `git: GitInfo{commit_hash, branch, repository_url}` |
| User text | Legacy: `response_item` → `Message{role:"user", content:[InputText{text}]}`. Paginated: `event_msg` → `ItemCompleted{TurnItem::UserMessage}` |
| Tool call + result + exit code | Legacy: `LocalShellCall` + `FunctionCallOutput{body, success:Option<bool>}` — no numeric exit code. Paginated: `CommandExecution{command, cwd, stdout, stderr, aggregated_output, exit_code, duration, status}` — full structure |
| Token counts | `event_msg` → `TokenCount`, `TokenUsage{input, cached_input, cache_write, output, reasoning_output, total}` |
| Timestamps | millisecond UTC, per line |
| sqlite | `state_5.sqlite` `threads` table: an optional query index over the JSONL, never the source of truth |
| `--ephemeral` | fully suppresses the rollout file and sqlite init for that run |
| `history.jsonl` | separate, thinner, global, user-text-only; must not be conflated with rollouts |

**`[COULD NOT DETERMINE]` / not read this pass**, flagged rather than guessed: the exact
field shapes of `LocalShellAction`, `ParsedCommand`, `FileChange`, `UserInput`, and
`CallToolResult`. All are referenced by structs above, but their defining files
(`protocol/src/user_input.rs`, the `FileChange` section of `protocol/src/protocol.rs`,
`protocol/src/mcp.rs`) were not fetched. Pull them before writing a parser against them.

---

## 2. Google Antigravity

Vendor documentation only decides "documented". This machine was not used as evidence.

### 2.1 Documented storage locations

- **CLI resume-cache index**: `~/.gemini/antigravity-cli/cache/last_conversations.json` —
  "A JSON map associating absolute workspace directory paths with their most recently active
  conversation ID." `[DOC https://antigravity.google/docs/cli/commands/resume]`
- **CLI plugin/settings files** (not transcripts):
  `~/.gemini/antigravity-cli/plugins/<plugin_name>/`,
  `~/.gemini/antigravity-cli/settings.json`,
  `~/.gemini/antigravity-cli/import_manifest.json`
  `[DOC https://antigravity.google/docs/cli/features/]`
- **CLI updater state** (not transcripts): `~/.gemini/antigravity-cli/updater/update.lock`,
  `last_check.timestamp` `[DOC https://antigravity.google/docs/cli/troubleshooting/]`
- Scoping behaviour is confirmed but the transcript path is never named: "Antigravity CLI
  scopes conversation histories directly to your current working directory."
  `[DOC https://antigravity.google/docs/cli/conversations]`
- Session tokens live in the OS keychain (macOS Keychain / Linux secret-service / Windows
  Credential Manager), not in the conversation content
  `[DOC https://antigravity.google/docs/cli/troubleshooting/]`

**`[COULD NOT DETERMINE]` from vendor docs**: the per-conversation transcript file's own
path. The resume, conversations, features, troubleshooting, FAQ and enterprise pages were
each fetched in full; none states where the conversation body lives. Only the small
workspace→id index above is documented.

### 2.2 Documented format

**`[COULD NOT DETERMINE]`.** No vendor page specifies a transcript file format. This matches
BRIEF §8 and is now confirmed by direct fetch of each page rather than inferred.

Third-party sources actively **contradict each other, and contradict themselves across
product surfaces**:

- `[THIRD-PARTY]` Full transcripts as **protobuf** `.pb` files, e.g.
  `~/.gemini/antigravity/conversations/` (legacy) or
  `~/.gemini/antigravity-ide/conversations/` (newer IDE builds) — this is the **IDE**, a
  separate surface from the CLI. (github.com/ag-donald/Antigravity-Database-Manager;
  ericxliu.me reverse-engineering post)
- `[THIRD-PARTY]` Newer IDE builds store **one SQLite `.db` per conversation** instead of
  `.pb`, with a `steps` table whose `step_payload` column is itself still protobuf blobs
  (github.com/ag-donald/Antigravity-Database-Manager) — the SQLite claim resolves to
  protobuf underneath, not a clean alternative.
- `[THIRD-PARTY]` A **readable JSONL** transcript log also exists, under a "brain
  conversation's `.system_generated/logs/`" — a third format, for a still different code
  path (agentgrep.org docs).
- `[THIRD-PARTY]` The `.pb` files are reported **encrypted** via Electron's `safeStorage`
  API, keyed to the OS Keychain/DPAPI equivalent, making them "effectively random noise"
  without the device's own key (ericxliu.me; github.com/arashz/antigravity_decryptor exists
  specifically to reverse this).

Net honest read: at least three incompatible format claims exist, for what may be two
different product surfaces (CLI vs IDE) sharing the `~/.gemini/` root, plus a credible claim
that the on-disk file is encrypted per-device. None is vendor-confirmed. **Do not resolve
this contradiction by guessing which is current** — it may not even be one format.

### 2.3 Tool calls and tool results

**`[COULD NOT DETERMINE]`.** No vendor doc describes the transcript schema, so nothing can
be said officially about whether `CommandExecutionItem`-equivalent pairs are present,
retained, or truncated. This is a strictly lower-confidence position than Codex, which has
the struct in open source.

### 2.4 Refinement to BRIEF §8

BRIEF's single "Antigravity" bullet does not distinguish **CLI from IDE**. Third-party
sources suggest they may be genuinely different storage surfaces
(`~/.gemini/antigravity-cli/…` vs `~/.gemini/antigravity/conversations/` or
`~/.gemini/antigravity-ide/conversations/`), and only the CLI's tiny resume index is
documented at all. If Antigravity is ever revisited, resolve that surface distinction before
picking a target.

---

## 3. Cursor

Cursor is closed source. All vendor pages below were fetched directly.

### 3.1 Documented storage locations

**None.** Cursor's docs never name a local file path for chat storage. Everything documented
is the **server-side** data path:

- Prompts and code context are sent to model providers through Cursor's backend, even with
  your own API key `[DOC https://cursor.com/help/security-and-privacy/privacy]`
  `[DOC https://cursor.com/data-use]`
- Shared transcripts are a **server** feature: a `cursor.com/s/…` link generated from the
  dashboard, not a local export. "The full conversation history is shared, including code
  snippets, tool calls, and their results," with best-effort secret redaction that is
  explicitly "not guaranteed" `[DOC https://cursor.com/docs/agent/chat/export]`
- Codebase indexing: plaintext deleted after embedding; embeddings/hashes/filenames "may be
  stored in our database" `[DOC https://cursor.com/data-use]`
- Cloud Agents are the one feature documented as requiring Cursor to hold code over time
  (encrypted copy, deleted after use, Privacy Mode on by default)
  `[DOC https://cursor.com/data-use]`

**`[COULD NOT DETERMINE]` from vendor docs**: any local on-disk path for chat content. The
privacy, export and data-use pages are written entirely from the server-retention angle.

### 3.2 Documented format

**`[COULD NOT DETERMINE]`.** No vendor source describes a local file format at all. This is
an absence, not a dispute.

`[THIRD-PARTY]`, for context only, not a build basis: numerous independent write-ups
(vibe-replay.com, dasarpai.com, the `cursor-db-mcp` and `cursaves` GitHub projects) converge
on `%APPDATA%\Cursor\User\globalStorage\state.vscdb` on Windows (analogous paths elsewhere),
plus per-workspace `workspaceStorage/<hash>/state.vscdb`, with a `cursorDiskKV` key-value
table storing message bubbles under keys like `bubbleId:{composerId}:{bubbleId}`. Unusually
consistent for reverse engineering — several independent tools implement against it
successfully — but zero vendor confirmation, and nothing here is a public contract.

### 3.3 Tool calls and tool results

Not established by the vendor as a local-recovery question. The only place Cursor's own docs
discuss tool calls and results together is the **server-side shared-transcript** feature,
which explicitly includes them, but that is a per-conversation share-to-web action, not a
bulk export or local log. Local recoverability is **`[COULD NOT DETERMINE]`** on vendor
evidence; `[THIRD-PARTY]` sources claim yes via the `state.vscdb` schema.

---

## 4. ChatGPT and Gemini consumer exports

### 4.1 ChatGPT `conversations.json`

**Export procedure is documented**
`[OFFICIAL DOC https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data]`:
Settings → Data Controls → Export → Confirm. Delivered by email/SMS link, available up to
7 days, link expires 24h after delivery. "The downloaded ZIP file includes your chat history
and other relevant account data." Self-service export is available on Free/Go/Plus/Pro/
eligible Edu, not on Business/Enterprise/Healthcare workspaces. (Confirmed via search
snippet; direct `help.openai.com` fetch returns 403, exactly as BRIEF notes.)

**Schema: `[COULD NOT DETERMINE]` / no official doc found.** Targeted `site:help.openai.com`
and `site:developers.openai.com` searches for `conversations.json`, `mapping`,
`current_node`, `parent`, `children` returned nothing OpenAI-authored describing the
export's internal structure. `developers.openai.com` publishes "Conversation state" and
"Realtime conversations" guides, but those describe the **live Conversations API** object
model, a different product surface. Two OpenAI Developer Community threads
(community.openai.com/t/403144 and /t/954762) were opened directly and checked specifically
for an OpenAI-staff reply: **none exists**, only community members.

So the "tree, not list" description and every `mapping` / `current_node` / `parent` /
`children` reference traces only to `[THIRD-PARTY]` exporter tools, gists and blog posts.
**This confirms BRIEF §8 and finds nothing that contradicts or resolves it.** The claim stays
`[THIRD-PARTY]`.

| Item | Status |
|---|---|
| Per-message text | Present per `[THIRD-PARTY]` accounts; officially only "chat history" is confirmed, no field-level guarantee |
| Timestamps | `[THIRD-PARTY]` "creation and modification timestamps" |
| Model name | `[THIRD-PARTY]` "the model recorded for each turn" |
| Tool / code-execution traces | Not addressed by any OpenAI doc either way. `[COULD NOT DETERMINE]`, lean absent — this is a consumer chat export, not an agent trace log |
| Working directory | No concept applies |

### 4.2 Gemini Takeout

**Export procedure is documented**
`[OFFICIAL DOC https://support.google.com/gemini/answer/16920332]`: via takeout.google.com,
deselect all, then select "All activity data included" or the Gemini-specific items. The
page explicitly distinguishes **"Gemini Gems data"** from **"Gemini Apps Activity"** ("your
Gemini chats, generated media, and uploads"). Delivery is zip/tgz, "a few hours to a few
days".

**The path `Takeout/My Activity/Gemini Apps/MyActivity.json` is `[THIRD-PARTY]`**, not found
on any Google-authored page. Google's own My Activity Schema Reference
`[OFFICIAL DOC https://developers.google.com/data-portability/schema-reference/my_activity]`
was fetched directly and **confirms BRIEF's claim**: it does not mention Gemini anywhere,
enumerating six resource groups (YouTube, Maps, Google Search, My Ad Center, Shopping,
Google Play), none of them Gemini. A search across all
`developers.google.com/data-portability/schema-reference/*` pages finds **no Gemini
schema-reference page at all**. The Gemini Apps Privacy Hub
`[OFFICIAL DOC https://support.google.com/gemini/answer/13594961]` only says "You can also
export your information" with a bare takeout.google.com link.

**Schema: `[COULD NOT DETERMINE]`.** No Google-authored page describes field names, record
shape, or whether it is a flat activity log or a threaded structure. `[THIRD-PARTY]` sources
describe "an activity log, not a chat-tree export… each record holds one prompt, Gemini's
response, and a timestamp".

**Retention when Gemini Apps Activity is off**
`[OFFICIAL DOC https://support.google.com/gemini/answer/13278892]`: "If Keep Activity is
off, any Gems you create will still be saved to your account. Any chats you create with Gems
will not be saved." And: "Even when Keep Activity is off, your conversations will be saved
with your account for up to 72 hours…" — i.e. **there is no zero-retention state** on the
consumer product. Separately, `[THIRD-PARTY]` summaries (heydata.eu, anarlog.so) state that
conversations selected for human review are retained up to 3 years disconnected from the
account regardless of the setting; this was **not** found on a `support.google.com` or
`policies.google.com` page and is flagged unresolved rather than asserted.

| Item | Status |
|---|---|
| Per-message text | `[OFFICIAL DOC 16920332]` confirms "your Gemini chats" are included; per-message fidelity unspecified |
| Timestamps | `[THIRD-PARTY]`, consistent with My Activity's `time` field, but Gemini is not in that schema doc — inferred, not confirmed |
| Model name | `[COULD NOT DETERMINE]` — no source, official or third-party, claims it is present |
| Tool / code-execution traces | `[COULD NOT DETERMINE]` / likely absent — nothing documents it; this is a chat/activity log, not an agent trace |
| Working directory | Not applicable |

### 4.3 Which scoring axes these two sources can ever support

Per BRIEF §8's capability floor — outcome-based scoring needs tool calls **and** tool
results — and confirmed by this research (neither export documents, nor is claimed by
anyone, to carry a tool-call/tool-result record type):

- **Supportable:** Framing, Precision, Rigor. These are scored from user-message quality and
  reasoning-in-prose, which is what both exports carry, subject to the schema gaps being
  resolved well enough to parse reliably.
- **Structurally impossible:** Execution, Resilience. Both require observing an action and
  its outcome. Neither export contains any record type resembling this. **This is not a
  parsing gap to fix later; it is absent at the source.**
- **Expertise: unresolved, do not guess.** BRIEF §6 flags "whether the Expertise classifier
  reads code content" as an open upstream question. If it does, these exports fail it for
  the same structural reason. If Expertise is scored purely from prose, it might be partly
  supportable. `[COULD NOT DETERMINE]` — flagged rather than assumed either way.

Net: **a ChatGPT or Gemini export can support at most 3 of 6 axes, never Execution or
Resilience, and Expertise only if the upstream classifier turns out not to require tool or
code evidence — which is currently unknown.**

---

## 5. Which adapters can responsibly be written today

"Responsibly" means: the format is established from a vendor source, the capability floor in
BRIEF §8 is met, and a parser written now will fail loudly rather than silently when the
vendor changes something.

| Source | Format from vendor? | Capability floor met? | Could be written today? |
|---|---|---|---|
| Claude Code | No vendor spec, but the corpus is on this machine, is JSONL, and slice 1 enumerates every type deliberately (PLAN.md §3) | Yes — tool calls and `toolUseResult` | **Already the slice 1 target** |
| Codex | **Yes** — open source, cited by file and line throughout §1 | Yes — Paginated mode carries `CommandExecution{command, exit_code, stdout/stderr, duration}`; Legacy carries the call and a boolean success | **Yes, technically.** Still gated by BRIEF §10 — "any non-Claude-Code adapter" is deferred until triggered. Nothing here fires that trigger. |
| Antigravity | **No.** Transcript path undocumented, format contested three ways, one credible claim of per-device encryption | `[COULD NOT DETERMINE]` | **No.** A parser built now reverse-engineers a moving, possibly-encrypted, possibly-multi-format target across two product surfaces, and breaks silently on the next release. Defer. |
| Cursor | **No.** Zero local path or format documented | `[COULD NOT DETERMINE]` on vendor evidence | **No.** Anything workable rests entirely on undocumented third-party schema work with no vendor guarantee it survives a release. Defer. |
| ChatGPT export | Export flow yes, schema no | **No** — no tool-call/tool-result record type | **No**, and worth stating positively: even a perfect parser buys at most 3 of 6 axes. |
| Gemini Takeout | Export flow yes, schema no, and the schema doc that exists does not mention Gemini | **No** — same | **No**, same reasoning. |

**If a Codex adapter is ever triggered**, the five things §1.5 lists are the work, not the
JSONL parsing: zstd-transparent reading, the Legacy/Paginated fork, tolerating a truncated
final line, the reverted-thread filename, and filtering sub-agent threads by the in-file
`source` field rather than by directory depth. Pull the five `[COULD NOT DETERMINE]` structs
in §1.6 first.

---

## 6. Why this machine's local state is not evidence about any of these products

BRIEF §8 states this and it is worth keeping in front of anyone who opens this file, because
the temptation runs the other way every time.

On this machine: **Cursor** has four empty draft conversations and was never really used;
**Codex** is installed and authenticated but has zero threads and zero rollouts;
**Antigravity** was downloaded on 2026-07-07 and never installed.

A conclusion such as "Cursor does not store message text locally" drawn from that state is a
conclusion about **an unused install**, not about Cursor. An empty directory is consistent
with at least four different explanations — the product stores nothing locally, the product
stores it elsewhere, the feature was never exercised, or persistence was disabled — and
local inspection cannot distinguish them. Codex proves the point in the other direction: its
own source documents `--ephemeral`, under which a genuinely heavy session leaves **no file
at all** `[SOURCE codex-rs/core/src/session/session.rs:838-842]`. Absence of files is not
evidence of absence of storage.

The reverse error is equally available: finding a file here would establish that *this build,
on this OS, with these settings* wrote it — not that the format is stable, documented, or
present for anyone else.

So the rule is the one BRIEF already set: **establish each format from the vendor's own
source or documentation, and where neither exists, say so and stop rather than building a
parser from blog posts.** Sections 2 and 3 above are what stopping looks like.
