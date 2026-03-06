// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

import type { ActivityLogger } from '../types/activity-logger.js';

export type AiExecutorBackend = 'claude' | 'codex';

const DEFAULT_CODEX_HOME = '/tmp/.codex';
const DEFAULT_CODEX_AUTH_SOURCE = '/app/.codex-host/auth.json';

function hasAnthropicCredentialConfig(): boolean {
  return Boolean(
    process.env.ANTHROPIC_BASE_URL ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.CLAUDE_CODE_USE_BEDROCK === '1' ||
    process.env.CLAUDE_CODE_USE_VERTEX === '1'
  );
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || DEFAULT_CODEX_HOME;
}

export function getCodexAuthSourcePath(): string {
  return process.env.SHANNON_CODEX_AUTH_SOURCE?.trim() || DEFAULT_CODEX_AUTH_SOURCE;
}

export function hasCodexAuthFile(): boolean {
  const sourceAuthPath = getCodexAuthSourcePath();
  const localAuthPath = path.join(getCodexHome(), 'auth.json');
  return existsSync(sourceAuthPath) || existsSync(localAuthPath);
}

export function hasCodexCredentialsConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY) || hasCodexAuthFile();
}

export function resolveAiExecutorBackend(): AiExecutorBackend {
  const configuredBackend = process.env.SHANNON_EXECUTOR?.trim().toLowerCase();
  if (configuredBackend === 'codex') {
    return 'codex';
  }
  if (configuredBackend === 'claude') {
    return 'claude';
  }
  if (hasAnthropicCredentialConfig()) {
    return 'claude';
  }
  if (hasCodexCredentialsConfigured()) {
    return 'codex';
  }
  return 'claude';
}

export async function prepareCodexAuth(
  logger: ActivityLogger
): Promise<void> {
  const sourceAuthPath = getCodexAuthSourcePath();
  if (!existsSync(sourceAuthPath)) {
    return;
  }

  const codexHome = getCodexHome();
  const targetAuthPath = path.join(codexHome, 'auth.json');

  try {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.copyFile(sourceAuthPath, targetAuthPath);
    await fs.chmod(targetAuthPath, 0o600);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to materialize Codex auth.json into CODEX_HOME', {
      sourceAuthPath,
      targetAuthPath,
      error: errMsg,
    });
  }
}
