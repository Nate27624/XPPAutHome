export interface PersistedProject {
  modelName: string;
  modelText: string;
  simulationRequest: Record<string, unknown>;
  phaseRequest: Record<string, unknown>;
  bifRequest: Record<string, unknown>;
  parameterOverrides?: Record<string, number>;
}

const DB_NAME = "xpp-web";
const STORE_NAME = "projects";
const DB_VERSION = 1;
const LATEST_KEY = "latest";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

export async function saveLatestProject(project: PersistedProject): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(project, LATEST_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to save project"));
  });
  db.close();
}

export async function loadLatestProject(): Promise<PersistedProject | null> {
  const db = await openDb();
  const result = await new Promise<PersistedProject | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(LATEST_KEY);
    req.onsuccess = () => resolve((req.result as PersistedProject | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("Failed to load project"));
  });
  db.close();
  return result;
}
