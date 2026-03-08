import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createSaveDeliverableHandler } from './save-deliverable.js';
import { DeliverableType } from '../types/deliverables.js';

// Mock fs and other dependencies if needed, or use a temp directory
// For simplicity, let's use a temp directory or mock saveDeliverableFile

vi.mock('../utils/file-operations.js', () => ({
  saveDeliverableFile: vi.fn((targetDir, filename, content) => path.join(targetDir, filename)),
}));

describe('save-deliverable tool', () => {
  const targetDir = '/tmp/test-deliverables';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should save a REPORT deliverable', async () => {
    const handler = createSaveDeliverableHandler(targetDir);
    const result = await handler({
      deliverable_type: DeliverableType.REPORT,
      content: '# Comprehensive Report\n\nAll good.',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('Deliverable saved successfully: comprehensive_security_assessment_report.md');
  });

  it('should error if neither content nor file_path is provided', async () => {
    const handler = createSaveDeliverableHandler(targetDir);
    const result = await handler({
      deliverable_type: DeliverableType.REPORT,
    } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('"message": "Either \\"content\\" or \\"file_path\\" must be provided"');
  });
});
