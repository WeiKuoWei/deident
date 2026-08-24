#!/usr/bin/env node
// deident — the only entry point.
//
// This file owns the process exit code and is the single try/catch that turns
// any escaped error into one of the three message shapes in PLAN §6.4.
// It contains no logic of its own. BRIEF §2: a traceback reaching the terminal
// is a failed delivery, so nothing below is allowed to throw past main().

import { parseCliArgs } from './src/cli/args.mjs';
import { checkRuntime } from './src/cli/runtime.mjs';
import { wrapUnexpected } from './src/cli/errors.mjs';
import * as report from './src/cli/report.mjs';

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {object} env     process.env
 * @returns {Promise<number>} exit code
 */
export async function main(argv, env) {
  // Before argument parsing, so `--version` and `--help` still answer on a
  // runtime that cannot export. Those two are the commands a person runs when
  // something is wrong, and refusing them would remove the only way to find out
  // what is wrong.
  const unsupported = checkRuntime({ node: process.version });
  if (unsupported !== null && !argv.includes('--version') && !argv.includes('--help')) {
    return report.renderError(unsupported);
  }

  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    return report.renderError(err);
  }

  report.setCommand(opts.command);

  try {
    switch (opts.mode) {
      case 'usage':
        report.renderUsage();
        return 0;
      case 'version':
        report.renderVersion();
        return 0;
      case 'selftest': {
        const { selftest } = await import('./src/selftest.mjs');
        return report.renderSelftest(selftest()) ? 0 : 1;
      }
      case 'command': {
        const pipeline = await import('./src/pipeline.mjs');
        // One document per run, emitted once at the end. Begun here rather than
        // inside each command so a throw anywhere below still lands in the
        // envelope: renderError finishes the document itself.
        if (opts.flags.json) report.beginMachine(opts.command);
        switch (opts.command) {
          case 'scan': {
            const code = await pipeline.runScan(opts.flags, env);
            report.endMachine();
            return code;
          }
          case 'review': {
            const code = await pipeline.runReview(opts.flags, env);
            report.endMachine();
            return code;
          }
          case 'triage': {
            const code = await pipeline.runTriage(opts.flags, env);
            report.endMachine();
            return code;
          }
          case 'export': {
            const code = await pipeline.runExport(opts.flags, env);
            report.endMachine();
            return code;
          }
          default:
            // parseCliArgs already rejected anything else.
            report.renderUsage();
            return 2;
        }
      }
      default:
        report.renderUsage();
        return 2;
    }
  } catch (err) {
    return report.renderError(wrapUnexpected(err, `running "${opts.command ?? opts.mode}"`));
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace(
    /^file:\/\/\/?/,
    'file:///',
  );

// The URL comparison above is fragile across platforms, so fall back to a
// basename check. Windows-first (BRIEF §2): both forms must work in Git Bash
// and in PowerShell.
const invokedAsScript =
  isDirectRun || (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('/deident.mjs');

if (invokedAsScript) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.exitCode = report.renderError(wrapUnexpected(err, 'starting up'));
    },
  );
}
