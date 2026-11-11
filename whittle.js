// The wasm module behind a small promise API. An ES module: the worker imports it in the
// browser and the node tests import the same file.

export const FORMAT = { glb: 1, obj: 2 };
export const SAMPLE = { sphere: 1, cylinder: 2, tube: 3, cube: 4 };
export const METHOD = { lod: 0, cluster: 1 };
const SLOT_FILE = 0;
const SLOT_POSITIONS = 1;
const SLOT_NORMALS = 2;
const SLOT_INDICES = 3;
const SLOT_EDGES = 4;

// What the module imports: the three libm functions the Odin runtime leaves to the host (shapes
// use sin and cos, the deviation metric pow). Nothing else, and nothing from the network.
export const IMPORTS = { env: { sin: Math.sin, cos: Math.cos, pow: Math.pow } };

export class WhittleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WhittleError";
    this.code = code;
  }
}

// `source` is a URL (string or URL), a Response, or the bytes (or compiled module) of whittle.wasm.
export async function instantiate(source) {
  let result;
  if (source instanceof WebAssembly.Module) {
    result = { instance: await WebAssembly.instantiate(source, IMPORTS) };
  } else if (typeof source === "string" || source instanceof URL || (typeof Response !== "undefined" && source instanceof Response)) {
    const response = typeof source === "string" || source instanceof URL ? fetch(source) : source;
    try {
      result = await WebAssembly.instantiateStreaming(response, IMPORTS);
    } catch (e) {
      // a server that does not send application/wasm: read the bytes and compile them
      const again = typeof source === "string" || source instanceof URL ? await fetch(source) : source;
      result = await WebAssembly.instantiate(await again.arrayBuffer(), IMPORTS);
    }
  } else {
    result = await WebAssembly.instantiate(source, IMPORTS);
  }
  return new Whittle(result.instance.exports);
}

export class Whittle {
  constructor(exports) {
    this.x = exports;
    this.decoder = new TextDecoder();
  }

  get memoryBytes() {
    return this.x.memory.buffer.byteLength;
  }

  get version() {
    const v = this.x.wh_version();
    return `${v >> 16}.${(v >> 8) & 255}.${v & 255}`;
  }

  // Throws on a negative status, with the module's own message.
  check(status) {
    if (status >= 0) return status;
    const n = this.x.wh_error_len();
    const message = n ? this.decoder.decode(new Uint8Array(this.x.memory.buffer, this.x.wh_error_ptr(), n)) : "unknown error";
    throw new WhittleError(message, status);
  }

  slot(i) {
    const n = this.x.wh_out_len(i);
    if (!n) return new Uint8Array(0);
    return new Uint8Array(this.x.memory.buffer, this.x.wh_out_ptr(i), n).slice();
  }

  load(bytes, format) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const p = this.x.wh_alloc(data.length);
    if (!p) throw new WhittleError("out of memory while reading the file", -4);
    new Uint8Array(this.x.memory.buffer, p, data.length).set(data);
    try {
      this.check(this.x.wh_load(p, data.length, format));
    } finally {
      this.x.wh_free(p, data.length);
    }
    return this.info();
  }

  loadSample(shape) {
    this.check(this.x.wh_load_sample(typeof shape === "string" ? SAMPLE[shape] : shape));
    return this.info();
  }

  info() {
    this.check(this.x.wh_info());
    return JSON.parse(this.decoder.decode(this.slot(SLOT_FILE)));
  }

  estimate(lodCount) {
    return this.x.wh_estimate(lodCount);
  }

  // Builds LOD `lod` (1..8) from the source: `keep` is a fraction (0 = unset), `tris` an absolute count (0 = unset).
  build(lod, keep, tris = 0, method = METHOD.lod) {
    this.check(this.x.wh_build(lod, keep, tris, method));
  }

  drop(lod) {
    this.check(this.x.wh_drop(lod));
  }

  // The buffers of one LOD (0 is the source) for drawing.
  view(lod) {
    this.check(this.x.wh_view(lod));
    const copy = (slot, Type) => {
      const bytes = this.slot(slot);
      return new Type(bytes.buffer, 0, bytes.length / Type.BYTES_PER_ELEMENT);
    };
    return {
      positions: copy(SLOT_POSITIONS, Float32Array),
      normals: copy(SLOT_NORMALS, Float32Array),
      indices: copy(SLOT_INDICES, Uint32Array),
      edges: copy(SLOT_EDGES, Uint32Array),
    };
  }

  // The file of one LOD (0 is the source): a Uint8Array in the given format.
  exportLod(lod, format = FORMAT.glb) {
    this.check(this.x.wh_export(lod, format));
    return this.slot(SLOT_FILE);
  }

  report() {
    this.check(this.x.wh_report());
    return JSON.parse(this.decoder.decode(this.slot(SLOT_FILE)));
  }

  reset() {
    this.x.wh_reset();
  }
}
