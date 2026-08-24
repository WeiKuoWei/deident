// Typed errors. The exit code is a property of the error, never a call-site
// decision (PLAN §1). Every error carries enough to render one of the three
// message shapes in PLAN §6.4 without the renderer guessing.

/**
 * Base class. `code` is the process exit code.
 * `reason` is one line. `why` is two or three lines. `remedies` is a list of
 * {label, command} pairs. Nothing here is formatted; report.mjs owns wording.
 */
export class DeidentError extends Error {
  constructor(reason, { code, why = [], remedies = [], detail = null } = {}) {
    super(reason);
    this.name = new.target.name;
    this.reason = reason;
    this.code = code;
    this.why = Object.freeze([...why]);
    this.remedies = Object.freeze(remedies.map((r) => Object.freeze({ ...r })));
    this.detail = detail === null ? null : Object.freeze({ ...detail });
    Object.freeze(this);
  }
}

/** Bad flag, bad command, illegal combination. Usage text follows. */
export class UsageError extends DeidentError {
  constructor(reason, opts = {}) {
    super(reason, { ...opts, code: 2 });
  }
}

/**
 * An input file could not be read or parsed.
 * `detail` carries {file, line, parserMessage, likelyCause}.
 */
export class ReadError extends DeidentError {
  constructor(reason, opts = {}) {
    super(reason, { ...opts, code: 3 });
  }
}

/** A check failed or the export was refused. Nothing was written. */
export class RefusalError extends DeidentError {
  constructor(reason, opts = {}) {
    super(reason, { ...opts, code: 1 });
  }
}

/**
 * One line for an OS-level failure. A node fs error already carries its code
 * at the front of `.message`, so prefixing the code again printed
 * "EPERM: EPERM: operation not permitted" in a refusal body.
 */
export function osErrorLine(err) {
  const code = err && err.code ? err.code : null;
  const msg = err && err.message ? err.message : String(err);
  return code && !msg.startsWith(`${code}:`) ? `${code}: ${msg}` : msg;
}

/**
 * Wrap an unexpected throw so the entry point never prints a traceback.
 * BRIEF §2: a traceback on Sam's machine is a failed delivery.
 */
export function wrapUnexpected(err, context) {
  if (err instanceof DeidentError) return err;
  const msg = err && err.message ? err.message : String(err);
  return new RefusalError(`internal error while ${context}: ${msg}`, {
    why: [
      'This is a bug in deident, not a problem with your data.',
      'Nothing was written.',
    ],
    remedies: [{ label: 'Report it with this line', command: msg }],
    detail: { stack: err && err.stack ? err.stack : null },
  });
}
