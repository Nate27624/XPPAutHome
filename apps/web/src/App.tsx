import {
  type BifurcationRequest,
  type BifurcationResult,
  type Diagnostic,
  type ModelInfo,
  type PhasePlaneRequest,
  type PhasePlaneResult,
  type SimulationRequest,
  type SimulationResult
} from "@xpp/core-api";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  bifurcationCsv,
  downloadBlob,
  exportProjectBundle,
  phasePlaneCsv,
  simulationCsv,
  toCsv
} from "./exporters";
import { COMMON_MODELS, type CommonModelTemplate } from "./commonModels";
import { extractStateVariablesFromOde } from "./odeVariables";
import { loadLatestProject, saveLatestProject } from "./storage";
import { WorkerClient } from "./workerClient";

type TabId = "model" | "phase" | "bifurcation";
const X_AXIS_VARIABLE_PREFIX = "__xvar__:";

const DEFAULT_ODE = `# Morris-Lecar example
params iapp=0.08,phi=.333
param v1=-.01,v2=.15,v3=.1,v4=.145,gca=1
params vk=-.7,vl=-.5,gk=2.0,gl=.5
minf(v)=.5*(1+tanh((v-v1)/v2))
ninf(v)=.5*(1+tanh((v-v3)/v4))
lamn(v)=phi*cosh((v-v3)/(2*v4))
ica=gca*minf(v)*(v-1)
v'=(iapp+gl*(vl-v)+gk*w*(vk-v)-ica)
w'=(lamn(v)*(ninf(v)-w))
init v=-0.3,w=0.01
@ total=200,dt=.05
set baseline {iapp=.08}
done
`;

const DEFAULT_SIM_REQUEST: SimulationRequest = {
  integrator: "rk4",
  t0: 0,
  tEnd: 200,
  dt: 0.05,
  transient: 0,
  outputStride: 1,
  parameterOverrides: {},
  initialConditions: {},
  requestedSeries: []
};

const DEFAULT_PHASE_REQUEST: PhasePlaneRequest = {
  xVar: "v",
  yVar: "w",
  parameterOverrides: {},
  fixedState: {},
  vectorField: {
    xMin: -0.75,
    xMax: 1.2,
    yMin: -0.2,
    yMax: 1.0,
    xSteps: 26,
    ySteps: 26
  },
  nullclineGrid: {
    xSteps: 80,
    ySteps: 80
  },
  trajectory: {
    enabled: false,
    tEnd: 200,
    dt: 0.05
  }
};

const DEFAULT_BIF_REQUEST: BifurcationRequest = {
  mode: "one_param",
  primaryParameter: "iapp",
  xVariable: "v",
  yVariable: "v",
  parameterOverrides: {},
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
    rl0: -0.2,
    rl1: 0.5,
    a0: -1e6,
    a1: 1e6,
    epsl: 1e-4,
    epsu: 1e-4,
    epss: 1e-4
  }
};

const BUILTIN_BUTERA_REDUCED: CommonModelTemplate = {
  id: "butera-reduced-h-fixed",
  label: "Butera Reduced (h fixed)",
  fileName: "butera-reduced-h-fixed.ode",
  source: `# Reduced Butera planar model: fast Na blocked, h fixed
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
inap=gnap*mninf(v)*hfix*(v-ena)
v'=(i-il-ik-inap)/cm
n'=(ninf(v)-n)/taun(v)
init v=-60,n=0.1
@ total=2000,dt=.1
done
`,
  originUrl: "builtin://butera-reduced-h-fixed"
};
const COMMON_MODEL_OPTIONS: CommonModelTemplate[] = [
  BUILTIN_BUTERA_REDUCED,
  ...COMMON_MODELS
];
const DEFAULT_COMMON_MODEL_ID = BUILTIN_BUTERA_REDUCED.id;

type AxisBounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

type PhaseTrajectory = NonNullable<PhasePlaneResult["trajectory"]>;
type FiPoint = {
  x: number;
  y: number;
};

type NumericInputProps = {
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
};

const DEFAULT_BIF_AXIS_MANUAL: AxisBounds = {
  xMin: 0,
  xMax: 1,
  yMin: -80,
  yMax: 20
};

const SPECIAL_BIF_TYPE_PREFIXES = ["HB", "LP", "BP", "PD", "TR", "BIF"] as const;
const SPECIAL_BIF_TYPE_EXACT = new Set(["BT", "CP", "GH", "ZH", "NS"]);

function normalizeBifType(type: string): string {
  return type.trim().toUpperCase();
}

function isSpecialBifType(type: string): boolean {
  const normalized = normalizeBifType(type);
  if (!normalized) {
    return false;
  }
  if (SPECIAL_BIF_TYPE_EXACT.has(normalized)) {
    return true;
  }
  return SPECIAL_BIF_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isInspectableBifPoint(point: { label: number; type: string }): boolean {
  return point.label > 0 && isSpecialBifType(point.type);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function scaleSeries(values: number[]): { min: number; max: number } {
  if (values.length === 0) {
    return { min: -1, max: 1 };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  if (Math.abs(max - min) < 1e-9) {
    return { min: min - 1, max: max + 1 };
  }
  return { min, max };
}

function paddedRange(min: number, max: number, fraction = 0.05): { min: number; max: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: -1, max: 1 };
  }
  if (Math.abs(max - min) < 1e-9) {
    return { min: min - 1, max: max + 1 };
  }
  const pad = Math.max(1e-6, Math.abs(max - min) * fraction);
  return { min: min - pad, max: max + pad };
}

function fittedBifAxisBounds(data: BifurcationResult | null): AxisBounds | null {
  if (!data) {
    return null;
  }
  const points = data.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length === 0) {
    return null;
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xRange = scaleSeries(xs);
  const yRange = scaleSeries(ys);
  const x = paddedRange(xRange.min, xRange.max, 0.05);
  const y = paddedRange(yRange.min, yRange.max, 0.08);
  return { xMin: x.min, xMax: x.max, yMin: y.min, yMax: y.max };
}

function normalizeAxisBounds(bounds: AxisBounds): AxisBounds {
  let xMin = Number.isFinite(bounds.xMin) ? bounds.xMin : DEFAULT_BIF_AXIS_MANUAL.xMin;
  let xMax = Number.isFinite(bounds.xMax) ? bounds.xMax : DEFAULT_BIF_AXIS_MANUAL.xMax;
  let yMin = Number.isFinite(bounds.yMin) ? bounds.yMin : DEFAULT_BIF_AXIS_MANUAL.yMin;
  let yMax = Number.isFinite(bounds.yMax) ? bounds.yMax : DEFAULT_BIF_AXIS_MANUAL.yMax;

  if (xMax < xMin) {
    [xMin, xMax] = [xMax, xMin];
  }
  if (yMax < yMin) {
    [yMin, yMax] = [yMax, yMin];
  }
  if (Math.abs(xMax - xMin) < 1e-9) {
    xMax = xMin + 1;
  }
  if (Math.abs(yMax - yMin) < 1e-9) {
    yMax = yMin + 1;
  }

  return { xMin, xMax, yMin, yMax };
}

function includesIgnoreCase(values: string[], target: string): boolean {
  const t = target.trim().toLowerCase();
  return values.some((value) => value.toLowerCase() === t);
}

function canonicalVariableName(values: string[], target: string): string | null {
  const t = target.trim().toLowerCase();
  return values.find((value) => value.toLowerCase() === t) ?? null;
}

function notSameCaseInsensitive(a: string, b: string): boolean {
  return a.trim().toLowerCase() !== b.trim().toLowerCase();
}

function stateValueCaseInsensitive(point: { stateValues?: Record<string, number> }, variable: string): number | null {
  if (!variable) {
    return null;
  }
  const stateValues = point.stateValues;
  if (!stateValues) {
    return null;
  }
  const target = variable.trim().toLowerCase();
  for (const [name, value] of Object.entries(stateValues)) {
    if (name.toLowerCase() === target && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function getParameterValueForContinuation(
  info: ModelInfo,
  primaryParameter: string,
  parameterOverrides: Record<string, number>
): number | null {
  const canonical = canonicalVariableName(info.parameters, primaryParameter) ?? primaryParameter;
  const target = canonical.toLowerCase();
  for (const [key, value] of Object.entries(parameterOverrides)) {
    if (key.toLowerCase() === target && Number.isFinite(value)) {
      return value;
    }
  }
  const modelValue = info.parameterValues[canonical];
  return typeof modelValue === "number" && Number.isFinite(modelValue) ? modelValue : null;
}

function normalizeContinuationRange(
  controls: BifurcationRequest["controls"],
  primaryValue: number | null
): Pick<BifurcationRequest["controls"], "rl0" | "rl1"> {
  let rl0 = controls.rl0;
  let rl1 = controls.rl1;
  if (!Number.isFinite(rl0) || !Number.isFinite(rl1) || rl1 <= rl0) {
    rl0 = 0;
    rl1 = 1;
  }
  if (typeof primaryValue === "number" && Number.isFinite(primaryValue)) {
    let width = Math.abs(rl1 - rl0);
    width = Math.max(width, 0.25, Math.max(1, Math.abs(primaryValue) * 0.4));
    rl0 = primaryValue - width / 2;
    rl1 = primaryValue + width / 2;
  }
  return { rl0, rl1 };
}

function findSeriesCaseInsensitive(series: Record<string, number[]>, requestedName: string): number[] {
  const exact = series[requestedName];
  if (Array.isArray(exact)) {
    return exact;
  }
  const target = requestedName.trim().toLowerCase();
  if (!target) {
    return [];
  }
  for (const [key, values] of Object.entries(series)) {
    if (key.toLowerCase() === target && Array.isArray(values)) {
      return values;
    }
  }
  return [];
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function lastFiniteValue(values: number[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function pickBestFiringRate(
  time: number[],
  series: Record<string, number[]>,
  candidates: string[]
): { rate: number; signal: string } {
  let bestAnyRate = Number.NEGATIVE_INFINITY;
  let bestAnySignal = candidates[0] ?? "";
  let bestVoltageRate = Number.NEGATIVE_INFINITY;
  let bestVoltageSignal = candidates[0] ?? "";
  for (const candidate of candidates) {
    const values = findSeriesCaseInsensitive(series, candidate);
    const rate = estimateFiringRate(time, values);
    if (!Number.isFinite(rate)) {
      continue;
    }
    if (rate > bestAnyRate) {
      bestAnyRate = rate;
      bestAnySignal = candidate;
    }
    if (isVoltageLikeVariableName(candidate) && rate > bestVoltageRate) {
      bestVoltageRate = rate;
      bestVoltageSignal = candidate;
    }
  }
  if (Number.isFinite(bestVoltageRate)) {
    return { rate: bestVoltageRate, signal: bestVoltageSignal };
  }
  if (!Number.isFinite(bestAnyRate)) {
    return { rate: 0, signal: bestAnySignal };
  }
  return { rate: bestAnyRate, signal: bestAnySignal };
}

function fiFromPeriodicBifurcation(
  data: BifurcationResult | null,
  primaryParameter: string
): FiPoint[] {
  if (!data || data.points.length === 0) {
    return [];
  }
  const periodic = data.points.filter((point) =>
    point.branch < 0 &&
    typeof point.period === "number" &&
    Number.isFinite(point.period) &&
    point.period > 0 &&
    Number.isFinite(point.x)
  );
  if (periodic.length === 0) {
    return [];
  }
  const stablePeriodic = periodic.filter((point) => point.stable !== false);
  const source = stablePeriodic.length >= 4 ? stablePeriodic : periodic;
  const merged = new Map<string, FiPoint>();
  for (const point of source) {
    const px = typeof point.parameters?.[primaryParameter] === "number" && Number.isFinite(point.parameters[primaryParameter]!)
      ? point.parameters[primaryParameter]!
      : point.x;
    const rate = 1 / point.period!;
    if (!Number.isFinite(px) || !Number.isFinite(rate)) {
      continue;
    }
    const key = px.toFixed(8);
    const existing = merged.get(key);
    if (!existing || rate > existing.y) {
      merged.set(key, { x: px, y: rate });
    }
  }
  return [...merged.values()].sort((a, b) => a.x - b.x);
}

function fiCurveSpread(points: FiPoint[]): { xSpan: number; ySpan: number } {
  if (points.length === 0) {
    return { xSpan: 0, ySpan: 0 };
  }
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (Number.isFinite(point.x)) {
      xMin = Math.min(xMin, point.x);
      xMax = Math.max(xMax, point.x);
    }
    if (Number.isFinite(point.y)) {
      yMin = Math.min(yMin, point.y);
      yMax = Math.max(yMax, point.y);
    }
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { xSpan: 0, ySpan: 0 };
  }
  return { xSpan: Math.abs(xMax - xMin), ySpan: Math.abs(yMax - yMin) };
}

function isCurrentLikeParameter(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "i" || normalized === "iapp" || normalized === "ibias" || normalized === "idc" || normalized === "iinj") {
    return true;
  }
  return normalized.includes("current") || normalized.includes("inj");
}

function isVoltageLikeVariableName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "v" || normalized === "vm" || normalized === "u" || normalized.includes("volt");
}

function finiteBifPointCount(result: BifurcationResult): number {
  return result.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).length;
}

function shouldRetrySparseOneParam(result: BifurcationResult): boolean {
  const finiteCount = finiteBifPointCount(result);
  if (finiteCount > 2) {
    return false;
  }
  const hasSparseDiagnostic = result.diagnostics.some((diag) => diag.code === "SPARSE_BIFURCATION_OUTPUT");
  const hasNoFiniteDiagnostic = result.diagnostics.some((diag) => diag.code === "NO_FINITE_BIFURCATION_POINTS");
  return hasSparseDiagnostic || (!hasNoFiniteDiagnostic && finiteCount > 0);
}

function buildSparseRecoveryControls(
  controls: BifurcationRequest["controls"],
  primaryParameter: string,
  primaryValue: number | null
): BifurcationRequest["controls"] {
  let rl0 = controls.rl0;
  let rl1 = controls.rl1;
  if (!Number.isFinite(rl0) || !Number.isFinite(rl1) || rl1 <= rl0) {
    rl0 = 0;
    rl1 = 1;
  }
  const currentLike = isCurrentLikeParameter(primaryParameter);
  const minWidth = currentLike ? 6 : 2;
  const width = Math.max(minWidth, (rl1 - rl0) * 1.75);
  const center = typeof primaryValue === "number" && Number.isFinite(primaryValue)
    ? primaryValue
    : (rl0 + rl1) / 2;
  const dsBase = Number.isFinite(controls.ds) ? controls.ds : 0.02;
  const dsSign = dsBase < 0 ? -1 : 1;
  const dsMagnitude = Math.min(0.01, Math.max(0.001, Math.abs(dsBase) * 0.5));
  const ds = dsSign * dsMagnitude;
  const dsMin = Math.max(1e-5, Math.min(Math.abs(ds) * 0.5, controls.dsMin));
  const dsMax = Math.max(Math.abs(ds) * 1.5, controls.dsMax);
  return {
    ...controls,
    rl0: center - width / 2,
    rl1: center + width / 2,
    nmx: Math.max(controls.nmx, 450),
    pointDensity: Math.max(controls.pointDensity ?? 1, 2),
    ds,
    dsMin,
    dsMax
  };
}

function estimateFiringRate(time: number[], signal: number[]): number {
  const n = Math.min(time.length, signal.length);
  if (n < 5) {
    return 0;
  }

  const samples: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < n; i += 1) {
    const t = time[i] ?? Number.NaN;
    const v = signal[i] ?? Number.NaN;
    if (!Number.isFinite(t) || !Number.isFinite(v)) {
      continue;
    }
    samples.push({ t, v });
  }
  if (samples.length < 5) {
    return 0;
  }

  const firstTime = samples[0]?.t ?? 0;
  const lastTime = samples[samples.length - 1]?.t ?? firstTime;
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime <= firstTime) {
    return 0;
  }
  const analysisStart = firstTime + (lastTime - firstTime) * 0.35;
  const analysisSamples = samples.filter((sample) => sample.t >= analysisStart);
  const active = analysisSamples.length >= 5 ? analysisSamples : samples;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of active) {
    min = Math.min(min, sample.v);
    max = Math.max(max, sample.v);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }

  const amplitude = max - min;
  if (amplitude < 1e-4) {
    return 0;
  }

  const threshold = min + amplitude * 0.5;
  const intervals: number[] = [];
  for (let i = 1; i < active.length; i += 1) {
    const dt = active[i]!.t - active[i - 1]!.t;
    if (Number.isFinite(dt) && dt > 0) {
      intervals.push(dt);
    }
  }
  intervals.sort((a, b) => a - b);
  const medianDt = intervals.length > 0
    ? intervals[Math.floor(intervals.length / 2)] ?? intervals[0] ?? 1e-3
    : 1e-3;
  const minIsi = Math.max(2 * medianDt, (lastTime - firstTime) / 500, 1e-6);
  const spikes: number[] = [];

  for (let i = 1; i < active.length; i += 1) {
    const prev = active[i - 1];
    const curr = active[i];
    if (!prev || !curr) {
      continue;
    }
    if (!(prev.v < threshold && curr.v >= threshold && curr.v > prev.v)) {
      continue;
    }
    const dv = curr.v - prev.v;
    const alpha = Math.abs(dv) < 1e-12 ? 0 : clamp((threshold - prev.v) / dv, 0, 1);
    const t = prev.t + alpha * (curr.t - prev.t);
    const lastSpike = spikes[spikes.length - 1];
    if (typeof lastSpike === "number" && t - lastSpike < minIsi) {
      continue;
    }
    spikes.push(t);
  }

  if (spikes.length >= 2) {
    const duration = (spikes[spikes.length - 1] ?? 0) - (spikes[0] ?? 0);
    if (Number.isFinite(duration) && duration > 0) {
      return (spikes.length - 1) / duration;
    }
  }

  const peaks: number[] = [];
  for (let i = 1; i < active.length - 1; i += 1) {
    const prev = active[i - 1];
    const curr = active[i];
    const next = active[i + 1];
    if (!prev || !curr || !next) {
      continue;
    }
    if (curr.v < threshold || curr.v < prev.v || curr.v <= next.v) {
      continue;
    }
    const lastPeak = peaks[peaks.length - 1];
    if (typeof lastPeak === "number" && curr.t - lastPeak < minIsi) {
      continue;
    }
    peaks.push(curr.t);
  }
  if (peaks.length < 2) {
    return 0;
  }
  const peakDuration = (peaks[peaks.length - 1] ?? 0) - (peaks[0] ?? 0);
  if (!Number.isFinite(peakDuration) || peakDuration <= 0) {
    return 0;
  }
  return (peaks.length - 1) / peakDuration;
}

function resolvePhaseVars(
  variables: string[],
  xVar: string,
  yVar: string
): { xVar: string; yVar: string; error?: string } {
  if (variables.length === 0) {
    return {
      xVar,
      yVar,
      error: "Phase-plane requires at least two state variables, but this model has none."
    };
  }
  if (variables.length === 1) {
    const only = variables[0] ?? xVar;
    return {
      xVar: only,
      yVar: only,
      error: "Phase-plane requires at least two state variables, but this model has only one."
    };
  }
  const canonicalX = canonicalVariableName(variables, xVar) ?? variables[0] ?? xVar;
  const fallbackY = (variables.find((value) => value !== canonicalX) ?? variables[1] ?? variables[0] ?? yVar);
  const canonicalY = canonicalVariableName(variables, yVar) ?? fallbackY;
  if (canonicalX === canonicalY) {
    const alternate = variables.find((value) => value !== canonicalX);
    if (alternate) {
      return { xVar: canonicalX, yVar: alternate };
    }
  }
  return { xVar: canonicalX, yVar: canonicalY };
}

const INTERMEDIATE_NUMERIC_INPUTS = new Set(["", "-", "+", ".", "-.", "+."]);

function NumericInput({ value, onCommit, disabled }: NumericInputProps): JSX.Element {
  const [draft, setDraft] = useState(() => (Number.isFinite(value) ? String(value) : ""));

  useEffect(() => {
    setDraft(Number.isFinite(value) ? String(value) : "");
  }, [value]);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (INTERMEDIATE_NUMERIC_INPUTS.has(trimmed)) {
      setDraft(Number.isFinite(value) ? String(value) : "");
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(Number.isFinite(value) ? String(value) : "");
      return;
    }
    onCommit(parsed);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(Number.isFinite(value) ? String(value) : "");
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SimulationPlot({ data, svgId }: { data: SimulationResult | null; svgId?: string }): JSX.Element {
  if (!data) {
    return <div className="panelEmpty">Run a simulation to visualize trajectories.</div>;
  }

  const firstSeriesName = Object.keys(data.series)[0] ?? "";
  const ySeries = firstSeriesName ? data.series[firstSeriesName] ?? [] : [];

  if (data.time.length === 0 || ySeries.length === 0) {
    return <div className="panelEmpty">Simulation returned empty output.</div>;
  }

  const width = 760;
  const height = 320;
  const margin = 26;
  const x0 = data.time[0] ?? 0;
  const x1 = data.time[data.time.length - 1] ?? 1;
  const { min: y0, max: y1 } = scaleSeries(ySeries);

  const sx = (x: number): number => margin + ((x - x0) / Math.max(1e-12, x1 - x0)) * (width - 2 * margin);
  const sy = (y: number): number => height - margin - ((y - y0) / Math.max(1e-12, y1 - y0)) * (height - 2 * margin);

  const path = data.time
    .map((t, i) => `${i === 0 ? "M" : "L"}${sx(t)} ${sy(ySeries[i] ?? 0)}`)
    .join(" ");

  return (
    <svg id={svgId} viewBox={`0 0 ${width} ${height}`} className="plotSvg" role="img" aria-label="Simulation plot">
      <rect x={0} y={0} width={width} height={height} fill="rgba(248,248,242,0.92)" rx={10} />
      <line x1={margin} y1={height - margin} x2={width - margin} y2={height - margin} stroke="#1f2430" strokeWidth={1.5} />
      <line x1={margin} y1={margin} x2={margin} y2={height - margin} stroke="#1f2430" strokeWidth={1.5} />
      <path d={path} stroke="#cb4f1d" strokeWidth={2} fill="none" />
      <text x={width - 10} y={height - 6} textAnchor="end" className="plotLabel">
        t
      </text>
      <text x={8} y={14} className="plotLabel">
        {firstSeriesName}
      </text>
    </svg>
  );
}

function PhasePlot({
  data,
  svgId,
  xLabel,
  yLabel,
  extraTrajectories,
  onAddTrajectorySeed
}: {
  data: PhasePlaneResult | null;
  svgId?: string;
  xLabel: string;
  yLabel: string;
  extraTrajectories?: PhaseTrajectory[];
  onAddTrajectorySeed?: (x: number, y: number) => void;
}): JSX.Element {
  if (!data) {
    return <div className="panelEmpty">Run phase-plane analysis to render vector field and nullclines.</div>;
  }
  const width = 760;
  const height = 340;
  const margin = 30;

  const xs = data.vectorField.map((p) => p.x);
  const ys = data.vectorField.map((p) => p.y);
  const { min: x0, max: x1 } = scaleSeries(xs);
  const { min: y0, max: y1 } = scaleSeries(ys);

  const sx = (x: number): number => margin + ((x - x0) / Math.max(1e-12, x1 - x0)) * (width - 2 * margin);
  const sy = (y: number): number => height - margin - ((y - y0) / Math.max(1e-12, y1 - y0)) * (height - 2 * margin);
  const overlays = extraTrajectories ?? [];

  const handlePlotClick = (event: ReactMouseEvent<SVGSVGElement>): void => {
    if (!onAddTrajectorySeed) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const py = ((event.clientY - rect.top) / rect.height) * height;
    const clampedPx = clamp(px, margin, width - margin);
    const clampedPy = clamp(py, margin, height - margin);
    const x = x0 + ((clampedPx - margin) / Math.max(1e-12, width - 2 * margin)) * (x1 - x0);
    const y = y0 + ((height - margin - clampedPy) / Math.max(1e-12, height - 2 * margin)) * (y1 - y0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    onAddTrajectorySeed(x, y);
  };

  return (
    <svg
      id={svgId}
      viewBox={`0 0 ${width} ${height}`}
      className="plotSvg"
      role="img"
      aria-label="Phase-plane plot"
      onClick={handlePlotClick}
      style={onAddTrajectorySeed ? { cursor: "crosshair" } : undefined}
    >
      <rect x={0} y={0} width={width} height={height} fill="rgba(251,245,236,0.95)" rx={10} />
      <line x1={margin} y1={height - margin} x2={width - margin} y2={height - margin} stroke="#1f2430" strokeWidth={1.2} />
      <line x1={margin} y1={margin} x2={margin} y2={height - margin} stroke="#1f2430" strokeWidth={1.2} />

      {data.vectorField.map((v, idx) => {
        const len = Math.max(1e-9, Math.hypot(v.dx, v.dy));
        const norm = 11;
        const dx = (v.dx / len) * norm;
        const dy = (v.dy / len) * norm;
        const x = sx(v.x);
        const y = sy(v.y);
        return <line key={`vf-${idx}`} x1={x} y1={y} x2={x + dx} y2={y - dy} stroke="#1f2430" strokeWidth={0.8} opacity={0.38} />;
      })}

      {data.nullclines.xNullcline.map((line, idx) => (
        <polyline
          key={`xn-${idx}`}
          fill="none"
          stroke="#0c8f5d"
          strokeWidth={1.5}
          points={line.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")}
        />
      ))}

      {data.nullclines.yNullcline.map((line, idx) => (
        <polyline
          key={`yn-${idx}`}
          fill="none"
          stroke="#a12b12"
          strokeWidth={1.5}
          points={line.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ")}
        />
      ))}

      {overlays.map((trajectory, idx) => (
        <polyline
          key={`extra-traj-${idx}`}
          fill="none"
          stroke="#0b2f73"
          strokeWidth={2}
          opacity={0.72}
          points={trajectory.x.map((x, i) => `${sx(x)},${sy(trajectory.y[i] ?? 0)}`).join(" ")}
        />
      ))}

      <text x={width - 10} y={height - 8} textAnchor="end" className="plotLabel">
        {xLabel.trim() || "x"}
      </text>
      <text x={12} y={14} className="plotLabel">
        {yLabel.trim() || "y"}
      </text>
    </svg>
  );
}

function BifurcationPlot({
  data,
  request,
  modelInfo,
  axisBounds,
  axisMode,
  xAxisSource,
  selectedLabel,
  fiPoints,
  showFiCurve,
  onSelect,
  svgId
}: {
  data: BifurcationResult | null;
  request: BifurcationRequest;
  modelInfo: ModelInfo | null;
  axisBounds: AxisBounds | null;
  axisMode: "auto" | "manual";
  xAxisSource: "primary_parameter" | "state_variable";
  selectedLabel: number | null;
  fiPoints: FiPoint[];
  showFiCurve: boolean;
  onSelect: (label: number | null) => void;
  svgId?: string;
}): JSX.Element {
  if (!data) {
    return <div className="panelEmpty">Run bifurcation analysis to render branches.</div>;
  }

  const width = 760;
  const height = 340;
  const margin = 30;
  const xVariable = request.xVariable?.trim() || request.yVariable?.trim() || modelInfo?.variables[0] || "";
  const projectedPoints = data.points.map((point) => {
    const plotX = xAxisSource === "state_variable"
      ? stateValueCaseInsensitive(point, xVariable)
      : point.x;
    return {
      point,
      plotX: typeof plotX === "number" ? plotX : Number.NaN,
      plotY: point.y
    };
  });
  const plottedPointsForView = projectedPoints.filter((entry) => Number.isFinite(entry.plotX) && Number.isFinite(entry.plotY));
  if (plottedPointsForView.length === 0) {
    const diagnostics = data.diagnostics.slice(-8);
    const tips: string[] = [];
    const hasPrimary = modelInfo ? includesIgnoreCase(modelInfo.parameters, request.primaryParameter) : true;
    if (!hasPrimary) {
      tips.push(`Primary parameter '${request.primaryParameter}' was not found in this model. Pick one from Model details.`);
    }
    if (request.mode === "two_param") {
      const hasSecondary = request.secondaryParameter ? (modelInfo ? includesIgnoreCase(modelInfo.parameters, request.secondaryParameter) : true) : false;
      if (!hasSecondary) {
        tips.push(`Secondary parameter '${request.secondaryParameter ?? ""}' was not found in this model.`);
      }
      tips.push("Run one-parameter continuation first to verify a finite branch before switching to two-parameter mode.");
    }
    const hasYVar = request.yVariable ? (modelInfo ? modelInfo.variables.includes(request.yVariable) : true) : true;
    if (!hasYVar) {
      tips.push(`y variable '${request.yVariable ?? ""}' is not a model state variable.`);
    }
    if (xAxisSource === "state_variable") {
      const hasXVar = xVariable ? (modelInfo ? includesIgnoreCase(modelInfo.variables, xVariable) : true) : false;
      if (!hasXVar) {
        tips.push(`x variable '${xVariable || "(unset)"}' is not a model state variable.`);
      }
      const hasStateValues = projectedPoints.some((entry) => Number.isFinite(entry.plotX));
      if (!hasStateValues) {
        tips.push("No finite x-variable state values were returned by continuation points; run one-parameter continuation first and ensure xVariable is a state variable.");
      }
    }
    if (Math.abs(request.controls.rl1 - request.controls.rl0) < 1e-12) {
      tips.push("Primary parameter range is zero-width. Set different RL0 and RL1 values.");
    }
    tips.push(`Try a nearby parameter window first, e.g. RL0=${request.controls.rl0}, RL1=${request.controls.rl1}.`);
    tips.push("If this happens after a code update, hard refresh the page (Cmd+Shift+R) to reload the worker.");

    return (
      <div className="panelEmpty panelEmptyDetailed">
        <p><strong>Bifurcation output did not contain finite points to render.</strong></p>
        <p>Run config: mode={request.mode}, primary={request.primaryParameter}, xMode={xAxisSource}, xVar={xVariable || "auto"}, y={request.yVariable ?? "auto"}.</p>
        <p>Continuation window: RL=[{request.controls.rl0}, {request.controls.rl1}].</p>
        {diagnostics.length > 0 ? (
          <>
            <p>Diagnostics:</p>
            <ul className="diagnosticListCompact">
              {diagnostics.map((d: Diagnostic, idx) => (
                <li key={`bif-diag-${idx}`}>
                  [{d.tier}] {d.code}: {d.message}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p>Try this:</p>
        <ul className="diagnosticListCompact">
          {tips.map((tip, idx) => (
            <li key={`bif-tip-${idx}`}>{tip}</li>
          ))}
        </ul>
      </div>
    );
  }
  const xs = plottedPointsForView.map((p) => p.plotX);
  const ys = plottedPointsForView.map((p) => p.plotY);
  const showFiOnPlot = showFiCurve && xAxisSource === "primary_parameter";
  const finiteFiPoints = showFiOnPlot
    ? fiPoints.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    : [];
  const xScaleValues = axisMode === "auto" ? [...xs, ...finiteFiPoints.map((point) => point.x)] : xs;
  const yScaleValues = ys;
  const xDataRange = scaleSeries(xScaleValues.length > 0 ? xScaleValues : xs);
  const yDataRange = scaleSeries(yScaleValues.length > 0 ? yScaleValues : ys);
  const useManualBounds = axisMode === "manual" && axisBounds !== null;
  const x0 = useManualBounds && axisBounds && Number.isFinite(axisBounds.xMin) ? axisBounds.xMin : xDataRange.min;
  const x1 = useManualBounds && axisBounds && Number.isFinite(axisBounds.xMax) && axisBounds.xMax > x0 ? axisBounds.xMax : xDataRange.max;
  const y0 = useManualBounds && axisBounds && Number.isFinite(axisBounds.yMin) ? axisBounds.yMin : yDataRange.min;
  const y1 = useManualBounds && axisBounds && Number.isFinite(axisBounds.yMax) && axisBounds.yMax > y0 ? axisBounds.yMax : yDataRange.max;
  const fiValues = finiteFiPoints.map((point) => point.y);
  const fiRangeRaw = fiValues.length > 0 ? scaleSeries(fiValues) : null;
  const fiRangePadded = fiRangeRaw ? paddedRange(fiRangeRaw.min, fiRangeRaw.max, 0.1) : null;
  const fiY0 = fiRangePadded?.min ?? 0;
  const fiY1 = fiRangePadded?.max ?? 1;
  const primaryLabel = request.primaryParameter?.trim() || "primary parameter";
  const branchLabel = request.mode === "two_param"
    ? (request.secondaryParameter?.trim() || "secondary parameter")
    : (request.yVariable?.trim() || modelInfo?.variables[0] || "branch variable");
  const xAxisLabel = xAxisSource === "state_variable" ? (xVariable || "x variable") : primaryLabel;
  const yAxisLabel = branchLabel;
  const sx = (x: number): number => margin + ((x - x0) / Math.max(1e-12, x1 - x0)) * (width - 2 * margin);
  const sy = (y: number): number => height - margin - ((y - y0) / Math.max(1e-12, y1 - y0)) * (height - 2 * margin);
  const syFi = (value: number): number => height - margin - ((value - fiY0) / Math.max(1e-12, fiY1 - fiY0)) * (height - 2 * margin);
  const byBranch = new Map<number, Array<(typeof plottedPointsForView)[number]>>();
  const labeledPoints = plottedPointsForView.filter(({ point }) => isInspectableBifPoint(point));
  const sortedFiPoints = [...finiteFiPoints].sort((a, b) => a.x - b.x);
  const fiPath = sortedFiPoints
    .map((point, index) => `${index === 0 ? "M" : "L"}${sx(point.x)} ${syFi(point.y)}`)
    .join(" ");
  for (const point of plottedPointsForView) {
    const branchPoints = byBranch.get(point.point.branch) ?? [];
    branchPoints.push(point);
    byBranch.set(point.point.branch, branchPoints);
  }
  const omittedPointCount = projectedPoints.length - plottedPointsForView.length;
  const showPointLabels = labeledPoints.length <= 120;

  const selectNearestLabeled = (event: ReactMouseEvent<SVGSVGElement>): void => {
    if (labeledPoints.length === 0) {
      onSelect(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const y = ((event.clientY - rect.top) / rect.height) * height;

    let best: (typeof labeledPoints)[number] | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const candidate of labeledPoints) {
      const dx = sx(candidate.plotX) - x;
      const dy = sy(candidate.plotY) - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        best = candidate;
        bestDist = d2;
      }
    }

    if (best && Math.sqrt(bestDist) <= 12) {
      onSelect(best.point.label);
    }
  };

  return (
    <svg
      id={svgId}
      viewBox={`0 0 ${width} ${height}`}
      className="plotSvg"
      role="img"
      aria-label="Bifurcation plot"
      onClick={selectNearestLabeled}
    >
      <rect x={0} y={0} width={width} height={height} fill="rgba(245,252,245,0.96)" rx={10} />
      <line x1={margin} y1={height - margin} x2={width - margin} y2={height - margin} stroke="#1f2430" strokeWidth={1.2} />
      <line x1={margin} y1={margin} x2={margin} y2={height - margin} stroke="#1f2430" strokeWidth={1.2} />
      {showFiOnPlot && finiteFiPoints.length > 0 ? (
        <line x1={width - margin} y1={margin} x2={width - margin} y2={height - margin} stroke="#1d8b31" strokeWidth={1.1} />
      ) : null}
      {showFiOnPlot && sortedFiPoints.length > 1 ? (
        <path d={fiPath} fill="none" stroke="#1d8b31" strokeWidth={1.3} opacity={0.78} pointerEvents="none" />
      ) : null}
      {[...byBranch.entries()].map(([branchId, branchPoints]) => {
        const sorted = [...branchPoints].sort((a, b) => a.plotX - b.plotX);
        return sorted.slice(1).map((point, idx) => {
          const prev = sorted[idx];
          if (!prev) {
            return null;
          }
          const stable = point.point.stable ?? prev.point.stable ?? true;
          return (
            <line
              key={`branch-${branchId}-${idx}`}
              x1={sx(prev.plotX)}
              y1={sy(prev.plotY)}
              x2={sx(point.plotX)}
              y2={sy(point.plotY)}
              stroke={stable ? "#1a5ea8" : "#8a8f98"}
              strokeWidth={1.35}
              strokeDasharray={stable ? "0" : "4 3"}
              opacity={0.85}
              pointerEvents="none"
            />
          );
        });
      })}
      {plottedPointsForView.map(({ point, plotX, plotY }) => {
        const isSelectable = isInspectableBifPoint(point);
        const isSelected = isSelectable && selectedLabel !== null && point.label === selectedLabel;
        const isStable = point.stable ?? true;
        return (
          <circle
            key={`${point.index}-${point.label}`}
            cx={sx(plotX)}
            cy={sy(plotY)}
            r={isSelectable ? (isSelected ? 4.8 : 3.1) : isSelected ? 3.8 : 2.2}
            fill={
              point.type.includes("LP")
                ? "#d48000"
                : point.type.includes("HB")
                  ? "#a12b12"
                  : point.type.includes("BIF")
                    ? "#0f766a"
                    : isStable
                      ? "#0b2f73"
                      : "#7a818d"
            }
            opacity={0.95}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(isSelectable ? point.label : null);
            }}
            style={{ cursor: isSelectable ? "pointer" : "default" }}
            stroke={isSelected ? "#0f1726" : "transparent"}
            strokeWidth={isSelected ? 1.2 : 0}
          />
        );
      })}
      {finiteFiPoints.map((point, idx) => (
        <circle
          key={`fi-${idx}`}
          cx={sx(point.x)}
          cy={syFi(point.y)}
          r={2.7}
          fill="#1d8b31"
          opacity={0.92}
          pointerEvents="none"
          stroke="#f4fff5"
          strokeWidth={0.8}
        />
      ))}
      {labeledPoints.map(({ point, plotX, plotY }) => (
        <circle
          key={`hit-${point.index}-${point.label}`}
          cx={sx(plotX)}
          cy={sy(plotY)}
          r={8}
          fill="transparent"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(point.label);
          }}
          style={{ cursor: "pointer" }}
        />
      ))}
      {showPointLabels
        ? labeledPoints.map(({ point, plotX, plotY }) => (
            <text key={`label-${point.index}-${point.label}`} x={sx(plotX) + 4} y={sy(plotY) - 4} className="bifPointLabel">
              {point.label}
            </text>
          ))
        : null}
      {omittedPointCount > 0 ? (
        <text x={margin + 4} y={height - 8} className="bifPointLabel">
          {omittedPointCount} non-finite points omitted
        </text>
      ) : null}
      {showFiOnPlot && finiteFiPoints.length > 0 ? (
        <text x={margin + 4} y={margin + 11} className="bifPointLabel">
          F/I overlay: {finiteFiPoints.length} points
        </text>
      ) : null}
      <text x={width - 10} y={height - 8} textAnchor="end" className="plotLabel">
        {xAxisLabel}
      </text>
      <text x={12} y={14} className="plotLabel">
        {yAxisLabel}
      </text>
      {showFiOnPlot && finiteFiPoints.length > 0 ? (
        <>
          <text x={width - 10} y={margin + 12} textAnchor="end" className="plotMetaLabel">
            F/I {fiY1.toFixed(4)}
          </text>
          <text x={width - 10} y={height - margin - 4} textAnchor="end" className="plotMetaLabel">
            {fiY0.toFixed(4)}
          </text>
        </>
      ) : null}
      <text x={width - 10} y={14} textAnchor="end" className="plotMetaLabel">
        {axisMode} x[{x0.toFixed(3)}, {x1.toFixed(3)}] y[{y0.toFixed(3)}, {y1.toFixed(3)}]
      </text>
    </svg>
  );
}

export default function App(): JSX.Element {
  const workerRef = useRef<WorkerClient | null>(null);

  const [tab, setTab] = useState<TabId>("model");
  const [status, setStatus] = useState("Booting worker runtime...");
  const [busy, setBusy] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [engineFallbackReason, setEngineFallbackReason] = useState<string | null>(null);
  const [showEngineInfo, setShowEngineInfo] = useState(false);

  const [modelName, setModelName] = useState("lecar.ode");
  const [modelText, setModelText] = useState(DEFAULT_ODE);
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [loadedModelKey, setLoadedModelKey] = useState<string | null>(null);

  const [simRequest, setSimRequest] = useState<SimulationRequest>(DEFAULT_SIM_REQUEST);
  const [phaseRequest, setPhaseRequest] = useState<PhasePlaneRequest>(DEFAULT_PHASE_REQUEST);
  const [bifRequest, setBifRequest] = useState<BifurcationRequest>(DEFAULT_BIF_REQUEST);
  const [parameterOverrides, setParameterOverrides] = useState<Record<string, number>>({});
  const [parameterDrafts, setParameterDrafts] = useState<Record<string, string>>({});
  const [selectedCommonModelId, setSelectedCommonModelId] = useState(DEFAULT_COMMON_MODEL_ID);
  const [bifAxisAuto, setBifAxisAuto] = useState(true);
  const [bifAxisManual, setBifAxisManual] = useState<AxisBounds>(DEFAULT_BIF_AXIS_MANUAL);
  const [bifAxisFitted, setBifAxisFitted] = useState<AxisBounds | null>(null);
  const [bifXAxisSource, setBifXAxisSource] = useState<"primary_parameter" | "state_variable">("primary_parameter");

  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [phasePlane, setPhasePlane] = useState<PhasePlaneResult | null>(null);
  const [phaseTrajectories, setPhaseTrajectories] = useState<PhaseTrajectory[]>([]);
  const [bifurcation, setBifurcation] = useState<BifurcationResult | null>(null);
  const [selectedBifLabel, setSelectedBifLabel] = useState<number | null>(null);
  const [fiPoints, setFiPoints] = useState<FiPoint[]>([]);
  const [showFiCurve, setShowFiCurve] = useState(false);

  const selectedBifPoint = useMemo(
    () => bifurcation?.points.find((p) => p.label === selectedBifLabel && isInspectableBifPoint(p)) ?? null,
    [bifurcation, selectedBifLabel]
  );
  const labeledBifPoints = useMemo(
    () =>
      (bifurcation?.points ?? [])
        .filter((p) => isInspectableBifPoint(p) && Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.label - b.label),
    [bifurcation]
  );
  const hbPointCount = useMemo(
    () => (bifurcation?.points ?? []).filter((point) => normalizeBifType(point.type).startsWith("HB")).length,
    [bifurcation]
  );
  const lpPointCount = useMemo(
    () => (bifurcation?.points ?? []).filter((point) => normalizeBifType(point.type).startsWith("LP")).length,
    [bifurcation]
  );
  const fiPointCount = fiPoints.length;
  const currentModelKey = useMemo(() => `${modelName}\n${modelText}`, [modelName, modelText]);
  const parameterNames = modelInfo?.parameters ?? [];
  const variableNames = modelInfo?.variables ?? [];
  const inferredVariableNames = useMemo(() => extractStateVariablesFromOde(modelText), [modelText]);
  const parameterValues = modelInfo?.parameterValues ?? {};
  const bifParameterOptions = useMemo(
    () =>
      dedupeCaseInsensitive([
        ...parameterNames,
        ...Object.keys(parameterValues),
        ...Object.keys(parameterOverrides)
      ]),
    [parameterNames, parameterValues, parameterOverrides]
  );
  const bifVariableOptions = useMemo(
    () =>
      dedupeCaseInsensitive([
        ...inferredVariableNames.map((name) => name.toLowerCase()),
        ...inferredVariableNames,
        ...variableNames.map((name) => name.toLowerCase()),
        ...variableNames,
        ...((bifurcation?.points ?? []).flatMap((point) => Object.keys(point.stateValues ?? {}))),
        ...(bifRequest.xVariable ? [bifRequest.xVariable] : []),
        ...(bifRequest.yVariable ? [bifRequest.yVariable] : [])
      ]),
    [inferredVariableNames, variableNames, bifurcation, bifRequest.xVariable, bifRequest.yVariable]
  );
  const bifXAxisSelectionValue = useMemo(() => {
    if (bifXAxisSource === "state_variable") {
      return `${X_AXIS_VARIABLE_PREFIX}${bifRequest.xVariable?.trim() ?? ""}`;
    }
    return bifRequest.primaryParameter;
  }, [bifXAxisSource, bifRequest.xVariable, bifRequest.primaryParameter]);
  const hasParameterOverrides = useMemo(() => Object.keys(parameterOverrides).length > 0, [parameterOverrides]);
  const activeBifAxisBounds = useMemo(() => {
    if (bifAxisAuto) {
      return bifAxisFitted;
    }
    return normalizeAxisBounds(bifAxisManual);
  }, [bifAxisAuto, bifAxisFitted, bifAxisManual]);
  const selectedCommonModel = useMemo(
    () => COMMON_MODEL_OPTIONS.find((model) => model.id === selectedCommonModelId) ?? null,
    [selectedCommonModelId]
  );

  useEffect(() => {
    if (selectedBifLabel !== null && !selectedBifPoint) {
      setSelectedBifLabel(null);
    }
  }, [selectedBifLabel, selectedBifPoint]);

  const setManualBifAxis = (field: keyof AxisBounds, value: number): void => {
    if (!Number.isFinite(value)) {
      return;
    }
    setBifAxisManual((prev) => ({ ...prev, [field]: value }));
  };

  const syncEngineFallbackInfo = (diagnostics?: Diagnostic[]): void => {
    const fallbackDiag = diagnostics?.find((diag) => diag.code === "ENGINE_FALLBACK_ACTIVE");
    if (fallbackDiag?.message) {
      setEngineFallbackReason(fallbackDiag.message);
      return;
    }
    setEngineFallbackReason(null);
    setShowEngineInfo(false);
  };

  const applyModelInfo = (info: ModelInfo): void => {
    setModelInfo(info);
    setParameterOverrides((prev) => {
      const next: Record<string, number> = {};
      for (const key of info.parameters) {
        const value = prev[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          next[key] = value;
        }
      }
      return next;
    });
    setParameterDrafts((prev) => {
      const next: Record<string, string> = {};
      for (const key of info.parameters) {
        if (Object.prototype.hasOwnProperty.call(prev, key)) {
          next[key] = prev[key] ?? "";
        }
      }
      return next;
    });
  };

  useEffect(() => {
    const worker = new WorkerClient();
    workerRef.current = worker;

    void (async () => {
      try {
        await worker.boot();
        const cached = await loadLatestProject();
        const bootstrapModelName = cached?.modelName ?? "lecar.ode";
        const bootstrapModelText = cached?.modelText ?? DEFAULT_ODE;
        if (cached) {
          setModelName(cached.modelName);
          setModelText(cached.modelText);
          const cachedSim = { ...DEFAULT_SIM_REQUEST, ...(cached.simulationRequest as Partial<SimulationRequest>) };
          const cachedPhase = {
            ...DEFAULT_PHASE_REQUEST,
            ...(cached.phaseRequest as Partial<PhasePlaneRequest>),
            trajectory: {
              ...DEFAULT_PHASE_REQUEST.trajectory,
              ...(cached.phaseRequest as Partial<PhasePlaneRequest>)?.trajectory,
              enabled: false
            }
          };
          const cachedBif = {
            ...DEFAULT_BIF_REQUEST,
            ...(cached.bifRequest as Partial<BifurcationRequest>),
            startStrategy: "steady_state" as const,
            continueLabel: undefined
          };
          setSimRequest(cachedSim);
          setPhaseRequest(cachedPhase);
          setBifRequest(cachedBif);
          const cachedShared = (cached as { parameterOverrides?: Record<string, number> }).parameterOverrides;
          if (cachedShared && typeof cachedShared === "object") {
            setParameterOverrides(cachedShared);
          } else {
            setParameterOverrides(cachedSim.parameterOverrides ?? {});
          }
          setStatus("Runtime ready. Restored last project from local storage.");
        } else {
          setStatus("Runtime ready.");
        }
        await worker.loadModel(bootstrapModelText, bootstrapModelName);
        const info = await worker.getModelInfo();
        applyModelInfo(info);
        syncEngineFallbackInfo(info.diagnostics);
        setLoadedModelKey(`${bootstrapModelName}\n${bootstrapModelText}`);
      } catch (error) {
        setStatus(`Runtime boot error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setPersistenceReady(true);
      }
    })();

    return () => {
      void worker.free();
    };
  }, []);

  useEffect(() => {
    if (!persistenceReady) {
      return;
    }
    const project = {
      modelName,
      modelText,
      simulationRequest: simRequest,
      phaseRequest,
      bifRequest,
      parameterOverrides
    };
    void saveLatestProject(project);
  }, [modelName, modelText, simRequest, phaseRequest, bifRequest, parameterOverrides, persistenceReady]);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        void runSimulation();
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        void runPhasePlane();
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        void runBifurcation();
      }
    };

    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  });

  const withBusy = async (fn: () => Promise<void>): Promise<void> => {
    const worker = workerRef.current;
    if (!worker || busy) {
      return;
    }
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const syncRequestsWithModelInfo = (info: ModelInfo): void => {
    setPhaseRequest((prev) => {
      const resolved = resolvePhaseVars(info.variables, prev.xVar, prev.yVar);
      return {
        ...prev,
        xVar: resolved.xVar,
        yVar: resolved.yVar
      };
    });
    setBifRequest((prev) => {
      const variables = info.variables;
      const parameters = dedupeCaseInsensitive([...info.parameters, ...Object.keys(info.parameterValues ?? {})]);

      const primary = parameters.includes(prev.primaryParameter)
        ? prev.primaryParameter
        : (canonicalVariableName(parameters, prev.primaryParameter) ?? parameters[0] ?? prev.primaryParameter);
      const preferredSecondary = prev.secondaryParameter && includesIgnoreCase(parameters, prev.secondaryParameter)
        ? (canonicalVariableName(parameters, prev.secondaryParameter) ?? prev.secondaryParameter)
        : parameters.find((name) => notSameCaseInsensitive(name, primary));
      const yVariable = prev.yVariable && includesIgnoreCase(variables, prev.yVariable)
        ? (canonicalVariableName(variables, prev.yVariable) ?? prev.yVariable)
        : (variables[0] ?? prev.yVariable);
      const xVariable = prev.xVariable && includesIgnoreCase(variables, prev.xVariable)
        ? (canonicalVariableName(variables, prev.xVariable) ?? prev.xVariable)
        : (variables[0] ?? prev.xVariable ?? yVariable);

      return {
        ...prev,
        primaryParameter: primary,
        secondaryParameter: preferredSecondary,
        xVariable,
        yVariable,
        startStrategy: "steady_state",
        continueLabel: undefined
      };
    });
  };

  const applyLoadedModelState = (nextModelName: string, nextModelText: string, info: ModelInfo): void => {
    applyModelInfo(info);
    syncRequestsWithModelInfo(info);
    setLoadedModelKey(`${nextModelName}\n${nextModelText}`);
    setBifAxisFitted(null);
    setPhaseTrajectories([]);
    setFiPoints([]);
    setShowFiCurve(false);
  };

  const loadModel = async (): Promise<void> => {
    await withBusy(async () => {
      const worker = workerRef.current;
      if (!worker) {
        return;
      }
      await worker.loadModel(modelText, modelName);
      const info = await worker.getModelInfo();
      applyLoadedModelState(modelName, modelText, info);
      setStatus(`Loaded ${modelName} with ${info.variables.length} variables and ${info.parameters.length} parameters.`);
    });
  };

  const ensureModelLoaded = async (): Promise<ModelInfo | null> => {
    if (loadedModelKey === currentModelKey && modelInfo) {
      return modelInfo;
    }
    const worker = workerRef.current;
    if (!worker) {
      return null;
    }
    try {
      await worker.loadModel(modelText, modelName);
      const info = await worker.getModelInfo();
      applyLoadedModelState(modelName, modelText, info);
      return info;
    } catch (error) {
      setStatus(`Model load failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const runSimulation = async (): Promise<void> => {
    await withBusy(async () => {
      const worker = workerRef.current;
      if (!worker) {
        return;
      }
      const info = await ensureModelLoaded();
      if (!info) {
        return;
      }
      const result = await worker.runSimulation({ ...simRequest, parameterOverrides });
      setSimulation(result);
      syncEngineFallbackInfo(result.diagnostics);
      setStatus(`Simulation complete (${result.time.length} points).`);
      setTab("model");
    });
  };

  const runPhasePlane = async (): Promise<void> => {
    await withBusy(async () => {
      const worker = workerRef.current;
      if (!worker) {
        return;
      }
      const info = await ensureModelLoaded();
      if (!info) {
        return;
      }
      let request: PhasePlaneRequest = {
        ...phaseRequest,
        parameterOverrides,
        trajectory: {
          ...phaseRequest.trajectory,
          enabled: false
        }
      };
      const resolved = resolvePhaseVars(info.variables, request.xVar, request.yVar);
      const xVar = resolved.xVar;
      const yVar = resolved.yVar;
      request = { ...request, xVar, yVar };
      setPhaseRequest((prev) => ({ ...prev, xVar, yVar }));
      if (resolved.error) {
        setStatus(resolved.error);
        return;
      }

      const result = await worker.runPhasePlane(request);
      setPhasePlane(result);
      setPhaseTrajectories([]);
      syncEngineFallbackInfo(result.diagnostics);
      if (result.vectorField.length === 0) {
        const diag = result.diagnostics.find((d) => d.code === "PHASE_VARS_NOT_FOUND" || d.code === "VARIABLE_NOT_FOUND");
        setStatus(
          diag
            ? `Phase-plane produced 0 vectors: ${diag.message}`
            : "Phase-plane produced 0 vectors. Check xVar/yVar and vector-field ranges."
        );
      } else {
        const nonFiniteDiag = result.diagnostics.find((d) =>
          d.code === "PHASE_NONFINITE_VALUES_SANITIZED" || d.code === "PHASE_NONFINITE_DERIVATIVES"
        );
        if (nonFiniteDiag) {
          setStatus(
            `Phase-plane complete (${result.vectorField.length} vector samples) with warnings: ${nonFiniteDiag.message} ` +
              "Try narrowing x/y ranges or adjusting fixed state/parameter values."
          );
        } else {
          setStatus(`Phase-plane complete (${result.vectorField.length} vector samples).`);
        }
      }
      setTab("phase");
    });
  };

  const addPhaseTrajectoryAt = async (xSeed: number, ySeed: number): Promise<void> => {
    await withBusy(async () => {
      const worker = workerRef.current;
      if (!worker) {
        return;
      }
      if (!phasePlane) {
        setStatus("Run phase-plane first, then click the plot to add seeded trajectories.");
        return;
      }

      const info = await ensureModelLoaded();
      if (!info) {
        return;
      }

      let request: PhasePlaneRequest = { ...phaseRequest, parameterOverrides };
      const resolved = resolvePhaseVars(info.variables, request.xVar, request.yVar);
      const xVar = resolved.xVar;
      const yVar = resolved.yVar;
      request = { ...request, xVar, yVar };
      setPhaseRequest((prev) => ({ ...prev, xVar, yVar }));
      if (resolved.error) {
        setStatus(resolved.error);
        return;
      }

      const seededRequest: PhasePlaneRequest = {
        ...request,
        fixedState: {
          ...request.fixedState,
          [xVar]: xSeed,
          [yVar]: ySeed
        },
        trajectory: {
          ...request.trajectory,
          enabled: true
        }
      };

      const seeded = await worker.runPhasePlane(seededRequest);
      syncEngineFallbackInfo(seeded.diagnostics);
      if (!seeded.trajectory || seeded.trajectory.x.length === 0 || seeded.trajectory.y.length === 0) {
        const diag = seeded.diagnostics[0];
        setStatus(diag ? `Could not add trajectory: ${diag.message}` : "Could not add trajectory from selected seed.");
        return;
      }

      const newTrajectory: PhaseTrajectory = seeded.trajectory;
      const nextCount = phaseTrajectories.length + 1;
      setPhaseTrajectories((prev) => {
        return [...prev, newTrajectory];
      });
      setStatus(`Added trajectory ${nextCount} from seed (${xSeed.toFixed(3)}, ${ySeed.toFixed(3)}).`);
    });
  };

  const clearPhaseTrajectories = (): void => {
    const hadAny =
      phaseTrajectories.length > 0 ||
      (phasePlane?.trajectory?.x.length ?? 0) > 0 ||
      (phasePlane?.trajectory?.y.length ?? 0) > 0;
    if (!hadAny) {
      setStatus("No trajectories to clear.");
      return;
    }
    setPhaseTrajectories([]);
    setPhasePlane((prev) => (prev ? { ...prev, trajectory: undefined } : prev));
    setStatus("Cleared all phase-plane trajectories.");
  };

  const runBifurcation = async (options?: { continueLabel?: number }): Promise<void> => {
    await withBusy(async () => {
      const worker = workerRef.current;
      if (!worker) {
        return;
      }
      const info = await ensureModelLoaded();
      if (!info) {
        return;
      }
      const continueLabel = typeof options?.continueLabel === "number" ? options.continueLabel : undefined;
      const primaryCanonical = canonicalVariableName(info.parameters, bifRequest.primaryParameter) ?? bifRequest.primaryParameter;
      const primaryValue = getParameterValueForContinuation(info, primaryCanonical, parameterOverrides);
      const effectiveControls = (() => {
        if (!bifAxisAuto) {
          const manual = normalizeAxisBounds(bifAxisManual);
          return {
            ...bifRequest.controls,
            rl0: manual.xMin,
            rl1: manual.xMax,
            a0: -1e6,
            a1: 1e6
          };
        }
        const { rl0, rl1 } = normalizeContinuationRange(bifRequest.controls, primaryValue);
        return {
          ...bifRequest.controls,
          rl0,
          rl1,
          a0: -1e6,
          a1: 1e6
        };
      })();

      let runRequest: BifurcationRequest = {
        ...bifRequest,
        startStrategy: continueLabel !== undefined ? "continue_label" : "steady_state",
        continueLabel,
        controls: effectiveControls,
        parameterOverrides
      };
      let result = await worker.runBifurcation(runRequest);
      let controlsUsed = effectiveControls;
      let autoRetryNote = "";

      if (continueLabel === undefined && runRequest.mode === "one_param" && shouldRetrySparseOneParam(result)) {
        const recoveryControls = buildSparseRecoveryControls(effectiveControls, primaryCanonical, primaryValue);
        const retryRequest: BifurcationRequest = {
          ...runRequest,
          startStrategy: "steady_state",
          continueLabel: undefined,
          controls: recoveryControls
        };
        const retry = await worker.runBifurcation(retryRequest);
        if (finiteBifPointCount(retry) > finiteBifPointCount(result)) {
          result = retry;
          runRequest = retryRequest;
          controlsUsed = recoveryControls;
          autoRetryNote = " Applied an automatic recovery retry with wider range and smaller continuation step.";
        }
      }

      setBifRequest((prev) => ({
        ...prev,
        startStrategy: "steady_state",
        continueLabel: undefined,
        controls: {
          ...prev.controls,
          rl0: controlsUsed.rl0,
          rl1: controlsUsed.rl1,
          a0: controlsUsed.a0,
          a1: controlsUsed.a1,
          ds: controlsUsed.ds,
          dsMin: controlsUsed.dsMin,
          dsMax: controlsUsed.dsMax,
          nmx: controlsUsed.nmx,
          pointDensity: controlsUsed.pointDensity
        }
      }));

      setBifurcation(result);
      syncEngineFallbackInfo(result.diagnostics);
      const fitted = fittedBifAxisBounds(result);
      setBifAxisFitted(fitted);
      setSelectedBifLabel(null);
      setFiPoints([]);
      setShowFiCurve(false);
      if (result.points.length === 0) {
        const keyDiag = result.diagnostics.find((d) =>
          d.code === "NO_BIF_POINTS" || d.code === "NO_FINITE_BIF_POINTS" || d.code === "ONE_PARAM_SAMPLES_WITHOUT_EQ"
        );
        const fallbackDiag = result.diagnostics.find((d) => d.code === "ENGINE_FALLBACK_ACTIVE");
        setStatus(
          (keyDiag
            ? `Bifurcation produced no plottable points: ${keyDiag.code}. Open the plot panel for detailed diagnostics.`
            : "Bifurcation produced no plottable points. Open the plot panel for detailed diagnostics.") +
            (fallbackDiag ? " Runtime is in fallback mode; results are approximate and can differ from XPPAUT/AUTO." : "") +
            autoRetryNote
        );
      } else {
        const branchCount = new Set(result.points.map((p) => p.branch)).size;
        const unstableCount = result.points.filter((p) => p.stable === false).length;
        const hbCount = result.points.filter((p) => normalizeBifType(p.type).startsWith("HB")).length;
        const lpCount = result.points.filter((p) => normalizeBifType(p.type).startsWith("LP")).length;
        const fallbackDiag = result.diagnostics.find((d) => d.code === "ENGINE_FALLBACK_ACTIVE");
        const sparseDiag = result.diagnostics.find((d) => d.code === "SPARSE_BIFURCATION_OUTPUT");
        setStatus(
          `Bifurcation complete (${result.points.length} points, ${branchCount} branches, ${unstableCount} unstable points, HB=${hbCount}, LP=${lpCount}).` +
            (sparseDiag ? ` ${sparseDiag.message}` : "") +
            (fallbackDiag ? " Runtime is in fallback mode; results are approximate and can differ from XPPAUT/AUTO." : "") +
            autoRetryNote
        );
      }
      setTab("bifurcation");
    });
  };

  const generateFiCurve = async (): Promise<void> => {
    await withBusy(async () => {
      const worker = workerRef.current;
      if (!worker) {
        return;
      }
      const info = await ensureModelLoaded();
      if (!info) {
        return;
      }
      const primaryParameter = canonicalVariableName(info.parameters, bifRequest.primaryParameter) ?? "";
      if (!primaryParameter) {
        setStatus("F/I generation failed: primary parameter is not available in the loaded model.");
        return;
      }
      const yVariable = (bifRequest.yVariable && canonicalVariableName(info.variables, bifRequest.yVariable))
        ?? info.variables[0]
        ?? "";
      if (!yVariable) {
        setStatus("F/I generation failed: no model state variable is available for spike detection.");
        return;
      }
      const fiFromBif = fiFromPeriodicBifurcation(bifurcation, primaryParameter);
      const fiFromBifSpread = fiCurveSpread(fiFromBif);
      if (fiFromBif.length >= 4 && fiFromBifSpread.xSpan > 1e-8 && fiFromBifSpread.ySpan > 1e-8) {
        const nonZeroCount = fiFromBif.filter((point) => point.y > 0).length;
        setFiPoints(fiFromBif);
        setShowFiCurve(true);
        setStatus(
          `F/I curve generated from XPPAUT periodic branch data (${fiFromBif.length} points, non-zero=${nonZeroCount}, parameter=${primaryParameter}).`
        );
        setTab("bifurcation");
        return;
      }
      const skippedBifReason = fiFromBif.length >= 4
        ? "Periodic branch data looked flat; using simulation sweep for F/I."
        : null;
      const voltageLike = info.variables.filter((name) => isVoltageLikeVariableName(name));
      const isFallbackMode = engineFallbackReason !== null || info.diagnostics.some((diag) => diag.code === "ENGINE_FALLBACK_ACTIVE");
      const fiCandidates = dedupeCaseInsensitive([
        yVariable,
        ...voltageLike,
        info.variables[0] ?? ""
      ]);
      const stateVariables = dedupeCaseInsensitive(info.variables);
      const stateVariablesForCarry = isFallbackMode ? stateVariables.slice(0, 4) : stateVariables;
      const requestedSeries = dedupeCaseInsensitive([...fiCandidates, ...stateVariablesForCarry]);

      const primaryValue = getParameterValueForContinuation(info, bifRequest.primaryParameter, parameterOverrides);
      const effectiveControls = (() => {
        if (!bifAxisAuto) {
          const manual = normalizeAxisBounds(bifAxisManual);
          return {
            ...bifRequest.controls,
            rl0: manual.xMin,
            rl1: manual.xMax
          };
        }
        const { rl0, rl1 } = normalizeContinuationRange(bifRequest.controls, primaryValue);
        return {
          ...bifRequest.controls,
          rl0,
          rl1
        };
      })();
      let fiSweepControls = effectiveControls;
      let fiRangeNote: string | null = null;
      if (bifAxisAuto && isCurrentLikeParameter(primaryParameter)) {
        const center = typeof primaryValue === "number" && Number.isFinite(primaryValue)
          ? primaryValue
          : (effectiveControls.rl0 + effectiveControls.rl1) / 2;
        const minPreferred = center - 2;
        const maxPreferred = center + 8;
        const width = effectiveControls.rl1 - effectiveControls.rl0;
        if (width < 10) {
          fiSweepControls = {
            ...effectiveControls,
            rl0: Math.min(effectiveControls.rl0, minPreferred),
            rl1: Math.max(effectiveControls.rl1, maxPreferred)
          };
          fiRangeNote = `Using expanded ${primaryParameter} sweep [${fiSweepControls.rl0.toFixed(3)}, ${fiSweepControls.rl1.toFixed(3)}] for F/I onset detection.`;
        }
      }
      const sampleCount = Math.max(
        isFallbackMode ? 8 : 12,
        Math.min(
          isFallbackMode ? 12 : 80,
          Math.round((bifRequest.controls.npr || 30) * Math.max(1, bifRequest.controls.pointDensity ?? 1))
        )
      );
      const fiDurations = [...new Set(
        isFallbackMode
          ? [
              Math.max(simRequest.tEnd, 700),
              Math.max(simRequest.tEnd * 1.8, 1600)
            ]
          : [
              Math.max(simRequest.tEnd, 900),
              Math.max(simRequest.tEnd * 2, 2500),
              Math.max(simRequest.tEnd * 4, 5000)
            ]
      )].sort((a, b) => a - b);
      const maxStepsPerRun = isFallbackMode ? 60_000 : 320_000;
      const startMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      const maxSweepMs = isFallbackMode ? 25_000 : 150_000;
      const maxSimulationCalls = isFallbackMode ? 24 : Number.POSITIVE_INFINITY;
      const progressInterval = Math.max(1, Math.floor(sampleCount / 8));
      const sampledPoints: FiPoint[] = [];
      const signalUsage = new Map<string, number>();
      let rollingInitialConditions: Record<string, number> = { ...simRequest.initialConditions };
      let timedOut = false;
      let callBudgetHit = false;
      let simulationCalls = 0;
      let sawStepBudget = false;
      let sawStepTruncation = false;
      let sweepError: string | null = null;

      for (let i = 0; i < sampleCount; i += 1) {
        const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (nowMs - startMs > maxSweepMs) {
          timedOut = true;
          break;
        }
        if (i === 0 || i === sampleCount - 1 || (i + 1) % progressInterval === 0) {
          setStatus(`Generating F/I curve (${i + 1}/${sampleCount})...`);
        }
        const frac = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
        const parameterValue = fiSweepControls.rl0 + frac * (fiSweepControls.rl1 - fiSweepControls.rl0);
        let best = { rate: Number.NEGATIVE_INFINITY, signal: fiCandidates[0] ?? yVariable };
        let chosenSim: SimulationResult | null = null;

        for (let durationIndex = 0; durationIndex < fiDurations.length; durationIndex += 1) {
          const innerNowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
          if (innerNowMs - startMs > maxSweepMs) {
            timedOut = true;
            break;
          }
          if (simulationCalls >= maxSimulationCalls) {
            callBudgetHit = true;
            break;
          }
          const duration = fiDurations[durationIndex] ?? fiDurations[fiDurations.length - 1] ?? Math.max(simRequest.tEnd, 900);
          const minDtForBudget = duration / maxStepsPerRun;
          const dtForRun = Math.max(simRequest.dt, minDtForBudget);
          simulationCalls += 1;
          let sim: SimulationResult;
          try {
            sim = await worker.runSimulation({
              ...simRequest,
              tEnd: duration,
              dt: dtForRun,
              parameterOverrides: {
                ...parameterOverrides,
                [primaryParameter]: parameterValue
              },
              initialConditions: rollingInitialConditions,
              requestedSeries
            });
          } catch (error) {
            sweepError = error instanceof Error ? error.message : String(error);
            timedOut = true;
            break;
          }
          syncEngineFallbackInfo(sim.diagnostics);
          if (sim.diagnostics.some((diag) => diag.code === "SIM_STEP_BUDGET_APPLIED")) {
            sawStepBudget = true;
          }
          if (sim.diagnostics.some((diag) => diag.code === "SIM_STEP_BUDGET_TRUNCATED")) {
            sawStepTruncation = true;
          }
          const candidate = pickBestFiringRate(sim.time, sim.series, fiCandidates);
          if (!chosenSim || candidate.rate > best.rate) {
            best = candidate;
            chosenSim = sim;
          }
          const isLongRun = durationIndex >= fiDurations.length - 2;
          if (candidate.rate > 0 && isLongRun) {
            break;
          }
        }
        if (callBudgetHit) {
          break;
        }
        if (timedOut) {
          break;
        }

        if (!chosenSim) {
          continue;
        }
        if (!Number.isFinite(best.rate)) {
          best = { rate: 0, signal: best.signal || yVariable };
        }

        for (const stateName of stateVariablesForCarry) {
          const stateSeries = findSeriesCaseInsensitive(chosenSim.series, stateName);
          const last = lastFiniteValue(stateSeries);
          if (typeof last === "number" && Number.isFinite(last)) {
            rollingInitialConditions[stateName] = last;
          }
        }

        const rate = best.rate;
        const signalName = best.signal || yVariable;
        signalUsage.set(signalName, (signalUsage.get(signalName) ?? 0) + 1);
        if (Number.isFinite(parameterValue) && Number.isFinite(rate)) {
          sampledPoints.push({
            x: parameterValue,
            y: rate
          });
        }
      }

      const finitePoints = sampledPoints.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (finitePoints.length === 0) {
        setStatus(
          timedOut
            ? "F/I generation timed out before any finite points were produced. Try shorter tEnd, larger dt, or narrower parameter range."
            : "F/I generation returned no finite points. Try a different parameter range or simulation settings." +
              (callBudgetHit ? " Reached fallback simulation-call budget while sweeping." : "") +
              (sawStepBudget ? " Fallback step budget was applied." : "") +
              (sawStepTruncation ? " Some sweeps were truncated by the fallback step budget." : "") +
              (sweepError ? ` Last engine error: ${sweepError}` : "")
        );
        return;
      }
      let dominantSignal = yVariable;
      let dominantCount = 0;
      for (const [name, count] of signalUsage.entries()) {
        if (count > dominantCount) {
          dominantCount = count;
          dominantSignal = name;
        }
      }
      const nonZeroCount = finitePoints.filter((point) => point.y > 0).length;
      if (nonZeroCount === 0) {
        setFiPoints(finitePoints);
        setShowFiCurve(true);
        setStatus(
          `F/I sweep found no spikes in this range (${finitePoints.length} samples, parameter=${primaryParameter}).` +
            " Try increasing drive/bias and widening the parameter window." +
            (timedOut ? " Sweep was time-limited in fallback mode; rerun with fewer points or shorter simulation duration." : "") +
            (callBudgetHit ? " Sweep reached fallback simulation-call budget." : "") +
            (sawStepBudget ? " Fallback step budget was applied." : "") +
            (sawStepTruncation ? " Some sweeps were truncated by the fallback step budget." : "") +
            (sweepError ? ` Last engine error: ${sweepError}.` : "") +
            (fiRangeNote ? ` ${fiRangeNote}` : "")
        );
      } else {
        setFiPoints(finitePoints);
        setShowFiCurve(true);
        setStatus(
          `F/I curve generated (${finitePoints.length} points, non-zero=${nonZeroCount}, dominant signal=${dominantSignal}, parameter=${primaryParameter}).` +
            (skippedBifReason ? ` ${skippedBifReason}` : "") +
            (timedOut ? " Sweep reached fallback time limit; showing partial curve." : "") +
            (callBudgetHit ? " Sweep reached fallback simulation-call budget; showing partial curve." : "") +
            (sawStepBudget ? " Fallback step budget was applied." : "") +
            (sawStepTruncation ? " Some sweeps were truncated by the fallback step budget." : "") +
            (sweepError ? ` Last engine error: ${sweepError}.` : "") +
            (fiRangeNote ? ` ${fiRangeNote}` : "")
        );
      }
      setTab("bifurcation");
    });
  };

  const getSvgById = (id: string): SVGSVGElement | null => {
    const element = document.getElementById(id);
    if (!element || !(element instanceof SVGSVGElement)) {
      return null;
    }
    return element;
  };

  const exportSvg = (id: string, fileName: string): void => {
    const svg = getSvgById(id);
    if (!svg) {
      setStatus(`Plot ${id} is not available yet.`);
      return;
    }
    const text = new XMLSerializer().serializeToString(svg);
    downloadBlob(fileName, new Blob([text], { type: "image/svg+xml" }));
  };

  const exportPng = (id: string, fileName: string): void => {
    const svg = getSvgById(id);
    if (!svg) {
      setStatus(`Plot ${id} is not available yet.`);
      return;
    }
    const text = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width || 1280;
      canvas.height = image.height || 720;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setStatus("Could not initialize canvas context.");
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          setStatus("PNG export failed.");
          return;
        }
        downloadBlob(fileName, blob);
      }, "image/png");
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  };

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    void file.text().then((text) => {
      setModelName(file.name);
      setModelText(text);
      setTab("model");
      void withBusy(async () => {
        const worker = workerRef.current;
        if (!worker) {
          return;
        }
        await worker.loadModel(text, file.name);
        const info = await worker.getModelInfo();
        applyLoadedModelState(file.name, text, info);
        setStatus(`Loaded ${file.name} with ${info.variables.length} variables and ${info.parameters.length} parameters.`);
      });
    });
  };

  const loadSelectedCommonModel = (): void => {
    if (!selectedCommonModel) {
      setStatus("Select a common model first.");
      return;
    }
    const nextModelName = selectedCommonModel.fileName;
    const nextModelText = selectedCommonModel.source;
    setModelName(nextModelName);
    setModelText(nextModelText);
    if (selectedCommonModel.id === BUILTIN_BUTERA_REDUCED.id) {
      setPhaseRequest((prev) => ({
        ...prev,
        xVar: "v",
        yVar: "n",
        vectorField: {
          ...prev.vectorField,
          xMin: -80,
          xMax: 20,
          yMin: 0,
          yMax: 1
        }
      }));
      setBifRequest((prev) => ({
        ...prev,
        mode: "one_param",
        primaryParameter: "hfix",
        secondaryParameter: undefined,
        yVariable: "v",
        controls: {
          ...prev.controls,
          rl0: 0,
          rl1: 1,
          a0: -1e6,
          a1: 1e6,
          nmx: 220
        }
      }));
      setBifAxisAuto(true);
      setBifAxisManual({ xMin: 0, xMax: 1, yMin: -80, yMax: 20 });
    }
    setTab("model");
    void withBusy(async () => {
      const worker = workerRef.current;
      if (!worker) {
        return;
      }
      await worker.loadModel(nextModelText, nextModelName);
      const info = await worker.getModelInfo();
      applyLoadedModelState(nextModelName, nextModelText, info);
      if (selectedCommonModel.id === BUILTIN_BUTERA_REDUCED.id) {
        setStatus(`Loaded ${selectedCommonModel.label} with recommended defaults (${info.parameters.length} parameters).`);
      } else {
        setStatus(`Loaded ${selectedCommonModel.label} (${info.parameters.length} parameters).`);
      }
    });
  };

  const exportModelCsv = (): void => {
    if (!modelInfo) {
      setStatus("No loaded model metadata available to export.");
      return;
    }
    const csv = toCsv([
      ["variable", ...modelInfo.variables],
      ["parameter", ...modelInfo.parameters],
      ["auxiliary", ...modelInfo.auxiliaries],
      ["set", ...modelInfo.sets]
    ]);
    downloadBlob("model_metadata.csv", new Blob([csv], { type: "text/csv;charset=utf-8" }));
  };

  const exportBundle = async (): Promise<void> => {
    const blob = await exportProjectBundle({
      modelName,
      modelText,
      simulation,
      phase: phasePlane,
      bifurcation,
      controls: {
        simulationRequest: { ...simRequest, parameterOverrides },
        phaseRequest: { ...phaseRequest, parameterOverrides },
        bifRequest: { ...bifRequest, parameterOverrides }
      }
    });
    downloadBlob(`${modelName.replace(/\.ode$/i, "") || "xpp-project"}.zip`, blob);
  };

  const setSharedParameter = (name: string, rawValue: string): void => {
    setParameterDrafts((prev) => ({ ...prev, [name]: rawValue }));
    setParameterOverrides((prev) => {
      const next = { ...prev };
      if (rawValue.trim() === "") {
        delete next[name];
        return next;
      }
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) {
        return prev;
      }
      const defaultValue = parameterValues[name];
      if (typeof defaultValue === "number" && Math.abs(parsed - defaultValue) < 1e-12) {
        delete next[name];
        return next;
      }
      next[name] = parsed;
      return next;
    });
  };

  const normalizeSharedParameterInput = (name: string): void => {
    setParameterDrafts((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, name)) {
        return prev;
      }
      const raw = prev[name] ?? "";
      const trimmed = raw.trim();
      const next = { ...prev };
      if (trimmed === "") {
        delete next[name];
        return next;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        const fallback = parameterOverrides[name] ?? parameterValues[name];
        next[name] = typeof fallback === "number" && Number.isFinite(fallback) ? String(fallback) : "";
        return next;
      }
      next[name] = String(parsed);
      return next;
    });
  };

  const resetSharedParameters = (): void => {
    setParameterOverrides({});
    setParameterDrafts({});
    setStatus("Shared parameter overrides reset to model defaults.");
  };

  const renderSharedParameterPanel = (): JSX.Element => (
    <article className="panel panelFull">
      <h2>Shared Parameters</h2>
      <p className="hint">Applies to simulation, phase plane, and bifurcation runs.</p>
      {parameterNames.length === 0 ? (
        <div className="panelEmpty">Load a model to edit parameter values.</div>
      ) : (
        <>
          <div className="parameterGrid">
            {parameterNames.map((name) => {
              const currentValue = parameterOverrides[name] ?? parameterValues[name] ?? 0;
              const defaultValue = parameterValues[name];
              const isOverride = Object.prototype.hasOwnProperty.call(parameterOverrides, name);
              const displayValue = Object.prototype.hasOwnProperty.call(parameterDrafts, name)
                ? parameterDrafts[name] ?? ""
                : String(currentValue);
              return (
                <label className="parameterField" key={`param-${name}`}>
                  <span>
                    {name}
                    {isOverride ? " (override)" : ""}
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={displayValue}
                    onChange={(event) => setSharedParameter(name, event.target.value)}
                    onBlur={() => normalizeSharedParameterInput(name)}
                  />
                  {typeof defaultValue === "number" ? <small>Default: {defaultValue}</small> : null}
                </label>
              );
            })}
          </div>
          <div className="buttonRow">
            <button className="btnMuted" onClick={resetSharedParameters} disabled={!hasParameterOverrides}>
              Reset to Defaults
            </button>
          </div>
        </>
      )}
    </article>
  );

  return (
    <main className="appRoot">
      <section className="toolbar">
        <div className="toolbarLabel">Project File</div>
        <p className="toolbarHint">Pick a common Neurobook model or upload a `.ode`, then run and export from the active tab.</p>
        <div className="toolbarRow">
          <label className="toolbarField">
            Common model (Neurobook)
            <select value={selectedCommonModelId} onChange={(event) => setSelectedCommonModelId(event.target.value)}>
              <option value="">Select common model...</option>
              {COMMON_MODEL_OPTIONS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <button className="btnMuted" disabled={busy || !selectedCommonModel} onClick={loadSelectedCommonModel}>
            Load Selected Model
          </button>
          <label className="fileButton fileButtonAlt">
            Upload .ode
            <input type="file" accept=".ode,text/plain" onChange={handleFileUpload} />
          </label>
        </div>
      </section>

      <section className="statusBar">
        <span className={`statusBadge ${busy ? "statusBusy" : "statusReady"}`}>{busy ? "Working" : "Ready"}</span>
        <span className="statusText">{status}</span>
        {engineFallbackReason ? (
          <button
            className="statusInfoButton"
            type="button"
            aria-label="Show fallback runtime details"
            title="Why this is using fallback runtime"
            onClick={() => setShowEngineInfo((prev) => !prev)}
          >
            i
          </button>
        ) : null}
      </section>
      {showEngineInfo && engineFallbackReason ? (
        <section className="statusInfoPanel">
          <strong>Fallback Runtime Details</strong>
          <p>{engineFallbackReason}</p>
          <ul className="statusInfoList">
            <li>Build the XPPAUT WASM core: <code>npm run wasm:build</code>.</li>
            <li>Restart the web dev server after building.</li>
            <li>Hard refresh the page (<code>Cmd+Shift+R</code>) to reload worker assets.</li>
            <li>Confirm these files exist: <code>apps/web/public/wasm/xppcore.js</code> and <code>xppcore.wasm</code>.</li>
          </ul>
        </section>
      ) : null}

      <nav className="tabs" aria-label="analysis tabs">
        <button className={`tabButton ${tab === "model" ? "tabActive" : ""}`} onClick={() => setTab("model")}>Model</button>
        <button className={`tabButton ${tab === "phase" ? "tabActive" : ""}`} onClick={() => setTab("phase")}>Phase Plane</button>
        <button className={`tabButton ${tab === "bifurcation" ? "tabActive" : ""}`} onClick={() => setTab("bifurcation")}>Bifurcation</button>
      </nav>

      {tab === "model" ? (
        <section className="panelGrid">
          <article className="panel panelTall">
            <h2>Model</h2>
            <input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="Model filename" />
            <textarea value={modelText} onChange={(e) => setModelText(e.target.value)} spellCheck={false} />
          </article>

          <article className="panel panelWide">
            <h2>Simulation</h2>
            <div className="gridTwo">
              <label>
                tEnd
                <NumericInput
                  value={simRequest.tEnd}
                  onCommit={(next) => setSimRequest((prev) => ({ ...prev, tEnd: clamp(next, 1, 50000) }))}
                />
              </label>
              <label>
                dt
                <NumericInput
                  value={simRequest.dt}
                  onCommit={(next) => setSimRequest((prev) => ({ ...prev, dt: clamp(next, 0.0001, 100) }))}
                />
              </label>
            </div>
            <p className="hint">Shortcut: Ctrl+Enter runs simulation.</p>
            <div className="buttonRow">
              <button className="btnPrimary" disabled={busy} onClick={() => void runSimulation()}>Run Simulation</button>
              <button className="btnMuted" disabled={busy} onClick={() => void loadModel()}>Load Model</button>
              <button
                className="btnMuted"
                onClick={() => {
                  if (!simulation) {
                    setStatus("Run simulation before exporting CSV.");
                    return;
                  }
                  downloadBlob("simulation.csv", new Blob([simulationCsv(simulation)], { type: "text/csv;charset=utf-8" }));
                }}
              >
                Export Simulation CSV
              </button>
              <button className="btnMuted" onClick={() => exportSvg("simulation-plot", "simulation.svg")}>Export Simulation SVG</button>
              <button className="btnMuted" onClick={() => exportPng("simulation-plot", "simulation.png")}>Export Simulation PNG</button>
              <button className="btnMuted" onClick={exportModelCsv}>Export Model CSV</button>
              <button className="btnGhost" onClick={() => void exportBundle()}>Export Project Bundle</button>
            </div>
            <SimulationPlot data={simulation} svgId="simulation-plot" />
            <details className="simpleDetails">
              <summary>Model details and diagnostics</summary>
              {modelInfo ? (
                <>
                  <p>
                    Variables: <strong>{modelInfo.variables.join(", ") || "none"}</strong>
                  </p>
                  <p>
                    Parameters: <strong>{modelInfo.parameters.join(", ") || "none"}</strong>
                  </p>
                  <p>
                    Auxiliaries: <strong>{modelInfo.auxiliaries.join(", ") || "none"}</strong>
                  </p>
                  <ul className="diagnosticList">
                    {modelInfo.diagnostics.map((d, idx) => (
                      <li key={`diag-${idx}`}>
                        [{d.tier}] {d.code}: {d.message}
                        {d.line ? ` (line ${d.line})` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>Load model to inspect parser diagnostics and compatibility tiers.</p>
              )}
            </details>
          </article>
          {renderSharedParameterPanel()}
        </section>
      ) : null}

      {tab === "phase" ? (
        <section className="panelGrid">
          <article className="panel panelWide">
            <h2>Phase Plane</h2>
            <PhasePlot
              data={phasePlane}
              svgId="phase-plot"
              xLabel={phaseRequest.xVar}
              yLabel={phaseRequest.yVar}
              extraTrajectories={phaseTrajectories}
              onAddTrajectorySeed={(x, y) => {
                void addPhaseTrajectoryAt(x, y);
              }}
            />
          </article>
          <article className="panel">
            <h2>Phase Controls</h2>
            <div className="gridTwo">
              <label>
                xVar
                <select
                  value={phaseRequest.xVar}
                  onChange={(e) => setPhaseRequest((prev) => ({ ...prev, xVar: e.target.value }))}
                  disabled={variableNames.length === 0}
                >
                  {!variableNames.includes(phaseRequest.xVar) && phaseRequest.xVar ? (
                    <option value={phaseRequest.xVar}>{phaseRequest.xVar} (current)</option>
                  ) : null}
                  {variableNames.length === 0 ? <option value={phaseRequest.xVar}>Load model first</option> : null}
                  {variableNames.map((name) => (
                    <option key={`phase-x-${name}`} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                yVar
                <select
                  value={phaseRequest.yVar}
                  onChange={(e) => setPhaseRequest((prev) => ({ ...prev, yVar: e.target.value }))}
                  disabled={variableNames.length === 0}
                >
                  {!variableNames.includes(phaseRequest.yVar) && phaseRequest.yVar ? (
                    <option value={phaseRequest.yVar}>{phaseRequest.yVar} (current)</option>
                  ) : null}
                  {variableNames.length === 0 ? <option value={phaseRequest.yVar}>Load model first</option> : null}
                  {variableNames.map((name) => (
                    <option key={`phase-y-${name}`} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                xMin
                <NumericInput
                  value={phaseRequest.vectorField.xMin}
                  onCommit={(next) =>
                    setPhaseRequest((prev) => ({
                      ...prev,
                      vectorField: { ...prev.vectorField, xMin: next }
                    }))
                  }
                />
              </label>
              <label>
                xMax
                <NumericInput
                  value={phaseRequest.vectorField.xMax}
                  onCommit={(next) =>
                    setPhaseRequest((prev) => ({
                      ...prev,
                      vectorField: { ...prev.vectorField, xMax: next }
                    }))
                  }
                />
              </label>
            </div>
            <p className="hint">Shortcut: Ctrl+Shift+P runs phase-plane.</p>
            <p className="hint">Tip: click the phase-plane plot to add a trajectory seeded at that point.</p>
            <div className="buttonRow">
              <button className="btnPrimary" disabled={busy} onClick={() => void runPhasePlane()}>Run Phase Plane</button>
              <button className="btnMuted" disabled={busy || (phaseTrajectories.length === 0 && !phasePlane?.trajectory)} onClick={clearPhaseTrajectories}>
                Clear Trajectories
              </button>
              <button
                className="btnMuted"
                onClick={() => {
                  if (!phasePlane) {
                    setStatus("Run phase-plane before exporting CSV.");
                    return;
                  }
                  downloadBlob("phase_plane.csv", new Blob([phasePlaneCsv(phasePlane)], { type: "text/csv;charset=utf-8" }));
                }}
              >
                Export Phase Plane CSV
              </button>
              <button className="btnMuted" onClick={() => exportSvg("phase-plot", "phase_plane.svg")}>Export Phase Plane SVG</button>
              <button className="btnMuted" onClick={() => exportPng("phase-plot", "phase_plane.png")}>Export Phase Plane PNG</button>
            </div>
            <details className="simpleDetails">
              <summary>Advanced grid settings</summary>
              <div className="gridTwo">
                <label>
                  yMin
                  <NumericInput
                    value={phaseRequest.vectorField.yMin}
                    onCommit={(next) =>
                      setPhaseRequest((prev) => ({
                        ...prev,
                        vectorField: { ...prev.vectorField, yMin: next }
                      }))
                    }
                  />
                </label>
                <label>
                  yMax
                  <NumericInput
                    value={phaseRequest.vectorField.yMax}
                    onCommit={(next) =>
                      setPhaseRequest((prev) => ({
                        ...prev,
                        vectorField: { ...prev.vectorField, yMax: next }
                      }))
                    }
                  />
                </label>
              </div>
            </details>
          </article>
          {renderSharedParameterPanel()}
        </section>
      ) : null}

      {tab === "bifurcation" ? (
        <section className="panelGrid">
          <article className="panel panelWide">
            <h2>Bifurcation Branches</h2>
            <BifurcationPlot
              data={bifurcation}
              request={bifRequest}
              modelInfo={modelInfo}
              axisBounds={activeBifAxisBounds}
              axisMode={bifAxisAuto ? "auto" : "manual"}
              xAxisSource={bifXAxisSource}
              selectedLabel={selectedBifLabel}
              fiPoints={fiPoints}
              showFiCurve={showFiCurve}
              onSelect={setSelectedBifLabel}
              svgId="bifurcation-plot"
            />
            {selectedBifPoint ? (
              <div className="inspector">
                <strong>Point Inspector</strong>
                <div>Label: {selectedBifPoint.label}</div>
                <div>Type: {selectedBifPoint.type}</div>
                <div>Stable: {selectedBifPoint.stable === undefined ? "unknown" : selectedBifPoint.stable ? "yes" : "no"}</div>
                <div>Branch: {selectedBifPoint.branch}</div>
                {typeof selectedBifPoint.ntot === "number" ? <div>ntot: {selectedBifPoint.ntot}</div> : null}
                {typeof selectedBifPoint.itp === "number" ? <div>itp: {selectedBifPoint.itp}</div> : null}
                {typeof selectedBifPoint.period === "number" && Number.isFinite(selectedBifPoint.period) ? (
                  <div>Period: {selectedBifPoint.period.toFixed(6)}</div>
                ) : null}
                <div>x: {selectedBifPoint.x.toFixed(6)}</div>
                <div>y: {selectedBifPoint.y.toFixed(6)}</div>
                {bifRequest.xVariable ? (
                  <div>
                    {bifRequest.xVariable}: {(() => {
                      const v = stateValueCaseInsensitive(selectedBifPoint, bifRequest.xVariable ?? "");
                      return typeof v === "number" && Number.isFinite(v) ? v.toFixed(6) : "n/a";
                    })()}
                  </div>
                ) : null}
                {bifRequest.yVariable ? (
                  <div>
                    {bifRequest.yVariable}: {(() => {
                      const v = stateValueCaseInsensitive(selectedBifPoint, bifRequest.yVariable ?? "");
                      return typeof v === "number" && Number.isFinite(v) ? v.toFixed(6) : "n/a";
                    })()}
                  </div>
                ) : null}
                <button
                  className="btnGhost"
                  onClick={() => {
                    void runBifurcation({ continueLabel: selectedBifPoint.label });
                  }}
                >
                  Continue from label
                </button>
              </div>
            ) : (
              <div className="inspector">Select a labeled point to inspect and continue.</div>
            )}
            {labeledBifPoints.length > 0 ? (
              <details className="simpleDetails">
                <summary>Labeled points ({labeledBifPoints.length})</summary>
                <div className="pointList">
                  {labeledBifPoints.map((point) => (
                    <button
                      key={`pick-${point.index}-${point.label}`}
                      className={point.label === selectedBifLabel ? "btnGhost pointButtonActive" : "btnMuted"}
                      onClick={() => setSelectedBifLabel(point.label)}
                    >
                      #{point.label} {point.type} ({point.x.toFixed(4)}, {point.y.toFixed(4)})
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
          </article>

          <article className="panel">
            <h2>Bifurcation Controls</h2>
            <div className="gridTwo">
              <label>
                Mode
                <select
                  value={bifRequest.mode}
                  onChange={(e) =>
                    setBifRequest((prev) => ({
                      ...prev,
                      mode: e.target.value as BifurcationRequest["mode"]
                    }))
                  }
                >
                  <option value="one_param">one_param</option>
                  <option value="two_param">two_param</option>
                </select>
              </label>
              <label>
                X-axis Control
                <select
                  value={bifXAxisSelectionValue}
                  onChange={(e) => {
                    const selected = e.target.value;
                    if (selected.startsWith(X_AXIS_VARIABLE_PREFIX)) {
                      const nextXVariable = selected.slice(X_AXIS_VARIABLE_PREFIX.length);
                      setBifXAxisSource("state_variable");
                      setBifRequest((prev) => ({ ...prev, xVariable: nextXVariable || undefined }));
                      return;
                    }
                    setBifXAxisSource("primary_parameter");
                    setBifRequest((prev) => {
                      const nextPrimary = selected;
                      const secondaryConflicts =
                        typeof prev.secondaryParameter === "string" &&
                        prev.secondaryParameter.trim() !== "" &&
                        !notSameCaseInsensitive(prev.secondaryParameter, nextPrimary);
                      const nextSecondary = secondaryConflicts
                        ? (bifParameterOptions.find((name) => notSameCaseInsensitive(name, nextPrimary)) ?? undefined)
                        : prev.secondaryParameter;
                      return {
                        ...prev,
                        primaryParameter: nextPrimary,
                        secondaryParameter: nextSecondary
                      };
                    });
                  }}
                  disabled={bifParameterOptions.length === 0 && bifVariableOptions.length === 0}
                >
                  {!includesIgnoreCase(bifParameterOptions, bifRequest.primaryParameter) && bifRequest.primaryParameter ? (
                    <option value={bifRequest.primaryParameter}>{bifRequest.primaryParameter} (current)</option>
                  ) : null}
                  {bifParameterOptions.length === 0 && bifVariableOptions.length === 0
                    ? <option value={bifXAxisSelectionValue}>Load model first</option>
                    : null}
                  {bifParameterOptions.length > 0 ? (
                    <optgroup label="Continuation parameters">
                      {bifParameterOptions.map((name) => (
                        <option key={`primary-${name}`} value={name}>
                          {name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {bifVariableOptions.length > 0 ? (
                    <optgroup label="State variables (x-axis)">
                      {bifVariableOptions.map((name) => (
                        <option key={`primary-xvar-${name}`} value={`${X_AXIS_VARIABLE_PREFIX}${name}`}>
                          {name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </label>
              <label>
                Y-axis Parameter
                <select
                  value={bifRequest.secondaryParameter ?? ""}
                  onChange={(e) => setBifRequest((prev) => ({ ...prev, secondaryParameter: e.target.value || undefined }))}
                >
                  <option value="">(none)</option>
                  {!bifRequest.secondaryParameter || includesIgnoreCase(bifParameterOptions, bifRequest.secondaryParameter)
                    ? null
                    : <option value={bifRequest.secondaryParameter}>{bifRequest.secondaryParameter} (current)</option>}
                  {bifParameterOptions
                    .filter((name) => notSameCaseInsensitive(name, bifRequest.primaryParameter))
                    .map((name) => (
                      <option key={`secondary-${name}`} value={name}>
                        {name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                yVariable
                <select
                  value={bifRequest.yVariable ?? ""}
                  onChange={(e) => setBifRequest((prev) => ({ ...prev, yVariable: e.target.value || undefined }))}
                >
                  <option value="">(auto)</option>
                  {!bifRequest.yVariable || includesIgnoreCase(bifVariableOptions, bifRequest.yVariable)
                    ? null
                    : <option value={bifRequest.yVariable}>{bifRequest.yVariable} (current)</option>}
                  {bifVariableOptions.map((name) => (
                    <option key={`yvar-${name}`} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Plot X-axis As
                <select
                  value={bifXAxisSource}
                  onChange={(e) => setBifXAxisSource(e.target.value as "primary_parameter" | "state_variable")}
                >
                  <option value="primary_parameter">Primary parameter</option>
                  <option value="state_variable">State variable</option>
                </select>
              </label>
              <label>
                xVariable
                <select
                  value={bifRequest.xVariable ?? ""}
                  onChange={(e) => setBifRequest((prev) => ({ ...prev, xVariable: e.target.value || undefined }))}
                  disabled={bifXAxisSource !== "state_variable"}
                >
                  <option value="">(auto)</option>
                  {!bifRequest.xVariable || includesIgnoreCase(bifVariableOptions, bifRequest.xVariable)
                    ? null
                    : <option value={bifRequest.xVariable}>{bifRequest.xVariable} (current)</option>}
                  {bifVariableOptions.map((name) => (
                    <option key={`xvar-${name}`} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Point Density
                <select
                  value={String(bifRequest.controls.pointDensity ?? 1)}
                  onChange={(e) => {
                    const pointDensity = Math.min(8, Math.max(1, Math.round(Number(e.target.value) || 1)));
                    setBifRequest((prev) => ({
                      ...prev,
                      controls: {
                        ...prev.controls,
                        pointDensity
                      }
                    }));
                  }}
                >
                  <option value="1">Standard (1x)</option>
                  <option value="2">High (2x)</option>
                  <option value="4">Very High (4x)</option>
                </select>
              </label>
            </div>
            <p className="hint">Increase point density if HB/LP/P points are missed. Higher values run slower.</p>
            <details className="simpleDetails">
              <summary>Axis scaling</summary>
              <div className="axisControls">
                <label className="inlineCheck">
                  <input type="checkbox" checked={bifAxisAuto} onChange={(e) => setBifAxisAuto(e.target.checked)} />
                  Auto-fit axes after run
                </label>
                <p className="axisSummary">
                  Mode: {bifAxisAuto ? "Auto (manual values ignored)" : "Manual (using values below)"}
                </p>
                {!bifAxisAuto ? <p className="axisSummary">Manual x-bounds are used as the continuation window.</p> : null}
                <div className="gridTwo">
                  <label>
                    xMin
                    <NumericInput value={bifAxisManual.xMin} disabled={bifAxisAuto} onCommit={(next) => setManualBifAxis("xMin", next)} />
                  </label>
                  <label>
                    xMax
                    <NumericInput value={bifAxisManual.xMax} disabled={bifAxisAuto} onCommit={(next) => setManualBifAxis("xMax", next)} />
                  </label>
                  <label>
                    yMin
                    <NumericInput value={bifAxisManual.yMin} disabled={bifAxisAuto} onCommit={(next) => setManualBifAxis("yMin", next)} />
                  </label>
                  <label>
                    yMax
                    <NumericInput value={bifAxisManual.yMax} disabled={bifAxisAuto} onCommit={(next) => setManualBifAxis("yMax", next)} />
                  </label>
                </div>
                {bifAxisFitted ? (
                  <p className="axisSummary">
                    Auto-fit bounds: x[{bifAxisFitted.xMin.toFixed(3)}, {bifAxisFitted.xMax.toFixed(3)}], y[
                    {bifAxisFitted.yMin.toFixed(3)}, {bifAxisFitted.yMax.toFixed(3)}]
                  </p>
                ) : (
                  <p className="axisSummary">Run bifurcation to compute automatic axis bounds.</p>
                )}
              </div>
            </details>
            <p className="hint">Shortcut: Ctrl+Shift+B runs bifurcation.</p>
            <div className="buttonRow">
              <button className="btnPrimary" disabled={busy} onClick={() => void runBifurcation()}>Run Bifurcation</button>
              <button className="btnMuted" disabled={busy} onClick={() => void generateFiCurve()}>
                Generate F/I Curve
              </button>
              <button
                className="btnMuted"
                disabled={busy || fiPoints.length === 0}
                onClick={() => {
                  setFiPoints([]);
                  setShowFiCurve(false);
                  setStatus("Cleared F/I curve overlay.");
                }}
              >
                Clear F/I Curve
              </button>
              <button
                className="btnMuted"
                onClick={() => {
                  if (!bifurcation) {
                    setStatus("Run bifurcation before exporting CSV.");
                    return;
                  }
                  downloadBlob("bifurcation.csv", new Blob([bifurcationCsv(bifurcation)], { type: "text/csv;charset=utf-8" }));
                }}
              >
                Export Bifurcation CSV
              </button>
              <button className="btnMuted" onClick={() => exportSvg("bifurcation-plot", "bifurcation.svg")}>Export Bifurcation SVG</button>
              <button className="btnMuted" onClick={() => exportPng("bifurcation-plot", "bifurcation.png")}>Export Bifurcation PNG</button>
            </div>
            <label className="inlineCheck">
              <input
                type="checkbox"
                checked={showFiCurve}
                disabled={fiPoints.length === 0}
                onChange={(event) => setShowFiCurve(event.target.checked)}
              />
              Show F/I overlay (green circles)
            </label>
            <p className="hint">F/I y-values are firing rates in inverse model time units (1/time).</p>
            <div className="legend">
              <span className="legendItem"><i className="dot lp" /> LP</span>
              <span className="legendItem"><i className="dot hb" /> HB</span>
              <span className="legendItem"><i className="dot bif" /> Stability Transition</span>
              <span className="legendItem"><i className="dot ep" /> Stable EP</span>
              <span className="legendItem"><i className="dot un" /> Unstable EP</span>
              <span className="legendItem"><i className="dot fi" /> F/I</span>
            </div>
            <p className="hint">
              Detected points: HB={hbPointCount}, LP={lpPointCount}, total labeled={labeledBifPoints.length}.
              {hbPointCount === 0 ? " No HB detected in current sweep." : ""}
              {fiPointCount > 0 ? ` F/I points=${fiPointCount}.` : ""}
            </p>
          </article>
          {renderSharedParameterPanel()}
        </section>
      ) : null}

    </main>
  );
}
