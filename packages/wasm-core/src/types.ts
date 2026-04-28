import type {
  BifurcationRequest,
  BifurcationResult,
  ModelInfo,
  PhasePlaneRequest,
  PhasePlaneResult,
  SimulationRequest,
  SimulationResult
} from "@xpp/core-api";

export interface XpwRuntime {
  boot(): Promise<void>;
  loadModel(odeText: string, fileName: string): Promise<ModelInfo>;
  getModelInfo(): Promise<ModelInfo>;
  runSimulation(request: SimulationRequest): Promise<SimulationResult>;
  runPhasePlane(request: PhasePlaneRequest): Promise<PhasePlaneResult>;
  runBifurcation(request: BifurcationRequest): Promise<BifurcationResult>;
  free(): Promise<void>;
}
