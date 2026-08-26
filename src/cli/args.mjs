// Flag table and argv parsing. PLAN §6.1 / §6.2.
// Returns a frozen options object, or throws UsageError. No I/O here.

import { parseArgs } from 'node:util';
import { UsageError } from './errors.mjs';
import { DEFAULT_TRIAGE_CHARS, MAX_TRIAGE_CHARS } from '../policy/triage.mjs';
import { CANDIDATE_BATCH_CHARS } from '../retain/constants.mjs';

export const COMMANDS = Object.freeze(['scan', 'review', 'triage', 'export']);

// flag -> {type, multiple?, commands}. `commands: null` means every command.
const FLAGS = Object.freeze({
  root: { type: 'string', commands: null },
  out: { type: 'string', commands: ['scan', 'review', 'triage', 'export'] },
  'salt-dir': { type: 'string', commands: null },
  html: { type: 'boolean', commands: ['review'] },
  entity: { type: 'string', commands: ['review'] },
  session: { type: 'string', commands: ['review'] },
  preview: { type: 'boolean', commands: ['export'] },
  entities: { type: 'string', commands: ['export'] },
  // Ignore the record of what has already been read and put the whole corpus
  // in front of a reader again. For a person who has changed their mind about
  // what counts as an identity, whose only other route is deleting a file they
  // would have to be told the path of.
  full: { type: 'boolean', commands: ['export'] },
  namespace: { type: 'string', commands: ['export'] },
  'skip-unclassified': { type: 'boolean', commands: ['export'] },
  'skip-unreadable': { type: 'boolean', commands: ['scan', 'export'] },
  'skip-unknown-types': { type: 'boolean', commands: ['scan', 'export'] },
  'include-denied': { type: 'string', multiple: true, commands: ['export'] },
  // An encoding of the values already in hand at each render call, not a
  // second code path. The settled operator is an agent, and the alternative is
  // parsing padded columns whose width is data-dependent.
  json: { type: 'boolean', commands: ['scan', 'review', 'triage', 'export'] },
  // triage writes a file for a reader, then reads that reader's answer back.
  // Two directions, one command, because they are one contract: the file states
  // the rubric the verdicts are judged against.
  apply: { type: 'boolean', commands: ['triage'] },
  verdicts: { type: 'string', commands: ['triage'] },
  'triage-chars': { type: 'string', commands: ['triage'] },
  // How much prose one run puts in the candidates file before deferring the
  // rest. A knob rather than a constant because the right value is the
  // reader's context window, which the tool cannot see.
  'batch-chars': { type: 'string', commands: ['export'] },
  // Global, command-less.
  help: { type: 'boolean', commands: null },
  version: { type: 'boolean', commands: null },
  selftest: { type: 'boolean', commands: null },
});

const NAMESPACE_RE = /^[A-Z][A-Z0-9]{0,7}$/;

const parseOptions = Object.fromEntries(
  Object.entries(FLAGS).map(([name, spec]) => [
    name,
    { type: spec.type, ...(spec.multiple ? { multiple: true } : {}) },
  ]),
);

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {Readonly<object>} {command, flags, mode}
 *   mode is one of 'usage' | 'version' | 'selftest' | 'command'
 */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: parseOptions,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    // node:util names the offending token in its first sentence and then adds
    // a paragraph about `--`. Keep the sentence; the usage block follows.
    const firstSentence = err.message.split(/\.\s/)[0].replace(/\.$/, '');
    throw new UsageError(firstSentence);
  }

  const { values, positionals } = parsed;

  if (positionals.length > 1) {
    throw new UsageError(
      `expected one command, got ${positionals.length}: ${positionals.join(' ')}`,
    );
  }

  const command = positionals[0] ?? null;
  if (command !== null && !COMMANDS.includes(command)) {
    throw new UsageError(`unknown command "${command}"`);
  }

  if (values.selftest) return frozen({ mode: 'selftest', command: null, flags: {} });
  if (values.version) return frozen({ mode: 'version', command: null, flags: {} });
  if (values.help || command === null) {
    return frozen({ mode: 'usage', command, flags: {} });
  }

  // Reject flags that this command does not accept. Silently ignoring one is
  // how --preview on `scan` becomes a surprise export.
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const spec = FLAGS[name];
    if (spec.commands === null) continue;
    if (!spec.commands.includes(command)) {
      throw new UsageError(
        `--${name} is not accepted by "${command}" (accepted by: ${spec.commands.join(', ')})`,
      );
    }
  }

  if (values.namespace !== undefined && !NAMESPACE_RE.test(values.namespace)) {
    throw new UsageError(
      `--namespace must match [A-Z][A-Z0-9]{0,7}, got "${values.namespace}"`,
    );
  }

  for (const name of ['root', 'out', 'salt-dir', 'entities', 'entity', 'session', 'verdicts']) {
    if (values[name] !== undefined && values[name].trim() === '') {
      throw new UsageError(`--${name} needs a value`);
    }
  }

  // The two halves of triage must be asked for together. `--apply` with nothing
  // to apply would write over review.md with the verdicts of an empty list, and
  // `--verdicts` without `--apply` reads a file and then throws the answer away
  // - a flag that exits 0 without doing its job (cli-ux §5).
  if (values.apply === true && values.verdicts === undefined) {
    throw new UsageError('--apply needs --verdicts <file>', {
      why: ['There is nothing to apply until you name the file the reader wrote.'],
      remedies: [{ label: 'Name it', command: 'deident triage --apply --verdicts deident-triage.json' }],
    });
  }
  if (values.verdicts !== undefined && values.apply !== true) {
    throw new UsageError('--verdicts only means something with --apply', {
      why: ['Without --apply the file would be read and the answer discarded.'],
      remedies: [{ label: 'Apply it', command: 'deident triage --apply --verdicts <file>' }],
    });
  }

  const triageChars = parseTriageChars(values['triage-chars']);
  const batchChars = parseBatchChars(values['batch-chars']);

  // --full says "show me everything again" and --entities says "here is my
  // answer". A run carrying both would read the answer and then refuse to use
  // it, because --full marks every session unread. Refused at the flag rather
  // than after a ten-minute run.
  if (values.full === true && values.entities !== undefined) {
    throw new UsageError('--full cannot be combined with --entities', {
      why: ['--full re-reads the whole corpus, so the list you supplied could not be used yet.'],
      remedies: [
        { label: 'Re-read first', command: 'deident export --full' },
        { label: 'Then supply the list', command: 'deident export --entities deident-entities.json' },
      ],
    });
  }

  if (values.html && (values.entity !== undefined || values.session !== undefined)) {
    throw new UsageError('--html cannot be combined with --entity or --session');
  }
  if (values.entity !== undefined && values.session !== undefined) {
    throw new UsageError('--entity and --session are separate queries; run them separately');
  }

  const includeDenied = values['include-denied'] ?? [];
  for (const name of includeDenied) {
    if (name.includes('*') || name.includes('?')) {
      throw new UsageError(
        `--include-denied takes an exact workspace name, not a glob: "${name}"`,
      );
    }
  }

  return frozen({
    mode: 'command',
    command,
    flags: {
      root: values.root ?? null,
      out: values.out ?? null,
      saltDir: values['salt-dir'] ?? null,
      html: values.html === true,
      entity: values.entity ?? null,
      session: values.session ?? null,
      preview: values.preview === true,
      entities: values.entities ?? null,
      full: values.full === true,
      namespace: values.namespace ?? null,
      skipUnclassified: values['skip-unclassified'] === true,
      skipUnreadable: values['skip-unreadable'] === true,
      skipUnknownTypes: values['skip-unknown-types'] === true,
      includeDenied: Object.freeze([...includeDenied]),
      json: values.json === true,
      apply: values.apply === true,
      verdicts: values.verdicts ?? null,
      triageChars,
      batchChars,
    },
  });
}

/**
 * The candidates-file budget, as a whole number of characters.
 *
 * Same posture as parseTriageChars, and deliberately not `parseInt` for the
 * same reason: it reads `300abc` as 300. No upper bound, because a reader with
 * a large context window asking for the whole corpus in one file is the
 * behaviour this tool had before the cap, and it is theirs to ask for.
 */
function parseBatchChars(raw) {
  if (raw === undefined) return CANDIDATE_BATCH_CHARS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(`--batch-chars takes a whole number of characters, got "${raw}"`);
  }
  const value = Number(raw.trim());
  if (value < 1) {
    throw new UsageError(`--batch-chars must be at least 1, got ${value}`, {
      why: ['A budget of zero would offer nothing and record nothing, so the export could never proceed.'],
      remedies: [{ label: 'Use the default', command: 'deident export' }],
    });
  }
  return value;
}

/**
 * The truncation limit, as a whole number of characters.
 *
 * Validated here rather than where it is used, so a typo refuses at the flag and
 * not after the corpus has been enumerated. `parseInt` is deliberately not used:
 * it reads `300abc` as 300 and `3e5` as 3, so a value that means nothing would
 * silently become one that means something.
 */
function parseTriageChars(raw) {
  if (raw === undefined) return DEFAULT_TRIAGE_CHARS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(`--triage-chars takes a whole number of characters, got "${raw}"`);
  }
  const value = Number(raw.trim());
  if (value < 1 || value > MAX_TRIAGE_CHARS) {
    throw new UsageError(`--triage-chars must be between 1 and ${MAX_TRIAGE_CHARS}, got ${value}`, {
      why: [
        `At ${MAX_TRIAGE_CHARS.toLocaleString('en-US')} characters over a 205-session corpus the payload is 410 KB,`,
        'which is already within reach of what the entity pass reads. A limit high',
        'enough to carry whole sessions turns triage back into the expensive stage.',
      ],
      remedies: [{ label: 'Use the default', command: 'deident triage --out <workdir>' }],
    });
  }
  return value;
}

function frozen(o) {
  return Object.freeze({ ...o, flags: Object.freeze(o.flags) });
}
