export type WeReadSource = {
  kind: 'weread';
  accountId: string;
  bookId: string;
  author?: string;
  remoteFormat?: string;
  onShelf: boolean;
};

export type WeReadProgress = {
  chapterUid: number;
  chapterIndex: number;
  charOffset: number;
  updatedAt: number;
  pendingChapterUid?: number;
};

export type WeReadChapter = { uid: number; title: string; index: number };
export type WeReadShelfBook = { bookId: string; title: string; author?: string; format?: string };

export function isWeReadBook(book: { source?: WeReadSource }): boolean {
  return book.source?.kind === 'weread';
}
