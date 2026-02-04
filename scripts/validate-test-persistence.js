#!/usr/bin/env node

/**
 * Spec Hub Test Persistence Validation
 * 
 * This script validates whether custom test scripts persist when
 * Spec Hub re-generates a collection from an updated spec.
 * 
 * Test Procedure:
 * 1. Create minimal OpenAPI spec
 * 2. Upload to Spec Hub
 * 3. Generate collection from spec
 * 4. Add test scripts to collection via API
 * 5. Update spec in Spec Hub
 * 6. Re-generate collection
 * 7. Verify if test scripts persist
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const POSTMAN_API_KEY = process.env.POSTMAN_API_KEY;
const WORKSPACE_ID = process.env.POSTMAN_WORKSPACE_ID || '06d2843a-af55-4443-a628-83a45a979403';
const POSTMAN_API_BASE = 'https://api.getpostman.com';

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function log(message, color = RESET) {
  console.log(`${color}${message}${RESET}`);
}

function logStep(step, message) {
  log(`\n[Step ${step}] ${message}`, BLUE);
}

function logSuccess(message) {
  log(`✅ ${message}`, GREEN);
}

function logError(message) {
  log(`❌ ${message}`, RED);
}

function logInfo(message) {
  log(`ℹ️  ${message}`, YELLOW);
}

// Validate environment
function validateEnv() {
  if (!POSTMAN_API_KEY) {
    logError('POSTMAN_API_KEY environment variable is required');
    process.exit(1);
  }
  logSuccess('Environment variables validated');
}

// Make API request
async function apiRequest(method, endpoint, body = null) {
  const url = `${POSTMAN_API_BASE}${endpoint}`;
  const options = {
    method,
    headers: {
      'X-Api-Key': POSTMAN_API_KEY,
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

// Step 1: Create minimal OpenAPI spec
function createMinimalSpec() {
  logStep(1, 'Creating minimal OpenAPI spec');
  
  const spec = {
    openapi: '3.0.0',
    info: {
      title: 'Test Persistence API',
      version: '1.0.0',
      description: 'Minimal API for testing Spec Hub test persistence'
    },
    servers: [
      { url: 'https://api.example.com/v1', description: 'Production' }
    ],
    paths: {
      '/test': {
        get: {
          summary: 'Test endpoint',
          operationId: 'testEndpoint',
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  
  const specPath = path.join(__dirname, '..', 'output', 'test-persistence-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  logSuccess(`Created spec at ${specPath}`);
  
  return { spec, specPath };
}

// Step 2: Upload spec to Spec Hub
async function uploadSpecToSpecHub(spec) {
  logStep(2, 'Uploading spec to Spec Hub');
  
  const payload = {
    name: 'Test Persistence API',
    type: 'OPENAPI:3.0',
    files: [
      {
        path: 'index.json',
        content: JSON.stringify(spec)
      }
    ]
  };
  
  const result = await apiRequest(
    'POST',
    `/specs?workspaceId=${WORKSPACE_ID}`,
    payload
  );
  
  const specId = result.id || result.spec?.id;
  logSuccess(`Uploaded spec to Spec Hub: ${specId}`);
  
  if (!specId) {
    throw new Error('Spec ID not found in response: ' + JSON.stringify(result));
  }
  
  return specId;
}

// Step 3: Generate collection from spec
async function generateCollectionFromSpec(specId) {
  logStep(3, 'Generating collection from spec');
  
  const payload = {
    name: 'Test Persistence Collection',
    options: {
      enableOptionalParameters: true,
      folderStrategy: 'Tags'
    }
  };
  
  const result = await apiRequest(
    'POST',
    `/specs/${specId}/generations/collection`,
    payload
  );
  
  // Collection generation is async, we need to poll for completion
  logInfo('Collection generation started, polling for completion...');
  
  // Wait a bit for generation to complete
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Get the generated collection
  const collectionsResult = await apiRequest(
    'GET',
    `/collections?workspace=${WORKSPACE_ID}`
  );
  
  const collection = collectionsResult.collections?.find(
    c => c.name === 'Test Persistence Collection'
  );
  
  if (!collection) {
    throw new Error('Generated collection not found');
  }
  
  logSuccess(`Collection generated: ${collection.uid}`);
  
  return collection.uid;
}

// Step 4: Add test scripts to collection
async function addTestScriptsToCollection(collectionUid) {
  logStep(4, 'Adding test scripts to collection');
  
  // Get current collection - use full UID
  const collectionData = await apiRequest(
    'GET',
    `/collections/${collectionUid}`
  );
  
  const collection = collectionData.collection;
  
  // Add test script to the first request
  if (collection.item && collection.item.length > 0) {
    const item = collection.item[0];
    
    // Add test event
    item.event = [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            '// Custom test added for persistence validation',
            'pm.test("Status code is 200", function () {',
            '    pm.response.to.have.status(200);',
            '});',
            '',
            'pm.test("Response has id field", function () {',
            '    const jsonData = pm.response.json();',
            '    pm.expect(jsonData).to.have.property("id");',
            '});'
          ]
        }
      }
    ];
    
    // Update collection - use full UID
    await apiRequest(
      'PUT',
      `/collections/${collectionUid}`,
      { collection }
    );
    
    logSuccess('Added test scripts to collection');
  } else {
    throw new Error('Collection has no items to add tests to');
  }
  
  // Verify tests were added - use full UID
  const verifyData = await apiRequest(
    'GET',
    `/collections/${collectionUid}`
  );
  
  const hasTests = verifyData.collection.item?.[0]?.event?.some(
    e => e.listen === 'test'
  );
  
  if (hasTests) {
    logSuccess('Verified: Test scripts are present in collection');
  } else {
    throw new Error('Test scripts not found after adding');
  }
  
  return collectionUid;
}

// Step 5: Update spec in Spec Hub
async function updateSpecInSpecHub(specId, originalSpec) {
  logStep(5, 'Updating spec in Spec Hub');
  
  // Modify the spec slightly
  const updatedSpec = {
    ...originalSpec,
    info: {
      ...originalSpec.info,
      description: 'Updated description for persistence test'
    },
    paths: {
      ...originalSpec.paths,
      '/test2': {
        get: {
          summary: 'New endpoint added',
          operationId: 'testEndpoint2',
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  
  const payload = {
    content: JSON.stringify(updatedSpec)
  };
  
  await apiRequest(
    'PATCH',
    `/specs/${specId}/files/index.json`,
    payload
  );
  
  logSuccess('Updated spec in Spec Hub');
  
  return updatedSpec;
}

// Step 6: Re-generate collection from updated spec
async function regenerateCollectionFromSpec(specId) {
  logStep(6, 'Re-generating collection from updated spec');
  
  const payload = {
    name: 'Test Persistence Collection',
    options: {
      enableOptionalParameters: true,
      folderStrategy: 'Tags'
    }
  };
  
  const result = await apiRequest(
    'POST',
    `/specs/${specId}/generations/collection`,
    payload
  );
  
  logInfo('Collection re-generation started, waiting...');
  
  // Wait for generation
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  logSuccess('Collection re-generated');
}

// Step 7: Verify if test scripts persist
async function verifyTestPersistence(collectionId) {
  logStep(7, 'Verifying if test scripts persist');
  
  const collectionData = await apiRequest(
    'GET',
    `/collections/${collectionId}`
  );
  
  const collection = collectionData.collection;
  
  // Check for test scripts
  let hasTests = false;
  let testCount = 0;
  
  function checkItems(items) {
    for (const item of items) {
      if (item.event) {
        const testEvents = item.event.filter(e => e.listen === 'test');
        if (testEvents.length > 0) {
          hasTests = true;
          testCount += testEvents.length;
        }
      }
      if (item.item) {
        checkItems(item.item);
      }
    }
  }
  
  if (collection.item) {
    checkItems(collection.item);
  }
  
  logInfo(`Found ${testCount} test event(s) in collection`);
  
  return { hasTests, testCount, collection };
}

// Cleanup
async function cleanup(specId, collectionUid) {
  logStep('Cleanup', 'Removing test resources');
  
  try {
    // Delete collection
    if (collectionUid) {
      await apiRequest('DELETE', `/collections/${collectionUid}`);
      logSuccess('Deleted test collection');
    }
    
    // Delete spec
    if (specId) {
      await apiRequest('DELETE', `/specs/${specId}`);
      logSuccess('Deleted test spec');
    }
  } catch (error) {
    logError(`Cleanup error: ${error.message}`);
  }
}

// Main validation function
async function main() {
  log('\n═══════════════════════════════════════════════════════════', BLUE);
  log('  Spec Hub Test Persistence Validation', BLUE);
  log('═══════════════════════════════════════════════════════════\n', BLUE);
  
  let specId = null;
  let collectionUid = null;
  
  try {
    // Validate environment
    validateEnv();
    
    // Step 1: Create minimal spec
    const { spec, specPath } = createMinimalSpec();
    
    // Step 2: Upload spec
    specId = await uploadSpecToSpecHub(spec);
    
    // Step 3: Generate collection
    collectionUid = await generateCollectionFromSpec(specId);
    
    // Step 4: Add test scripts
    await addTestScriptsToCollection(collectionUid);
    
    // Step 5: Update spec
    await updateSpecInSpecHub(specId, spec);
    
    // Step 6: Re-generate collection
    await regenerateCollectionFromSpec(specId);
    
    // Step 7: Verify persistence
    const { hasTests, testCount, collection } = await verifyTestPersistence(collectionUid);
    
    // Results
    log('\n═══════════════════════════════════════════════════════════', BLUE);
    log('  VALIDATION RESULTS', BLUE);
    log('═══════════════════════════════════════════════════════════\n', BLUE);
    
    if (hasTests) {
      logSuccess('TEST SCRIPTS PERSIST! ✅');
      logSuccess(`Found ${testCount} test event(s) after re-generation`);
      log('\n📋 CONCLUSION:', GREEN);
      log('Custom test scripts ARE preserved when Spec Hub re-generates collections.', GREEN);
      log('Architecture: Inject tests into Spec Hub-generated collection ✅', GREEN);
    } else {
      logError('TEST SCRIPTS DO NOT PERSIST ❌');
      logError('No test events found after re-generation');
      log('\n📋 CONCLUSION:', RED);
      log('Custom test scripts are OVERWRITTEN when Spec Hub re-generates collections.', RED);
      log('Architecture: Use clone-and-inject or hybrid approach', RED);
    }
    
    // Additional info
    log('\n📊 Collection Info:', YELLOW);
    log(`  - Name: ${collection.name}`, YELLOW);
    log(`  - UID: ${collection.uid}`, YELLOW);
    log(`  - Linked to spec: ${collection.info?._postman_id || 'N/A'}`, YELLOW);
    
  } catch (error) {
    logError(`Validation failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  } finally {
    // Cleanup
    await cleanup(specId, collectionUid);
    
    // Clean up local file
    try {
      fs.unlinkSync(path.join(__dirname, '..', 'output', 'test-persistence-spec.json'));
    } catch (e) {
      // Ignore
    }
  }
  
  log('\n═══════════════════════════════════════════════════════════', BLUE);
  log('  Validation Complete', BLUE);
  log('═══════════════════════════════════════════════════════════\n', BLUE);
}

main();
