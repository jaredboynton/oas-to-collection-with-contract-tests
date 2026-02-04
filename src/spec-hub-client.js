#!/usr/bin/env node

/**
 * Spec Hub Client
 * 
 * Handles all interactions with Postman Spec Hub API.
 * Uses native fetch with Postman API key authentication.
 */

import fs from 'fs';

const POSTMAN_API_BASE = 'https://api.getpostman.com';

class SpecHubClient {
  constructor(apiKey, workspaceId) {
    this.apiKey = apiKey;
    this.workspaceId = workspaceId;
  }

  /**
   * Make authenticated API request
   */
  async request(method, endpoint, body = null) {
    const url = `${POSTMAN_API_BASE}${endpoint}`;
    const options = {
      method,
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`API Error ${response.status}: ${JSON.stringify(data.error || data)}`);
    }

    return data;
  }

  /**
   * Upload or update spec in Spec Hub
   */
  async uploadSpec(name, specContent, specId = null) {
    const payload = {
      name,
      type: 'OPENAPI:3.0',
      files: [
        {
          path: 'index.json',
          content: typeof specContent === 'string' ? specContent : JSON.stringify(specContent)
        }
      ]
    };

    if (specId) {
      // Update existing spec
      await this.request('PATCH', `/specs/${specId}/files/index.json`, {
        content: payload.files[0].content
      });
      return specId;
    } else {
      // Create new spec
      const result = await this.request('POST', `/specs?workspaceId=${this.workspaceId}`, payload);
      return result.id;
    }
  }

  /**
   * Get collections generated from a spec
   * Distinguishes between "no collections" (404) and API errors
   */
  async getSpecGeneratedCollections(specId) {
    try {
      const result = await this.request('GET', `/specs/${specId}/generations/collection`);
      return result.collections || [];
    } catch (error) {
      // Check if it's a 404 (no collections yet) vs a real API error
      const statusMatch = error.message.match(/API Error (\d+)/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : null;
      
      if (statusCode === 404) {
        // No collections generated yet - this is expected for new specs
        return [];
      }
      
      // For other errors, log and re-throw
      console.error(`  Error fetching spec collections: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate or sync collection from spec
   * 
   * If collection with same name exists for this spec, sync it.
   * Otherwise, generate a new collection.
   */
  async generateOrSyncCollection(specId, name, options = {}) {
    // First, check if a collection with this name already exists for this spec
    const existingCollections = await this.getSpecGeneratedCollections(specId);
    const existingCollection = existingCollections.find(c => c.name === name);

    if (existingCollection) {
      // Collection exists, sync it with the spec
      // The ID from spec generations is just the collection ID
      // We need to find the full UID from the collections list
      console.log(`  Syncing existing collection: ${existingCollection.id}`);
      await this.syncCollectionWithSpec(existingCollection.id, specId);
      
      // Wait for sync to complete
      await this.waitForCollectionSync(existingCollection.id);
      
      // Find the full UID from collections list
      const collections = await this.request('GET', `/collections?workspace=${this.workspaceId}`);
      const collection = collections.collections?.find(c => c.name === name);
      
      if (!collection) {
        throw new Error(`Synced collection "${name}" not found`);
      }
      
      return collection.uid;
    }

    // No existing collection, generate new one
    console.log(`  Generating new collection: ${name}`);
    const payload = {
      name,
      options: {
        enableOptionalParameters: options.enableOptionalParameters ?? true,
        folderStrategy: options.folderStrategy || 'Tags',
        ...options
      }
    };

    await this.request(
      'POST',
      `/specs/${specId}/generations/collection`,
      payload
    );

    // Collection generation is async, wait for it to complete
    await this.waitForCollectionGeneration(name);

    // Find and return the generated collection
    const collections = await this.request('GET', `/collections?workspace=${this.workspaceId}`);
    const collection = collections.collections?.find(c => c.name === name);

    if (!collection) {
      throw new Error(`Generated collection "${name}" not found`);
    }

    return collection.uid;
  }

  /**
   * Sync collection with spec
   */
  async syncCollectionWithSpec(collectionId, specId) {
    return this.request(
      'PUT',
      `/collections/${collectionId}/synchronizations?specId=${specId}`
    );
  }

  /**
   * Wait for collection sync to complete with exponential backoff
   */
  async waitForCollectionSync(collectionUid, maxAttempts = 15) {
    let delay = 2000; // Start with 2 seconds
    
    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(delay);

      // Check if collection is accessible and stable
      try {
        const collection = await this.getCollectionWithRetry(collectionUid);
        if (collection && collection.collection) {
          // Collection exists and is accessible - sync is likely complete
          return collection;
        }
      } catch (error) {
        // Collection might be temporarily unavailable during sync
        console.log(`  Waiting for sync... (${i + 1}/${maxAttempts})`);
      }
      
      // Exponential backoff: 2s, 3s, 4.5s, 6.75s... (max 10s)
      delay = Math.min(delay * 1.5, 10000);
    }

    throw new Error(`Collection sync timed out after ${maxAttempts} attempts`);
  }

  /**
   * Wait for collection generation to complete with exponential backoff
   */
  async waitForCollectionGeneration(name, maxAttempts = 15) {
    let delay = 2000; // Start with 2 seconds
    
    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(delay);

      try {
        const collections = await this.request('GET', `/collections?workspace=${this.workspaceId}`);
        const collection = collections.collections?.find(c => c.name === name);

        if (collection) {
          return collection;
        }
      } catch (error) {
        console.log(`  Waiting for generation... (${i + 1}/${maxAttempts})`);
      }
      
      // Exponential backoff
      delay = Math.min(delay * 1.5, 10000);
    }

    throw new Error(`Collection generation timed out after ${maxAttempts} attempts`);
  }

  /**
   * Get collection with retry logic for transient failures
   */
  async getCollectionWithRetry(collectionUid, maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.getCollection(collectionUid);
      } catch (error) {
        lastError = error;
        
        // Only retry on 5xx errors or network issues
        const statusCode = error.message.match(/API Error (\d+)/)?.[1];
        if (statusCode && parseInt(statusCode) < 500) {
          throw error; // Don't retry 4xx errors
        }
        
        if (i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
          console.log(`  Retrying collection fetch... (${i + 1}/${maxRetries})`);
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Sleep utility for async delays
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get collection details
   */
  async getCollection(collectionUid) {
    return this.request('GET', `/collections/${collectionUid}`);
  }

  /**
   * Update collection
   */
  async updateCollection(collectionUid, collection) {
    return this.request('PUT', `/collections/${collectionUid}`, { collection });
  }

  /**
   * Add test scripts to collection requests
   */
  async addTestScripts(collectionUid, testScripts) {
    const collectionData = await this.getCollection(collectionUid);
    const collection = collectionData.collection;

    // Recursively add tests to all request items
    this.addTestsToItems(collection.item, testScripts);

    // Update the collection
    await this.updateCollection(collectionUid, collection);

    return collection;
  }

  /**
   * Recursively add test scripts to collection items
   */
  addTestsToItems(items, testScripts) {
    for (const item of items) {
      if (item.request) {
        // This is a request item, add tests
        const testScript = testScripts[item.name] || testScripts['default'];
        if (testScript) {
          item.event = item.event || [];
          
          // Remove existing test events
          item.event = item.event.filter(e => e.listen !== 'test');
          
          // Add new test event
          item.event.push({
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: Array.isArray(testScript) ? testScript : testScript.split('\n')
            }
          });
        }
      }

      if (item.item) {
        // Recurse into folders
        this.addTestsToItems(item.item, testScripts);
      }
    }
  }

  /**
   * Delete spec
   */
  async deleteSpec(specId) {
    return this.request('DELETE', `/specs/${specId}`);
  }

  /**
   * Delete collection
   */
  async deleteCollection(collectionUid) {
    return this.request('DELETE', `/collections/${collectionUid}`);
  }

  /**
   * List specs in workspace
   */
  async listSpecs() {
    const result = await this.request('GET', `/specs?workspaceId=${this.workspaceId}`);
    return result.specs || [];
  }

  /**
   * Find spec by name
   */
  async findSpecByName(name) {
    const specs = await this.listSpecs();
    return specs.find(s => s.name === name);
  }

  /**
   * Get collection tags
   */
  async getCollectionTags(collectionUid) {
    return this.request('GET', `/collections/${collectionUid}/tags`);
  }

  /**
   * Update collection tags (replaces all existing tags)
   * @param {string} collectionUid - Collection UID
   * @param {string[]} tags - Array of tag slugs
   */
  async updateCollectionTags(collectionUid, tags) {
    // Validate and format tags
    const formattedTags = tags.map(tag => ({
      slug: this.validateTag(tag)
    }));

    return this.request('PUT', `/collections/${collectionUid}/tags`, {
      tags: formattedTags
    });
  }

  /**
   * Validate and format a tag according to Postman rules:
   * - 2-64 characters
   * - Must match: ^[a-z][a-z0-9-]*[a-z0-9]+$
   * - Starts with letter, ends with letter/number, can contain hyphens
   */
  validateTag(tag) {
    if (!tag || typeof tag !== 'string') {
      throw new Error('Tag must be a non-empty string');
    }

    // Convert to lowercase and replace invalid characters
    let clean = tag.toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')  // Replace invalid chars with hyphens
      .replace(/^-+|-+$/g, '');      // Trim leading/trailing hyphens

    // Ensure starts with letter
    if (!/^[a-z]/.test(clean)) {
      clean = 'tag-' + clean;
    }

    // Ensure ends with letter or number
    if (!/[a-z0-9]$/.test(clean)) {
      clean = clean + '0';
    }

    // Length validation (2-64 chars)
    if (clean.length < 2) {
      clean = 'tag-' + clean;
    }
    if (clean.length > 64) {
      clean = clean.substring(0, 64).replace(/-+$/, '');  // Trim without trailing hyphen
      // Re-check ending
      if (!/[a-z0-9]$/.test(clean)) {
        clean = clean.substring(0, 63) + '0';
      }
    }

    return clean;
  }

  /**
   * Apply standard tags to a collection based on type
   * @param {string} collectionUid - Collection UID
   * @param {string} type - Collection type: 'main', 'smoke', or 'contract'
   */
  async applyCollectionTags(collectionUid, type) {
    const tagMap = {
      'main': ['generated', 'docs'],
      'smoke': ['generated', 'smoke'],
      'contract': ['generated', 'contract']
    };

    const tags = tagMap[type];
    if (!tags) {
      throw new Error(`Unknown collection type: ${type}. Use 'main', 'smoke', or 'contract'.`);
    }

    return this.updateCollectionTags(collectionUid, tags);
  }

  // ============================================================
  // BIDIRECTIONAL SYNC METHODS
  // ============================================================

  /**
   * Get all collections in workspace with metadata (for change detection)
   * Returns uid, name, and updatedAt for efficient polling
   */
  async getWorkspaceCollections() {
    const result = await this.request('GET', `/collections?workspace=${this.workspaceId}`);
    return result.collections || [];
  }

  /**
   * Get all environments in workspace with metadata (for change detection)
   */
  async getWorkspaceEnvironments() {
    const result = await this.request('GET', `/environments?workspace=${this.workspaceId}`);
    return result.environments || [];
  }

  /**
   * Get environment by UID
   */
  async getEnvironment(environmentUid) {
    return this.request('GET', `/environments/${environmentUid}`);
  }

  /**
   * Convert collection back to OpenAPI via Postman API
   * Uses Postman's native transformation - returns OpenAPI spec derived from collection
   * @param {string} collectionUid - Collection UID to transform
   * @returns {object} Parsed OpenAPI specification
   */
  async getCollectionAsOpenApi(collectionUid) {
    const result = await this.request(
      'GET',
      `/collections/${collectionUid}/transformations?format=openapi3`
    );
    // result.output is a stringified JSON
    return typeof result.output === 'string'
      ? JSON.parse(result.output)
      : result.output;
  }

  /**
   * Create a fork of a collection
   * @param {string} collectionUid - Source collection UID
   * @param {string} forkLabel - Label for the fork
   * @param {string} targetWorkspaceId - Optional target workspace (defaults to current)
   */
  async forkCollection(collectionUid, forkLabel, targetWorkspaceId = null) {
    const workspaceParam = targetWorkspaceId || this.workspaceId;

    return this.request(
      'POST',
      `/collections/fork/${collectionUid}?workspace=${workspaceParam}`,
      { label: forkLabel }
    );
  }

  /**
   * List all forks of a collection
   * @param {string} collectionUid - Collection UID to list forks for
   */
  async getCollectionForks(collectionUid) {
    const result = await this.request('GET', `/collections/${collectionUid}/forks`);
    return result.forks || [];
  }

  /**
   * Create a pull request from fork to parent collection
   * @param {string} destinationCollectionUid - Parent collection UID (PR target)
   * @param {string} sourceCollectionUid - Fork collection UID (PR source)
   * @param {object} options - PR options (title, description)
   */
  async createPullRequest(destinationCollectionUid, sourceCollectionUid, options = {}) {
    return this.request(
      'POST',
      `/collections/${destinationCollectionUid}/pull-requests`,
      {
        title: options.title || 'Sync changes from fork',
        description: options.description || '',
        source: sourceCollectionUid
      }
    );
  }

  /**
   * Get pull requests for a collection
   * @param {string} collectionUid - Collection UID
   * @param {string} status - Filter by status: 'open', 'merged', 'declined'
   */
  async getPullRequests(collectionUid, status = 'open') {
    const result = await this.request(
      'GET',
      `/collections/${collectionUid}/pull-requests?status=${status}`
    );
    return result.pullRequests || result.data || [];
  }

  /**
   * Merge a pull request
   * @param {string} collectionUid - Collection UID (PR destination)
   * @param {string} pullRequestId - Pull request ID to merge
   */
  async mergePullRequest(collectionUid, pullRequestId) {
    return this.request(
      'POST',
      `/collections/${collectionUid}/pull-requests/${pullRequestId}/merge`
    );
  }

  /**
   * Decline a pull request
   * @param {string} collectionUid - Collection UID (PR destination)
   * @param {string} pullRequestId - Pull request ID to decline
   */
  async declinePullRequest(collectionUid, pullRequestId) {
    return this.request(
      'PUT',
      `/collections/${collectionUid}/pull-requests/${pullRequestId}`,
      { status: 'declined' }
    );
  }
}

export default SpecHubClient;
export { SpecHubClient };
