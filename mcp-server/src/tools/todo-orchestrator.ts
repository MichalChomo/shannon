// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * todo orchestration MCP Tools
 *
 * Provides a lightweight, in-memory task system that emulates TodoWrite-style
 * workflows for Codex CLI execution.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  createToolResult,
  type TodoItem,
  type TodoPriority,
  type TodoReadResponse,
  type TodoResetResponse,
  type TodoStatus,
  type TodoSummary,
  type TodoWriteResponse,
  type TodoNextResponse,
  type ToolResult,
} from '../types/tool-responses.js';
import { createGenericError } from '../utils/error-formatter.js';

const TODO_STATUS_VALUES = ['pending', 'in_progress', 'completed'] as const;
const TODO_PRIORITY_VALUES = ['high', 'medium', 'low'] as const;
const DEFAULT_PRIORITY: TodoPriority = 'medium';

const TodoInputItemSchema = z.object({
  id: z.string().min(1).optional().describe('Stable task ID. If omitted, an ID is generated.'),
  content: z.string().min(1).describe('Task description'),
  status: z.enum(TODO_STATUS_VALUES).describe('Task status'),
  priority: z.enum(TODO_PRIORITY_VALUES).optional().describe('Task priority (default: medium)'),
  notes: z.string().min(1).optional().describe('Optional implementation notes'),
});

export const TodoWriteInputSchema = z.object({
  todos: z.array(TodoInputItemSchema)
    .min(1)
    .describe('Full current todo list. This call replaces previous list state.'),
});

export const TodoReadInputSchema = z.object({
  status: z.enum(TODO_STATUS_VALUES).optional().describe('Optional status filter'),
  include_completed: z.boolean().optional().describe('Set false to hide completed items when no status filter is set'),
});

export const TodoNextInputSchema = z.object({
  mark_in_progress: z.boolean().optional().describe('If true, mark a selected pending task as in_progress'),
});

export const TodoResetInputSchema = z.object({});

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;
export type TodoReadInput = z.infer<typeof TodoReadInputSchema>;
export type TodoNextInput = z.infer<typeof TodoNextInputSchema>;
export type TodoResetInput = z.infer<typeof TodoResetInputSchema>;

interface TodoStore {
  todos: TodoItem[];
  revision: number;
}

interface TodoOrchestrationHandlers {
  todoWrite: (args: TodoWriteInput) => Promise<ToolResult>;
  todoRead: (args: TodoReadInput) => Promise<ToolResult>;
  todoNext: (args: TodoNextInput) => Promise<ToolResult>;
  todoReset: (_args: TodoResetInput) => Promise<ToolResult>;
}

function createInitialStore(): TodoStore {
  return {
    todos: [],
    revision: 0,
  };
}

function sanitizeTodoText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function makeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  return slug.slice(0, 36) || 'task';
}

function ensureUniqueId(candidate: string, usedIds: Set<string>): string {
  if (!usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }

  let suffix = 2;
  while (usedIds.has(`${candidate}-${suffix}`)) {
    suffix += 1;
  }

  const resolved = `${candidate}-${suffix}`;
  usedIds.add(resolved);
  return resolved;
}

function createSummary(todos: readonly TodoItem[]): TodoSummary {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;

  for (const todo of todos) {
    if (todo.status === 'pending') {
      pending += 1;
      continue;
    }

    if (todo.status === 'in_progress') {
      inProgress += 1;
      continue;
    }

    completed += 1;
  }

  return {
    total: todos.length,
    pending,
    inProgress,
    completed,
  };
}

function priorityRank(priority: TodoPriority): number {
  if (priority === 'high') {
    return 0;
  }
  if (priority === 'medium') {
    return 1;
  }
  return 2;
}

function selectNextTodo(todos: readonly TodoItem[]): TodoItem | null {
  for (const todo of todos) {
    if (todo.status === 'in_progress') {
      return todo;
    }
  }

  let candidate: TodoItem | null = null;
  let candidateRank = Number.POSITIVE_INFINITY;

  for (const todo of todos) {
    if (todo.status !== 'pending') {
      continue;
    }

    const rank = priorityRank(todo.priority);
    if (!candidate || rank < candidateRank) {
      candidate = todo;
      candidateRank = rank;
    }
  }

  return candidate;
}

function normalizeTodos(input: TodoWriteInput, store: TodoStore): TodoItem[] {
  const now = new Date().toISOString();
  const existingById = new Map(store.todos.map((todo) => [todo.id, todo]));
  const existingByContent = new Map(store.todos.map((todo) => [todo.content, todo]));
  const usedIds = new Set<string>();
  const normalized: TodoItem[] = [];

  for (let index = 0; index < input.todos.length; index += 1) {
    const todo = input.todos[index]!;
    const content = sanitizeTodoText(todo.content);
    const requestedId = todo.id ? sanitizeTodoText(todo.id) : '';
    const existingByText = existingByContent.get(content);
    const baseId = requestedId || existingByText?.id || `${makeSlug(content)}-${index + 1}`;
    const id = ensureUniqueId(baseId, usedIds);
    const existing = existingById.get(id) || (existingByText?.id === id ? existingByText : undefined);
    const priority = todo.priority ?? existing?.priority ?? DEFAULT_PRIORITY;
    const notes = todo.notes ? sanitizeTodoText(todo.notes) : existing?.notes;

    normalized.push({
      id,
      content,
      status: todo.status as TodoStatus,
      priority,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(notes !== undefined && { notes }),
    });
  }

  return normalized;
}

function filterTodos(todos: readonly TodoItem[], args: TodoReadInput): TodoItem[] {
  if (args.status) {
    return todos.filter((todo) => todo.status === args.status);
  }

  if (args.include_completed === false) {
    return todos.filter((todo) => todo.status !== 'completed');
  }

  return [...todos];
}

export function createTodoOrchestrationHandlers(): TodoOrchestrationHandlers {
  const store = createInitialStore();

  return {
    async todoWrite(args: TodoWriteInput): Promise<ToolResult> {
      try {
        store.todos = normalizeTodos(args, store);
        store.revision += 1;

        const summary = createSummary(store.todos);
        const nextTodo = selectNextTodo(store.todos);
        const response: TodoWriteResponse = {
          status: 'success',
          message: `Todo list updated (${summary.total} tasks, ${summary.completed} completed)`,
          revision: store.revision,
          summary,
          todos: store.todos,
          nextTodo,
        };

        return createToolResult(response);
      } catch (error) {
        return createToolResult(createGenericError(error, false));
      }
    },

    async todoRead(args: TodoReadInput): Promise<ToolResult> {
      try {
        const todos = filterTodos(store.todos, args);
        const summary = createSummary(store.todos);
        const response: TodoReadResponse = {
          status: 'success',
          message: 'Current todo state',
          revision: store.revision,
          summary,
          todos,
        };

        return createToolResult(response);
      } catch (error) {
        return createToolResult(createGenericError(error, false));
      }
    },

    async todoNext(args: TodoNextInput): Promise<ToolResult> {
      try {
        const shouldMarkInProgress = args.mark_in_progress === true;
        let nextTodo = selectNextTodo(store.todos);

        if (shouldMarkInProgress && nextTodo && nextTodo.status === 'pending') {
          const now = new Date().toISOString();
          store.todos = store.todos.map((todo) => {
            if (todo.id !== nextTodo!.id) {
              return todo;
            }

            return {
              ...todo,
              status: 'in_progress',
              updatedAt: now,
            };
          });
          store.revision += 1;
          nextTodo = selectNextTodo(store.todos);
        }

        const response: TodoNextResponse = {
          status: 'success',
          message: nextTodo ? `Next task: ${nextTodo.content}` : 'No pending or in-progress tasks',
          revision: store.revision,
          todo: nextTodo,
        };

        return createToolResult(response);
      } catch (error) {
        return createToolResult(createGenericError(error, false));
      }
    },

    async todoReset(_args: TodoResetInput): Promise<ToolResult> {
      try {
        store.todos = [];
        store.revision += 1;
        const response: TodoResetResponse = {
          status: 'success',
          message: 'Todo list cleared',
          revision: store.revision,
        };
        return createToolResult(response);
      } catch (error) {
        return createToolResult(createGenericError(error, false));
      }
    },
  };
}

export function createTodoOrchestrationTools() {
  const handlers = createTodoOrchestrationHandlers();

  return {
    handlers,
    tools: [
      tool(
        'todo_write',
        'Replace current todo/task list state. Use when instructions mention TodoWrite.',
        TodoWriteInputSchema.shape,
        handlers.todoWrite
      ),
      tool(
        'todo_read',
        'Read current todo/task list with optional status filtering.',
        TodoReadInputSchema.shape,
        handlers.todoRead
      ),
      tool(
        'todo_next',
        'Get the next task to work on (in_progress first, otherwise highest-priority pending).',
        TodoNextInputSchema.shape,
        handlers.todoNext
      ),
      tool(
        'todo_reset',
        'Clear all current todo/task entries.',
        TodoResetInputSchema.shape,
        handlers.todoReset
      ),
    ],
  };
}
