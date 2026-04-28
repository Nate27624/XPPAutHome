import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FallbackXppEngine } from "./fallbackEngine";

const modelPath = (name: string): string => resolve(process.cwd(), "..", "benchmark", "models", name);
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

function estimateRate(time: number[], signal: number[]): number {
  const n = Math.min(time.length, signal.length);
  if (n < 5) {
    return 0;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const samples: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < n; i += 1) {
    const t = time[i] ?? Number.NaN;
    const v = signal[i] ?? Number.NaN;
    if (!Number.isFinite(t) || !Number.isFinite(v)) {
      continue;
    }
    samples.push({ t, v });
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  if (samples.length < 5 || !Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }
  const amplitude = max - min;
  if (amplitude < 1e-3) {
    return 0;
  }
  const threshold = min + amplitude * 0.5;
  const spikes: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (!prev || !curr) {
      continue;
    }
    if (prev.v < threshold && curr.v >= threshold && curr.v > prev.v) {
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

describe("FallbackXppEngine", () => {
  it("loads canonical models and returns metadata", async () => {
    const engine = new FallbackXppEngine();
    await engine.boot();

    const lecar = await readFile(modelPath("lecar.ode"), "utf8");
    await engine.loadModel(lecar, "lecar.ode");
    const info = await engine.getModelInfo();

    expect(info.variables.length).toBeGreaterThan(1);
    expect(info.parameters.length).toBeGreaterThan(1);
    expect(info.diagnostics).toBeDefined();
  });

  it("reports unsupported tier2 features with line-level diagnostics", async () => {
    const engine = new FallbackXppEngine();
    await engine.boot();

    const source = `\npar a=1\nmarkov m 2\nx'=a*x\ndone\n`;
    await engine.loadModel(source, "tier2.ode");
    const info = await engine.getModelInfo();

    const markovDiag = info.diagnostics.find((d) => d.code === "TIER2_FEATURE");
    expect(markovDiag).toBeTruthy();
    expect(markovDiag?.line).toBe(3);
  });

  it("simulates trajectories with finite outputs", async () => {
    const engine = new FallbackXppEngine();
    const fhn = await readFile(modelPath("fhn.ode"), "utf8");
    await engine.loadModel(fhn, "fhn.ode");

    const sim = await engine.runSimulation({
      integrator: "rk4",
      t0: 0,
      tEnd: 20,
      dt: 0.05,
      transient: 0,
      outputStride: 1,
      parameterOverrides: {},
      initialConditions: {},
      requestedSeries: []
    });

    expect(sim.time.length).toBeGreaterThan(5);
    for (const arr of Object.values(sim.series)) {
      expect(arr.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it("simulates the Destexhe-Pare model with gkm=0 without non-finite values", async () => {
    const engine = new FallbackXppEngine();
    await engine.loadModel(DESTEXHE_PARE, "destexhe-pare.ode");
    const sim = await engine.runSimulation({
      integrator: "rk4",
      t0: 0,
      tEnd: 700,
      dt: 0.05,
      transient: 100,
      outputStride: 4,
      parameterOverrides: { gkm: 0, i: 2.5 },
      initialConditions: {},
      requestedSeries: ["v", "m", "h", "n", "mk"]
    });

    expect(sim.time.length).toBeGreaterThan(100);
    expect(sim.time.every((v) => Number.isFinite(v))).toBe(true);
    for (const arr of Object.values(sim.series)) {
      expect(arr.length).toBe(sim.time.length);
      expect(arr.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it("produces a non-flat F/I sweep for Destexhe-Pare when gkm=0", async () => {
    const engine = new FallbackXppEngine();
    await engine.loadModel(DESTEXHE_PARE, "destexhe-pare.ode");

    const drives = [-1, 0, 1, 2, 4, 6];
    const rates: number[] = [];
    for (const drive of drives) {
      const sim = await engine.runSimulation({
        integrator: "rk4",
        t0: 0,
        tEnd: 900,
        dt: 0.05,
        transient: 300,
        outputStride: 4,
        parameterOverrides: { gkm: 0, i: drive },
        initialConditions: {},
        requestedSeries: ["v"]
      });
      rates.push(estimateRate(sim.time, sim.series.v ?? []));
    }

    const nonZero = rates.filter((r) => r > 1e-5);
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    expect(nonZero.length).toBeGreaterThanOrEqual(3);
    expect(max - min).toBeGreaterThan(0.002);
  });

  it("applies simulation step budget for very small dt requests", async () => {
    const engine = new FallbackXppEngine();
    await engine.boot();
    await engine.loadModel(`v'=-v\ninit v=1\ndone\n`, "budget.ode");

    const sim = await engine.runSimulation({
      integrator: "rk4",
      t0: 0,
      tEnd: 5000,
      dt: 1e-6,
      transient: 0,
      outputStride: 1,
      parameterOverrides: {},
      initialConditions: {},
      requestedSeries: ["v"]
    });

    expect(sim.time.length).toBeGreaterThan(1);
    expect(sim.time.every((v) => Number.isFinite(v))).toBe(true);
    expect((sim.series.v ?? []).every((v) => Number.isFinite(v))).toBe(true);
    expect(sim.diagnostics.some((d) => d.code === "SIM_STEP_BUDGET_APPLIED")).toBe(true);
  });

  it("produces phase-plane field and nullclines", async () => {
    const engine = new FallbackXppEngine();
    const lecar = await readFile(modelPath("lecar.ode"), "utf8");
    await engine.loadModel(lecar, "lecar.ode");

    const phase = await engine.runPhasePlane({
      xVar: "v",
      yVar: "w",
      fixedState: {},
      vectorField: {
        xMin: -0.7,
        xMax: 1,
        yMin: -0.2,
        yMax: 1,
        xSteps: 12,
        ySteps: 12
      },
      nullclineGrid: {
        xSteps: 40,
        ySteps: 40
      },
      trajectory: {
        enabled: true,
        tEnd: 50,
        dt: 0.05
      }
    });

    expect(phase.vectorField.length).toBe(144);
    expect(phase.nullclines.xNullcline.length + phase.nullclines.yNullcline.length).toBeGreaterThan(0);
  });

  it("includes per-point state values in one-parameter bifurcation output", async () => {
    const engine = new FallbackXppEngine();
    const source = `par a=0
v'=a-v
h'=v-h
init v=0,h=0
done
`;
    await engine.loadModel(source, "state-values.ode");

    const bif = await engine.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "v",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 80,
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

    expect(bif.points.length).toBeGreaterThan(2);
    const first = bif.points.find((point) => point.stateValues && Number.isFinite(point.stateValues.v) && Number.isFinite(point.stateValues.h));
    expect(first).toBeTruthy();
  });

  it("accepts case-insensitive variable names in phase-plane requests", async () => {
    const engine = new FallbackXppEngine();
    const lecar = await readFile(modelPath("lecar.ode"), "utf8");
    await engine.loadModel(lecar, "lecar.ode");

    const phase = await engine.runPhasePlane({
      xVar: "V",
      yVar: "W",
      fixedState: {},
      vectorField: {
        xMin: -0.7,
        xMax: 1,
        yMin: -0.2,
        yMax: 1,
        xSteps: 8,
        ySteps: 8
      },
      nullclineGrid: {
        xSteps: 30,
        ySteps: 30
      },
      trajectory: {
        enabled: false,
        tEnd: 50,
        dt: 0.05
      }
    });

    expect(phase.vectorField.length).toBeGreaterThan(0);
    expect(phase.diagnostics.some((d) => d.code === "PHASE_VARS_NOT_FOUND")).toBe(false);
  });

  it("clamps non-finite phase-plane derivatives and reports diagnostics", async () => {
    const engine = new FallbackXppEngine();
    await engine.boot();
    const source = `v'=w
w'=sqrt(-1)
init v=0,w=0
done
`;
    await engine.loadModel(source, "nan-phase.ode");

    const phase = await engine.runPhasePlane({
      xVar: "v",
      yVar: "w",
      fixedState: {},
      vectorField: {
        xMin: -1,
        xMax: 1,
        yMin: -1,
        yMax: 1,
        xSteps: 8,
        ySteps: 8
      },
      nullclineGrid: {
        xSteps: 16,
        ySteps: 16
      },
      trajectory: {
        enabled: false,
        tEnd: 10,
        dt: 0.05
      }
    });

    expect(phase.vectorField.length).toBeGreaterThan(0);
    expect(phase.vectorField.every((p) => Number.isFinite(p.dx) && Number.isFinite(p.dy))).toBe(true);
    expect(phase.diagnostics.some((d) => d.code === "PHASE_NONFINITE_DERIVATIVES")).toBe(true);
  });

  it("parses neurobook/XPP variants like dv/dt, v(0), and par ranges", async () => {
    const engine = new FallbackXppEngine();
    await engine.boot();

    const source = `# Morris-Lecar style syntax variants
dv/dt = ( I - gca*minf(V)*(V-Vca)-gk*w*(V-VK)-gl*(V-Vl))/c
dw/dt = phi*(winf(V)-w)/tauw(V)
v(0)=-16
w(0)=0.014915
minf(v)=.5*(1+tanh((v-v1)/v2))
winf(v)=.5*(1+tanh((v-v3)/v4))
tauw(v)=1/cosh((v-v3)/(2*v4))
param vk=-84,vl=-60,vca=120
param i=0,gk=8,gl=2,c=20
param v1=-1.2,v2=18
par1-3 v3=2,v4=30,phi=.04,gca=4.4
done
`;

    await engine.loadModel(source, "neurobook-ml.ode");
    const info = await engine.getModelInfo();
    expect(info.variables).toEqual(expect.arrayContaining(["v", "w"]));
    expect(info.diagnostics.some((d) => d.code === "NO_ODES")).toBe(false);

    const sim = await engine.runSimulation({
      integrator: "rk4",
      t0: 0,
      tEnd: 10,
      dt: 0.05,
      transient: 0,
      outputStride: 1,
      parameterOverrides: {},
      initialConditions: {},
      requestedSeries: []
    });
    expect(sim.time.length).toBeGreaterThan(1);
    expect(sim.series.v?.length ?? 0).toBeGreaterThan(1);
    expect(sim.series.w?.length ?? 0).toBeGreaterThan(1);
  });

  it("parses p and number declaration forms used in neurobook models", async () => {
    const engine = new FallbackXppEngine();
    await engine.boot();

    const source = `# constant declaration variants
p temp=23.5
number faraday=96485,rgas=8.3147,tabs0=273.15
v'=(faraday/(rgas*(tabs0+temp)))-v
init v=0
@ total=2,dt=.05
done
`;

    await engine.loadModel(source, "p-number-variants.ode");
    const info = await engine.getModelInfo();
    expect(info.parameters).toEqual(expect.arrayContaining(["temp", "faraday", "rgas", "tabs0"]));

    const sim = await engine.runSimulation({
      integrator: "rk4",
      t0: 0,
      tEnd: 2,
      dt: 0.05,
      transient: 0,
      outputStride: 1,
      parameterOverrides: {},
      initialConditions: {},
      requestedSeries: []
    });
    expect(sim.time.length).toBeGreaterThan(1);
    expect((sim.series.v ?? []).every((value) => Number.isFinite(value))).toBe(true);
  });

  it("parses the standard T-current model and exposes h as a state variable", async () => {
    const engine = new FallbackXppEngine();
    await engine.boot();

    const source = `# Standard T-Current Model (Restored)
par EL=-78
par gL=0.1, Cm=1, ECa=120, gT=0.5
minf(v) = 1/(1+exp(-(v+65)/7.8))
hinf(v) = 1/(1+exp((v+81)/11))
par tauh=30
dv/dt = (-gL*(v-EL) - gT*minf(v)^3*h*(v-ECa))/Cm
dh/dt = (hinf(v) - h)/tauh
init v=-65, h=0.2
@ total=800, xp=t, yp=v, xlo=0, xhi=800, ylo=-100, yhi=20, bound=1000
done
`;

    await engine.loadModel(source, "standard-t-current.ode");
    const info = await engine.getModelInfo();
    expect(info.variables.map((name) => name.toLowerCase())).toEqual(expect.arrayContaining(["v", "h"]));

    const bif = await engine.runBifurcation({
      mode: "one_param",
      primaryParameter: "EL",
      xVariable: "h",
      yVariable: "v",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 180,
        pointDensity: 1,
        npr: 30,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.5,
        rl0: -85,
        rl1: -60,
        a0: -1e6,
        a1: 1e6,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    const hasFiniteHState = bif.points.some((point) => {
      const h = point.stateValues?.h;
      return typeof h === "number" && Number.isFinite(h);
    });
    expect(hasFiniteHState).toBe(true);
  });

  it("resolves deferred parameter expressions such as !temp=273.15+celsius", async () => {
    const engine = new FallbackXppEngine();
    await engine.boot();

    const source = `# Neurobook-style forward reference in constants
!temp=273.15+celsius
par celsius=25,scale=1
v'=temp*scale-v
init v=0
@ total=2,dt=.05
done
`;

    await engine.loadModel(source, "temp-forward-ref.ode");
    const info = await engine.getModelInfo();
    expect(info.parameters).toEqual(expect.arrayContaining(["temp", "celsius", "scale"]));

    const sim = await engine.runSimulation({
      integrator: "rk4",
      t0: 0,
      tEnd: 2,
      dt: 0.05,
      transient: 0,
      outputStride: 1,
      parameterOverrides: {},
      initialConditions: {},
      requestedSeries: []
    });

    expect(sim.time.length).toBeGreaterThan(1);
    expect((sim.series.v ?? []).every((value) => Number.isFinite(value))).toBe(true);
  });

  it("produces one-parameter and two-parameter bifurcation outputs", async () => {
    const engine = new FallbackXppEngine();
    const simplefold = await readFile(modelPath("simplefold.ode"), "utf8");
    await engine.loadModel(simplefold, "simplefold.ode");

    const one = await engine.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "x",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 80,
        npr: 10,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.2,
        rl0: -2,
        rl1: 2,
        a0: -1,
        a1: 1,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    const two = await engine.runBifurcation({
      mode: "two_param",
      primaryParameter: "a",
      secondaryParameter: "b",
      yVariable: "x",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 80,
        npr: 10,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.2,
        rl0: -2,
        rl1: 2,
        a0: -2,
        a1: 2,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    expect(one.points.length).toBeGreaterThan(10);
    expect(two.points.length).toBeGreaterThan(1);
  });

  it("returns explicit diagnostics when continuation yields no branch points", async () => {
    const engine = new FallbackXppEngine();
    const source = `par a=0
x' = 1
init x=0
@ total=20,dt=.1
done
`;
    await engine.loadModel(source, "no-equilibria.ode");

    const out = await engine.runBifurcation({
      mode: "one_param",
      primaryParameter: "a",
      yVariable: "x",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 100,
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

    expect(out.points.length).toBe(0);
    expect(out.diagnostics.some((d) => d.code === "NO_BIF_POINTS")).toBe(true);
    expect(out.diagnostics.some((d) => d.code === "ONE_PARAM_SAMPLES_WITHOUT_EQ")).toBe(true);
  });

  it("keeps reduced Butera bifurcation points finite for plotting", async () => {
    const engine = new FallbackXppEngine();
    const source = `# Reduced Butera planar model: fast Na blocked, h fixed
par cm=21,i=0
xinf(v,vt,sig)=1/(1+exp((v-vt)/sig))
taux(v,vt,sig,tau)=tau/cosh((v-vt)/(2*sig))
il=gl*(v-el)
par gl=2.8,el=-65
ninf(v)=xinf(v,-29,-4)
taun(v)=taux(v,-29,-4,10)
ik=gk*n^4*(v-ek)
par gk=11.2,ek=-85
mninf(v)=xinf(v,-40,-6)
par gnap=2.8,ena=50,hfix=0.5
v'=(i-il-ik-inap)/cm
n'=(ninf(v)-n)/taun(v)
inap=gnap*mninf(v)*hfix*(v-ena)
init v=-60,n=0.1
@ total=2000,dt=.1
done
`;
    await engine.loadModel(source, "butera-reduced-h-fixed.ode");

    const bif = await engine.runBifurcation({
      mode: "one_param",
      primaryParameter: "hfix",
      yVariable: "v",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 180,
        npr: 30,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.5,
        rl0: -0.2,
        rl1: 0.5,
        a0: -0.4,
        a1: 0.4,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    expect(bif.points.length).toBeGreaterThan(10);
    expect(bif.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(bif.diagnostics.some((d) => d.code === "NO_FINITE_BIF_POINTS")).toBe(false);
  });

  it("labels HB points for a planar Hopf normal form", async () => {
    const engine = new FallbackXppEngine();
    const source = `par mu=-0.5
v'=mu*v-w-v*(v^2+w^2)
w'=v+mu*w-w*(v^2+w^2)
init v=0,w=0
@ total=500,dt=.05
done
`;
    await engine.loadModel(source, "hopf-normal-form.ode");

    const bif = await engine.runBifurcation({
      mode: "one_param",
      primaryParameter: "mu",
      yVariable: "v",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 180,
        pointDensity: 2,
        npr: 30,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.5,
        rl0: -1,
        rl1: 1,
        a0: -2,
        a1: 2,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    const hbPoints = bif.points.filter((p) => p.type === "HB");
    expect(hbPoints.length).toBeGreaterThan(0);
  });

  it("detects Hopf transitions in 3D systems using eigenvalue-based stability", async () => {
    const engine = new FallbackXppEngine();
    const source = `par mu=-0.5
v'=mu*v-w
w'=v+mu*w
z'=-z
init v=0,w=0,z=0
@ total=300,dt=.05
done
`;
    await engine.loadModel(source, "hopf-3d.ode");

    const bif = await engine.runBifurcation({
      mode: "one_param",
      primaryParameter: "mu",
      yVariable: "v",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 120,
        pointDensity: 2,
        npr: 20,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.5,
        rl0: -1,
        rl1: 1,
        a0: -2,
        a1: 2,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    const hbPoints = bif.points.filter((p) => p.type === "HB");
    expect(hbPoints.length).toBeGreaterThan(0);
    expect(bif.points.some((p) => p.stable === true)).toBe(true);
    expect(bif.points.some((p) => p.stable === false)).toBe(true);
    const hbNearZero = hbPoints.some((p) => Math.abs(p.x) < 0.1);
    expect(hbNearZero).toBe(true);
  });

  it("accepts case-insensitive yVariable in bifurcation requests", async () => {
    const engine = new FallbackXppEngine();
    const source = `par mu=-0.5
v'=mu*v-w-v*(v^2+w^2)
w'=v+mu*w-w*(v^2+w^2)
init v=0,w=0
@ total=500,dt=.05
done
`;
    await engine.loadModel(source, "hopf-normal-form.ode");

    const bif = await engine.runBifurcation({
      mode: "one_param",
      primaryParameter: "mu",
      yVariable: "V",
      startStrategy: "steady_state",
      controls: {
        ntst: 15,
        nmx: 120,
        pointDensity: 1,
        npr: 30,
        ncol: 4,
        ds: 0.02,
        dsMin: 0.001,
        dsMax: 0.5,
        rl0: -1,
        rl1: 1,
        a0: -2,
        a1: 2,
        epsl: 1e-4,
        epsu: 1e-4,
        epss: 1e-4
      }
    });

    expect(bif.points.length).toBeGreaterThan(0);
  });

  it("is stable over repeated runs", async () => {
    const engine = new FallbackXppEngine();
    const wc = await readFile(modelPath("wc.ode"), "utf8");
    await engine.loadModel(wc, "wc.ode");

    for (let i = 0; i < 100; i += 1) {
      const sim = await engine.runSimulation({
        integrator: "rk4",
        t0: 0,
        tEnd: 2,
        dt: 0.05,
        transient: 0,
        outputStride: 1,
        parameterOverrides: {},
        initialConditions: {},
        requestedSeries: []
      });
      expect(sim.time.length).toBeGreaterThan(1);
    }
  });
});
