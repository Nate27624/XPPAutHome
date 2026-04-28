import type {
  BifurcationRequest,
  BifurcationResult,
  ModelInfo,
  PhasePlaneRequest,
  PhasePlaneResult,
  SimulationRequest,
  SimulationResult
} from "@xpp/core-api";
import type { XpwRuntime } from "./types";

type WasmReturnType = "number" | "string" | "boolean" | "void";
type WasmArgType = "number" | "string";

interface EmscriptenLikeModule {
  ccall(
    ident: string,
    returnType: WasmReturnType,
    argTypes: WasmArgType[],
    args: Array<number | string>
  ): number | string | boolean | undefined;
}

interface EmscriptenFactoryModule {
  default?: (opts?: Record<string, unknown>) => Promise<EmscriptenLikeModule> | EmscriptenLikeModule;
}

const WASM_ENTRY_CANDIDATES = [
  "/wasm/xppcore.js",
  "/wasm/xppcore.mjs",
  "../dist/wasm/xppcore.js",
  "../dist/wasm/xppcore.mjs"
];

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson<T>(raw: string | null, context: string): T {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${context}: empty response`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${context}: invalid JSON (${asErrorMessage(error)})`);
  }
}

async function importModuleAt(url: string): Promise<EmscriptenFactoryModule> {
  return import(/* @vite-ignore */ url) as Promise<EmscriptenFactoryModule>;
}

export async function createWasmRuntime(): Promise<WasmXpwRuntime> {
  const explicit = (globalThis as { __XPP_WASM_ENTRY?: string }).__XPP_WASM_ENTRY;
  const candidates = explicit ? [explicit] : WASM_ENTRY_CANDIDATES.map((entry) => new URL(entry, import.meta.url).toString());

  let lastError: unknown = null;
  for (const entryUrl of candidates) {
    try {
      const imported = await importModuleAt(entryUrl);
      const factory = imported.default;
      if (typeof factory !== "function") {
        throw new Error(`WASM entry at ${entryUrl} does not export a default Emscripten factory`);
      }
      const baseUrl = entryUrl.slice(0, entryUrl.lastIndexOf("/") + 1);
      const module = await factory({
        locateFile: (asset: string) => new URL(asset, baseUrl).toString()
      });
      if (!module || typeof module.ccall !== "function") {
        throw new Error(`WASM module at ${entryUrl} is missing ccall`);
      }
      return new WasmXpwRuntime(module);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Could not load XPPAUT WASM module: ${asErrorMessage(lastError)}`);
}

export class WasmXpwRuntime implements XpwRuntime {
  public constructor(private readonly module: EmscriptenLikeModule) {}

  public async boot(): Promise<void> {
    const rc = this.callNumber("xpw_boot");
    if (rc !== 0) {
      throw new Error(`xpw_boot failed with rc=${rc}`);
    }
  }

  public async loadModel(odeText: string, fileName: string): Promise<ModelInfo> {
    const payload = this.callString("xpw_load_model", ["string", "string"], [odeText, fileName]);
    const status = parseJson<{ status?: string; error?: string }>(payload, "xpw_load_model");
    if (status.error) {
      throw new Error(status.error);
    }
    return this.getModelInfo();
  }

  public async getModelInfo(): Promise<ModelInfo> {
    const payload = this.callString("xpw_get_model_info");
    return parseJson<ModelInfo>(payload, "xpw_get_model_info");
  }

  public async runSimulation(request: SimulationRequest): Promise<SimulationResult> {
    const payload = this.callString("xpw_run_simulation", ["string"], [JSON.stringify(request)]);
    return parseJson<SimulationResult>(payload, "xpw_run_simulation");
  }

  public async runPhasePlane(request: PhasePlaneRequest): Promise<PhasePlaneResult> {
    const payload = this.callString("xpw_run_phase_plane", ["string"], [JSON.stringify(request)]);
    return parseJson<PhasePlaneResult>(payload, "xpw_run_phase_plane");
  }

  public async runBifurcation(request: BifurcationRequest): Promise<BifurcationResult> {
    const payload = this.callString("xpw_run_bifurcation", ["string"], [JSON.stringify(request)]);
    return parseJson<BifurcationResult>(payload, "xpw_run_bifurcation");
  }

  public async free(): Promise<void> {
    this.module.ccall("xpw_free", "void", [], []);
  }

  private callString(fn: string, argTypes: WasmArgType[] = [], args: Array<number | string> = []): string {
    const result = this.module.ccall(fn, "string", argTypes, args);
    if (typeof result !== "string") {
      throw new Error(`${fn} returned non-string response`);
    }
    return result;
  }

  private callNumber(fn: string, argTypes: WasmArgType[] = [], args: Array<number | string> = []): number {
    const result = this.module.ccall(fn, "number", argTypes, args);
    if (typeof result !== "number") {
      throw new Error(`${fn} returned non-numeric response`);
    }
    return result;
  }
}
