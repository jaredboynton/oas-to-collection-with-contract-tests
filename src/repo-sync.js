#!/usr/bin/env node

/**
 * Repo Sync Module
 *
 * Exports Postman collections and environments to the local filesystem
 * as Git-friendly JSON files. Features:
 * - Deterministic output (sorted keys)
 * - Volatile fields removed (_postman_id, timestamps)
 * - Secrets redacted in environments
 * - Manifest tracking for change detection
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_CONFIG = {
  collectionsDir: 'postman/collections',
  environmentsDir: 'postman/environments',
  manifestFile: 'postman/.sync-manifest.json',
  indent: 2,
  sortKeys: true
};

export class RepoSync {
  constructor(client, config = {}) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Export all collections for a spec to repo
   * @param {string} specName - Name of the spec (for filename generation)
   * @param {Array} collectionUids - Array of {uid, type} objects
   * @param {string} outputDir - Base output directory
   */
  async exportCollections(specName, collectionUids, outputDir) {
    const collectionsDir = path.join(outputDir, this.config.collectionsDir);
    fs.mkdirSync(collectionsDir, { recursive: true });

    const exports = [];

    for (const { uid, type } of collectionUids) {
      try {
        const collection = await this.client.getCollection(uid);
        const normalized = this.normalizeCollection(collection.collection);

        const filename = this.generateFilename(specName, type, 'collection');
        const filepath = path.join(collectionsDir, filename);

        this.writeJsonFile(filepath, normalized);

        exports.push({
          type,
          uid,
          filename,
          hash: this.hashContent(normalized),
          updatedAt: collection.collection?.info?.updatedAt
        });

        console.log(`  Exported: ${filename}`);
      } catch (error) {
        console.error(`  Failed to export collection ${uid}: ${error.message}`);
      }
    }

    return exports;
  }

  /**
   * Export environments to repo
   * @param {string} specName - Name of the spec
   * @param {Array} environmentUids - Array of {uid, name} objects
   * @param {string} outputDir - Base output directory
   */
  async exportEnvironments(specName, environmentUids, outputDir) {
    const envsDir = path.join(outputDir, this.config.environmentsDir);
    fs.mkdirSync(envsDir, { recursive: true });

    const exports = [];

    for (const { uid, name } of environmentUids) {
      try {
        const envData = await this.client.getEnvironment(uid);
        const sanitized = this.sanitizeEnvironment(envData.environment);

        const filename = `${this.slugify(name)}.environment.json`;
        const filepath = path.join(envsDir, filename);

        this.writeJsonFile(filepath, sanitized);

        exports.push({
          name,
          uid,
          filename,
          hash: this.hashContent(sanitized),
          updatedAt: envData.environment?.updatedAt
        });

        console.log(`  Exported: ${filename}`);
      } catch (error) {
        console.error(`  Failed to export environment ${uid}: ${error.message}`);
      }
    }

    return exports;
  }

  /**
   * Normalize collection for deterministic Git diffs
   * - Removes volatile fields
   * - Sorts keys
   * - Normalizes script whitespace
   */
  normalizeCollection(collection) {
    const normalized = JSON.parse(JSON.stringify(collection));

    // Remove volatile fields that change on every export
    const volatileFields = [
      '_postman_id',
      'id',
      'uid',
      'owner',
      'createdAt',
      'updatedAt',
      'lastUpdatedBy',
      'fork'
    ];

    this.removeVolatileFields(normalized, volatileFields);

    // Normalize script whitespace
    this.normalizeScripts(normalized.item);

    // Sort keys for consistent output
    return this.config.sortKeys ? this.sortObjectKeys(normalized) : normalized;
  }

  /**
   * Sanitize environment (redact secrets)
   */
  sanitizeEnvironment(env) {
    const sanitized = JSON.parse(JSON.stringify(env));

    // Remove volatile metadata
    delete sanitized.uid;
    delete sanitized.id;
    delete sanitized.owner;
    delete sanitized.createdAt;
    delete sanitized.updatedAt;
    delete sanitized.isPublic;

    // Secret value patterns to redact
    const secretPatterns = /^(api[_-]?key|token|secret|password|auth|bearer|credential|private)/i;

    for (const variable of sanitized.values || []) {
      if (variable.type === 'secret' || secretPatterns.test(variable.key)) {
        variable.value = '';
        variable._redacted = true;
      }
    }

    return this.config.sortKeys ? this.sortObjectKeys(sanitized) : sanitized;
  }

  /**
   * Remove volatile fields recursively
   */
  removeVolatileFields(obj, fields) {
    if (Array.isArray(obj)) {
      obj.forEach(item => this.removeVolatileFields(item, fields));
    } else if (obj && typeof obj === 'object') {
      for (const field of fields) {
        delete obj[field];
      }
      Object.values(obj).forEach(val => this.removeVolatileFields(val, fields));
    }
  }

  /**
   * Normalize script whitespace for cleaner diffs
   */
  normalizeScripts(items) {
    for (const item of items || []) {
      if (item.event) {
        for (const event of item.event) {
          if (event.script?.exec && Array.isArray(event.script.exec)) {
            event.script.exec = event.script.exec.map(line =>
              line.replace(/\r\n/g, '\n').trimEnd()
            );
          }
        }
      }
      if (item.item) {
        this.normalizeScripts(item.item);
      }
    }
  }

  /**
   * Sort object keys recursively for deterministic output
   */
  sortObjectKeys(obj) {
    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObjectKeys(item));
    }
    if (obj && typeof obj === 'object') {
      return Object.keys(obj)
        .sort()
        .reduce((sorted, key) => {
          sorted[key] = this.sortObjectKeys(obj[key]);
          return sorted;
        }, {});
    }
    return obj;
  }

  /**
   * Generate consistent filename
   */
  generateFilename(specName, type, entityType) {
    const slug = this.slugify(specName);
    const typeSuffix = type === 'main' ? '' : `-${type}`;
    return `${slug}${typeSuffix}.${entityType}.json`;
  }

  /**
   * Slugify a name for filesystem use
   */
  slugify(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Write JSON file with consistent formatting
   */
  writeJsonFile(filepath, data) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(
      filepath,
      JSON.stringify(data, null, this.config.indent) + '\n'
    );
  }

  /**
   * Generate content hash for change detection
   */
  hashContent(obj) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(obj))
      .digest('hex')
      .substring(0, 12);
  }

  /**
   * Load existing manifest
   */
  loadManifest(outputDir) {
    const manifestPath = path.join(outputDir, this.config.manifestFile);

    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }

    return {
      version: '1.0',
      lastSync: null,
      collections: {},
      environments: {}
    };
  }

  /**
   * Update sync manifest
   */
  async updateManifest(outputDir, syncResult) {
    const manifestPath = path.join(outputDir, this.config.manifestFile);
    const manifest = this.loadManifest(outputDir);

    manifest.lastSync = new Date().toISOString();
    manifest.specPath = syncResult.specPath;
    manifest.workspaceId = this.client.workspaceId;

    // Update collection entries
    for (const coll of syncResult.collections || []) {
      manifest.collections[coll.uid] = {
        type: coll.type,
        filename: coll.filename,
        hash: coll.hash,
        updatedAt: coll.updatedAt,
        syncedAt: manifest.lastSync
      };
    }

    // Update environment entries
    for (const env of syncResult.environments || []) {
      manifest.environments[env.uid] = {
        name: env.name,
        filename: env.filename,
        hash: env.hash,
        updatedAt: env.updatedAt,
        syncedAt: manifest.lastSync
      };
    }

    this.writeJsonFile(manifestPath, manifest);
    console.log(`  Updated manifest: ${this.config.manifestFile}`);

    return manifest;
  }

  /**
   * Check for changes by comparing updatedAt timestamps
   * @param {string} outputDir - Directory containing manifest
   * @returns {object} Change detection results
   */
  async detectChanges(outputDir) {
    const manifest = this.loadManifest(outputDir);
    const changes = {
      collections: [],
      environments: [],
      hasChanges: false
    };

    // Get current workspace state (2 API calls)
    const currentCollections = await this.client.getWorkspaceCollections();
    const currentEnvironments = await this.client.getWorkspaceEnvironments();

    // Check collections for changes
    for (const coll of currentCollections) {
      const tracked = manifest.collections[coll.uid];

      if (!tracked) {
        changes.collections.push({ uid: coll.uid, name: coll.name, change: 'new' });
        changes.hasChanges = true;
      } else if (tracked.updatedAt !== coll.updatedAt) {
        changes.collections.push({
          uid: coll.uid,
          name: coll.name,
          change: 'modified',
          previousUpdate: tracked.updatedAt,
          currentUpdate: coll.updatedAt
        });
        changes.hasChanges = true;
      }
    }

    // Check environments for changes
    for (const env of currentEnvironments) {
      const tracked = manifest.environments[env.uid];

      if (!tracked) {
        changes.environments.push({ uid: env.uid, name: env.name, change: 'new' });
        changes.hasChanges = true;
      } else if (tracked.updatedAt !== env.updatedAt) {
        changes.environments.push({
          uid: env.uid,
          name: env.name,
          change: 'modified',
          previousUpdate: tracked.updatedAt,
          currentUpdate: env.updatedAt
        });
        changes.hasChanges = true;
      }
    }

    return changes;
  }

  /**
   * Get sync status summary
   */
  async getStatus(outputDir) {
    const manifest = this.loadManifest(outputDir);
    const changes = await this.detectChanges(outputDir);

    return {
      lastSync: manifest.lastSync,
      specPath: manifest.specPath,
      workspaceId: manifest.workspaceId,
      trackedCollections: Object.keys(manifest.collections).length,
      trackedEnvironments: Object.keys(manifest.environments).length,
      changes,
      needsSync: changes.hasChanges
    };
  }
}

export default RepoSync;
