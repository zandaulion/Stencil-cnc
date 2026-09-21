import { executeGeometryJob } from "../core/geometry-jobs.js";

function report(id, phase, detail) {
  self.postMessage({ id, kind: "progress", progress: { phase, detail } });
}

self.onmessage = (event) => {
  const { id, type, payload } = event.data ?? {};
  const startedAt = performance.now();
  try {
    const result = executeGeometryJob(type, payload, (phase, detail) => report(id, phase, detail));
    self.postMessage({
      id,
      kind: "result",
      result: { value: result, durationMs: performance.now() - startedAt },
    });
  } catch (error) {
    self.postMessage({
      id,
      kind: "error",
      error: { name: error?.name, message: error?.message, stack: error?.stack },
    });
  }
};
