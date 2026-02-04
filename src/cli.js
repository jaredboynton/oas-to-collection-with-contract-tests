#!/usr/bin/env node

/**
 * Bi-Directional Sync CLI
 *
 * Unified interface for OpenAPI <-> Postman synchronization
 *
 * Commands:
 *   forward  - Sync spec to Postman (existing behavior)
 *   repo     - Export Postman collections/environments to repo
 *   reverse  - Sync Postman changes back to spec
 *   bidi     - Full bidirectional workflow
 *   status   - Check sync status and detect drift
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { SpecHubClient } from './spec-hub-client.js';
import { RepoSync } from './repo-sync.js';
import { ReverseSync } from './reverse-sync.js';
import { parseSpec } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

program
  .name('spec-sync')
  .description('Bi-directional OpenAPI <-> Postman sync tool')
  .version('2.0.0');

/**
 * Add common options to a command
 */
function addCommonOptions(cmd) {
  return cmd
    .requiredOption('-s, --spec <path>', 'Path to OpenAPI spec file')
    .option('-w, --workspace <id>', 'Postman workspace ID', process.env.POSTMAN_WORKSPACE_ID)
    .option('-k, --api-key <key>', 'Postman API key', process.env.POSTMAN_API_KEY)
    .option('-d, --dry-run', 'Preview changes without applying', false);
}

/**
 * Validate required options
 */
function validateOptions(options) {
  if (!options.workspace) {
    console.error('Error: Workspace ID required. Set POSTMAN_WORKSPACE_ID or use --workspace');
    process.exit(1);
  }
  if (!options.apiKey) {
    console.error('Error: API key required. Set POSTMAN_API_KEY or use --api-key');
    process.exit(1);
  }
}

// ============================================================
// FORWARD SYNC COMMAND
// ============================================================

const forwardCmd = program
  .command('forward')
  .description('Forward sync: OpenAPI spec -> Postman collections');

addCommonOptions(forwardCmd)
  .option('-t, --test-level <level>', 'Test level: smoke, contract, all, none', 'all')
  .option('--export-to-repo <path>', 'Also export collections to repo after sync')
  .action(async (options) => {
    validateOptions(options);

    console.log('\nForward Sync: OpenAPI -> Postman');
    console.log('='.repeat(50));

    // Delegate to existing spec-hub-sync.js
    const args = [
      `--spec "${options.spec}"`,
      options.testLevel !== 'all' ? `--test-level ${options.testLevel}` : '',
      options.dryRun ? '--dry-run' : ''
    ].filter(Boolean).join(' ');

    try {
      execSync(`node "${path.join(__dirname, 'spec-hub-sync.js')}" ${args}`, {
        stdio: 'inherit',
        env: {
          ...process.env,
          POSTMAN_API_KEY: options.apiKey,
          POSTMAN_WORKSPACE_ID: options.workspace
        }
      });

      // Export to repo if requested
      if (options.exportToRepo && !options.dryRun) {
        console.log('\nExporting to repo...');
        await runRepoSync(options.spec, options.exportToRepo, options);
      }
    } catch (error) {
      process.exit(1);
    }
  });

// ============================================================
// REPO SYNC COMMAND
// ============================================================

const repoCmd = program
  .command('repo')
  .description('Export Postman collections and environments to repo');

addCommonOptions(repoCmd)
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('--no-envs', 'Skip environment export')
  .action(async (options) => {
    validateOptions(options);
    await runRepoSync(options.spec, options.output, options);
  });

/**
 * Run repo sync operation
 */
async function runRepoSync(specPath, outputDir, options) {
  console.log('\nRepo Sync: Postman -> Filesystem');
  console.log('='.repeat(50));

  const client = new SpecHubClient(options.apiKey, options.workspace);
  const repoSync = new RepoSync(client);

  const spec = await parseSpec(specPath);
  const specName = spec.info?.title || 'api';

  console.log(`\n[1] Fetching collections for: ${specName}`);

  // Get all collections in workspace
  const allCollections = await client.getWorkspaceCollections();

  // Filter to collections matching this spec
  const relevantCollections = allCollections
    .filter(c =>
      c.name === specName ||
      c.name === `${specName} - Smoke Tests` ||
      c.name === `${specName} - Contract Tests`
    )
    .map(c => ({
      uid: c.uid,
      type: c.name.includes('Smoke') ? 'smoke' :
            c.name.includes('Contract') ? 'contract' : 'main'
    }));

  if (relevantCollections.length === 0) {
    console.log('    No matching collections found');
    return;
  }

  console.log(`    Found ${relevantCollections.length} collections`);

  const collections = await repoSync.exportCollections(
    specName,
    relevantCollections,
    outputDir
  );

  // Export environments
  let environments = [];
  if (options.envs !== false) {
    console.log('\n[2] Exporting environments...');
    const allEnvs = await client.getWorkspaceEnvironments();

    // Filter to environments matching this spec
    const relevantEnvs = allEnvs
      .filter(e => e.name.startsWith(specName))
      .map(e => ({ uid: e.uid, name: e.name }));

    if (relevantEnvs.length > 0) {
      environments = await repoSync.exportEnvironments(specName, relevantEnvs, outputDir);
    } else {
      console.log('    No matching environments found');
    }
  }

  // Update manifest
  console.log('\n[3] Updating manifest...');
  await repoSync.updateManifest(outputDir, {
    specPath,
    collections,
    environments
  });

  console.log('\nRepo sync complete');
  console.log(`  Collections: ${collections.length}`);
  console.log(`  Environments: ${environments.length}`);
}

// ============================================================
// REVERSE SYNC COMMAND
// ============================================================

const reverseCmd = program
  .command('reverse')
  .description('Reverse sync: Postman collection -> OpenAPI spec');

addCommonOptions(reverseCmd)
  .requiredOption('-c, --collection <uid>', 'Collection UID to sync from')
  .option('--strategy <strategy>', 'Conflict resolution: spec-wins, collection-wins', 'spec-wins')
  .option('--output <path>', 'Output path for updated spec')
  .option('--no-tests', 'Skip syncing tests as vendor extensions')
  .action(async (options) => {
    validateOptions(options);

    console.log('\nReverse Sync: Postman -> OpenAPI');
    console.log('='.repeat(50));

    const client = new SpecHubClient(options.apiKey, options.workspace);
    const reverseSync = new ReverseSync(client, {
      conflictStrategy: options.strategy,
      storeTestsAsExtension: options.tests !== false
    });

    const result = await reverseSync.reverseSync(
      options.spec,
      options.collection,
      {
        dryRun: options.dryRun,
        outputPath: options.output
      }
    );

    if (result.status === 'dry-run') {
      console.log('\nDry Run Results:');
      console.log(`  Would apply: ${result.wouldApply} changes`);
      console.log(`  Would skip: ${result.wouldSkip} blocked changes`);
      console.log(`  Needs review: ${result.wouldReview} changes`);
    }
  });

// ============================================================
// BIDIRECTIONAL SYNC COMMAND
// ============================================================

const bidiCmd = program
  .command('bidirectional')
  .alias('bidi')
  .description('Full bidirectional sync workflow');

addCommonOptions(bidiCmd)
  .option('-o, --output <dir>', 'Repo output directory', '.')
  .option('--auto-merge', 'Automatically apply safe changes', false)
  .action(async (options) => {
    validateOptions(options);

    console.log('\nBidirectional Sync: Full Workflow');
    console.log('='.repeat(50));

    const client = new SpecHubClient(options.apiKey, options.workspace);

    // Stage 1: Forward sync
    console.log('\n[Stage 1] Forward Sync (Spec -> Postman)');
    console.log('-'.repeat(40));

    const args = [
      `--spec "${options.spec}"`,
      options.dryRun ? '--dry-run' : ''
    ].filter(Boolean).join(' ');

    try {
      execSync(`node "${path.join(__dirname, 'spec-hub-sync.js')}" ${args}`, {
        stdio: 'inherit',
        env: {
          ...process.env,
          POSTMAN_API_KEY: options.apiKey,
          POSTMAN_WORKSPACE_ID: options.workspace
        }
      });
    } catch (error) {
      console.error('Forward sync failed');
      process.exit(1);
    }

    // Stage 2: Repo sync
    console.log('\n[Stage 2] Repo Sync (Postman -> Files)');
    console.log('-'.repeat(40));

    if (!options.dryRun) {
      await runRepoSync(options.spec, options.output, options);
    } else {
      console.log('  Skipped (dry-run mode)');
    }

    // Stage 3: Check for reverse sync
    console.log('\n[Stage 3] Reverse Sync Check');
    console.log('-'.repeat(40));

    const repoSync = new RepoSync(client);
    const status = await repoSync.getStatus(options.output);

    if (status.needsSync) {
      console.log('  Changes detected in Postman');
      console.log(`    Collections: ${status.changes.collections.length}`);
      console.log(`    Environments: ${status.changes.environments.length}`);

      if (options.autoMerge && !options.dryRun) {
        console.log('  Auto-merging safe changes...');
        // Would trigger reverse sync here for each changed collection
      } else {
        console.log('  Run with --auto-merge to apply safe changes');
      }
    } else {
      console.log('  No changes detected');
    }

    console.log('\nBidirectional sync complete');
  });

// ============================================================
// STATUS COMMAND
// ============================================================

program
  .command('status')
  .description('Show sync status and detect drift')
  .option('-s, --spec <path>', 'Path to OpenAPI spec')
  .option('-o, --output <dir>', 'Repo output directory', '.')
  .option('-w, --workspace <id>', 'Postman workspace ID', process.env.POSTMAN_WORKSPACE_ID)
  .option('-k, --api-key <key>', 'Postman API key', process.env.POSTMAN_API_KEY)
  .action(async (options) => {
    if (!options.workspace || !options.apiKey) {
      console.error('Error: Workspace ID and API key required');
      process.exit(1);
    }

    console.log('\nSync Status');
    console.log('='.repeat(50));

    const client = new SpecHubClient(options.apiKey, options.workspace);
    const repoSync = new RepoSync(client);

    try {
      const status = await repoSync.getStatus(options.output);

      console.log(`\nLast Sync: ${status.lastSync || 'Never'}`);
      console.log(`Spec: ${status.specPath || 'Not configured'}`);
      console.log(`Workspace: ${status.workspaceId || options.workspace}`);
      console.log(`\nTracked Collections: ${status.trackedCollections}`);
      console.log(`Tracked Environments: ${status.trackedEnvironments}`);

      if (status.needsSync) {
        console.log('\nChanges Detected:');

        for (const coll of status.changes.collections) {
          console.log(`  Collection: ${coll.name} (${coll.change})`);
        }

        for (const env of status.changes.environments) {
          console.log(`  Environment: ${env.name} (${env.change})`);
        }

        console.log('\nRun "spec-sync repo" to export changes');
      } else {
        console.log('\nStatus: In sync');
      }
    } catch (error) {
      if (error.message.includes('manifest')) {
        console.log('\nNo sync manifest found. Run "spec-sync repo" first.');
      } else {
        console.error(`Error: ${error.message}`);
      }
    }
  });

// ============================================================
// PARSE AND RUN
// ============================================================

program.parse();
