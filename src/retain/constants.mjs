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

/** How many example occurrences a refusal or a review row prints. */
export const EXAMPLES_PER_REPORT = 5;

/** Characters of tier-0-cleaned prose written to the candidates file. */
export const CANDIDATE_EXCERPT_CHARS = 400;

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
export const DENIED_CONTENT = Object.freeze([
  /(^|[^a-z])MEMORY[.]md/i,
  /(reference|feedback|project|user)_[a-z0-9_]+[.]md/i,
  /[.](identity|investment|deident)-private/i,
  /shim-(hint[.]txt|dict[.]json)/i,
  /Spokenly[/\\]History/i,
  /private-archive|daily-logs/i,
  /[/\\]i94[/\\]/i,
  /(credentials|profile)[.]json/i,
]);

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
