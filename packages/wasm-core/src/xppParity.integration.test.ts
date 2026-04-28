import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { BifurcationRequest, BifurcationResult, SimulationResult } from "@xpp/core-api";
import { FallbackXppEngine } from "./fallbackEngine";
import { createWasmRuntime, type WasmXpwRuntime } from "./wasmRuntime";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

const SIMPLEFOLD = readFileSync(join(repoRoot, "vendor/xppaut/tstauto/simplefold.ode"), "utf8");
const LECAR = readFileSync(join(repoRoot, "vendor/xppaut/tstauto/lecar.ode"), "utf8");
const DESTEXHE_PARE = `# Destexhe & Pare model (vtrap-stabilized)
vtrap(x,y)=x/(exp(x/y)-1)
am(v)=.32*vtrap(-(v-vt-13),4)
par i=0,gkm=2
num vt=-58,vs=-10
bm(v)=.28*vtrap(v-vt-40,5)
ah(v)=.128*exp(-(v-vt-vs-17)/18)
bh(v)=4/(1+exp(-(v-vt-vs-40)/5))
ina(v,m,h)=gna*m^3*h*(v-ena)
par gna=120,ena=55
an(v)=.032*vtrap(-(v-vt-15),5)
bn(v)=.5*exp(-(v-vt-10)/40)
ikdr(v,n)=gk*n^4*(v-ek)
par gk=100,ek=-85
akm(v)=.0001*vtrap(-(v+30),9)
bkm(v)=.0001*vtrap(v+30,9)
ikm(v,m)=gkm*m*(v-ek)
v'=(I-gl*(v-el)-ikdr(v,n)-ina(v,m,h)-ikm(v,mk))/cm
m'=am(v)*(1-m)-bm(v)*m
h'=ah(v)*(1-h)-bh(v)*h
n'=an(v)*(1-n)-bn(v)*n
mk'=akm(v)*(1-mk)-bkm(v)*mk
init v=-73.87,m=0,h=1,n=.002,mk=.0075
par gl=.019,el=-65,cm=1
@ total=2000,dt=.05,meth=rk4
done
`;
const WASM_ENTRY_URL = new URL("../dist/wasm/xppcore.js", import.meta.url).toString();

const BASE_CONTROLS: BifurcationRequest["controls"] = {
  ntst: 20,
  nmx: 320,
  pointDensity: 1,
  npr: 30,
  ncol: 4,
  ds: 0.02,
  dsMin: 0.001,
  dsMax: 0.2,
  rl0: -1,
  rl1: 2,
  a0: -1e6,
  a1: 1e6,
  epsl: 1e-4,
  epsu: 1e-4,
  epss: 1e-4
};

function isSpecialType(type: string): boolean {
  const t = type.trim().toUpperCase();
  return t.startsWith("HB") || t.startsWith("LP") || t.startsWith("BP") || t.startsWith("PD") ||
    t.startsWith("TR") || t.startsWith("BIF") || t === "BT" || t === "CP" || t === "GH" || t === "ZH" || t === "NS";
}

function fiFromPeriodic(points: BifurcationResult["points"]): Array<{ x: number; y: number }> {
  return points
    .filter((point) => point.branch < 0 && typeof point.period === "number" && Number.isFinite(point.period) && point.period > 0 && Number.isFinite(point.x))
    .map((point) => ({ x: point.x, y: 1 / (point.period as number) }))
    .sort((a, b) => a.x - b.x);
}

function estimateFiringRateFromSimulation(sim: SimulationResult, signalName: string): number {
  const values = sim.series[signalName] ?? [];
  if (sim.time.length < 3 || values.length < 3) {
    return 0;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const paired: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < sim.time.length; i += 1) {
    const t = sim.time[i];
    const v = values[i];
    if (typeof t !== "number" || typeof v !== "number" || !Number.isFinite(t) || !Number.isFinite(v)) {
      continue;
    }
    paired.push({ t, v });
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  if (paired.length < 3 || !Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }
  const amp = max - min;
  if (amp < 1e-6) {
    return 0;
  }
  const threshold = min + amp * 0.5;
  const spikes: number[] = [];
  for (let i = 1; i < paired.length; i += 1) {
    const prev = paired[i - 1];
    const curr = paired[i];
    if (!prev || !curr) {
      continue;
    }
    if (prev.v < threshold && curr.v >= threshold) {
      spikes.push(curr.t);
    }
  }
  if (spikes.length < 2) {
    return 0;
  }
  const duration = (spikes[spikes.length - 1] ?? 0) - (spikes[0] ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return (spikes.length - 1) / duration;
}

function pearsonCorrelation(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) {
    return 0;
  }
  const n = a.length;
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 1e-12 || varB <= 1e-12) {
    return 0;
  }
  return cov / Math.sqrt(varA * varB);
}

describe("XPPAUT parity integration (WASM core)", () => {
  let runtime: WasmXpwRuntime;
  const nativeFetch = globalThis.fetch.bind(globalThis);

  beforeAll(async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (href.startsWith("file://")) {
        const payload = readFileSync(fileURLToPath(href));
        const isWasm = href.endsWith(".wasm");
        return new Response(payload, {
          status: 200,
          headers: isWasm ? { "content-type": "application/wasm" } : { "content-type": "application/javascript" }
        });
      }
      if (href.startsWith("/") && !href.startsWith("//")) {
        const payload = readFileSync(href);
        const isWasm = href.endsWith(".wasm");
        return new Response(payload, {
          status: 200,
          headers: isWasm ? { "content-type": "application/wasm" } : { "content-type": "application/javascript" }
        });
      }
      return nativeFetch(input as RequestInfo, init);
    }) as typeof fetch;
    (globalThis as { __XPP_WASM_ENTRY?: string }).__XPP_WASM_ENTRY = WASM_ENTRY_URL;
    runtime = await createWasmRuntime();
    await runtime.boot();
  });

  afterAll(async () => {
    if (runtime) {
      await runtime.free();
    }
    (globalThis as { __XPP_WASM_ENTRY?: string }).__XPP_WASM_ENTRY = undefined;
    globalThis.fetch = nativeFetch;
  });

  it("case 1: loads simplefold model", async () => {
    const info = await runtime.loadModel(SIMPLEFOLD, "simplefold.ode");
    expect(info.variables.some((name) => name.toLowerCase() === "x")).toBe(true);
    expect(info.parameters.some((name) => name.toLowerCase() === "a")).toBe(true);
  });

  it("case 2: simplefold one-parameter continuation returns finite points", async () => {
    const result = await runtime.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "x",
      startStrategy: "steady_state",
      controls: { ...BASE_CONTROLS, rl0: -1, rl1: 2 },
      parameterOverrides: {}
    });
    const finite = result.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    expect(finite.length).toBeGreaterThan(2);
  });

  it("case 3: stable/unstable parity matches XPP ntot sign", async () => {
    const result = await runtime.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "x",
      startStrategy: "steady_state",
      controls: { ...BASE_CONTROLS, rl0: -1, rl1: 2 },
      parameterOverrides: {}
    });
    const withNtot = result.points.filter((point) => typeof point.ntot === "number");
    expect(withNtot.length).toBeGreaterThan(0);
    for (const point of withNtot) {
      expect(point.stable).toBe((point.ntot as number) < 0);
    }
  });

  it("case 4: labeled points are restricted to bifurcation-special types", async () => {
    const result = await runtime.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "x",
      startStrategy: "steady_state",
      controls: { ...BASE_CONTROLS, rl0: -1, rl1: 2 },
      parameterOverrides: {}
    });
    const nonSpecialLabeled = result.points.filter((point) => point.label > 0 && !isSpecialType(point.type));
    expect(nonSpecialLabeled.length).toBe(0);
  });

  it("case 5: periodic-branch F/I extraction follows XPP semantics (branch<0, finite period)", async () => {
    const points: BifurcationResult["points"] = [
      { index: 0, label: 0, type: "PT", branch: -1, stable: true, x: 0.1, y: -40, period: 40, parameters: { iapp: 0.1 } },
      { index: 1, label: 0, type: "PT", branch: -1, stable: true, x: 0.2, y: -35, period: 20, parameters: { iapp: 0.2 } },
      { index: 2, label: 0, type: "EP", branch: 1, stable: true, x: 0.3, y: -30, period: 10, parameters: { iapp: 0.3 } }
    ];
    const fi = fiFromPeriodic(points);
    expect(fi).toEqual([
      { x: 0.1, y: 1 / 40 },
      { x: 0.2, y: 1 / 20 }
    ]);
  });

  it("case 6: periodic-branch F/I extraction is non-flat when period varies", async () => {
    const points: BifurcationResult["points"] = [
      { index: 0, label: 0, type: "PT", branch: -1, stable: true, x: -0.1, y: -50, period: 100, parameters: { iapp: -0.1 } },
      { index: 1, label: 0, type: "PT", branch: -1, stable: true, x: 0.0, y: -45, period: 30, parameters: { iapp: 0.0 } },
      { index: 2, label: 0, type: "PT", branch: -1, stable: true, x: 0.2, y: -20, period: 10, parameters: { iapp: 0.2 } },
      { index: 3, label: 0, type: "PT", branch: 1, stable: true, x: 0.4, y: -10, period: 5, parameters: { iapp: 0.4 } }
    ];
    const fi = fiFromPeriodic(points);
    expect(fi.length).toBe(3);
    const min = Math.min(...fi.map((point) => point.y));
    const max = Math.max(...fi.map((point) => point.y));
    expect(max - min).toBeGreaterThan(1e-4);
  });

  it("case 7: simplefold has both stable and unstable equilibrium samples", async () => {
    await runtime.loadModel(SIMPLEFOLD, "simplefold.ode");
    const result = await runtime.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "x",
      startStrategy: "steady_state",
      controls: { ...BASE_CONTROLS, rl0: -1, rl1: 2 },
      parameterOverrides: {}
    });
    const eqPoints = result.points.filter((point) => point.branch > 0);
    expect(eqPoints.some((point) => point.stable === true)).toBe(true);
    expect(eqPoints.some((point) => point.stable === false)).toBe(true);
  });

  it("case 8: fallback F/I trend tracks WASM/XPPAUT on a planar benchmark model", async () => {
    const fallback = new FallbackXppEngine();
    await fallback.boot();
    await runtime.loadModel(LECAR, "lecar.ode");
    await fallback.loadModel(LECAR, "lecar.ode");

    const driveValues = [0.04, 0.08, 0.12, 0.16, 0.2];
    const wasmRates: number[] = [];
    const fallbackRates: number[] = [];
    for (const drive of driveValues) {
      const request = {
        integrator: "rk4" as const,
        t0: 0,
        tEnd: 120,
        dt: 0.05,
        transient: 40,
        outputStride: 1,
        parameterOverrides: { iapp: drive },
        initialConditions: {},
        requestedSeries: ["v"]
      };
      const simWasm = await runtime.runSimulation(request);
      const simFallback = await fallback.runSimulation(request);
      wasmRates.push(estimateFiringRateFromSimulation(simWasm, "v"));
      fallbackRates.push(estimateFiringRateFromSimulation(simFallback, "v"));
    }

    const rmse = Math.sqrt(
      wasmRates.reduce((sum, rate, idx) => {
        const diff = rate - (fallbackRates[idx] ?? 0);
        return sum + diff * diff;
      }, 0) / wasmRates.length
    );
    const norm = Math.max(0.05, Math.sqrt(wasmRates.reduce((sum, rate) => sum + rate * rate, 0) / wasmRates.length));
    const nrmse = rmse / norm;
    const corr = pearsonCorrelation(wasmRates, fallbackRates);
    const meanWasm = wasmRates.reduce((sum, rate) => sum + rate, 0) / wasmRates.length;
    const varWasm = wasmRates.reduce((sum, rate) => {
      const d = rate - meanWasm;
      return sum + d * d;
    }, 0) / wasmRates.length;
    if (varWasm > 1e-8) {
      expect(nrmse).toBeLessThanOrEqual(0.45);
      expect(corr).toBeGreaterThanOrEqual(0.6);
    } else {
      const maxWasmRate = Math.max(...wasmRates);
      expect(maxWasmRate).toBeLessThanOrEqual(1e-6);
      const maxFallbackRate = Math.max(...fallbackRates);
      expect(maxFallbackRate).toBeLessThanOrEqual(0.2);
      const maxAbsDiff = wasmRates.reduce((mx, rate, idx) => Math.max(mx, Math.abs(rate - (fallbackRates[idx] ?? 0))), 0);
      expect(maxAbsDiff).toBeLessThanOrEqual(0.2);
    }

    await fallback.free();
  });

  it("case 9: fallback F/I trend for Destexhe-Pare (gkm=0) tracks WASM directionality", async () => {
    const fallback = new FallbackXppEngine();
    await fallback.boot();
    await runtime.loadModel(DESTEXHE_PARE, "destexhe-pare.ode");
    await fallback.loadModel(DESTEXHE_PARE, "destexhe-pare.ode");

    const driveValues = [0, 1, 2, 3, 4];
    const wasmRates: number[] = [];
    const fallbackRates: number[] = [];
    for (const drive of driveValues) {
      const request = {
        integrator: "rk4" as const,
        t0: 0,
        tEnd: 900,
        dt: 0.05,
        transient: 300,
        outputStride: 4,
        parameterOverrides: { i: drive, gkm: 0 },
        initialConditions: {},
        requestedSeries: ["v"]
      };
      const simWasm = await runtime.runSimulation(request);
      const simFallback = await fallback.runSimulation(request);
      wasmRates.push(estimateFiringRateFromSimulation(simWasm, "v"));
      fallbackRates.push(estimateFiringRateFromSimulation(simFallback, "v"));
    }

    const nonZeroFallback = fallbackRates.filter((rate) => rate > 1e-5).length;
    expect(nonZeroFallback).toBeGreaterThanOrEqual(2);

    const meanWasm = wasmRates.reduce((sum, rate) => sum + rate, 0) / wasmRates.length;
    const varWasm = wasmRates.reduce((sum, rate) => {
      const d = rate - meanWasm;
      return sum + d * d;
    }, 0) / wasmRates.length;
    const corr = pearsonCorrelation(wasmRates, fallbackRates);
    if (varWasm > 1e-8) {
      expect(corr).toBeGreaterThanOrEqual(0.45);
    } else {
      const maxAbsDiff = wasmRates.reduce((mx, rate, idx) => Math.max(mx, Math.abs(rate - (fallbackRates[idx] ?? 0))), 0);
      expect(maxAbsDiff).toBeLessThanOrEqual(0.3);
    }
    await fallback.free();
  });
});
