# What deident does not protect against, in full

A tool that only lists its strengths gets over-trusted, and the first surprise
destroys it permanently. README carries the two limits that decide whether you
should run this at all. This is the whole list.

The same disclosure is printed at the moment of export, in
`src/cli/limits.mjs`, so the person deciding to send a file sees it there and
not only here.

## The residue check proves less than its label

The check reads `known-entity residue    0 occurrences of N entity spellings`,
never "safe". It searches only for entities it already knows about. On a 90-file
sample of the development corpus there were 230 distinct email addresses, 228 of
them not the user's. Emails have a regex and are swept automatically. **Names do
not have a regex.** That is what the semantic pass is for, and why it is
mandatory.

## The semantic pass only ever sees prose, which is 2.30% of the bytes

The candidates file is built from `text` blocks and nothing else, because
feeding a discovery pass the other 97.7% is how it starts inventing entities. A
third-party name that appears only in a tool result, a directory listing or a
code block never reaches the reader: they cannot declare it, and the residue
scan cannot look for what was never declared.

## A name touching a letter or a digit is left alone

The boundary rule is `(?<!\w)X(?!\w)`, with an underscore counting as a boundary
for spellings of five characters or more and a camel-case hump always counting,
which is what makes `mcp__<server>__tool` and `<Org>AI` real matches while
keeping `ray` inside `array` a correct non-match. What survives is a spelling
abutting an ordinary letter or digit: `<name>son`, `<org>123`. The manifest
reports that count and it is not zero. Scripts written without spaces between
words (Chinese, Japanese, Korean, Thai) have no boundary to test at all and are
flagged in the manifest instead.

## Case-insensitive matching is withheld from a few spellings

Spellings of four characters or more match in any casing. The exception is one
whose case change alters its **length**: Turkish dotted capital I lowercases to
two code units, German sharp s uppercases to two. Folding those would consume
the wrong span, so they stay literal. A miss rather than a corruption, which is
the right way round.

## Credentials and phone numbers are matched by shape, and only by shape

Anything with an unambiguous vendor prefix (`github_pat_`, `ghp_`, `sk-ant-`,
`xoxb-`, `AKIA`, `ntn_`, `AIza`, `sk-proj-`, `sk_live_`, `npm_`, `glpat-`,
`hf_`, `xapp-`, and the rest of one greppable list in `src/entities/seed.mjs`)
is force-replaced, and so is any `+<country code><8-15 digits>` phone number. So
is a value whose **label** says what it is: `api_key`, `secret_key`,
`access_token`, `auth_token`, `client_secret`, `password`, a `Bearer ` header,
an `X-Amz-` parameter in a signed URL, a password inline in a database URL. A
`-----BEGIN … PRIVATE KEY-----` block is dropped whole, because half a key is
still a key. An entropy heuristic would fire on every hash and uuid in your
logs, and a scan that cries wolf is the first thing switched off.

## A credential with no listed prefix and no label beside it is not detected

Nothing downstream recovers it. The semantic pass reads your prose and the
model's, never tool output, so a key printed by a command you ran is caught by
shape or not at all. The `0 secrets` row means "none of the shapes deident
knows", not "no secrets", and the export block says so as you run it.

## Identity-document numbers are found by their label, in English and Chinese only

`passport`, `national id`, `identity card`, `id card`, `driver's licence`,
`social security`, `ssn`, `tax id`, `fein`, and 護照, 护照, 身分證, 身份證,
台胞證, 居留證. Anchoring on the label is a measured precision decision: a
passport-shaped regex on its own matched a thermal-paste part number. **A number
labelled in any other language, or with no label near it, is not detected.**
Only the semantic pass can catch that one.

## `review.md` is full of raw identity, on purpose

Real absolute paths, real workspace names, real git remotes including other
people's handles, and the deny-list token that matched each excluded directory.
It has to be, or you could not recognise the rows you are deciding about. Treat
it like the salt: local only, never pasted into a ticket, never committed. Same
for `deident-candidates.txt`, which holds prose the semantic pass has not seen
yet.

## Device fingerprint survives

MCP server names are replaced, but the model mix, the harness version sequence,
the tool inventory and localhost ports remain inferable. Timestamps are
quantised to the minute, which removes millisecond-level correlation and nothing
more.

## Verbatim documents you pasted into your own messages are not detected

A contract, a résumé, a bank statement or someone else's email pasted into a
prompt is prose, and the semantic pass will only catch the identities it
recognises inside it. Quoted third-party writing survives as writing.

## The agent-memory deny-list matches filenames, and knows one naming convention

`MEMORY.md`, and files named `reference_*.md`, `feedback_*.md`, `project_*.md`,
`user_*.md`. That is one person's memory-index layout, not a Claude Code
universal. Harness injections inside `<system-reminder>` spans are stripped
whatever they are called, so the gap is narrower than it sounds: it is a memory
file a tool **read** for you, under another name, shipping as ordinary prose.
Put your own filenames in `~/.deident-private/denied.json`, a JSON array of
regex strings or `{"patterns": [...], "tokens": [...]}`. A malformed one refuses
the export rather than running with none of your rules.

## Fragments of an entity survive

Tool results are capped head-and-tail, and a cap can land in the middle of an
email address or a name. The remaining fragment matches no spelling, so neither
the substituter nor the scan sees it.

## Four of six upstream scoring axes depend on rules that are not published

Nobody outside the scoring pipeline knows what `failure_signal` is counted from,
what a "decision point" is, whether the prompt-quality run reads only user
messages, or whether the expertise classifier reads code content. If truncating
`tool_result` pushed `failure_signal` below its threshold, `hits_trouble` would
go false, Resilience would go null and the overall score would **rise**: the tool
would silently inflate scores. deident therefore caps tool results generously,
preserves `is_error` verbatim regardless of truncation, and keeps every threshold
named in `src/retain/constants.mjs`. Until those rules are published, treat
scores from a deident export as unverified against scores from raw logs.

## Subagent and workflow transcripts are not exported

Only depth-0 human sessions are read; the rest of the corpus is 2.2x the payload
with zero human turns. Orchestration stays visible through the parent session's
`Agent` and `Workflow` tool calls.
