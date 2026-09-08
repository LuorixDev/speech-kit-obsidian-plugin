import { describe, expect, it, vi } from 'vitest';
import { TranslationResultPool } from '../src/session/translation-result-pool';

describe('TranslationResultPool', () => {
  it('coalesces revisions without letting producers write directly', async () => {
    const write = vi.fn(() => true);
    const pool = new TranslationResultPool(write);
    const first = pool.enqueue('a', 'preview', { revision: 1, isFinal: false });
    const final = pool.enqueue('a', 'final', { revision: 2, isFinal: true });
    expect(write).not.toHaveBeenCalled();
    await Promise.all([first, final]);
    expect(write).toHaveBeenCalledExactlyOnceWith('a', 'final', false);
    await pool.enqueue('a', 'late preview', { revision: 3, isFinal: false });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('publishes previews and then finalizes the same sentence', async () => {
    const write = vi.fn(() => true);
    const pool = new TranslationResultPool(write);
    await pool.enqueue('a', 'preview', { revision: 1, isFinal: false });
    await pool.enqueue('b', 'other', { revision: 1, isFinal: false });
    await pool.enqueue('a', 'final', { revision: 2, isFinal: true });
    expect(write.mock.calls).toEqual([
      ['a', 'preview', true],
      ['b', 'other', true],
      ['a', 'final', false],
    ]);
  });

  it('settles pending work without writing after disposal', async () => {
    const write = vi.fn(() => true);
    const pool = new TranslationResultPool(write);
    const pending = pool.enqueue('a', 'preview', {
      revision: 1,
      isFinal: false,
    });
    pool.dispose();
    expect(await pending).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
