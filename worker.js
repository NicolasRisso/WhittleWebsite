// Holds the wasm module. The page talks to it by postMessage: {id, type, ...args} in,
// {id, ok, data | error} out, ArrayBuffers transferred. Requests run one at a time, in order.
import { instantiate, WhittleError } from "./whittle.js";

let whittle = null;
let queue = Promise.resolve();

async function module() {
  whittle ??= await instantiate(new URL("whittle.wasm", import.meta.url).href);
  return whittle;
}

function handle(w, m) {
  switch (m.type) {
    case "load": return { data: w.load(m.bytes, m.format) };
    case "sample": return { data: w.loadSample(m.shape) };
    case "info": return { data: w.info() };
    case "estimate": return { data: w.estimate(m.count) };
    case "build": w.build(m.lod, m.keep, m.tris ?? 0, m.method ?? 0); return { data: null };
    case "drop": w.drop(m.lod); return { data: null };
    case "view": {
      const v = w.view(m.lod);
      return { data: v, transfer: [v.positions.buffer, v.normals.buffer, v.indices.buffer, v.edges.buffer] };
    }
    case "export": {
      const bytes = w.exportLod(m.lod, m.format);
      return { data: bytes, transfer: [bytes.buffer] };
    }
    case "report": return { data: w.report() };
    case "reset": w.reset(); return { data: null };
  }
  throw new WhittleError(`unknown request ${m.type}`, -2);
}

self.onmessage = (event) => {
  const m = event.data;
  queue = queue.then(async () => {
    try {
      const w = await module();
      const { data, transfer } = handle(w, m);
      self.postMessage({ id: m.id, ok: true, data }, transfer ?? []);
    } catch (e) {
      // a WhittleError is the module refusing politely; anything else (a trap, a failed
      // instantiation) leaves the module in an unknown state, so the page restarts the worker
      const polite = e instanceof WhittleError;
      self.postMessage({ id: m.id, ok: false, error: { message: String(e.message ?? e), code: polite ? e.code : 0, trap: !polite } });
    }
  });
};
