export const SYNC_RETRY_DELAYS_MS = Object.freeze([
  5_000,
  15_000,
  45_000,
  120_000,
  300_000,
]);

export function isStorageQuotaError(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (
      current.name === 'QuotaExceededError' ||
      current.code === 22 ||
      /(?:quota|storage).*(?:exceed|full)|(?:exceed|full).*(?:quota|storage)/i.test(String(current.message || ''))
    ) return true;
    current = current.cause;
  }
  return false;
}

export function isRetryableSyncError(error) {
  if (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name)) return true;
  const status = Number(error?.status);
  if ([408, 425, 429].includes(status) || status >= 500) return true;
  // A reverse proxy can return an unstructured 400 when the request stream is
  // interrupted. Structured application validation errors always carry a code.
  return status === 400 && !error?.code;
}

export function createSyncRetryController({
  delays = SYNC_RETRY_DELAYS_MS,
  canRun = () => true,
  onRetry,
  onState = () => {},
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof onRetry !== 'function') throw new TypeError('A synchronization retry callback is required');
  const retryDelays = [...delays].map(Number);
  if (!retryDelays.length || retryDelays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new TypeError('Synchronization retry delays must be finite non-negative numbers');
  }
  let attempt = 0;
  let timer = null;

  const controller = {
    schedule() {
      if (timer !== null) {
        return { status: 'scheduled', attempt, delayMs: retryDelays[attempt - 1] };
      }
      if (!canRun()) {
        const state = { status: 'paused', attempt };
        onState(state);
        return state;
      }
      const delayMs = retryDelays[attempt];
      if (delayMs === undefined) {
        const state = { status: 'exhausted', attempt };
        onState(state);
        return state;
      }
      attempt += 1;
      const scheduledAttempt = attempt;
      timer = setTimer(async () => {
        timer = null;
        if (!canRun()) {
          onState({ status: 'paused', attempt: scheduledAttempt });
          return;
        }
        await onRetry({ attempt: scheduledAttempt, delayMs });
      }, delayMs);
      const state = { status: 'scheduled', attempt: scheduledAttempt, delayMs };
      onState(state);
      return state;
    },
    pause() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      return { status: 'paused', attempt };
    },
    reset() {
      controller.pause();
      attempt = 0;
      return { status: 'idle', attempt };
    },
    snapshot() {
      return { attempt, scheduled: timer !== null };
    },
  };
  return controller;
}
