/**
 * Grid distortion (Phase 26) — a decorative WebGL2 grid whose lines are
 * pushed away from the pointer and ripple with time. It is the hero's
 * backdrop, nothing more: it draws no data, states no facts, and is
 * `aria-hidden` at every call site.
 *
 * Why this module exists apart from the React island:
 *
 * 1. **The plumbing is the risk.** The failures that make an effect like
 *    this silently invisible are a mistyped uniform name, a missing
 *    attribute bind, or a shader that failed to compile with the error
 *    swallowed — none of which a screenshot would explain. Those paths
 *    live here so a recording fake `WebGL2RenderingContext` can drive
 *    them in tests, including the name cross-check between the JS and the
 *    GLSL source.
 * 2. **The maths is pure.** Geometry generation, pixel-to-clip mapping,
 *    pointer smoothing and hex→RGB are plain functions with no GL or DOM
 *    involvement, so they are unit-testable exactly.
 *
 * Rendering is deliberately dependency-free (no three.js/OGL): the whole
 * effect is one shader pair and one line-list buffer, and the project
 * gains nothing from a 3D engine for a background grid.
 */

export class GridDistortionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GridDistortionError";
  }
}

// --- shaders ---------------------------------------------------------

/**
 * `#version 300 es` is required for a WebGL2 context. The pointer is in
 * clip space ([-1, 1] on both axes); an inactive pointer is parked far
 * outside the viewport so the falloff term is ~0 everywhere.
 */
export const GRID_VERTEX_SHADER = `#version 300 es
in vec2 a_position;

uniform vec2 u_pointer;
uniform float u_time;
uniform float u_strength;

out float v_energy;

void main() {
  vec2 delta = a_position - u_pointer;
  float dist = length(delta);
  float falloff = 1.0 / (1.0 + dist * dist * 5.0);

  vec2 ripple = vec2(
    sin(u_time * 0.9 + a_position.y * 2.5),
    cos(u_time * 0.7 + a_position.x * 2.5)
  );

  vec2 offset = normalize(delta + vec2(0.00001)) * falloff * 0.35 * u_strength
              + ripple * 0.02 * u_strength;

  v_energy = falloff * u_strength;
  gl_Position = vec4(a_position + offset, 0.0, 1.0);
}
`;

/**
 * Lines are dimmer far from the pointer (v_energy), so the grid reads as
 * quieter at rest and brighter where the user is looking. Alpha comes
 * from the caller, which keeps the layer decorative under any text.
 */
export const GRID_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in float v_energy;

uniform vec3 u_color;
uniform float u_alpha;

out vec4 outColor;

void main() {
  outColor = vec4(u_color, u_alpha * (0.35 + 0.65 * clamp(v_energy, 0.0, 1.0)));
}
`;

/** Uniforms the vertex shader declares. */
export const VERTEX_UNIFORMS = ["u_pointer", "u_time", "u_strength"] as const;
/** Uniforms the fragment shader declares. */
export const FRAGMENT_UNIFORMS = ["u_color", "u_alpha"] as const;
/** The single vertex attribute the geometry feeds. */
export const POSITION_ATTRIBUTE = "a_position";

// --- geometry and maths (pure) ---------------------------------------

/**
 * Line-list geometry for a `cols`×`rows` cell grid, in clip space.
 * Vertical lines first, then horizontals; each segment is two vertices,
 * each vertex two floats. Drawn with `gl.LINES`, which is why there is no
 * index buffer — 2·(rows·(cols+1) + cols·(rows+1)) vertices exactly.
 */
export function buildGridLineVertices(cols: number, rows: number): Float32Array {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new GridDistortionError(`Grid must be a positive integer grid, got ${cols}x${rows}`);
  }

  const out: number[] = [];
  for (let col = 0; col <= cols; col += 1) {
    const x = (col / cols) * 2 - 1;
    for (let row = 0; row < rows; row += 1) {
      const y0 = (row / rows) * 2 - 1;
      const y1 = ((row + 1) / rows) * 2 - 1;
      out.push(x, y0, x, y1);
    }
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = (row / rows) * 2 - 1;
    for (let col = 0; col < cols; col += 1) {
      const x0 = (col / cols) * 2 - 1;
      const x1 = ((col + 1) / cols) * 2 - 1;
      out.push(x0, y, x1, y);
    }
  }
  return new Float32Array(out);
}

export function gridVertexCount(cols: number, rows: number): number {
  return 2 * (rows * (cols + 1) + cols * (rows + 1));
}

export interface ClipPointer {
  x: number;
  y: number;
}

/**
 * A pointer far outside the clip square: every falloff term is
 * effectively zero, so the grid rests. Used before the first pointer
 * event and whenever the pointer leaves.
 */
export const INACTIVE_POINTER: ClipPointer = { x: 1000, y: 1000 };

/**
 * DOM pixel coordinates inside `rect` → clip space. Y is flipped because
 * the DOM's origin is top-left and clip space's is bottom-left.
 */
export function toClipSpace(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): ClipPointer {
  if (rect.width <= 0 || rect.height <= 0) return INACTIVE_POINTER;
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: 1 - ((clientY - rect.top) / rect.height) * 2,
  };
}

/**
 * Frame-rate-independent approach toward a target, so the grid keeps up
 * with a fast pointer without snapping. `dt` is in seconds; `halfLife` is
 * how long it takes to close half the remaining distance.
 */
export function easePointer(
  current: ClipPointer,
  target: ClipPointer,
  dt: number,
  halfLife = 0.08,
): ClipPointer {
  if (halfLife <= 0) return target;
  const k = 1 - Math.pow(0.5, dt / halfLife);
  return {
    x: current.x + (target.x - current.x) * k,
    y: current.y + (target.y - current.y) * k,
  };
}

/** `#rrggbb` → 0..1 RGB, for the shader's `u_color`. */
export function hexToRgb01(hex: string): [number, number, number] {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) throw new GridDistortionError(`Not a 6-digit hex colour: ${hex}`);
  const value = parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// --- the renderer ----------------------------------------------------

export const GRID_COLUMNS = 14;
export const GRID_ROWS = 8;

export interface GridFrame {
  /** Seconds since the loop started (or a fixed value for a still frame). */
  time: number;
  pointer: ClipPointer;
  /** 0 freezes the effect; 1 is the full default. */
  strength?: number;
}

export interface GridRenderer {
  render(frame: GridFrame): void;
  resize(width: number, height: number, dpr: number): void;
  /** Re-tints the lines, e.g. when the colour scheme flips. */
  setColor(color: GridColor): void;
  dispose(): void;
  /** Vertices drawn per frame — asserted against the geometry. */
  readonly vertexCount: number;
}

export interface GridColor {
  hex: string;
  alpha: number;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new GridDistortionError(`Could not create the ${label} shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "no info log";
    gl.deleteShader(shader);
    throw new GridDistortionError(`${label} shader failed to compile: ${log}`);
  }
  return shader;
}

/**
 * Builds the renderer. Throws `GridDistortionError` when the program will
 * not compile or link — callers treat that as "no effect", never as a
 * broken page, which is why nothing here is caught silently.
 */
export function createGridDistortion(
  gl: WebGL2RenderingContext,
  options: { cols?: number; rows?: number; color?: GridColor } = {},
): GridRenderer {
  const cols = options.cols ?? GRID_COLUMNS;
  const rows = options.rows ?? GRID_ROWS;
  const vertices = buildGridLineVertices(cols, rows);

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, GRID_VERTEX_SHADER, "vertex");
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, GRID_FRAGMENT_SHADER, "fragment");

  const program = gl.createProgram();
  if (!program) throw new GridDistortionError("Could not create the grid program");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "no info log";
    gl.deleteProgram(program);
    throw new GridDistortionError(`Grid program failed to link: ${log}`);
  }

  const positionLocation = gl.getAttribLocation(program, POSITION_ATTRIBUTE);
  if (positionLocation < 0) {
    throw new GridDistortionError(`Grid program has no ${POSITION_ATTRIBUTE} attribute`);
  }

  const buffer = gl.createBuffer();
  if (!buffer) throw new GridDistortionError("Could not create the grid buffer");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  const uniform = (name: string): WebGLUniformLocation | null => {
    const location = gl.getUniformLocation(program, name);
    if (!location) throw new GridDistortionError(`Grid program has no ${name} uniform`);
    return location;
  };
  const uPointer = uniform("u_pointer");
  const uTime = uniform("u_time");
  const uStrength = uniform("u_strength");
  const uColor = uniform("u_color");
  const uAlpha = uniform("u_alpha");

  let color = hexToRgb01(options.color?.hex ?? "#1d4a7a");
  let alpha = options.color?.alpha ?? 0.55;
  let disposed = false;

  return {
    vertexCount: vertices.length / 2,

    render(frame: GridFrame): void {
      if (disposed) return;
      const strength = frame.strength ?? 1;
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(uPointer, frame.pointer.x, frame.pointer.y);
      gl.uniform1f(uTime, frame.time);
      gl.uniform1f(uStrength, strength);
      gl.uniform3f(uColor, color[0], color[1], color[2]);
      gl.uniform1f(uAlpha, alpha);

      gl.drawArrays(gl.LINES, 0, vertices.length / 2);
    },

    resize(width: number, height: number, dpr: number): void {
      if (disposed) return;
      const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 2) : 1;
      const w = Math.max(1, Math.round(width * ratio));
      const h = Math.max(1, Math.round(height * ratio));
      gl.viewport(0, 0, w, h);
    },

    setColor(next: GridColor): void {
      color = hexToRgb01(next.hex);
      alpha = next.alpha;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    },
  };
}
