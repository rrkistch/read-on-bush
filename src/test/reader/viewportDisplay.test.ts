import * as assert from 'assert';
import { EventEmitter, type ExtensionContext, type Terminal } from 'vscode';
import { PaginatedReaderDisplay } from '../../presentation/reader/PaginatedReaderDisplay';
import { TerminalSurface } from '../../presentation/readerSurfaces/TerminalSurface';
import type { ReaderSurface, ReaderSurfaceFrame, SurfaceDimensions } from '../../presentation/readerSurfaces/ReaderSurface';
import { createReaderSurfaceFrame } from '../../presentation/readerSurfaces/ReaderFrame';
import { resolveCamouflageLayout, formatCamouflageLayout } from '../../presentation/reader/CamouflageLayout';
import { clearScreen, resolveBuiltinTemplate } from '../../presentation/reader/CamouflageRenderer';

suite('Viewport-aware reader display', () => {
  test('rendering and pagination share visible capacity, including resize while concealed', () => {
    const resize = new EventEmitter<SurfaceDimensions>();
    let dimensions = { columns: 32, rows: 5 };
    let frame: ReaderSurfaceFrame | undefined;
    const calls: number[] = [];
    const surface: ReaderSurface = {
      onDidResize: resize.event, getDimensions: () => dimensions,
      publishFrame: (value) => { frame = value; },
      publishIdle: () => {}, publishHint: () => {}, clear: () => {},
      setInputHandler: () => {}, focus: () => {}, dispose: () => resize.dispose()
    };
    const display = new PaginatedReaderDisplay({ next: 'n', prev: 'p', stop: 's', jump: 'j', viewImage: 'i' }, surface);
    display.bind({
      getScreen: (_, rows) => { calls.push(rows); return { lines: Array(rows).fill('小说正文'), images: [] }; },
      getProgressLabel: () => '42%'
    }, { template: resolveBuiltinTemplate('docker'), lineWidth: 0, lineCount: 8, showChapterTitle: true, layout: 'auto' });
    display.reveal();
    assert.strictEqual(display.getLineCount(), 4);
    assert.strictEqual(calls.at(-1), 4);
    assert.strictEqual(frame?.lines.length, 5);
    dimensions = { columns: 24, rows: 3 };
    resize.fire(dimensions);
    assert.strictEqual(display.getLineCount(), 2);
    assert.strictEqual(calls.at(-1), 2);
    assert.strictEqual(frame?.lines.length, 3);
    display.concealContent();
    dimensions = { columns: 24, rows: 2 };
    resize.fire(dimensions);
    assert.strictEqual(frame?.mode, 'debugTemplate');
    assert.ok(!frame?.screen.includes('小说正文'));
    assert.ok(frame!.lines.length <= 2);
    display.dispose(); surface.dispose();
  });

  test('the first PTY frame uses initial dimensions, not the oversized queued fallback', () => {
    const output: string[] = [];
    const surface = new TerminalSurface({ subscriptions: [] } as unknown as ExtensionContext,
      () => ({ show: () => {}, dispose: () => {} }) as unknown as Terminal);
    const template = resolveBuiltinTemplate('docker');
    surface.onDidWrite((value) => output.push(value));
    surface.onDidResize((dimensions) => {
      const layout = resolveCamouflageLayout(template, 0, 3, dimensions, 'auto');
      surface.publishFrame(createReaderSurfaceFrame(formatCamouflageLayout(layout, ['当前正文'], '42%'), template, 'real'));
    });
    surface.publishFrame(createReaderSurfaceFrame(clearScreen + 'oversized queued frame', template, 'real'));
    surface.open({ columns: 32, rows: 5 });
    assert.ok(output.join('').includes('当前正文'));
    assert.ok(!output.join('').includes('oversized queued frame'));
    const frames = output.filter((value) => value.startsWith(clearScreen));
    assert.strictEqual(frames.length, 1);
    assert.ok(frames[0].split('\r\n').length <= 5);
    assert.deepStrictEqual(surface.getDimensions(), { columns: 32, rows: 5 });
    surface.dispose();
  });
});
