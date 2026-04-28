import {
  BifurcationRequestSchema,
  PhasePlaneRequestSchema,
  SimulationRequestSchema,
  WorkerRequestSchema,
  WorkerSuccessSchema,
  type WorkerError,
  type WorkerRequest,
  type WorkerSuccess
} from "@xpp/core-api";
import { XpwRuntimeClient } from "./index";

const runtime = new XpwRuntimeClient();

function ok(message: WorkerSuccess): WorkerSuccess {
  return WorkerSuccessSchema.parse(message);
}

function err(requestType: string, error: unknown): WorkerError {
  return {
    type: "error",
    requestType,
    message: error instanceof Error ? error.message : String(error),
    diagnostics: []
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  let message: WorkerRequest;
  try {
    message = WorkerRequestSchema.parse(event.data);
  } catch (error) {
    self.postMessage(err("unknown", error));
    return;
  }

  try {
    switch (message.type) {
      case "boot": {
        await runtime.boot();
        self.postMessage(ok({ type: "ok", requestType: "boot" }));
        return;
      }
      case "load_model": {
        await runtime.loadModel(message.odeText, message.fileName);
        self.postMessage(ok({ type: "ok", requestType: "load_model" }));
        return;
      }
      case "get_model_info": {
        const data = await runtime.getModelInfo();
        self.postMessage(ok({ type: "model_info", data }));
        return;
      }
      case "run_simulation": {
        const request = SimulationRequestSchema.parse(message.request);
        const data = await runtime.runSimulation(request);
        self.postMessage(ok({ type: "simulation", data }));
        return;
      }
      case "run_phase_plane": {
        const request = PhasePlaneRequestSchema.parse(message.request);
        const data = await runtime.runPhasePlane(request);
        self.postMessage(ok({ type: "phase_plane", data }));
        return;
      }
      case "run_bifurcation": {
        const request = BifurcationRequestSchema.parse(message.request);
        const data = await runtime.runBifurcation(request);
        self.postMessage(ok({ type: "bifurcation", data }));
        return;
      }
      case "free": {
        await runtime.free();
        self.postMessage(ok({ type: "ok", requestType: "free" }));
        return;
      }
      default: {
        throw new Error(`Unhandled message ${(message as { type?: string }).type ?? "unknown"}`);
      }
    }
  } catch (error) {
    self.postMessage(err(message.type, error));
  }
};
