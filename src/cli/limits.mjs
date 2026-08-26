// The "NOT protected against" block, in ONE place.
//
// cli-ux §6: this is the honesty mechanism, and "it must also not list
// something the tool DOES handle. MCP server names sat in this block while
// seed.mjs was adding them to the entity list, a disclosure hiding an
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
// Three entries left this list when the tool_result payload was deleted, and
// they left because they became FALSE, which is the only reason an entry may
// leave. cli-ux §6: a disclosure hiding an implemented control is worse than
// either honest option, and so is a disclosure of a route that no longer
// exists, because it teaches a reader to distrust the rows that are real.
//
//   "verbatim documents a tool read for you"   a tool result ships as a byte
//                                              count now. Nothing a tool read
//                                              reaches the archive as text.
//   "…a key a command printed for you is       a key a command printed for you
//    caught by shape or not at all"            is not in the export at all.
//
// The agent-memory line did NOT leave, and nearly did. Its wording was about a
// memory file a tool READ for you, which is the closed route; the deny-list
// underneath it still decides two live questions, whether a tool_use parameter
// may name that file and whether an attachment carrying it survives. A user
// whose memory files are named otherwise still needs to be told, and still has
// denied.json as the remedy. So the line is narrowed rather than removed.
//
// What replaced them is narrower and true: the parameters of the tool calls.
export const ALWAYS = Object.freeze([
  'device fingerprint: localhost ports, model mix, CLI version sequence',
  'names the semantic pass missed, yours included, and facts that are not names: a shareholding, a rate, a balance',
  'the bare NAME of a file or directory you discussed, where prose quotes it without a path',
  'your own account inventory: vault item names, login ids, which tokens are live',
  'ids from a service deident does not sweep: a board, document or channel id',
  // Measured on the archive built from the live corpus: 1.48 MB of 9.08 MB,
  // 16.3%. It is the only free text left in the export that no reader sees,
  // and it is the model's own words rather than a program's output, so the
  // encodings that made tool results unreadable are rare here and ordinary
  // English is not. A path, a shell command, a search pattern, and the brief
  // one agent writes to another all ride in on this.
  'the parameters of your tool calls: the path you read, the command you ran, the',
  '  brief you gave a subagent. The candidates file is built from prose, so these',
  '  go in front of no reader and the semantic pass never sees them',
  // The manifest prints `0 secrets  0 replaced` six lines above this block, as
  // a zeros row whose whole purpose is to be believed. Enumerating vendor
  // prefixes stays reactive forever, so the affirmative zero has to say what
  // it is a zero OF. Only the shapes that really are unswept are named here:
  // a labelled value, a Bearer header, a signed URL, an inline database
  // password and a private key body all have a sweep or a deny rule now, and
  // cli-ux §6 says a disclosure hiding an implemented control is worse than
  // either honest option.
  'agent memory NAMED in a tool parameter or arriving as an attachment, under a',
  '  filename deident does not know: only MEMORY.md and',
  '  reference_/feedback_/project_/user_*.md are recognised, which is one person\'s',
  '  naming convention. Put your own in denied.json beside the salt. A memory file',
  '  a tool READ for you is no longer a case: tool output does not ship',
  'a credential with no listed vendor prefix and no label beside it. The 0 secrets',
  '  row above means "none of the shapes it knows", not "no secrets". A key a',
  '  command PRINTED for you is no longer a case: tool output does not ship. One',
  '  you typed, or one named in a tool parameter, is caught by shape or not at all',
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
  if (m.gluedOccurrences > 0) {
    // Named separately from the `embedded` total above, because this is the
    // slice a reader can do something about: it is their OWN username or git
    // identity, and the terminal prints the rows and the excerpts. Measured
    // 2026-08-24: 14 such occurrences shipped in cloud resource names beside a
    // printed `known-entity residue 0`.
    lines.push(`${n(m.gluedOccurrences)} occurrences of your own username or git identity are joined to`);
    lines.push('  letters or digits (yourname-prod) and were left alone by the same rule');
  }
  if (m.gluedNotListed && m.gluedNotListed.length > 0) {
    // The rows above stop at the letter test, and renderGluedResidue prints
    // nothing at all when there are no rows. So for a three- or
    // four-character username whose occurrences are all letter-blocked the
    // reader sees a green `known-entity residue 0` and an absent list, and an
    // absent list reads as a clean result. It is not: it is not examined.
    const total = m.gluedNotListed.reduce((a, r) => a + Number(r.count ?? 0), 0);
    const named = m.gluedNotListed.map((r) => `"${r.spelling}"`).join(', ');
    lines.push(`${n(total)} more occurrences of ${named} sit against a LETTER and are not`);
    lines.push('  among those rows: under five characters that list is mostly ordinary');
    lines.push('  words (ray inside array), so it is withheld rather than shown. No row');
    lines.push('  here means not examined, not clean. grep the archive before you send it.');
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
