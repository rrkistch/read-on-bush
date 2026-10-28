import * as assert from 'assert';
import { ReadingLocationStack } from '../domain/search';

suite('ReadingLocationStack', () => {
  test('returns search locations in reverse navigation order', () => {
    const stack = new ReadingLocationStack();
    stack.push({ bookId: 'book-1', target: { kind: 'page', pageIndex: 1 } });
    stack.push({ bookId: 'book-1', target: { kind: 'page', pageIndex: 2 } });

    assert.deepStrictEqual(stack.pop('book-1'), { kind: 'page', pageIndex: 2 });
    assert.deepStrictEqual(stack.pop('book-1'), { kind: 'page', pageIndex: 1 });
    assert.strictEqual(stack.pop('book-1'), undefined);
  });

  test('does not pop a location for a different book', () => {
    const stack = new ReadingLocationStack();
    stack.push({ bookId: 'book-1', target: { kind: 'page', pageIndex: 1 } });

    assert.strictEqual(stack.pop('book-2'), undefined);
    assert.strictEqual(stack.size, 1);
  });
});
