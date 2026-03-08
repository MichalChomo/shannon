import { describe, it, expect } from 'vitest';
import { createToolResult } from './tool-responses.js';

describe('tool-responses', () => {
  describe('createToolResult', () => {
    it('should create a success result', () => {
      const response = {
        status: 'success' as const,
        message: 'Test success',
      };
      const result = createToolResult(response);

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe('text');
      const parsedContent = JSON.parse(result.content[0]!.text);
      expect(parsedContent).toEqual(response);
    });

    it('should create an error result', () => {
      const response = {
        status: 'error' as const,
        message: 'Test error',
        errorType: 'TestError',
        retryable: true,
      };
      const result = createToolResult(response);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe('text');
      const parsedContent = JSON.parse(result.content[0]!.text);
      expect(parsedContent).toEqual(response);
    });
  });
});
