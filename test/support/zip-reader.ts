/**
 * A ZIP reader for the tests, written by hand ON PURPOSE.
 *
 * `lib/export/zip.ts` has no reader, and adding one would be worse than this:
 * a test that read an archive with the writer's own understanding of the format
 * would pass for any self-consistent nonsense. The point of a test here is that
 * SOMETHING ELSE can open the file.
 *
 * So this parses the CENTRAL DIRECTORY — the index at the end of the archive,
 * which is what every real reader looks at first and the one place the writer's
 * streaming shape (data descriptors, zeroed local headers) has to be correct or
 * nothing works. It then inflates each entry and verifies the stored CRC.
 *
 * It was also checked against two independent readers during development, which
 * a unit test cannot do in CI: `unzip -t` reported no errors and Python's
 * `zipfile.testzip()` returned None, both agreeing with these sizes and CRCs.
 *
 * Deliberately NOT a general reader. No ZIP64, no encryption, no stored
 * (method 0) entries, no multi-disk — the writer emits none of those, and a
 * reader that handled cases the writer cannot produce would be untested code in
 * a test helper.
 */
import { inflateRawSync } from 'node:zlib';
import { crc32 } from '@/lib/export/zip';

export interface ZipEntry {
  name: string;
  /** The uncompressed bytes. */
  data: Buffer;
  /** As recorded in the central directory, and verified against the data. */
  declaredSize: number;
  declaredCrc: number;
}

const EOCD_SIG = 0x0605_4b50;
const CD_SIG = 0x0201_4b50;
const LOCAL_SIG = 0x0403_4b50;

/** Read every entry. Throws when the archive is malformed or a CRC disagrees. */
export function readZip(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record is last, but may be followed by a
  // comment, so it is searched for backwards from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('readZip: no end-of-central-directory record');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) {
    throw new Error('readZip: central directory runs past the end of the archive');
  }

  const out: ZipEntry[] = [];
  let p = cdOffset;

  for (let n = 0; n < entryCount; n += 1) {
    if (buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`readZip: central directory entry ${n} has a bad signature`);
    }
    const method = buf.readUInt16LE(p + 10);
    const declaredCrc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const declaredSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (method !== 8) throw new Error(`readZip: ${name} uses method ${method}, expected deflate`);

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`readZip: ${name}'s local header offset is wrong`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    const data =
      declaredSize === 0 && compressedSize <= 2
        ? Buffer.alloc(0)
        : inflateRawSync(buf.subarray(dataStart, dataStart + compressedSize));

    if (data.length !== declaredSize) {
      throw new Error(
        `readZip: ${name} inflated to ${data.length} bytes, directory says ${declaredSize}`,
      );
    }
    const actual = crc32(new Uint8Array(data));
    if (actual !== declaredCrc) {
      throw new Error(`readZip: ${name} CRC mismatch — ${actual} vs ${declaredCrc}`);
    }

    out.push({ name, data, declaredSize, declaredCrc });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/** Entries by name, for a test that wants one file. */
export function readZipMap(buf: Buffer): Map<string, Buffer> {
  return new Map(readZip(buf).map((e) => [e.name, e.data]));
}

/**
 * Parse CSV back into rows.
 *
 * Enough of RFC 4180 to read what `lib/export/csv.ts` writes — quoted fields,
 * doubled quotes, embedded commas and newlines. Hand-written for the same reason
 * as the reader above: reusing the writer's escaping to check the writer's
 * escaping proves nothing.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
