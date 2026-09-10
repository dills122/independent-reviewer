import { AsyncLocalStorage } from "node:async_hooks";

export interface ReviewProgress {
  type: string;
  stage?: string;
  delayMs?: number;
}
export type ReviewProgressObserver = (progress: ReviewProgress) => void;
const observers = new AsyncLocalStorage<ReviewProgressObserver>();
export function withReviewProgress<T>(
  observer: ReviewProgressObserver | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return observer ? observers.run(observer, run) : run();
}
/** Observational only: a UI exception cannot change state or purchase a repeated call. */
export function emitReviewProgress(event: Record<string, unknown>): void {
  const observer = observers.getStore();
  if (!observer || typeof event.type !== "string") return;
  const safe: ReviewProgress = { type: event.type };
  if (typeof event.stage === "string") safe.stage = event.stage;
  if (typeof event.delayMs === "number") safe.delayMs = event.delayMs;
  try {
    observer(safe);
  } catch {
    /* Durable state remains authoritative. */
  }
}
