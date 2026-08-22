// Walk a parsed record immutably, applying substituteString to every string.
//
// BRIEF §4.6: parse the line, substitute inside DECODED strings, re-serialize.
// That is the only way `C:\\Users\\devuser` inside an embedded JSON string and
// `C:\Users\devuser` in ordinary prose are both reachable by one entity table.
//
// Object KEYS are substituted too: a key can carry a path (file-history maps
// are keyed by absolute filename), and a key that leaks is as identifying as
// a value that leaks.

import { substituteString } from './engine.mjs';

/**
 * @param {*} record  a parsed JSON value
 * @param {object} table
 * @returns {{record: *, strings: Array<{path:string, before:string, after:string, spans:object[]}>}}
 *   `strings` carries every string that changed, for the substitution
 *   invariant (I2). Unchanged strings are not recorded: they cannot fail it.
 *
 * There is no flat `spans` array. It used to be accumulated here with
 * `allSpans.push(...spans)` and no caller ever read it: the pipeline uses
 * `record` and `strings` only. Spreading an array into `push` passes every
 * element as an argument, so one decoded string holding ~125,000 entity spans
 * — a 762 KB session file is enough — overflowed the argument stack and the
 * whole export died with "Maximum call stack size exceeded" reported as
 * "a bug in deident". Every span is still carried, per string, in `strings`.
 */
export function substituteRecord(record, table) {
  const changed = [];
  const out = walk(record, table, '', changed);
  return { record: out, strings: changed };
}

// Substitution runs to a FIXPOINT, not once.
//
// A replacement changes the text around the next candidate, and the boundary
// rule reads that text. Measured on a real export: `devusergitroll.onmicrosoft`
// held the username handle glued to the org name, so the handle was a correct
// embedded non-match on the first pass — and once the org became `X_ORG_7252582`
// the handle stood at a camel-case boundary in the output, plainly visible. The
// residual scan reads the FINAL bytes, so it saw the leak and the substituter
// never could: two passes that legitimately disagree because the text changed
// between them, which is a permanently red gate rather than a bug in either.
//
// Every pass after the first runs under the pseudonym guard, so the fixpoint
// can never eat its own output, and each pass records its own before/after so
// I2 is proved per pass exactly as it is for tier 0 versus tier 1.
const MAX_PASSES = 3;

function walk(value, table, keyPath, changed) {
  if (typeof value === 'string') {
    let current = value;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const { out, spans } = substituteString(current, table, pass === 0 ? undefined : table.repassGuard);
      if (spans.length === 0) break;
      changed.push(Object.freeze({ path: keyPath, before: current, after: out, spans }));
      current = out;
    }
    return current;
  }

  if (Array.isArray(value)) {
    let mutated = false;
    const next = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      next[i] = walk(value[i], table, `${keyPath}[${i}]`, changed);
      if (next[i] !== value[i]) mutated = true;
    }
    return mutated ? next : value;
  }

  if (value !== null && typeof value === 'object') {
    let mutated = false;
    const next = {};
    for (const [k, v] of Object.entries(value)) {
      let nextKey = k;
      for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const r = substituteString(nextKey, table, pass === 0 ? undefined : table.repassGuard);
        if (r.spans.length === 0) break;
        changed.push(Object.freeze({ path: `${keyPath}.<key>`, before: nextKey, after: r.out, spans: r.spans }));
        nextKey = r.out;
        mutated = true;
      }
      const nextValue = walk(v, table, `${keyPath}.${k}`, changed);
      if (nextValue !== v) mutated = true;
      next[nextKey] = nextValue;
    }
    return mutated ? next : value;
  }

  // number, boolean, null — nothing to substitute and nothing to copy.
  return value;
}

/**
 * Collect every string in a record, for tier-1 candidate extraction and for
 * the residual scan's in-memory pre-check. Read-only.
 */
export function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
  return out;
}
