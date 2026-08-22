// The "NOT protected against" block, in ONE place.
//
// cli-ux §6: this is the honesty mechanism, and "it must also not list
// something the tool DOES handle. MCP server names sat in this block while
// seed.mjs was adding them to the entity list — a disclosure hiding an
// implemented-but-inert control, which is worse than either honest option."
//
// It was then fixed in report.mjs and missed in the two files that also print
// it. Measured 2026-08-22: review.html and the --preview file both still read
// `device fingerprint: MCP server names, …` for a run whose entity table
// replaced 2,864 MCP names, and neither carried the residue line or the
// embedded-occurrence count that the terminal manifest carries. Three copies
// of a security disclosure is three chances to be wrong; there is one now, and
// report.mjs, preview.mjs and reviewfile.mjs all render it.

/** What survives every control this tool has. Nothing measured goes here. */
// One line per item: every renderer prints them as a list, and a wrapped
// second line becomes a bullet of its own in review.html.
export const ALWAYS = Object.freeze([
  'device fingerprint: localhost ports, model mix, CLI version sequence',
  'verbatim documents a tool read for you, not only ones you pasted yourself',
  'third-party names the semantic pass missed, and facts that are not names at all: a shareholding, a rate, a balance',
  'your own account inventory: vault item names, login ids, which tokens are live',
  'ids from a service deident does not sweep: a board, document or channel id',
]);

/**
 * The block, including the counters that make it specific to THIS export.
 *
 * @param {object} m  the manifest, or {} for a surface that has not run an
 *   export (review.html before `deident export`).
 * @returns {ReadonlyArray<string>} lines, unindented.
 */
export function limitLines(m = {}) {
  const n = (v) => Number(v ?? 0).toLocaleString('en-US');
  const lines = [...ALWAYS];

  if (m.unknownTypes && m.unknownTypes.length > 0) {
    lines.push(`${m.unknownTypes.map((u) => `${u.type} (${n(u.count)})`).join(', ')}`);
    lines.push('  dropped unread under --skip-unknown-types');
  }
  if (m.embedded > 0) {
    // `ray` inside `array` is the case §4.5's boundary rule exists for and is a
    // CORRECT non-match. `_` is in the same character class, so a filename like
    // `contract_<name>.pdf` is left alone too, and calling that "inside a longer
    // word" would be the reassuring phrasing this tool is supposed to avoid.
    lines.push(`${n(m.embedded)} known-entity spellings abut an ordinary letter or digit`);
    lines.push('  (<name>son, <org>123) and were left alone under the §4.5 boundary rule');
  }
  if (m.escapeArtifacts > 0) {
    // A match that begins immediately after an odd run of backslashes is inside
    // a JSON escape, so in the DECODED string those bytes are not the entity.
    // The exemption is right and the outcome is still that grep finds the
    // spelling in the shipped file, which is what a recipient actually does.
    lines.push(`${n(m.escapeArtifacts)} spellings are legible in the raw bytes but not in the decoded`);
    lines.push('  text, because a JSON escape ends where the spelling begins');
  }
  if (typeof m.residueLine === 'string') {
    lines.push(`known-entity residue: ${m.residueLine}`);
  }
  return Object.freeze(lines);
}
