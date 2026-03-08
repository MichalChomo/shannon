import { describe, it, expect } from 'vitest';
import { base32Decode, validateTotpSecret } from './totp-validator.js';

describe('totp-validator', () => {
  describe('base32Decode', () => {
    it('should correctly decode base32 string', () => {
      // 'Hello, World!' is actually JBSWY3DPFQQFO33SNRSCC
      const encoded = 'JBSWY3DPFQQFO33SNRSCC';
      expect(base32Decode(encoded).toString('utf8')).toBe('Hello, World!');
    });

    it('should return empty buffer for empty input', () => {
      expect(base32Decode('').length).toBe(0);
    });
  });

  describe('validateTotpSecret', () => {
    it('should return true for valid secret', () => {
      expect(validateTotpSecret('JBSWY3DPEHPK3PXP')).toBe(true);
    });

    it('should throw for empty secret', () => {
      expect(() => validateTotpSecret('')).toThrow('TOTP secret cannot be empty');
    });

    it('should throw for secret with no base32 characters', () => {
      expect(() => validateTotpSecret('0189')).toThrow('TOTP secret must be base32-encoded');
    });
  });
});
