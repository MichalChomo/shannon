import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCodexPrompt, runClaudePrompt } from './claude-executor.js';
import { Codex } from '@openai/codex-sdk';
import { fs } from 'zx';
import * as codexAuth from './codex-auth.js';
import * as messageHandlers from './message-handlers.js';
import * as progressManager from './progress-manager.js';
import * as auditLogger from './audit-logger.js';
import * as outputFormatters from './output-formatters.js';
import * as models from './models.js';

vi.mock('zx', () => ({
  fs: {
    mkdir: vi.fn(),
    pathExists: vi.fn(),
    readFile: vi.fn(),
    remove: vi.fn(),
    appendFile: vi.fn(),
  },
  path: {
    join: (...args: string[]) => args.join('/'),
    resolve: (...args: string[]) => args.join('/'),
    dirname: vi.fn().mockReturnValue('/mock/dir'),
  }
}));
vi.mock('node:url', () => ({
  fileURLToPath: vi.fn().mockReturnValue('/mock/path.js'),
}));
vi.mock('@openai/codex-sdk');
vi.mock('./codex-auth.js');
vi.mock('./codex-models.js');
vi.mock('./models.js');
vi.mock('./message-handlers.js');
vi.mock('./progress-manager.js');
vi.mock('./audit-logger.js');
vi.mock('./output-formatters.js');
vi.mock('../session-manager.js');
vi.mock('../utils/metrics.js');

import { AGENTS, MCP_AGENT_MAPPING } from '../session-manager.js';
import { resolveCodexModel } from './codex-models.js';

describe('runCodexPrompt', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockProgress = {
    start: vi.fn(),
    finish: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };

  const mockAuditLogger = {
    logLlmResponse: vi.fn(),
    logToolCall: vi.fn(),
    logError: vi.fn(),
  };

  const mockTimer = {
    stop: vi.fn().mockReturnValue(1000),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(codexAuth.getCodexHome).mockReturnValue('/tmp/.codex');
    vi.mocked(resolveCodexModel).mockReturnValue('gpt-5.4');
    vi.mocked(models.resolveModel).mockReturnValue('claude-3-5-sonnet-20240620');
    vi.mocked(progressManager.createProgressManager).mockReturnValue(mockProgress as any);
    vi.mocked(auditLogger.createAuditLogger).mockReturnValue(mockAuditLogger as any);
    vi.mocked(outputFormatters.detectExecutionContext).mockReturnValue({ useCleanOutput: false } as any);
    vi.mocked(outputFormatters.formatErrorOutput).mockReturnValue([]);
    vi.mocked(outputFormatters.formatCompletionMessage).mockReturnValue('completed');
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fs.appendFile).mockResolvedValue(undefined as any);
    vi.mocked(codexAuth.prepareCodexAuth).mockResolvedValue(undefined);
    vi.mocked(codexAuth.resolveAiExecutorBackend).mockReturnValue('codex');

    // Mock session manager data
    (AGENTS as any)['test-agent'] = {
      name: 'test-agent',
      displayName: 'Test Agent',
      promptTemplate: 'test-template',
    };
    (MCP_AGENT_MAPPING as any)['test-template'] = 'test-mcp';
  });

  it('successfully handles a simple conversation', async () => {
    const mockEvents = (async function* () {
      yield { type: 'turn.started' };
      yield {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Hello from Codex' },
      };
    })();

    const mockThread = {
      runStreamed: vi.fn().mockResolvedValue({ events: mockEvents }),
    };

    vi.mocked(Codex).mockImplementation(function() {
      return {
        startThread: vi.fn().mockReturnValue(mockThread),
      } as any;
    });

    vi.mocked(messageHandlers.dispatchMessage).mockResolvedValue({ type: 'continue' } as any);

    const result = await runCodexPrompt(
      'Say hello',
      '/work',
      'test-desc',
      'test-agent',
      'medium',
      mockTimer as any,
      { useCleanOutput: false } as any,
      mockProgress as any,
      mockAuditLogger as any,
      mockLogger as any
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe('Hello from Codex');
    expect(result.turns).toBe(1);
    expect(mockProgress.start).toHaveBeenCalled();
    expect(mockProgress.finish).toHaveBeenCalled();
  });

  it('handles tool calls correctly', async () => {
    const mockEvents = (async function* () {
      yield { type: 'turn.started' };
      yield {
        type: 'item.started',
        item: { type: 'mcp_tool_call', tool: 'test_tool', arguments: { arg: 1 } },
      };
      yield {
        type: 'item.completed',
        item: { type: 'mcp_tool_call', tool: 'test_tool', result: { content: [{ type: 'text', text: 'tool result' }] } },
      };
      yield {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Finished' },
      };
    })();

    const mockThread = {
      runStreamed: vi.fn().mockResolvedValue({ events: mockEvents }),
    };

    vi.mocked(Codex).mockImplementation(function() {
      return {
        startThread: vi.fn().mockReturnValue(mockThread),
      } as any;
    });

    vi.mocked(messageHandlers.dispatchMessage).mockResolvedValue({ type: 'continue' } as any);

    const result = await runCodexPrompt(
      'Use tool',
      '/work',
      'test-desc',
      'test-agent',
      'medium',
      mockTimer as any,
      { useCleanOutput: false } as any,
      mockProgress as any,
      mockAuditLogger as any,
      mockLogger as any
    );

    expect(result.success).toBe(true);
    expect(messageHandlers.dispatchMessage).toHaveBeenCalledTimes(3); // tool_use, tool_result, assistant
    expect(messageHandlers.dispatchMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'tool_use', name: 'test_tool' }),
      1,
      expect.anything()
    );
  });

  it('handles turn.failed event', async () => {
    const mockEvents = (async function* () {
      yield { type: 'turn.started' };
      yield { type: 'turn.failed', error: { message: 'Something went wrong' } };
    })();

    const mockThread = {
      runStreamed: vi.fn().mockResolvedValue({ events: mockEvents }),
    };

    vi.mocked(Codex).mockImplementation(function() {
      return {
        startThread: vi.fn().mockReturnValue(mockThread),
      } as any;
    });

    const result = await runCodexPrompt(
      'Fail me',
      '/work',
      'test-desc',
      'test-agent',
      'medium',
      mockTimer as any,
      { useCleanOutput: false } as any,
      mockProgress as any,
      mockAuditLogger as any,
      mockLogger as any
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Something went wrong');
  });

  it('handles error when no assistant message is received', async () => {
    const mockEvents = (async function* () {
      yield { type: 'turn.started' };
    })();

    const mockThread = {
      runStreamed: vi.fn().mockResolvedValue({ events: mockEvents }),
    };

    vi.mocked(Codex).mockImplementation(function() {
      return {
        startThread: vi.fn().mockReturnValue(mockThread),
      } as any;
    });

    const result = await runCodexPrompt(
      'Nothing',
      '/work',
      'test-desc',
      'test-agent',
      'medium',
      mockTimer as any,
      { useCleanOutput: false } as any,
      mockProgress as any,
      mockAuditLogger as any,
      mockLogger as any
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('finished without a final assistant message');
  });

  it('runClaudePrompt delegates to runCodexPrompt when backend is codex', async () => {
    vi.mocked(codexAuth.resolveAiExecutorBackend).mockReturnValue('codex');

    const mockEvents = (async function* () {
      yield { type: 'turn.started' };
      yield {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Hello from Codex via ClaudePrompt' },
      };
    })();

    const mockThread = {
      runStreamed: vi.fn().mockResolvedValue({ events: mockEvents }),
    };

    vi.mocked(Codex).mockImplementation(function() {
      return {
        startThread: vi.fn().mockReturnValue(mockThread),
      } as any;
    });

    const result = await runClaudePrompt(
      'Say hello',
      '/work',
      '',
      'test-desc',
      'test-agent',
      null,
      mockLogger as any,
      'medium'
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe('Hello from Codex via ClaudePrompt');
    expect(codexAuth.resolveAiExecutorBackend).toHaveBeenCalled();
  });
});
