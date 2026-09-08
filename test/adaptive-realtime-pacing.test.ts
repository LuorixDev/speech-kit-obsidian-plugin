import { describe, expect, it } from 'vitest';
import { AdaptiveRealtimePacing } from '../src/translation/adaptive-realtime-pacing';

function sample(pacing: AdaptiveRealtimePacing, at: number, processing = 2000, sessionId = 's') {
  pacing.observe(
    {
      sessionId,
      utteranceId: String(at),
      revision: 0,
      processingDurationMs: processing,
      utteranceDurationMs: 2000,
    },
    at,
  );
}

describe('adaptive realtime translation pacing', () => {
  it('scales the recovery gap with long translations instead of capping it at 1.5 seconds', () => {
    const pacing = new AdaptiveRealtimePacing();
    pacing.observeTranslation(10000);
    for (let at = 0; at <= 180000; at += 2000) sample(pacing, at);
    expect(pacing.delayMs(180000)).toBe(10000);
    for (let at = 182000; at <= 400000; at += 2000) sample(pacing, at, 100);
    expect(pacing.delayMs(400000)).toBe(0);
  });
  it('requires sustained samples and adjusts at most once every five seconds', () => {
    const pacing = new AdaptiveRealtimePacing();
    for (let at = 0; at <= 8000; at += 2000) sample(pacing, at);
    expect(pacing.delayMs(8000)).toBe(0);
    sample(pacing, 10000);
    expect(pacing.delayMs(10000)).toBe(100);
    sample(pacing, 12000);
    expect(pacing.delayMs(12000)).toBe(100);
    sample(pacing, 16000);
    expect(pacing.delayMs(16000)).toBe(200);
  });

  it('does not repeatedly count the whole audio for revised drafts', () => {
    const pacing = new AdaptiveRealtimePacing();
    for (let revision = 0; revision <= 5; revision++) {
      pacing.observe(
        {
          sessionId: 's',
          utteranceId: 'one',
          revision,
          processingDurationMs: 2000,
          utteranceDurationMs: (revision + 1) * 2000,
        },
        revision * 2000,
      );
    }
    expect(pacing.delayMs(10000)).toBe(100);
  });

  it('keeps the GPU available when transcription is fast', () => {
    const pacing = new AdaptiveRealtimePacing();
    for (let at = 0; at <= 60000; at += 2000) sample(pacing, at, 200);
    expect(pacing.delayMs(60000)).toBe(0);
  });

  it('gradually recovers after slow samples leave the long window', () => {
    const pacing = new AdaptiveRealtimePacing();
    for (let at = 0; at <= 30000; at += 2000) sample(pacing, at);
    expect(pacing.delayMs(30000)).toBeGreaterThan(0);
    for (let at = 32000; at <= 240000; at += 2000) sample(pacing, at, 100);
    expect(pacing.delayMs(240000)).toBe(0);
  });

  it('caps waiting and does not carry pressure into a new session or long silence', () => {
    const pacing = new AdaptiveRealtimePacing();
    for (let at = 0; at <= 180000; at += 2000) sample(pacing, at);
    expect(pacing.delayMs(180000)).toBe(1500);
    expect(pacing.delayMs(230000)).toBe(0);
    sample(pacing, 230000, 200, 'new-session');
    expect(pacing.delayMs(230000)).toBe(0);
  });
});
