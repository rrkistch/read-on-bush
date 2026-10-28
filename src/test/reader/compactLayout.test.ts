import * as assert from 'assert';
import { resolveBuiltinTemplate, getTextWidth, clearScreen } from '../../presentation/reader/CamouflageRenderer';
import { resolveCamouflageLayout, formatCamouflageLayout, formatDebugCamouflageLayout } from '../../presentation/reader/CamouflageLayout';
import { DEFAULT_CUSTOM_TERMINAL_TEMPLATE, parseCustomTerminalTemplate } from '../../presentation/readerTemplates/CustomTemplate';
import type { ResolvedTerminalTemplate } from '../../presentation/readerTemplates';

function templates(): ResolvedTerminalTemplate[] {
  const custom = parseCustomTerminalTemplate(DEFAULT_CUSTOM_TERMINAL_TEMPLATE);
  assert.ok(custom.ok);
  return [
    ...(['buildLog', 'claudeCli', 'serverLog', 'vite', 'docker'] as const).map(resolveBuiltinTemplate),
    { key: 'custom:test', requestedStyle: 'custom', template: custom.value.template }
  ];
}

suite('Camouflage viewport layout', () => {
  test('every built-in style and custom template fit a small viewport', () => {
    for (const template of templates()) {
      for (const [columns, rows] of [[48, 9], [30, 5], [20, 3], [10, 1]]) {
        const layout = resolveCamouflageLayout(template, 0, 6, { columns, rows }, 'auto');
        assert.strictEqual(layout.compact, true, template.key);
        const screen = formatCamouflageLayout(layout, Array(layout.lineCount).fill('短文'), '很长的章节标题 · 全书 42%');
        const lines = screen.slice(clearScreen.length).split('\r\n');
        assert.ok(lines.length <= rows, template.key + ' overflows height');
        assert.ok(lines.every((line) => getTextWidth(line) < columns), template.key + ' wraps');
        assert.ok(screen.includes('短文'));
        const concealed = formatDebugCamouflageLayout(layout).slice(clearScreen.length).split('\r\n');
        assert.ok(concealed.length <= rows);
        assert.ok(concealed.every((line) => getTextWidth(line) < columns));
      }
    }
  });

  test('auto returns to full chrome when there is enough space; full is opt-in legacy layout', () => {
    const template = resolveBuiltinTemplate('docker');
    assert.strictEqual(resolveCamouflageLayout(template, 0, 3, { columns: 120, rows: 60 }, 'auto').compact, false);
    assert.strictEqual(resolveCamouflageLayout(template, 0, 3, { columns: 40, rows: 5 }, 'full').resolved, template);
    assert.strictEqual(resolveCamouflageLayout(template, 0, 3, undefined, 'auto').compact, true);
  });

  test('short final pages keep the compact footer at the same row', () => {
    const layout = resolveCamouflageLayout(resolveBuiltinTemplate('docker'), 0, 3, { columns: 48, rows: 9 }, 'auto');
    const full = formatCamouflageLayout(layout, ['甲', '乙', '丙'], '42%').split('\r\n');
    const short = formatCamouflageLayout(layout, ['丁'], '99%').split('\r\n');
    assert.strictEqual(full.length, short.length);
    assert.ok(short.at(-1)?.includes('99%'));
    assert.ok(!short.join('').includes('keys:'));
  });
});
