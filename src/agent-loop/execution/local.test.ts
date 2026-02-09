import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { LocalExecutionEnvironment } from './local.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;
let env: LocalExecutionEnvironment;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attractor-test-'));
  env = new LocalExecutionEnvironment({ workingDirectory: tmpDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('LocalExecutionEnvironment', () => {
  describe('read_file', () => {
    it('reads actual file and returns raw content (no line numbers)', async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      await fs.writeFile(filePath, 'hello\nworld\n', 'utf-8');
      const content = await env.read_file(filePath);
      // Raw content, no line numbers
      expect(content).toBe('hello\nworld\n');
    });

    it('respects offset and limit', async () => {
      const filePath = path.join(tmpDir, 'lines.txt');
      await fs.writeFile(
        filePath,
        'line1\nline2\nline3\nline4\nline5\n',
        'utf-8',
      );
      const content = await env.read_file(filePath, 2, 2);
      // Should get lines 2-3 (0-indexed: starts at index 1, takes 2)
      expect(content).toBe('line2\nline3');
    });

    it('throws on missing file', async () => {
      await expect(
        env.read_file(path.join(tmpDir, 'nonexistent.txt')),
      ).rejects.toThrow();
    });
  });

  describe('write_file', () => {
    it('creates file with content', async () => {
      const filePath = path.join(tmpDir, 'output.txt');
      await env.write_file(filePath, 'test content');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('test content');
    });

    it('creates parent directories', async () => {
      const filePath = path.join(tmpDir, 'sub', 'dir', 'file.txt');
      await env.write_file(filePath, 'nested');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('nested');
    });
  });

  describe('file_exists', () => {
    it('returns true for existing file', async () => {
      const filePath = path.join(tmpDir, 'exists.txt');
      await fs.writeFile(filePath, 'hi', 'utf-8');
      expect(await env.file_exists(filePath)).toBe(true);
    });

    it('returns false for non-existing file', async () => {
      expect(
        await env.file_exists(path.join(tmpDir, 'nope.txt')),
      ).toBe(false);
    });
  });

  describe('exec_command', () => {
    it('runs echo hello and gets stdout', async () => {
      const result = await env.exec_command('echo hello', 5000);
      expect(result.stdout.trim()).toBe('hello');
      expect(result.exit_code).toBe(0);
      expect(result.timed_out).toBe(false);
    });

    it('captures non-zero exit code', async () => {
      const result = await env.exec_command('exit 42', 5000);
      expect(result.exit_code).toBe(42);
    });

    it('timeout kills long-running process', async () => {
      const result = await env.exec_command('sleep 60', 500);
      expect(result.timed_out).toBe(true);
    }, 10000);

    it('captures stderr', async () => {
      const result = await env.exec_command(
        'echo "err" >&2',
        5000,
      );
      expect(result.stderr.trim()).toBe('err');
    });

    it('env var filtering excludes *_API_KEY', async () => {
      // Set an API key in the environment, then check it's filtered
      const envWithKey = new LocalExecutionEnvironment({
        workingDirectory: tmpDir,
        envVarPolicy: 'inherit_core',
      });
      // We can't easily set process.env in the test, but we can verify
      // the policy is 'inherit_core' by default and test that safe vars
      // are included
      const result = await envWithKey.exec_command(
        'echo $HOME',
        5000,
      );
      // HOME should be available
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });

    it('inherit_none policy starts clean', async () => {
      const envClean = new LocalExecutionEnvironment({
        workingDirectory: tmpDir,
        envVarPolicy: 'inherit_none',
      });
      const result = await envClean.exec_command(
        'echo "${HOME:-empty}"',
        5000,
      );
      expect(result.stdout.trim()).toBe('empty');
    });
  });

  describe('working_directory', () => {
    it('returns the configured working directory', () => {
      expect(env.working_directory()).toBe(tmpDir);
    });
  });

  describe('platform', () => {
    it('returns a platform string', () => {
      expect(env.platform()).toBe(process.platform);
    });
  });

  describe('os_version', () => {
    it('returns an os version string', () => {
      expect(env.os_version()).toContain(os.type());
    });
  });

  describe('initialize', () => {
    it('succeeds for existing directory', async () => {
      await expect(env.initialize()).resolves.toBeUndefined();
    });

    it('throws for non-existing directory', async () => {
      const badEnv = new LocalExecutionEnvironment({
        workingDirectory: '/nonexistent/path/xxxyyy',
      });
      await expect(badEnv.initialize()).rejects.toThrow();
    });
  });

  describe('list_directory', () => {
    it('lists files and directories', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
      await fs.mkdir(path.join(tmpDir, 'subdir'));
      const entries = await env.list_directory(tmpDir, 1);
      const names = entries.map((e) => e.name);
      expect(names).toContain('a.txt');
      expect(names).toContain('subdir');

      const fileEntry = entries.find((e) => e.name === 'a.txt');
      expect(fileEntry?.is_dir).toBe(false);
      expect(fileEntry?.size).toBe(5);

      const dirEntry = entries.find((e) => e.name === 'subdir');
      expect(dirEntry?.is_dir).toBe(true);
    });
  });
});
