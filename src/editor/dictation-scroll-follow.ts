import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { dictationAnchorStateField, setAnchorEffect } from './dictation-anchor-extension';

const BOTTOM_TOLERANCE_PX = 32;

/** One follow state per editor, shared by transcription and delayed translations. */
export class DictationScrollFollower {
  private following: boolean;
  private lastTop: number;
  private disposed = false;

  constructor(private readonly view: EditorView) {
    this.following = this.atBottom();
    this.lastTop = view.scrollDOM.scrollTop;
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    view.scrollDOM.addEventListener('wheel', this.onWheel, { passive: true });
  }

  update(update: ViewUpdate): void {
    if (
      !this.following ||
      update.startState.field(dictationAnchorStateField, false)?.pos == null ||
      !update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setAnchorEffect)),
      )
    )
      return;

    // Measure after layout, coalescing multiple results in the same frame.
    // User scrolling can still cancel this request before its write phase.
    this.view.requestMeasure({
      key: this,
      read: () => Math.max(0, this.view.scrollDOM.scrollHeight - this.view.scrollDOM.clientHeight),
      write: (bottom) => {
        if (this.disposed || !this.following) return;
        this.view.scrollDOM.scrollTop = bottom;
        this.lastTop = this.view.scrollDOM.scrollTop;
      },
    });
  }

  destroy(): void {
    this.disposed = true;
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.view.scrollDOM.removeEventListener('wheel', this.onWheel);
  }

  private atBottom(): boolean {
    const { scrollHeight, scrollTop, clientHeight } = this.view.scrollDOM;
    return clientHeight > 0 && scrollHeight - scrollTop - clientHeight <= BOTTOM_TOLERANCE_PX;
  }

  private readonly onScroll = (): void => {
    const top = this.view.scrollDOM.scrollTop;
    if (this.atBottom()) this.following = true;
    else if (top < this.lastTop) this.following = false;
    // Growing text can increase the bottom distance without user scrolling.
    // That must not disable an already active follow operation.
    this.lastTop = top;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0) this.following = false;
  };
}

export const dictationScrollFollowExtension = ViewPlugin.fromClass(DictationScrollFollower);
