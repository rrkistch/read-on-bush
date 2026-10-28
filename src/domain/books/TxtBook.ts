import type {
  BookData,
  BookProgressPort,
  ReadingDisplayState,
  ReadingNotifier,
  TxtDisplayPort
} from '.';

export type TxtBookDependencies = {
  display: TxtDisplayPort;
  progress: Pick<BookProgressPort, 'updateBookProcess'>;
  notifier: ReadingNotifier;
};

export class TxtBook {
  public book: BookData;
  public contents: string[];
  public isReading: boolean;
  private process: number;
  private charOffset = 0;
  private disposed = false;

  constructor(
    book: BookData,
    contents: string[],
    private readonly dependencies: TxtBookDependencies
  ) {
    this.book = book;
    this.contents = contents;
    this.isReading = true;
    this.process = Math.min(book.process, Math.max(this.contents.length - 1, 0));
    this.book.process = this.process;
    this.charOffset = Math.max(0, Math.min(book.txtCharOffset ?? 0, this.contents[this.process]?.length ?? 0));
  }

  prevLine(): void {
    if (this.disposed || !this.isReading) {
      return;
    }
    if (this.dependencies.display.getPreviousPosition) {
      const previous = this.dependencies.display.getPreviousPosition(this.getDisplayState());
      if (previous) { this.setProcess(previous.process, true, previous.charOffset); }
      else { this.dependencies.notifier.info('已经是第一页了'); }
      return;
    }

    if (this.process < 1) {
      this.dependencies.notifier.info('已经是第一页了');
      return;
    }

    const step = this.dependencies.display.getPrevProcessStep(this.getDisplayState());
    this.setProcess(this.process - step);
  }

  nextLine(showEndMessage = true): boolean {
    if (this.disposed || !this.isReading) {
      return false;
    }
    if (this.dependencies.display.getNextPosition) {
      const next = this.dependencies.display.getNextPosition(this.getDisplayState());
      if (!next) {
        if (showEndMessage) { this.dependencies.notifier.info('已经是最后一页了'); }
        return false;
      }
      this.setProcess(next.process, true, next.charOffset);
      return true;
    }

    if (this.process >= this.contents.length - 1) {
      if (showEndMessage) { this.dependencies.notifier.info('已经是最后一页了'); }
      return false;
    }

    const step = this.dependencies.display.getNextProcessStep(this.getDisplayState());
    this.setProcess(this.process + step);
    return true;
  }

  jumpLine(process: number, persistProgress = true, charOffset = 0): void {
    if (this.disposed || !this.isReading) {
      return;
    }

    this.setProcess(process, persistProgress, charOffset);
  }

  getDisplayState(): ReadingDisplayState {
    return {
      content: (this.contents[this.process] || '').slice(this.charOffset),
      contents: this.contents,
      book: this.book,
      process: this.process,
      charOffset: this.charOffset,
      total: this.contents.length,
      isReading: this.isReading
    };
  }

  pause(): void {
    this.isReading = false;
    this.dependencies.display.pause(this.getDisplayState());
  }

  start(): void {
    if (this.disposed) {
      return;
    }
    this.isReading = true;
    this.dependencies.display.render(this.getDisplayState());
  }

  dispose(): void {
    this.disposed = true;
    this.isReading = false;
    this.contents = [];
  }

  private setProcess(process: number, persistProgress = true, charOffset = 0): void {
    const maxProcess = Math.max(this.contents.length - 1, 0);
    this.process = Math.min(Math.max(process, 0), maxProcess);
    this.charOffset = Math.max(0, Math.min(charOffset, this.contents[this.process]?.length ?? 0));
    this.dependencies.display.render(this.getDisplayState());
    if (persistProgress) {
      this.book.process = this.process;
      if (this.charOffset > 0) { this.book.txtCharOffset = this.charOffset; }
      else { delete this.book.txtCharOffset; }
      this.dependencies.progress.updateBookProcess(this.book.id, this.process, this.charOffset);
    }
  }
}
