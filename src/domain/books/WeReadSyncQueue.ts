type SyncCallbacks = {
  send(uid: number, signal: AbortSignal): Promise<void>;
  pending(uid: number | undefined): void;
  error(error: unknown): void;
};

/** Latest chapter wins. Failed work remains pending; no unattended retry loop. */
export class WeReadSyncQueue {
  private pendingUid?: number;
  private lastSyncedUid?: number;
  private lastSentAt: number;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private inFlightUid?: number;
  private controller?: AbortController;
  private disposed = false;
  private enabled = false;

  constructor(
    private readonly callbacks: SyncCallbacks,
    initialCloudUid?: number,
    private readonly now = Date.now,
    private readonly intervalMs = 30000
  ) {
    this.lastSyncedUid = initialCloudUid;
    this.lastSentAt = now();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearTimer();
      this.controller?.abort();
      this.pendingUid = undefined;
      this.callbacks.pending(undefined);
    }
  }

  enqueue(uid: number): void {
    if (!this.enabled || this.disposed) { return; }
    this.pendingUid = uid === this.lastSyncedUid && !this.inFlight ? undefined : uid;
    this.callbacks.pending(this.pendingUid);
    this.clearTimer();
    if (this.pendingUid !== undefined) {
      this.timer = setTimeout(() => void this.flush(), Math.max(0, this.intervalMs - (this.now() - this.lastSentAt)));
    }
  }

  async flush(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) {
      const attemptedUid = this.inFlightUid;
      await this.inFlight;
      if (this.pendingUid !== undefined && this.pendingUid !== attemptedUid) { await this.flush(); }
      return;
    }
    if (!this.enabled || this.disposed || this.pendingUid === undefined) { return; }
    const uid = this.pendingUid;
    this.inFlightUid = uid;
    const controller = new AbortController();
    this.controller = controller;
    this.lastSentAt = this.now();
    this.inFlight = (async () => {
      try {
        await this.callbacks.send(uid, controller.signal);
        if (controller.signal.aborted || !this.enabled || this.disposed) { return; }
        this.lastSyncedUid = uid;
        if (this.pendingUid === uid) { this.pendingUid = undefined; }
        this.callbacks.pending(this.pendingUid);
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed && this.enabled) { this.callbacks.error(error); }
      }
    })();
    try { await this.inFlight; }
    finally {
      this.inFlight = undefined;
      this.inFlightUid = undefined;
      this.controller = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.controller?.abort();
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }
}
