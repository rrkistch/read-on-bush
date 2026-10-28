import { lineIndexForOffset, wrapChapter, type WrappedChapter } from './epubPagination';
import type { WeReadChapter } from './WeRead';

/** One loaded chapter. Async boundary transitions are owned by WeReadReader, not this model. */
export class WeReadChapterBook {
  private offset: number;
  private wrapped?: { width: number; value: WrappedChapter };

  constructor(
    readonly chapter: WeReadChapter,
    readonly chapterIndex: number,
    readonly chapterCount: number,
    readonly text: string,
    offset = 0,
    public privateMode = false
  ) { this.offset = Number.isFinite(offset) ? Math.min(text.length, Math.max(0, Math.floor(offset))) : 0; }

  get charOffset(): number { return this.offset; }

  getScreen(width: number, count: number): { lines: string[]; images: never[] } {
    const wrapped = this.lines(width);
    const index = lineIndexForOffset(wrapped.starts, this.offset);
    return { lines: wrapped.lines.slice(index, index + count), images: [] };
  }

  getProgressLabel(showTitle = true): string {
    const prefix = this.privateMode || !showTitle ? '' : this.chapter.title + ' · ';
    const percent = this.text.length ? Math.floor(100 * this.offset / this.text.length) : 0;
    return prefix + '第 ' + (this.chapterIndex + 1) + '/' + this.chapterCount + ' 章 · 本章 ' + percent + '%';
  }

  next(width: number, count: number): boolean {
    const wrapped = this.lines(width);
    const next = lineIndexForOffset(wrapped.starts, this.offset) + count;
    if (next >= wrapped.starts.length) { return false; }
    this.offset = wrapped.starts[next];
    return true;
  }

  previous(width: number, count: number): boolean {
    if (this.offset === 0) { return false; }
    const wrapped = this.lines(width);
    const previous = Math.max(0, lineIndexForOffset(wrapped.starts, this.offset) - count);
    this.offset = wrapped.starts[previous] ?? 0;
    return true;
  }

  lastPage(width: number, count: number): void {
    const starts = this.lines(width).starts;
    this.offset = starts[Math.max(0, starts.length - count)] ?? 0;
  }

  private lines(width: number): WrappedChapter {
    if (this.wrapped?.width !== width) {
      this.wrapped = { width, value: wrapChapter(this.text, Math.max(1, width)) };
    }
    return this.wrapped.value;
  }
}
