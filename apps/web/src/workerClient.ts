import type {
  BifurcationRequest,
  BifurcationResult,
  ModelInfo,
  PhasePlaneRequest,
  PhasePlaneResult,
  SimulationRequest,
  SimulationResult,
  WorkerError,
  WorkerRequest,
  WorkerSuccess
} from "@xpp/core-api";

type WorkerResponse = WorkerSuccess | WorkerError;
type WorkerRequestType = WorkerRequest["type"];
type TimeoutMap = Partial<Record<WorkerRequestType, number>>;

type WorkerClientOptions = {
  timeoutOverrides?: TimeoutMap;
};

export class WorkerClient {
  private worker: Worker;
  private queue: Promise<void> = Promise.resolve();
  private booted = false;
  private needsRestore = false;
  private lastModel: { odeText: string; fileName: string } | null = null;
  private readonly timeoutOverrides: TimeoutMap;

  public constructor(options: WorkerClientOptions = {}) {
    this.timeoutOverrides = options.timeoutOverrides ?? {};
    this.worker = this.createWorker();
  }

  public async boot(): Promise<void> {
    await this.call({ type: "boot" });
  }

  public async loadModel(odeText: string, fileName: string): Promise<void> {
    await this.call({ type: "load_model", odeText, fileName });
  }

  public async getModelInfo(): Promise<ModelInfo> {
    const response = await this.call({ type: "get_model_info" });
    if (response.type !== "model_info") {
      throw new Error("Unexpected response type for get_model_info");
    }
    return response.data;
  }

  public async runSimulation(request: SimulationRequest): Promise<SimulationResult> {
    const response = await this.call({ type: "run_simulation", request });
    if (response.type !== "simulation") {
      throw new Error("Unexpected response type for run_simulation");
    }
    return response.data;
  }

  public async runPhasePlane(request: PhasePlaneRequest): Promise<PhasePlaneResult> {
    const response = await this.call({ type: "run_phase_plane", request });
    if (response.type !== "phase_plane") {
      throw new Error("Unexpected response type for run_phase_plane");
    }
    return response.data;
  }

  public async runBifurcation(request: BifurcationRequest): Promise<BifurcationResult> {
    const response = await this.call({ type: "run_bifurcation", request });
    if (response.type !== "bifurcation") {
      throw new Error("Unexpected response type for run_bifurcation");
    }
    return response.data;
  }

  public async free(): Promise<void> {
    try {
      await this.call({ type: "free" });
    } finally {
      this.worker.terminate();
    }
  }

  private async call(message: WorkerRequest): Promise<WorkerSuccess> {
    const run = this.queue.then(async () => {
      await this.ensureWorkerReady(message.type);
      const response = await this.exec(message, this.timeoutForMessage(message));
      this.noteSuccess(message);
      return response;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private createWorker(): Worker {
    return new Worker(new URL("./engine.worker.ts", import.meta.url), {
      type: "module"
    });
  }

  private timeoutForMessage(message: WorkerRequest): number {
    const override = this.timeoutOverrides[message.type];
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
      return override;
    }
    switch (message.type) {
      case "boot":
      case "load_model":
      case "get_model_info":
      case "free":
        return 20_000;
      case "run_simulation":
        return 35_000;
      case "run_phase_plane":
        return 35_000;
      case "run_bifurcation":
        return 60_000;
      default:
        return 30_000;
    }
  }

  private noteSuccess(message: WorkerRequest): void {
    if (message.type === "boot") {
      this.booted = true;
      this.needsRestore = false;
      return;
    }
    if (message.type === "load_model") {
      this.booted = true;
      this.needsRestore = false;
      this.lastModel = {
        odeText: message.odeText,
        fileName: message.fileName
      };
      return;
    }
    if (message.type === "free") {
      this.booted = false;
      this.needsRestore = false;
      this.lastModel = null;
    }
  }

  private restartWorker(): void {
    this.worker.terminate();
    this.worker = this.createWorker();
    this.needsRestore = this.booted;
  }

  private async ensureWorkerReady(requestType: WorkerRequest["type"]): Promise<void> {
    if (requestType === "boot" || requestType === "free") {
      return;
    }

    if (!this.booted) {
      await this.exec({ type: "boot" }, this.timeoutForMessage({ type: "boot" }));
      this.booted = true;
      this.needsRestore = false;
    }

    if (!this.needsRestore) {
      return;
    }

    await this.exec({ type: "boot" }, this.timeoutForMessage({ type: "boot" }));
    if (this.lastModel && requestType !== "load_model") {
      await this.exec(
        { type: "load_model", odeText: this.lastModel.odeText, fileName: this.lastModel.fileName },
        this.timeoutForMessage({ type: "load_model", odeText: "", fileName: "" })
      );
    }
    this.needsRestore = false;
  }

  private exec(message: WorkerRequest, timeoutMs: number): Promise<WorkerSuccess> {
    return new Promise<WorkerSuccess>((resolve, reject) => {
      let settled = false;
      const timeoutId = globalThis.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.restartWorker();
        reject(new Error(`Worker request '${message.type}' timed out after ${Math.round(timeoutMs / 1000)}s and was reset.`));
      }, timeoutMs);

      const onMessage = (event: MessageEvent<WorkerResponse>): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const payload = event.data;
        if (payload.type === "error") {
          reject(new Error(payload.message));
          return;
        }
        resolve(payload);
      };

      const onError = (error: ErrorEvent): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.restartWorker();
        reject(error.error ?? new Error(error.message));
      };

      const cleanup = (): void => {
        globalThis.clearTimeout(timeoutId);
        this.worker.removeEventListener("message", onMessage);
        this.worker.removeEventListener("error", onError);
      };

      this.worker.addEventListener("message", onMessage);
      this.worker.addEventListener("error", onError);
      try {
        this.worker.postMessage(message);
      } catch (error) {
        if (!settled) {
          settled = true;
          cleanup();
          this.restartWorker();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }
}
