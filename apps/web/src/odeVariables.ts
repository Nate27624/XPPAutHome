export function extractStateVariablesFromOde(source: string): string[] {
  if (!source.trim()) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const primeMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*'\s*=\s*(.+)$/);
    const dtMatch = line.match(/^d([A-Za-z_][A-Za-z0-9_]*)\s*\/\s*dt\s*=\s*(.+)$/i);
    const name = primeMatch?.[1] ?? dtMatch?.[1] ?? "";
    if (!name) {
      continue;
    }
    const normalized = name.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }
  return out;
}
