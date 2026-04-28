import type {
  BifurcationRequest,
  BifurcationResult,
  Diagnostic,
  ModelInfo,
  PhasePlaneRequest,
  PhasePlaneResult,
  SimulationRequest,
  SimulationResult
} from "@xpp/core-api";
import { FallbackXppEngine } from "./fallbackEngine";
import type { XpwRuntime } from "./types";
import { createWasmRuntime, type WasmXpwRuntime } from "./wasmRuntime";

type DiagnosticCarrier = {
  diagnostics?: Diagnostic[];
};

const WASM_UNSUPPORTED_CODES = new Set([
  "WASM_WRAPPER_PLACEHOLDER",
  "WASM_ENGINE_NOT_LINKED",
  "WASM_ENGINE_UNAVAILABLE"
]);
const SPECIAL_BIF_TYPE_PREFIXES = ["HB", "LP", "BP", "PD", "TR", "BIF"] as const;
const SPECIAL_BIF_TYPE_EXACT = new Set(["BT", "CP", "GH", "ZH", "NS"]);

type RuntimeBootstrapFlags = {
  __XPP_PREFER_WASM__?: boolean;
};

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldPreferWasmRuntime(): boolean {
  return (globalThis as RuntimeBootstrapFlags).__XPP_PREFER_WASM__ === true;
}

function hasUnsupportedWasmDiagnostic(payload: DiagnosticCarrier): boolean {
  const diagnostics = payload.diagnostics ?? [];
  return diagnostics.some((diag) => WASM_UNSUPPORTED_CODES.has(diag.code) || diag.code.startsWith("WASM_") && diag.tier === "unsupported");
}

function withFallbackDiagnostic<T extends DiagnosticCarrier>(payload: T, reason: string): T {
  return {
    ...payload,
    diagnostics: [
      {
        code: "ENGINE_FALLBACK_ACTIVE",
        message: reason,
        tier: "warning"
      },
      ...(payload.diagnostics ?? [])
    ]
  };
}

function isDegradedPhasePlane(result: PhasePlaneResult): boolean {
  const noVectors = result.vectorField.length === 0;
  const noNullclines = result.nullclines.xNullcline.length === 0 && result.nullclines.yNullcline.length === 0;
  return noVectors || noNullclines;
}

function sanitizeSimulationResult(result: SimulationResult): SimulationResult {
  let replacedCount = 0;
  const sanitizeSeries = (values: number[]): number[] => {
    let lastFinite = 0;
    let hasFinite = false;
    return values.map((value) => {
      if (Number.isFinite(value)) {
        lastFinite = value;
        hasFinite = true;
        return value;
      }
      replacedCount += 1;
      return hasFinite ? lastFinite : 0;
    });
  };

  const time = (() => {
    let previous = 0;
    return result.time.map((value, index) => {
      if (Number.isFinite(value)) {
        previous = value;
        return value;
      }
      replacedCount += 1;
      const replacement = index === 0 ? 0 : previous + 1e-9;
      previous = replacement;
      return replacement;
    });
  })();

  const series: Record<string, number[]> = {};
  for (const [name, values] of Object.entries(result.series)) {
    series[name] = sanitizeSeries(values);
  }

  if (replacedCount === 0) {
    return result;
  }

  const diagnostics = [
    {
      code: "SIM_NONFINITE_VALUES_SANITIZED",
      message: `Simulation output contained ${replacedCount} non-finite values; replaced using last finite sample fallback.`,
      tier: "warning" as const
    },
    ...(result.diagnostics ?? [])
  ];

  return {
    time,
    series,
    diagnostics
  };
}

function sanitizePhasePlaneResult(result: PhasePlaneResult): PhasePlaneResult {
  let replacedCount = 0;
  const replace = (value: number, fallback = 0): number => {
    if (Number.isFinite(value)) {
      return value;
    }
    replacedCount += 1;
    return fallback;
  };

  const vectorField = result.vectorField.map((point) => ({
    x: replace(point.x),
    y: replace(point.y),
    dx: replace(point.dx),
    dy: replace(point.dy)
  }));

  const sanitizePolyline = (polyline: Array<[number, number]>): Array<[number, number]> =>
    polyline.map(([x, y]) => [replace(x), replace(y)] as [number, number]);

  const nullclines = {
    xNullcline: result.nullclines.xNullcline.map(sanitizePolyline),
    yNullcline: result.nullclines.yNullcline.map(sanitizePolyline)
  };

  const trajectory = result.trajectory
    ? {
        time: result.trajectory.time.map((t) => replace(t)),
        x: result.trajectory.x.map((x) => replace(x)),
        y: result.trajectory.y.map((y) => replace(y))
      }
    : undefined;

  if (replacedCount === 0) {
    return result;
  }

  const diagnostics = [
    {
      code: "PHASE_NONFINITE_VALUES_SANITIZED",
      message: `Phase-plane output contained ${replacedCount} non-finite values; replaced with 0.`,
      tier: "warning" as const
    },
    ...(result.diagnostics ?? [])
  ];

  return {
    vectorField,
    nullclines,
    trajectory,
    diagnostics
  };
}

function isSpecialBifType(type: string): boolean {
  const normalized = type.trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (SPECIAL_BIF_TYPE_EXACT.has(normalized)) {
    return true;
  }
  return SPECIAL_BIF_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizeBifurcationLabels(result: BifurcationResult): BifurcationResult {
  let changed = false;
  const points = result.points.map((point) => {
    if (point.label <= 0 || isSpecialBifType(point.type)) {
      return point;
    }
    changed = true;
    return {
      ...point,
      label: 0
    };
  });
  if (!changed) {
    return result;
  }
  return { ...result, points };
}

export class XpwRuntimeClient implements XpwRuntime {
  private readonly fallback = new FallbackXppEngine();
  private wasm: WasmXpwRuntime | null = null;
  private useFallback = false;
  private fallbackReason = "Fallback runtime active.";
  private lastLoadedModel: { odeText: string; fileName: string } | null = null;
  private fallbackModelReady = false;

  private activateFallback(reason: string): void {
    this.useFallback = true;
    this.fallbackReason = reason;
  }

  public async boot(): Promise<void> {
    await this.fallback.boot();
    this.lastLoadedModel = null;
    this.fallbackModelReady = false;
    if (!shouldPreferWasmRuntime()) {
      this.wasm = null;
      this.useFallback = true;
      this.fallbackReason = "Configured to use TS fallback engine by default. Set globalThis.__XPP_PREFER_WASM__ = true before boot to prefer XPPAUT WASM.";
      return;
    }
    try {
      this.wasm = await createWasmRuntime();
      await this.wasm.boot();
      this.useFallback = false;
      this.fallbackReason = "Fallback runtime active.";
    } catch (error) {
      this.activateFallback(`WASM runtime unavailable; using fallback engine (${asErrorMessage(error)})`);
    }
  }

  public async loadModel(odeText: string, fileName: string): Promise<ModelInfo> {
    this.lastLoadedModel = { odeText, fileName };
    this.fallbackModelReady = false;
    try {
      return await this.runWasmFirst(
        () => this.wasm!.loadModel(odeText, fileName),
        async () => {
          const result = await this.fallback.loadModel(odeText, fileName);
          this.fallbackModelReady = true;
          return result;
        },
        true
      );
    } catch (error) {
      this.activateFallback(`WASM hard failure during model load; using fallback engine (${asErrorMessage(error)})`);
      const fallbackResult = await this.fallback.loadModel(odeText, fileName);
      this.fallbackModelReady = true;
      return withFallbackDiagnostic(fallbackResult, this.fallbackReason);
    }
  }

  public async getModelInfo(): Promise<ModelInfo> {
    try {
      return await this.runWasmFirst(
        () => this.wasm!.getModelInfo(),
        () => this.runFallbackWithModel(() => this.fallback.getModelInfo()),
        true
      );
    } catch (error) {
      this.activateFallback(`WASM hard failure during model-info query; using fallback engine (${asErrorMessage(error)})`);
      const fallbackResult = await this.runFallbackWithModel(() => this.fallback.getModelInfo());
      return withFallbackDiagnostic(fallbackResult, this.fallbackReason);
    }
  }

  public async runSimulation(request: SimulationRequest): Promise<SimulationResult> {
    const result = await this.runWasmFirst(
      () => this.wasm!.runSimulation(request),
      () => this.runFallbackWithModel(() => this.fallback.runSimulation(request)),
      true
    );
    return sanitizeSimulationResult(result);
  }

  public async runPhasePlane(request: PhasePlaneRequest): Promise<PhasePlaneResult> {
    if (this.useFallback || !this.wasm) {
      const fallbackResult = await this.runFallbackWithModel(() => this.fallback.runPhasePlane(request));
      return withFallbackDiagnostic(sanitizePhasePlaneResult(fallbackResult), this.fallbackReason);
    }

    try {
      const wasmResult = await this.wasm.runPhasePlane(request);
      const sanitizedWasmResult = sanitizePhasePlaneResult(wasmResult);
      if (!hasUnsupportedWasmDiagnostic(sanitizedWasmResult) && !isDegradedPhasePlane(sanitizedWasmResult)) {
        return sanitizedWasmResult;
      }
      const fallbackResult = await this.runFallbackWithModel(() => this.fallback.runPhasePlane(request));
      return withFallbackDiagnostic(
        sanitizePhasePlaneResult(fallbackResult),
        "WASM phase-plane output was incomplete; used fallback engine for this phase-plane run."
      );
    } catch (error) {
      const fallbackResult = await this.runFallbackWithModel(() => this.fallback.runPhasePlane(request));
      return withFallbackDiagnostic(
        sanitizePhasePlaneResult(fallbackResult),
        `WASM phase-plane error; used fallback engine for this phase-plane run (${asErrorMessage(error)})`
      );
    }
  }

  public async runBifurcation(request: BifurcationRequest): Promise<BifurcationResult> {
    if (this.useFallback || !this.wasm) {
      const fallbackResult = await this.runFallbackWithModel(() => this.fallback.runBifurcation(request));
      return withFallbackDiagnostic(normalizeBifurcationLabels(fallbackResult), this.fallbackReason);
    }

    try {
      const wasmResult = normalizeBifurcationLabels(await this.wasm.runBifurcation(request));
      if (!hasUnsupportedWasmDiagnostic(wasmResult)) {
        return wasmResult;
      }
      const fallbackResult = normalizeBifurcationLabels(await this.runFallbackWithModel(() => this.fallback.runBifurcation(request)));
      return withFallbackDiagnostic(
        fallbackResult,
        "WASM bifurcation reported unsupported operation; used fallback engine for this bifurcation run."
      );
    } catch (error) {
      const fallbackResult = normalizeBifurcationLabels(await this.runFallbackWithModel(() => this.fallback.runBifurcation(request)));
      return withFallbackDiagnostic(
        fallbackResult,
        `WASM bifurcation error; used fallback engine for this bifurcation run (${asErrorMessage(error)})`
      );
    }
  }

  public async free(): Promise<void> {
    if (this.wasm) {
      await this.wasm.free();
    }
    await this.fallback.free();
    this.lastLoadedModel = null;
    this.fallbackModelReady = false;
  }

  private async ensureFallbackModelReady(): Promise<void> {
    if (this.fallbackModelReady) {
      return;
    }
    if (!this.lastLoadedModel) {
      return;
    }
    await this.fallback.loadModel(this.lastLoadedModel.odeText, this.lastLoadedModel.fileName);
    this.fallbackModelReady = true;
  }

  private async runFallbackWithModel<T extends DiagnosticCarrier>(runFallback: () => Promise<T>): Promise<T> {
    await this.ensureFallbackModelReady();
    return runFallback();
  }

  private async runWasmFirst<T extends DiagnosticCarrier>(
    runWasm: () => Promise<T>,
    runFallback: () => Promise<T>,
    annotateFallback: boolean
  ): Promise<T> {
    if (!this.useFallback && this.wasm) {
      try {
        const wasmResult = await runWasm();
        if (hasUnsupportedWasmDiagnostic(wasmResult)) {
          this.activateFallback("WASM reported unsupported operation; switched to fallback engine.");
          const fallbackResult = await runFallback();
          return annotateFallback ? withFallbackDiagnostic(fallbackResult, this.fallbackReason) : fallbackResult;
        }
        return wasmResult;
      } catch (error) {
        this.activateFallback(`WASM runtime error; switched to fallback engine (${asErrorMessage(error)})`);
        const fallbackResult = await runFallback();
        return annotateFallback ? withFallbackDiagnostic(fallbackResult, this.fallbackReason) : fallbackResult;
      }
    }
    const fallbackResult = await runFallback();
    return annotateFallback ? withFallbackDiagnostic(fallbackResult, this.fallbackReason) : fallbackResult;
  }
}

export * from "./types";
