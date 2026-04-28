import { z } from "zod";

export const IntegratorSchema = z.enum([
  "discrete",
  "euler",
  "modified_euler",
  "rk4",
  "adams",
  "gear",
  "cvode"
]);

export const NumericMapSchema = z.record(z.number());

export const SimulationRequestSchema = z
  .object({
    integrator: IntegratorSchema.default("rk4"),
    t0: z.number().default(0),
    tEnd: z.number().positive(),
    dt: z.number().positive(),
    transient: z.number().min(0).default(0),
    outputStride: z.number().int().positive().default(1),
    parameterOverrides: NumericMapSchema.default({}),
    initialConditions: NumericMapSchema.default({}),
    requestedSeries: z.array(z.string()).default([])
  })
  .strict();

export const PhasePlaneRequestSchema = z
  .object({
    xVar: z.string().min(1),
    yVar: z.string().min(1),
    parameterOverrides: NumericMapSchema.default({}),
    fixedState: NumericMapSchema.default({}),
    vectorField: z
      .object({
        xMin: z.number(),
        xMax: z.number(),
        yMin: z.number(),
        yMax: z.number(),
        xSteps: z.number().int().positive(),
        ySteps: z.number().int().positive()
      })
      .strict(),
    nullclineGrid: z
      .object({
        xSteps: z.number().int().positive(),
        ySteps: z.number().int().positive()
      })
      .strict(),
    trajectory: z
      .object({
        enabled: z.boolean().default(true),
        tEnd: z.number().positive().default(200),
        dt: z.number().positive().default(0.05)
      })
      .default({ enabled: true, tEnd: 200, dt: 0.05 })
  })
  .strict();

export const AutoControlsSchema = z
  .object({
    ntst: z.number().int().positive().default(15),
    nmx: z.number().int().positive().default(200),
    pointDensity: z.number().int().min(1).max(8).default(1),
    npr: z.number().int().positive().default(50),
    ncol: z.number().int().positive().default(4),
    ds: z.number().default(0.02),
    dsMin: z.number().positive().default(0.001),
    dsMax: z.number().positive().default(0.5),
    rl0: z.number().default(0),
    rl1: z.number().default(2),
    a0: z.number().default(0),
    a1: z.number().default(1000),
    epsl: z.number().positive().default(1e-4),
    epsu: z.number().positive().default(1e-4),
    epss: z.number().positive().default(1e-4)
  })
  .strict();

export const BifurcationModeSchema = z.enum(["one_param", "two_param"]);

export const BifurcationRequestSchema = z
  .object({
    mode: BifurcationModeSchema,
    primaryParameter: z.string().min(1),
    secondaryParameter: z.string().optional(),
    xVariable: z.string().optional(),
    yVariable: z.string().optional(),
    parameterOverrides: NumericMapSchema.default({}),
    startStrategy: z.enum(["steady_state", "periodic", "continue_label"]).default("steady_state"),
    continueLabel: z.number().int().positive().optional(),
    controls: AutoControlsSchema.default({})
  })
  .strict();

export const DiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    tier: z.enum(["tier1", "tier2", "unsupported", "warning"]).default("warning")
  })
  .strict();

export const ModelInfoSchema = z
  .object({
    variables: z.array(z.string()),
    parameters: z.array(z.string()),
    parameterValues: NumericMapSchema.default({}),
    auxiliaries: z.array(z.string()),
    sets: z.array(z.string()),
    diagnostics: z.array(DiagnosticSchema)
  })
  .strict();

export const SimulationResultSchema = z
  .object({
    time: z.array(z.number()),
    series: z.record(z.array(z.number())),
    diagnostics: z.array(DiagnosticSchema).default([])
  })
  .strict();

export const VectorFieldPointSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    dx: z.number(),
    dy: z.number()
  })
  .strict();

export const PolylineSchema = z.array(z.tuple([z.number(), z.number()]));

export const PhasePlaneResultSchema = z
  .object({
    vectorField: z.array(VectorFieldPointSchema),
    nullclines: z.object({ xNullcline: z.array(PolylineSchema), yNullcline: z.array(PolylineSchema) }).strict(),
    trajectory: z
      .object({
        time: z.array(z.number()),
        x: z.array(z.number()),
        y: z.array(z.number())
      })
      .strict()
      .optional(),
    diagnostics: z.array(DiagnosticSchema).default([])
  })
  .strict();

export const BranchPointSchema = z
  .object({
    index: z.number().int().nonnegative(),
    label: z.number().int().nonnegative(),
    type: z.string(),
    branch: z.number().int(),
    stable: z.boolean().optional(),
    x: z.number(),
    y: z.number(),
    secondaryY: z.number().optional(),
    period: z.number().optional(),
    ntot: z.number().int().optional(),
    itp: z.number().int().optional(),
    parameters: z.record(z.number()).default({}),
    stateValues: z.record(z.number()).optional()
  })
  .strict();

export const BifurcationResultSchema = z
  .object({
    mode: BifurcationModeSchema,
    points: z.array(BranchPointSchema),
    diagnostics: z.array(DiagnosticSchema).default([])
  })
  .strict();

export const WorkerRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boot") }).strict(),
  z.object({ type: z.literal("load_model"), odeText: z.string().min(1), fileName: z.string().min(1).default("model.ode") }).strict(),
  z.object({ type: z.literal("get_model_info") }).strict(),
  z.object({ type: z.literal("run_simulation"), request: SimulationRequestSchema }).strict(),
  z.object({ type: z.literal("run_phase_plane"), request: PhasePlaneRequestSchema }).strict(),
  z.object({ type: z.literal("run_bifurcation"), request: BifurcationRequestSchema }).strict(),
  z.object({ type: z.literal("free") }).strict()
]);

export const WorkerSuccessSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ok"), requestType: z.string() }).strict(),
  z.object({ type: z.literal("model_info"), data: ModelInfoSchema }).strict(),
  z.object({ type: z.literal("simulation"), data: SimulationResultSchema }).strict(),
  z.object({ type: z.literal("phase_plane"), data: PhasePlaneResultSchema }).strict(),
  z.object({ type: z.literal("bifurcation"), data: BifurcationResultSchema }).strict()
]);

export const WorkerErrorSchema = z
  .object({
    type: z.literal("error"),
    requestType: z.string(),
    message: z.string(),
    diagnostics: z.array(DiagnosticSchema).default([])
  })
  .strict();

export type SimulationRequest = z.infer<typeof SimulationRequestSchema>;
export type PhasePlaneRequest = z.infer<typeof PhasePlaneRequestSchema>;
export type BifurcationRequest = z.infer<typeof BifurcationRequestSchema>;
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export type SimulationResult = z.infer<typeof SimulationResultSchema>;
export type PhasePlaneResult = z.infer<typeof PhasePlaneResultSchema>;
export type BifurcationResult = z.infer<typeof BifurcationResultSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerSuccess = z.infer<typeof WorkerSuccessSchema>;
export type WorkerError = z.infer<typeof WorkerErrorSchema>;
