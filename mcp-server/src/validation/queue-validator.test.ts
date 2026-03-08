import { describe, it, expect } from 'vitest';
import { validateQueueJson } from './queue-validator.js';

describe('queue-validator', () => {
  it('should return valid for correct queue JSON', () => {
    const json = JSON.stringify({
      vulnerabilities: [
        { type: 'injection', url: 'http://test.com' }
      ]
    });
    const result = validateQueueJson(json);
    expect(result.valid).toBe(true);
    expect(result.data?.vulnerabilities).toHaveLength(1);
  });

  it('should return invalid for non-object JSON', () => {
    const result = validateQueueJson('123');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('Expected an object');
  });

  it('should return invalid for missing vulnerabilities property', () => {
    const result = validateQueueJson('{"other": []}');
    expect(result.valid).toBe(false);
    expect(result.message).toContain("Missing 'vulnerabilities' property");
  });

  it('should return invalid for non-array vulnerabilities', () => {
    const result = validateQueueJson('{"vulnerabilities": "not an array"}');
    expect(result.valid).toBe(false);
    expect(result.message).toContain("'vulnerabilities' must be an array");
  });

  it('should return invalid for malformed JSON', () => {
    const result = validateQueueJson('{malformed}');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('Invalid JSON');
  });
});
