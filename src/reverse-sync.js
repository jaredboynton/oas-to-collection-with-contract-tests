#!/usr/bin/env node

/**
 * Reverse Sync Module
 *
 * Orchestrates the reverse sync workflow:
 * 1. Fetch collection from Postman
 * 2. Transform to OpenAPI via Postman API
 * 3. Detect and classify changes
 * 4. Apply allowed changes back to spec
 * 5. Store tests as vendor extensions
 */

import fs from 'fs';
import path from 'path';
import { ChangeDetector, CHANGE_DIRECTION } from './change-detector.js';
import { SpecMerge } from './spec-merge.js';

export class ReverseSync {
  constructor(client, config = {}) {
    this.client = client;
    this.config = {
      conflictStrategy: config.conflictStrategy || 'spec-wins',
      autoMergeDescriptions: config.autoMergeDescriptions ?? true,
      autoMergeExamples: config.autoMergeExamples ?? true,
      storeTestsAsExtension: config.storeTestsAsExtension ?? true,
      baselineDir: config.baselineDir || '.sync-baselines',
      ...config
    };
    this.changeDetector = new ChangeDetector();
    this.specMerge = new SpecMerge(this.config);
  }

  /**
   * Main entry: Analyze and optionally apply reverse sync
   * @param {string} specPath - Path to local OpenAPI spec
   * @param {string} collectionUid - Collection UID to sync from
   * @param {object} options - Options (dryRun, outputPath)
   */
  async reverseSync(specPath, collectionUid, options = {}) {
    console.log('\nReverse Sync: Postman -> OpenAPI Spec');
    console.log('-'.repeat(50));

    // Step 1: Load local spec
    console.log('\n[1] Loading local spec...');
    const localSpec = this.specMerge.readSpec(specPath);
    console.log(`    Loaded: ${localSpec.info?.title} v${localSpec.info?.version}`);

    // Step 2: Get Postman collection
    console.log('\n[2] Fetching collection from Postman...');
    const collection = await this.client.getCollection(collectionUid);
    console.log(`    Collection: ${collection.collection?.info?.name}`);

    // Step 3: Transform collection to OpenAPI
    console.log('\n[3] Transforming collection to OpenAPI...');
    let remoteSpec;
    try {
      remoteSpec = await this.client.getCollectionAsOpenApi(collectionUid);
      console.log('    Transformation complete');
    } catch (error) {
      console.error(`    Transformation failed: ${error.message}`);
      console.log('    Falling back to description/example extraction only');
      remoteSpec = null;
    }

    // Step 4: Load baseline spec (for 3-way merge)
    const baseSpec = await this.loadBaseline(specPath) || localSpec;

    // Step 5: Detect and classify changes
    console.log('\n[4] Detecting changes...');
    let changes;

    if (remoteSpec) {
      changes = this.changeDetector.detectChanges(baseSpec, localSpec, remoteSpec);
    } else {
      // Fallback: extract what we can from collection directly
      changes = this.extractChangesFromCollection(baseSpec, localSpec, collection.collection);
    }

    this.printChangeSummary(changes);

    // Step 6: Return analysis if dry-run
    if (options.dryRun) {
      return {
        status: 'dry-run',
        changes,
        wouldApply: changes.safeToSync.length,
        wouldSkip: changes.blocked.length,
        wouldReview: changes.needsReview.length
      };
    }

    // Step 7: Check for blocking issues
    if (changes.blocked.length > 0) {
      console.log('\n    Blocked changes detected (structural changes cannot reverse-sync):');
      for (const blocked of changes.blocked.slice(0, 5)) {
        console.log(`      - ${blocked.path}: ${blocked.reason}`);
      }
      if (changes.blocked.length > 5) {
        console.log(`      ... and ${changes.blocked.length - 5} more`);
      }
    }

    // Step 8: Apply safe changes
    if (changes.safeToSync.length === 0 && changes.tests.length === 0) {
      console.log('\n    No changes to apply');
      return { status: 'no-changes', changes };
    }

    console.log('\n[5] Applying changes...');
    const mergeResult = this.specMerge.mergeSpecs(
      localSpec,
      remoteSpec || localSpec,
      changes.safeToSync
    );

    // Step 9: Store tests as vendor extension if configured
    if (this.config.storeTestsAsExtension && collection.collection) {
      const testsApplied = this.applyTestsAsExtensions(
        mergeResult.spec,
        collection.collection
      );
      if (testsApplied > 0) {
        console.log(`    Applied ${testsApplied} test scripts as x-postman-tests`);
      }
    }

    // Step 10: Write updated spec
    const outputPath = options.outputPath || specPath;

    // Backup original if modifying in place
    if (outputPath === specPath && !options.noBackup) {
      const backupPath = this.specMerge.backupSpec(specPath);
      console.log(`    Backup created: ${backupPath}`);
    }

    this.specMerge.writeSpec(mergeResult.spec, outputPath);
    console.log(`\n    Updated: ${outputPath}`);
    console.log(`    Applied: ${mergeResult.applied.length} changes`);
    console.log(`    Skipped: ${mergeResult.skipped.length} changes`);

    // Step 11: Save new baseline for future 3-way merges
    await this.saveBaseline(specPath, mergeResult.spec);

    return {
      status: 'synced',
      changes,
      applied: mergeResult.applied,
      skipped: mergeResult.skipped,
      outputPath
    };
  }

  /**
   * Print change summary
   */
  printChangeSummary(changes) {
    const summary = this.changeDetector.getSummary(changes);
    console.log('\n    Change Summary:');
    console.log(`      Safe to sync: ${summary.safeToSync}`);
    console.log(`      Needs review: ${summary.needsReview}`);
    console.log(`      Blocked: ${summary.blocked}`);
    console.log(`      Tests: ${summary.tests}`);
    if (summary.hasConflicts) {
      console.log('      (!) Conflicts detected');
    }
  }

  /**
   * Load baseline spec for 3-way merge
   */
  async loadBaseline(specPath) {
    const baselinePath = this.getBaselinePath(specPath);

    if (fs.existsSync(baselinePath)) {
      try {
        const content = fs.readFileSync(baselinePath, 'utf8');
        return JSON.parse(content);
      } catch (error) {
        console.log(`    Could not load baseline: ${error.message}`);
      }
    }

    return null;
  }

  /**
   * Save baseline spec after successful sync
   */
  async saveBaseline(specPath, spec) {
    const baselinePath = this.getBaselinePath(specPath);
    const baselineDir = path.dirname(baselinePath);

    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(spec, null, 2));
  }

  /**
   * Get baseline file path for a spec
   */
  getBaselinePath(specPath) {
    const specName = path.basename(specPath, path.extname(specPath));
    return path.join(
      path.dirname(specPath),
      this.config.baselineDir,
      `${specName}.baseline.json`
    );
  }

  /**
   * Extract changes directly from collection (fallback when transformation fails)
   */
  extractChangesFromCollection(baseSpec, localSpec, collection) {
    const changes = {
      safeToSync: [],
      needsReview: [],
      blocked: [],
      tests: []
    };

    // Extract descriptions from collection items
    this.extractDescriptionsFromItems(collection.item, changes, '');

    return changes;
  }

  /**
   * Recursively extract descriptions from collection items
   */
  extractDescriptionsFromItems(items, changes, pathPrefix) {
    for (const item of items || []) {
      if (item.item) {
        // Folder - recurse
        this.extractDescriptionsFromItems(
          item.item,
          changes,
          `${pathPrefix}/${item.name}`
        );
      } else if (item.request) {
        // Request item - extract description
        if (item.description) {
          changes.safeToSync.push({
            path: `request.${item.name}.description`,
            kind: 'E',
            newValue: item.description,
            direction: CHANGE_DIRECTION.BIDIRECTIONAL,
            reason: 'Request description',
            hasConflict: false
          });
        }

        // Extract test scripts
        if (item.event) {
          const testEvents = item.event.filter(e => e.listen === 'test');
          if (testEvents.length > 0) {
            changes.tests.push({
              path: `request.${item.name}.tests`,
              kind: 'E',
              newValue: testEvents,
              direction: CHANGE_DIRECTION.COLLECTION_ONLY,
              reason: 'Test scripts',
              hasConflict: false
            });
          }
        }
      }
    }
  }

  /**
   * Extract and store test scripts as OpenAPI vendor extensions
   */
  applyTestsAsExtensions(spec, collection) {
    const testsByOperation = this.extractTestsFromCollection(collection);
    let appliedCount = 0;

    for (const [operationKey, tests] of Object.entries(testsByOperation)) {
      const [urlPath, method] = operationKey.split('|');

      // Find matching operation in spec
      const operation = this.findOperation(spec, urlPath, method);

      if (operation) {
        operation['x-postman-tests'] = tests;
        appliedCount++;
      }
    }

    return appliedCount;
  }

  /**
   * Find operation in spec by path and method
   */
  findOperation(spec, urlPath, method) {
    if (!spec.paths) return null;

    // Try exact match first
    if (spec.paths[urlPath]?.[method]) {
      return spec.paths[urlPath][method];
    }

    // Try matching with path parameters
    for (const [specPath, methods] of Object.entries(spec.paths)) {
      if (this.pathsMatch(specPath, urlPath) && methods[method]) {
        return methods[method];
      }
    }

    return null;
  }

  /**
   * Check if spec path matches collection URL path
   * Handles path parameters: /users/{id} matches /users/123
   */
  pathsMatch(specPath, urlPath) {
    const specParts = specPath.split('/');
    const urlParts = urlPath.split('/');

    if (specParts.length !== urlParts.length) return false;

    for (let i = 0; i < specParts.length; i++) {
      const specPart = specParts[i];
      const urlPart = urlParts[i];

      // Path parameter matches anything
      if (specPart.startsWith('{') && specPart.endsWith('}')) {
        continue;
      }

      if (specPart !== urlPart) {
        return false;
      }
    }

    return true;
  }

  /**
   * Extract test scripts from collection items
   */
  extractTestsFromCollection(collection) {
    const tests = {};

    const processItems = (items, folderPath = '') => {
      for (const item of items || []) {
        if (item.item) {
          // Folder - recurse
          processItems(item.item, `${folderPath}/${item.name}`);
        } else if (item.request && item.event) {
          const testEvents = item.event.filter(e => e.listen === 'test');

          if (testEvents.length > 0) {
            const url = item.request.url;
            const urlPath = typeof url === 'string'
              ? new URL(url, 'http://localhost').pathname
              : `/${(url.path || []).join('/')}`;
            const method = (item.request.method || 'get').toLowerCase();
            const key = `${urlPath}|${method}`;

            tests[key] = testEvents.map(e => ({
              name: item.name,
              script: e.script?.exec || [],
              type: e.script?.type || 'text/javascript'
            }));
          }
        }
      }
    };

    processItems(collection.item);
    return tests;
  }

  /**
   * Get reverse sync status/preview without making changes
   */
  async getStatus(specPath, collectionUid) {
    return this.reverseSync(specPath, collectionUid, { dryRun: true });
  }
}

export default ReverseSync;
