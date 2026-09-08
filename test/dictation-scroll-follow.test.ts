import { EditorState } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import {
  dictationAnchorExtension,
  setAnchorEffect,
} from '../src/editor/dictation-anchor-extension';
import { DictationScrollFollower } from '../src/editor/dictation-scroll-follow';

function setup(top = 600) {
  const scrollDOM = Object.assign(new EventTarget(), {
    scrollTop: top,
    scrollHeight: 1000,
    clientHeight: 400,
  });
  let measure: { read: () => number; write: (bottom: number) => void } | undefined;
  const follower = new DictationScrollFollower({
    scrollDOM,
    requestMeasure: (request: typeof measure) => {
      measure = request;
    },
  } as unknown as EditorView);
  let state = EditorState.create({ doc: 'source', extensions: dictationAnchorExtension() });
  state = state.update({ effects: setAnchorEffect.of(6) }).state;
  return {
    follower,
    scrollDOM,
    update(anchor = true) {
      const transaction = state.update({ effects: anchor ? setAnchorEffect.of(6) : [] });
      follower.update({ startState: state, transactions: [transaction] } as unknown as ViewUpdate);
      state = transaction.state;
    },
    flush() {
      const pending = measure;
      measure = undefined;
      if (pending) pending.write(pending.read());
    },
    scroll(top: number) {
      scrollDOM.scrollTop = top;
      scrollDOM.dispatchEvent(new Event('scroll'));
    },
  };
}

describe('dictation bottom following', () => {
  it('follows growth from both transcript and delayed translation updates', () => {
    const app = setup();
    app.update();
    app.scrollDOM.scrollHeight = 1300;
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(900);
    app.update();
    app.scrollDOM.scrollHeight = 1800;
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(1400);
  });

  it('does not pull a reader who was already above the bottom', () => {
    const app = setup(100);
    app.update();
    app.scrollDOM.scrollHeight = 2000;
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(100);
  });

  it('cancels pending follow on upward scrolling and resumes at the bottom', () => {
    const app = setup();
    app.update();
    app.scroll(200);
    app.scrollDOM.scrollHeight = 1300;
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(200);
    app.scroll(900);
    app.update();
    app.scrollDOM.scrollHeight = 1800;
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(1400);
  });

  it('does not interpret content growth as scrolling away', () => {
    const app = setup();
    app.update();
    app.scrollDOM.scrollHeight = 1600;
    app.scroll(600);
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(1200);
  });

  it('cancels on upward wheel input before the browser updates scroll position', () => {
    const app = setup();
    app.update();
    app.scrollDOM.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: -100 }));
    app.scrollDOM.scrollHeight = 1600;
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(600);
  });

  it('ignores decoration-only updates and queued work after disposal', () => {
    const app = setup();
    app.update(false);
    app.scrollDOM.scrollHeight = 1600;
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(600);
    app.update();
    app.follower.destroy();
    app.flush();
    expect(app.scrollDOM.scrollTop).toBe(600);
  });
});
