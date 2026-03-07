import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCodexModel } from './codex-models.js';

describe('resolveCodexModel', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.stubGlobal('process', { ...originalEnv, env: { ...originalEnv } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns default models when no env vars are set', () => {
    process.env.CODEX_SMALL_MODEL = '';
    process.env.CODEX_MEDIUM_MODEL = '';
    process.env.CODEX_LARGE_MODEL = '';

    expect(resolveCodexModel('small')).toBe('gpt-5.1-codex-mini');
    expect(resolveCodexModel('medium')).toBe('gpt-5.3-codex');
    expect(resolveCodexModel('large')).toBe('gpt-5.4');
  });

  it('returns env var overrides when set', () => {
    process.env.CODEX_SMALL_MODEL = 'custom-small';
    process.env.CODEX_MEDIUM_MODEL = 'custom-medium';
    process.env.CODEX_LARGE_MODEL = 'custom-large';

    expect(resolveCodexModel('small')).toBe('custom-small');
    expect(resolveCodexModel('medium')).toBe('custom-medium');
    expect(resolveCodexModel('large')).toBe('custom-large');
  });

  it('defaults to medium tier', () => {
    expect(resolveCodexModel()).toBe('gpt-5.3-codex');
  });
});
