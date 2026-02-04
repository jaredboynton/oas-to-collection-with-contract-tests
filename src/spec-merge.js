#!/usr/bin/env node

/**
 * Spec Merge Module
 *
 * Handles 3-way merge for bidirectional sync between OpenAPI specs
 * and Postman collections. Only merges allowed fields (descriptions,
 * examples) while preserving structural integrity.
 */

import fs from 'fs';
import yaml from 'js-yaml';

export class SpecMerge {
  constructor(options = {}) {
    this.options = {
      conflictStrategy: options.conflictStrategy || 'spec-wins',
      autoMergeDescriptions: options.autoMergeDescriptions ?? true,
      autoMergeExamples: options.autoMergeExamples ?? true,
      preserveFormatting: options.preserveFormatting ?? true,
      ...options
    };
  }

  /**
   * Merge Postman changes into spec (only allowed fields)
   * @param {object} localSpec - Current repo spec (preserved for structure)
   * @param {object} remoteSpec - Spec derived from Postman collection
   * @param {Array} allowedChanges - Pre-classified safe changes
   * @returns {object} Merge result with spec, applied, and skipped changes
   */
  mergeSpecs(localSpec, remoteSpec, allowedChanges) {
    // Deep clone to avoid mutation
    const merged = JSON.parse(JSON.stringify(localSpec));
    const appliedChanges = [];
    const skippedChanges = [];

    // Apply only allowed changes
    for (const change of allowedChanges) {
      // Skip conflicting changes based on strategy
      if (change.hasConflict) {
        if (this.options.conflictStrategy === 'spec-wins') {
          skippedChanges.push({ ...change, reason: 'Conflict - spec wins' });
          continue;
        }
        // collection-wins or interactive: apply the change
      }

      try {
        this.applyChange(merged, change);
        appliedChanges.push(change);
      } catch (error) {
        skippedChanges.push({
          ...change,
          reason: `Failed to apply: ${error.message}`
        });
      }
    }

    return {
      spec: merged,
      applied: appliedChanges,
      skipped: skippedChanges
    };
  }

  /**
   * Apply a single change to the spec
   * @param {object} spec - Spec object to modify
   * @param {object} change - Change to apply (path, newValue)
   */
  applyChange(spec, change) {
    const pathParts = this.parsePath(change.path);
    let current = spec;

    // Navigate to parent of target
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];

      if (current[part] === undefined) {
        // Create intermediate objects/arrays as needed
        const nextPart = pathParts[i + 1];
        current[part] = typeof nextPart === 'number' ? [] : {};
      }
      current = current[part];
    }

    // Apply the change
    const finalKey = pathParts[pathParts.length - 1];

    if (change.kind === 'D') {
      // Deletion
      delete current[finalKey];
    } else {
      // Addition or Edit
      current[finalKey] = change.newValue;
    }
  }

  /**
   * Parse a dot-separated path into parts
   * Handles paths like "paths./users.get.description"
   */
  parsePath(pathStr) {
    const parts = [];
    let current = '';
    let inBracket = false;

    for (let i = 0; i < pathStr.length; i++) {
      const char = pathStr[i];

      if (char === '/' && !inBracket) {
        // Start of path segment like /users
        if (current) parts.push(current);
        current = '/';
      } else if (char === '.' && !inBracket && !current.startsWith('/')) {
        if (current) parts.push(current);
        current = '';
      } else if (char === '[') {
        inBracket = true;
        current += char;
      } else if (char === ']') {
        inBracket = false;
        current += char;
      } else {
        current += char;
      }
    }

    if (current) parts.push(current);

    // Convert numeric strings to numbers for array access
    return parts.map(p => {
      const num = parseInt(p, 10);
      return !isNaN(num) && String(num) === p ? num : p;
    });
  }

  /**
   * Sync descriptions from remote to local spec
   * More targeted than full merge - only syncs description fields
   */
  syncDescriptions(localSpec, remoteSpec) {
    const synced = JSON.parse(JSON.stringify(localSpec));

    // Sync info description
    if (remoteSpec.info?.description && this.options.autoMergeDescriptions) {
      synced.info.description = remoteSpec.info.description;
    }

    // Sync tag descriptions
    if (synced.tags && remoteSpec.tags) {
      for (const tag of synced.tags) {
        const remoteTag = remoteSpec.tags?.find(t => t.name === tag.name);
        if (remoteTag?.description) {
          tag.description = remoteTag.description;
        }
      }
    }

    // Sync path/operation descriptions
    if (synced.paths && remoteSpec.paths) {
      for (const [path, methods] of Object.entries(synced.paths)) {
        if (!remoteSpec.paths[path]) continue;

        for (const [method, operation] of Object.entries(methods)) {
          if (typeof operation !== 'object') continue;

          const remoteOp = remoteSpec.paths[path]?.[method];
          if (!remoteOp) continue;

          // Sync summary and description
          if (remoteOp.summary) operation.summary = remoteOp.summary;
          if (remoteOp.description) operation.description = remoteOp.description;

          // Sync parameter descriptions
          if (operation.parameters && remoteOp.parameters) {
            for (const param of operation.parameters) {
              const remoteParam = remoteOp.parameters?.find(
                p => p.name === param.name && p.in === param.in
              );
              if (remoteParam?.description) {
                param.description = remoteParam.description;
              }
            }
          }

          // Sync response descriptions
          if (operation.responses && remoteOp.responses) {
            for (const [code, response] of Object.entries(operation.responses)) {
              const remoteResponse = remoteOp.responses?.[code];
              if (remoteResponse?.description) {
                response.description = remoteResponse.description;
              }
            }
          }
        }
      }
    }

    return synced;
  }

  /**
   * Sync examples from remote to local spec
   */
  syncExamples(localSpec, remoteSpec) {
    if (!this.options.autoMergeExamples) {
      return localSpec;
    }

    const synced = JSON.parse(JSON.stringify(localSpec));

    if (synced.paths && remoteSpec.paths) {
      for (const [path, methods] of Object.entries(synced.paths)) {
        if (!remoteSpec.paths[path]) continue;

        for (const [method, operation] of Object.entries(methods)) {
          if (typeof operation !== 'object') continue;

          const remoteOp = remoteSpec.paths[path]?.[method];
          if (!remoteOp) continue;

          // Sync parameter examples
          if (operation.parameters && remoteOp.parameters) {
            for (const param of operation.parameters) {
              const remoteParam = remoteOp.parameters?.find(
                p => p.name === param.name && p.in === param.in
              );
              if (remoteParam?.example !== undefined) {
                param.example = remoteParam.example;
              }
              if (remoteParam?.examples) {
                param.examples = remoteParam.examples;
              }
            }
          }

          // Sync request body examples
          if (operation.requestBody?.content && remoteOp.requestBody?.content) {
            for (const [mediaType, content] of Object.entries(operation.requestBody.content)) {
              const remoteContent = remoteOp.requestBody?.content?.[mediaType];
              if (remoteContent?.example !== undefined) {
                content.example = remoteContent.example;
              }
              if (remoteContent?.examples) {
                content.examples = remoteContent.examples;
              }
            }
          }

          // Sync response examples
          if (operation.responses && remoteOp.responses) {
            for (const [code, response] of Object.entries(operation.responses)) {
              const remoteResponse = remoteOp.responses?.[code];
              if (!remoteResponse?.content || !response.content) continue;

              for (const [mediaType, content] of Object.entries(response.content)) {
                const remoteContent = remoteResponse.content?.[mediaType];
                if (remoteContent?.example !== undefined) {
                  content.example = remoteContent.example;
                }
                if (remoteContent?.examples) {
                  content.examples = remoteContent.examples;
                }
              }
            }
          }
        }
      }
    }

    return synced;
  }

  /**
   * Read spec from file (YAML or JSON)
   */
  readSpec(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const isYaml = filePath.endsWith('.yaml') || filePath.endsWith('.yml');

    return isYaml ? yaml.load(content) : JSON.parse(content);
  }

  /**
   * Write spec back to file (preserving format)
   */
  writeSpec(spec, filePath) {
    const isYaml = filePath.endsWith('.yaml') || filePath.endsWith('.yml');

    const content = isYaml
      ? yaml.dump(spec, {
          lineWidth: -1,
          noRefs: true,
          quotingType: '"',
          forceQuotes: false
        })
      : JSON.stringify(spec, null, 2);

    fs.writeFileSync(filePath, content + '\n');
  }

  /**
   * Create a backup of the spec before modifying
   */
  backupSpec(filePath) {
    const backupPath = `${filePath}.backup.${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  }
}

export default SpecMerge;
