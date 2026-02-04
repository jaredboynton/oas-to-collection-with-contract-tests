#!/usr/bin/env node

/**
 * Cleanup Orphaned Specs
 * 
 * Removes test specs from the workspace.
 */

const POSTMAN_API_KEY = process.env.POSTMAN_API_KEY;
const POSTMAN_API_BASE = 'https://api.getpostman.com';

// Specs to KEEP (canonical)
const KEEP_SPECS = [
  '14b1f350-13aa-44b1-add1-b5916fc0e380', // Task Management API
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
  console.log('🔍 Fetching specs from workspace...\n');
  
  const result = await apiRequest('GET', `/specs?workspaceId=06d2843a-af55-4443-a628-83a45a979403`);
  const specs = result.specs || [];
  
  console.log(`Found ${specs.length} specs:\n`);
  
  // Categorize
  const toKeep = [];
  const toDelete = [];
  
  for (const spec of specs) {
    if (KEEP_SPECS.includes(spec.id)) {
      toKeep.push(spec);
    } else {
      toDelete.push(spec);
    }
  }
  
  console.log('✅ Keeping (canonical):');
  for (const s of toKeep) {
    console.log(`  - ${s.name} (${s.id})`);
  }
  
  console.log('\n🗑️  Deleting (test/orphaned):');
  for (const s of toDelete) {
    console.log(`  - ${s.name} (${s.id})`);
  }
  
  console.log(`\nDelete ${toDelete.length} specs?\n`);
  
  for (const spec of toDelete) {
    try {
      await apiRequest('DELETE', `/specs/${spec.id}`);
      console.log(`✅ Deleted: ${spec.name}`);
    } catch (error) {
      console.log(`❌ Failed to delete ${spec.name}: ${error.message}`);
    }
  }
  
  console.log('\n✨ Cleanup complete!');
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
