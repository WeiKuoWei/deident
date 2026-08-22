// Flag table and argv parsing. PLAN §6.1 / §6.2.
// Returns a frozen options object, or throws UsageError. No I/O here.

import { parseArgs } from 'node:util';
import { UsageError } from './errors.mjs';

export const COMMANDS = Object.freeze(['scan', 'review', 'export']);

// flag -> {type, multiple?, commands}. `commands: null` means every command.
const FLAGS = Object.freeze({
  root: { type: 'string', commands: null },
  out: { type: 'string', commands: ['scan', 'review', 'export'] },
  'salt-dir': { type: 'string', commands: null },
  html: { type: 'boolean', commands: ['review'] },
  entity: { type: 'string', commands: ['review'] },
  session: { type: 'string', commands: ['review'] },
  preview: { type: 'boolean', commands: ['export'] },
  entities: { type: 'string', commands: ['export'] },
  namespace: { type: 'string', commands: ['export'] },
  'skip-unclassified': { type: 'boolean', commands: ['export'] },
  'skip-unreadable': { type: 'boolean', commands: ['scan', 'export'] },
  'skip-unknown-types': { type: 'boolean', commands: ['scan', 'export'] },
  'include-denied': { type: 'string', multiple: true, commands: ['export'] },
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

  for (const name of ['root', 'out', 'salt-dir', 'entities', 'entity', 'session']) {
    if (values[name] !== undefined && values[name].trim() === '') {
      throw new UsageError(`--${name} needs a value`);
    }
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
      namespace: values.namespace ?? null,
      skipUnclassified: values['skip-unclassified'] === true,
      skipUnreadable: values['skip-unreadable'] === true,
      skipUnknownTypes: values['skip-unknown-types'] === true,
      includeDenied: Object.freeze([...includeDenied]),
    },
  });
}

function frozen(o) {
  return Object.freeze({ ...o, flags: Object.freeze(o.flags) });
}
