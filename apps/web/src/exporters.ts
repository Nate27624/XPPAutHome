import JSZip from "jszip";
import type { BifurcationResult, PhasePlaneResult, SimulationResult } from "@xpp/core-api";

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function toCsv(rows: Array<Array<string | number>>): string {
  return rows
    .map((row) => row.map((cell) => `${cell}`.replaceAll('"', '""')).map((cell) => `"${cell}"`).join(","))
    .join("\n");
}

export function simulationCsv(sim: SimulationResult): string {
  const keys = Object.keys(sim.series);
  const rows: Array<Array<string | number>> = [["t", ...keys]];
  const n = sim.time.length;
  for (let i = 0; i < n; i += 1) {
    rows.push([sim.time[i] ?? 0, ...keys.map((key) => sim.series[key]?.[i] ?? 0)]);
  }
  return toCsv(rows);
}

export function phasePlaneCsv(phase: PhasePlaneResult): string {
  const rows: Array<Array<string | number>> = [["x", "y", "dx", "dy"]];
  for (const p of phase.vectorField) {
    rows.push([p.x, p.y, p.dx, p.dy]);
  }
  return toCsv(rows);
}

export function bifurcationCsv(bif: BifurcationResult): string {
  const rows: Array<Array<string | number>> = [["index", "label", "type", "branch", "stable", "ntot", "itp", "period", "x", "y", "secondaryY"]];
  for (const p of bif.points) {
    rows.push([
      p.index,
      p.label,
      p.type,
      p.branch,
      p.stable === undefined ? "" : Number(p.stable),
      p.ntot ?? "",
      p.itp ?? "",
      p.period ?? "",
      p.x,
      p.y,
      p.secondaryY ?? ""
    ]);
  }
  return toCsv(rows);
}

export async function exportProjectBundle(payload: {
  modelName: string;
  modelText: string;
  simulation: SimulationResult | null;
  phase: PhasePlaneResult | null;
  bifurcation: BifurcationResult | null;
  controls: Record<string, unknown>;
}): Promise<Blob> {
  const zip = new JSZip();
  zip.file("model.ode", payload.modelText);
  zip.file("manifest.json", JSON.stringify(payload.controls, null, 2));
  if (payload.simulation) {
    zip.file("simulation.csv", simulationCsv(payload.simulation));
  }
  if (payload.phase) {
    zip.file("phase_plane.csv", phasePlaneCsv(payload.phase));
  }
  if (payload.bifurcation) {
    zip.file("bifurcation.csv", bifurcationCsv(payload.bifurcation));
  }
  return zip.generateAsync({ type: "blob" });
}

export async function importProjectBundle(file: File): Promise<{ modelText: string; modelName: string; controls: Record<string, unknown> }> {
  const zip = await JSZip.loadAsync(file);
  const model = await zip.file("model.ode")?.async("string");
  if (!model) {
    throw new Error("Bundle does not include model.ode");
  }
  const manifestRaw = await zip.file("manifest.json")?.async("string");
  const controls = manifestRaw ? (JSON.parse(manifestRaw) as Record<string, unknown>) : {};
  return {
    modelName: file.name.replace(/\.zip$/i, ""),
    modelText: model,
    controls
  };
}
