// The preview: WebGL2, one VAO per LOD, a Lambert shader (flat normals from screen-space
// derivatives, or the smooth ones from the file), edges as GL_LINES over a polygon-offset fill,
// orbit by drag, zoom by wheel, pinch on touch, and every LOD side by side in scissored cells.
// The matrix and layout helpers are plain functions so the node tests can check them.

// ---- math (column-major, as WebGL wants) ----

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye, center, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, center));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

// The eye of an orbit camera: yaw around Y, pitch above the horizon, `distance` from the target.
export function orbitEye(target, yaw, pitch, distance) {
  const cp = Math.cos(pitch);
  return [target[0] + distance * cp * Math.sin(yaw), target[1] + distance * Math.sin(pitch), target[2] + distance * cp * Math.cos(yaw)];
}

// The bounding box of a position buffer (f32x3), or null when it is empty.
export function bounds(positions) {
  if (!positions || positions.length < 3) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return { lo, hi };
}

// How far the eye must be for a sphere of `radius` to fit a vertical field of view `fovy`.
export function fitDistance(radius, fovy, aspect = 1) {
  const half = fovy / 2;
  const halfX = Math.atan(Math.tan(half) * Math.min(1, aspect)); // the narrower side decides
  return (radius / Math.sin(Math.max(halfX, 1e-3))) * 1.05;
}

// n cells in a w x h area, top-left origin: columns chosen to keep cells near the area's shape.
export function layoutCells(n, w, h, gap = 0) {
  if (n <= 0) return [];
  const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt((n * w) / Math.max(h, 1)))));
  const rows = Math.ceil(n / cols);
  const cw = (w - gap * (cols - 1)) / cols;
  const ch = (h - gap * (rows - 1)) / rows;
  const cells = [];
  for (let i = 0; i < n; i++) {
    cells.push({ x: (i % cols) * (cw + gap), y: Math.floor(i / cols) * (ch + gap), w: cw, h: ch });
  }
  return cells;
}

// ---- shaders ----

const VERT = `#version 300 es
in vec3 aPos;
in vec3 aNrm;
uniform mat4 uMV;
uniform mat4 uP;
out vec3 vView;
out vec3 vNrm;
void main() {
  vec4 v = uMV * vec4(aPos, 1.0);
  vView = v.xyz;
  vNrm = mat3(uMV) * aNrm;
  gl_Position = uP * v;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vView;
in vec3 vNrm;
uniform bool uFlat;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  vec3 n = uFlat ? normalize(cross(dFdx(vView), dFdy(vView))) : normalize(vNrm);
  if (dot(n, -vView) < 0.0) n = -n;
  vec3 key = normalize(vec3(0.35, 0.55, 1.0));
  vec3 fill = normalize(vec3(-0.6, -0.2, 0.5));
  float l = 0.22 + 0.62 * max(dot(n, key), 0.0) + 0.22 * max(dot(n, fill), 0.0);
  outColor = vec4(uColor * l, 1.0);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uLine;
out vec4 outColor;
void main() { outColor = uLine; }`;

function compile(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader failed");
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.bindAttribLocation(p, 1, "aNrm");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link failed");
  return p;
}

const FOV = (40 * Math.PI) / 180;

export class Viewer {
  // `labels` is the element the per-LOD count labels are placed in.
  constructor(canvas, labels) {
    this.canvas = canvas;
    this.labels = labels;
    this.ok = false;
    this.lods = new Map(); // slot -> {label, triangles, buffers, gl objects}
    this.shown = 0;        // slot shown when not side by side
    this.side = false;
    this.wire = false;
    this.flat = false;
    this.yaw = 0.55;
    this.pitch = 0.32;
    this.distance = 3;
    this.target = [0, 0, 0];
    this.radius = 1;
    this.pointers = new Map();
    this.queued = false;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) return;
    this.gl = gl;
    try {
      this.fill = this.makeProgram(VERT, FRAG);
      this.line = this.makeProgram(VERT, LINE_FRAG);
    } catch (e) {
      return;
    }
    this.ok = true;
    this.watch();
  }

  makeProgram(vs, fs) {
    const gl = this.gl;
    const p = program(gl, vs, fs);
    return { p, uMV: gl.getUniformLocation(p, "uMV"), uP: gl.getUniformLocation(p, "uP"), uFlat: gl.getUniformLocation(p, "uFlat"),
      uColor: gl.getUniformLocation(p, "uColor"), uLine: gl.getUniformLocation(p, "uLine") };
  }

  // ---- data ----

  // Replaces the buffers of one LOD. `buffers` is what the worker's view returned.
  setLod(slot, label, buffers) {
    if (!this.ok) return;
    this.dropLod(slot, false);
    const gl = this.gl;
    const mk = (target, data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    };
    const pos = mk(gl.ARRAY_BUFFER, buffers.positions);
    const nrm = mk(gl.ARRAY_BUFFER, buffers.normals);
    const idx = mk(gl.ELEMENT_ARRAY_BUFFER, buffers.indices);
    const edg = mk(gl.ELEMENT_ARRAY_BUFFER, buffers.edges);
    const attributes = () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, nrm);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    };
    const triVao = gl.createVertexArray();
    gl.bindVertexArray(triVao);
    attributes();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    const edgeVao = gl.createVertexArray();
    gl.bindVertexArray(edgeVao);
    attributes();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edg);
    gl.bindVertexArray(null);
    const entry = { label, triangles: buffers.indices.length / 3, buffers, pos, nrm, idx, edg, triVao, edgeVao,
      indexCount: buffers.indices.length, edgeCount: buffers.edges.length, box: bounds(buffers.positions) };
    this.lods.set(slot, entry);
    if (slot === 0 && entry.box) this.fit(entry.box);
    this.draw();
  }

  has(slot) {
    return this.lods.has(slot);
  }

  relabel(slot, label) {
    const l = this.lods.get(slot);
    if (l) l.label = label;
  }

  dropLod(slot, redraw = true) {
    const l = this.lods.get(slot);
    if (!l) return;
    const gl = this.gl;
    for (const b of [l.pos, l.nrm, l.idx, l.edg]) gl.deleteBuffer(b);
    gl.deleteVertexArray(l.triVao);
    gl.deleteVertexArray(l.edgeVao);
    this.lods.delete(slot);
    if (redraw) this.draw();
  }

  clear() {
    for (const slot of [...this.lods.keys()]) this.dropLod(slot, false);
    this.draw();
  }

  fit(box) {
    this.target = [0, 1, 2].map((k) => (box.lo[k] + box.hi[k]) / 2);
    this.radius = Math.max(Math.hypot(box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]) / 2, 1e-6);
    this.distance = fitDistance(this.radius, FOV, 1);
  }

  show(slot) {
    this.shown = slot;
    this.draw();
  }

  set({ side, wire, flat }) {
    if (side !== undefined) this.side = side;
    if (wire !== undefined) this.wire = wire;
    if (flat !== undefined) this.flat = flat;
    this.draw();
  }

  // ---- input ----

  watch() {
    const c = this.canvas;
    new ResizeObserver(() => this.draw()).observe(c);
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pinch = this.pinchSpan();
    });
    c.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) {
        this.yaw -= dx * 0.008;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.008));
      } else if (this.pointers.size === 2) {
        const span = this.pinchSpan();
        if (this.pinch > 0 && span > 0) this.zoomBy(this.pinch / span);
        this.pinch = span;
      }
      this.draw();
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      this.pinch = this.pinchSpan();
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomBy(Math.exp(e.deltaY * 0.001));
      this.draw();
    }, { passive: false });
    c.addEventListener("webglcontextlost", (e) => e.preventDefault());
    c.addEventListener("webglcontextrestored", () => this.restore());
  }

  pinchSpan() {
    if (this.pointers.size !== 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  zoomBy(factor) {
    this.distance = Math.max(this.radius * 0.3, Math.min(this.radius * 60, this.distance * factor));
  }

  // After a lost context the GL objects are gone: rebuild them from the buffers kept on the CPU.
  restore() {
    const old = [...this.lods.entries()];
    this.lods.clear();
    this.fill = this.makeProgram(VERT, FRAG);
    this.line = this.makeProgram(VERT, LINE_FRAG);
    for (const [slot, l] of old) this.setLod(slot, l.label, l.buffers);
  }

  // ---- drawing ----

  draw() {
    if (!this.ok || this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  cssSize() {
    const r = this.canvas.getBoundingClientRect();
    return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
  }

  render() {
    const gl = this.gl;
    const { w, h } = this.cssSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const style = getComputedStyle(this.canvas);
    const bg = style.getPropertyValue("--canvas-bg").trim() || "#ecebe4";
    const [r, g, b] = parseColor(bg);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const slots = this.side ? [...this.lods.keys()].sort((a, c) => a - c) : this.lods.has(this.shown) ? [this.shown] : [];
    const cells = this.side ? layoutCells(slots.length, w, h, 4) : [{ x: 0, y: 0, w, h }];
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.SCISSOR_TEST);
    const accent = style.getPropertyValue("--model").trim() || "#c9855a";
    const lineColour = style.getPropertyValue("--wire").trim() || "rgba(20,20,20,0.55)";
    const model = parseColor(accent);
    const wire = parseColor(lineColour, true);
    this.placeLabels(slots, cells);
    slots.forEach((slot, i) => {
      const cell = cells[i];
      const x = Math.round(cell.x * dpr);
      const y = Math.round((h - cell.y - cell.h) * dpr);
      const cwid = Math.max(1, Math.round(cell.w * dpr));
      const chei = Math.max(1, Math.round(cell.h * dpr));
      gl.viewport(x, y, cwid, chei);
      gl.scissor(x, y, cwid, chei);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const proj = perspective(FOV, cell.w / cell.h, this.radius * 0.02, this.distance + this.radius * 4);
      const eye = orbitEye(this.target, this.yaw, this.pitch, this.distance);
      const mv = lookAt(eye, this.target, [0, 1, 0]);
      const l = this.lods.get(slot);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      gl.useProgram(this.fill.p);
      gl.uniformMatrix4fv(this.fill.uMV, false, mv);
      gl.uniformMatrix4fv(this.fill.uP, false, proj);
      gl.uniform1i(this.fill.uFlat, this.flat ? 1 : 0);
      gl.uniform3f(this.fill.uColor, model[0], model[1], model[2]);
      gl.bindVertexArray(l.triVao);
      gl.drawElements(gl.TRIANGLES, l.indexCount, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      if (this.wire && l.edgeCount > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.line.p);
        gl.uniformMatrix4fv(this.line.uMV, false, mv);
        gl.uniformMatrix4fv(this.line.uP, false, proj);
        gl.uniform4f(this.line.uLine, wire[0], wire[1], wire[2], wire[3]);
        gl.bindVertexArray(l.edgeVao);
        gl.drawElements(gl.LINES, l.edgeCount, gl.UNSIGNED_INT, 0);
        gl.disable(gl.BLEND);
      }
    });
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
  }

  // One DOM label per drawn LOD, at the top-left of its cell.
  placeLabels(slots, cells) {
    const host = this.labels;
    while (host.childElementCount > slots.length) host.lastElementChild.remove();
    while (host.childElementCount < slots.length) host.append(document.createElement("span"));
    slots.forEach((slot, i) => {
      const el = host.children[i];
      const l = this.lods.get(slot);
      el.textContent = `${l.label} · ${l.triangles.toLocaleString("en-US")} triangles`;
      el.style.left = `${cells[i].x + 8}px`;
      el.style.top = `${cells[i].y + 8}px`;
    });
  }
}

// "#rrggbb" or "rgb(a)(...)" -> [r, g, b] (or [r, g, b, a]) in 0..1.
export function parseColor(text, withAlpha = false) {
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (m) {
    const c = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
    return withAlpha ? [...c, 1] : c;
  }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/.exec(text);
  if (m) {
    const c = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
    return withAlpha ? [...c, m[4] === undefined ? 1 : Number(m[4])] : c;
  }
  return withAlpha ? [0, 0, 0, 1] : [0, 0, 0];
}
