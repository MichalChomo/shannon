import { describe, it, expect } from 'vitest';
import { DeliverableType, DELIVERABLE_FILENAMES, isQueueType } from './deliverables.js';

describe('deliverables', () => {
  it('should have correct mapping for REPORT', () => {
    expect(DeliverableType.REPORT).toBe('REPORT');
    expect(DELIVERABLE_FILENAMES[DeliverableType.REPORT]).toBe('comprehensive_security_assessment_report.md');
  });

  it('should correctly identify queue types', () => {
    expect(isQueueType(DeliverableType.INJECTION_QUEUE)).toBe(true);
    expect(isQueueType(DeliverableType.REPORT)).toBe(false);
  });
});
