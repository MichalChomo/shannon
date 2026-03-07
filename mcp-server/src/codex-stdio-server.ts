// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Shannon Helper MCP stdio server for Codex CLI integration.
 *
 * Claude SDK can consume in-process MCP servers directly. Codex CLI expects
 * external MCP stdio servers, so this bridge exposes the same Shannon helper
 * tools over JSON-RPC on stdio.
 */

import path from 'node:path';

import { DeliverableType } from './types/deliverables.js';
import { GenerateTotpInputSchema, generateTotp } from './tools/generate-totp.js';
import { SaveDeliverableInputSchema, createSaveDeliverableHandler } from './tools/save-deliverable.js';
import { createToolResult, type ToolResult } from './types/tool-responses.js';
import { createValidationError } from './utils/error-formatter.js';

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const SAVE_DELIVERABLE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    deliverable_type: {
      type: 'string',
      enum: Object.values(DeliverableType),
      description: 'Type of deliverable to save',
    },
    content: {
      type: 'string',
      minLength: 1,
      description: 'File content (markdown for analysis/evidence, JSON for queues). Optional if file_path is provided.',
    },
    file_path: {
      type: 'string',
      description: 'Path to a file whose contents should be used as the deliverable content.',
    },
  },
  required: ['deliverable_type'],
  additionalProperties: false,
};

const GENERATE_TOTP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    secret: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Z2-7]+$',
      description: 'Base32-encoded TOTP secret',
    },
  },
  required: ['secret'],
  additionalProperties: false,
};

const TOOLS: McpToolDefinition[] = [
  {
    name: 'save_deliverable',
    description: 'Saves deliverable files with automatic validation.',
    inputSchema: SAVE_DELIVERABLE_SCHEMA,
  },
  {
    name: 'generate_totp',
    description: 'Generates 6-digit TOTP code for authentication.',
    inputSchema: GENERATE_TOTP_SCHEMA,
  },
];

function writeResponse(payload: Record<string, unknown>): void {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respondResult(id: JsonRpcId, result: unknown): void {
  writeResponse({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function respondError(id: JsonRpcId | undefined, error: JsonRpcError): void {
  if (id === undefined) {
    return;
  }

  writeResponse({
    jsonrpc: '2.0',
    id,
    error,
  });
}

function parseContentLength(headers: string): number | null {
  const lines = headers.split(/\r?\n/);
  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (name !== 'content-length') {
      continue;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function extractFrame(
  buffer: Buffer<ArrayBufferLike>
): { body: Buffer<ArrayBufferLike>; rest: Buffer<ArrayBufferLike> } | null {
  const separator = '\r\n\r\n';
  let headerEnd = buffer.indexOf(separator);
  let separatorLength = separator.length;

  if (headerEnd === -1) {
    headerEnd = buffer.indexOf('\n\n');
    separatorLength = 2;
  }

  if (headerEnd === -1) {
    return null;
  }

  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const contentLength = parseContentLength(headerText);
  if (contentLength === null) {
    throw new Error('Invalid MCP frame: missing Content-Length header');
  }

  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + contentLength;
  if (buffer.length < bodyEnd) {
    return null;
  }

  return {
    body: buffer.subarray(bodyStart, bodyEnd),
    rest: buffer.subarray(bodyEnd),
  };
}

function resolveTargetDir(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--target-dir') {
      continue;
    }

    const candidate = argv[i + 1];
    if (candidate) {
      return path.resolve(candidate);
    }
  }

  if (process.env.SHANNON_TARGET_DIR) {
    return path.resolve(process.env.SHANNON_TARGET_DIR);
  }

  return process.cwd();
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  saveDeliverable: ReturnType<typeof createSaveDeliverableHandler>
): Promise<ToolResult> {
  if (name === 'save_deliverable') {
    const parsed = SaveDeliverableInputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return createToolResult(createValidationError(parsed.error.message, true));
    }
    return saveDeliverable(parsed.data);
  }

  if (name === 'generate_totp') {
    const parsed = GenerateTotpInputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return createToolResult(createValidationError(parsed.error.message, false));
    }
    return generateTotp(parsed.data);
  }

  return createToolResult(createValidationError(`Unknown tool: ${name}`, false));
}

async function handleRequest(
  request: JsonRpcRequest,
  targetDir: string,
  saveDeliverable: ReturnType<typeof createSaveDeliverableHandler>
): Promise<void> {
  const id = request.id;
  const method = request.method;

  if (!method) {
    respondError(id, { code: -32600, message: 'Invalid request: missing method' });
    return;
  }

  if (method === 'initialize') {
    const protocolVersion =
      typeof request.params?.protocolVersion === 'string'
        ? request.params.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;

    if (id === undefined) {
      return;
    }

    respondResult(id, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'shannon-helper',
        version: '1.0.0',
      },
      instructions: `Shannon helper tools for ${targetDir}`,
    });
    return;
  }

  if (method === 'tools/list') {
    if (id === undefined) {
      return;
    }

    respondResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = typeof request.params?.name === 'string' ? request.params.name : '';
    if (!toolName) {
      respondError(id, { code: -32602, message: 'Invalid params: missing tool name' });
      return;
    }

    const rawArgs = request.params?.arguments;
    const toolArgs = typeof rawArgs === 'object' && rawArgs !== null
      ? rawArgs as Record<string, unknown>
      : undefined;

    const result = await handleToolCall(toolName, toolArgs, saveDeliverable);
    if (id === undefined) {
      return;
    }

    respondResult(id, result);
    return;
  }

  if (method === 'ping') {
    if (id === undefined) {
      return;
    }

    respondResult(id, {});
    return;
  }

  if (id !== undefined) {
    respondError(id, { code: -32601, message: `Method not found: ${method}` });
  }
}

async function startServer(): Promise<void> {
  const targetDir = resolveTargetDir(process.argv.slice(2));
  const saveDeliverable = createSaveDeliverableHandler(targetDir);

  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, data]);

    while (true) {
      let frame: { body: Buffer<ArrayBufferLike>; rest: Buffer<ArrayBufferLike> } | null = null;
      try {
        frame = extractFrame(buffer);
      } catch (error) {
        process.stderr.write(`shannon-helper MCP framing error: ${String(error)}\n`);
        buffer = Buffer.alloc(0);
        return;
      }

      if (!frame) {
        return;
      }

      buffer = frame.rest;
      const payloadText = frame.body.toString('utf8');

      let parsed: JsonRpcRequest | null = null;
      try {
        parsed = JSON.parse(payloadText) as JsonRpcRequest;
      } catch {
        continue;
      }

      void handleRequest(parsed, targetDir, saveDeliverable).catch((error) => {
        process.stderr.write(`shannon-helper MCP request error: ${String(error)}\n`);
        respondError(parsed?.id, { code: -32603, message: 'Internal error' });
      });
    }
  });

  process.stdin.on('error', (error) => {
    process.stderr.write(`shannon-helper MCP stdin error: ${String(error)}\n`);
  });
}

void startServer();
