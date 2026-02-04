#!/usr/bin/env node

/**
 * Cleanup Orphaned Collections
 * 
 * Removes duplicate and test collections from the workspace.
 */

const POSTMAN_API_KEY = process.env.POSTMAN_API_KEY;
const WORKSPACE_ID = process.env.POSTMAN_WORKSPACE_ID || '06d2843a-af55-4443-a628-83a45a979403';
const POSTMAN_API_BASE = 'https://api.getpostman.com';

// Collections to KEEP (canonical) - most recent ones
const KEEP_COLLECTIONS = [
  '17929829-67bb1b61-c4fd-4ed8-9459-43b3b8481d9e', // Task Management API (main/docs)
  '17929829-0dd01e53-6869-48c4-b746-9daa32438582', // Task Management API - Smoke Tests
  '17929829-c0e8f9e8-d8ab-4dfa-8713-7671848e667b', // Task Management API - Contract Tests
];

async function apiRequest(method, endpoint) {
  const url = `${POSTMAN_API_BASE}${endpoint}`;
  const options = {
    method,
    headers: {
      'X-Api-Key': POSTMAN_API_KEY,
      'Content-Type': 'application/json'
    }
  };

  const response = await fetch(url, options);
  
  if (!response.ok && response.status !== 404) {
    const data = await response.json();
    throw new Error(`API Error ${response.status}: ${JSON.stringify(data.error || data)}`);
  }
  
  if (response.status === 404) {
    return null;
  }
  
  return response.json();
}

async function main() {
  console.log('🔍 Fetching collections from workspace...\n');
  
  const result = await apiRequest('GET', `/collections?workspace=${WORKSPACE_ID}`);
  const collections = result.collections || [];
  
  console.log(`Found ${collections.length} collections:\n`);
  
  // Categorize
  const toKeep = [];
  const toDelete = [];
  
  for (const collection of collections) {
    if (KEEP_COLLECTIONS.includes(collection.uid)) {
      toKeep.push(collection);
    } else {
      toDelete.push(collection);
    }
  }
  
  console.log('✅ Keeping (canonical):');
  for (const c of toKeep) {
    console.log(`  - ${c.name} (${c.uid})`);
  }
  
  console.log('\n🗑️  Deleting (orphaned/test):');
  for (const c of toDelete) {
    console.log(`  - ${c.name} (${c.uid})`);
  }
  
  console.log(`\nDelete ${toDelete.length} collections? (y/N)`);
  
  // Auto-confirm for now (or add prompt)
  console.log('Auto-confirming...\n');
  
  for (const collection of toDelete) {
    try {
      await apiRequest('DELETE', `/collections/${collection.uid}`);
      console.log(`✅ Deleted: ${collection.name}`);
    } catch (error) {
      console.log(`❌ Failed to delete ${collection.name}: ${error.message}`);
    }
  }
  
  console.log('\n✨ Cleanup complete!');
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
