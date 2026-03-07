// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

// Production Claude agent execution with retry, git checkpoints, and audit logging

import { fs, path } from 'zx';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';

import { isRetryableError, PentestError } from '../services/error-handling.js';
import { isSpendingCapBehavior } from '../utils/billing-detection.js';
import { Timer } from '../utils/metrics.js';
import { formatTimestamp } from '../utils/formatting.js';
import { AGENT_VALIDATORS, MCP_AGENT_MAPPING } from '../session-manager.js';
import { AuditSession } from '../audit/index.js';
import { createShannonHelperServer } from '../../mcp-server/dist/index.js';
import { AGENTS } from '../session-manager.js';
import type { AgentName } from '../types/index.js';

import { dispatchMessage } from './message-handlers.js';
import { detectExecutionContext, formatErrorOutput, formatCompletionMessage } from './output-formatters.js';
import { createProgressManager } from './progress-manager.js';
import { createAuditLogger } from './audit-logger.js';
import { getActualModelName } from './router-utils.js';
import { resolveModel, type ModelTier } from './models.js';
import { resolveCodexModel } from './codex-models.js';
import { getCodexHome, prepareCodexAuth, resolveAiExecutorBackend } from './codex-auth.js';
import type { ActivityLogger } from '../types/activity-logger.js';

declare global {
  var SHANNON_DISABLE_LOADER: boolean | undefined;
}

export interface ClaudePromptResult {
  result?: string | null | undefined;
  success: boolean;
  duration: number;
  turns?: number | undefined;
  cost: number;
  model?: string | undefined;
  partialCost?: number | undefined;
  apiErrorDetected?: boolean | undefined;
  error?: string | undefined;
  errorType?: string | undefined;
  prompt?: string | undefined;
  retryable?: boolean | undefined;
}

interface StdioMcpServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

type McpServer = ReturnType<typeof createShannonHelperServer> | StdioMcpServer;
interface CodexMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function buildPlaywrightMcpServer(playwrightMcpName: string): StdioMcpServer {
  const userDataDir = `/tmp/${playwrightMcpName}`;
  const isDocker = process.env.SHANNON_DOCKER === 'true';

  const mcpArgs: string[] = [
    '@playwright/mcp@latest',
    '--isolated',
    '--user-data-dir', userDataDir,
  ];

  if (isDocker) {
    mcpArgs.push('--executable-path', '/usr/bin/chromium-browser');
    mcpArgs.push('--browser', 'chromium');
  }

  const envVars: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...process.env,
      PLAYWRIGHT_HEADLESS: 'true',
      ...(isDocker && { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

  return {
    type: 'stdio',
    command: 'npx',
    args: mcpArgs,
    env: envVars,
  };
}

function resolvePlaywrightMcpName(agentName: string | null, logger: ActivityLogger): string | null {
  if (!agentName) {
    return null;
  }

  const promptTemplate = AGENTS[agentName as AgentName].promptTemplate;
  const playwrightMcpName = MCP_AGENT_MAPPING[promptTemplate as keyof typeof MCP_AGENT_MAPPING] || null;
  if (playwrightMcpName) {
    logger.info(`Assigned ${agentName} -> ${playwrightMcpName}`);
  }

  return playwrightMcpName;
}

// Configures MCP servers for agent execution, with Docker-specific Chromium handling
function buildMcpServers(
  sourceDir: string,
  agentName: string | null,
  logger: ActivityLogger
): Record<string, McpServer> {
  // 1. Create the shannon-helper server (always present)
  const shannonHelperServer = createShannonHelperServer(sourceDir);

  const mcpServers: Record<string, McpServer> = {
    'shannon-helper': shannonHelperServer,
  };

  // 2. Look up the agent's Playwright MCP mapping
  const playwrightMcpName = resolvePlaywrightMcpName(agentName, logger);
  if (playwrightMcpName) {
    mcpServers[playwrightMcpName] = buildPlaywrightMcpServer(playwrightMcpName);
  }

  // 4. Return configured servers
  return mcpServers;
}

function buildCodexMcpServers(sourceDir: string, agentName: string | null, logger: ActivityLogger): Record<string, CodexMcpServer> {
  const executorDir = path.dirname(fileURLToPath(import.meta.url));
  const helperServerPath = path.resolve(executorDir, '../../mcp-server/dist/codex-stdio-server.js');
  const mcpServers: Record<string, CodexMcpServer> = {
    'shannon-helper': {
      command: 'node',
      args: [helperServerPath, '--target-dir', sourceDir],
    },
  };

  const playwrightMcpName = resolvePlaywrightMcpName(agentName, logger);
  if (!playwrightMcpName) {
    return mcpServers;
  }

  const playwrightServer = buildPlaywrightMcpServer(playwrightMcpName);
  const isDocker = process.env.SHANNON_DOCKER === 'true';
  mcpServers[playwrightMcpName] = {
    command: playwrightServer.command,
    args: playwrightServer.args,
    env: {
      PLAYWRIGHT_HEADLESS: 'true',
      ...(isDocker && { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }),
    },
  };

  return mcpServers;
}


function buildCodexTodoShim(fullPrompt: string): string {
  const todoInstructions = [
    '<codex_todo_tools>',
    'Codex CLI does not provide a native built-in TodoWrite tool in this environment.',
    'When instructions reference "TodoWrite", use MCP tool `TodoWrite` (alias of `todo_write`).',
    '- `todo_write`/`TodoWrite`: write/replace the full todo list (`todos` array, can be empty).',
    'To append or update one task: call `todo_read`, modify the list, then call `todo_write` with the full list.',
    '- `todo_read`: read current todo list and progress summary.',
    '- `todo_next`: select the next task (and optionally mark in progress).',
    '- `todo_reset`: clear todo state when starting over.',
    '</codex_todo_tools>',
  ].join('\n');

  return `${fullPrompt}\n\n${todoInstructions}`;
}

function outputLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

async function writeErrorLog(
  err: Error & { code?: string; status?: number },
  sourceDir: string,
  fullPrompt: string,
  duration: number
): Promise<void> {
  try {
    const errorLog = {
      timestamp: formatTimestamp(),
      agent: 'claude-executor',
      error: {
        name: err.constructor.name,
        message: err.message,
        code: err.code,
        status: err.status,
        stack: err.stack
      },
      context: {
        sourceDir,
        prompt: fullPrompt.slice(0, 200) + '...',
        retryable: isRetryableError(err)
      },
      duration
    };
    const logPath = path.join(sourceDir, 'error.log');
    await fs.appendFile(logPath, JSON.stringify(errorLog) + '\n');
  } catch {
    // Best-effort error log writing - don't propagate failures
  }
}

export async function validateAgentOutput(
  result: ClaudePromptResult,
  agentName: string | null,
  sourceDir: string,
  logger: ActivityLogger
): Promise<boolean> {
  logger.info(`Validating ${agentName} agent output`);

  try {
    // Check if agent completed successfully
    if (!result.success || !result.result) {
      logger.error('Validation failed: Agent execution was unsuccessful');
      return false;
    }

    // Get validator function for this agent
    const validator = agentName ? AGENT_VALIDATORS[agentName as keyof typeof AGENT_VALIDATORS] : undefined;

    if (!validator) {
      logger.warn(`No validator found for agent "${agentName}" - assuming success`);
      logger.info('Validation passed: Unknown agent with successful result');
      return true;
    }

    logger.info(`Using validator for agent: ${agentName}`, { sourceDir });

    // Apply validation function
    const validationResult = await validator(sourceDir, logger);

    if (validationResult) {
      logger.info('Validation passed: Required files/structure present');
    } else {
      logger.error('Validation failed: Missing required deliverable files');
    }

    return validationResult;

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Validation failed with error: ${errMsg}`);
    return false;
  }
}

// Low-level SDK execution. Handles message streaming, progress, and audit logging.
// Exported for Temporal activities to call single-attempt execution.
export async function runClaudePrompt(
  prompt: string,
  sourceDir: string,
  context: string = '',
  description: string = 'Claude analysis',
  agentName: string | null = null,
  auditSession: AuditSession | null = null,
  logger: ActivityLogger,
  modelTier: ModelTier = 'medium'
): Promise<ClaudePromptResult> {
  // 1. Initialize timing and prompt
  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;

  // 2. Set up progress and audit infrastructure
  const execContext = detectExecutionContext(description);
  const progress = createProgressManager(
    { description, useCleanOutput: execContext.useCleanOutput },
    global.SHANNON_DISABLE_LOADER ?? false
  );
  const auditLogger = createAuditLogger(auditSession);

  const backend = resolveAiExecutorBackend();
  if (backend === 'codex') {
    return runCodexPrompt(
      fullPrompt,
      sourceDir,
      description,
      agentName,
      modelTier,
      timer,
      execContext,
      progress,
      auditLogger,
      logger
    );
  }

  logger.info(`Running Claude Code: ${description}...`);

  // 3. Configure MCP servers
  const mcpServers = buildMcpServers(sourceDir, agentName, logger);

  // 4. Build env vars to pass to SDK subprocesses
  const sdkEnv: Record<string, string> = {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '64000',
  };
  const passthroughVars = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_REGION',
    'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLOUD_ML_REGION',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'ANTHROPIC_SMALL_MODEL',
    'ANTHROPIC_MEDIUM_MODEL',
    'ANTHROPIC_LARGE_MODEL',
  ];
  for (const name of passthroughVars) {
    if (process.env[name]) {
      sdkEnv[name] = process.env[name]!;
    }
  }

  // 5. Configure SDK options
  const options = {
    model: resolveModel(modelTier),
    maxTurns: 10_000,
    cwd: sourceDir,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    mcpServers,
    env: sdkEnv,
  };

  if (!execContext.useCleanOutput) {
    logger.info(`SDK Options: maxTurns=${options.maxTurns}, cwd=${sourceDir}, permissions=BYPASS`);
  }

  let turnCount = 0;
  let result: string | null = null;
  let apiErrorDetected = false;
  let totalCost = 0;

  progress.start();

  try {
    // 6. Process the message stream
    const messageLoopResult = await processMessageStream(
      fullPrompt,
      options,
      { execContext, description, progress, auditLogger, logger },
      timer
    );

    turnCount = messageLoopResult.turnCount;
    result = messageLoopResult.result;
    apiErrorDetected = messageLoopResult.apiErrorDetected;
    totalCost = messageLoopResult.cost;
    const model = messageLoopResult.model;

    // === SPENDING CAP SAFEGUARD ===
    // 7. Defense-in-depth: Detect spending cap that slipped through detectApiError().
    // Uses consolidated billing detection from utils/billing-detection.ts
    if (isSpendingCapBehavior(turnCount, totalCost, result || '')) {
      throw new PentestError(
        `Spending cap likely reached (turns=${turnCount}, cost=$0): ${result?.slice(0, 100)}`,
        'billing',
        true // Retryable - Temporal will use 5-30 min backoff
      );
    }

    // 8. Finalize successful result
    const duration = timer.stop();

    if (apiErrorDetected) {
      logger.warn(`API Error detected in ${description} - will validate deliverables before failing`);
    }

    progress.finish(formatCompletionMessage(execContext, description, turnCount, duration));

    return {
      result,
      success: true,
      duration,
      turns: turnCount,
      cost: totalCost,
      model,
      partialCost: totalCost,
      apiErrorDetected
    };

  } catch (error) {
    // 9. Handle errors — log, write error file, return failure
    const duration = timer.stop();

    const err = error as Error & { code?: string; status?: number };

    await auditLogger.logError(err, duration, turnCount);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, isRetryableError(err)));
    await writeErrorLog(err, sourceDir, fullPrompt, duration);

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: fullPrompt.slice(0, 100) + '...',
      success: false,
      duration,
      cost: totalCost,
      retryable: isRetryableError(err)
    };
  }
}

export async function runCodexPrompt(
  fullPrompt: string,
  sourceDir: string,
  description: string,
  agentName: string | null,
  modelTier: ModelTier,
  timer: Timer,
  execContext: ReturnType<typeof detectExecutionContext>,
  progress: ReturnType<typeof createProgressManager>,
  auditLogger: ReturnType<typeof createAuditLogger>,
  logger: ActivityLogger
): Promise<ClaudePromptResult> {
  const model = resolveCodexModel(modelTier);
  const codexHome = getCodexHome();
  const codexPrompt = buildCodexTodoShim(fullPrompt);
  let turnCount = 0;
  let apiErrorDetected = false;
  const totalCost = 0;

  logger.info(`Running Codex SDK: ${description}...`);
  progress.start();

  try {
    // 1. Ensure CODEX_HOME is writable and auth token is materialized.
    await fs.mkdir(codexHome, { recursive: true });
    await prepareCodexAuth(logger);

    // 2. Configure Codex MCP servers to match Claude wiring.
    const mcpServers = buildCodexMcpServers(sourceDir, agentName, logger);
    const mcpConfig: Record<string, any> = {};
    for (const [name, server] of Object.entries(mcpServers)) {
      mcpConfig[name] = {
        enabled: true,
        command: server.command,
        args: server.args,
        env: server.env,
      };
    }

    // 3. Initialize Codex SDK and process the message stream
    const codex = new Codex({
      config: { mcp_servers: mcpConfig },
      env: Object.fromEntries(
        Object.entries({ ...process.env, CODEX_HOME: codexHome })
          .filter(([, v]) => v !== undefined)
      ) as Record<string, string>,
    });

    const thread = codex.startThread({
      model,
      workingDirectory: sourceDir,
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });

    const deps: MessageLoopDeps = { execContext, description, progress, auditLogger, logger };
    const { events } = await thread.runStreamed(codexPrompt);

    let finalResponse = '';

    for await (const event of events) {
      if (event.type === 'turn.started') {
        turnCount++;
      }

      if (event.type === 'item.started') {
        if (event.item.type === 'mcp_tool_call') {
          await dispatchMessage(
            { type: 'tool_use', name: event.item.tool, input: event.item.arguments as any } as any,
            turnCount,
            deps
          );
        }
      } else if (event.type === 'item.completed') {
        if (event.item.type === 'mcp_tool_call') {
          const toolResult = event.item.result;
          await dispatchMessage(
            { type: 'tool_result', content: toolResult?.content } as any,
            turnCount,
            deps
          );
        } else if (event.item.type === 'agent_message') {
          finalResponse = event.item.text;
          const dispatchResult = await dispatchMessage(
            { type: 'assistant', message: { content: finalResponse } } as any,
            turnCount,
            deps
          );
          if (dispatchResult.type === 'throw') {
            throw dispatchResult.error;
          }
        }
      } else if (event.type === 'turn.failed') {
        throw new Error(event.error.message);
      } else if (event.type === 'error') {
        apiErrorDetected = true;
        logger.warn(`Codex API error: ${event.message}`);
      }
    }

    if (!finalResponse) {
      throw new Error('Codex SDK finished without a final assistant message');
    }

    // 4. Finalize successful result.
    const duration = timer.stop();
    progress.finish(formatCompletionMessage(execContext, description, Math.max(turnCount, 1), duration));

    return {
      result: finalResponse,
      success: true,
      duration,
      turns: Math.max(turnCount, 1),
      cost: totalCost,
      model,
      partialCost: totalCost,
      apiErrorDetected,
    };
  } catch (error) {
    // 5. Handle errors — log, write error file, return failure.
    const duration = timer.stop();
    const err = error as Error & { code?: string; status?: number };

    await auditLogger.logError(err, duration, turnCount);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, isRetryableError(err)));
    await writeErrorLog(err, sourceDir, fullPrompt, duration);

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: fullPrompt.slice(0, 100) + '...',
      success: false,
      duration,
      cost: totalCost,
      retryable: isRetryableError(err),
    };
  }
}

interface MessageLoopResult {
  turnCount: number;
  result: string | null;
  apiErrorDetected: boolean;
  cost: number;
  model?: string | undefined;
}

interface MessageLoopDeps {
  execContext: ReturnType<typeof detectExecutionContext>;
  description: string;
  progress: ReturnType<typeof createProgressManager>;
  auditLogger: ReturnType<typeof createAuditLogger>;
  logger: ActivityLogger;
}

async function processMessageStream(
  fullPrompt: string,
  options: NonNullable<Parameters<typeof query>[0]['options']>,
  deps: MessageLoopDeps,
  timer: Timer
): Promise<MessageLoopResult> {
  const { execContext, description, progress, auditLogger, logger } = deps;
  const HEARTBEAT_INTERVAL = 30000;

  let turnCount = 0;
  let result: string | null = null;
  let apiErrorDetected = false;
  let cost = 0;
  let model: string | undefined;
  let lastHeartbeat = Date.now();

  for await (const message of query({ prompt: fullPrompt, options })) {
    // Heartbeat logging when loader is disabled
    const now = Date.now();
    if (global.SHANNON_DISABLE_LOADER && now - lastHeartbeat > HEARTBEAT_INTERVAL) {
      logger.info(`[${Math.floor((now - timer.startTime) / 1000)}s] ${description} running... (Turn ${turnCount})`);
      lastHeartbeat = now;
    }

    // Increment turn count for assistant messages
    if (message.type === 'assistant') {
      turnCount++;
    }

    const dispatchResult = await dispatchMessage(
      message as { type: string; subtype?: string },
      turnCount,
      { execContext, description, progress, auditLogger, logger }
    );

    if (dispatchResult.type === 'throw') {
      throw dispatchResult.error;
    }

    if (dispatchResult.type === 'complete') {
      result = dispatchResult.result;
      cost = dispatchResult.cost;
      break;
    }

    if (dispatchResult.type === 'continue') {
      if (dispatchResult.apiErrorDetected) {
        apiErrorDetected = true;
      }
      // Capture model from SystemInitMessage, but override with router model if applicable
      if (dispatchResult.model) {
        model = getActualModelName(dispatchResult.model);
      }
    }
  }

  return { turnCount, result, apiErrorDetected, cost, model };
}
