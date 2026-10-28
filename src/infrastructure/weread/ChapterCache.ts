export type LoadedWeReadChapter = { text: string; format: string };

/** Per-account, in-memory only. Clearing invalidates even requests already in flight. */
export class ChapterCache {
  private readonly chapters = new Map<string, LoadedWeReadChapter>();
  private readonly pending = new Map<string, Promise<LoadedWeReadChapter>>();
  private generation = 0;

  load(key: string, loader: () => Promise<LoadedWeReadChapter>): Promise<LoadedWeReadChapter> {
    const cached = this.chapters.get(key);
    if (cached) {
      this.chapters.delete(key);
      this.chapters.set(key, cached);
      return Promise.resolve(cached);
    }
    const current = this.pending.get(key);
    if (current) { return current; }
    const generation = this.generation;
    const promise = loader().then((chapter) => {
      if (generation === this.generation) {
        this.chapters.set(key, chapter);
        while (this.chapters.size > 3) { this.chapters.delete(this.chapters.keys().next().value!); }
      }
      return chapter;
    }).finally(() => {
      if (this.pending.get(key) === promise) { this.pending.delete(key); }
    });
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void {
    this.generation++;
    this.chapters.clear();
    this.pending.clear();
  }
}
