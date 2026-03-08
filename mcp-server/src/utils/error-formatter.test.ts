import { describe, it, expect } from 'vitest';
import { createValidationError, createCryptoError, createGenericError } from './error-formatter.js';

describe('error-formatter', () => {
  it('should create a validation error', () => {
    const error = createValidationError('Invalid input', true, { field: 'email' });
    expect(error.status).toBe('error');
    expect(error.message).toBe('Invalid input');
    expect(error.errorType).toBe('ValidationError');
    expect(error.retryable).toBe(true);
    expect(error.context).toEqual({ field: 'email' });
  });

  it('should create a crypto error', () => {
    const error = createCryptoError('Secret too short');
    expect(error.status).toBe('error');
    expect(error.message).toBe('Secret too short');
    expect(error.errorType).toBe('CryptoError');
    expect(error.retryable).toBe(false);
  });

  it('should create a generic error from Error object', () => {
    const originalError = new TypeError('Something went wrong');
    const error = createGenericError(originalError);
    expect(error.status).toBe('error');
    expect(error.message).toBe('Something went wrong');
    expect(error.errorType).toBe('TypeError');
  });

  it('should create a generic error from string', () => {
    const error = createGenericError('Fatal failure');
    expect(error.status).toBe('error');
    expect(error.message).toBe('Fatal failure');
    expect(error.errorType).toBe('UnknownError');
  });
});
