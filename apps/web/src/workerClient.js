export class WorkerClient {
    worker;
    queue = Promise.resolve();
    constructor() {
        this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
            type: "module"
        });
    }
    async boot() {
        await this.call({ type: "boot" });
    }
    async loadModel(odeText, fileName) {
        await this.call({ type: "load_model", odeText, fileName });
    }
    async getModelInfo() {
        const response = await this.call({ type: "get_model_info" });
        if (response.type !== "model_info") {
            throw new Error("Unexpected response type for get_model_info");
        }
        return response.data;
    }
    async runSimulation(request) {
        const response = await this.call({ type: "run_simulation", request });
        if (response.type !== "simulation") {
            throw new Error("Unexpected response type for run_simulation");
        }
        return response.data;
    }
    async runPhasePlane(request) {
        const response = await this.call({ type: "run_phase_plane", request });
        if (response.type !== "phase_plane") {
            throw new Error("Unexpected response type for run_phase_plane");
        }
        return response.data;
    }
    async runBifurcation(request) {
        const response = await this.call({ type: "run_bifurcation", request });
        if (response.type !== "bifurcation") {
            throw new Error("Unexpected response type for run_bifurcation");
        }
        return response.data;
    }
    async free() {
        await this.call({ type: "free" });
        this.worker.terminate();
    }
    async call(message) {
        this.queue = this.queue.then(() => this.exec(message));
        const result = await this.queue;
        return result;
    }
    exec(message) {
        return new Promise((resolve, reject) => {
            const onMessage = (event) => {
                cleanup();
                const payload = event.data;
                if (payload.type === "error") {
                    reject(new Error(payload.message));
                    return;
                }
                resolve(payload);
            };
            const onError = (error) => {
                cleanup();
                reject(error.error ?? new Error(error.message));
            };
            const cleanup = () => {
                this.worker.removeEventListener("message", onMessage);
                this.worker.removeEventListener("error", onError);
            };
            this.worker.addEventListener("message", onMessage);
            this.worker.addEventListener("error", onError);
            this.worker.postMessage(message);
        });
    }
}
