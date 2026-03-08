import { describe, it, expect } from 'vitest';
import { createTodoOrchestrationHandlers } from './todo-orchestrator.js';

describe('todo-orchestrator', () => {
  it('should handle basic todo lifecycle', async () => {
    const handlers = createTodoOrchestrationHandlers();

    // 1. Initial state
    const readResult1 = await handlers.todoRead({});
    const parsedRead1 = JSON.parse(readResult1.content[0]!.text);
    expect(parsedRead1.todos).toHaveLength(0);

    // 2. Write todos
    const writeResult = await handlers.todoWrite({
      todos: [
        { content: 'Task 1', status: 'pending', priority: 'high' },
        { content: 'Task 2', status: 'pending', priority: 'medium' },
      ],
    });
    const parsedWrite = JSON.parse(writeResult.content[0]!.text);
    expect(parsedWrite.todos).toHaveLength(2);
    expect(parsedWrite.nextTodo.content).toBe('Task 1');

    // 3. Get next todo
    const nextResult = await handlers.todoNext({ mark_in_progress: true });
    const parsedNext = JSON.parse(nextResult.content[0]!.text);
    expect(parsedNext.todo.content).toBe('Task 1');
    expect(parsedNext.todo.status).toBe('in_progress');

    // 4. Read with filter
    const readResult2 = await handlers.todoRead({ status: 'in_progress' });
    const parsedRead2 = JSON.parse(readResult2.content[0]!.text);
    expect(parsedRead2.todos).toHaveLength(1);
    expect(parsedRead2.todos[0].content).toBe('Task 1');

    // 5. Reset
    await handlers.todoReset({});
    const readResult3 = await handlers.todoRead({});
    const parsedRead3 = JSON.parse(readResult3.content[0]!.text);
    expect(parsedRead3.todos).toHaveLength(0);
  });
});
