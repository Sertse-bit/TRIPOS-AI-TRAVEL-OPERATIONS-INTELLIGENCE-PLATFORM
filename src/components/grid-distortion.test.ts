import { describe, expect, it } from "vitest";
import {
  buildGridLineVertices,
  createGridDistortion,
  easePointer,
  FRAGMENT_UNIFORMS,
  GridDistortionError,
  GRID_FRAGMENT_SHADER,
  gridVertexCount,
  GRID_VERTEX_SHADER,
  hexToRgb01,
  INACTIVE_POINTER,
  POSITION_ATTRIBUTE,
  toClipSpace,
  VERTEX_UNIFORMS,
  type GridRenderer,
} from "@/components/grid-distortion";

/**
 * No GPU and no browser here, so these tests drive the renderer with a
 * recording fake `WebGL2RenderingContext`. That is deliberate: the bugs
 * that make an effect like this silently invisible are structural (a
 * uniform name that does not exist in the GLSL, an attribute never bound,
 * a compile error swallowed), and every one of those is a *plumbing*
 * failure this fake can catch. What it cannot catch — whether the shader
 * looks good — is stated in the phase notes rather than implied by a
 * green suite.
 */

interface Call {
  name: string;
  args: unknown[];
}

interface FakeOptions {
  compileStatus?: boolean;
  linkStatus?: boolean;
  missingUniform?: string;
  missingAttribute?: boolean;
}

function createFakeGl(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const deleted: string[] = [];
  const shaderSources: string[] = [];

  const record = (name: string, result?: unknown) => {
    return (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
  };

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    LINES: 0x0001,
    createShader: (type: number) => {
      calls.push({ name: "createShader", args: [type] });
      return { type };
    },
    shaderSource: (_shader: unknown, source: string) => {
      calls.push({ name: "shaderSource", args: [source] });
      shaderSources.push(source);
    },
    compileShader: record("compileShader"),
    getShaderParameter: () => options.compileStatus ?? true,
    getShaderInfoLog: () => "synthetic compile log",
    deleteShader: () => deleted.push("shader"),
    createProgram: () => {
      calls.push({ name: "createProgram", args: [] });
      return { program: true };
    },
    attachShader: record("attachShader"),
    linkProgram: record("linkProgram"),
    getProgramParameter: () => options.linkStatus ?? true,
    getProgramInfoLog: () => "synthetic link log",
    getAttribLocation: (_program: unknown, name: string) => {
      calls.push({ name: "getAttribLocation", args: [name] });
      return options.missingAttribute ? -1 : 0;
    },
    createBuffer: () => {
      calls.push({ name: "createBuffer", args: [] });
      return { buffer: true };
    },
    bindBuffer: record("bindBuffer"),
    bufferData: record("bufferData"),
    getUniformLocation: (_program: unknown, name: string) => {
      calls.push({ name: "getUniformLocation", args: [name] });
      return options.missingUniform === name ? null : { location: name };
    },
    useProgram: record("useProgram"),
    enableVertexAttribArray: record("enableVertexAttribArray"),
    vertexAttribPointer: record("vertexAttribPointer"),
    uniform1f: record("uniform1f"),
    uniform2f: record("uniform2f"),
    uniform3f: record("uniform3f"),
    drawArrays: record("drawArrays"),
    viewport: record("viewport"),
    deleteBuffer: () => deleted.push("buffer"),
    deleteProgram: () => deleted.push("program"),
  };

  return {
    gl: gl as unknown as WebGL2RenderingContext,
    calls,
    deleted,
    shaderSources,
    namesFor: (callName: string) =>
      calls.filter((call) => call.name === callName).map((call) => String(call.args[0])),
    callsNamed: (callName: string) => calls.filter((call) => call.name === callName),
  };
}

function renderOnce(renderer: GridRenderer, pointer = { x: 0, y: 0 }, time = 1.5) {
  renderer.render({ time, pointer });
}

describe("grid geometry", () => {
  it("emits exactly one line-list segment per grid edge", () => {
    const vertices = buildGridLineVertices(3, 2);
    expect(vertices).toBeInstanceOf(Float32Array);
    // 2·(rows·(cols+1) + cols·(rows+1)) vertices, two floats each.
    expect(vertices.length / 2).toBe(gridVertexCount(3, 2));
    expect(vertices.length / 2).toBe(2 * (2 * 4 + 3 * 3));
  });

  it("stays inside the clip square and is axis-aligned", () => {
    const cols = 5;
    const rows = 4;
    const vertices = buildGridLineVertices(cols, rows);
    let verticals = 0;
    let horizontals = 0;
    for (let i = 0; i < vertices.length; i += 4) {
      const [x0, y0, x1, y1] = [vertices[i], vertices[i + 1], vertices[i + 2], vertices[i + 3]];
      for (const value of [x0, y0, x1, y1]) {
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
      }
      if (x0 === x1 && y0 !== y1) verticals += 1;
      else if (y0 === y1 && x0 !== x1) horizontals += 1;
      else throw new Error(`Segment ${i / 4} is not axis-aligned: ${x0},${y0} → ${x1},${y1}`);
    }
    expect(verticals).toBe(rows * (cols + 1));
    expect(horizontals).toBe(cols * (rows + 1));
  });

  it("rejects a non-positive or fractional grid instead of emitting nothing", () => {
    expect(() => buildGridLineVertices(0, 4)).toThrow(GridDistortionError);
    expect(() => buildGridLineVertices(4, -1)).toThrow(GridDistortionError);
    expect(() => buildGridLineVertices(2.5, 4)).toThrow(GridDistortionError);
  });
});

describe("pointer maths", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it("maps the DOM box onto clip space with the Y axis flipped", () => {
    expect(toClipSpace(300, 150, rect)).toEqual({ x: 0, y: 0 });
    expect(toClipSpace(100, 50, rect)).toEqual({ x: -1, y: 1 });
    expect(toClipSpace(500, 250, rect)).toEqual({ x: 1, y: -1 });
  });

  it("parks the pointer off-screen for a zero-sized box", () => {
    expect(toClipSpace(10, 10, { left: 0, top: 0, width: 0, height: 10 })).toEqual(
      INACTIVE_POINTER,
    );
    expect(toClipSpace(10, 10, { left: 0, top: 0, width: 10, height: 0 })).toEqual(
      INACTIVE_POINTER,
    );
  });

  it("approaches the target without overshooting, and snaps on a zero half-life", () => {
    const start = { x: -1, y: -1 };
    const target = { x: 1, y: 1 };
    let current = start;
    let previousDistance = Number.POSITIVE_INFINITY;
    for (let step = 0; step < 20; step += 1) {
      current = easePointer(current, target, 1 / 60);
      const distance = Math.hypot(target.x - current.x, target.y - current.y);
      expect(distance).toBeLessThan(previousDistance);
      previousDistance = distance;
    }
    expect(current.x).toBeLessThan(target.x);
    expect(current.y).toBeLessThan(target.y);
    // One half-life closes half the distance.
    expect(easePointer(start, target, 0.08, 0.08).x).toBeCloseTo(0, 10);
    expect(easePointer(start, target, 0.016, 0)).toEqual(target);
    expect(easePointer(start, target, 0, 0.08)).toEqual(start);
  });
});

describe("colour conversion", () => {
  it("converts palette hex to the shader's 0..1 range", () => {
    expect(hexToRgb01("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb01("#000000")).toEqual([0, 0, 0]);
    const [r, g, b] = hexToRgb01("#6198cf");
    expect(r).toBeCloseTo(0x61 / 255, 6);
    expect(g).toBeCloseTo(0x98 / 255, 6);
    expect(b).toBeCloseTo(0xcf / 255, 6);
  });

  it("refuses anything that is not a 6-digit hex colour", () => {
    expect(() => hexToRgb01("var(--grid-line)")).toThrow(GridDistortionError);
    expect(() => hexToRgb01("#fff")).toThrow(GridDistortionError);
    expect(() => hexToRgb01("")).toThrow(GridDistortionError);
  });
});

describe("shader and uniform contract", () => {
  it("declares every uniform and attribute it is addressed by", () => {
    for (const name of VERTEX_UNIFORMS) {
      expect(GRID_VERTEX_SHADER).toContain(`uniform`);
      expect(GRID_VERTEX_SHADER).toContain(name);
    }
    for (const name of FRAGMENT_UNIFORMS) {
      expect(GRID_FRAGMENT_SHADER).toContain(name);
    }
    expect(GRID_VERTEX_SHADER).toContain(POSITION_ATTRIBUTE);
  });

  it("addresses only names that appear in the GLSL, in the right stage", () => {
    const fake = createFakeGl();
    const renderer = createGridDistortion(fake.gl);
    renderOnce(renderer);

    const uniformNames = fake.namesFor("getUniformLocation");
    expect(new Set(uniformNames)).toEqual(
      new Set(["u_pointer", "u_time", "u_strength", "u_color", "u_alpha"]),
    );
    for (const name of ["u_pointer", "u_time", "u_strength"]) {
      expect(GRID_VERTEX_SHADER).toContain(name);
    }
    for (const name of ["u_color", "u_alpha"]) {
      expect(GRID_FRAGMENT_SHADER).toContain(name);
    }
    expect(fake.namesFor("getAttribLocation")).toEqual([POSITION_ATTRIBUTE]);
    expect(GRID_VERTEX_SHADER).toContain(POSITION_ATTRIBUTE);
    // Both stages were compiled from the exported sources, not from copies.
    expect(fake.shaderSources).toContain(GRID_VERTEX_SHADER);
    expect(fake.shaderSources).toContain(GRID_FRAGMENT_SHADER);
  });
});

describe("renderer", () => {
  it("uploads the same geometry the pure builder produces", () => {
    const fake = createFakeGl();
    createGridDistortion(fake.gl, { cols: 4, rows: 3 });
    const upload = fake.callsNamed("bufferData")[0];
    const [target, data, usage] = upload.args as [number, Float32Array, number];
    expect(target).toBe(fake.gl.ARRAY_BUFFER);
    expect(usage).toBe(fake.gl.STATIC_DRAW);
    expect(Array.from(data)).toEqual(Array.from(buildGridLineVertices(4, 3)));
  });

  it("draws every vertex once per frame with the frame's values", () => {
    const fake = createFakeGl();
    const renderer = createGridDistortion(fake.gl, { color: { hex: "#1d4a7a", alpha: 0.5 } });
    expect(renderer.vertexCount).toBe(gridVertexCount(14, 8));

    renderOnce(renderer, { x: 0.25, y: -0.5 }, 2);
    const draws = fake.callsNamed("drawArrays");
    expect(draws).toHaveLength(1);
    expect(draws[0].args).toEqual([fake.gl.LINES, 0, renderer.vertexCount]);

    expect(fake.callsNamed("uniform2f")[0].args).toEqual([{ location: "u_pointer" }, 0.25, -0.5]);
    expect(fake.callsNamed("uniform1f").map((call) => call.args)).toEqual([
      [{ location: "u_time" }, 2],
      [{ location: "u_strength" }, 1],
      [{ location: "u_alpha" }, 0.5],
    ]);
    expect(fake.callsNamed("uniform3f")[0].args).toEqual([
      { location: "u_color" },
      0x1d / 255,
      0x4a / 255,
      0x7a / 255,
    ]);
    // Alpha belongs to the renderer's colour, not to the frame, so it is
    // set from the colour the renderer was built with.
    expect(fake.callsNamed("uniform1f").at(-1)?.args).toEqual([{ location: "u_alpha" }, 0.5]);
    expect(fake.callsNamed("useProgram")).toHaveLength(1);
    expect(fake.callsNamed("vertexAttribPointer")[0].args.slice(1, 3)).toEqual([2, fake.gl.FLOAT]);
  });

  it("retints the lines without rebuilding the program", () => {
    const fake = createFakeGl();
    const renderer = createGridDistortion(fake.gl);
    renderOnce(renderer);
    renderer.setColor({ hex: "#ffffff", alpha: 0.2 });
    renderOnce(renderer);

    const colors = fake.callsNamed("uniform3f").map((call) => call.args);
    expect(colors.at(-1)).toEqual([{ location: "u_color" }, 1, 1, 1]);
    // One program for the renderer's whole life: retinting must not compile
    // or link anything again.
    expect(fake.callsNamed("createProgram")).toHaveLength(1);
    expect(fake.callsNamed("linkProgram")).toHaveLength(1);
  });

  it("clamps the device pixel ratio and never asks for a zero-sized viewport", () => {
    const fake = createFakeGl();
    const renderer = createGridDistortion(fake.gl);
    renderer.resize(300, 200, 4);
    renderer.resize(0, 0, Number.NaN);
    expect(fake.callsNamed("viewport").map((call) => call.args)).toEqual([
      [0, 0, 600, 400],
      [0, 0, 1, 1],
    ]);
  });

  it("releases GL objects and stops drawing after dispose", () => {
    const fake = createFakeGl();
    const renderer = createGridDistortion(fake.gl);
    renderOnce(renderer);
    const drawsBefore = fake.callsNamed("drawArrays").length;
    renderer.dispose();
    renderOnce(renderer);
    renderer.resize(10, 10, 1);
    renderer.dispose();

    expect(fake.deleted.filter((item) => item === "shader")).toHaveLength(2);
    expect(fake.deleted).toContain("program");
    expect(fake.deleted).toContain("buffer");
    expect(fake.callsNamed("drawArrays")).toHaveLength(drawsBefore);
    expect(fake.callsNamed("viewport")).toHaveLength(0);
  });

  it("reports a compile failure with the driver's log instead of a blank canvas", () => {
    const fake = createFakeGl({ compileStatus: false });
    expect(() => createGridDistortion(fake.gl)).toThrowError(/synthetic compile log/);
    expect(fake.deleted).toContain("shader");
  });

  it("reports a link failure and a missing attribute or uniform", () => {
    expect(() => createGridDistortion(createFakeGl({ linkStatus: false }).gl)).toThrowError(
      /synthetic link log/,
    );
    expect(() => createGridDistortion(createFakeGl({ missingAttribute: true }).gl)).toThrowError(
      POSITION_ATTRIBUTE,
    );
    expect(() => createGridDistortion(createFakeGl({ missingUniform: "u_time" }).gl)).toThrowError(
      "u_time",
    );
  });
});
