// Every threshold, cap and toggle in the codebase.
//
// BRIEF §6 posture: four of six scoring axes depend on rules that are not in
// any local repo, so prefer preserving evidence over shrinking bytes wherever
// the two conflict, and make every truncation threshold a named constant in
// ONE file so it can be changed without a rewrite.
//
// No literal number with a policy meaning appears anywhere else.

/**
 * tool_result head/tail caps.
 *
 * BRIEF §6 open question 1 is unresolved: nobody here knows what
 * `failure_signal` is counted from. Measured, an 800+400 byte cap destroyed
 * 98.7% of tool_result bytes and 23.9% of blocks exceed 1200 B. If truncating
 * pushes failure_signal below 3, `hits_trouble` goes false, Resilience goes
 * null, and OVR RISES — the tool would silently inflate scores.
 *
 * So these are set generously, not tightly, and `is_error` is preserved
 * verbatim regardless of truncation. Shrink them only after that question is
 * answered.
 */
export const TOOL_RESULT_HEAD_BYTES = 4000;
export const TOOL_RESULT_TAIL_BYTES = 2000;

/** The marker written between head and tail. Counted, never silent. */
export const TRUNCATION_MARKER = (omitted) => `\n…[${omitted} bytes omitted by deident]…\n`;

/**
 * BRIEF §6 posture again: thinking blocks are agent reasoning and are the
 * single largest byte lever. They are kept, and this is the knob to turn if
 * export size ever actually bites.
 */
export const KEEP_THINKING_BLOCKS = true;

/** §F4: quantise timestamps to the minute. Millisecond stamps fingerprint. */
export const TIMESTAMP_QUANTUM_MS = 60_000;

/**
 * Tool parameters whose value is code, not prose. BRIEF §3: code content is
 * never exported; it is replaced by a count.
 */
export const CODE_VALUED_TOOL_PARAMS = Object.freeze([
  'content',
  'new_string',
  'old_string',
  'edits',
]);

/** Minimum spelling length before an entity may be substituted at all. */
export const MIN_ENTITY_LENGTH = 3;

/** Minimum codepoint length for a CJK-only entity (BRIEF §4.5). */
export const MIN_CJK_ENTITY_CODEPOINTS = 2;

/**
 * How long a string has to be before it counts as "the same text".
 *
 * A cwd-less record (last-prompt, queue-operation, mode) is dropped only when
 * it REPLAYS something authored inside an excluded directory, and the test for
 * that is an exact string match against the excluded lines. Short strings are
 * useless for it: `"user"`, `"text"` and every JSON key appear on both sides,
 * so a floor is what keeps the test from matching everything.
 */
export const MIN_REPLAY_MATCH_CHARS = 40;

/** How many example occurrences a refusal or a review row prints. */
export const EXAMPLES_PER_REPORT = 5;

/**
 * Characters of one prose chunk written to the candidates file.
 *
 * This replaces a 400-character cap that dropped 76.2% of the prose and
 * counted none of it. Removing the cap outright was measured over a copy of
 * the whole depth-0 corpus (216 files, 934 MB, one namespace shift, unclassified
 * workspaces skipped): the candidates file goes from 2,957,659 to 13,026,553
 * bytes, against the 915 KB docs/cli-ux.md §11b budgets for the stage. So a cap
 * stays.
 *
 * The value is taken from the measured post-retention distribution rather than
 * guessed. Over the twelve largest sessions, 17,466 prose chunks: p50 62
 * characters, p90 236, p95 404, p99 1,562, longest 10,045. At 20,000 the cap
 * fires on nothing that corpus contains, which is the point: it bounds the
 * pathological single chunk BRIEF measured at 938,529 characters (a pasted
 * document, a dumped log) without touching prose anybody wrote.
 *
 * Most of the growth is the dedupe change, not the cap, and that half is not
 * restorable: the old key was a chunk's first 80 characters and it discarded
 * 1,590 chunks (10,443,749 characters) that were not identical to the chunk
 * that claimed the key. No cap value brings this file near 915 KB without
 * reinstating exactly that silent loss.
 *
 * Whatever this cap does drop is counted and printed, in the file and in the
 * report. A silent cap is what made the old one a disclosure.
 */
export const CANDIDATE_CHUNK_CHARS = 20_000;

/**
 * Content that must not leave even when the session around it may.
 *
 * privacy-tiers 4 assumed the unit of decision is a session. It is not. This
 * machine's harness injects the owner's memory index, dictation hint list and
 * personal-data files into unrelated sessions as attachments and tool results,
 * so a per-session decision has to throw away an hour of clean engineering to
 * remove four lines it never asked for. Measured on the 2026-08-22 export:
 * dropping every session that carried one of these took the archive from 35
 * sessions to 17, and not one of those sessions was ABOUT the private matter.
 *
 * So the block is dropped and the session stays. Matched against a file path,
 * a filename, or the first part of a tool result's own text.
 */
// ONLY patterns that are true of the AGENT, not of one person. The first
// draft of this list carried the author's own dictation app, his immigration
// folder and a directory named after a real human. In a shared repository
// that is a disclosure, and for every other user it is dead weight. Anything
// machine-specific belongs in DENIED_USER_FILENAME beside the salt, where it
// is per-person by construction and is never committed.
export const DENIED_CONTENT = Object.freeze([
  // The agent's own memory store, whatever a given user keeps in it.
  /(^|[^a-z])MEMORY[.]md/i,
  /(reference|feedback|project|user)_[a-z0-9_]+[.]md/i,
  // A dotted directory whose own name says it is private.
  /[.][a-z0-9-]{2,24}-private[/\\]/i,
  // Filenames that are a credential or an identity record by convention.
  /(credentials|profile)[.]json/i,
]);

/** Per-person additions, read from beside the salt. Never in the repository. */
export const DENIED_USER_FILENAME = 'denied.json';

/**
 * A deny-listed directory named ANYWHERE in a value, not only as the cwd.
 *
 * BRIEF §4.11 says per-directory opt-in, never opt-out, and privacy-tiers §4
 * claims three levels of granularity make the deny-list sufficient. All three
 * test where the agent WAS, never what it TOUCHED, so a Read, an Edit or a
 * directory listing of a deny-listed path from an allowed cwd was invisible to
 * every one of them. Measured on a real export: files under
 * `…ops-handover\\private\\` were named 17, 36 and 5 times
 * (`vendor-search\\SCORECARD.md`, `VENDOR-BRIEF.md`,
 * `calc.mjs`) — the parent got a WORKSPACE pseudonym and the subpath
 * below it did not — and a `[chat]…txt` from the archive of private messages was named
 * by a directory listing run from an included directory.
 *
 * The token has to sit inside a path SEGMENT: a separator, then segment
 * characters (no spaces, no quotes), then the token. That is what keeps it off
 * the sentence "at /home and private things".
 */
// Generic only. Per-person tokens arrive from beside the salt; see
// policy/userdeny.mjs and the segment test in records.mjs, which is what
// applies them.
const DENY_PATH_TOKENS = ['private', 'identity', 'payroll'];
export const DENIED_PATH_RE = new RegExp(
  '[\\\\/][^\\\\/\\s"' + String.fromCharCode(39) + '`]{0,60}?(?:' +
    DENY_PATH_TOKENS.join('|') +
    ')',
  'i',
);

/**
 * The reason string a denied PATH puts in the export.
 *
 * Deliberately generic: the deny tokens themselves are `private`, `payroll`,
 * `identity`, and a person may add their own, one of which was a real name.
 * review.md says
 * which token matched because review.md is local; the marker inside the
 * archive is read by the recipient.
 */
/**
 * The same, for a path that BEGINS with the deny-listed segment.
 *
 * DENIED_PATH_RE requires a separator BEFORE the token, so a relative path
 * quoted as `private/vendor-search/COST-COMPARISON.md:17:` matched nothing —
 * measured, that shape survived a real export inside grep output. Requiring a
 * separator AFTER the segment instead is what keeps this off the ordinary
 * English sentence "a private repo": there the next character is a space.
 */
export const DENIED_PATH_HEAD_RE = new RegExp(
  '(?:^|[\\s"' + String.fromCharCode(39) + '`(=])[^\\\\/\\s"' + String.fromCharCode(39) + '`]{0,60}?(?:' +
    DENY_PATH_TOKENS.join('|') +
    ')[^\\\\/\\s"' + String.fromCharCode(39) + '`]{0,60}?[\\\\/]',
  'i',
);

export const DENIED_PATH_REASON = 'a deny-listed directory';

/**
 * One path-shaped token inside ordinary prose.
 *
 * Prose is not a file listing: withholding a whole assistant turn because it
 * mentions a path would throw away the scoring evidence the export exists for.
 * The path itself is what must not ship, so the path itself is what goes.
 * Measured on a real export, in assistant prose rather than tool output:
 * `…/private/vendor-search/SCORECARD.md` and
 * `WORKSPACE_n/private/WORKSPACE_m/VENDOR-BRIEF.md`.
 */
export const PATH_TOKEN_RE = /[^\s"'`,;()\[\]{}<>]*[\\\\/][^\s"'`,;()\[\]{}<>]*/g;

/** What replaces one withheld path token. Short, and it names no directory. */
export const DENIED_PATH_MARKER = '[path withheld by deident]';

/** What replaces a denied block. Counted, never silent. */
export const DENIED_MARKER = (bytes, why) =>
  `[${bytes} bytes withheld by deident: ${why}]`;

/**
 * Harness-injected spans inside an otherwise authored message.
 *
 * None of this was typed by the user or written by the model: the harness
 * splices it in at send time, and it is where the memory index, the recalled
 * memories and local command output ride into a session that has nothing to
 * do with them. Removing it loses no authored content.
 */
export const INJECTED_SPANS = Object.freeze([
  /<system-reminder>[^]*?<[/]system-reminder>/g,
  /<local-command-stdout>[^]*?<[/]local-command-stdout>/g,
  /<local-command-stderr>[^]*?<[/]local-command-stderr>/g,
]);

/**
 * Prose whose subject is a live credential, withheld as a whole block.
 *
 * String-level substitution needs the exact literal, and a reviewer looking at
 * a recovery kit or a vault map cannot promise to have enumerated every way it
 * is written across a long session. On 2026-08-22 that gap is what forced two
 * sessions out whole: "truncated in the quotes, so complete string removal
 * cannot be guaranteed".
 *
 * A block is coarser than a string and that is the point. Losing a paragraph
 * is cheap; a key that leaves cannot be recalled, and it does not care who was
 * holding it.
 */
export const DENIED_TEXT = Object.freeze([
  /1Password[- ]?Emergency[- ]?Kit/i,
  /Emergency Kit/i,
  /Secret Key[ ]*[:：]/i,
  /master password/i,
  /(recovery|backup) codes?[ ]*[:：]/i,
  /備份碼|復原碼/,
  /X-Amz-Security-Token/i,
]);
