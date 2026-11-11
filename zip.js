// A zip writer for the page's downloads: stored entries (method 0), UTF-8 names, CRC-32.
// No compression: GLB and OBJ files are what the user would otherwise save one by one.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC-32 (IEEE) of `bytes`; pass a previous result as `crc` to continue over more bytes.
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// files: {name, bytes: Uint8Array}[]  ->  the zip file's bytes.
export function zip(files, when = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  if (files.length > 0xffff) throw new Error("too many files for a zip");
  const entries = files.map((f) => ({ name: enc.encode(f.name), bytes: f.bytes, crc: crc32(f.bytes), offset: 0 }));
  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.bytes.length + 46 + e.name.length;
  if (size >= 0xffffffff) throw new Error("the files are too large for one zip");
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let p = 0;
  const u16 = (x) => { v.setUint16(p, x, true); p += 2; };
  const u32 = (x) => { v.setUint32(p, x, true); p += 4; };
  for (const e of entries) {
    e.offset = p;
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(time); u16(date);
    u32(e.crc); u32(e.bytes.length); u32(e.bytes.length); u16(e.name.length); u16(0);
    out.set(e.name, p); p += e.name.length;
    out.set(e.bytes, p); p += e.bytes.length;
  }
  const centralStart = p;
  for (const e of entries) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(time); u16(date);
    u32(e.crc); u32(e.bytes.length); u32(e.bytes.length); u16(e.name.length); u16(0); u16(0);
    u16(0); u16(0); u32(0); u32(e.offset);
    out.set(e.name, p); p += e.name.length;
  }
  const centralSize = p - centralStart;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length); u32(centralSize); u32(centralStart); u16(0);
  return out;
}
