import { defineConfig } from '@vscode/test-cli';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(absolute) : entry.name.endsWith('.test.js') ? [absolute] : [];
  });
}

export default defineConfig({
  // VS Code's test host may start with its installation directory as cwd.
  files: testFiles(path.join(root, 'out', 'test')),
  extensionDevelopmentPath: root,
  ...(process.env.VSCODE_TEST_EXECUTABLE
    ? { useInstallation: { fromPath: process.env.VSCODE_TEST_EXECUTABLE } } : {}),
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  mocha: { timeout: 10000 }
});
