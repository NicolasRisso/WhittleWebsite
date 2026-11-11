import { Viewer } from "./viewer.js";
import { zip } from "./zip.js";

// The page: a model in, a list of LODs with sliders, counts and deviations. The wasm lives in
// worker.js; this file only holds the interface state and talks to it by message.

export const MIN_PERCENT = 0.5;
export const MAX_PERCENT = 100;
export const MAX_LODS = 8;
export const DEFAULT_PERCENTS = [50, 25, 12.5];
const SLIDER_STEPS = 1000;

// The slider is logarithmic: position 0 is 0.5 %, position 1000 is 100 %.
export function sliderToPercent(position) {
  const t = Math.min(1, Math.max(0, position / SLIDER_STEPS));
  return MIN_PERCENT * Math.pow(MAX_PERCENT / MIN_PERCENT, t);
}

export function percentToSlider(percent) {
  const p = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
  return Math.round((Math.log(p / MIN_PERCENT) / Math.log(MAX_PERCENT / MIN_PERCENT)) * SLIDER_STEPS);
}

export function formatPercent(percent) {
  if (percent >= 10) return `${Math.round(percent * 10) / 10} %`;
  return `${Math.round(percent * 100) / 100} %`;
}

export function formatCount(n) {
  return Math.round(n).toLocaleString("en-US");
}

// The count a keep fraction asks for, before the module has answered.
export function predictedTriangles(percent, sourceTriangles) {
  return Math.min(sourceTriangles, Math.max(1, Math.ceil((percent / 100) * sourceTriangles)));
}

// "Model.final.glb" -> "Model.final"
export function baseName(file) {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

export function formatOf(file) {
  return /\.obj$/i.test(file) ? 2 : 1;
}

// The size rules of docs/plan §9.3. `fileBytes` is checked before the file is read; the rest after
// the module has counted it. Messages never name anything but the command-line tool.
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const LIVE_TRIANGLES = 1_000_000;
export const MAX_TRIANGLES = 4_000_000;
export const MAX_ESTIMATE = 3 * 1024 * 1024 * 1024;

export function checkLimits({ fileBytes = 0, triangles = 0, estimate = 0 }) {
  if (fileBytes > MAX_FILE_BYTES) {
    return { ok: false, message: "This file is over 256 MB, which is too large for the browser version. Use the command-line tool." };
  }
  if (triangles > MAX_TRIANGLES) {
    return { ok: false, message: `This model has ${formatCount(triangles)} triangles, which is too many for the browser version. Use the command-line tool.` };
  }
  if (estimate > MAX_ESTIMATE) {
    return { ok: false, message: "Making LODs of this model would need more memory than a browser offers. Use the command-line tool." };
  }
  return { ok: true, message: "" };
}

export function isLive(triangles) {
  return triangles <= LIVE_TRIANGLES;
}

// The file names of a download: LOD numbers follow the order of the list, not the module's slots.
export function lodFileName(name, index, format) {
  return `${name}_LOD${index}.${format === 2 ? "obj" : "glb"}`;
}

// The message for a failure that has a code, in words for a person.
export function explain(error) {
  if (error.code === -4) return "This browser ran out of memory for this model. Use the command-line tool for a model this large.";
  if (error.code === -3 && /buffer|uri|missing/i.test(error.message)) {
    return `${error.message}. A .gltf must embed its buffers; export a .glb instead.`;
  }
  if (error.code === -3) return `${error.message}. This file is damaged or not a valid model.`;
  return error.message;
}

// What to tell the person after the module trapped. Only a real allocation failure (V8 words it
// "Out of memory", "Cannot allocate", "Memory.grow(): Maximum memory size exceeded") is blamed on
// memory; a trap while loading a file is read as a damaged file; anything else is just unexpected.
export function explainTrap(error, loading = false) {
  if (/memory|alloc/i.test(String(error?.message ?? ""))) {
    return "The module stopped unexpectedly, most likely for lack of memory. Load the file again, or use the command-line tool for a model this large.";
  }
  if (loading) return "This file is damaged or not a valid model. Try another file, or export it again from your 3D tool.";
  return "The module stopped unexpectedly. Load the file again.";
}

// A promise-based client for worker.js. `restart` makes a fresh worker (after a trap).
export class Client {
  constructor(url = "worker.js") {
    this.url = url;
    this.start();
  }

  start() {
    this.pending = new Map();
    this.nextId = 1;
    this.worker = new Worker(this.url, { type: "module" });
    this.worker.onmessage = (event) => {
      const { id, ok, data, error } = event.data;
      const p = this.pending.get(id);
      if (!p) return; // a reply nobody waits for any more
      this.pending.delete(id);
      if (ok) p.resolve(data);
      else p.reject(Object.assign(new Error(error.message), error));
    };
    this.worker.onerror = (event) => {
      const failure = Object.assign(new Error(event.message || "the module failed to start"), { trap: true, code: 0 });
      for (const p of this.pending.values()) p.reject(failure);
      this.pending.clear();
    };
  }

  restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(Object.assign(new Error("restarted"), { trap: true, code: 0 }));
    this.start();
  }

  call(type, args = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...args }, transfer);
    });
  }
}

function start() {
  const $ = (id) => document.getElementById(id);
  const client = new Client();
  const ui = {
    drop: $("drop"), file: $("file"), model: $("model"), panel: $("lods-panel"), method: $("method"),
    format: $("format"), list: $("lods"), add: $("add"), build: $("build"), zip: $("zip"),
    note: $("note"), status: $("status"), sha: $("sha"),
    viewerPanel: $("viewer-panel"), lodButtons: $("lod-buttons"), side: $("side"), wire: $("wire"), shade: $("shade"),
  };
  const viewer = new Viewer($("canvas"), $("labels"));
  const app = {
    name: "model",
    info: null,          // what wh_info said about the source
    rows: [],            // {slot, percent, version, dirty, timer, tris, dev, state, el}
    busy: false,         // one build in flight at a time
    generation: 0,       // bumps on every load, so a late reply for an old model is dropped
    live: true,          // false above 1M triangles: a Build button replaces live rebuilds
    shown: 0,            // the slot the preview shows (0 = the source)
    side: false,         // every LOD in its own cell
    views: new Map(),    // slot -> the revision of it that the viewer holds
  };

  function setStatus(text, kind = "") {
    ui.status.textContent = text;
    ui.status.className = `status ${kind}`.trim();
  }

  async function guard(task, loading = false) {
    try {
      return await task();
    } catch (e) {
      if (e.trap) {
        client.restart();
        clearModel();
        setStatus(explainTrap(e, loading), "bad");
      } else {
        setStatus(explain(e), "bad");
      }
      return undefined;
    }
  }

  function clearModel() {
    app.generation++;
    app.info = null;
    app.busy = false;
    for (const r of app.rows) clearTimeout(r.timer);
    app.rows = [];
    ui.list.replaceChildren();
    ui.panel.hidden = true;
    ui.model.hidden = true;
    ui.viewerPanel.hidden = true;
    app.shown = 0;
    app.views.clear();
    viewer.clear();
  }

  // ---- loading ----

  async function afterLoad(info, name) {
    app.name = name;
    app.info = info;
    app.live = isLive(info.triangles);
    ui.model.hidden = false;
    ui.model.textContent = `${name}: ${formatCount(info.triangles)} triangles, ${formatCount(info.vertices)} vertices` +
      (info.skins ? `, ${info.joints} joints` : "") + (info.images ? `, ${info.images} image${info.images > 1 ? "s" : ""}` : "");
    ui.format.value = String(app.formatHint ?? 1);
    ui.panel.hidden = false;
    ui.viewerPanel.hidden = !viewer.ok;
    if (!viewer.ok) setNote("The preview needs WebGL 2, which this browser does not offer here. Everything else works.");
    ui.build.hidden = app.live;
    if (!app.live) setNote("This model has over a million triangles, so the sliders do not rebuild as you drag. Set them, then press Build.");
    else if (viewer.ok) ui.note.hidden = true;
    app.rows = [];
    ui.list.replaceChildren();
    ui.list.append(sourceRow());
    for (const p of DEFAULT_PERCENTS) addRow(p);
    layoutRows();
    refreshButtons();
    refreshView();
    setStatus(`Loaded ${name}.`, "ok");
    if (app.live) {
      for (const r of app.rows) r.dirty = true;
      pump();
    } else {
      setStatus(`Loaded ${name}. Press Build to make the LODs.`, "ok");
    }
  }

  // Applies the size rules to a model the module has read; refuses it (and frees it) when too large.
  async function admit(info, name) {
    const generation = app.generation;
    const estimate = await guard(() => client.call("estimate", { count: DEFAULT_PERCENTS.length }));
    if (generation !== app.generation) return;
    const verdict = checkLimits({ triangles: info.triangles, estimate: estimate ?? 0 });
    if (!verdict.ok) {
      await guard(() => client.call("reset"));
      clearModel();
      setStatus(verdict.message, "bad");
      return;
    }
    await afterLoad(info, name);
  }

  async function loadFile(file) {
    if (!file) return;
    clearModel();
    const early = checkLimits({ fileBytes: file.size });
    if (!early.ok) {
      setStatus(early.message, "bad");
      return;
    }
    setStatus(`Reading ${file.name}…`);
    const format = formatOf(file.name);
    app.formatHint = format;
    const bytes = await file.arrayBuffer();
    const generation = app.generation;
    const info = await guard(() => client.call("load", { bytes: new Uint8Array(bytes), format }, [bytes]), true);
    if (info && generation === app.generation) await admit(info, baseName(file.name));
  }

  async function loadSample(shape) {
    clearModel();
    setStatus(`Making the ${shape}…`);
    app.formatHint = 1;
    const generation = app.generation;
    const info = await guard(() => client.call("sample", { shape }));
    if (info && generation === app.generation) await admit(info, shape);
  }

  // ---- rows ----

  function sourceRow() {
    const li = document.createElement("li");
    li.className = "lod source";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = "LOD0";
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = "the source, as it is";
    const tools = document.createElement("div");
    tools.className = "tools";
    const dl = document.createElement("button");
    dl.type = "button";
    dl.textContent = "Download";
    dl.addEventListener("click", () => downloadOne(0, 0));
    tools.append(dl);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = formatCount(app.info.triangles);
    li.append(name, detail, count, tools);
    return li;
  }

  function freeSlot() {
    for (let s = 1; s <= MAX_LODS; s++) if (!app.rows.some((r) => r.slot === s)) return s;
    return 0;
  }

  function addRow(percent) {
    const slot = freeSlot();
    if (!slot) return null;
    const row = { slot, percent, version: 0, revision: 0, dirty: false, timer: 0, tris: null, dev: null, state: "idle", el: null };
    const li = document.createElement("li");
    li.className = "lod";
    const name = document.createElement("span");
    name.className = "name";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(SLIDER_STEPS);
    slider.value = String(percentToSlider(percent));
    slider.setAttribute("aria-label", "Share of the triangles kept");
    const count = document.createElement("span");
    count.className = "count";
    const detail = document.createElement("span");
    detail.className = "detail";
    const tools = document.createElement("div");
    tools.className = "tools";
    li.append(name, slider, count, detail, tools);
    row.el = { li, name, slider, count, detail, tools };
    slider.addEventListener("input", () => {
      row.percent = sliderToPercent(Number(slider.value));
      row.version++;
      row.state = "stale";
      renderRow(row);
      clearTimeout(row.timer);
      if (app.live) {
        row.timer = setTimeout(() => {
          row.dirty = true;
          pump();
        }, 150);
      }
    });
    const dl = document.createElement("button");
    dl.type = "button";
    dl.textContent = "Download";
    dl.addEventListener("click", () => downloadOne(row.slot, app.rows.indexOf(row) + 1));
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => removeRow(row));
    tools.append(dl, rm);
    row.el.download = dl;
    app.rows.push(row);
    ui.list.append(li);
    renderRow(row);
    return row;
  }

  function renderRow(row) {
    const { li, name, count, detail, tools } = row.el;
    const n = app.rows.indexOf(row) + 1;
    name.textContent = `LOD${n}`;
    const guess = predictedTriangles(row.percent, app.info.triangles);
    count.textContent = row.state === "built" && row.tris !== null ? formatCount(row.tris) : `~${formatCount(guess)}`;
    const parts = [`keeps ${formatPercent(row.percent)}`];
    if (row.state === "built" && row.dev !== null) parts.push(`deviation ${(row.dev * 100).toFixed(2)} %`);
    if (row.state === "working") parts.push("building…");
    if (row.state === "stale") parts.push(app.live ? "waiting…" : "press Build");
    if (row.state === "error") parts.push(row.message ?? "failed");
    detail.textContent = parts.join(" · ");
    li.classList.toggle("stale", row.state !== "built");
    li.classList.toggle("error", row.state === "error");
    row.el.download.disabled = !(row.state === "built" && row.revision > 0);
  }

  function layoutRows() {
    for (const r of app.rows) renderRow(r);
    ui.add.disabled = app.rows.length >= MAX_LODS;
  }

  // ---- building: one request in flight, the newest slider position wins ----

  function pump() {
    if (app.busy || !app.info) return;
    const row = app.rows.find((r) => r.dirty);
    if (!row) return;
    app.busy = true;
    row.dirty = false;
    const sent = row.version;
    const generation = app.generation;
    row.state = "working";
    renderRow(row);
    setStatus("Building…");
    const method = Number(ui.method.value);
    guard(async () => {
      await client.call("build", { lod: row.slot, keep: Math.fround(row.percent / 100), tris: 0, method });
      return client.call("report");
    }).then((report) => {
      if (generation !== app.generation) return;
      app.busy = false;
      if (report) {
        for (const line of report.lods) {
          const r = app.rows.find((x) => x.slot === line.lod);
          if (!r) continue;
          if (r === row) r.revision++;
          r.tris = line.triangles;
          r.dev = line.deviation.max;
          if (r === row && r.version === sent) r.state = "built";
          else if (r.state !== "stale" && r.state !== "working") r.state = "built";
        }
        if (row.version !== sent) row.state = "stale";
      } else {
        row.state = "error";
        row.message = ui.status.textContent;
      }
      for (const r of app.rows) renderRow(r);
      refreshButtons();
      refreshView();
      if (!app.rows.some((r) => r.dirty || r.state === "working")) setStatus(`${app.rows.filter((r) => r.state === "built").length} LODs ready.`, "ok");
      pump();
    });
  }

  function markAllDirty() {
    for (const r of app.rows) {
      r.version++;
      r.dirty = true;
      r.state = "stale";
    }
    layoutRows();
    pump();
  }

  // ---- downloads ----

  function save(bytes, fileName, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const format = () => Number(ui.format.value);

  async function downloadOne(slot, index) {
    const f = format();
    const bytes = await guard(() => client.call("export", { lod: slot, format: f }));
    if (!bytes) return;
    save(bytes, lodFileName(app.name, index, f), f === 2 ? "text/plain" : "model/gltf-binary");
    setStatus(`Saved ${lodFileName(app.name, index, f)}.`, "ok");
  }

  async function downloadAll() {
    if (!app.info) return;
    const f = format();
    const files = [];
    const order = [{ slot: 0, index: 0 }, ...app.rows.filter((r) => r.state === "built").map((r) => ({ slot: r.slot, index: app.rows.indexOf(r) + 1 }))];
    setStatus("Packing the files…");
    for (const { slot, index } of order) {
      const bytes = await guard(() => client.call("export", { lod: slot, format: f }));
      if (!bytes) return;
      files.push({ name: lodFileName(app.name, index, f), bytes });
    }
    const report = await guard(() => client.call("report"));
    if (report) files.push({ name: `${app.name}_report.json`, bytes: new TextEncoder().encode(JSON.stringify(report, null, 2) + "\n") });
    let archive;
    try {
      archive = zip(files);
    } catch (e) {
      setStatus(`${e.message}. Download the LODs one by one.`, "bad");
      return;
    }
    save(archive, `${app.name}_LODs.zip`, "application/zip");
    setStatus(`Saved ${app.name}_LODs.zip (${files.length} files).`, "ok");
  }

  async function removeRow(row) {
    clearTimeout(row.timer);
    row.dirty = false;
    const i = app.rows.indexOf(row);
    if (i < 0) return;
    app.rows.splice(i, 1);
    row.el.li.remove();
    app.views.delete(row.slot);
    viewer.dropLod(row.slot);
    await guard(() => client.call("drop", { lod: row.slot }));
    layoutRows();
    refreshButtons();
    refreshView();
  }

  // ---- the preview ----

  function setNote(text) {
    ui.note.textContent = text;
    ui.note.hidden = false;
  }

  function rowLabel(slot) {
    return slot === 0 ? "LOD0" : `LOD${app.rows.findIndex((r) => r.slot === slot) + 1}`;
  }

  // One button per LOD that exists (LOD0 always; the others once built).
  function refreshButtons() {
    const slots = [0, ...app.rows.filter((r) => r.revision > 0).map((r) => r.slot)];
    if (!slots.includes(app.shown)) app.shown = 0;
    ui.lodButtons.replaceChildren();
    for (const slot of slots) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = rowLabel(slot);
      b.setAttribute("aria-pressed", String(slot === app.shown));
      b.addEventListener("click", () => {
        app.shown = slot;
        refreshButtons();
        refreshView();
      });
      ui.lodButtons.append(b);
    }
  }

  // Brings the viewer up to date with what is shown: fetches the buffers of any LOD it lacks
  // or holds an older build of.
  async function refreshView() {
    if (!viewer.ok || !app.info) return;
    const generation = app.generation;
    const built = app.rows.filter((r) => r.revision > 0);
    const slots = app.side ? [0, ...built.map((r) => r.slot)] : [app.shown];
    for (const slot of slots) {
      const row = app.rows.find((r) => r.slot === slot);
      const revision = slot === 0 ? 0 : row?.revision ?? 0;
      if (slot !== 0 && revision === 0) continue;
      if (app.views.get(slot) === revision && viewer.has(slot)) continue;
      app.views.set(slot, revision);
      const buffers = await guard(() => client.call("view", { lod: slot }));
      if (generation !== app.generation) return;
      if (buffers) viewer.setLod(slot, rowLabel(slot), buffers);
      else app.views.delete(slot);
    }
    for (const slot of built.map((r) => r.slot)) viewer.relabel(slot, rowLabel(slot));
    viewer.relabel(0, "LOD0");
    viewer.show(app.shown);
  }

  ui.side.addEventListener("click", () => {
    app.side = !app.side;
    ui.side.setAttribute("aria-pressed", String(app.side));
    viewer.set({ side: app.side });
    refreshView();
  });
  ui.wire.addEventListener("click", () => {
    const on = ui.wire.getAttribute("aria-pressed") !== "true";
    ui.wire.setAttribute("aria-pressed", String(on));
    viewer.set({ wire: on });
  });
  ui.shade.addEventListener("click", () => {
    const on = ui.shade.getAttribute("aria-pressed") !== "true";
    ui.shade.setAttribute("aria-pressed", String(on));
    viewer.set({ flat: on });
  });

  // ---- controls ----

  ui.file.addEventListener("change", () => loadFile(ui.file.files[0]));
  for (const b of document.querySelectorAll("[data-sample]")) b.addEventListener("click", () => loadSample(b.dataset.sample));
  ui.add.addEventListener("click", () => {
    const last = app.rows.length ? app.rows[app.rows.length - 1].percent : 50;
    const row = addRow(Math.max(MIN_PERCENT, last / 2));
    if (!row) return;
    layoutRows();
    if (app.live) {
      row.dirty = true;
      pump();
    } else {
      row.state = "stale";
      renderRow(row);
    }
  });
  ui.zip.addEventListener("click", downloadAll);
  ui.build.addEventListener("click", () => {
    for (const r of app.rows) {
      r.dirty = true;
    }
    pump();
  });
  ui.method.addEventListener("change", () => {
    if (!app.info) return;
    if (app.live) markAllDirty();
    else for (const r of app.rows) { r.state = "stale"; renderRow(r); }
  });

  // drag and drop anywhere on the page
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; ui.drop.classList.add("over"); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; ui.drop.classList.remove("over"); } });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    ui.drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });

  // the build id in the footer, when the site has one
  fetch("build.json").then((r) => (r.ok ? r.json() : null)).then((b) => {
    if (b?.whittle) ui.sha.textContent = String(b.whittle).slice(0, 7);
  }).catch(() => {});

  setStatus("Ready. Drop a model or try a sample.");
  window.whittle = { app, client, loadFile, loadSample, pump }; // handy in a console; no secrets in it
}

if (typeof document !== "undefined" && document.getElementById("drop")) start();
