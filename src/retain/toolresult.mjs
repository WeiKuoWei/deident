// `toolUseResult` distillation. BRIEF §4.1 / §4.2 / §4.3.
//
// §4.1: for an Edit, the tool_result content block is prose with ZERO line
// information ("The file ... has been updated successfully."), while
// `toolUseResult.structuredPatch` carries {oldStart, oldLines, newStart,
// newLines, lines[]} with +/- prefixes. structuredPatch is the ONLY
// machine-readable added-line count in the record.
//
// §4.2: net line count is not a substitute. Measured over 511 edits: true
// added 9,290, removed 5,338, net 3,952 — the net undercounts true added by
// 57.5%, and 123 edits (24.1%) have added>0 with net==0.
//
// §4.3: `null` and `0` are different, and `0` is the dangerous one. A wrong 0
// manufactures an "abandoned" session downstream and the existing partition
// invariant still sums correctly, so no test catches it.
//
// The patch body is code and is discarded after counting.

/**
 * @param {*} toolUseResult  the raw field; may be an object, a string, or absent
 * @returns {Readonly<{code_added_lines: number|null, code_removed_lines: number|null,
 *                     patch_hunks: number|null, form: string}>}
 */
export function distillToolResult(toolUseResult) {
  // PLAN C6: measured 20,583 object-valued and 1,304 string-valued. A typeof
  // guard is required before any field access, and the string form must not be
  // mistaken for "no result".
  if (typeof toolUseResult === 'string') {
    return frozen(null, null, null, 'string');
  }
  if (toolUseResult === null || toolUseResult === undefined) {
    return frozen(null, null, null, 'absent');
  }
  if (typeof toolUseResult !== 'object' || Array.isArray(toolUseResult)) {
    return frozen(null, null, null, 'other');
  }

  const patch = toolUseResult.structuredPatch;
  if (!Array.isArray(patch)) {
    // A Write with no patch, a Bash result, a Read result. Unknown, not zero.
    return frozen(null, null, null, 'no-patch');
  }
  if (patch.length === 0) {
    // Measured: 3,192 records carry structuredPatch, 2,352 of them non-empty.
    // An empty patch array means the edit produced no hunks — genuinely zero
    // added lines, which is a *known* zero and therefore not null.
    return frozen(0, 0, 0, 'empty-patch');
  }

  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const hunk of patch) {
    if (hunk === null || typeof hunk !== 'object' || !Array.isArray(hunk.lines)) {
      // One malformed hunk makes the whole count untrustworthy. Reporting a
      // partial count as if it were true is exactly the §4.3 failure.
      return frozen(null, null, null, 'malformed-patch');
    }
    hunks += 1;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }

  return frozen(added, removed, hunks, 'patch');
}

function frozen(added, removed, hunks, form) {
  return Object.freeze({
    code_added_lines: added,
    code_removed_lines: removed,
    patch_hunks: hunks,
    form,
  });
}

/**
 * The exported replacement for `toolUseResult`.
 *
 * Everything except the counts is dropped: `oldString`, `newString`,
 * `originalFile` and `structuredPatch.lines[]` are code (BRIEF §3, never
 * exported), and the remaining ~100 distinct keys observed across the corpus
 * are tool-specific bookkeeping already represented by the tool_result content
 * block. Dropping the lot also means a new tool cannot introduce an unreviewed
 * field into the export.
 */
export function retainToolUseResult(toolUseResult) {
  const d = distillToolResult(toolUseResult);
  const isError =
    toolUseResult !== null && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)
      ? toolUseResult.is_error === true || toolUseResult.isError === true || toolUseResult.error !== undefined
      : false;

  return Object.freeze({
    code_added_lines: d.code_added_lines,
    code_removed_lines: d.code_removed_lines,
    patch_hunks: d.patch_hunks,
    result_form: d.form,
    // §6 open question 1: is_error is a block-level flag that survives
    // truncation, and suppressing it is what would silently inflate OVR.
    ...(isError ? { is_error: true } : {}),
  });
}

/** I8, asserted rather than assumed. Returns null when the record is fine. */
export function checkAddedLines(distilled) {
  if (distilled.code_added_lines === null) return null;
  if (!Number.isInteger(distilled.code_added_lines) || distilled.code_added_lines < 0) {
    return `code_added_lines is ${distilled.code_added_lines}, which is neither a non-negative integer nor null`;
  }
  if (distilled.form === 'no-patch' || distilled.form === 'string' || distilled.form === 'absent') {
    return `code_added_lines is ${distilled.code_added_lines} for form "${distilled.form}", where the count is unknown and must be null`;
  }
  return null;
}
