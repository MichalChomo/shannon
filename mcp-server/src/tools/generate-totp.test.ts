import { describe, it, expect, vi } from 'vitest';
import { generateTotp } from './generate-totp.js';

describe('generate_totp tool', () => {
  it('should generate a TOTP code with valid secret', async () => {
    // Example base32 secret: 'JBSWY3DPEHPK3PXP' (RFC 4648)
    const secret = 'JBSWY3DPEHPK3PXP';
    const result = await generateTotp({ secret });

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    const parsedContent = JSON.parse(result.content[0]!.text);
    expect(parsedContent.status).toBe('success');
    expect(parsedContent.totpCode).toMatch(/^\d{6}$/);
    expect(parsedContent.expiresIn).toBeGreaterThan(0);
    expect(parsedContent.expiresIn).toBeLessThanOrEqual(30);
  });

  it('should generate consistent TOTP code for same time', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    
    // Fix the time
    const fixedTime = 1609459200000; // 2021-01-01 00:00:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(fixedTime);

    const result1 = await generateTotp({ secret });
    const parsed1 = JSON.parse(result1.content[0]!.text);

    // Still same time step (30s)
    vi.setSystemTime(fixedTime + 10000); // +10s
    const result2 = await generateTotp({ secret });
    const parsed2 = JSON.parse(result2.content[0]!.text);

    expect(parsed1.totpCode).toBe(parsed2.totpCode);

    // New time step
    vi.setSystemTime(fixedTime + 40000); // +40s
    const result3 = await generateTotp({ secret });
    const parsed3 = JSON.parse(result3.content[0]!.text);

    expect(parsed1.totpCode).not.toBe(parsed3.totpCode);

    vi.useRealTimers();
  });

  it('should error with empty secret', async () => {
    const secret = '';
    const result = await generateTotp({ secret } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('error');
  });
});
