import {
  BifurcationRequestSchema,
  type BifurcationResult,
  type Diagnostic,
  type ModelInfo,
  PhasePlaneRequestSchema,
  type PhasePlaneResult,
  SimulationRequestSchema,
  type SimulationResult
} from "@xpp/core-api";
import { all, create, type EvalFunction } from "mathjs";

const math = create(all as never, {});
const MAX_FALLBACK_SIM_STEPS = 60_000;

type NumericDict = Record<string, number>;
type ExpressionDict = Record<string, string>;

interface ParsedFunction {
  name: string;
  args: string[];
  expression: string;
  compiled: EvalFunction;
}

interface ParsedModel {
  fileName: string;
  source: string;
  variables: string[];
  equations: string[];
  equationCompiled: EvalFunction[];
  parameters: NumericDict;
  initialConditions: NumericDict;
  auxiliaries: string[];
  auxExpressions: string[];
  auxCompiled: EvalFunction[];
  derivedNames: string[];
  derivedExpressions: string[];
  derivedCompiled: EvalFunction[];
  userFunctions: ParsedFunction[];
  sets: string[];
  options: NumericDict;
  diagnostics: Diagnostic[];
}

function normalizeExpr(expr: string): string {
  const trimmed = expr.trim();
  return trimmed
    .replace(/\bln\s*\(/gi, "log(")
    .replace(/\bheav\s*\(/gi, "heav(")
    .replace(/\bsign\s*\(/gi, "sign(")
    .replace(/\bmod\s*\(/gi, "mod(");
}

function splitAssignments(input: string): string[] {
  return input
    .split(",")
    .flatMap((token) => token.split(/\s+/))
    .map((token) => token.trim())
    .filter(Boolean);
}

function evaluateAssignmentExpression(expression: string, scope: NumericDict): number | undefined {
  try {
    const evaluated = math.evaluate(normalizeExpr(expression), scope);
    const value = typeof evaluated === "number" ? evaluated : Number(evaluated);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseLineAssignments(input: string, scope: NumericDict = {}): { values: NumericDict; unresolved: ExpressionDict } {
  const values: NumericDict = {};
  const unresolved: ExpressionDict = {};
  for (const token of splitAssignments(input)) {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
    if (!match) {
      const bare = token.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      const key = bare?.[1];
      if (key && !Object.prototype.hasOwnProperty.call(values, key)) {
        values[key] = 0;
      }
      continue;
    }
    const key = match[1];
    const rawValue = match[2];
    if (!key || !rawValue) {
      continue;
    }
    const numericValue = Number(rawValue);
    if (!Number.isNaN(numericValue)) {
      values[key] = numericValue;
      continue;
    }

    const evaluated = evaluateAssignmentExpression(rawValue, { ...scope, ...values });
    if (typeof evaluated === "number") {
      values[key] = evaluated;
      continue;
    }

    unresolved[key] = normalizeExpr(rawValue);
  }
  return { values, unresolved };
}

function resolveDeferredAssignments(
  target: NumericDict,
  deferred: ExpressionDict,
  baseScope: NumericDict,
  diagnostics: Diagnostic[],
  code: string
): void {
  const pending: ExpressionDict = { ...deferred };
  const maxPasses = Math.max(4, Object.keys(pending).length * 4);
  let changed = true;
  let pass = 0;

  while (changed && pass < maxPasses && Object.keys(pending).length > 0) {
    changed = false;
    pass += 1;
    for (const [key, expression] of Object.entries(pending)) {
      const evaluated = evaluateAssignmentExpression(expression, { ...baseScope, ...target });
      if (typeof evaluated === "number") {
        target[key] = evaluated;
        delete pending[key];
        changed = true;
      }
    }
  }

  for (const [key, expression] of Object.entries(pending)) {
    // Keep fallback stable even when expression resolution fails.
    target[key] = 0;
    diagnostics.push(
      makeDiagnostic(code, `Could not resolve assignment ${key}=${expression}; defaulted to 0`, undefined, "warning")
    );
  }
}

function symbolVariants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) {
    return [];
  }
  const lower = trimmed.toLowerCase();
  const upper = trimmed.toUpperCase();
  const title = lower.slice(0, 1).toUpperCase() + lower.slice(1);
  return [...new Set([trimmed, lower, upper, title])];
}

function setScopeAliases(scope: Record<string, unknown>, name: string, value: unknown): void {
  for (const variant of symbolVariants(name)) {
    scope[variant] = value;
  }
}

function getSymbolValue(source: NumericDict, name: string): number | undefined {
  for (const variant of symbolVariants(name)) {
    const value = source[variant];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function resolveSymbolKey(source: NumericDict, name: string): string | undefined {
  for (const variant of symbolVariants(name)) {
    if (Object.prototype.hasOwnProperty.call(source, variant)) {
      return variant;
    }
  }
  return undefined;
}

function findVariableIndex(variables: string[], name: string): number {
  if (!name) {
    return -1;
  }
  const target = name.trim().toLowerCase();
  return variables.findIndex((value) => value.toLowerCase() === target);
}

function makeDiagnostic(
  code: string,
  message: string,
  line?: number,
  tier: Diagnostic["tier"] = "warning"
): Diagnostic {
  return {
    code,
    message,
    line,
    tier
  };
}

function linearInterpolateZero(a: number, b: number): number {
  const denom = b - a;
  if (Math.abs(denom) < 1e-12) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, -a / denom));
}

function normalizePointDensity(raw: number | undefined): number {
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.min(8, Math.max(1, Math.round(raw ?? 1)));
}

function scaledSampleCount(base: number, min: number, max: number, density: number): number {
  const target = Math.round(base * density);
  return Math.min(max, Math.max(min, target));
}

function buildStateValues(variables: string[], state: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < variables.length; i += 1) {
    const name = variables[i];
    const value = state[i] ?? Number.NaN;
    if (!name || !Number.isFinite(value)) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

function vtrap(x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return 0;
  }
  if (Math.abs(y) < 1e-12) {
    return x;
  }
  const z = x / y;
  if (Math.abs(z) < 1e-6) {
    return y * (1 - z / 2);
  }
  const denom = Math.expm1(z);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) {
    return y;
  }
  return x / denom;
}

function marchingSquares(
  field: number[][],
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
): Array<Array<[number, number]>> {
  const rows = field.length;
  const cols = field[0]?.length ?? 0;
  if (rows < 2 || cols < 2) {
    return [];
  }

  const polylines: Array<Array<[number, number]>> = [];
  const xStep = (xMax - xMin) / (cols - 1);
  const yStep = (yMax - yMin) / (rows - 1);

  const addSegment = (x1: number, y1: number, x2: number, y2: number): void => {
    polylines.push([
      [x1, y1],
      [x2, y2]
    ]);
  };

  for (let j = 0; j < rows - 1; j += 1) {
    for (let i = 0; i < cols - 1; i += 1) {
      const f00 = field[j]?.[i] ?? 0;
      const f10 = field[j]?.[i + 1] ?? 0;
      const f11 = field[j + 1]?.[i + 1] ?? 0;
      const f01 = field[j + 1]?.[i] ?? 0;

      const x0 = xMin + i * xStep;
      const x1 = x0 + xStep;
      const y0 = yMin + j * yStep;
      const y1 = y0 + yStep;

      const idx =
        (f00 >= 0 ? 1 : 0) |
        (f10 >= 0 ? 2 : 0) |
        (f11 >= 0 ? 4 : 0) |
        (f01 >= 0 ? 8 : 0);

      if (idx === 0 || idx === 15) {
        continue;
      }

      const leftY = y0 + linearInterpolateZero(f00, f01) * yStep;
      const rightY = y0 + linearInterpolateZero(f10, f11) * yStep;
      const bottomX = x0 + linearInterpolateZero(f00, f10) * xStep;
      const topX = x0 + linearInterpolateZero(f01, f11) * xStep;

      switch (idx) {
        case 1:
        case 14:
          addSegment(x0, leftY, bottomX, y0);
          break;
        case 2:
        case 13:
          addSegment(bottomX, y0, x1, rightY);
          break;
        case 3:
        case 12:
          addSegment(x0, leftY, x1, rightY);
          break;
        case 4:
        case 11:
          addSegment(x1, rightY, topX, y1);
          break;
        case 5:
          addSegment(x0, leftY, topX, y1);
          addSegment(bottomX, y0, x1, rightY);
          break;
        case 6:
        case 9:
          addSegment(bottomX, y0, topX, y1);
          break;
        case 7:
        case 8:
          addSegment(x0, leftY, topX, y1);
          break;
        case 10:
          addSegment(x0, leftY, bottomX, y0);
          addSegment(x1, rightY, topX, y1);
          break;
        default:
          break;
      }
    }
  }

  return polylines;
}

function maxRealEigenApprox(jacobian: number[][]): number {
  const n = jacobian.length;
  if (n === 0) {
    return 0;
  }
  if (n === 1) {
    return jacobian[0]?.[0] ?? 0;
  }
  if (n === 2) {
    const spectral = planarSpectralInfo(jacobian);
    if (!spectral) {
      return 0;
    }
    const { trace: tr, discriminant: disc } = spectral;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      return Math.max((tr + root) / 2, (tr - root) / 2);
    }
    return tr / 2;
  }

  // Prefer true eigenvalues for higher-dimensional systems when available.
  // Gershgorin bounds are very conservative and can falsely classify stable
  // equilibria as unstable, which suppresses HB/LP detection.
  try {
    const eigResult = (math.eigs as unknown as (matrix: number[][]) => { values?: unknown[] } | unknown[])(jacobian);
    const values = Array.isArray(eigResult)
      ? eigResult
      : (Array.isArray((eigResult as { values?: unknown[] } | null)?.values) ? (eigResult as { values: unknown[] }).values : []);
    if (values.length > 0) {
      let maxReal = Number.NEGATIVE_INFINITY;
      for (const value of values) {
        let real = Number.NaN;
        if (typeof value === "number") {
          real = value;
        } else if (value && typeof value === "object" && "re" in value) {
          real = Number((value as { re?: unknown }).re);
        } else {
          real = Number(value);
        }
        if (Number.isFinite(real)) {
          maxReal = Math.max(maxReal, real);
        }
      }
      if (Number.isFinite(maxReal)) {
        return maxReal;
      }
    }
  } catch {
    // Fall through to Gershgorin bound below.
  }

  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const row = jacobian[i] ?? [];
    const center = row[i] ?? 0;
    const radius = row.reduce((sum, value, idx) => sum + (idx === i ? 0 : Math.abs(value)), 0);
    max = Math.max(max, center + radius);
  }
  return max;
}

function planarSpectralInfo(jacobian: number[][]): { trace: number; determinant: number; discriminant: number } | null {
  if (jacobian.length !== 2) {
    return null;
  }
  const a = jacobian[0]?.[0] ?? 0;
  const b = jacobian[0]?.[1] ?? 0;
  const c = jacobian[1]?.[0] ?? 0;
  const d = jacobian[1]?.[1] ?? 0;
  const trace = a + d;
  const determinant = a * d - b * c;
  const discriminant = trace * trace - 4 * determinant;
  return { trace, determinant, discriminant };
}

export class FallbackXppEngine {
  private model: ParsedModel | null = null;

  public async boot(): Promise<void> {
    return;
  }

  public async free(): Promise<void> {
    this.model = null;
  }

  public async loadModel(odeText: string, fileName: string): Promise<ModelInfo> {
    this.model = this.parseModel(odeText, fileName);
    return this.getModelInfo();
  }

  public async getModelInfo(): Promise<ModelInfo> {
    if (!this.model) {
      return {
        variables: [],
        parameters: [],
        parameterValues: {},
        auxiliaries: [],
        sets: [],
        diagnostics: [makeDiagnostic("MODEL_NOT_LOADED", "Load a .ode model before running analysis", undefined, "unsupported")]
      };
    }
    return {
      variables: [...this.model.variables],
      parameters: Object.keys(this.model.parameters),
      parameterValues: { ...this.model.parameters },
      auxiliaries: [...this.model.auxiliaries],
      sets: [...this.model.sets],
      diagnostics: [...this.model.diagnostics]
    };
  }

  public async runSimulation(rawRequest: unknown): Promise<SimulationResult> {
    const request = SimulationRequestSchema.parse(rawRequest);
    const model = this.requireModel();
    const span = Math.max(0, request.tEnd - request.t0);
    const requestedDt = request.dt;
    const minDtForBudget = span > 0 ? span / MAX_FALLBACK_SIM_STEPS : requestedDt;
    const effectiveDt = Math.max(requestedDt, minDtForBudget);
    const budgetApplied = Number.isFinite(effectiveDt) && Number.isFinite(requestedDt) && effectiveDt > requestedDt * (1 + 1e-12);
    const runRequest = budgetApplied
      ? {
          ...request,
          dt: effectiveDt
        }
      : request;
    const { time, stateSeries, auxSeries, truncated } = this.simulateModel(model, runRequest, MAX_FALLBACK_SIM_STEPS);
    const diagnostics = [...model.diagnostics];
    if (budgetApplied) {
      diagnostics.push(
        makeDiagnostic(
          "SIM_STEP_BUDGET_APPLIED",
          `Fallback simulation step budget applied: dt increased from ${requestedDt} to ${effectiveDt.toFixed(8)} to keep runtime bounded`,
          undefined,
          "warning"
        )
      );
    }
    if (truncated) {
      diagnostics.push(
        makeDiagnostic(
          "SIM_STEP_BUDGET_TRUNCATED",
          `Fallback simulation hit step budget (${MAX_FALLBACK_SIM_STEPS} steps) and returned partial trajectory`,
          undefined,
          "warning"
        )
      );
    }

    const series: Record<string, number[]> = {};
    for (const [name, values] of Object.entries(stateSeries)) {
      series[name] = values;
    }
    for (const [name, values] of Object.entries(auxSeries)) {
      series[name] = values;
    }

    if (request.requestedSeries.length > 0) {
      const filtered: Record<string, number[]> = {};
      for (const key of request.requestedSeries) {
        filtered[key] = series[key] ?? [];
      }
      return {
        time,
        series: filtered,
        diagnostics
      };
    }

    return {
      time,
      series,
      diagnostics
    };
  }

  public async runPhasePlane(rawRequest: unknown): Promise<PhasePlaneResult> {
    const request = PhasePlaneRequestSchema.parse(rawRequest);
    const model = this.requireModel();
    const params = { ...model.parameters, ...request.parameterOverrides };

    const xIndex = findVariableIndex(model.variables, request.xVar);
    const yIndex = findVariableIndex(model.variables, request.yVar);
    if (xIndex < 0 || yIndex < 0) {
      return {
        vectorField: [],
        nullclines: { xNullcline: [], yNullcline: [] },
        diagnostics: [
          ...model.diagnostics,
          makeDiagnostic("PHASE_VARS_NOT_FOUND", `Variables ${request.xVar} and/or ${request.yVar} are not model state variables`, undefined, "unsupported")
        ]
      };
    }
    const xName = model.variables[xIndex] ?? request.xVar;
    const yName = model.variables[yIndex] ?? request.yVar;

    const baselineState = this.makeInitialState(model, request.fixedState);

    const vf = request.vectorField;
    const vectorField: Array<{ x: number; y: number; dx: number; dy: number }> = [];
    let nonFiniteVectorDerivatives = 0;
    let nonFiniteNullclineSamples = 0;

    const nx = request.nullclineGrid.xSteps;
    const ny = request.nullclineGrid.ySteps;
    const fieldX: number[][] = Array.from({ length: ny }, () => Array.from({ length: nx }, () => 0));
    const fieldY: number[][] = Array.from({ length: ny }, () => Array.from({ length: nx }, () => 0));

    for (let j = 0; j < vf.ySteps; j += 1) {
      const y = vf.yMin + (j / Math.max(1, vf.ySteps - 1)) * (vf.yMax - vf.yMin);
      for (let i = 0; i < vf.xSteps; i += 1) {
        const x = vf.xMin + (i / Math.max(1, vf.xSteps - 1)) * (vf.xMax - vf.xMin);
        const state = [...baselineState];
        state[xIndex] = x;
        state[yIndex] = y;
        const deriv = this.computeDerivatives(model, 0, state, params);
        const rawDx = deriv[xIndex] ?? 0;
        const rawDy = deriv[yIndex] ?? 0;
        const dx = Number.isFinite(rawDx) ? rawDx : 0;
        const dy = Number.isFinite(rawDy) ? rawDy : 0;
        if (!Number.isFinite(rawDx)) {
          nonFiniteVectorDerivatives += 1;
        }
        if (!Number.isFinite(rawDy)) {
          nonFiniteVectorDerivatives += 1;
        }
        vectorField.push({ x, y, dx, dy });
      }
    }

    for (let j = 0; j < ny; j += 1) {
      const y = vf.yMin + (j / Math.max(1, ny - 1)) * (vf.yMax - vf.yMin);
      for (let i = 0; i < nx; i += 1) {
        const x = vf.xMin + (i / Math.max(1, nx - 1)) * (vf.xMax - vf.xMin);
        const state = [...baselineState];
        state[xIndex] = x;
        state[yIndex] = y;
        const deriv = this.computeDerivatives(model, 0, state, params);
        const rawDx = deriv[xIndex] ?? 0;
        const rawDy = deriv[yIndex] ?? 0;
        fieldX[j]![i] = Number.isFinite(rawDx) ? rawDx : 0;
        fieldY[j]![i] = Number.isFinite(rawDy) ? rawDy : 0;
        if (!Number.isFinite(rawDx)) {
          nonFiniteNullclineSamples += 1;
        }
        if (!Number.isFinite(rawDy)) {
          nonFiniteNullclineSamples += 1;
        }
      }
    }

    const xNullcline = marchingSquares(fieldX, vf.xMin, vf.xMax, vf.yMin, vf.yMax);
    const yNullcline = marchingSquares(fieldY, vf.xMin, vf.xMax, vf.yMin, vf.yMax);

    let trajectory: PhasePlaneResult["trajectory"];
    if (request.trajectory.enabled) {
      const sim = this.simulateModel(model, {
        integrator: "rk4",
        t0: 0,
        tEnd: request.trajectory.tEnd,
        dt: request.trajectory.dt,
        transient: 0,
        outputStride: 1,
        initialConditions: request.fixedState,
        parameterOverrides: request.parameterOverrides,
        requestedSeries: []
      });
      trajectory = {
        time: sim.time,
        x: sim.stateSeries[xName] ?? [],
        y: sim.stateSeries[yName] ?? []
      };
    }

    const diagnostics = [...model.diagnostics];
    if (nonFiniteVectorDerivatives > 0 || nonFiniteNullclineSamples > 0) {
      diagnostics.push(
        makeDiagnostic(
          "PHASE_NONFINITE_DERIVATIVES",
          `Encountered non-finite phase-plane derivatives (vector=${nonFiniteVectorDerivatives}, nullcline=${nonFiniteNullclineSamples}); values were clamped to 0`,
          undefined,
          "warning"
        )
      );
    }

    return {
      vectorField,
      nullclines: {
        xNullcline,
        yNullcline
      },
      trajectory,
      diagnostics
    };
  }

  public async runBifurcation(rawRequest: unknown): Promise<BifurcationResult> {
    const request = BifurcationRequestSchema.parse(rawRequest);
    const model = this.requireModel();
    const baseParams = { ...model.parameters, ...request.parameterOverrides };
    const primaryParameter = resolveSymbolKey(model.parameters, request.primaryParameter);

    if (!primaryParameter) {
      return {
        mode: request.mode,
        points: [],
        diagnostics: [
          ...model.diagnostics,
          makeDiagnostic("PRIMARY_PARAMETER_NOT_FOUND", `Parameter ${request.primaryParameter} was not found`, undefined, "unsupported")
        ]
      };
    }

    const yVarIndex = request.yVariable ? findVariableIndex(model.variables, request.yVariable) : -1;
    const yIndex = yVarIndex >= 0 ? yVarIndex : 0;

    if (request.mode === "one_param") {
      return this.runOneParameterBifurcation(model, baseParams, { ...request, primaryParameter }, yIndex);
    }

    const secondaryParameter = request.secondaryParameter ? resolveSymbolKey(model.parameters, request.secondaryParameter) : undefined;
    if (!secondaryParameter) {
      return {
        mode: request.mode,
        points: [],
        diagnostics: [
          ...model.diagnostics,
          makeDiagnostic(
            "SECONDARY_PARAMETER_NOT_FOUND",
            `Secondary parameter ${request.secondaryParameter ?? "<missing>"} was not found`,
            undefined,
            "unsupported"
          )
        ]
      };
    }

    const p2 = secondaryParameter;
    const pointDensity = normalizePointDensity(request.controls.pointDensity);
    const steps = Math.min(Math.max(12, Math.floor(Math.sqrt(request.controls.nmx * pointDensity))), 70);
    const stableGrid: boolean[][] = Array.from({ length: steps }, () => Array.from({ length: steps }, () => false));

    for (let j = 0; j < steps; j += 1) {
      const fy = j / Math.max(1, steps - 1);
      const py = request.controls.a0 + fy * (request.controls.a1 - request.controls.a0);
      for (let i = 0; i < steps; i += 1) {
        const fx = i / Math.max(1, steps - 1);
        const px = request.controls.rl0 + fx * (request.controls.rl1 - request.controls.rl0);
        const params = {
          ...baseParams,
          [request.primaryParameter]: px,
          [p2]: py
        };
        const state = this.integrateToAttractor(model, params);
        const jac = this.jacobian(model, state, params);
        stableGrid[j]![i] = maxRealEigenApprox(jac) < 0;
      }
    }

    const points: BifurcationResult["points"] = [];
    let label = 1;
    for (let j = 0; j < steps - 1; j += 1) {
      for (let i = 0; i < steps - 1; i += 1) {
        const s00 = stableGrid[j]?.[i] ?? false;
        const s10 = stableGrid[j]?.[i + 1] ?? false;
        const s11 = stableGrid[j + 1]?.[i + 1] ?? false;
        const s01 = stableGrid[j + 1]?.[i] ?? false;

        const flips = Number(s00 !== s10) + Number(s10 !== s11) + Number(s11 !== s01) + Number(s01 !== s00);
        if (flips === 0) {
          continue;
        }

        const fx = (i + 0.5) / Math.max(1, steps - 1);
        const fy = (j + 0.5) / Math.max(1, steps - 1);
        const px = request.controls.rl0 + fx * (request.controls.rl1 - request.controls.rl0);
        const py = request.controls.a0 + fy * (request.controls.a1 - request.controls.a0);

        points.push({
          index: points.length,
          label: label++,
          type: "HB2",
          branch: 1,
          x: px,
          y: py,
          secondaryY: py,
          parameters: {
            [request.primaryParameter]: px,
            [p2]: py
          }
        });
      }
    }

    if (points.length === 0) {
      for (let i = 0; i < steps; i += 1) {
        const frac = i / Math.max(1, steps - 1);
        const px = request.controls.rl0 + frac * (request.controls.rl1 - request.controls.rl0);
        const py = request.controls.a0 + frac * (request.controls.a1 - request.controls.a0);
        points.push({
          index: points.length,
          label: label++,
          type: "APX2",
          branch: 1,
          x: px,
          y: py,
          secondaryY: py,
          parameters: {
            [request.primaryParameter]: px,
            [p2]: py
          }
        });
      }
    }

    return this.finalizeBifurcationResult(request.mode, points, [
      ...model.diagnostics,
      makeDiagnostic(
        "POINT_DENSITY_APPLIED",
        `Point density ${pointDensity}x applied to two-parameter boundary tracing (${steps} x ${steps} grid)`,
        undefined,
        "warning"
      ),
      makeDiagnostic(
        "TWO_PARAM_APPROX",
        "Two-parameter continuation is approximated in fallback mode using stability-boundary tracing",
        undefined,
        "warning"
      )
    ]);
  }

  private requireModel(): ParsedModel {
    if (!this.model) {
      throw new Error("No model loaded");
    }
    return this.model;
  }

  private parseModel(source: string, fileName: string): ParsedModel {
    const variables: string[] = [];
    const equations: string[] = [];
    const equationCompiled: EvalFunction[] = [];
    const parameters: NumericDict = {};
    const initialConditions: NumericDict = {};
    const auxiliaries: string[] = [];
    const auxExpressions: string[] = [];
    const auxCompiled: EvalFunction[] = [];
    const derivedNames: string[] = [];
    const derivedExpressions: string[] = [];
    const derivedCompiled: EvalFunction[] = [];
    const userFunctions: ParsedFunction[] = [];
    const sets: string[] = [];
    const options: NumericDict = {};
    const diagnostics: Diagnostic[] = [];
    const deferredParameterExpressions: ExpressionDict = {};
    const deferredInitialExpressions: ExpressionDict = {};

    const lines = source.split(/\r?\n/);

    for (let idx = 0; idx < lines.length; idx += 1) {
      const lineNumber = idx + 1;
      const raw = lines[idx] ?? "";
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("\"")) {
        continue;
      }

      if (/^done\b/i.test(line)) {
        break;
      }

      if (/^#include\b/i.test(line)) {
        diagnostics.push(
          makeDiagnostic(
            "INCLUDE_UNSUPPORTED",
            "#include is a Tier 2 feature and requires native XPPAUT WASM mode",
            lineNumber,
            "unsupported"
          )
        );
        continue;
      }

      if (/^(global|markov|table|special|wiener)\b/i.test(line)) {
        diagnostics.push(
          makeDiagnostic(
            "TIER2_FEATURE",
            `Feature '${line.split(/\s+/)[0] ?? "unknown"}' is Tier 2 and not executed in fallback mode`,
            lineNumber,
            "unsupported"
          )
        );
        continue;
      }

      if (/^@/.test(line)) {
        const parsed = parseLineAssignments(line.slice(1), { ...parameters, ...options });
        Object.assign(options, parsed.values);
        continue;
      }

      if (/^!/.test(line)) {
        const parsed = parseLineAssignments(line.slice(1), parameters);
        Object.assign(parameters, parsed.values);
        Object.assign(deferredParameterExpressions, parsed.unresolved);
        continue;
      }

      if (/^set\s+/i.test(line)) {
        const match = line.match(/^set\s+([A-Za-z_][A-Za-z0-9_]*)/i);
        if (match?.[1]) {
          sets.push(match[1]);
        }
        continue;
      }

      if (/^par(?:ams?)?(?:\d+(?:-\d+)?)?\s+/i.test(line)) {
        const parsed = parseLineAssignments(line.replace(/^par(?:ams?)?(?:\d+(?:-\d+)?)?\s+/i, ""), parameters);
        Object.assign(parameters, parsed.values);
        Object.assign(deferredParameterExpressions, parsed.unresolved);
        continue;
      }

      if (/^p\s+/i.test(line)) {
        const parsed = parseLineAssignments(line.replace(/^p\s+/i, ""), parameters);
        Object.assign(parameters, parsed.values);
        Object.assign(deferredParameterExpressions, parsed.unresolved);
        continue;
      }

      if (/^num\s+/i.test(line)) {
        const parsed = parseLineAssignments(line.replace(/^num\s+/i, ""), parameters);
        Object.assign(parameters, parsed.values);
        Object.assign(deferredParameterExpressions, parsed.unresolved);
        continue;
      }

      if (/^number\s+/i.test(line)) {
        const parsed = parseLineAssignments(line.replace(/^number\s+/i, ""), parameters);
        Object.assign(parameters, parsed.values);
        Object.assign(deferredParameterExpressions, parsed.unresolved);
        continue;
      }

      if (/^init\s+/i.test(line)) {
        const parsed = parseLineAssignments(line.replace(/^init\s+/i, ""), { ...parameters, ...initialConditions });
        Object.assign(initialConditions, parsed.values);
        Object.assign(deferredInitialExpressions, parsed.unresolved);
        continue;
      }

      const initAtZeroMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*0\s*\)\s*=\s*(.+)$/);
      if (initAtZeroMatch?.[1] && initAtZeroMatch[2]) {
        const value = Number(initAtZeroMatch[2]);
        if (Number.isFinite(value)) {
          initialConditions[initAtZeroMatch[1]] = value;
        } else {
          diagnostics.push(makeDiagnostic("INIT_PARSE_ERROR", `Could not parse initial condition line: ${line}`, lineNumber, "warning"));
        }
        continue;
      }

      if (/^aux\s+/i.test(line)) {
        const match = line.match(/^aux\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i);
        if (!match?.[1] || !match[2]) {
          diagnostics.push(makeDiagnostic("AUX_PARSE_ERROR", `Could not parse auxiliary line: ${line}`, lineNumber, "warning"));
          continue;
        }
        auxiliaries.push(match[1]);
        auxExpressions.push(normalizeExpr(match[2]));
        continue;
      }

      const fnMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s*=\s*(.+)$/);
      if (fnMatch?.[1] && fnMatch[3]) {
        const name = fnMatch[1];
        const args = (fnMatch[2] ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        const expression = normalizeExpr(fnMatch[3]);
        const compiled = math.compile(expression);
        userFunctions.push({
          name,
          args,
          expression,
          compiled
        });
        continue;
      }

      const odeMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)'\s*=\s*(.+)$/);
      if (odeMatch?.[1] && odeMatch[2]) {
        variables.push(odeMatch[1]);
        equations.push(normalizeExpr(odeMatch[2]));
        continue;
      }

      const odeDtMatch = line.match(/^d([A-Za-z_][A-Za-z0-9_]*)\s*\/\s*dt\s*=\s*(.+)$/i);
      if (odeDtMatch?.[1] && odeDtMatch[2]) {
        variables.push(odeDtMatch[1]);
        equations.push(normalizeExpr(odeDtMatch[2]));
        continue;
      }

      const derivedMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (derivedMatch?.[1] && derivedMatch[2]) {
        derivedNames.push(derivedMatch[1]);
        derivedExpressions.push(normalizeExpr(derivedMatch[2]));
        continue;
      }

      diagnostics.push(makeDiagnostic("UNHANDLED_LINE", `Unhandled line in fallback parser: ${line}`, lineNumber, "warning"));
    }

    for (const expr of equations) {
      equationCompiled.push(math.compile(expr));
    }
    for (const expr of auxExpressions) {
      auxCompiled.push(math.compile(expr));
    }
    for (const expr of derivedExpressions) {
      derivedCompiled.push(math.compile(expr));
    }

    resolveDeferredAssignments(
      parameters,
      deferredParameterExpressions,
      parameters,
      diagnostics,
      "PARAM_ASSIGNMENT_UNRESOLVED"
    );
    resolveDeferredAssignments(
      initialConditions,
      deferredInitialExpressions,
      { ...parameters, ...initialConditions },
      diagnostics,
      "INIT_ASSIGNMENT_UNRESOLVED"
    );

    if (variables.length === 0) {
      diagnostics.push(makeDiagnostic("NO_ODES", "No ODE state equations were found in the model", undefined, "unsupported"));
    }

    return {
      fileName,
      source,
      variables,
      equations,
      equationCompiled,
      parameters,
      initialConditions,
      auxiliaries,
      auxExpressions,
      auxCompiled,
      derivedNames,
      derivedExpressions,
      derivedCompiled,
      userFunctions,
      sets,
      options,
      diagnostics
    };
  }

  private buildScope(model: ParsedModel, t: number, state: number[], params: NumericDict): Record<string, unknown> {
    const scope: Record<string, unknown> = {
      heav: (x: number): number => (x >= 0 ? 1 : 0),
      sign: (x: number): number => (x === 0 ? 0 : x > 0 ? 1 : -1),
      vtrap
    };
    setScopeAliases(scope, "t", t);
    setScopeAliases(scope, "pi", Math.PI);
    setScopeAliases(scope, "e", Math.E);

    for (const [name, value] of Object.entries(params)) {
      setScopeAliases(scope, name, value);
    }

    for (let i = 0; i < model.variables.length; i += 1) {
      const name = model.variables[i];
      if (name) {
        setScopeAliases(scope, name, state[i] ?? 0);
      }
    }

    for (const fn of model.userFunctions) {
      const evaluator = (...args: number[]): number => {
        const localScope: Record<string, unknown> = { ...scope };
        for (let i = 0; i < fn.args.length; i += 1) {
          const argName = fn.args[i] ?? `arg${i + 1}`;
          setScopeAliases(localScope, argName, args[i] ?? 0);
        }
        const result = fn.compiled.evaluate(localScope);
        return typeof result === "number" ? result : Number(result);
      };
      setScopeAliases(scope, fn.name, evaluator);
    }

    // Derived scalar assignments (e.g. ica=...) become named symbols in scope.
    for (let i = 0; i < model.derivedNames.length; i += 1) {
      const name = model.derivedNames[i];
      const compiled = model.derivedCompiled[i];
      if (!name || !compiled) {
        continue;
      }
      const result = compiled.evaluate(scope);
      setScopeAliases(scope, name, typeof result === "number" ? result : Number(result));
    }

    return scope;
  }

  private makeInitialState(model: ParsedModel, initOverrides: NumericDict): number[] {
    const state: number[] = [];
    for (const name of model.variables) {
      const v = getSymbolValue(initOverrides, name) ?? getSymbolValue(model.initialConditions, name) ?? 0;
      state.push(v);
    }

    return state;
  }

  private computeDerivatives(model: ParsedModel, t: number, state: number[], params: NumericDict): number[] {
    const scope = this.buildScope(model, t, state, params);
    const derivatives: number[] = [];
    for (const compiled of model.equationCompiled) {
      const value = compiled.evaluate(scope);
      derivatives.push(typeof value === "number" ? value : Number(value));
    }
    return derivatives;
  }

  private computeAux(model: ParsedModel, t: number, state: number[], params: NumericDict): NumericDict {
    const scope = this.buildScope(model, t, state, params);
    const out: NumericDict = {};
    for (let i = 0; i < model.auxiliaries.length; i += 1) {
      const name = model.auxiliaries[i];
      const compiled = model.auxCompiled[i];
      if (!name || !compiled) {
        continue;
      }
      const value = compiled.evaluate(scope);
      out[name] = typeof value === "number" ? value : Number(value);
    }
    return out;
  }

  private rk4Step(model: ParsedModel, t: number, dt: number, state: number[], params: NumericDict): number[] {
    const k1 = this.computeDerivatives(model, t, state, params);
    const s2 = state.map((v, i) => v + 0.5 * dt * (k1[i] ?? 0));
    const k2 = this.computeDerivatives(model, t + 0.5 * dt, s2, params);
    const s3 = state.map((v, i) => v + 0.5 * dt * (k2[i] ?? 0));
    const k3 = this.computeDerivatives(model, t + 0.5 * dt, s3, params);
    const s4 = state.map((v, i) => v + dt * (k3[i] ?? 0));
    const k4 = this.computeDerivatives(model, t + dt, s4, params);

    return state.map((v, i) => v + (dt / 6) * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + (k4[i] ?? 0)));
  }

  private eulerStep(model: ParsedModel, t: number, dt: number, state: number[], params: NumericDict): number[] {
    const deriv = this.computeDerivatives(model, t, state, params);
    return state.map((v, i) => v + dt * (deriv[i] ?? 0));
  }

  private simulateModel(
    model: ParsedModel,
    request: {
      integrator: "discrete" | "euler" | "modified_euler" | "rk4" | "adams" | "gear" | "cvode";
      t0: number;
      tEnd: number;
      dt: number;
      transient: number;
      outputStride: number;
      parameterOverrides: NumericDict;
      initialConditions: NumericDict;
      requestedSeries: string[];
    },
    maxSteps = Number.POSITIVE_INFINITY
  ): {
    time: number[];
    stateSeries: Record<string, number[]>;
    auxSeries: Record<string, number[]>;
    truncated: boolean;
  } {
    const params = { ...model.parameters, ...request.parameterOverrides };
    let state = this.makeInitialState(model, request.initialConditions);
    const dt = Number.isFinite(request.dt) && request.dt > 0 ? request.dt : 0.05;

    const time: number[] = [];
    const stateSeries: Record<string, number[]> = {};
    const auxSeries: Record<string, number[]> = {};

    for (const v of model.variables) {
      stateSeries[v] = [];
    }
    for (const a of model.auxiliaries) {
      auxSeries[a] = [];
    }

    let t = request.t0;
    let step = 0;
    while (t <= request.tEnd + dt * 0.5 && step < maxSteps) {
      if (t >= request.transient && step % request.outputStride === 0) {
        time.push(t);
        model.variables.forEach((name, idx) => {
          stateSeries[name]?.push(state[idx] ?? 0);
        });
        const aux = this.computeAux(model, t, state, params);
        for (const [key, value] of Object.entries(aux)) {
          auxSeries[key]?.push(value);
        }
      }

      if (request.integrator === "euler" || request.integrator === "discrete") {
        state = this.eulerStep(model, t, dt, state, params);
      } else {
        state = this.rk4Step(model, t, dt, state, params);
      }

      t += dt;
      step += 1;
    }
    const truncated = step >= maxSteps && t <= request.tEnd + dt * 0.5;

    return { time, stateSeries, auxSeries, truncated };
  }

  private integrateToAttractor(model: ParsedModel, params: NumericDict): number[] {
    const sim = this.simulateModel(model, {
      integrator: "rk4",
      t0: 0,
      tEnd: Math.max(50, model.options.TOTAL ?? model.options.total ?? 200),
      dt: model.options.DT ?? model.options.dt ?? 0.05,
      transient: 0,
      outputStride: 1,
      parameterOverrides: params,
      initialConditions: {},
      requestedSeries: []
    });

    const state: number[] = [];
    for (const name of model.variables) {
      const arr = sim.stateSeries[name] ?? [];
      let lastFinite: number | undefined;
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        const value = arr[i];
        if (typeof value === "number" && Number.isFinite(value)) {
          lastFinite = value;
          break;
        }
      }
      state.push(lastFinite ?? getSymbolValue(model.initialConditions, name) ?? 0);
    }
    return state;
  }

  private jacobian(model: ParsedModel, state: number[], params: NumericDict): number[][] {
    const n = model.variables.length;
    const base = this.computeDerivatives(model, 0, state, params);
    const jac: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
    const eps = 1e-6;

    for (let j = 0; j < n; j += 1) {
      const h = eps * (1 + Math.abs(state[j] ?? 0));
      const plus = [...state];
      const minus = [...state];
      plus[j] = (plus[j] ?? 0) + h;
      minus[j] = (minus[j] ?? 0) - h;

      const fPlus = this.computeDerivatives(model, 0, plus, params);
      const fMinus = this.computeDerivatives(model, 0, minus, params);

      for (let i = 0; i < n; i += 1) {
        jac[i]![j] = ((fPlus[i] ?? base[i] ?? 0) - (fMinus[i] ?? base[i] ?? 0)) / (2 * h);
      }
    }

    return jac;
  }

  private runOneParameterBifurcation(
    model: ParsedModel,
    baseParams: NumericDict,
    request: {
      primaryParameter: string;
      controls: {
        nmx: number;
        pointDensity?: number;
        rl0: number;
        rl1: number;
        a0: number;
        a1: number;
      };
    },
    yIndex: number
  ): BifurcationResult {
    // In 1D, compute all equilibria via root finding over x for each parameter sample.
    // This captures unstable branches that attractor-following misses.
    if (model.variables.length === 1 && yIndex >= 0) {
      const stateName = model.variables[0] ?? "x";
      const init = model.initialConditions[stateName] ?? 0;
      const searchPad = Math.max(2, Math.abs(init) + 1);
      const aLo = Math.min(request.controls.a0, request.controls.a1);
      const aHi = Math.max(request.controls.a0, request.controls.a1);
      const xMin = Math.min(aLo, init - searchPad) - 0.5;
      const xMax = Math.max(aHi, init + searchPad) + 0.5;
      const span = Math.max(1e-6, xMax - xMin);
      const matchTol = Math.max(0.04, 0.03 * span);
      const pointDensity = normalizePointDensity(request.controls.pointDensity);

      const samples = scaledSampleCount(request.controls.nmx, 80, 2400, pointDensity);
      const rootGridBins = scaledSampleCount(320, 320, 1600, pointDensity);
      const points: BifurcationResult["points"] = [];
      let label = 1;
      let nextBranch = 1;
      let activeBranches = new Map<number, number>();
      let samplesWithoutRoots = 0;

      for (let i = 0; i < samples; i += 1) {
        const frac = i / Math.max(1, samples - 1);
        const p = request.controls.rl0 + frac * (request.controls.rl1 - request.controls.rl0);
        const roots = this.findOneDimEquilibria(model, baseParams, request.primaryParameter, p, xMin, xMax, rootGridBins);
        if (roots.length === 0) {
          samplesWithoutRoots += 1;
        }

        const newActive = new Map<number, number>();
        const usedBranches = new Set<number>();
        for (const root of roots) {
          let chosenBranch: number | null = null;
          let chosenDist = Number.POSITIVE_INFINITY;
          for (const [branchId, lastY] of activeBranches.entries()) {
            if (usedBranches.has(branchId)) {
              continue;
            }
            const dist = Math.abs(root.y - lastY);
            if (dist < chosenDist && dist <= matchTol) {
              chosenDist = dist;
              chosenBranch = branchId;
            }
          }

          if (chosenBranch === null) {
            chosenBranch = nextBranch++;
          }

          usedBranches.add(chosenBranch);
          newActive.set(chosenBranch, root.y);
          points.push({
            index: points.length,
            label: root.type === "LP" ? label++ : 0,
            type: root.type,
            branch: chosenBranch,
            stable: root.stable,
            x: p,
            y: root.y,
            parameters: { [request.primaryParameter]: p },
            stateValues: buildStateValues(model.variables, [root.y])
          });
        }

        activeBranches = newActive;
      }

      const transitionAugmented = this.addStabilityTransitionPoints(points);
      const diagnostics: Diagnostic[] = [
        ...model.diagnostics,
        makeDiagnostic(
          "POINT_DENSITY_APPLIED",
          `Point density ${pointDensity}x applied (${samples} continuation samples, ${rootGridBins} root bins)`,
          undefined,
          "warning"
        ),
        makeDiagnostic(
          "ONE_PARAM_1D_CONTINUATION",
          "Computed one-parameter diagram using 1D equilibrium root-finding continuation",
          undefined,
          "warning"
        )
      ];
      if (transitionAugmented.added > 0) {
        diagnostics.push(
          makeDiagnostic(
            "STABILITY_TRANSITION_POINTS",
            `Added ${transitionAugmented.added} synthetic bifurcation point(s) at stability transitions`,
            undefined,
            "warning"
          )
        );
      }
      if (samplesWithoutRoots > 0) {
        diagnostics.push(
          makeDiagnostic(
            "ONE_PARAM_SAMPLES_WITHOUT_EQ",
            `No equilibria were found for ${samplesWithoutRoots}/${samples} continuation samples in parameter range [${request.controls.rl0}, ${request.controls.rl1}]`,
            undefined,
            "warning"
          )
        );
      }

      return this.finalizeBifurcationResult("one_param", transitionAugmented.points, [
        ...diagnostics
      ]);
    }

    // Generic multi-dimensional fallback: compute equilibria via multi-start Newton.
    const points: BifurcationResult["points"] = [];
    const pointDensity = normalizePointDensity(request.controls.pointDensity);
    const samples = scaledSampleCount(request.controls.nmx, 40, 1800, pointDensity);
    let nextBranch = 1;
    let label = 1;
    const n = model.variables.length;
    const baseSeed = this.makeInitialState(model, {});
    const trackedIndex = Math.max(0, yIndex);
    const trackedName = model.variables[trackedIndex] ?? "y";
    const trackedBase = baseSeed[trackedIndex] ?? 0;
    let seedMin = Math.min(request.controls.a0, request.controls.a1);
    let seedMax = Math.max(request.controls.a0, request.controls.a1);
    let seedRangeExpanded = false;
    if (!Number.isFinite(seedMin) || !Number.isFinite(seedMax)) {
      const pad = Math.max(15, Math.abs(trackedBase) * 0.5);
      seedMin = trackedBase - pad;
      seedMax = trackedBase + pad;
      seedRangeExpanded = true;
    } else {
      const tooNarrow = Math.abs(seedMax - seedMin) < 1e-9;
      const missesBase = trackedBase < seedMin - 2 || trackedBase > seedMax + 2;
      if (tooNarrow || missesBase) {
        const pad = Math.max(15, Math.abs(trackedBase) * 0.5);
        seedMin = Math.min(seedMin, trackedBase - pad);
        seedMax = Math.max(seedMax, trackedBase + pad);
        seedRangeExpanded = true;
      }
    }
    const latticeCount = Math.max(9, Math.min(33, Math.round(Math.sqrt(samples))));
    const zeroSeed = Array.from({ length: n }, () => 0);
    const seedTemplates: number[][] = [];
    for (let k = 0; k < latticeCount; k += 1) {
      const frac = k / Math.max(1, latticeCount - 1);
      const trackedValue = seedMin + frac * (seedMax - seedMin);
      const fromBase = [...baseSeed];
      fromBase[trackedIndex] = trackedValue;
      seedTemplates.push(fromBase);

      const fromZero = [...zeroSeed];
      fromZero[trackedIndex] = trackedValue;
      seedTemplates.push(fromZero);
    }
    let activeBranches = new Map<number, {
      state: number[];
      y: number;
      stable: boolean;
      slope: number | null;
      eig: number | null;
      param: number;
      trace: number | null;
      determinant: number | null;
      discriminant: number | null;
    }>();
    const syntheticSpecialPoints: BifurcationResult["points"] = [];
    let samplesWithoutEffective = 0;
    let samplesUsingAttractorFallback = 0;
    let samplesWithRejectedAttractorFallback = 0;
    let transitionRefinedCount = 0;
    let transitionRefinedHbCount = 0;
    let transitionRefinedLpCount = 0;

    for (let i = 0; i < samples; i += 1) {
      const frac = i / Math.max(1, samples - 1);
      const p = request.controls.rl0 + frac * (request.controls.rl1 - request.controls.rl0);
      const params = { ...baseParams, [request.primaryParameter]: p };
      const carrySeeds = [...activeBranches.values()].map((branch) => branch.state);
      const useLatticeSeeds = i === 0 || activeBranches.size <= 2 || i % 8 === 0;
      const seeds: number[][] = useLatticeSeeds
        ? [...carrySeeds, ...seedTemplates, [...baseSeed], [...zeroSeed]]
        : [[...baseSeed], ...carrySeeds, [...zeroSeed]];

      const equilibria = this.findEquilibriaMultiStart(model, params, seeds, Math.max(0, yIndex));
      let effective = equilibria;
      if (effective.length === 0) {
        samplesUsingAttractorFallback += 1;
        const state = this.integrateToAttractor(model, params);
        if (state.every((value) => Number.isFinite(value))) {
          const jac = this.jacobian(model, state, params);
          const y = state[Math.max(0, yIndex)] ?? 0;
          if (Number.isFinite(y)) {
            const eig = maxRealEigenApprox(jac);
            const planar = planarSpectralInfo(jac);
            effective = [{
              state,
              y,
              stable: Number.isFinite(eig) ? eig < 0 : false,
              eig,
              trace: planar?.trace ?? Number.NaN,
              determinant: planar?.determinant ?? Number.NaN,
              discriminant: planar?.discriminant ?? Number.NaN
            }];
          } else {
            samplesWithRejectedAttractorFallback += 1;
          }
        } else {
          samplesWithRejectedAttractorFallback += 1;
        }
      }

      if (effective.length === 0) {
        samplesWithoutEffective += 1;
        // Preserve previous active branches across sparse continuation misses so branch IDs
        // remain trackable when equilibria are found again on the next parameter sample.
        continue;
      }

      const used = new Set<number>();
      const nextActive = new Map<number, {
        state: number[];
        y: number;
        stable: boolean;
        slope: number | null;
        eig: number | null;
        param: number;
        trace: number | null;
        determinant: number | null;
        discriminant: number | null;
      }>();
      for (const eq of effective.sort((a, b) => a.y - b.y)) {
        let branchId: number | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const [id, prev] of activeBranches.entries()) {
          if (used.has(id)) {
            continue;
          }
          const dist = this.euclideanDistance(prev.state, eq.state);
          if (dist < bestDist) {
            bestDist = dist;
            branchId = id;
          }
        }
        if (branchId === null) {
          branchId = nextBranch++;
        }
        used.add(branchId);

        const prev = activeBranches.get(branchId);
        const slope = prev ? eq.y - prev.y : null;
        const hasSlopeFlip =
          !!prev &&
          prev.slope !== null &&
          slope !== null &&
          Math.abs(prev.slope) > 1e-8 &&
          Math.abs(slope) > 1e-8 &&
          Math.sign(prev.slope) !== Math.sign(slope);
        const hasStabilityFlip = !!prev && prev.stable !== eq.stable;
        let currentType = hasSlopeFlip && !hasStabilityFlip ? "LP" : "EP";
        let currentLabel = hasSlopeFlip && !hasStabilityFlip ? label++ : 0;

        if (prev && hasStabilityFlip) {
          const isHopfTransition =
            n === 2 &&
            Number.isFinite(prev.trace) &&
            Number.isFinite(eq.trace) &&
            Number.isFinite(prev.determinant) &&
            Number.isFinite(eq.determinant) &&
            (prev.determinant ?? Number.NaN) > 0 &&
            (eq.determinant ?? Number.NaN) > 0 &&
            (
              Math.sign(prev.trace ?? 0) !== Math.sign(eq.trace ?? 0) ||
              (
                (Number.isFinite(prev.discriminant) && (prev.discriminant ?? Number.NaN) < 0) ||
                (Number.isFinite(eq.discriminant) && (eq.discriminant ?? Number.NaN) < 0)
              )
            );
          const specialType = n === 1 ? "LP" : (n === 2 ? (isHopfTransition ? "HB" : "LP") : "HB");
          const prevEig = prev.eig;
          const currEig = eq.eig;
          const alpha =
            typeof prevEig === "number" &&
            Number.isFinite(prevEig) &&
              typeof currEig === "number" &&
              Number.isFinite(currEig) &&
              Math.sign(prevEig) !== Math.sign(currEig)
              ? Math.abs(prevEig) / Math.max(1e-12, Math.abs(prevEig) + Math.abs(currEig))
              : 0.5;
          const xSpecial = prev.param + alpha * (p - prev.param);
          const ySpecial = prev.y + alpha * (eq.y - prev.y);
          let emittedRefined = false;

          if (Number.isFinite(xSpecial) && Number.isFinite(ySpecial)) {
            syntheticSpecialPoints.push({
              index: 0,
              label: label++,
              type: specialType,
              branch: branchId,
              stable: false,
              x: xSpecial,
              y: ySpecial,
              parameters: { [request.primaryParameter]: xSpecial },
              stateValues: buildStateValues(
                model.variables,
                prev.state.map((value, idx) => value + alpha * ((eq.state[idx] ?? value) - value))
              )
            });
            transitionRefinedCount += 1;
            emittedRefined = true;
            if (specialType === "HB") {
              transitionRefinedHbCount += 1;
            } else {
              transitionRefinedLpCount += 1;
            }
          }
          if (!emittedRefined) {
            currentType = specialType;
            currentLabel = label++;
          }
        }

        points.push({
          index: points.length,
          label: currentLabel,
          type: currentType,
          branch: branchId,
          stable: eq.stable,
          x: p,
          y: eq.y,
          parameters: { [request.primaryParameter]: p },
          stateValues: buildStateValues(model.variables, eq.state)
        });

        nextActive.set(branchId, {
          state: eq.state,
          y: eq.y,
          stable: eq.stable,
          slope,
          eig: Number.isFinite(eq.eig) ? eq.eig : null,
          param: p,
          trace: Number.isFinite(eq.trace) ? eq.trace : null,
          determinant: Number.isFinite(eq.determinant) ? eq.determinant : null,
          discriminant: Number.isFinite(eq.discriminant) ? eq.discriminant : null
        });
      }
      activeBranches = nextActive;
    }

    const mergedPoints = [
      ...points,
      ...syntheticSpecialPoints.map((point, idx) => ({ ...point, index: points.length + idx }))
    ];
    const transitionAugmented = this.addStabilityTransitionPoints(mergedPoints);
    const diagnostics: Diagnostic[] = [
      ...model.diagnostics,
      makeDiagnostic(
        "POINT_DENSITY_APPLIED",
        `Point density ${pointDensity}x applied (${samples} continuation samples, lattice ${latticeCount})`,
        undefined,
        "warning"
      ),
      makeDiagnostic(
        "ONE_PARAM_ATTRACTOR_APPROX",
        "Multi-dimensional one-parameter diagram uses attractor-following fallback",
        undefined,
        "warning"
      ),
      makeDiagnostic(
        "PERIODIC_POINTS_REQUIRE_AUTO",
        "Fallback mode tracks equilibrium branches only; periodic-orbit points (P) require native AUTO/WASM continuation",
        undefined,
        "unsupported"
      )
    ];
    if (transitionAugmented.added > 0) {
      diagnostics.push(
        makeDiagnostic(
          "STABILITY_TRANSITION_POINTS",
          `Added ${transitionAugmented.added} synthetic bifurcation point(s) at stability transitions`,
          undefined,
          "warning"
        )
      );
    }
    if (transitionRefinedCount > 0) {
      diagnostics.push(
        makeDiagnostic(
          "STABILITY_TRANSITION_REFINED",
          `Inserted ${transitionRefinedCount} explicit special point(s) from stability-flip interpolation (HB=${transitionRefinedHbCount}, LP=${transitionRefinedLpCount})`,
          undefined,
          "warning"
        )
      );
    }
    if (samplesUsingAttractorFallback > 0) {
      diagnostics.push(
        makeDiagnostic(
          "ONE_PARAM_ATTRACTOR_FALLBACK_USED",
          `Attractor fallback was used in ${samplesUsingAttractorFallback}/${samples} continuation samples`,
          undefined,
          "warning"
        )
      );
    }
    if (samplesWithRejectedAttractorFallback > 0) {
      diagnostics.push(
        makeDiagnostic(
          "ONE_PARAM_ATTRACTOR_FALLBACK_REJECTED",
          `Attractor fallback produced non-finite state values in ${samplesWithRejectedAttractorFallback}/${samples} samples`,
          undefined,
          "warning"
        )
      );
    }
    if (samplesWithoutEffective > 0) {
      diagnostics.push(
        makeDiagnostic(
          "ONE_PARAM_SAMPLES_WITHOUT_EQ",
          `No finite equilibrium could be tracked for ${samplesWithoutEffective}/${samples} continuation samples in parameter range [${request.controls.rl0}, ${request.controls.rl1}]`,
          undefined,
          "warning"
        )
      );
    }
    if (seedRangeExpanded) {
      diagnostics.push(
        makeDiagnostic(
          "ONE_PARAM_SEED_RANGE_EXPANDED",
          `Search window for ${trackedName} was expanded from [${request.controls.a0}, ${request.controls.a1}] to [${seedMin}, ${seedMax}] around initial ${trackedName}=${trackedBase}`,
          undefined,
          "warning"
        )
      );
    }

    return this.finalizeBifurcationResult("one_param", transitionAugmented.points, [
      ...diagnostics
    ]);
  }

  private addStabilityTransitionPoints(points: BifurcationResult["points"]): { points: BifurcationResult["points"]; added: number } {
    if (points.length < 2) {
      return { points, added: 0 };
    }

    const byBranch = new Map<number, BifurcationResult["points"]>();
    for (const point of points) {
      const bucket = byBranch.get(point.branch) ?? [];
      bucket.push(point);
      byBranch.set(point.branch, bucket);
    }

    let nextLabel = points.reduce((mx, point) => Math.max(mx, point.label), 0) + 1;
    const synthetic: BifurcationResult["points"] = [];

    const midpointParameters = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
      const out: Record<string, number> = {};
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        const av = a[key];
        const bv = b[key];
        if (typeof av === "number" && Number.isFinite(av) && typeof bv === "number" && Number.isFinite(bv)) {
          out[key] = 0.5 * (av + bv);
        } else if (typeof av === "number" && Number.isFinite(av)) {
          out[key] = av;
        } else if (typeof bv === "number" && Number.isFinite(bv)) {
          out[key] = bv;
        }
      }
      return out;
    };
    const midpointStateValues = (
      a?: Record<string, number>,
      b?: Record<string, number>
    ): Record<string, number> | undefined => {
      if (!a && !b) {
        return undefined;
      }
      const out: Record<string, number> = {};
      const keys = new Set([...(a ? Object.keys(a) : []), ...(b ? Object.keys(b) : [])]);
      for (const key of keys) {
        const av = a?.[key];
        const bv = b?.[key];
        if (typeof av === "number" && Number.isFinite(av) && typeof bv === "number" && Number.isFinite(bv)) {
          out[key] = 0.5 * (av + bv);
        } else if (typeof av === "number" && Number.isFinite(av)) {
          out[key] = av;
        } else if (typeof bv === "number" && Number.isFinite(bv)) {
          out[key] = bv;
        }
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };

    for (const branchPoints of byBranch.values()) {
      const sorted = [...branchPoints]
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.x - b.x || a.index - b.index);
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const a = sorted[i];
        const b = sorted[i + 1];
        if (!a || !b) {
          continue;
        }
        if (typeof a.stable !== "boolean" || typeof b.stable !== "boolean" || a.stable === b.stable) {
          continue;
        }
        if (a.label > 0 || b.label > 0) {
          continue;
        }
        // Skip midpoint insertion when the interval already has a labeled special point.
        const hasLabeledBetween = sorted.some(
          (p) => p.label > 0 && p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x)
        );
        if (hasLabeledBetween) {
          continue;
        }
        if (a.type !== "EP" || b.type !== "EP") {
          continue;
        }

        const x = 0.5 * (a.x + b.x);
        const y = 0.5 * (a.y + b.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          continue;
        }

        synthetic.push({
          index: points.length + synthetic.length,
          label: nextLabel++,
          type: "BIF",
          branch: a.branch,
          stable: false,
          x,
          y,
          parameters: midpointParameters(a.parameters, b.parameters),
          stateValues: midpointStateValues(a.stateValues, b.stateValues)
        });
      }
    }

    if (synthetic.length === 0) {
      return { points, added: 0 };
    }
    return {
      points: [...points, ...synthetic],
      added: synthetic.length
    };
  }

  private findEquilibriaMultiStart(
    model: ParsedModel,
    params: NumericDict,
    seeds: number[][],
    yIndex: number
  ): Array<{
    state: number[];
    y: number;
    stable: boolean;
    eig: number;
    trace: number;
    determinant: number;
    discriminant: number;
  }> {
    const roots: number[][] = [];
    for (const seed of seeds) {
      const root = this.newtonEquilibriumSolve(model, params, seed);
      if (!root) {
        continue;
      }
      if (!roots.some((existing) => this.euclideanDistance(existing, root) < 1e-3)) {
        roots.push(root);
      }
    }

    return roots
      .map((state) => {
        const jac = this.jacobian(model, state, params);
        const eig = maxRealEigenApprox(jac);
        const planar = planarSpectralInfo(jac);
        return {
          state,
          y: state[yIndex] ?? 0,
          stable: Number.isFinite(eig) ? eig < 0 : false,
          eig: Number.isFinite(eig) ? eig : Number.NaN,
          trace: planar?.trace ?? Number.NaN,
          determinant: planar?.determinant ?? Number.NaN,
          discriminant: planar?.discriminant ?? Number.NaN
        };
      })
      .filter((entry) => entry.state.every((value) => Number.isFinite(value)) && Number.isFinite(entry.y));
  }

  private newtonEquilibriumSolve(model: ParsedModel, params: NumericDict, seed: number[]): number[] | null {
    let x = [...seed];
    const maxIter = 35;
    for (let iter = 0; iter < maxIter; iter += 1) {
      const f = this.computeDerivatives(model, 0, x, params);
      const fnorm = this.vectorNorm(f);
      if (!Number.isFinite(fnorm)) {
        return null;
      }
      if (fnorm < 1e-8) {
        return x;
      }
      const jac = this.jacobian(model, x, params);
      const rhs = f.map((v) => -v);
      const delta = this.solveLinearSystem(jac, rhs);
      if (!delta) {
        return null;
      }
      x = x.map((value, idx) => value + (delta[idx] ?? 0));
      if (!x.every((v) => Number.isFinite(v))) {
        return null;
      }
      if (this.vectorNorm(delta) < 1e-10 && fnorm < 1e-6) {
        return x;
      }
    }
    const residual = this.vectorNorm(this.computeDerivatives(model, 0, x, params));
    if (Number.isFinite(residual) && residual < 1e-5) {
      return x;
    }
    return null;
  }

  private solveLinearSystem(a: number[][], b: number[]): number[] | null {
    const n = a.length;
    if (n === 0 || b.length !== n) {
      return null;
    }
    const aug: number[][] = a.map((row, i) => [...row, b[i] ?? 0]);

    for (let col = 0; col < n; col += 1) {
      let pivot = col;
      for (let row = col + 1; row < n; row += 1) {
        if (Math.abs(aug[row]?.[col] ?? 0) > Math.abs(aug[pivot]?.[col] ?? 0)) {
          pivot = row;
        }
      }
      if (Math.abs(aug[pivot]?.[col] ?? 0) < 1e-12) {
        return null;
      }
      if (pivot !== col) {
        const tmp = aug[col];
        aug[col] = aug[pivot] ?? [];
        aug[pivot] = tmp ?? [];
      }

      const pivotVal = aug[col]?.[col] ?? 0;
      for (let j = col; j <= n; j += 1) {
        aug[col]![j] = (aug[col]?.[j] ?? 0) / pivotVal;
      }

      for (let row = 0; row < n; row += 1) {
        if (row === col) {
          continue;
        }
        const factor = aug[row]?.[col] ?? 0;
        for (let j = col; j <= n; j += 1) {
          aug[row]![j] = (aug[row]?.[j] ?? 0) - factor * (aug[col]?.[j] ?? 0);
        }
      }
    }

    return Array.from({ length: n }, (_, i) => aug[i]?.[n] ?? 0);
  }

  private vectorNorm(values: number[]): number {
    let sum = 0;
    for (const value of values) {
      sum += value * value;
    }
    return Math.sqrt(sum);
  }

  private euclideanDistance(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  private findOneDimEquilibria(
    model: ParsedModel,
    baseParams: NumericDict,
    parameterName: string,
    parameterValue: number,
    xMin: number,
    xMax: number,
    samples: number
  ): Array<{ y: number; stable: boolean; type: string }> {
    const params = { ...baseParams, [parameterName]: parameterValue };
    const evaluate = (x: number): number => {
      const derivative = this.computeDerivatives(model, 0, [x], params)[0] ?? Number.NaN;
      return Number.isFinite(derivative) ? derivative : Number.NaN;
    };

    const roots: number[] = [];
    const h = (xMax - xMin) / Math.max(1, samples - 1);
    let xPrev = xMin;
    let fPrev = evaluate(xPrev);

    for (let i = 1; i < samples; i += 1) {
      const x = xMin + i * h;
      const f = evaluate(x);
      if (!Number.isFinite(fPrev) || !Number.isFinite(f)) {
        xPrev = x;
        fPrev = f;
        continue;
      }
      if (Math.abs(fPrev) < 1e-8) {
        roots.push(xPrev);
      }
      if (fPrev === 0 || f === 0 || Math.sign(fPrev) !== Math.sign(f)) {
        const root = this.bisectRoot(evaluate, xPrev, x, 36);
        if (root !== null && Number.isFinite(root)) {
          roots.push(root);
        }
      }
      xPrev = x;
      fPrev = f;
    }

    const uniqueRoots = roots
      .sort((a, b) => a - b)
      .filter((value, idx, arr) => idx === 0 || Math.abs(value - (arr[idx - 1] ?? value)) > 1e-3);

    return uniqueRoots.map((root) => {
      const eps = 1e-5 * (1 + Math.abs(root));
      const fp = evaluate(root + eps);
      const fm = evaluate(root - eps);
      const dfdx = (fp - fm) / (2 * eps);
      const stable = dfdx < 0;
      const type = Math.abs(dfdx) < 2e-2 ? "LP" : "EP";
      return { y: root, stable, type };
    });
  }

  private bisectRoot(fn: (x: number) => number, lo: number, hi: number, iterations: number): number | null {
    let a = lo;
    let b = hi;
    let fa = fn(a);
    let fb = fn(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
      return null;
    }
    if (Math.abs(fa) < 1e-12) {
      return a;
    }
    if (Math.abs(fb) < 1e-12) {
      return b;
    }
    if (Math.sign(fa) === Math.sign(fb)) {
      return 0.5 * (a + b);
    }
    for (let i = 0; i < iterations; i += 1) {
      const mid = 0.5 * (a + b);
      const fm = fn(mid);
      if (!Number.isFinite(fm)) {
        return null;
      }
      if (Math.abs(fm) < 1e-10) {
        return mid;
      }
      if (Math.sign(fa) === Math.sign(fm)) {
        a = mid;
        fa = fm;
      } else {
        b = mid;
        fb = fm;
      }
      if (Math.abs(b - a) < 1e-7) {
        break;
      }
    }
    return 0.5 * (a + b);
  }

  private finalizeBifurcationResult(
    mode: BifurcationResult["mode"],
    points: BifurcationResult["points"],
    diagnostics: Diagnostic[]
  ): BifurcationResult {
    if (points.length === 0) {
      diagnostics = [
        ...diagnostics,
        makeDiagnostic(
          "NO_BIF_POINTS",
          "Continuation run did not produce any branch points; adjust continuation ranges or parameter selections",
          undefined,
          "warning"
        )
      ];
    }

    const finitePoints: BifurcationResult["points"] = [];
    let removed = 0;
    for (const point of points) {
      const hasFiniteXY = Number.isFinite(point.x) && Number.isFinite(point.y);
      const hasFiniteSecondary = point.secondaryY === undefined || Number.isFinite(point.secondaryY);
      if (!hasFiniteXY || !hasFiniteSecondary) {
        removed += 1;
        continue;
      }
      finitePoints.push({ ...point, index: finitePoints.length });
    }

    const extraDiagnostics: Diagnostic[] = [];
    if (removed > 0) {
      extraDiagnostics.push(
        makeDiagnostic(
          "NONFINITE_BIF_POINTS_DROPPED",
          `Dropped ${removed} bifurcation points with non-finite coordinates before rendering`,
          undefined,
          "warning"
        )
      );
    }
    if (finitePoints.length === 0 && points.length > 0) {
      extraDiagnostics.push(
        makeDiagnostic("NO_FINITE_BIF_POINTS", "Bifurcation run produced only non-finite points", undefined, "warning")
      );
    }
    if (mode === "one_param" && finitePoints.length > 0) {
      const hbCount = finitePoints.filter((point) => point.type === "HB").length;
      const lpCount = finitePoints.filter((point) => point.type === "LP").length;
      if (hbCount === 0) {
        extraDiagnostics.push(
          makeDiagnostic(
            "NO_HB_POINTS",
            "No Hopf (HB) points were detected for this parameter sweep. This can be valid for the selected model and continuation window.",
            undefined,
            "warning"
          )
        );
      }
      if (lpCount === 0) {
        extraDiagnostics.push(
          makeDiagnostic(
            "NO_LP_POINTS",
            "No fold (LP) points were detected for this parameter sweep.",
            undefined,
            "warning"
          )
        );
      }
    }

    return {
      mode,
      points: finitePoints,
      diagnostics: [...diagnostics, ...extraDiagnostics]
    };
  }
}
