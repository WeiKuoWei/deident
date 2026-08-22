// Resolve the session-storage root from the environment and enumerate
// depth-0 session files. BRIEF §4.9: never parse a slug. BRIEF §4.10: depth-0
// only — a recursive glob ships 2.2x the payload with zero extra human turns.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RefusalError } from '../cli/errors.mjs';

/**
 * Resolve `<root>/projects`. Order: explicit --root, then CLAUDE_CONFIG_DIR
 * (official), then ~/.claude. CLAUDE_CODE_PROJECT_DIR_NAME is read only to
 * report which subdirectory a live session would be writing into; it never
 * becomes a parse target (§4.9).
 */
export function resolveRoot(env, override = null) {
  const configDir = override ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return Object.freeze({
    configDir: path.resolve(configDir),
    projectsDir: path.resolve(configDir, 'projects'),
    currentProjectDirName: env.CLAUDE_CODE_PROJECT_DIR_NAME ?? null,
    source: override ? '--root' : env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR' : 'default',
  });
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
      ],
      remedies: [
        { label: 'Point at a different root', command: 'deident scan --root <path>' },
        { label: 'Or set the official variable', command: 'CLAUDE_CONFIG_DIR=<path>' },
      ],
    });
  }

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
    files.push(...wsFiles);
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
