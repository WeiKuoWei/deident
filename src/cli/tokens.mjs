// What reading a file deident just wrote will cost the reader, in tokens.
//
// The tier-1 semantic pass is the only stage whose cost grows with the corpus
// (docs/design-rationale.md, "What the stages cost": about 3.5 MB), and the
// person was handed deident-candidates.txt with no idea what reading it cost.
//
// These numbers are DISPLAY calibration, not policy: changing one moves a
// printed estimate and moves not one byte of what the export ships. That is
// why they live here rather than in retain/constants.mjs, which holds the
// thresholds that decide what leaves the machine.

/**
 * Characters written in a script that does not tokenize at the Latin rate.
 *
 * Han, Kana and Hangul only, deliberately, because the line the report prints
 * says "CJK" and a count has to mean its label. src/entities/variants.mjs
 * SPACELESS_RE is the wider class (it adds Thai, Lao, Khmer, Myanmar,
 * Tibetan) and is not reused here: report.mjs already carries the fix for a
 * count that said "CJK" while flagging every non-Latin script, and repeating
 * that in a second place is how a disclosure ends up naming the wrong writing
 * system twice.
 *
 * ponytail: Thai and Khmer are dense too and are counted here at the Latin
 * rate, so a Thai corpus is under-estimated by roughly 4x. The corpus this was
 * measured against is mixed zh/en (BRIEF §7). Widen the class and widen the
 * label together, or not at all.
 */
const CJK_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;

/**
 * The two rates.
 *
 * Measured on the real candidates file: 459,747 characters, 131,895 of them
 * (29%) CJK. CJK runs at roughly one token per character and Latin at roughly
 * one per four, so one divisor over the whole file is wrong by a factor of
 * four in one direction or the other depending on the mix. The mix is the
 * reason this file exists rather than a division.
 */
const CJK_TOKENS_PER_CHAR = 1;
const LATIN_CHARS_PER_TOKEN = 4;

/**
 * The reader's own reasoning tokens, as a share of what it read. Roughly 20%
 * is the right order for a reasoning model on this task.
 *
 * Output tokens are not estimated separately: an entity list is a few hundred
 * tokens beside a six-figure input, and a row for it would be false precision
 * dressed as thoroughness.
 */
const REASONING_SHARE = 0.2;

/**
 * Three significant figures, and never finer than a whole token.
 *
 * 213,858 prints as 214,000 and 7,043 as 7,000. The estimate is not accurate
 * to the last token, and printing it as though it were invites the reader to
 * trust it further than it deserves. The floor at one token is what keeps a
 * small file from rounding up to a thousand.
 */
export function roundEstimate(value) {
  if (!(value > 0)) return 0;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 2);
  return Math.round(value / step) * step;
}

/**
 * Input tokens for one file, split by script.
 *
 * Both counts are taken in a loop rather than with `[...text].length` and
 * `String.match`: the candidates file is measured in MB (11.6 MB on the
 * 2026-08-24 corpus), and both of those allocate one string per character of
 * it to produce one number.
 *
 * `chars` counts CODEPOINTS, not UTF-16 units, because a rarer Han character
 * is one character to the reader and two to `String.length`, and it is the
 * reader's cost this is estimating.
 */
export function estimateTokens(text) {
  let chars = 0;
  for (const _ of text) chars += 1;

  let cjkChars = 0;
  // A fresh regex per call rather than a module-level global one: a shared
  // lastIndex is state, and this is the only mutable thing in the file.
  const scan = new RegExp(CJK_RE.source, 'gu');
  while (scan.exec(text) !== null) cjkChars += 1;

  const inputTokens = Math.round(
    cjkChars * CJK_TOKENS_PER_CHAR + (chars - cjkChars) / LATIN_CHARS_PER_TOKEN,
  );
  return Object.freeze({ chars, cjkChars, inputTokens });
}

/**
 * The whole estimate: one headline, then a row per file.
 *
 * The headline carries the reader's reasoning share and the rows do not,
 * because the rows are what is in the files and the share is not.
 *
 * @param {ReadonlyArray<{label: string, estimate: ReturnType<estimateTokens>}>} rows
 */
export function tokenCost(rows) {
  const input = rows.reduce((sum, r) => sum + r.estimate.inputTokens, 0);
  return Object.freeze({
    total: roundEstimate(input * (1 + REASONING_SHARE)),
    reasoningPercent: Math.round(REASONING_SHARE * 100),
    files: Object.freeze(
      rows.map((r) =>
        Object.freeze({
          label: r.label,
          tokens: roundEstimate(r.estimate.inputTokens),
          chars: r.estimate.chars,
          cjkChars: r.estimate.cjkChars,
          cjkPercent: r.estimate.chars === 0 ? 0 : Math.round((r.estimate.cjkChars / r.estimate.chars) * 100),
        }),
      ),
    ),
  });
}
