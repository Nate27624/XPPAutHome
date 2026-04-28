import { describe, expect, it } from "vitest";
import { XpwRuntimeClient } from "./index";

const SIMPLE_MODEL = `v'=-v
init v=1
done
`;

const PLANAR_MODEL = `v'=-v+w
w'=-w
init v=1,w=0
done
`;

const BIF_MODEL = `x'=a*x+b-x^3
par b=1,a=1
init x=1.325
done
`;

describe("XpwRuntimeClient", () => {
  it("keeps model state when switching from WASM to fallback after load", async () => {
    const runtime = new XpwRuntimeClient() as unknown as {
      fallback: { boot: () => Promise<void> };
      wasm: {
        loadModel: (odeText: string, fileName: string) => Promise<{
          variables: string[];
          parameters: string[];
          parameterValues: Record<string, number>;
          auxiliaries: string[];
          sets: string[];
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
        getModelInfo: () => Promise<never>;
      };
      useFallback: boolean;
      loadModel: (odeText: string, fileName: string) => Promise<unknown>;
      getModelInfo: () => Promise<{
        variables: string[];
        diagnostics?: Array<{ code: string; message: string; tier: string }>;
      }>;
    };

    await runtime.fallback.boot();
    runtime.wasm = {
      async loadModel() {
        return {
          variables: ["v"],
          parameters: [],
          parameterValues: {},
          auxiliaries: [],
          sets: [],
          diagnostics: []
        };
      },
      async getModelInfo() {
        throw new Error("forced wasm getModelInfo failure");
      }
    };
    runtime.useFallback = false;

    await runtime.loadModel(SIMPLE_MODEL, "simple.ode");
    const info = await runtime.getModelInfo();

    expect(info.variables).toContain("v");
    expect(info.diagnostics?.some((diag) => diag.code === "ENGINE_FALLBACK_ACTIVE")).toBe(true);
  });

  it("falls back for phase-plane when WASM output is incomplete", async () => {
    const runtime = new XpwRuntimeClient() as unknown as {
      fallback: { boot: () => Promise<void> };
      wasm: {
        loadModel: (odeText: string, fileName: string) => Promise<{
          variables: string[];
          parameters: string[];
          parameterValues: Record<string, number>;
          auxiliaries: string[];
          sets: string[];
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
        runPhasePlane: () => Promise<{
          vectorField: Array<{ x: number; y: number; dx: number; dy: number }>;
          nullclines: { xNullcline: Array<Array<[number, number]>>; yNullcline: Array<Array<[number, number]>> };
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
      };
      useFallback: boolean;
      loadModel: (odeText: string, fileName: string) => Promise<unknown>;
      runPhasePlane: (request: {
        xVar: string;
        yVar: string;
        fixedState: Record<string, number>;
        parameterOverrides: Record<string, number>;
        vectorField: { xMin: number; xMax: number; yMin: number; yMax: number; xSteps: number; ySteps: number };
        nullclineGrid: { xSteps: number; ySteps: number };
        trajectory: { enabled: boolean; tEnd: number; dt: number };
      }) => Promise<{
        vectorField: Array<{ x: number; y: number; dx: number; dy: number }>;
        nullclines: { xNullcline: Array<Array<[number, number]>>; yNullcline: Array<Array<[number, number]>> };
        diagnostics?: Array<{ code: string; message: string; tier: string }>;
      }>;
    };

    await runtime.fallback.boot();
    runtime.wasm = {
      async loadModel() {
        return {
          variables: ["v", "w"],
          parameters: [],
          parameterValues: {},
          auxiliaries: [],
          sets: [],
          diagnostics: []
        };
      },
      async runPhasePlane() {
        return {
          vectorField: [],
          nullclines: { xNullcline: [], yNullcline: [] },
          diagnostics: []
        };
      }
    };
    runtime.useFallback = false;

    await runtime.loadModel(PLANAR_MODEL, "planar.ode");
    const phase = await runtime.runPhasePlane({
      xVar: "v",
      yVar: "w",
      fixedState: {},
      parameterOverrides: {},
      vectorField: { xMin: -2, xMax: 2, yMin: -2, yMax: 2, xSteps: 12, ySteps: 12 },
      nullclineGrid: { xSteps: 40, ySteps: 40 },
      trajectory: { enabled: true, tEnd: 10, dt: 0.05 }
    });

    expect(phase.vectorField.length).toBeGreaterThan(0);
    expect(phase.diagnostics?.some((diag) => diag.code === "ENGINE_FALLBACK_ACTIVE")).toBe(true);
  });

  it("keeps bifurcation on WASM after a phase-plane local fallback", async () => {
    const runtime = new XpwRuntimeClient() as unknown as {
      fallback: { boot: () => Promise<void> };
      wasm: {
        loadModel: (odeText: string, fileName: string) => Promise<{
          variables: string[];
          parameters: string[];
          parameterValues: Record<string, number>;
          auxiliaries: string[];
          sets: string[];
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
        runPhasePlane: () => Promise<{
          vectorField: Array<{ x: number; y: number; dx: number; dy: number }>;
          nullclines: { xNullcline: Array<Array<[number, number]>>; yNullcline: Array<Array<[number, number]>> };
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
        runBifurcation: () => Promise<{
          mode: "one_param";
          points: Array<{
            index: number;
            label: number;
            type: string;
            branch: number;
            stable?: boolean;
            x: number;
            y: number;
            parameters: Record<string, number>;
          }>;
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
      };
      useFallback: boolean;
      loadModel: (odeText: string, fileName: string) => Promise<unknown>;
      runPhasePlane: (request: {
        xVar: string;
        yVar: string;
        fixedState: Record<string, number>;
        parameterOverrides: Record<string, number>;
        vectorField: { xMin: number; xMax: number; yMin: number; yMax: number; xSteps: number; ySteps: number };
        nullclineGrid: { xSteps: number; ySteps: number };
        trajectory: { enabled: boolean; tEnd: number; dt: number };
      }) => Promise<{
        vectorField: Array<{ x: number; y: number; dx: number; dy: number }>;
        nullclines: { xNullcline: Array<Array<[number, number]>>; yNullcline: Array<Array<[number, number]>> };
        diagnostics?: Array<{ code: string; message: string; tier: string }>;
      }>;
      runBifurcation: (request: {
        mode: "one_param";
        primaryParameter: string;
        yVariable?: string;
        parameterOverrides?: Record<string, number>;
        startStrategy?: "steady_state" | "periodic" | "continue_label";
        controls: {
          ntst: number;
          nmx: number;
          npr: number;
          ncol: number;
          ds: number;
          dsMin: number;
          dsMax: number;
          rl0: number;
          rl1: number;
          a0: number;
          a1: number;
          epsl: number;
          epsu: number;
          epss: number;
        };
      }) => Promise<{
        mode: "one_param";
        points: Array<{
          index: number;
          label: number;
          type: string;
          branch: number;
          stable?: boolean;
          x: number;
          y: number;
          parameters: Record<string, number>;
        }>;
        diagnostics?: Array<{ code: string; message: string; tier: string }>;
      }>;
    };

    await runtime.fallback.boot();
    runtime.wasm = {
      async loadModel() {
        return {
          variables: ["v", "w"],
          parameters: ["i"],
          parameterValues: { i: 0 },
          auxiliaries: [],
          sets: [],
          diagnostics: []
        };
      },
      async runPhasePlane() {
        return {
          vectorField: [],
          nullclines: { xNullcline: [], yNullcline: [] },
          diagnostics: []
        };
      },
      async runBifurcation() {
        return {
          mode: "one_param",
          points: [
            {
              index: 0,
              label: 1,
              type: "LP",
              branch: 1,
              x: 0,
              y: 0,
              parameters: { i: 0 }
            },
            {
              index: 1,
              label: 2,
              type: "EP",
              branch: 1,
              x: 0.2,
              y: 0.1,
              parameters: { i: 0.2 }
            },
            {
              index: 2,
              label: 3,
              type: "EP",
              branch: 1,
              x: 0.4,
              y: 0.2,
              parameters: { i: 0.4 }
            }
          ],
          diagnostics: []
        };
      }
    };
    runtime.useFallback = false;

    await runtime.loadModel(PLANAR_MODEL, "planar.ode");
    const phase = await runtime.runPhasePlane({
      xVar: "v",
      yVar: "w",
      fixedState: {},
      parameterOverrides: {},
      vectorField: { xMin: -2, xMax: 2, yMin: -2, yMax: 2, xSteps: 12, ySteps: 12 },
      nullclineGrid: { xSteps: 40, ySteps: 40 },
      trajectory: { enabled: true, tEnd: 10, dt: 0.05 }
    });
    expect(phase.diagnostics?.some((diag) => diag.code === "ENGINE_FALLBACK_ACTIVE")).toBe(true);

    const bif = await runtime.runBifurcation({
      mode: "one_param",
      primaryParameter: "i",
      yVariable: "v",
      controls: {
        ntst: 15,
        nmx: 30,
        npr: 10,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.2,
        rl0: -1,
        rl1: 1,
        a0: -2,
        a1: 2,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });
    expect(bif.points.length).toBe(3);
    expect(bif.diagnostics?.some((diag) => diag.code === "ENGINE_FALLBACK_ACTIVE")).toBe(false);
  });

  it("normalizes non-special AUTO labels in bifurcation output", async () => {
    const runtime = new XpwRuntimeClient() as unknown as {
      fallback: { boot: () => Promise<void> };
      wasm: {
        loadModel: (odeText: string, fileName: string) => Promise<{
          variables: string[];
          parameters: string[];
          parameterValues: Record<string, number>;
          auxiliaries: string[];
          sets: string[];
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
        runBifurcation: () => Promise<{
          mode: "one_param";
          points: Array<{
            index: number;
            label: number;
            type: string;
            branch: number;
            stable?: boolean;
            x: number;
            y: number;
            parameters: Record<string, number>;
          }>;
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
      };
      useFallback: boolean;
      loadModel: (odeText: string, fileName: string) => Promise<unknown>;
      runBifurcation: (request: {
        mode: "one_param";
        primaryParameter: string;
        yVariable?: string;
        controls: {
          ntst: number;
          nmx: number;
          npr: number;
          ncol: number;
          ds: number;
          dsMin: number;
          dsMax: number;
          rl0: number;
          rl1: number;
          a0: number;
          a1: number;
          epsl: number;
          epsu: number;
          epss: number;
        };
      }) => Promise<{
        mode: "one_param";
        points: Array<{
          index: number;
          label: number;
          type: string;
          branch: number;
          stable?: boolean;
          x: number;
          y: number;
          parameters: Record<string, number>;
        }>;
        diagnostics?: Array<{ code: string; message: string; tier: string }>;
      }>;
    };

    await runtime.fallback.boot();
    runtime.wasm = {
      async loadModel() {
        return {
          variables: ["x"],
          parameters: ["a"],
          parameterValues: { a: 0 },
          auxiliaries: [],
          sets: [],
          diagnostics: []
        };
      },
      async runBifurcation() {
        return {
          mode: "one_param",
          points: [
            { index: 0, label: 1, type: "EP", branch: 1, x: -1, y: -1, parameters: { a: -1 } },
            { index: 1, label: 2, type: "HB", branch: 1, x: 0, y: 0, parameters: { a: 0 } },
            { index: 2, label: 3, type: "UZ", branch: 1, x: 1, y: 1, parameters: { a: 1 } }
          ],
          diagnostics: []
        };
      }
    };
    runtime.useFallback = false;

    await runtime.loadModel(BIF_MODEL, "bif.ode");
    const bif = await runtime.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "x",
      controls: {
        ntst: 15,
        nmx: 120,
        npr: 30,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.2,
        rl0: -1,
        rl1: 2,
        a0: -10,
        a1: 10,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    expect(bif.points.map((point) => ({ type: point.type, label: point.label }))).toEqual([
      { type: "EP", label: 0 },
      { type: "HB", label: 2 },
      { type: "UZ", label: 0 }
    ]);
  });

  it("sanitizes non-finite phase-plane outputs from WASM", async () => {
    const runtime = new XpwRuntimeClient() as unknown as {
      fallback: { boot: () => Promise<void> };
      wasm: {
        loadModel: (odeText: string, fileName: string) => Promise<{
          variables: string[];
          parameters: string[];
          parameterValues: Record<string, number>;
          auxiliaries: string[];
          sets: string[];
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
        runPhasePlane: () => Promise<{
          vectorField: Array<{ x: number; y: number; dx: number; dy: number }>;
          nullclines: { xNullcline: Array<Array<[number, number]>>; yNullcline: Array<Array<[number, number]>> };
          trajectory?: { time: number[]; x: number[]; y: number[] };
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
      };
      useFallback: boolean;
      loadModel: (odeText: string, fileName: string) => Promise<unknown>;
      runPhasePlane: (request: {
        xVar: string;
        yVar: string;
        fixedState: Record<string, number>;
        parameterOverrides: Record<string, number>;
        vectorField: { xMin: number; xMax: number; yMin: number; yMax: number; xSteps: number; ySteps: number };
        nullclineGrid: { xSteps: number; ySteps: number };
        trajectory: { enabled: boolean; tEnd: number; dt: number };
      }) => Promise<{
        vectorField: Array<{ x: number; y: number; dx: number; dy: number }>;
        nullclines: { xNullcline: Array<Array<[number, number]>>; yNullcline: Array<Array<[number, number]>> };
        trajectory?: { time: number[]; x: number[]; y: number[] };
        diagnostics?: Array<{ code: string; message: string; tier: string }>;
      }>;
    };

    await runtime.fallback.boot();
    runtime.wasm = {
      async loadModel() {
        return {
          variables: ["v", "w"],
          parameters: [],
          parameterValues: {},
          auxiliaries: [],
          sets: [],
          diagnostics: []
        };
      },
      async runPhasePlane() {
        return {
          vectorField: [
            { x: 0, y: 0, dx: 1, dy: Number.NaN },
            { x: Number.NaN, y: 1, dx: 0, dy: 2 }
          ],
          nullclines: {
            xNullcline: [[[0, Number.NaN]]],
            yNullcline: [[[1, 2]]]
          },
          trajectory: {
            time: [0, Number.NaN],
            x: [0, 1],
            y: [Number.NaN, 2]
          },
          diagnostics: []
        };
      }
    };
    runtime.useFallback = false;

    await runtime.loadModel(PLANAR_MODEL, "planar.ode");
    const phase = await runtime.runPhasePlane({
      xVar: "v",
      yVar: "w",
      fixedState: {},
      parameterOverrides: {},
      vectorField: { xMin: -2, xMax: 2, yMin: -2, yMax: 2, xSteps: 12, ySteps: 12 },
      nullclineGrid: { xSteps: 40, ySteps: 40 },
      trajectory: { enabled: true, tEnd: 10, dt: 0.05 }
    });

    expect(phase.vectorField.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.dx) && Number.isFinite(p.dy))).toBe(true);
    expect(phase.trajectory?.time.every((v) => Number.isFinite(v))).toBe(true);
    expect(phase.trajectory?.y.every((v) => Number.isFinite(v))).toBe(true);
    expect(phase.diagnostics?.some((diag) => diag.code === "PHASE_NONFINITE_VALUES_SANITIZED")).toBe(true);
  });

  it("sanitizes non-finite simulation outputs from WASM", async () => {
    const runtime = new XpwRuntimeClient() as unknown as {
      fallback: { boot: () => Promise<void> };
      wasm: {
        loadModel: (odeText: string, fileName: string) => Promise<{
          variables: string[];
          parameters: string[];
          parameterValues: Record<string, number>;
          auxiliaries: string[];
          sets: string[];
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
        runSimulation: () => Promise<{
          time: number[];
          series: Record<string, number[]>;
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
      };
      useFallback: boolean;
      loadModel: (odeText: string, fileName: string) => Promise<unknown>;
      runSimulation: (request: {
        integrator: "rk4";
        t0: number;
        tEnd: number;
        dt: number;
        transient: number;
        outputStride: number;
        parameterOverrides: Record<string, number>;
        initialConditions: Record<string, number>;
        requestedSeries: string[];
      }) => Promise<{
        time: number[];
        series: Record<string, number[]>;
        diagnostics?: Array<{ code: string; message: string; tier: string }>;
      }>;
    };

    await runtime.fallback.boot();
    runtime.wasm = {
      async loadModel() {
        return {
          variables: ["v"],
          parameters: [],
          parameterValues: {},
          auxiliaries: [],
          sets: [],
          diagnostics: []
        };
      },
      async runSimulation() {
        return {
          time: [0, 0.05, Number.NaN, 0.15],
          series: {
            v: [-60, Number.NaN, Number.POSITIVE_INFINITY, -55]
          },
          diagnostics: []
        };
      }
    };
    runtime.useFallback = false;

    await runtime.loadModel(SIMPLE_MODEL, "simple.ode");
    const sim = await runtime.runSimulation({
      integrator: "rk4",
      t0: 0,
      tEnd: 1,
      dt: 0.05,
      transient: 0,
      outputStride: 1,
      parameterOverrides: {},
      initialConditions: {},
      requestedSeries: []
    });

    expect(sim.time.every((value) => Number.isFinite(value))).toBe(true);
    expect((sim.series.v ?? []).every((value) => Number.isFinite(value))).toBe(true);
    expect(sim.diagnostics?.some((diag) => diag.code === "SIM_NONFINITE_VALUES_SANITIZED")).toBe(true);
    expect(runtime.useFallback).toBe(false);
  });

  it("keeps sparse bifurcation output on WASM for XPP parity", async () => {
    const runtime = new XpwRuntimeClient() as unknown as {
      fallback: { boot: () => Promise<void> };
      wasm: {
        loadModel: (odeText: string, fileName: string) => Promise<{
          variables: string[];
          parameters: string[];
          parameterValues: Record<string, number>;
          auxiliaries: string[];
          sets: string[];
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
        runBifurcation: () => Promise<{
          mode: "one_param";
          points: Array<{
            index: number;
            label: number;
            type: string;
            branch: number;
            stable?: boolean;
            x: number;
            y: number;
            parameters: Record<string, number>;
          }>;
          diagnostics: Array<{ code: string; message: string; tier: "warning" | "unsupported" }>;
        }>;
      };
      useFallback: boolean;
      loadModel: (odeText: string, fileName: string) => Promise<unknown>;
      runBifurcation: (request: {
        mode: "one_param";
        primaryParameter: string;
        yVariable?: string;
        parameterOverrides?: Record<string, number>;
        startStrategy?: "steady_state" | "periodic" | "continue_label";
        controls: {
          ntst: number;
          nmx: number;
          npr: number;
          ncol: number;
          ds: number;
          dsMin: number;
          dsMax: number;
          rl0: number;
          rl1: number;
          a0: number;
          a1: number;
          epsl: number;
          epsu: number;
          epss: number;
        };
      }) => Promise<{
        mode: "one_param";
        points: Array<{
          index: number;
          label: number;
          type: string;
          branch: number;
          stable?: boolean;
          x: number;
          y: number;
          parameters: Record<string, number>;
        }>;
        diagnostics?: Array<{ code: string; message: string; tier: string }>;
      }>;
    };

    await runtime.fallback.boot();
    runtime.wasm = {
      async loadModel() {
        return {
          variables: ["x"],
          parameters: ["a", "b"],
          parameterValues: { a: 1, b: 1 },
          auxiliaries: [],
          sets: [],
          diagnostics: []
        };
      },
      async runBifurcation() {
        return {
          mode: "one_param",
          points: [
            {
              index: 0,
              label: 1,
              type: "EP",
              branch: 1,
              x: 1,
              y: 1.3,
              parameters: { a: 1 }
            },
            {
              index: 1,
              label: 2,
              type: "MX",
              branch: 1,
              x: 1,
              y: 1.3,
              parameters: { a: 1 }
            }
          ],
          diagnostics: [
            {
              code: "SPARSE_BIFURCATION_OUTPUT",
              message: "sparse",
              tier: "warning"
            }
          ]
        };
      }
    };
    runtime.useFallback = false;

    await runtime.loadModel(BIF_MODEL, "bif.ode");
    const bif = await runtime.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "x",
      controls: {
        ntst: 15,
        nmx: 120,
        npr: 30,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.2,
        rl0: -1,
        rl1: 2,
        a0: -10,
        a1: 10,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    expect(bif.points.length).toBe(2);
    expect(bif.diagnostics?.some((diag) => diag.code === "SPARSE_BIFURCATION_OUTPUT")).toBe(true);
    expect(bif.diagnostics?.some((diag) => diag.code === "ENGINE_FALLBACK_ACTIVE")).toBe(false);
    expect(runtime.useFallback).toBe(false);
  });
});
