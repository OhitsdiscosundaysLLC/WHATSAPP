import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAuthStateProvider } from './fileAuthStateProvider';

describe('FileAuthStateProvider', () => {
  let dir: string;
  let provider: FileAuthStateProvider;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-auth-test-'));
    // Only reserve the path; let init()/load() create the actual directory contents.
    await fs.rm(dir, { recursive: true, force: true });
    provider = new FileAuthStateProvider(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hasExistingSession returns false before any session exists', async () => {
    await provider.init();
    expect(await provider.hasExistingSession()).toBe(false);
  });

  it('init() creates the auth directory', async () => {
    await provider.init();
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('hasExistingSession reflects creds.json registered flag without loading signal keys', async () => {
    await provider.init();
    await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ registered: true }), 'utf8');
    expect(await provider.hasExistingSession()).toBe(true);
  });

  it('hasExistingSession is false when creds.json exists but is not registered', async () => {
    await provider.init();
    await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ registered: false }), 'utf8');
    expect(await provider.hasExistingSession()).toBe(false);
  });

  it('clear() removes the entire auth directory', async () => {
    await provider.init();
    await fs.writeFile(path.join(dir, 'creds.json'), JSON.stringify({ registered: true }), 'utf8');

    await provider.clear();

    await expect(fs.stat(dir)).rejects.toThrow();
  });
});
