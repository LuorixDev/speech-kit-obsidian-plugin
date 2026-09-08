export interface TranslationResultUpdate {
  revision: number;
  isFinal: boolean;
}

/** Session-owned mailbox: inference callbacks never manipulate editor positions. */
export class TranslationResultPool {
  private readonly versions = new Map<string, TranslationResultUpdate>();
  private readonly pending = new Map<
    string,
    {
      text: string;
      update: TranslationResultUpdate;
      resolve: (written: boolean) => void;
    }
  >();
  private scheduled = false;
  private disposed = false;

  constructor(
    private readonly write: (id: string, text: string, provisional: boolean) => boolean,
  ) {}

  enqueue(id: string, text: string, update: TranslationResultUpdate): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const previous = this.versions.get(id);
    if (previous && (previous.revision > update.revision || (previous.isFinal && !update.isFinal)))
      return Promise.resolve(true);
    this.versions.set(id, update);
    this.pending.get(id)?.resolve(true);
    const done = new Promise<boolean>((resolve) => {
      this.pending.set(id, { text, update, resolve });
    });
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
    return done;
  }

  dispose(): void {
    this.disposed = true;
    for (const item of this.pending.values()) item.resolve(false);
    this.pending.clear();
    this.versions.clear();
  }

  private flush(): void {
    this.scheduled = false;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [id, item] of batch) {
      try {
        item.resolve(!this.disposed && this.write(id, item.text, !item.update.isFinal));
      } catch {
        item.resolve(false);
      }
    }
  }
}
