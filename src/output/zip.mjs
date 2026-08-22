// A minimal, deterministic ZIP writer over node:zlib.
//
// No npm dependency: a privacy tool does not open a supply-chain question to
// save a hundred lines (BRIEF §2).
//
// Deterministic because cli-ux §11 requires idempotence — running export twice
// with the same input and salt produces byte-identical output. That means a
// FIXED DOS timestamp, not the clock, and entries written in sorted order.

import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { RefusalError } from '../cli/errors.mjs';

// 1980-01-01 00:00:00, the earliest the DOS format can express. Any real clock
// value would break I10.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;

/**
 * @param {Array<{name: string, data: string|Buffer}>} entries
 * @param {string} outPath
 * @returns {{path: string, bytes: number}}
 */
export function writeZip(entries, outPath) {
  const buf = buildZip(entries);
  const partPath = `${outPath}.part`;

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(partPath, buf);
    fs.renameSync(partPath, outPath);
  } catch (err) {
    // cli-ux §10: any non-zero exit leaves no output file behind.
    safeUnlink(partPath);
    safeUnlink(outPath);
    throw new RefusalError(`could not write ${outPath}`, {
      why: [`${err.code}: ${err.message}`, 'Nothing was left behind.'],
      remedies: [{ label: 'Choose a writable directory', command: 'deident export --out <path>' }],
    });
  }

  return { path: outPath, bytes: buf.length };
}

export function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    // Already gone is the desired state.
  }
}

/** Exported separately so the selftest can assert byte-identity without I/O. */
export function buildZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);

    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}
