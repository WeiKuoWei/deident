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
 * @returns {{record: *, spans: object[], strings: Array<{path:string, before:string, after:string, spans:object[]}>}}
 *   `strings` carries every string that changed, for the substitution
 *   invariant (I2). Unchanged strings are not recorded: they cannot fail it.
 */
export function substituteRecord(record, table) {
  const changed = [];
  const allSpans = [];
  const out = walk(record, table, '', changed, allSpans);
  return { record: out, spans: allSpans, strings: changed };
}

function walk(value, table, keyPath, changed, allSpans) {
  if (typeof value === 'string') {
    const { out, spans } = substituteString(value, table);
    if (spans.length > 0) {
      changed.push(Object.freeze({ path: keyPath, before: value, after: out, spans }));
      allSpans.push(...spans);
    }
    return out;
  }

  if (Array.isArray(value)) {
    let mutated = false;
    const next = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      next[i] = walk(value[i], table, `${keyPath}[${i}]`, changed, allSpans);
      if (next[i] !== value[i]) mutated = true;
    }
    return mutated ? next : value;
  }

  if (value !== null && typeof value === 'object') {
    let mutated = false;
    const next = {};
    for (const [k, v] of Object.entries(value)) {
      const { out: nextKey, spans: keySpans } = substituteString(k, table);
      if (keySpans.length > 0) {
        changed.push(Object.freeze({ path: `${keyPath}.<key>`, before: k, after: nextKey, spans: keySpans }));
        allSpans.push(...keySpans);
        mutated = true;
      }
      const nextValue = walk(v, table, `${keyPath}.${k}`, changed, allSpans);
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
