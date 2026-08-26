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

## Every byte is a defined value or prose somebody read, except tool parameters

Every byte in the archive is either a value from a vocabulary this tool defines
in its own source, or a line of prose that a person read on screen. The one
exception is the parameters of your tool calls, described two sections down.

This used to be false, and the section here used to explain why rather than fix
it. The candidates file is built from `text` blocks and nothing else, because
feeding a discovery pass the rest is how it starts inventing entities, and the
rest was mostly tool results: the export was corpus-minus-detections, and every
miss in the part nobody read was invisible rather than merely undetected.

Twenty holes were reproduced against the shipped code on 2026-08-25. Sorted by
where the bytes came from rather than by which module missed them, seventeen
were in machine output: percent-encoded CJK, HTML character references, Python
bytes-repr, base64, zero-width characters, a gcloud token, the secret half of
an AWS credential pair, cloud account identifiers. Nobody types base64 of a
colleague's name into a prompt. A program emits it, and the only route program
output took into the archive was a tool result.

So tool results now leave as shape alone, and the archive is empty plus
admissions: material in a language, an encoding or a format nobody anticipated
is unrecognised, and unrecognised means absent.

Measured on an archive built from the live corpus, before and after:

| | before | after |
|---|---|---|
| archive, uncompressed | 12.28 MB | 9.08 MB |
| tool result payload | 3.54 MB (28.8%) | 0 |
| tool result shape | — | 0.32 MB (3.6%) |
| prose a reader was shown | 2.69 MB (21.9%) | 2.69 MB (29.6%) |
| tool call parameters | 1.48 MB (12.0%) | 1.48 MB (16.3%) |
| record scaffolding and minted ids | 4.40 MB (35.8%) | 4.40 MB (48.4%) |

## The cost: scoring that reads result CONTENT gets less than it did

Naming this rather than letting a consumer discover it. If your pipeline greps
tool output for build failures, counts test names, or reads a diff body out of
a result, that input is gone. What survives per result is `is_error`,
`result_bytes`, the tool name on the paired `tool_use` block, and the
`code_added_lines` / `code_removed_lines` / `patch_hunks` counts distilled from
`structuredPatch`, which are unchanged. Scoring that reads result SHAPE is
unaffected.

## The parameters of your tool calls are read by nobody

The path you read, the command you ran, the search pattern, the brief you gave
a subagent. These are free text, they are in the archive, and the candidates
file is built from prose blocks, so no reader is shown them and the semantic
pass never sees them. Measured on the archive above: 1.48 MB of 9.08 MB, 16.3%.

They are the model's own words rather than a program's output, so the encodings
that made tool results unreadable are rare here: measured over 250 corpus files,
zero-width characters appear 5 times in parameters against 1,468 in tool
results, and `\uXXXX` escapes 847 times against 45,699. Ordinary English and
ordinary paths are what this surface actually holds. It is still a surface no
reader checks, and a third-party name that appears only there cannot be
declared.

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

Nothing downstream recovers it: the semantic pass reads your prose and the
model's, and a value with no prefix and no label reads as an ordinary token to
a person as well as to a regex. The `0 secrets` row means "none of the shapes
deident knows", not "no secrets", and the export block says so as you run it.

A key **printed by a command you ran** is no longer one of these cases. That was
the largest instance of this limit and it is closed by construction: tool output
does not ship. Measured on the archive built from the live corpus, the secrets
row went from 168 replacements over 17 distinct values to 81 over 10, and the
seven that vanished were values that existed nowhere but tool output. They are
now absent rather than substituted. What is left is a credential you typed, or
one named in a tool parameter.

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
universal. Put your own filenames in `~/.deident-private/denied.json`, a JSON
array of regex strings or `{"patterns": [...], "tokens": [...]}`. A malformed
one refuses the export rather than running with none of your rules.

The gap this list used to leave was a memory file a tool **read** for you, under
another name, shipping as ordinary prose. That route is closed: nothing a tool
read ships as text, whatever it was called. Harness injections inside
`<system-reminder>` spans are stripped whatever they are called too. What the
list still gates is where a filename is **named**: a tool parameter, and an
attachment.

## Four of six upstream scoring axes depend on rules that are not published

Nobody outside the scoring pipeline knows what `failure_signal` is counted from,
what a "decision point" is, whether the prompt-quality run reads only user
messages, or whether the expertise classifier reads code content. Until those
rules are published, treat scores from a deident export as unverified against
scores from raw logs.

The specific fear this section used to record is now moot rather than answered.
It ran: if truncating `tool_result` pushed `failure_signal` below its threshold,
`hits_trouble` would go false, Resilience would go null and the overall score
would **rise**, so the caps were set generously and named in
`src/retain/constants.mjs`. There is no cap to set generously any more, because
nothing is kept to truncate. `is_error` is still preserved verbatim, which was
always the load-bearing half of that hedge, and a consumer that read
`failure_signal` off result TEXT is covered by the cost section above.

## Subagent and workflow transcripts are not exported

Only depth-0 human sessions are read; the rest of the corpus is 2.2x the payload
with zero human turns. Orchestration stays visible through the parent session's
`Agent` and `Workflow` tool calls.
