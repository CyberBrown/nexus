import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  isOperationalError,
} from '../src/lib/errors';

describe('Error Classes', () => {
  describe('AppError', () => {
    it('should create with default values', () => {
      const error = new AppError('Something went wrong');
      expect(error.message).toBe('Something went wrong');
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.isOperational).toBe(true);
    });

    it('should create with custom values', () => {
      const error = new AppError('Bad request', 400, 'BAD_REQUEST', true);
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('BAD_REQUEST');
    });

    it('should serialize to JSON correctly', () => {
      const error = new AppError('Test error', 500, 'TEST_ERROR');
      const json = error.toJSON();
      expect(json.success).toBe(false);
      expect(json.error.message).toBe('Test error');
      expect(json.error.code).toBe('TEST_ERROR');
    });

    it('should be instance of Error', () => {
      const error = new AppError('Test');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppError);
    });
  });

  describe('ValidationError', () => {
    it('should create with default message', () => {
      const error = new ValidationError();
      expect(error.message).toBe('Validation failed');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('VALIDATION_ERROR');
    });

    it('should include details in JSON', () => {
      const error = new ValidationError('Invalid input', [
        { field: 'email', message: 'Invalid email format' },
        { field: 'password', message: 'Too short' },
      ]);
      const json = error.toJSON();
      expect(json.error.details).toHaveLength(2);
      expect(json.error.details[0]?.field).toBe('email');
    });

    it('should be instance of AppError', () => {
      const error = new ValidationError();
      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(ValidationError);
    });
  });

  describe('NotFoundError', () => {
    it('should create with resource name', () => {
      const error = new NotFoundError('Task');
      expect(error.message).toBe('Task not found');
      expect(error.statusCode).toBe(404);
      expect(error.code).toBe('NOT_FOUND');
    });

    it('should include id in message', () => {
      const error = new NotFoundError('Task', 'abc-123');
      expect(error.message).toBe("Task with id 'abc-123' not found");
    });

    it('should use default resource name', () => {
      const error = new NotFoundError();
      expect(error.message).toBe('Resource not found');
    });
  });

  describe('UnauthorizedError', () => {
    it('should create with default message', () => {
      const error = new UnauthorizedError();
      expect(error.message).toBe('Unauthorized');
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('UNAUTHORIZED');
    });

    it('should accept custom message', () => {
      const error = new UnauthorizedError('Invalid token');
      expect(error.message).toBe('Invalid token');
    });
  });

  describe('ForbiddenError', () => {
    it('should create with default message', () => {
      const error = new ForbiddenError();
      expect(error.message).toBe('Forbidden');
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('FORBIDDEN');
    });
  });

  describe('ConflictError', () => {
    it('should create with default message', () => {
      const error = new ConflictError();
      expect(error.message).toBe('Resource conflict');
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('CONFLICT');
    });

    it('should accept custom message', () => {
      const error = new ConflictError('Email already exists');
      expect(error.message).toBe('Email already exists');
    });
  });

  describe('isOperationalError', () => {
    it('should return true for AppError', () => {
      const error = new AppError('Test');
      expect(isOperationalError(error)).toBe(true);
    });

    it('should return true for ValidationError', () => {
      const error = new ValidationError();
      expect(isOperationalError(error)).toBe(true);
    });

    it('should return true for NotFoundError', () => {
      const error = new NotFoundError();
      expect(isOperationalError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Test');
      expect(isOperationalError(error)).toBe(false);
    });

    it('should return false for non-operational AppError', () => {
      const error = new AppError('Test', 500, 'INTERNAL', false);
      expect(isOperationalError(error)).toBe(false);
    });

    it('should return false for non-error values', () => {
      expect(isOperationalError(null)).toBe(false);
      expect(isOperationalError(undefined)).toBe(false);
      expect(isOperationalError('string')).toBe(false);
      expect(isOperationalError({})).toBe(false);
    });
  });
});
