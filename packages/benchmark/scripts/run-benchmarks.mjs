import { readFile } from "node:fs/promises";
import { XpwRuntimeClient } from "@xpp/wasm-core";

const runtime = new XpwRuntimeClient();
await runtime.boot();

const models = [
  { name: "lecar.ode", sim: { tEnd: 150, dt: 0.05 }, bif: { mode: "one_param", primaryParameter: "iapp", yVariable: "v" } },
  { name: "wc.ode", sim: { tEnd: 120, dt: 0.05 }, bif: { mode: "one_param", primaryParameter: "aee", yVariable: "u" } },
  { name: "fhn.ode", sim: { tEnd: 100, dt: 0.05 }, bif: { mode: "one_param", primaryParameter: "a", yVariable: "v" } },
  { name: "simplefold.ode", sim: { tEnd: 50, dt: 0.05 }, bif: { mode: "one_param", primaryParameter: "a", yVariable: "x" } }
];

for (const model of models) {
  const source = await readFile(new URL(`../models/${model.name}`, import.meta.url), "utf8");
  await runtime.loadModel(source, model.name);
  const info = await runtime.getModelInfo();
  const sim = await runtime.runSimulation({
    integrator: "rk4",
    t0: 0,
    tEnd: model.sim.tEnd,
    dt: model.sim.dt,
    transient: 0,
    outputStride: 1,
    parameterOverrides: {},
    initialConditions: {},
    requestedSeries: []
  });

  const bif = await runtime.runBifurcation({
    mode: model.bif.mode,
    primaryParameter: model.bif.primaryParameter,
    yVariable: model.bif.yVariable,
    startStrategy: "steady_state",
    controls: {
      ntst: 15,
      nmx: 120,
      npr: 20,
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

  console.log(`${model.name}: vars=${info.variables.length} simPoints=${sim.time.length} bifPoints=${bif.points.length}`);
}

await runtime.free();
