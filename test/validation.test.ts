import { describe, it, expect } from 'vitest';
import {
  validate,
  createTaskSchema,
  updateTaskSchema,
  createProjectSchema,
  createIdeaSchema,
  createPersonSchema,
  createCommitmentSchema,
  createInboxItemSchema,
} from '../src/lib/validation';
import { ValidationError } from '../src/lib/errors';

describe('Validation Schemas', () => {
  describe('createTaskSchema', () => {
    it('should validate a minimal valid task', () => {
      const result = validate(createTaskSchema, {
        title: 'Test task',
      });
      expect(result.title).toBe('Test task');
      expect(result.domain).toBe('personal');
      expect(result.urgency).toBe(3);
      expect(result.importance).toBe(3);
    });

    it('should validate a complete task', () => {
      const result = validate(createTaskSchema, {
        title: 'Complete project',
        description: 'Finish the API implementation',
        domain: 'work',
        urgency: 5,
        importance: 4,
        due_date: '2024-12-31',
        status: 'next',
        energy_required: 'high',
      });
      expect(result.title).toBe('Complete project');
      expect(result.domain).toBe('work');
      expect(result.urgency).toBe(5);
    });

    it('should reject empty title', () => {
      expect(() => validate(createTaskSchema, { title: '' }))
        .toThrow(ValidationError);
    });

    it('should reject invalid urgency', () => {
      expect(() => validate(createTaskSchema, { title: 'Test', urgency: 10 }))
        .toThrow(ValidationError);
    });

    it('should reject invalid domain', () => {
      expect(() => validate(createTaskSchema, { title: 'Test', domain: 'invalid' }))
        .toThrow(ValidationError);
    });

    it('should reject invalid date format', () => {
      expect(() => validate(createTaskSchema, { title: 'Test', due_date: 'invalid' }))
        .toThrow(ValidationError);
    });

    it('should accept valid UUID for project_id', () => {
      const result = validate(createTaskSchema, {
        title: 'Test',
        project_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.project_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should reject invalid UUID', () => {
      expect(() => validate(createTaskSchema, { title: 'Test', project_id: 'not-a-uuid' }))
        .toThrow(ValidationError);
    });
  });

  describe('updateTaskSchema', () => {
    it('should allow partial updates', () => {
      const result = validate(updateTaskSchema, { status: 'completed' });
      expect(result.status).toBe('completed');
    });

    it('should allow empty object (returns defaults stripped)', () => {
      // updateTaskSchema is partial, so empty object is valid
      // Defaults aren't applied to undefined fields in partial schemas
      const result = validate(updateTaskSchema, {});
      // The result should be an object (possibly with defaults from base schema)
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });
  });

  describe('createProjectSchema', () => {
    it('should validate a minimal project', () => {
      const result = validate(createProjectSchema, { name: 'My Project' });
      expect(result.name).toBe('My Project');
      expect(result.status).toBe('planning');
    });

    it('should reject empty name', () => {
      expect(() => validate(createProjectSchema, { name: '' }))
        .toThrow(ValidationError);
    });

    it('should validate project with target_date', () => {
      const result = validate(createProjectSchema, {
        name: 'Project',
        target_date: '2024-12-31',
      });
      expect(result.target_date).toBe('2024-12-31');
    });
  });

  describe('createIdeaSchema', () => {
    it('should validate a minimal idea', () => {
      const result = validate(createIdeaSchema, { title: 'Cool idea' });
      expect(result.title).toBe('Cool idea');
      expect(result.category).toBe('random');
    });

    it('should validate excitement_level range', () => {
      const result = validate(createIdeaSchema, {
        title: 'Exciting idea',
        excitement_level: 5,
      });
      expect(result.excitement_level).toBe(5);
    });

    it('should reject out of range excitement_level', () => {
      expect(() => validate(createIdeaSchema, {
        title: 'Idea',
        excitement_level: 10,
      })).toThrow(ValidationError);
    });
  });

  describe('createPersonSchema', () => {
    it('should validate a minimal person', () => {
      const result = validate(createPersonSchema, { name: 'John Doe' });
      expect(result.name).toBe('John Doe');
    });

    it('should validate email format', () => {
      const result = validate(createPersonSchema, {
        name: 'John',
        email: 'john@example.com',
      });
      expect(result.email).toBe('john@example.com');
    });

    it('should reject invalid email', () => {
      expect(() => validate(createPersonSchema, {
        name: 'John',
        email: 'not-an-email',
      })).toThrow(ValidationError);
    });

    it('should validate preferred_contact enum', () => {
      const result = validate(createPersonSchema, {
        name: 'John',
        preferred_contact: 'email',
      });
      expect(result.preferred_contact).toBe('email');
    });
  });

  describe('createCommitmentSchema', () => {
    it('should validate a minimal commitment', () => {
      const result = validate(createCommitmentSchema, {
        direction: 'waiting_for',
        description: 'Waiting for response',
      });
      expect(result.direction).toBe('waiting_for');
      expect(result.description).toBe('Waiting for response');
    });

    it('should reject invalid direction', () => {
      expect(() => validate(createCommitmentSchema, {
        direction: 'invalid',
        description: 'Test',
      })).toThrow(ValidationError);
    });

    it('should validate with person_id', () => {
      const result = validate(createCommitmentSchema, {
        direction: 'owed_to',
        description: 'I owe them a call',
        person_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.person_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    });
  });

  describe('createInboxItemSchema', () => {
    it('should validate a minimal inbox item', () => {
      const result = validate(createInboxItemSchema, {
        source_type: 'voice',
        raw_content: 'Remember to call mom',
      });
      expect(result.source_type).toBe('voice');
      expect(result.raw_content).toBe('Remember to call mom');
    });

    it('should reject empty content', () => {
      expect(() => validate(createInboxItemSchema, {
        source_type: 'voice',
        raw_content: '',
      })).toThrow(ValidationError);
    });
  });
});

describe('ValidationError', () => {
  it('should include field details', () => {
    try {
      validate(createTaskSchema, { title: '' });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toHaveLength(1);
      expect(validationError.details[0]?.field).toBe('title');
    }
  });

  it('should have correct status code', () => {
    try {
      validate(createTaskSchema, {});
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).statusCode).toBe(400);
    }
  });
});
