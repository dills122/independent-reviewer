/** Share one instance across batch workers using the same model/provider pool. */
export class ProviderCallPacerV1 {
  readonly #nextStart = new Map<string, number>();
  readonly #cooldownUntil = new Map<string, number>();

  constructor(readonly minimumIntervalMs = 0) {
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error("Call pacing interval must be a nonnegative integer.");
    }
  }

  defer(model: string, delayMs: number): void {
    this.#cooldownUntil.set(
      model,
      Math.max(this.#cooldownUntil.get(model) ?? 0, Date.now() + delayMs),
    );
  }

  async wait(model: string): Promise<void> {
    for (;;) {
      const delay =
        Math.max(this.#nextStart.get(model) ?? 0, this.#cooldownUntil.get(model) ?? 0) - Date.now();
      if (delay <= 0) {
        this.#nextStart.set(model, Date.now() + this.minimumIntervalMs);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
      // Recheck: another worker may have extended the cooldown while we waited.
    }
  }
}
