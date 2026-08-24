// Resolve the session-storage root from the environment and enumerate
// depth-0 session files. BRIEF §4.9: never parse a slug. BRIEF §4.10: depth-0
// only — a recursive glob ships 2.2x the payload with zero extra human turns.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RefusalError } from '../cli/errors.mjs';
import { probeCaseFolding, setCaseFolding } from './cwdtrack.mjs';

/**
 * Resolve `<root>/projects`. Order: explicit --root, then CLAUDE_CONFIG_DIR
 * (official), then ~/.claude. CLAUDE_CODE_PROJECT_DIR_NAME is read only to
 * report which subdirectory a live session would be writing into; it never
 * becomes a parse target (§4.9).
 */
/**
 * The home directory, or null. NEVER throws.
 *
 * `os.homedir()` throws `uv_os_homedir returned ENOENT` when HOME and
 * USERPROFILE are both empty, and it was called unguarded from resolveRoot and
 * from defaultSaltDir — so `HOME= USERPROFILE= deident scan` printed
 * `internal error … This is a bug in deident, not a problem with your data`
 * and told the user to file an issue about their own environment. It is an
 * environment, it has a remedy, and the remedy is a flag.
 */
export function homeDir(env = process.env) {
  for (const name of ['HOME', 'USERPROFILE']) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  // Present but blank is a deliberate "no home", and it is exactly the state
  // that makes os.homedir() throw. Absent from the object is not: fall back.
  if (env && ('HOME' in env || 'USERPROFILE' in env)) return null;
  try {
    const home = os.homedir();
    return typeof home === 'string' && home.trim() !== '' ? home : null;
  } catch {
    return null;
  }
}

/** The refusal for "there is no home directory and you did not name a path". */
export function noHomeRefusal(what, flag) {
  return new RefusalError(`no home directory, so deident cannot find ${what}`, {
    why: [
      'HOME and USERPROFILE are both empty or unset, so there is no default path.',
      'This is the environment deident was started in, not a problem with your data.',
    ],
    remedies: [
      { label: 'Name the path', command: `deident scan ${flag} <path>` },
      // Was `HOME=<path>`, which is a bash assignment and a PowerShell parse
      // error ("the term 'HOME=/tmp/x' is not recognized as the name of a
      // cmdlet"). PowerShell is the default shell on the machines this ships
      // to, and cli-ux §8 makes the remedy the contract for getting unstuck,
      // so a remedy that cannot be run is worse than none: the person believes
      // they typed the fix and it did not work. Shell-neutral prose rather
      // than a platform test, because the string has to be correct to READ
      // everywhere, and the flag above is the answer that needs no shell at
      // all. If a dual-form remedy is ever wanted here, F111 will flag the
      // PowerShell half's `$env:` and the rule is what needs revisiting.
      { label: 'Or set HOME first', command: 'set HOME to a real directory in your shell, then run deident again' },
    ],
  });
}

export function resolveRoot(env, override = null) {
  // `??` does not treat '' as absent, and `path.resolve('')` is the current
  // directory — so a shell profile that exports CLAUDE_CONFIG_DIR
  // unconditionally would silently point deident at the cwd, and scan whatever
  // `projects/` happens to sit there. An empty or whitespace-only value is not
  // a setting; it falls through to the default.
  const fromEnv = nonBlank(env.CLAUDE_CONFIG_DIR);
  const home = homeDir(env);
  if (nonBlank(override) === null && fromEnv === null && home === null) {
    throw noHomeRefusal('your session storage', '--root');
  }
  const configDir = nonBlank(override) ?? fromEnv ?? path.join(home, '.claude');
  return Object.freeze({
    configDir: path.resolve(configDir),
    projectsDir: path.resolve(configDir, 'projects'),
    currentProjectDirName: nonBlank(env.CLAUDE_CODE_PROJECT_DIR_NAME),
    source: nonBlank(override) ? '--root' : fromEnv ? 'CLAUDE_CONFIG_DIR' : 'the default ~/.claude',
  });
}

/**
 * A string value, or null when it is absent OR blank.
 *
 * Exported because `??` is wrong for every environment variable this tool
 * reads and the rule had been written out here and then not propagated: the
 * MCP seeder in entities/seed.mjs used `??`, so an unconditionally-exported
 * empty CLAUDE_CONFIG_DIR made `path.join('', 'settings.json')` a relative
 * path read against the cwd.
 */
export function nonBlank(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Enumerate depth-0 session files: `<projectsDir>/<dir>/*.jsonl` and nothing
 * deeper. `<dir>/<uuid>/subagents/...` is deliberately not walked (§4.10).
 *
 * @returns {Readonly<{root, workspaceDirs: object[], files: object[], bytes: number}>}
 */
export function resolveCorpus(env, override = null) {
  const root = resolveRoot(env, override);

  let dirents;
  try {
    dirents = fs.readdirSync(root.projectsDir, { withFileTypes: true });
  } catch (err) {
    throw new RefusalError(`no session storage at ${root.projectsDir}`, {
      why: [
        err.code === 'ENOENT'
          ? 'That directory does not exist, so there is nothing to export.'
          : `The directory could not be read (${err.code}).`,
        `The root was resolved from ${root.source}.`,
        '',
        // The skill installs in more than one harness, so a Codex or Cursor
        // user reaches this refusal. Offering --root again, which is the flag
        // that just failed, turns a scope limit into a dead end.
        'deident reads Claude Code session logs: <root>/projects/<dir>/*.jsonl.',
        'Codex and Cursor write a different layout and are not read yet, so no',
        'value of --root reaches them.',
      ],
      remedies: [
        { label: 'Point at a Claude Code root', command: 'deident scan --root <path to .claude>' },
        { label: 'Or name it in the environment', command: 'deident scan   # honours CLAUDE_CONFIG_DIR' },
      ],
    });
  }

  // Ask the filesystem whether it folds case, once, before any cwd is
  // normalised. Guessing from process.platform is wrong on Linux and on a
  // case-sensitive macOS volume, and guessing WRONG merges two real
  // directories into one workspace row carrying one tier. A probe that cannot
  // answer leaves the per-platform default in place rather than inventing one.
  const folds = probeCaseFolding(root.projectsDir);
  if (folds !== null) setCaseFolding(folds);

  const workspaceDirs = [];
  const files = [];
  let bytes = 0;

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const dirPath = path.join(root.projectsDir, dirent.name);

    let inner;
    try {
      inner = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      // One unreadable workspace must not sink the run (BRIEF §2).
      workspaceDirs.push(
        Object.freeze({ dirName: dirent.name, dirPath, sessionCount: 0, bytes: 0, unreadable: err.code }),
      );
      continue;
    }

    const wsFiles = [];
    let wsBytes = 0;
    for (const f of inner) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(filePath);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // A file that vanished between readdir and stat is not an error.
        continue;
      }
      wsBytes += size;
      wsFiles.push(
        Object.freeze({
          path: filePath,
          dirName: dirent.name,
          sessionId: f.name.replace(/\.jsonl$/, ''),
          bytes: size,
          mtimeMs,
        }),
      );
    }

    wsFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // A loop, not `push(...arr)`: a workspace directory with enough session
    // files would blow the argument stack before anything could be reported.
    for (const f of wsFiles) files.push(f);
    bytes += wsBytes;
    workspaceDirs.push(
      Object.freeze({
        dirName: dirent.name,
        dirPath,
        sessionCount: wsFiles.length,
        bytes: wsBytes,
        unreadable: null,
      }),
    );
  }

  workspaceDirs.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));

  return Object.freeze({
    root,
    workspaceDirs: Object.freeze(workspaceDirs),
    files: Object.freeze(files),
    bytes,
  });
}

/** "2026-05-02 → 2026-08-22" over file mtimes, or null when there are none. */
export function corpusDateRange(files) {
  if (files.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of files) {
    if (f.mtimeMs < lo) lo = f.mtimeMs;
    if (f.mtimeMs > hi) hi = f.mtimeMs;
  }
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  return `${d(lo)} → ${d(hi)}`;
}
