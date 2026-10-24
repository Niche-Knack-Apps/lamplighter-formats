'use strict';
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('conversion, parser safety, CLI, and reader compatibility regressions', () => {
  execFileSync(process.env.PYTHON || 'python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_convert.py', '-v'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 120000, stdio: 'pipe'
  });
});
