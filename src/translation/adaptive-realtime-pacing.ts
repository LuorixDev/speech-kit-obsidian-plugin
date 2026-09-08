export interface TranscriptionTiming {
  sessionId: string;
  utteranceId: string;
  revision: number;
  processingDurationMs: number;
  utteranceDurationMs: number;
}

const WINDOW_MS = 45_000;
const ADJUST_MS = 5_000;

/** Estimate ASR pressure from sustained processing time, never GPU utilization. */
export class AdaptiveRealtimePacing {
  private sessionId: string | undefined;
  private samples: { at: number; processing: number; audio: number }[] = [];
  private readonly utterances = new Map<string, { revision: number; audio: number; at: number }>();
  private lastAdjustment = 0;
  private delay = 0;
  private translationDurationMs = 0;

  observeTranslation(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.translationDurationMs =
      this.translationDurationMs === 0
        ? durationMs
        : this.translationDurationMs * 0.8 + durationMs * 0.2;
  }

  observe(timing: TranscriptionTiming, now = performance.now()): void {
    if (
      !Number.isFinite(timing.processingDurationMs) ||
      timing.processingDurationMs < 0 ||
      !Number.isFinite(timing.utteranceDurationMs) ||
      timing.utteranceDurationMs <= 0
    )
      return;
    if (this.sessionId !== timing.sessionId) {
      this.sessionId = timing.sessionId;
      this.samples = [];
      this.utterances.clear();
      this.delay = 0;
      this.lastAdjustment = now;
    }
    const previous = this.utterances.get(timing.utteranceId);
    if (previous && timing.revision <= previous.revision) return;
    const audio = Math.max(previous?.audio ?? 0, timing.utteranceDurationMs);
    this.samples.push({
      at: now,
      processing: timing.processingDurationMs,
      audio: audio - (previous?.audio ?? 0),
    });
    this.utterances.set(timing.utteranceId, { revision: timing.revision, audio, at: now });
    this.samples = this.samples.filter((sample) => sample.at >= now - WINDOW_MS);
    for (const [id, item] of this.utterances) {
      if (item.at < now - WINDOW_MS) this.utterances.delete(id);
    }
    const first = this.samples[0];
    if (
      !first ||
      this.samples.length < 5 ||
      now - first.at < 10_000 ||
      now - this.lastAdjustment < ADJUST_MS
    )
      return;
    this.lastAdjustment = now;
    const totals = this.samples.reduce(
      (sum, sample) => ({
        processing: sum.processing + sample.processing,
        audio: sum.audio + sample.audio,
      }),
      { processing: 0, audio: 0 },
    );
    if (totals.audio < 5_000) return;
    const ratio = totals.processing / totals.audio;
    if (ratio > 0.75) this.delay = Math.min(1500, this.delay + 100);
    else if (ratio < 0.45) this.delay = Math.max(0, this.delay - 50);
  }

  delayMs(now = performance.now()): number {
    const latest = this.samples.at(-1);
    // A long silence must not preserve an obsolete throttling decision.
    if (!latest || now - latest.at > WINDOW_MS) return 0;
    // A fixed 1.5 second pause barely helps when inference takes ten seconds.
    // Scale the pause with measured translation time as ASR pressure rises.
    return Math.min(30_000, Math.max(this.delay, (this.translationDurationMs * this.delay) / 1500));
  }
}
