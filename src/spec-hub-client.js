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
   * Generate collection from spec
   */
  async generateCollection(specId, name, options = {}) {
    const payload = {
      name,
      options: {
        enableOptionalParameters: options.enableOptionalParameters ?? true,
        folderStrategy: options.folderStrategy || 'Tags',
        ...options
      }
    };

    const result = await this.request(
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
   * Wait for collection generation to complete
   */
  async waitForCollectionGeneration(name, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const collections = await this.request('GET', `/collections?workspace=${this.workspaceId}`);
      const collection = collections.collections?.find(c => c.name === name);

      if (collection) {
        return;
      }
    }

    throw new Error(`Collection generation timed out after ${maxAttempts * 2} seconds`);
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
}

export default SpecHubClient;
export { SpecHubClient };
