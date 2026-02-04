#!/usr/bin/env node

/**
 * Spec Hub Sync
 * 
 * Main orchestrator for the Spec Hub workflow:
 * 1. Parse OpenAPI spec
 * 2. Upload/update spec in Spec Hub
 * 3. Generate docs collection (via Spec Hub)
 * 4. Generate test collection (via Spec Hub + inject tests)
 * 5. Upload environment
 */

import { parseSpec } from './parser.js';
import { generateTestScriptsForSpec } from './test-generator.js';
import { SpecHubClient } from './spec-hub-client.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  log(`\n[${step}] ${message}`, BLUE);
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

// CLI argument parsing
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    spec: null,
    workspaceId: process.env.POSTMAN_WORKSPACE_ID,
    apiKey: process.env.POSTMAN_API_KEY,
    dryRun: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--spec':
      case '-s':
        options.spec = args[++i];
        break;
      case '--workspace':
      case '-w':
        options.workspaceId = args[++i];
        break;
      case '--api-key':
      case '-k':
        options.apiKey = args[++i];
        break;
      case '--dry-run':
      case '-d':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Spec Hub Sync - Upload specs and generate collections with contract tests

Usage:
  node src/spec-hub-sync.js --spec <path> [options]

Options:
  --spec, -s        Path to OpenAPI spec file (required)
  --workspace, -w   Postman workspace ID (default: env.POSTMAN_WORKSPACE_ID)
  --api-key, -k     Postman API key (default: env.POSTMAN_API_KEY)
  --dry-run, -d     Validate without uploading
  --help, -h        Show this help message

Environment Variables:
  POSTMAN_API_KEY       Required - Your Postman API key
  POSTMAN_WORKSPACE_ID  Required - Target workspace ID

Examples:
  # Basic usage
  node src/spec-hub-sync.js --spec specs/api.yaml

  # With explicit credentials
  node src/spec-hub-sync.js --spec specs/api.yaml --workspace <id> --api-key <key>

  # Dry run (validate only)
  node src/spec-hub-sync.js --spec specs/api.yaml --dry-run
`);
}

// Generate environment file
function generateEnvironment(api) {
  const servers = api.servers || [{ url: 'https://api.example.com' }];
  const baseUrl = servers[0].url;

  return {
    name: `${api.info?.title || 'API'} Environment`,
    values: [
      {
        key: 'baseUrl',
        value: baseUrl,
        type: 'default',
        enabled: true
      },
      {
        key: 'RESPONSE_TIME_THRESHOLD',
        value: '2000',
        type: 'default',
        enabled: true
      },
      {
        key: 'auth_token',
        value: '',
        type: 'secret',
        enabled: true
      }
    ],
    _postman_variable_scope: 'environment'
  };
}

// Main sync function
async function sync(options) {
  log('\n═══════════════════════════════════════════════════════════', BLUE);
  log('  Spec Hub Sync', BLUE);
  log('═══════════════════════════════════════════════════════════\n', BLUE);

  // Validate options
  if (!options.spec) {
    logError('Spec file path is required (--spec)');
    process.exit(1);
  }

  if (!options.apiKey) {
    logError('Postman API key is required (--api-key or env.POSTMAN_API_KEY)');
    process.exit(1);
  }

  if (!options.workspaceId) {
    logError('Workspace ID is required (--workspace or env.POSTMAN_WORKSPACE_ID)');
    process.exit(1);
  }

  if (options.dryRun) {
    logInfo('DRY RUN MODE - No changes will be made\n');
  }

  // Initialize client
  const client = new SpecHubClient(options.apiKey, options.workspaceId);

  // Step 1: Parse OpenAPI spec
  logStep('Step 1', 'Parsing OpenAPI spec');
  const api = await parseSpec(options.spec);
  const specName = api.info?.title || 'Untitled API';
  logSuccess(`Parsed: ${specName} (${api.info?.version || 'unknown version'})`);

  if (options.dryRun) {
    logInfo('Dry run complete - spec is valid');
    return;
  }

  // Step 2: Check for existing spec
  logStep('Step 2', 'Checking for existing spec in Spec Hub');
  let specId = null;
  try {
    const existingSpec = await client.findSpecByName(specName);
    if (existingSpec) {
      specId = existingSpec.id;
      logInfo(`Found existing spec: ${specId}`);
    } else {
      logInfo('No existing spec found - will create new');
    }
  } catch (error) {
    logInfo('Could not check for existing spec - will create new');
  }

  // Step 3: Upload spec to Spec Hub
  logStep('Step 3', 'Uploading spec to Spec Hub');
  const specContent = fs.readFileSync(options.spec, 'utf8');
  specId = await client.uploadSpec(specName, specContent, specId);
  logSuccess(`Spec uploaded: ${specId}`);

  // Step 4: Generate docs collection
  logStep('Step 4', 'Generating docs collection from Spec Hub');
  const docsCollectionName = `${specName} - Docs`;
  let docsCollectionUid = null;
  try {
    docsCollectionUid = await client.generateCollection(specId, docsCollectionName, {
      enableOptionalParameters: true,
      folderStrategy: 'Tags'
    });
    logSuccess(`Docs collection generated: ${docsCollectionUid}`);
  } catch (error) {
    logError(`Failed to generate docs collection: ${error.message}`);
    // Continue - docs collection is nice-to-have
  }

  // Wait a bit before generating test collection (Spec Hub lock)
  logInfo('Waiting for Spec Hub to complete...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Step 5: Generate test collection
  logStep('Step 5', 'Generating test collection from Spec Hub');
  const testCollectionName = `${specName} - Tests`;
  const testCollectionUid = await client.generateCollection(specId, testCollectionName, {
    enableOptionalParameters: true,
    folderStrategy: 'Tags'
  });
  logSuccess(`Test collection generated: ${testCollectionUid}`);

  // Step 6: Generate and inject contract tests
  logStep('Step 6', 'Generating contract tests');
  const testScripts = generateTestScriptsForSpec(api);
  const testCount = Object.keys(testScripts).length - 1; // Exclude 'default'
  logInfo(`Generated ${testCount} test scripts`);

  logStep('Step 7', 'Injecting contract tests into test collection');
  await client.addTestScripts(testCollectionUid, testScripts);
  logSuccess('Contract tests injected into collection');

  // Step 7: Create/update environment
  logStep('Step 8', 'Creating environment');
  const environment = generateEnvironment(api);
  
  // Check for existing environment
  const environments = await client.request('GET', `/environments?workspace=${options.workspaceId}`);
  const existingEnv = environments.environments?.find(e => e.name === environment.name);
  
  if (existingEnv) {
    // Update existing
    await client.request('PUT', `/environments/${existingEnv.uid}`, { environment });
    logSuccess(`Environment updated: ${existingEnv.uid}`);
  } else {
    // Create new
    const envResult = await client.request('POST', `/environments?workspace=${options.workspaceId}`, { environment });
    logSuccess(`Environment created: ${envResult.environment?.uid}`);
  }

  // Summary
  log('\n═══════════════════════════════════════════════════════════', BLUE);
  log('  SYNC SUMMARY', BLUE);
  log('═══════════════════════════════════════════════════════════\n', BLUE);

  logSuccess(`Spec: ${specName}`);
  logSuccess(`Spec Hub ID: ${specId}`);
  if (docsCollectionUid) {
    logSuccess(`Docs Collection: ${docsCollectionUid}`);
  }
  logSuccess(`Test Collection: ${testCollectionUid}`);
  logSuccess(`Contract Tests: ${testCount} endpoints covered`);

  log('\n📋 Next Steps:', BLUE);
  log('  1. Open Postman and verify collections in workspace');
  log('  2. Run tests: postman collection run "' + testCollectionName + '"');
  log('  3. On spec change, re-run: node src/spec-hub-sync.js --spec ' + options.spec);

  log('\n═══════════════════════════════════════════════════════════\n', BLUE);
}

// Run
const options = parseArgs();

if (options.help) {
  showHelp();
  process.exit(0);
}

sync(options).catch(error => {
  logError(`Sync failed: ${error.message}`);
  console.error(error);
  process.exit(1);
});
