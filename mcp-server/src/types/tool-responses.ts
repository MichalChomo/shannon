// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Tool Response Type Definitions
 *
 * Defines structured response formats for MCP tools to ensure
 * consistent error handling and success reporting.
 */

export interface ErrorResponse {
  status: 'error';
  message: string;
  errorType: string; // ValidationError, FileSystemError, CryptoError, etc.
  retryable: boolean;
  context?: Record<string, unknown>;
}

export interface SuccessResponse {
  status: 'success';
  message: string;
}

export interface SaveDeliverableResponse {
  status: 'success';
  message: string;
  filepath: string;
  deliverableType: string;
  validated: boolean; // true if queue JSON was validated
}

export interface GenerateTotpResponse {
  status: 'success';
  message: string;
  totpCode: string;
  timestamp: string;
  expiresIn: number; // seconds until expiration
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoPriority = 'high' | 'medium' | 'low';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface TodoSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

export interface TodoWriteResponse {
  status: 'success';
  message: string;
  revision: number;
  summary: TodoSummary;
  todos: TodoItem[];
  nextTodo: TodoItem | null;
}

export interface TodoReadResponse {
  status: 'success';
  message: string;
  revision: number;
  summary: TodoSummary;
  todos: TodoItem[];
}

export interface TodoNextResponse {
  status: 'success';
  message: string;
  revision: number;
  todo: TodoItem | null;
}

export interface TodoResetResponse {
  status: 'success';
  message: string;
  revision: number;
}

export type ToolResponse =
  | ErrorResponse
  | SuccessResponse
  | SaveDeliverableResponse
  | GenerateTotpResponse
  | TodoWriteResponse
  | TodoReadResponse
  | TodoNextResponse
  | TodoResetResponse;

export interface ToolResultContent {
  type: string;
  text: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError: boolean;
}

/**
 * Helper to create tool result from response
 * MCP tools should return this format
 */
export function createToolResult(response: ToolResponse): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2),
      },
    ],
    isError: response.status === 'error',
  };
}
