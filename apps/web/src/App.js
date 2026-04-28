import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { bifurcationCsv, downloadBlob, exportProjectBundle, phasePlaneCsv, simulationCsv, toCsv } from "./exporters";
import { COMMON_MODELS } from "./commonModels";
import { loadLatestProject, saveLatestProject } from "./storage";
import { WorkerClient } from "./workerClient";
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
const DEFAULT_SIM_REQUEST = {
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
const DEFAULT_PHASE_REQUEST = {
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
const DEFAULT_BIF_REQUEST = {
    mode: "one_param",
    primaryParameter: "iapp",
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
const BUILTIN_BUTERA_REDUCED = {
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
const COMMON_MODEL_OPTIONS = [
    BUILTIN_BUTERA_REDUCED,
    ...COMMON_MODELS
];
const DEFAULT_COMMON_MODEL_ID = BUILTIN_BUTERA_REDUCED.id;
const DEFAULT_BIF_AXIS_MANUAL = {
    xMin: 0,
    xMax: 1,
    yMin: -80,
    yMax: 20
};
const SPECIAL_BIF_TYPE_PREFIXES = ["HB", "LP", "BP", "PD", "TR", "BIF"];
const SPECIAL_BIF_TYPE_EXACT = new Set(["BT", "CP", "GH", "ZH", "NS"]);
function normalizeBifType(type) {
    return type.trim().toUpperCase();
}
function isSpecialBifType(type) {
    const normalized = normalizeBifType(type);
    if (!normalized) {
        return false;
    }
    if (SPECIAL_BIF_TYPE_EXACT.has(normalized)) {
        return true;
    }
    return SPECIAL_BIF_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
function isInspectableBifPoint(point) {
    return point.label > 0 && isSpecialBifType(point.type);
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function scaleSeries(values) {
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
function paddedRange(min, max, fraction = 0.05) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { min: -1, max: 1 };
    }
    if (Math.abs(max - min) < 1e-9) {
        return { min: min - 1, max: max + 1 };
    }
    const pad = Math.max(1e-6, Math.abs(max - min) * fraction);
    return { min: min - pad, max: max + pad };
}
function fittedBifAxisBounds(data) {
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
function normalizeAxisBounds(bounds) {
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
function includesIgnoreCase(values, target) {
    const t = target.trim().toLowerCase();
    return values.some((value) => value.toLowerCase() === t);
}
function canonicalVariableName(values, target) {
    const t = target.trim().toLowerCase();
    return values.find((value) => value.toLowerCase() === t) ?? null;
}
function getParameterValueForContinuation(info, primaryParameter, parameterOverrides) {
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
function normalizeContinuationRange(controls, primaryValue) {
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
function findSeriesCaseInsensitive(series, requestedName) {
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
function dedupeCaseInsensitive(values) {
    const out = [];
    const seen = new Set();
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
function lastFiniteValue(values) {
    for (let i = values.length - 1; i >= 0; i -= 1) {
        const value = values[i];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}
function pickBestFiringRate(time, series, candidates) {
    let bestRate = Number.NEGATIVE_INFINITY;
    let bestSignal = candidates[0] ?? "";
    for (const candidate of candidates) {
        const values = findSeriesCaseInsensitive(series, candidate);
        const rate = estimateFiringRate(time, values);
        if (!Number.isFinite(rate)) {
            continue;
        }
        if (rate > bestRate) {
            bestRate = rate;
            bestSignal = candidate;
        }
    }
    if (!Number.isFinite(bestRate)) {
        return { rate: 0, signal: bestSignal };
    }
    return { rate: bestRate, signal: bestSignal };
}
function fiFromPeriodicBifurcation(data, primaryParameter) {
    if (!data || data.points.length === 0) {
        return [];
    }
    const periodic = data.points.filter((point) => point.branch < 0 &&
        typeof point.period === "number" &&
        Number.isFinite(point.period) &&
        point.period > 0 &&
        Number.isFinite(point.x));
    if (periodic.length === 0) {
        return [];
    }
    const stablePeriodic = periodic.filter((point) => point.stable !== false);
    const source = stablePeriodic.length >= 4 ? stablePeriodic : periodic;
    const merged = new Map();
    for (const point of source) {
        const px = typeof point.parameters?.[primaryParameter] === "number" && Number.isFinite(point.parameters[primaryParameter])
            ? point.parameters[primaryParameter]
            : point.x;
        const rate = 1 / point.period;
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
function fiCurveSpread(points) {
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
function isCurrentLikeParameter(name) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    if (normalized === "i" || normalized === "iapp" || normalized === "ibias" || normalized === "idc" || normalized === "iinj") {
        return true;
    }
    return normalized.includes("current") || normalized.includes("inj");
}
function finiteBifPointCount(result) {
    return result.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).length;
}
function shouldRetrySparseOneParam(result) {
    const finiteCount = finiteBifPointCount(result);
    if (finiteCount > 2) {
        return false;
    }
    const hasSparseDiagnostic = result.diagnostics.some((diag) => diag.code === "SPARSE_BIFURCATION_OUTPUT");
    const hasNoFiniteDiagnostic = result.diagnostics.some((diag) => diag.code === "NO_FINITE_BIFURCATION_POINTS");
    return hasSparseDiagnostic || (!hasNoFiniteDiagnostic && finiteCount > 0);
}
function buildSparseRecoveryControls(controls, primaryParameter, primaryValue) {
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
function estimateFiringRate(time, signal) {
    const n = Math.min(time.length, signal.length);
    if (n < 5) {
        return 0;
    }
    const samples = [];
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
    const intervals = [];
    for (let i = 1; i < active.length; i += 1) {
        const dt = active[i].t - active[i - 1].t;
        if (Number.isFinite(dt) && dt > 0) {
            intervals.push(dt);
        }
    }
    intervals.sort((a, b) => a - b);
    const medianDt = intervals.length > 0
        ? intervals[Math.floor(intervals.length / 2)] ?? intervals[0] ?? 1e-3
        : 1e-3;
    const minIsi = Math.max(2 * medianDt, (lastTime - firstTime) / 500, 1e-6);
    const spikes = [];
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
    const peaks = [];
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
function resolvePhaseVars(variables, xVar, yVar) {
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
function NumericInput({ value, onCommit, disabled }) {
    const [draft, setDraft] = useState(() => (Number.isFinite(value) ? String(value) : ""));
    useEffect(() => {
        setDraft(Number.isFinite(value) ? String(value) : "");
    }, [value]);
    const commit = () => {
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
    return (_jsx("input", { type: "text", inputMode: "decimal", value: draft, disabled: disabled, onChange: (event) => setDraft(event.target.value), onBlur: commit, onKeyDown: (event) => {
            if (event.key === "Enter") {
                commit();
                event.currentTarget.blur();
            }
            if (event.key === "Escape") {
                setDraft(Number.isFinite(value) ? String(value) : "");
                event.currentTarget.blur();
            }
        } }));
}
function SimulationPlot({ data, svgId }) {
    if (!data) {
        return _jsx("div", { className: "panelEmpty", children: "Run a simulation to visualize trajectories." });
    }
    const firstSeriesName = Object.keys(data.series)[0] ?? "";
    const ySeries = firstSeriesName ? data.series[firstSeriesName] ?? [] : [];
    if (data.time.length === 0 || ySeries.length === 0) {
        return _jsx("div", { className: "panelEmpty", children: "Simulation returned empty output." });
    }
    const width = 760;
    const height = 320;
    const margin = 26;
    const x0 = data.time[0] ?? 0;
    const x1 = data.time[data.time.length - 1] ?? 1;
    const { min: y0, max: y1 } = scaleSeries(ySeries);
    const sx = (x) => margin + ((x - x0) / Math.max(1e-12, x1 - x0)) * (width - 2 * margin);
    const sy = (y) => height - margin - ((y - y0) / Math.max(1e-12, y1 - y0)) * (height - 2 * margin);
    const path = data.time
        .map((t, i) => `${i === 0 ? "M" : "L"}${sx(t)} ${sy(ySeries[i] ?? 0)}`)
        .join(" ");
    return (_jsxs("svg", { id: svgId, viewBox: `0 0 ${width} ${height}`, className: "plotSvg", role: "img", "aria-label": "Simulation plot", children: [_jsx("rect", { x: 0, y: 0, width: width, height: height, fill: "rgba(248,248,242,0.92)", rx: 10 }), _jsx("line", { x1: margin, y1: height - margin, x2: width - margin, y2: height - margin, stroke: "#1f2430", strokeWidth: 1.5 }), _jsx("line", { x1: margin, y1: margin, x2: margin, y2: height - margin, stroke: "#1f2430", strokeWidth: 1.5 }), _jsx("path", { d: path, stroke: "#cb4f1d", strokeWidth: 2, fill: "none" }), _jsx("text", { x: width - 10, y: height - 6, textAnchor: "end", className: "plotLabel", children: "t" }), _jsx("text", { x: 8, y: 14, className: "plotLabel", children: firstSeriesName })] }));
}
function PhasePlot({ data, svgId, xLabel, yLabel, extraTrajectories, onAddTrajectorySeed }) {
    if (!data) {
        return _jsx("div", { className: "panelEmpty", children: "Run phase-plane analysis to render vector field and nullclines." });
    }
    const width = 760;
    const height = 340;
    const margin = 30;
    const xs = data.vectorField.map((p) => p.x);
    const ys = data.vectorField.map((p) => p.y);
    const { min: x0, max: x1 } = scaleSeries(xs);
    const { min: y0, max: y1 } = scaleSeries(ys);
    const sx = (x) => margin + ((x - x0) / Math.max(1e-12, x1 - x0)) * (width - 2 * margin);
    const sy = (y) => height - margin - ((y - y0) / Math.max(1e-12, y1 - y0)) * (height - 2 * margin);
    const overlays = extraTrajectories ?? [];
    const handlePlotClick = (event) => {
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
    return (_jsxs("svg", { id: svgId, viewBox: `0 0 ${width} ${height}`, className: "plotSvg", role: "img", "aria-label": "Phase-plane plot", onClick: handlePlotClick, style: onAddTrajectorySeed ? { cursor: "crosshair" } : undefined, children: [_jsx("rect", { x: 0, y: 0, width: width, height: height, fill: "rgba(251,245,236,0.95)", rx: 10 }), _jsx("line", { x1: margin, y1: height - margin, x2: width - margin, y2: height - margin, stroke: "#1f2430", strokeWidth: 1.2 }), _jsx("line", { x1: margin, y1: margin, x2: margin, y2: height - margin, stroke: "#1f2430", strokeWidth: 1.2 }), data.vectorField.map((v, idx) => {
                const len = Math.max(1e-9, Math.hypot(v.dx, v.dy));
                const norm = 11;
                const dx = (v.dx / len) * norm;
                const dy = (v.dy / len) * norm;
                const x = sx(v.x);
                const y = sy(v.y);
                return _jsx("line", { x1: x, y1: y, x2: x + dx, y2: y - dy, stroke: "#1f2430", strokeWidth: 0.8, opacity: 0.38 }, `vf-${idx}`);
            }), data.nullclines.xNullcline.map((line, idx) => (_jsx("polyline", { fill: "none", stroke: "#0c8f5d", strokeWidth: 1.5, points: line.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ") }, `xn-${idx}`))), data.nullclines.yNullcline.map((line, idx) => (_jsx("polyline", { fill: "none", stroke: "#a12b12", strokeWidth: 1.5, points: line.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ") }, `yn-${idx}`))), overlays.map((trajectory, idx) => (_jsx("polyline", { fill: "none", stroke: "#0b2f73", strokeWidth: 2, opacity: 0.72, points: trajectory.x.map((x, i) => `${sx(x)},${sy(trajectory.y[i] ?? 0)}`).join(" ") }, `extra-traj-${idx}`))), _jsx("text", { x: width - 10, y: height - 8, textAnchor: "end", className: "plotLabel", children: xLabel.trim() || "x" }), _jsx("text", { x: 12, y: 14, className: "plotLabel", children: yLabel.trim() || "y" })] }));
}
function BifurcationPlot({ data, request, modelInfo, axisBounds, axisMode, selectedLabel, fiPoints, showFiCurve, onSelect, svgId }) {
    if (!data) {
        return _jsx("div", { className: "panelEmpty", children: "Run bifurcation analysis to render branches." });
    }
    const width = 760;
    const height = 340;
    const margin = 30;
    const plottedPoints = data.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (plottedPoints.length === 0) {
        const diagnostics = data.diagnostics.slice(-8);
        const tips = [];
        const hasPrimary = modelInfo ? modelInfo.parameters.includes(request.primaryParameter) : true;
        if (!hasPrimary) {
            tips.push(`Primary parameter '${request.primaryParameter}' was not found in this model. Pick one from Model details.`);
        }
        if (request.mode === "two_param") {
            const hasSecondary = request.secondaryParameter ? (modelInfo ? modelInfo.parameters.includes(request.secondaryParameter) : true) : false;
            if (!hasSecondary) {
                tips.push(`Secondary parameter '${request.secondaryParameter ?? ""}' was not found in this model.`);
            }
            tips.push("Run one-parameter continuation first to verify a finite branch before switching to two-parameter mode.");
        }
        const hasYVar = request.yVariable ? (modelInfo ? modelInfo.variables.includes(request.yVariable) : true) : true;
        if (!hasYVar) {
            tips.push(`y variable '${request.yVariable ?? ""}' is not a model state variable.`);
        }
        if (Math.abs(request.controls.rl1 - request.controls.rl0) < 1e-12) {
            tips.push("Primary parameter range is zero-width. Set different RL0 and RL1 values.");
        }
        tips.push(`Try a nearby parameter window first, e.g. RL0=${request.controls.rl0}, RL1=${request.controls.rl1}.`);
        tips.push("If this happens after a code update, hard refresh the page (Cmd+Shift+R) to reload the worker.");
        return (_jsxs("div", { className: "panelEmpty panelEmptyDetailed", children: [_jsx("p", { children: _jsx("strong", { children: "Bifurcation output did not contain finite points to render." }) }), _jsxs("p", { children: ["Run config: mode=", request.mode, ", primary=", request.primaryParameter, ", y=", request.yVariable ?? "auto", "."] }), _jsxs("p", { children: ["Continuation window: RL=[", request.controls.rl0, ", ", request.controls.rl1, "]."] }), diagnostics.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("p", { children: "Diagnostics:" }), _jsx("ul", { className: "diagnosticListCompact", children: diagnostics.map((d, idx) => (_jsxs("li", { children: ["[", d.tier, "] ", d.code, ": ", d.message] }, `bif-diag-${idx}`))) })] })) : null, _jsx("p", { children: "Try this:" }), _jsx("ul", { className: "diagnosticListCompact", children: tips.map((tip, idx) => (_jsx("li", { children: tip }, `bif-tip-${idx}`))) })] }));
    }
    const xs = plottedPoints.map((p) => p.x);
    const ys = plottedPoints.map((p) => p.y);
    const finiteFiPoints = showFiCurve
        ? fiPoints.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        : [];
    const xScaleValues = axisMode === "auto" ? [...xs, ...finiteFiPoints.map((point) => point.x)] : xs;
    const yScaleValues = ys;
    const xDataRange = scaleSeries(xScaleValues.length > 0 ? xScaleValues : xs);
    const yDataRange = scaleSeries(yScaleValues.length > 0 ? yScaleValues : ys);
    const x0 = axisBounds && Number.isFinite(axisBounds.xMin) ? axisBounds.xMin : xDataRange.min;
    const x1 = axisBounds && Number.isFinite(axisBounds.xMax) && axisBounds.xMax > x0 ? axisBounds.xMax : xDataRange.max;
    const y0 = axisBounds && Number.isFinite(axisBounds.yMin) ? axisBounds.yMin : yDataRange.min;
    const y1 = axisBounds && Number.isFinite(axisBounds.yMax) && axisBounds.yMax > y0 ? axisBounds.yMax : yDataRange.max;
    const fiValues = finiteFiPoints.map((point) => point.y);
    const fiRangeRaw = fiValues.length > 0 ? scaleSeries(fiValues) : null;
    const fiRangePadded = fiRangeRaw ? paddedRange(fiRangeRaw.min, fiRangeRaw.max, 0.1) : null;
    const fiY0 = fiRangePadded?.min ?? 0;
    const fiY1 = fiRangePadded?.max ?? 1;
    const xAxisLabel = request.primaryParameter?.trim() || "primary parameter";
    const yAxisLabel = request.mode === "two_param"
        ? (request.secondaryParameter?.trim() || "secondary parameter")
        : (request.yVariable?.trim() || modelInfo?.variables[0] || "branch variable");
    const sx = (x) => margin + ((x - x0) / Math.max(1e-12, x1 - x0)) * (width - 2 * margin);
    const sy = (y) => height - margin - ((y - y0) / Math.max(1e-12, y1 - y0)) * (height - 2 * margin);
    const syFi = (value) => height - margin - ((value - fiY0) / Math.max(1e-12, fiY1 - fiY0)) * (height - 2 * margin);
    const byBranch = new Map();
    const labeledPoints = plottedPoints.filter((p) => isInspectableBifPoint(p));
    const sortedFiPoints = [...finiteFiPoints].sort((a, b) => a.x - b.x);
    const fiPath = sortedFiPoints
        .map((point, index) => `${index === 0 ? "M" : "L"}${sx(point.x)} ${syFi(point.y)}`)
        .join(" ");
    for (const point of plottedPoints) {
        const branchPoints = byBranch.get(point.branch) ?? [];
        branchPoints.push(point);
        byBranch.set(point.branch, branchPoints);
    }
    const omittedPointCount = data.points.length - plottedPoints.length;
    const showPointLabels = labeledPoints.length <= 120;
    const selectNearestLabeled = (event) => {
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
        let best = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const point of labeledPoints) {
            const dx = sx(point.x) - x;
            const dy = sy(point.y) - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDist) {
                best = point;
                bestDist = d2;
            }
        }
        if (best && Math.sqrt(bestDist) <= 12) {
            onSelect(best.label);
        }
    };
    return (_jsxs("svg", { id: svgId, viewBox: `0 0 ${width} ${height}`, className: "plotSvg", role: "img", "aria-label": "Bifurcation plot", onClick: selectNearestLabeled, children: [_jsx("rect", { x: 0, y: 0, width: width, height: height, fill: "rgba(245,252,245,0.96)", rx: 10 }), _jsx("line", { x1: margin, y1: height - margin, x2: width - margin, y2: height - margin, stroke: "#1f2430", strokeWidth: 1.2 }), _jsx("line", { x1: margin, y1: margin, x2: margin, y2: height - margin, stroke: "#1f2430", strokeWidth: 1.2 }), showFiCurve && finiteFiPoints.length > 0 ? (_jsx("line", { x1: width - margin, y1: margin, x2: width - margin, y2: height - margin, stroke: "#1d8b31", strokeWidth: 1.1 })) : null, showFiCurve && sortedFiPoints.length > 1 ? (_jsx("path", { d: fiPath, fill: "none", stroke: "#1d8b31", strokeWidth: 1.3, opacity: 0.78, pointerEvents: "none" })) : null, [...byBranch.entries()].map(([branchId, branchPoints]) => {
                const sorted = [...branchPoints].sort((a, b) => a.x - b.x);
                return sorted.slice(1).map((point, idx) => {
                    const prev = sorted[idx];
                    if (!prev) {
                        return null;
                    }
                    const stable = point.stable ?? prev.stable ?? true;
                    return (_jsx("line", { x1: sx(prev.x), y1: sy(prev.y), x2: sx(point.x), y2: sy(point.y), stroke: stable ? "#1a5ea8" : "#8a8f98", strokeWidth: 1.35, strokeDasharray: stable ? "0" : "4 3", opacity: 0.85, pointerEvents: "none" }, `branch-${branchId}-${idx}`));
                });
            }), plottedPoints.map((p) => {
                const isSelectable = isInspectableBifPoint(p);
                const isSelected = isSelectable && selectedLabel !== null && p.label === selectedLabel;
                const isStable = p.stable ?? true;
                return (_jsx("circle", { cx: sx(p.x), cy: sy(p.y), r: isSelectable ? (isSelected ? 4.8 : 3.1) : isSelected ? 3.8 : 2.2, fill: p.type.includes("LP")
                        ? "#d48000"
                        : p.type.includes("HB")
                            ? "#a12b12"
                            : p.type.includes("BIF")
                                ? "#0f766a"
                                : isStable
                                    ? "#0b2f73"
                                    : "#7a818d", opacity: 0.95, onClick: (event) => {
                        event.stopPropagation();
                        onSelect(isSelectable ? p.label : null);
                    }, style: { cursor: isSelectable ? "pointer" : "default" }, stroke: isSelected ? "#0f1726" : "transparent", strokeWidth: isSelected ? 1.2 : 0 }, `${p.index}-${p.label}`));
            }), finiteFiPoints.map((point, idx) => (_jsx("circle", { cx: sx(point.x), cy: syFi(point.y), r: 2.7, fill: "#1d8b31", opacity: 0.92, pointerEvents: "none", stroke: "#f4fff5", strokeWidth: 0.8 }, `fi-${idx}`))), labeledPoints.map((p) => (_jsx("circle", { cx: sx(p.x), cy: sy(p.y), r: 8, fill: "transparent", onClick: (event) => {
                    event.stopPropagation();
                    onSelect(p.label);
                }, style: { cursor: "pointer" } }, `hit-${p.index}-${p.label}`))), showPointLabels
                ? labeledPoints.map((p) => (_jsx("text", { x: sx(p.x) + 4, y: sy(p.y) - 4, className: "bifPointLabel", children: p.label }, `label-${p.index}-${p.label}`)))
                : null, omittedPointCount > 0 ? (_jsxs("text", { x: margin + 4, y: height - 8, className: "bifPointLabel", children: [omittedPointCount, " non-finite points omitted"] })) : null, showFiCurve && finiteFiPoints.length > 0 ? (_jsxs("text", { x: margin + 4, y: margin + 11, className: "bifPointLabel", children: ["F/I overlay: ", finiteFiPoints.length, " points"] })) : null, _jsx("text", { x: width - 10, y: height - 8, textAnchor: "end", className: "plotLabel", children: xAxisLabel }), _jsx("text", { x: 12, y: 14, className: "plotLabel", children: yAxisLabel }), showFiCurve && finiteFiPoints.length > 0 ? (_jsxs(_Fragment, { children: [_jsxs("text", { x: width - 10, y: margin + 12, textAnchor: "end", className: "plotMetaLabel", children: ["F/I ", fiY1.toFixed(4)] }), _jsx("text", { x: width - 10, y: height - margin - 4, textAnchor: "end", className: "plotMetaLabel", children: fiY0.toFixed(4) })] })) : null, _jsxs("text", { x: width - 10, y: 14, textAnchor: "end", className: "plotMetaLabel", children: [axisMode, " x[", x0.toFixed(3), ", ", x1.toFixed(3), "] y[", y0.toFixed(3), ", ", y1.toFixed(3), "]"] })] }));
}
export default function App() {
    const workerRef = useRef(null);
    const [tab, setTab] = useState("model");
    const [status, setStatus] = useState("Booting worker runtime...");
    const [busy, setBusy] = useState(false);
    const [persistenceReady, setPersistenceReady] = useState(false);
    const [engineFallbackReason, setEngineFallbackReason] = useState(null);
    const [showEngineInfo, setShowEngineInfo] = useState(false);
    const [modelName, setModelName] = useState("lecar.ode");
    const [modelText, setModelText] = useState(DEFAULT_ODE);
    const [modelInfo, setModelInfo] = useState(null);
    const [loadedModelKey, setLoadedModelKey] = useState(null);
    const [simRequest, setSimRequest] = useState(DEFAULT_SIM_REQUEST);
    const [phaseRequest, setPhaseRequest] = useState(DEFAULT_PHASE_REQUEST);
    const [bifRequest, setBifRequest] = useState(DEFAULT_BIF_REQUEST);
    const [parameterOverrides, setParameterOverrides] = useState({});
    const [parameterDrafts, setParameterDrafts] = useState({});
    const [selectedCommonModelId, setSelectedCommonModelId] = useState(DEFAULT_COMMON_MODEL_ID);
    const [bifAxisAuto, setBifAxisAuto] = useState(true);
    const [bifAxisManual, setBifAxisManual] = useState(DEFAULT_BIF_AXIS_MANUAL);
    const [bifAxisFitted, setBifAxisFitted] = useState(null);
    const [simulation, setSimulation] = useState(null);
    const [phasePlane, setPhasePlane] = useState(null);
    const [phaseTrajectories, setPhaseTrajectories] = useState([]);
    const [bifurcation, setBifurcation] = useState(null);
    const [selectedBifLabel, setSelectedBifLabel] = useState(null);
    const [fiPoints, setFiPoints] = useState([]);
    const [showFiCurve, setShowFiCurve] = useState(false);
    const selectedBifPoint = useMemo(() => bifurcation?.points.find((p) => p.label === selectedBifLabel && isInspectableBifPoint(p)) ?? null, [bifurcation, selectedBifLabel]);
    const labeledBifPoints = useMemo(() => (bifurcation?.points ?? [])
        .filter((p) => isInspectableBifPoint(p) && Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.label - b.label), [bifurcation]);
    const hbPointCount = useMemo(() => (bifurcation?.points ?? []).filter((point) => normalizeBifType(point.type).startsWith("HB")).length, [bifurcation]);
    const lpPointCount = useMemo(() => (bifurcation?.points ?? []).filter((point) => normalizeBifType(point.type).startsWith("LP")).length, [bifurcation]);
    const fiPointCount = fiPoints.length;
    const currentModelKey = useMemo(() => `${modelName}\n${modelText}`, [modelName, modelText]);
    const parameterNames = modelInfo?.parameters ?? [];
    const variableNames = modelInfo?.variables ?? [];
    const parameterValues = modelInfo?.parameterValues ?? {};
    const hasParameterOverrides = useMemo(() => Object.keys(parameterOverrides).length > 0, [parameterOverrides]);
    const activeBifAxisBounds = useMemo(() => {
        if (bifAxisAuto) {
            return bifAxisFitted;
        }
        return normalizeAxisBounds(bifAxisManual);
    }, [bifAxisAuto, bifAxisFitted, bifAxisManual]);
    const selectedCommonModel = useMemo(() => COMMON_MODEL_OPTIONS.find((model) => model.id === selectedCommonModelId) ?? null, [selectedCommonModelId]);
    useEffect(() => {
        if (selectedBifLabel !== null && !selectedBifPoint) {
            setSelectedBifLabel(null);
        }
    }, [selectedBifLabel, selectedBifPoint]);
    const setManualBifAxis = (field, value) => {
        if (!Number.isFinite(value)) {
            return;
        }
        setBifAxisManual((prev) => ({ ...prev, [field]: value }));
    };
    const syncEngineFallbackInfo = (diagnostics) => {
        const fallbackDiag = diagnostics?.find((diag) => diag.code === "ENGINE_FALLBACK_ACTIVE");
        if (fallbackDiag?.message) {
            setEngineFallbackReason(fallbackDiag.message);
            return;
        }
        setEngineFallbackReason(null);
        setShowEngineInfo(false);
    };
    const applyModelInfo = (info) => {
        setModelInfo(info);
        setParameterOverrides((prev) => {
            const next = {};
            for (const key of info.parameters) {
                const value = prev[key];
                if (typeof value === "number" && Number.isFinite(value)) {
                    next[key] = value;
                }
            }
            return next;
        });
        setParameterDrafts((prev) => {
            const next = {};
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
                    const cachedSim = { ...DEFAULT_SIM_REQUEST, ...cached.simulationRequest };
                    const cachedPhase = {
                        ...DEFAULT_PHASE_REQUEST,
                        ...cached.phaseRequest,
                        trajectory: {
                            ...DEFAULT_PHASE_REQUEST.trajectory,
                            ...cached.phaseRequest?.trajectory,
                            enabled: false
                        }
                    };
                    const cachedBif = {
                        ...DEFAULT_BIF_REQUEST,
                        ...cached.bifRequest,
                        startStrategy: "steady_state",
                        continueLabel: undefined
                    };
                    setSimRequest(cachedSim);
                    setPhaseRequest(cachedPhase);
                    setBifRequest(cachedBif);
                    const cachedShared = cached.parameterOverrides;
                    if (cachedShared && typeof cachedShared === "object") {
                        setParameterOverrides(cachedShared);
                    }
                    else {
                        setParameterOverrides(cachedSim.parameterOverrides ?? {});
                    }
                    setStatus("Runtime ready. Restored last project from local storage.");
                }
                else {
                    setStatus("Runtime ready.");
                }
                await worker.loadModel(bootstrapModelText, bootstrapModelName);
                const info = await worker.getModelInfo();
                applyModelInfo(info);
                syncEngineFallbackInfo(info.diagnostics);
                setLoadedModelKey(`${bootstrapModelName}\n${bootstrapModelText}`);
            }
            catch (error) {
                setStatus(`Runtime boot error: ${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
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
        const onKeydown = (event) => {
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
    const withBusy = async (fn) => {
        const worker = workerRef.current;
        if (!worker || busy) {
            return;
        }
        setBusy(true);
        try {
            await fn();
        }
        catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    const syncRequestsWithModelInfo = (info) => {
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
            const parameters = info.parameters;
            const primary = parameters.includes(prev.primaryParameter)
                ? prev.primaryParameter
                : (canonicalVariableName(parameters, prev.primaryParameter) ?? parameters[0] ?? prev.primaryParameter);
            const preferredSecondary = prev.secondaryParameter && includesIgnoreCase(parameters, prev.secondaryParameter)
                ? (canonicalVariableName(parameters, prev.secondaryParameter) ?? prev.secondaryParameter)
                : parameters.find((name) => name !== primary);
            const yVariable = prev.yVariable && includesIgnoreCase(variables, prev.yVariable)
                ? (canonicalVariableName(variables, prev.yVariable) ?? prev.yVariable)
                : (variables[0] ?? prev.yVariable);
            return {
                ...prev,
                primaryParameter: primary,
                secondaryParameter: preferredSecondary,
                yVariable,
                startStrategy: "steady_state",
                continueLabel: undefined
            };
        });
    };
    const applyLoadedModelState = (nextModelName, nextModelText, info) => {
        applyModelInfo(info);
        syncRequestsWithModelInfo(info);
        setLoadedModelKey(`${nextModelName}\n${nextModelText}`);
        setBifAxisFitted(null);
        setPhaseTrajectories([]);
        setFiPoints([]);
        setShowFiCurve(false);
    };
    const loadModel = async () => {
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
    const ensureModelLoaded = async () => {
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
        }
        catch (error) {
            setStatus(`Model load failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    };
    const runSimulation = async () => {
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
    const runPhasePlane = async () => {
        await withBusy(async () => {
            const worker = workerRef.current;
            if (!worker) {
                return;
            }
            const info = await ensureModelLoaded();
            if (!info) {
                return;
            }
            let request = {
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
                setStatus(diag
                    ? `Phase-plane produced 0 vectors: ${diag.message}`
                    : "Phase-plane produced 0 vectors. Check xVar/yVar and vector-field ranges.");
            }
            else {
                const nonFiniteDiag = result.diagnostics.find((d) => d.code === "PHASE_NONFINITE_VALUES_SANITIZED" || d.code === "PHASE_NONFINITE_DERIVATIVES");
                if (nonFiniteDiag) {
                    setStatus(`Phase-plane complete (${result.vectorField.length} vector samples) with warnings: ${nonFiniteDiag.message} ` +
                        "Try narrowing x/y ranges or adjusting fixed state/parameter values.");
                }
                else {
                    setStatus(`Phase-plane complete (${result.vectorField.length} vector samples).`);
                }
            }
            setTab("phase");
        });
    };
    const addPhaseTrajectoryAt = async (xSeed, ySeed) => {
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
            let request = { ...phaseRequest, parameterOverrides };
            const resolved = resolvePhaseVars(info.variables, request.xVar, request.yVar);
            const xVar = resolved.xVar;
            const yVar = resolved.yVar;
            request = { ...request, xVar, yVar };
            setPhaseRequest((prev) => ({ ...prev, xVar, yVar }));
            if (resolved.error) {
                setStatus(resolved.error);
                return;
            }
            const seededRequest = {
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
            const newTrajectory = seeded.trajectory;
            const nextCount = phaseTrajectories.length + 1;
            setPhaseTrajectories((prev) => {
                return [...prev, newTrajectory];
            });
            setStatus(`Added trajectory ${nextCount} from seed (${xSeed.toFixed(3)}, ${ySeed.toFixed(3)}).`);
        });
    };
    const clearPhaseTrajectories = () => {
        const hadAny = phaseTrajectories.length > 0 ||
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
    const runBifurcation = async (options) => {
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
            let runRequest = {
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
                const retryRequest = {
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
                const keyDiag = result.diagnostics.find((d) => d.code === "NO_BIF_POINTS" || d.code === "NO_FINITE_BIF_POINTS" || d.code === "ONE_PARAM_SAMPLES_WITHOUT_EQ");
                const fallbackDiag = result.diagnostics.find((d) => d.code === "ENGINE_FALLBACK_ACTIVE");
                setStatus((keyDiag
                    ? `Bifurcation produced no plottable points: ${keyDiag.code}. Open the plot panel for detailed diagnostics.`
                    : "Bifurcation produced no plottable points. Open the plot panel for detailed diagnostics.") +
                    (fallbackDiag ? " Runtime is in fallback mode; results are approximate and can differ from XPPAUT/AUTO." : "") +
                    autoRetryNote);
            }
            else {
                const branchCount = new Set(result.points.map((p) => p.branch)).size;
                const unstableCount = result.points.filter((p) => p.stable === false).length;
                const hbCount = result.points.filter((p) => normalizeBifType(p.type).startsWith("HB")).length;
                const lpCount = result.points.filter((p) => normalizeBifType(p.type).startsWith("LP")).length;
                const fallbackDiag = result.diagnostics.find((d) => d.code === "ENGINE_FALLBACK_ACTIVE");
                const sparseDiag = result.diagnostics.find((d) => d.code === "SPARSE_BIFURCATION_OUTPUT");
                setStatus(`Bifurcation complete (${result.points.length} points, ${branchCount} branches, ${unstableCount} unstable points, HB=${hbCount}, LP=${lpCount}).` +
                    (sparseDiag ? ` ${sparseDiag.message}` : "") +
                    (fallbackDiag ? " Runtime is in fallback mode; results are approximate and can differ from XPPAUT/AUTO." : "") +
                    autoRetryNote);
            }
            setTab("bifurcation");
        });
    };
    const generateFiCurve = async () => {
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
                setStatus(`F/I curve generated from XPPAUT periodic branch data (${fiFromBif.length} points, non-zero=${nonZeroCount}, parameter=${primaryParameter}).`);
                setTab("bifurcation");
                return;
            }
            const skippedBifReason = fiFromBif.length >= 4
                ? "Periodic branch data looked flat; using simulation sweep for F/I."
                : null;
            const voltageLike = info.variables.filter((name) => {
                const normalized = name.trim().toLowerCase();
                return normalized === "v" || normalized === "vm" || normalized === "u" || normalized.includes("volt");
            });
            const fiCandidates = dedupeCaseInsensitive([
                yVariable,
                ...voltageLike,
                info.variables[0] ?? ""
            ]);
            const stateVariables = dedupeCaseInsensitive(info.variables);
            const requestedSeries = dedupeCaseInsensitive([...stateVariables, ...fiCandidates]);
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
            let fiRangeNote = null;
            if (bifAxisAuto && isCurrentLikeParameter(primaryParameter)) {
                const center = typeof primaryValue === "number" && Number.isFinite(primaryValue)
                    ? primaryValue
                    : (effectiveControls.rl0 + effectiveControls.rl1) / 2;
                const minPreferred = center - 1;
                const maxPreferred = center + 4;
                const width = effectiveControls.rl1 - effectiveControls.rl0;
                if (width < 4.5) {
                    fiSweepControls = {
                        ...effectiveControls,
                        rl0: Math.min(effectiveControls.rl0, minPreferred),
                        rl1: Math.max(effectiveControls.rl1, maxPreferred)
                    };
                    fiRangeNote = `Using expanded ${primaryParameter} sweep [${fiSweepControls.rl0.toFixed(3)}, ${fiSweepControls.rl1.toFixed(3)}] for F/I onset detection.`;
                }
            }
            const sampleCount = Math.max(12, Math.min(80, Math.round((bifRequest.controls.npr || 30) * Math.max(1, bifRequest.controls.pointDensity ?? 1))));
            const fiDurations = [...new Set([
                    Math.max(simRequest.tEnd, 900),
                    Math.max(simRequest.tEnd * 2, 2500),
                    Math.max(simRequest.tEnd * 4, 5000)
                ])].sort((a, b) => a - b);
            const sampledPoints = [];
            const signalUsage = new Map();
            let rollingInitialConditions = { ...simRequest.initialConditions };
            for (let i = 0; i < sampleCount; i += 1) {
                const frac = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
                const parameterValue = fiSweepControls.rl0 + frac * (fiSweepControls.rl1 - fiSweepControls.rl0);
                let best = { rate: Number.NEGATIVE_INFINITY, signal: fiCandidates[0] ?? yVariable };
                let chosenSim = null;
                for (let durationIndex = 0; durationIndex < fiDurations.length; durationIndex += 1) {
                    const duration = fiDurations[durationIndex] ?? fiDurations[fiDurations.length - 1] ?? Math.max(simRequest.tEnd, 900);
                    const sim = await worker.runSimulation({
                        ...simRequest,
                        tEnd: duration,
                        parameterOverrides: {
                            ...parameterOverrides,
                            [primaryParameter]: parameterValue
                        },
                        initialConditions: rollingInitialConditions,
                        requestedSeries
                    });
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
                if (!chosenSim) {
                    continue;
                }
                if (!Number.isFinite(best.rate)) {
                    best = { rate: 0, signal: best.signal || yVariable };
                }
                for (const stateName of stateVariables) {
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
                setStatus("F/I generation returned no finite points. Try a different parameter range or simulation settings.");
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
                setFiPoints([]);
                setShowFiCurve(false);
                setStatus(`F/I sweep found no spikes in this range (${finitePoints.length} samples, parameter=${primaryParameter}).` +
                    " Try increasing drive/bias, widening the parameter window, and using tEnd >= 2500." +
                    (fiRangeNote ? ` ${fiRangeNote}` : ""));
            }
            else {
                setFiPoints(finitePoints);
                setShowFiCurve(true);
                setStatus(`F/I curve generated (${finitePoints.length} points, non-zero=${nonZeroCount}, dominant signal=${dominantSignal}, parameter=${primaryParameter}).` +
                    (skippedBifReason ? ` ${skippedBifReason}` : "") +
                    (fiRangeNote ? ` ${fiRangeNote}` : ""));
            }
            setTab("bifurcation");
        });
    };
    const getSvgById = (id) => {
        const element = document.getElementById(id);
        if (!element || !(element instanceof SVGSVGElement)) {
            return null;
        }
        return element;
    };
    const exportSvg = (id, fileName) => {
        const svg = getSvgById(id);
        if (!svg) {
            setStatus(`Plot ${id} is not available yet.`);
            return;
        }
        const text = new XMLSerializer().serializeToString(svg);
        downloadBlob(fileName, new Blob([text], { type: "image/svg+xml" }));
    };
    const exportPng = (id, fileName) => {
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
    const handleFileUpload = (event) => {
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
    const loadSelectedCommonModel = () => {
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
            }
            else {
                setStatus(`Loaded ${selectedCommonModel.label} (${info.parameters.length} parameters).`);
            }
        });
    };
    const exportModelCsv = () => {
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
    const exportBundle = async () => {
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
    const setSharedParameter = (name, rawValue) => {
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
    const normalizeSharedParameterInput = (name) => {
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
    const resetSharedParameters = () => {
        setParameterOverrides({});
        setParameterDrafts({});
        setStatus("Shared parameter overrides reset to model defaults.");
    };
    const renderSharedParameterPanel = () => (_jsxs("article", { className: "panel panelFull", children: [_jsx("h2", { children: "Shared Parameters" }), _jsx("p", { className: "hint", children: "Applies to simulation, phase plane, and bifurcation runs." }), parameterNames.length === 0 ? (_jsx("div", { className: "panelEmpty", children: "Load a model to edit parameter values." })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "parameterGrid", children: parameterNames.map((name) => {
                            const currentValue = parameterOverrides[name] ?? parameterValues[name] ?? 0;
                            const defaultValue = parameterValues[name];
                            const isOverride = Object.prototype.hasOwnProperty.call(parameterOverrides, name);
                            const displayValue = Object.prototype.hasOwnProperty.call(parameterDrafts, name)
                                ? parameterDrafts[name] ?? ""
                                : String(currentValue);
                            return (_jsxs("label", { className: "parameterField", children: [_jsxs("span", { children: [name, isOverride ? " (override)" : ""] }), _jsx("input", { type: "text", inputMode: "decimal", value: displayValue, onChange: (event) => setSharedParameter(name, event.target.value), onBlur: () => normalizeSharedParameterInput(name) }), typeof defaultValue === "number" ? _jsxs("small", { children: ["Default: ", defaultValue] }) : null] }, `param-${name}`));
                        }) }), _jsx("div", { className: "buttonRow", children: _jsx("button", { className: "btnMuted", onClick: resetSharedParameters, disabled: !hasParameterOverrides, children: "Reset to Defaults" }) })] }))] }));
    return (_jsxs("main", { className: "appRoot", children: [_jsxs("section", { className: "toolbar", children: [_jsx("div", { className: "toolbarLabel", children: "Project File" }), _jsx("p", { className: "toolbarHint", children: "Pick a common Neurobook model or upload a `.ode`, then run and export from the active tab." }), _jsxs("div", { className: "toolbarRow", children: [_jsxs("label", { className: "toolbarField", children: ["Common model (Neurobook)", _jsxs("select", { value: selectedCommonModelId, onChange: (event) => setSelectedCommonModelId(event.target.value), children: [_jsx("option", { value: "", children: "Select common model..." }), COMMON_MODEL_OPTIONS.map((model) => (_jsx("option", { value: model.id, children: model.label }, model.id)))] })] }), _jsx("button", { className: "btnMuted", disabled: busy || !selectedCommonModel, onClick: loadSelectedCommonModel, children: "Load Selected Model" }), _jsxs("label", { className: "fileButton fileButtonAlt", children: ["Upload .ode", _jsx("input", { type: "file", accept: ".ode,text/plain", onChange: handleFileUpload })] })] })] }), _jsxs("section", { className: "statusBar", children: [_jsx("span", { className: `statusBadge ${busy ? "statusBusy" : "statusReady"}`, children: busy ? "Working" : "Ready" }), _jsx("span", { className: "statusText", children: status }), engineFallbackReason ? (_jsx("button", { className: "statusInfoButton", type: "button", "aria-label": "Show fallback runtime details", title: "Why this is using fallback runtime", onClick: () => setShowEngineInfo((prev) => !prev), children: "i" })) : null] }), showEngineInfo && engineFallbackReason ? (_jsxs("section", { className: "statusInfoPanel", children: [_jsx("strong", { children: "Fallback Runtime Details" }), _jsx("p", { children: engineFallbackReason }), _jsxs("ul", { className: "statusInfoList", children: [_jsxs("li", { children: ["Build the XPPAUT WASM core: ", _jsx("code", { children: "npm run wasm:build" }), "."] }), _jsx("li", { children: "Restart the web dev server after building." }), _jsxs("li", { children: ["Hard refresh the page (", _jsx("code", { children: "Cmd+Shift+R" }), ") to reload worker assets."] }), _jsxs("li", { children: ["Confirm these files exist: ", _jsx("code", { children: "apps/web/public/wasm/xppcore.js" }), " and ", _jsx("code", { children: "xppcore.wasm" }), "."] })] })] })) : null, _jsxs("nav", { className: "tabs", "aria-label": "analysis tabs", children: [_jsx("button", { className: `tabButton ${tab === "model" ? "tabActive" : ""}`, onClick: () => setTab("model"), children: "Model" }), _jsx("button", { className: `tabButton ${tab === "phase" ? "tabActive" : ""}`, onClick: () => setTab("phase"), children: "Phase Plane" }), _jsx("button", { className: `tabButton ${tab === "bifurcation" ? "tabActive" : ""}`, onClick: () => setTab("bifurcation"), children: "Bifurcation" })] }), tab === "model" ? (_jsxs("section", { className: "panelGrid", children: [_jsxs("article", { className: "panel panelTall", children: [_jsx("h2", { children: "Model" }), _jsx("input", { value: modelName, onChange: (e) => setModelName(e.target.value), placeholder: "Model filename" }), _jsx("textarea", { value: modelText, onChange: (e) => setModelText(e.target.value), spellCheck: false })] }), _jsxs("article", { className: "panel panelWide", children: [_jsx("h2", { children: "Simulation" }), _jsxs("div", { className: "gridTwo", children: [_jsxs("label", { children: ["tEnd", _jsx(NumericInput, { value: simRequest.tEnd, onCommit: (next) => setSimRequest((prev) => ({ ...prev, tEnd: clamp(next, 1, 50000) })) })] }), _jsxs("label", { children: ["dt", _jsx(NumericInput, { value: simRequest.dt, onCommit: (next) => setSimRequest((prev) => ({ ...prev, dt: clamp(next, 0.0001, 100) })) })] })] }), _jsx("p", { className: "hint", children: "Shortcut: Ctrl+Enter runs simulation." }), _jsxs("div", { className: "buttonRow", children: [_jsx("button", { className: "btnPrimary", disabled: busy, onClick: () => void runSimulation(), children: "Run Simulation" }), _jsx("button", { className: "btnMuted", disabled: busy, onClick: () => void loadModel(), children: "Load Model" }), _jsx("button", { className: "btnMuted", onClick: () => {
                                            if (!simulation) {
                                                setStatus("Run simulation before exporting CSV.");
                                                return;
                                            }
                                            downloadBlob("simulation.csv", new Blob([simulationCsv(simulation)], { type: "text/csv;charset=utf-8" }));
                                        }, children: "Export Simulation CSV" }), _jsx("button", { className: "btnMuted", onClick: () => exportSvg("simulation-plot", "simulation.svg"), children: "Export Simulation SVG" }), _jsx("button", { className: "btnMuted", onClick: () => exportPng("simulation-plot", "simulation.png"), children: "Export Simulation PNG" }), _jsx("button", { className: "btnMuted", onClick: exportModelCsv, children: "Export Model CSV" }), _jsx("button", { className: "btnGhost", onClick: () => void exportBundle(), children: "Export Project Bundle" })] }), _jsx(SimulationPlot, { data: simulation, svgId: "simulation-plot" }), _jsxs("details", { className: "simpleDetails", children: [_jsx("summary", { children: "Model details and diagnostics" }), modelInfo ? (_jsxs(_Fragment, { children: [_jsxs("p", { children: ["Variables: ", _jsx("strong", { children: modelInfo.variables.join(", ") || "none" })] }), _jsxs("p", { children: ["Parameters: ", _jsx("strong", { children: modelInfo.parameters.join(", ") || "none" })] }), _jsxs("p", { children: ["Auxiliaries: ", _jsx("strong", { children: modelInfo.auxiliaries.join(", ") || "none" })] }), _jsx("ul", { className: "diagnosticList", children: modelInfo.diagnostics.map((d, idx) => (_jsxs("li", { children: ["[", d.tier, "] ", d.code, ": ", d.message, d.line ? ` (line ${d.line})` : ""] }, `diag-${idx}`))) })] })) : (_jsx("p", { children: "Load model to inspect parser diagnostics and compatibility tiers." }))] })] }), renderSharedParameterPanel()] })) : null, tab === "phase" ? (_jsxs("section", { className: "panelGrid", children: [_jsxs("article", { className: "panel panelWide", children: [_jsx("h2", { children: "Phase Plane" }), _jsx(PhasePlot, { data: phasePlane, svgId: "phase-plot", xLabel: phaseRequest.xVar, yLabel: phaseRequest.yVar, extraTrajectories: phaseTrajectories, onAddTrajectorySeed: (x, y) => {
                                    void addPhaseTrajectoryAt(x, y);
                                } })] }), _jsxs("article", { className: "panel", children: [_jsx("h2", { children: "Phase Controls" }), _jsxs("div", { className: "gridTwo", children: [_jsxs("label", { children: ["xVar", _jsxs("select", { value: phaseRequest.xVar, onChange: (e) => setPhaseRequest((prev) => ({ ...prev, xVar: e.target.value })), disabled: variableNames.length === 0, children: [!variableNames.includes(phaseRequest.xVar) && phaseRequest.xVar ? (_jsxs("option", { value: phaseRequest.xVar, children: [phaseRequest.xVar, " (current)"] })) : null, variableNames.length === 0 ? _jsx("option", { value: phaseRequest.xVar, children: "Load model first" }) : null, variableNames.map((name) => (_jsx("option", { value: name, children: name }, `phase-x-${name}`)))] })] }), _jsxs("label", { children: ["yVar", _jsxs("select", { value: phaseRequest.yVar, onChange: (e) => setPhaseRequest((prev) => ({ ...prev, yVar: e.target.value })), disabled: variableNames.length === 0, children: [!variableNames.includes(phaseRequest.yVar) && phaseRequest.yVar ? (_jsxs("option", { value: phaseRequest.yVar, children: [phaseRequest.yVar, " (current)"] })) : null, variableNames.length === 0 ? _jsx("option", { value: phaseRequest.yVar, children: "Load model first" }) : null, variableNames.map((name) => (_jsx("option", { value: name, children: name }, `phase-y-${name}`)))] })] }), _jsxs("label", { children: ["xMin", _jsx(NumericInput, { value: phaseRequest.vectorField.xMin, onCommit: (next) => setPhaseRequest((prev) => ({
                                                    ...prev,
                                                    vectorField: { ...prev.vectorField, xMin: next }
                                                })) })] }), _jsxs("label", { children: ["xMax", _jsx(NumericInput, { value: phaseRequest.vectorField.xMax, onCommit: (next) => setPhaseRequest((prev) => ({
                                                    ...prev,
                                                    vectorField: { ...prev.vectorField, xMax: next }
                                                })) })] })] }), _jsx("p", { className: "hint", children: "Shortcut: Ctrl+Shift+P runs phase-plane." }), _jsx("p", { className: "hint", children: "Tip: click the phase-plane plot to add a trajectory seeded at that point." }), _jsxs("div", { className: "buttonRow", children: [_jsx("button", { className: "btnPrimary", disabled: busy, onClick: () => void runPhasePlane(), children: "Run Phase Plane" }), _jsx("button", { className: "btnMuted", disabled: busy || (phaseTrajectories.length === 0 && !phasePlane?.trajectory), onClick: clearPhaseTrajectories, children: "Clear Trajectories" }), _jsx("button", { className: "btnMuted", onClick: () => {
                                            if (!phasePlane) {
                                                setStatus("Run phase-plane before exporting CSV.");
                                                return;
                                            }
                                            downloadBlob("phase_plane.csv", new Blob([phasePlaneCsv(phasePlane)], { type: "text/csv;charset=utf-8" }));
                                        }, children: "Export Phase Plane CSV" }), _jsx("button", { className: "btnMuted", onClick: () => exportSvg("phase-plot", "phase_plane.svg"), children: "Export Phase Plane SVG" }), _jsx("button", { className: "btnMuted", onClick: () => exportPng("phase-plot", "phase_plane.png"), children: "Export Phase Plane PNG" })] }), _jsxs("details", { className: "simpleDetails", children: [_jsx("summary", { children: "Advanced grid settings" }), _jsxs("div", { className: "gridTwo", children: [_jsxs("label", { children: ["yMin", _jsx(NumericInput, { value: phaseRequest.vectorField.yMin, onCommit: (next) => setPhaseRequest((prev) => ({
                                                            ...prev,
                                                            vectorField: { ...prev.vectorField, yMin: next }
                                                        })) })] }), _jsxs("label", { children: ["yMax", _jsx(NumericInput, { value: phaseRequest.vectorField.yMax, onCommit: (next) => setPhaseRequest((prev) => ({
                                                            ...prev,
                                                            vectorField: { ...prev.vectorField, yMax: next }
                                                        })) })] })] })] })] }), renderSharedParameterPanel()] })) : null, tab === "bifurcation" ? (_jsxs("section", { className: "panelGrid", children: [_jsxs("article", { className: "panel panelWide", children: [_jsx("h2", { children: "Bifurcation Branches" }), _jsx(BifurcationPlot, { data: bifurcation, request: bifRequest, modelInfo: modelInfo, axisBounds: activeBifAxisBounds, axisMode: bifAxisAuto ? "auto" : "manual", selectedLabel: selectedBifLabel, fiPoints: fiPoints, showFiCurve: showFiCurve, onSelect: setSelectedBifLabel, svgId: "bifurcation-plot" }), selectedBifPoint ? (_jsxs("div", { className: "inspector", children: [_jsx("strong", { children: "Point Inspector" }), _jsxs("div", { children: ["Label: ", selectedBifPoint.label] }), _jsxs("div", { children: ["Type: ", selectedBifPoint.type] }), _jsxs("div", { children: ["Stable: ", selectedBifPoint.stable === undefined ? "unknown" : selectedBifPoint.stable ? "yes" : "no"] }), _jsxs("div", { children: ["Branch: ", selectedBifPoint.branch] }), typeof selectedBifPoint.ntot === "number" ? _jsxs("div", { children: ["ntot: ", selectedBifPoint.ntot] }) : null, typeof selectedBifPoint.itp === "number" ? _jsxs("div", { children: ["itp: ", selectedBifPoint.itp] }) : null, typeof selectedBifPoint.period === "number" && Number.isFinite(selectedBifPoint.period) ? (_jsxs("div", { children: ["Period: ", selectedBifPoint.period.toFixed(6)] })) : null, _jsxs("div", { children: ["x: ", selectedBifPoint.x.toFixed(6)] }), _jsxs("div", { children: ["y: ", selectedBifPoint.y.toFixed(6)] }), _jsx("button", { className: "btnGhost", onClick: () => {
                                            void runBifurcation({ continueLabel: selectedBifPoint.label });
                                        }, children: "Continue from label" })] })) : (_jsx("div", { className: "inspector", children: "Select a labeled point to inspect and continue." })), labeledBifPoints.length > 0 ? (_jsxs("details", { className: "simpleDetails", children: [_jsxs("summary", { children: ["Labeled points (", labeledBifPoints.length, ")"] }), _jsx("div", { className: "pointList", children: labeledBifPoints.map((point) => (_jsxs("button", { className: point.label === selectedBifLabel ? "btnGhost pointButtonActive" : "btnMuted", onClick: () => setSelectedBifLabel(point.label), children: ["#", point.label, " ", point.type, " (", point.x.toFixed(4), ", ", point.y.toFixed(4), ")"] }, `pick-${point.index}-${point.label}`))) })] })) : null] }), _jsxs("article", { className: "panel", children: [_jsx("h2", { children: "Bifurcation Controls" }), _jsxs("div", { className: "gridTwo", children: [_jsxs("label", { children: ["Mode", _jsxs("select", { value: bifRequest.mode, onChange: (e) => setBifRequest((prev) => ({
                                                    ...prev,
                                                    mode: e.target.value
                                                })), children: [_jsx("option", { value: "one_param", children: "one_param" }), _jsx("option", { value: "two_param", children: "two_param" })] })] }), _jsxs("label", { children: ["Primary Parameter", _jsxs("select", { value: bifRequest.primaryParameter, onChange: (e) => setBifRequest((prev) => ({ ...prev, primaryParameter: e.target.value })), disabled: parameterNames.length === 0, children: [!parameterNames.includes(bifRequest.primaryParameter) && bifRequest.primaryParameter ? (_jsxs("option", { value: bifRequest.primaryParameter, children: [bifRequest.primaryParameter, " (current)"] })) : null, parameterNames.length === 0 ? _jsx("option", { value: bifRequest.primaryParameter, children: "Load model first" }) : null, parameterNames.map((name) => (_jsx("option", { value: name, children: name }, `primary-${name}`)))] })] }), _jsxs("label", { children: ["Secondary Parameter", _jsxs("select", { value: bifRequest.secondaryParameter ?? "", onChange: (e) => setBifRequest((prev) => ({ ...prev, secondaryParameter: e.target.value || undefined })), children: [_jsx("option", { value: "", children: "(none)" }), !bifRequest.secondaryParameter || parameterNames.includes(bifRequest.secondaryParameter)
                                                        ? null
                                                        : _jsxs("option", { value: bifRequest.secondaryParameter, children: [bifRequest.secondaryParameter, " (current)"] }), parameterNames
                                                        .filter((name) => name !== bifRequest.primaryParameter)
                                                        .map((name) => (_jsx("option", { value: name, children: name }, `secondary-${name}`)))] })] }), _jsxs("label", { children: ["yVariable", _jsxs("select", { value: bifRequest.yVariable ?? "", onChange: (e) => setBifRequest((prev) => ({ ...prev, yVariable: e.target.value || undefined })), children: [_jsx("option", { value: "", children: "(auto)" }), !bifRequest.yVariable || variableNames.includes(bifRequest.yVariable)
                                                        ? null
                                                        : _jsxs("option", { value: bifRequest.yVariable, children: [bifRequest.yVariable, " (current)"] }), variableNames.map((name) => (_jsx("option", { value: name, children: name }, `yvar-${name}`)))] })] }), _jsxs("label", { children: ["Point Density", _jsxs("select", { value: String(bifRequest.controls.pointDensity ?? 1), onChange: (e) => {
                                                    const pointDensity = Math.min(8, Math.max(1, Math.round(Number(e.target.value) || 1)));
                                                    setBifRequest((prev) => ({
                                                        ...prev,
                                                        controls: {
                                                            ...prev.controls,
                                                            pointDensity
                                                        }
                                                    }));
                                                }, children: [_jsx("option", { value: "1", children: "Standard (1x)" }), _jsx("option", { value: "2", children: "High (2x)" }), _jsx("option", { value: "4", children: "Very High (4x)" })] })] })] }), _jsx("p", { className: "hint", children: "Increase point density if HB/LP/P points are missed. Higher values run slower." }), _jsxs("details", { className: "simpleDetails", children: [_jsx("summary", { children: "Axis scaling" }), _jsxs("div", { className: "axisControls", children: [_jsxs("label", { className: "inlineCheck", children: [_jsx("input", { type: "checkbox", checked: bifAxisAuto, onChange: (e) => setBifAxisAuto(e.target.checked) }), "Auto-fit axes after run"] }), _jsxs("p", { className: "axisSummary", children: ["Mode: ", bifAxisAuto ? "Auto (manual values ignored)" : "Manual (using values below)"] }), !bifAxisAuto ? _jsx("p", { className: "axisSummary", children: "Manual x-bounds are used as the continuation window." }) : null, _jsxs("div", { className: "gridTwo", children: [_jsxs("label", { children: ["xMin", _jsx(NumericInput, { value: bifAxisManual.xMin, disabled: bifAxisAuto, onCommit: (next) => setManualBifAxis("xMin", next) })] }), _jsxs("label", { children: ["xMax", _jsx(NumericInput, { value: bifAxisManual.xMax, disabled: bifAxisAuto, onCommit: (next) => setManualBifAxis("xMax", next) })] }), _jsxs("label", { children: ["yMin", _jsx(NumericInput, { value: bifAxisManual.yMin, disabled: bifAxisAuto, onCommit: (next) => setManualBifAxis("yMin", next) })] }), _jsxs("label", { children: ["yMax", _jsx(NumericInput, { value: bifAxisManual.yMax, disabled: bifAxisAuto, onCommit: (next) => setManualBifAxis("yMax", next) })] })] }), bifAxisFitted ? (_jsxs("p", { className: "axisSummary", children: ["Auto-fit bounds: x[", bifAxisFitted.xMin.toFixed(3), ", ", bifAxisFitted.xMax.toFixed(3), "], y[", bifAxisFitted.yMin.toFixed(3), ", ", bifAxisFitted.yMax.toFixed(3), "]"] })) : (_jsx("p", { className: "axisSummary", children: "Run bifurcation to compute automatic axis bounds." }))] })] }), _jsx("p", { className: "hint", children: "Shortcut: Ctrl+Shift+B runs bifurcation." }), _jsxs("div", { className: "buttonRow", children: [_jsx("button", { className: "btnPrimary", disabled: busy, onClick: () => void runBifurcation(), children: "Run Bifurcation" }), _jsx("button", { className: "btnMuted", disabled: busy, onClick: () => void generateFiCurve(), children: "Generate F/I Curve" }), _jsx("button", { className: "btnMuted", disabled: busy || fiPoints.length === 0, onClick: () => {
                                            setFiPoints([]);
                                            setShowFiCurve(false);
                                            setStatus("Cleared F/I curve overlay.");
                                        }, children: "Clear F/I Curve" }), _jsx("button", { className: "btnMuted", onClick: () => {
                                            if (!bifurcation) {
                                                setStatus("Run bifurcation before exporting CSV.");
                                                return;
                                            }
                                            downloadBlob("bifurcation.csv", new Blob([bifurcationCsv(bifurcation)], { type: "text/csv;charset=utf-8" }));
                                        }, children: "Export Bifurcation CSV" }), _jsx("button", { className: "btnMuted", onClick: () => exportSvg("bifurcation-plot", "bifurcation.svg"), children: "Export Bifurcation SVG" }), _jsx("button", { className: "btnMuted", onClick: () => exportPng("bifurcation-plot", "bifurcation.png"), children: "Export Bifurcation PNG" })] }), _jsxs("label", { className: "inlineCheck", children: [_jsx("input", { type: "checkbox", checked: showFiCurve, disabled: fiPoints.length === 0, onChange: (event) => setShowFiCurve(event.target.checked) }), "Show F/I overlay (green circles)"] }), _jsx("p", { className: "hint", children: "F/I y-values are firing rates in inverse model time units (1/time)." }), _jsxs("div", { className: "legend", children: [_jsxs("span", { className: "legendItem", children: [_jsx("i", { className: "dot lp" }), " LP"] }), _jsxs("span", { className: "legendItem", children: [_jsx("i", { className: "dot hb" }), " HB"] }), _jsxs("span", { className: "legendItem", children: [_jsx("i", { className: "dot bif" }), " Stability Transition"] }), _jsxs("span", { className: "legendItem", children: [_jsx("i", { className: "dot ep" }), " Stable EP"] }), _jsxs("span", { className: "legendItem", children: [_jsx("i", { className: "dot un" }), " Unstable EP"] }), _jsxs("span", { className: "legendItem", children: [_jsx("i", { className: "dot fi" }), " F/I"] })] }), _jsxs("p", { className: "hint", children: ["Detected points: HB=", hbPointCount, ", LP=", lpPointCount, ", total labeled=", labeledBifPoints.length, ".", hbPointCount === 0 ? " No HB detected in current sweep." : "", fiPointCount > 0 ? ` F/I points=${fiPointCount}.` : ""] })] }), renderSharedParameterPanel()] })) : null] }));
}
