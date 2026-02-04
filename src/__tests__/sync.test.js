/**
 * Bi-Directional Sync Test Suite
 * Run with: node --test src/__tests__/sync.test.js
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ChangeDetector, CHANGE_DIRECTION } from '../change-detector.js';
import { SpecMerge } from '../spec-merge.js';
import { RepoSync } from '../repo-sync.js';

// ============================================================
// FIXTURES
// ============================================================

const baseSpec = {
  openapi: '3.0.3',
  info: { title: 'Test API', version: '1.0.0', description: 'Base description' },
  paths: {
    '/tasks': {
      get: {
        summary: 'List tasks',
        description: 'Original description',
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: { type: 'array' },
                example: [{ id: 1 }]
              }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Task: { type: 'object', properties: { id: { type: 'integer' } } }
    }
  }
};

const localSpec = JSON.parse(JSON.stringify(baseSpec));
localSpec.info.description = 'Updated in repo';

const remoteSpec = JSON.parse(JSON.stringify(baseSpec));
remoteSpec.paths['/tasks'].get.description = 'Enhanced in Postman';
remoteSpec.paths['/tasks'].get.responses['200'].content['application/json'].example = [
  { id: 1, title: 'Task 1' }
];

// ============================================================
// CHANGE DETECTOR TESTS
// ============================================================

describe('ChangeDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new ChangeDetector();
  });

  it('should classify schema changes as blocked (spec-only)', () => {
    const remoteWithSchema = JSON.parse(JSON.stringify(baseSpec));
    remoteWithSchema.components.schemas.Task.properties.title = { type: 'string' };

    const changes = detector.detectChanges(baseSpec, localSpec, remoteWithSchema);

    const schemaChange = changes.blocked.find(c => c.path.includes('schemas'));
    assert.ok(schemaChange, 'Schema change should be in blocked list');
    assert.strictEqual(
      schemaChange.direction,
      CHANGE_DIRECTION.SPEC_TO_COLLECTION,
      'Schema changes should be spec-to-collection only'
    );
  });

  it('should classify description changes as bidirectional', () => {
    const changes = detector.detectChanges(baseSpec, localSpec, remoteSpec);

    const descChange = changes.safeToSync.find(c => c.path.includes('description'));
    assert.ok(descChange, 'Description change should be in safeToSync');
    assert.strictEqual(
      descChange.direction,
      CHANGE_DIRECTION.BIDIRECTIONAL,
      'Description should be bidirectional'
    );
  });

  it('should detect conflicts when same path changed in both specs', () => {
    // Local changed info.description, remote also changes it
    const conflictRemote = JSON.parse(JSON.stringify(baseSpec));
    conflictRemote.info.description = 'Changed in Postman too';

    const changes = detector.detectChanges(baseSpec, localSpec, conflictRemote);

    const conflicting = changes.needsReview.filter(c => c.hasConflict);
    assert.ok(conflicting.length > 0, 'Should detect conflicting changes');
  });

  it('should classify example changes as bidirectional', () => {
    const changes = detector.detectChanges(baseSpec, localSpec, remoteSpec);

    const exampleChange = changes.safeToSync.find(c => c.path.includes('example'));
    assert.ok(exampleChange, 'Example change should be in safeToSync');
    assert.strictEqual(
      exampleChange.direction,
      CHANGE_DIRECTION.BIDIRECTIONAL,
      'Examples should be bidirectional'
    );
  });

  it('should block endpoint structure changes', () => {
    const remoteWithNewPath = JSON.parse(JSON.stringify(baseSpec));
    remoteWithNewPath.paths['/tasks/{id}'] = { get: { summary: 'Get task' } };

    const changes = detector.detectChanges(baseSpec, localSpec, remoteWithNewPath);

    const pathChange = changes.blocked.find(c => c.path.includes('paths'));
    assert.ok(pathChange, 'New endpoint should be blocked');
  });
});

// ============================================================
// SPEC MERGE TESTS
// ============================================================

describe('SpecMerge', () => {
  let merger;

  beforeEach(() => {
    merger = new SpecMerge({ conflictStrategy: 'spec-wins' });
  });

  it('should apply only allowed changes', () => {
    const allowedChanges = [
      {
        path: 'paths./tasks.get.description',
        newValue: 'Enhanced in Postman',
        hasConflict: false
      }
    ];

    const result = merger.mergeSpecs(localSpec, remoteSpec, allowedChanges);

    assert.strictEqual(
      result.spec.paths['/tasks'].get.description,
      'Enhanced in Postman',
      'Description should be updated'
    );
    assert.strictEqual(result.applied.length, 1, 'Should have 1 applied change');
  });

  it('should preserve local structure (endpoints, schemas)', () => {
    const allowedChanges = [
      {
        path: 'paths./tasks.get.description',
        newValue: 'Enhanced in Postman',
        hasConflict: false
      }
    ];

    const result = merger.mergeSpecs(localSpec, remoteSpec, allowedChanges);

    // Endpoints preserved
    assert.ok(result.spec.paths['/tasks'], 'Original endpoint should exist');
    assert.ok(result.spec.paths['/tasks'].get, 'GET method should exist');

    // Schemas preserved
    assert.ok(result.spec.components.schemas.Task, 'Schema should be preserved');
  });

  it('should skip conflicting changes when strategy is spec-wins', () => {
    const conflictingChanges = [
      {
        path: 'info.description',
        newValue: 'Postman description',
        hasConflict: true
      }
    ];

    const result = merger.mergeSpecs(localSpec, remoteSpec, conflictingChanges);

    assert.strictEqual(
      result.spec.info.description,
      localSpec.info.description,
      'Local description should be preserved'
    );
    assert.strictEqual(result.skipped.length, 1, 'Conflict should be skipped');
  });

  it('should apply conflicting changes when strategy is collection-wins', () => {
    const collectionWinsMerger = new SpecMerge({ conflictStrategy: 'collection-wins' });
    const conflictingChanges = [
      {
        path: 'info.description',
        newValue: 'Postman description',
        hasConflict: true
      }
    ];

    const result = collectionWinsMerger.mergeSpecs(localSpec, remoteSpec, conflictingChanges);

    assert.strictEqual(
      result.spec.info.description,
      'Postman description',
      'Postman description should win'
    );
  });
});

// ============================================================
// REPO SYNC TESTS
// ============================================================

describe('RepoSync', () => {
  let repoSync;
  let mockClient;

  beforeEach(() => {
    mockClient = {
      getCollection: mock.fn(() => Promise.resolve({
        collection: {
          info: { name: 'Test Collection', _postman_id: 'abc123' },
          item: [],
          _postman_id: 'xyz789'
        }
      })),
      request: mock.fn(() => Promise.resolve({ environment: { name: 'Test Env', values: [] } }))
    };
    repoSync = new RepoSync(mockClient);
  });

  it('should remove volatile fields from collection', () => {
    const collection = {
      info: { name: 'Test', _postman_id: '123', createdAt: '2024-01-01' },
      _postman_id: '456',
      owner: 'user123',
      updatedAt: '2024-01-02',
      item: []
    };

    const normalized = repoSync.normalizeCollection(collection);

    assert.strictEqual(normalized._postman_id, undefined, '_postman_id should be removed');
    assert.strictEqual(normalized.owner, undefined, 'owner should be removed');
    assert.strictEqual(normalized.updatedAt, undefined, 'updatedAt should be removed');
    assert.ok(normalized.info.name, 'name should be preserved');
  });

  it('should sort keys for deterministic output', () => {
    const collection = {
      z: 1,
      a: 2,
      m: { z: 1, a: 2 }
    };

    const normalized = repoSync.sortObjectKeys(collection);
    const keys = Object.keys(normalized);

    assert.deepStrictEqual(keys, ['a', 'm', 'z'], 'Keys should be sorted');
    assert.deepStrictEqual(
      Object.keys(normalized.m),
      ['a', 'z'],
      'Nested keys should be sorted'
    );
  });

  it('should sanitize secret environment values', () => {
    const env = {
      name: 'Production',
      values: [
        { key: 'baseUrl', value: 'https://api.example.com', type: 'default' },
        { key: 'apiKey', value: 'secret-key-123', type: 'secret' },
        { key: 'authToken', value: 'bearer-token', type: 'default' }
      ]
    };

    const sanitized = repoSync.sanitizeEnvironment(env);

    const apiKey = sanitized.values.find(v => v.key === 'apiKey');
    const authToken = sanitized.values.find(v => v.key === 'authToken');
    const baseUrl = sanitized.values.find(v => v.key === 'baseUrl');

    assert.strictEqual(apiKey.value, '', 'Secret value should be redacted');
    assert.strictEqual(authToken.value, '', 'authToken should be redacted (matches pattern)');
    assert.strictEqual(baseUrl.value, 'https://api.example.com', 'baseUrl should be preserved');
  });

  it('should generate consistent filenames', () => {
    const filename1 = repoSync.generateFilename('Task Management API', 'main', 'collection');
    const filename2 = repoSync.generateFilename('Task Management API', 'main', 'collection');
    const smokeFilename = repoSync.generateFilename('Task Management API', 'smoke', 'collection');

    assert.strictEqual(filename1, filename2, 'Same input should produce same filename');
    assert.strictEqual(filename1, 'task-management-api.collection.json');
    assert.strictEqual(smokeFilename, 'task-management-api-smoke.collection.json');
  });

  it('should generate consistent hash for same content', () => {
    const content = { test: 'data', nested: { value: 123 } };

    const hash1 = repoSync.hashContent(content);
    const hash2 = repoSync.hashContent(content);

    assert.strictEqual(hash1, hash2, 'Same content should produce same hash');
    assert.strictEqual(hash1.length, 12, 'Hash should be 12 characters');
  });
});

// ============================================================
// EDGE CASE TESTS
// ============================================================

describe('Edge Cases', () => {
  it('should handle empty collection without crashing', () => {
    const repoSync = new RepoSync({});
    const emptyCollection = { info: { name: 'Empty' }, item: [] };

    const normalized = repoSync.normalizeCollection(emptyCollection);

    assert.ok(normalized, 'Should return normalized collection');
    assert.deepStrictEqual(normalized.item, [], 'Item should be empty array');
  });

  it('should handle deeply nested folders', () => {
    const repoSync = new RepoSync({});
    const deepCollection = {
      info: { name: 'Deep' },
      item: [
        {
          name: 'L1',
          item: [
            {
              name: 'L2',
              item: [
                {
                  name: 'L3',
                  item: [
                    {
                      name: 'L4',
                      item: [
                        {
                          name: 'L5',
                          event: [{ listen: 'test', script: { exec: ['pm.test()'] } }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const normalized = repoSync.normalizeCollection(deepCollection);

    // Should not throw and preserve structure
    assert.ok(normalized.item[0].item[0].item[0].item[0].item[0].name === 'L5');
  });

  it('should handle spec with all environments being secrets', () => {
    const repoSync = new RepoSync({});
    const allSecrets = {
      name: 'All Secrets',
      values: [
        { key: 'api_key', value: 'secret1', type: 'secret' },
        { key: 'token', value: 'secret2', type: 'secret' },
        { key: 'password', value: 'secret3', type: 'secret' }
      ]
    };

    const sanitized = repoSync.sanitizeEnvironment(allSecrets);

    for (const v of sanitized.values) {
      assert.strictEqual(v.value, '', `${v.key} should be redacted`);
    }
  });

  it('should detect no changes when specs are identical', () => {
    const detector = new ChangeDetector();
    const identicalSpec = JSON.parse(JSON.stringify(baseSpec));

    const changes = detector.detectChanges(baseSpec, identicalSpec, identicalSpec);

    assert.strictEqual(changes.safeToSync.length, 0, 'No safe changes');
    assert.strictEqual(changes.blocked.length, 0, 'No blocked changes');
    assert.strictEqual(changes.needsReview.length, 0, 'No review needed');
  });
});
