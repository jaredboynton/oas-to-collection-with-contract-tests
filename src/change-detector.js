#!/usr/bin/env node

/**
 * Change Detection and Classification Module
 *
 * Determines what changes are valid for reverse sync between
 * OpenAPI specs and Postman collections.
 *
 * Classification:
 * - SPEC_TO_COLLECTION: Structural changes (paths, schemas, security) - never reverse sync
 * - BIDIRECTIONAL: Enrichments (descriptions, examples) - can flow both ways
 * - COLLECTION_ONLY: Tests and scripts - stored as vendor extensions
 */

// Change direction constants
export const CHANGE_DIRECTION = {
  SPEC_TO_COLLECTION: 'spec-to-collection',  // Structural changes - blocked
  BIDIRECTIONAL: 'bidirectional',             // Enrichments - allowed
  COLLECTION_ONLY: 'collection-only'          // Tests, scripts - extension
};

// Fields that ONLY flow spec -> collection (never reverse sync)
const SPEC_SOURCE_OF_TRUTH = [
  'openapi',
  'paths',
  'components/schemas',
  'components/securitySchemes',
  'components/parameters',
  'components/requestBodies',
  'components/responses',
  'components/headers',
  'servers',
  'security'
];

// Fields that can flow bidirectionally (descriptions, examples)
const BIDIRECTIONAL_FIELDS = [
  'info.description',
  'info.contact',
  'info.license',
  'info.termsOfService',
  'externalDocs',
  'tags.*.description',
  'tags.*.externalDocs',
  'paths.*.*.summary',
  'paths.*.*.description',
  'paths.*.*.externalDocs',
  'paths.*.*.parameters.*.description',
  'paths.*.*.parameters.*.example',
  'paths.*.*.parameters.*.examples',
  'paths.*.*.requestBody.description',
  'paths.*.*.requestBody.content.*.example',
  'paths.*.*.requestBody.content.*.examples',
  'paths.*.*.responses.*.description',
  'paths.*.*.responses.*.content.*.example',
  'paths.*.*.responses.*.content.*.examples',
  'components.schemas.*.description',
  'components.schemas.*.properties.*.description',
  'components.schemas.*.properties.*.example'
];

/**
 * Deep diff implementation (simplified, no external dependency)
 * Returns array of changes between two objects
 */
function deepDiff(base, compare, path = []) {
  const changes = [];

  if (base === compare) return changes;

  if (base === null || compare === null ||
      typeof base !== 'object' || typeof compare !== 'object') {
    if (base !== compare) {
      changes.push({
        kind: base === undefined ? 'N' : compare === undefined ? 'D' : 'E',
        path: [...path],
        lhs: base,
        rhs: compare
      });
    }
    return changes;
  }

  // Handle arrays
  if (Array.isArray(base) || Array.isArray(compare)) {
    if (!Array.isArray(base) || !Array.isArray(compare)) {
      changes.push({ kind: 'E', path: [...path], lhs: base, rhs: compare });
      return changes;
    }

    const maxLen = Math.max(base.length, compare.length);
    for (let i = 0; i < maxLen; i++) {
      changes.push(...deepDiff(base[i], compare[i], [...path, i]));
    }
    return changes;
  }

  // Handle objects
  const allKeys = new Set([...Object.keys(base || {}), ...Object.keys(compare || {})]);

  for (const key of allKeys) {
    changes.push(...deepDiff(base[key], compare[key], [...path, key]));
  }

  return changes;
}

export class ChangeDetector {
  constructor(options = {}) {
    this.options = {
      strictMode: options.strictMode ?? true,  // Block unknown fields by default
      ...options
    };
  }

  /**
   * Detect and classify changes between two specs
   * @param {object} baseSpec - Original spec (common ancestor/baseline)
   * @param {object} currentSpec - Current repo spec
   * @param {object} remoteSpec - Spec derived from Postman collection
   * @returns {object} Classified changes
   */
  detectChanges(baseSpec, currentSpec, remoteSpec) {
    const changes = {
      safeToSync: [],      // Can auto-sync (descriptions, examples)
      needsReview: [],     // Require human approval (conflicts)
      blocked: [],         // Cannot reverse-sync (structural)
      tests: []            // Collection-only artifacts
    };

    // Get detailed diff between base and remote (Postman changes)
    const remoteDiff = deepDiff(baseSpec, remoteSpec);

    // Get detailed diff between base and current (repo changes)
    const localDiff = deepDiff(baseSpec, currentSpec);

    // Create a set of local change paths for conflict detection
    const localChangePaths = new Set(
      localDiff.map(change => (change.path || []).join('.'))
    );

    for (const change of remoteDiff) {
      const pathStr = (change.path || []).join('.');
      const classification = this.classifyChange(pathStr, change);

      // Check for conflicts (same path changed in both)
      const hasLocalChange = localChangePaths.has(pathStr);

      const classifiedChange = {
        path: pathStr,
        kind: change.kind,
        oldValue: change.lhs,
        newValue: change.rhs,
        direction: classification.direction,
        reason: classification.reason,
        hasConflict: hasLocalChange
      };

      switch (classification.direction) {
        case CHANGE_DIRECTION.BIDIRECTIONAL:
          if (hasLocalChange) {
            changes.needsReview.push(classifiedChange);
          } else {
            changes.safeToSync.push(classifiedChange);
          }
          break;
        case CHANGE_DIRECTION.COLLECTION_ONLY:
          changes.tests.push(classifiedChange);
          break;
        case CHANGE_DIRECTION.SPEC_TO_COLLECTION:
        default:
          changes.blocked.push(classifiedChange);
          break;
      }
    }

    return changes;
  }

  /**
   * Classify a single change by its path
   * @param {string} pathStr - Dot-separated path string
   * @param {object} change - The change object
   * @returns {object} Classification with direction and reason
   */
  classifyChange(pathStr, change) {
    // Check if path is in spec-source-of-truth list (structural)
    for (const pattern of SPEC_SOURCE_OF_TRUTH) {
      if (this.pathMatchesPattern(pathStr, pattern)) {
        // Check if it's a description/example within a structural element
        if (this.isEnrichmentWithinStructure(pathStr)) {
          return {
            direction: CHANGE_DIRECTION.BIDIRECTIONAL,
            reason: `Enrichment within structure: ${pathStr}`
          };
        }
        return {
          direction: CHANGE_DIRECTION.SPEC_TO_COLLECTION,
          reason: `Structural element: ${pattern}`
        };
      }
    }

    // Check if path is explicitly bidirectional
    for (const pattern of BIDIRECTIONAL_FIELDS) {
      if (this.pathMatchesPattern(pathStr, pattern)) {
        return {
          direction: CHANGE_DIRECTION.BIDIRECTIONAL,
          reason: `Enrichment field: ${pattern}`
        };
      }
    }

    // Check for test/script content (vendor extensions)
    if (pathStr.includes('x-postman') ||
        pathStr.includes('x-tests') ||
        pathStr.includes('event') ||
        pathStr.includes('script')) {
      return {
        direction: CHANGE_DIRECTION.COLLECTION_ONLY,
        reason: 'Test or script content'
      };
    }

    // Default behavior based on strictMode
    if (this.options.strictMode) {
      return {
        direction: CHANGE_DIRECTION.SPEC_TO_COLLECTION,
        reason: 'Unclassified - defaulting to spec-only (strict mode)'
      };
    }

    // In non-strict mode, allow unknown fields
    return {
      direction: CHANGE_DIRECTION.BIDIRECTIONAL,
      reason: 'Unclassified - allowing in non-strict mode'
    };
  }

  /**
   * Check if a path is an enrichment field within a structural element
   * e.g., paths./users.get.description is an enrichment within paths
   * Also handles nested paths like .example.0.title (changes within examples)
   */
  isEnrichmentWithinStructure(pathStr) {
    const enrichmentPatterns = [
      /\.description$/,
      /\.summary$/,
      /\.example($|\.)/,   // .example or .example.anything
      /\.examples($|\.)/,  // .examples or .examples.anything
      /\.externalDocs($|\.)/
    ];

    return enrichmentPatterns.some(pattern => pattern.test(pathStr));
  }

  /**
   * Check if a path matches a pattern (supports * wildcard)
   * @param {string} path - Actual path (e.g., "paths./users.get.description")
   * @param {string} pattern - Pattern (e.g., "paths.*.*.description")
   */
  pathMatchesPattern(path, pattern) {
    const pathParts = path.split('.');
    const patternParts = pattern.split('.');

    let pi = 0;  // path index
    let pti = 0; // pattern index

    while (pi < pathParts.length && pti < patternParts.length) {
      const patternPart = patternParts[pti];

      if (patternPart === '*') {
        // Wildcard matches any single segment
        pi++;
        pti++;
      } else if (patternPart.includes('*')) {
        // Partial wildcard (e.g., "*.description")
        const regex = new RegExp('^' + patternPart.replace(/\*/g, '.*') + '$');
        if (regex.test(pathParts[pi])) {
          pi++;
          pti++;
        } else {
          return false;
        }
      } else if (pathParts[pi] === patternPart) {
        pi++;
        pti++;
      } else {
        return false;
      }
    }

    // Pattern matched if we consumed the entire pattern
    // and either consumed entire path or pattern ends with structural element
    return pti === patternParts.length;
  }

  /**
   * Get summary statistics for a set of changes
   */
  getSummary(changes) {
    return {
      total: changes.safeToSync.length + changes.needsReview.length +
             changes.blocked.length + changes.tests.length,
      safeToSync: changes.safeToSync.length,
      needsReview: changes.needsReview.length,
      blocked: changes.blocked.length,
      tests: changes.tests.length,
      hasConflicts: changes.needsReview.some(c => c.hasConflict)
    };
  }
}

export default ChangeDetector;
