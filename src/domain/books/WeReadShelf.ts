import type { BookData } from './BookData';
import type { WeReadShelfBook } from './WeRead';

export function mergeWeReadShelf(
  existing: readonly BookData[], accountId: string, incoming: readonly WeReadShelfBook[], now = Date.now()
): BookData[] {
  const byId = new Map(incoming.map((book) => [book.bookId, book]));
  const result = existing.map((book) => {
    if (book.source?.accountId !== accountId) { return book; }
    const remote = byId.get(book.source.bookId);
    byId.delete(book.source.bookId);
    return {
      ...book,
      name: remote?.title ?? book.name,
      source: {
        ...book.source, author: remote?.author ?? book.source.author,
        remoteFormat: remote?.format ?? book.source.remoteFormat, onShelf: !!remote
      }
    };
  });
  let order = existing.reduce((max, book) => Math.max(max, book.order ?? 0), 0);
  for (const remote of byId.values()) {
    result.push({
      id: 'weread:' + accountId + ':' + remote.bookId,
      name: remote.title, url: 'weread://' + accountId + '/' + encodeURIComponent(remote.bookId),
      format: 'weread', process: 0, createdAt: now, order: ++order,
      source: {
        kind: 'weread', accountId, bookId: remote.bookId, author: remote.author,
        remoteFormat: remote.format, onShelf: true
      }
    });
  }
  return result;
}

export function visibleWeReadBooks(books: readonly BookData[], accountId?: string): BookData[] {
  return books.filter((book) => !book.source ||
    (book.source.accountId === accountId && book.source.onShelf));
}
