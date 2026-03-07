import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCodexHome, getCodexAuthSourcePath, resolveAiExecutorBackend, hasCodexAuthFile } from './codex-auth.js';
import { existsSync } from 'fs';

vi.mock('fs');
vi.mock('fs/promises');

describe('codex-auth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.stubGlobal('process', { ...originalEnv, env: { ...originalEnv } });
    vi.mocked(existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getCodexHome returns default or env var', () => {
    expect(getCodexHome()).toBe('/tmp/.codex');
    process.env.CODEX_HOME = '/custom/home';
    expect(getCodexHome()).toBe('/custom/home');
  });

  it('getCodexAuthSourcePath returns default or env var', () => {
    expect(getCodexAuthSourcePath()).toBe('/app/.codex-host/auth.json');
    process.env.SHANNON_CODEX_AUTH_SOURCE = '/custom/auth.json';
    expect(getCodexAuthSourcePath()).toBe('/custom/auth.json');
  });

  it('hasCodexAuthFile checks source and local paths', () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      if (path === '/app/.codex-host/auth.json') return true;
      return false;
    });
    expect(hasCodexAuthFile()).toBe(true);

    vi.mocked(existsSync).mockReturnValue(false);
    expect(hasCodexAuthFile()).toBe(false);
  });

  it('resolveAiExecutorBackend selects correctly based on configuration', () => {
    // Explicit selection via SHANNON_EXECUTOR
    process.env.SHANNON_EXECUTOR = 'codex';
    expect(resolveAiExecutorBackend()).toBe('codex');

    process.env.SHANNON_EXECUTOR = 'claude';
    expect(resolveAiExecutorBackend()).toBe('claude');

    // Default to claude if no credentials
    delete process.env.SHANNON_EXECUTOR;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(resolveAiExecutorBackend()).toBe('claude');

    // Select claude if Anthropic key is set
    process.env.ANTHROPIC_API_KEY = 'sk-ant-...';
    expect(resolveAiExecutorBackend()).toBe('claude');

    // Select codex if only OpenAI key is set
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-proj-...';
    expect(resolveAiExecutorBackend()).toBe('codex');
  });
});
