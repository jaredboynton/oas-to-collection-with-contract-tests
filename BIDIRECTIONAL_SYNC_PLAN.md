# Bi-Directional Sync Plan: Postman ↔ Git Repository

## Overview

This document outlines a bi-directional synchronization system between Postman Spec Hub and a Git repository, enabling teams to work in both environments while maintaining consistency.

---

## Current Architecture (One-Way)

```
Git Repo (OpenAPI Spec)
    │
    ▼ (sync to Postman)
Postman Spec Hub
    │
    ├──▶ Main Collection (docs)
    ├──▶ Smoke Tests Collection
    ├──▶ Contract Tests Collection
    └──▶ Environments (per server)
```

## Target Architecture (Bi-Directional)

```
                    ┌─────────────────────────────────────┐
                    │         Git Repository              │
                    │  ┌─────────────┐  ┌──────────────┐ │
                    │  │ openapi.yaml│  │ postman/     │ │
                    │  │ (source)    │  │ ├── collections│
                    │  └─────────────┘  │ ├── environments│
                    │                   │ └── versions/  │ │
                    └─────────┬─────────┘ └──────────────┘ │
                              │                            │
              ┌───────────────┼───────────────┐            │
              │               │               │            │
              ▼               ▼               ▼            │
        ┌──────────┐   ┌──────────┐   ┌──────────┐        │
        │  sync-to │   │ sync-from│   │  export  │        │
        │  postman │   │ postman  │   │  backup  │        │
        └────┬─────┘   └────┬─────┘   └────┬─────┘        │
             │              │              │              │
             ▼              ▼              ▼              │
        ┌─────────────────────────────────────────┐       │
        │         Postman Spec Hub                │       │
        │  ┌─────────┐ ┌─────────┐ ┌──────────┐  │       │
        │  │  Spec   │ │Collections│ │Environments│ │       │
        │  │  (ID)   │ │(3 types) │ │(per server)│ │       │
        │  └─────────┘ └─────────┘ └──────────┘  │       │
        └─────────────────────────────────────────┘       │
                              │                           │
                              │ (fork/PR/merge workflow)  │
                              ▼                           │
                    ┌──────────────────┐                  │
                    │  User Forks      │                  │
                    │  & Modifies      │                  │
                    └──────────────────┘                  │
                              │                           │
                              └───────────────────────────┘
```

---

## Phase 1: Git → Postman Export (Backup to Repo)

### Purpose
Export generated collections and environments back to the repo for version control and disaster recovery.

### File Structure
```
demo/
├── specs/
│   └── sample-api.yaml           # Source OpenAPI spec
├── postman/                      # Generated artifacts (committed)
│   ├── collections/
│   │   ├── task-management-api.json
│   │   ├── task-management-api-smoke-tests.json
│   │   └── task-management-api-contract-tests.json
│   ├── environments/
│   │   ├── task-management-api-production.json
│   │   └── task-management-api-staging.json
│   └── versions/                 # Version history
│       ├── 2024-01-15T10-30-00/
│       │   ├── collections/
│       │   └── environments/
│       └── 2024-01-20T14-22-00/
└── .postman-sync.json            # Sync configuration
```

### New CLI Commands

```bash
# Export all Postman artifacts to repo
npm run sync:export -- --spec specs/sample-api.yaml

# Options:
#   --output, -o    Output directory (default: ./postman)
#   --versioned, -v Keep versioned backups
#   --dry-run, -d   Preview what would be exported
```

### Implementation

```javascript
// src/export-to-repo.js
class PostmanExporter {
  async exportCollections(specName, outputDir) {
    // 1. Find collections by tag (generated)
    // 2. Export each collection as JSON
    // 3. Write to postman/collections/
  }

  async exportEnvironments(specName, outputDir) {
    // 1. Find environments by name pattern
    // 2. Export each environment as JSON
    // 3. Write to postman/environments/
  }
}
```

### API Endpoints Needed
- `GET /collections/{uid}` - Export collection
- `GET /environments/{uid}` - Export environment

---

## Phase 2: Postman → Git Import (Merge Changes)

### Purpose
Extract changes made in Postman (via fork/PR workflow) and merge them back into the OpenAPI spec.

### Workflow

```
User in Postman:
1. Fork collection (creates fork)
2. Make changes (add endpoint, modify schema)
3. Create PR to merge back
4. PR approved and merged

System:
1. Detect merged PR via webhook or polling
2. Export merged collection
3. Diff against original
4. Convert changes to OpenAPI format
5. Update spec file
6. Create PR in Git repo (optional)
```

### New CLI Commands

```bash
# Import changes from Postman to spec
npm run sync:import -- --spec specs/sample-api.yaml --collection-uid <uid>

# Options:
#   --from-fork, -f    Import from a forked collection
#   --from-main, -m    Import from main collection (direct edit)
#   --create-pr        Create a Git PR with changes
#   --dry-run, -d      Preview changes without applying
```

### Implementation

```javascript
// src/import-from-postman.js
class PostmanImporter {
  async importFromCollection(collectionUid, specPath) {
    // 1. Get collection from Postman API
    const collection = await this.getCollection(collectionUid);
    
    // 2. Parse current spec
    const currentSpec = await this.parseSpec(specPath);
    
    // 3. Convert collection to OpenAPI diff
    const changes = this.convertToOpenAPI(collection, currentSpec);
    
    // 4. Apply changes to spec
    const updatedSpec = this.mergeChanges(currentSpec, changes);
    
    // 5. Write updated spec
    await this.writeSpec(specPath, updatedSpec);
    
    return changes;
  }

  convertToOpenAPI(collection, currentSpec) {
    // Convert Postman requests to OpenAPI paths
    // Convert Postman tests to OpenAPI examples
    // Handle query params, headers, auth
  }
}
```

### Conversion Mapping

| Postman Element | OpenAPI Equivalent |
|-----------------|-------------------|
| Request URL | `paths/{path}` |
| HTTP Method | `paths/{path}.{method}` |
| Query Params | `parameters` (in: query) |
| Path Params | `parameters` (in: path) |
| Headers | `parameters` (in: header) |
| Request Body | `requestBody.content` |
| Response Body | `responses.{code}.content` |
| Response Tests | `responses.{code}.examples` |
| Auth | `securitySchemes` |

---

## Phase 3: Conflict Resolution

### Conflict Detection

```javascript
// src/conflict-detector.js
class ConflictDetector {
  async detectConflicts(specPath, collectionUid) {
    const spec = await this.parseSpec(specPath);
    const collection = await this.getCollection(collectionUid);
    
    const conflicts = [];
    
    // Check each endpoint in collection
    for (const item of collection.item) {
      const path = this.convertPostmanPathToOpenAPI(item.request.url.path);
      const method = item.request.method.toLowerCase();
      
      // Does endpoint exist in spec?
      if (!spec.paths[path]?.[method]) {
        conflicts.push({
          type: 'NEW_ENDPOINT',
          path,
          method,
          message: 'New endpoint in Postman not in spec'
        });
        continue;
      }
      
      // Check for parameter conflicts
      const paramConflicts = this.checkParameterConflicts(
        spec.paths[path][method],
        item.request
      );
      conflicts.push(...paramConflicts);
      
      // Check for schema conflicts
      const schemaConflicts = this.checkSchemaConflicts(
        spec.paths[path][method],
        item.request
      );
      conflicts.push(...schemaConflicts);
    }
    
    return conflicts;
  }
}
```

### Conflict Types

| Type | Description | Resolution |
|------|-------------|------------|
| `NEW_ENDPOINT` | Endpoint exists in Postman but not spec | Add to spec |
| `DELETED_ENDPOINT` | Endpoint exists in spec but not Postman | Remove from spec (confirm) |
| `PARAM_TYPE_MISMATCH` | Parameter type changed | Prompt user |
| `SCHEMA_MISMATCH` | Response schema differs | Prompt user |
| `REQUIRED_FIELD_CHANGED` | Required fields differ | Prompt user |
| `AUTH_CHANGED` | Authentication method changed | Prompt user |

### Resolution Strategies

```javascript
// Resolution options per conflict type
const resolutionStrategies = {
  NEW_ENDPOINT: ['accept', 'ignore'],
  DELETED_ENDPOINT: ['remove', 'keep'],
  PARAM_TYPE_MISMATCH: ['use-postman', 'use-spec', 'manual'],
  SCHEMA_MISMATCH: ['use-postman', 'use-spec', 'merge', 'manual']
};
```

---

## Phase 4: Git Workflow Integration

### Pre-Commit Hook

```bash
#!/bin/sh
# .git/hooks/pre-commit

# Check if spec file changed
if git diff --cached --name-only | grep -q "specs/.*\.yaml"; then
  echo "Spec file changed - validating..."
  
  # Validate spec
  npm run validate:spec -- specs/sample-api.yaml
  
  # Export current Postman state (backup)
  npm run sync:export -- --spec specs/sample-api.yaml --dry-run
fi
```

### CI/CD Integration

```yaml
# .github/workflows/bidirectional-sync.yml
name: Bi-Directional Sync

on:
  push:
    paths:
      - 'specs/**'
  repository_dispatch:  # Triggered by Postman webhook
    types: [postman-pr-merged]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      # Git → Postman (existing workflow)
      - name: Sync to Postman
        if: github.event_name == 'push'
        run: npm run sync:spec-hub -- --spec specs/api.yaml
      
      # Postman → Git (import changes)
      - name: Import from Postman
        if: github.event_name == 'repository_dispatch'
        run: |
          npm run sync:import \
            -- --spec specs/api.yaml \
            --collection-uid ${{ github.event.client_payload.collection_uid }} \
            --create-pr
```

---

## Phase 5: Configuration File

### `.postman-sync.json`

```json
{
  "version": "1.0.0",
  "spec": {
    "path": "specs/sample-api.yaml",
    "format": "openapi3"
  },
  "sync": {
    "toPostman": {
      "enabled": true,
      "collections": {
        "generateMain": true,
        "generateSmoke": true,
        "generateContract": true
      },
      "environments": {
        "generatePerServer": true
      }
    },
    "fromPostman": {
      "enabled": true,
      "autoMerge": false,
      "requireApproval": true,
      "conflictResolution": "prompt"
    },
    "export": {
      "enabled": true,
      "directory": "./postman",
      "versioning": true,
      "retainVersions": 10
    }
  },
  "mappings": {
    "collectionNaming": "{specName} - {type}",
    "environmentNaming": "{specName} - {serverDescription}"
  }
}
```

---

## Phase 6: Implementation Roadmap

### Sprint 1: Export to Repo (Git → Postman Backup)
- [ ] Create `PostmanExporter` class
- [ ] Implement collection export
- [ ] Implement environment export
- [ ] Add `sync:export` CLI command
- [ ] Add versioned backup support
- [ ] Tests

### Sprint 2: Import from Postman (Postman → Git)
- [ ] Create `PostmanImporter` class
- [ ] Implement collection → OpenAPI conversion
- [ ] Handle basic endpoint mapping
- [ ] Add `sync:import` CLI command
- [ ] Tests

### Sprint 3: Conflict Resolution
- [ ] Create `ConflictDetector` class
- [ ] Implement diff algorithm
- [ ] Add interactive conflict resolution
- [ ] Add dry-run mode
- [ ] Tests

### Sprint 4: Automation & Integration
- [ ] Git hooks integration
- [ ] CI/CD workflow templates
- [ ] Postman webhook handler
- [ ] Configuration file support
- [ ] Documentation

---

## Edge Cases & Solutions

| Edge Case | Solution |
|-----------|----------|
| Collection deleted in Postman | Detect on export, archive in repo, warn user |
| Spec file renamed in repo | Use config file to track mappings |
| Merge conflicts in YAML | Use YAML-aware merge tool, preserve comments |
| Postman changes not representable in OpenAPI | Log warnings, create `postman-extras.json` |
| Circular sync (infinite loop) | Add sync metadata tags, skip if already synced |
| Fork not merged yet | Only import from main collections, not forks |
| Environment variables with secrets | Mask secrets in exported files, use placeholders |

---

## API Requirements

### Postman API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /collections/{uid}` | Export collection |
| `GET /environments/{uid}` | Export environment |
| `GET /collections/{uid}/forks` | List forks |
| `GET /collections/fork/{forkUid}` | Get fork details |
| `GET /webhooks` | Register sync webhook |

### New Internal Modules

```
src/
├── export-to-repo.js          # Export Postman → Git
├── import-from-postman.js     # Import Postman → Git
├── conflict-detector.js       # Detect conflicts
├── openapi-converter.js       # Postman ↔ OpenAPI conversion
├── sync-config.js             # Configuration management
└── webhook-handler.js         # Handle Postman webhooks
```

---

## Success Metrics

1. **Export Coverage**: 100% of generated collections/environments exported
2. **Import Accuracy**: >95% of Postman changes correctly converted to OpenAPI
3. **Conflict Detection**: 100% of conflicts detected before merge
4. **User Adoption**: Team can work in both Postman and Git without friction

---

## Open Questions

1. Should we support two-way sync for test scripts (Postman tests → OpenAPI examples)?
2. How to handle Postman-specific features (pre-request scripts, visualizer)?
3. Should we create a GitHub App for tighter integration?
4. How to handle multiple teams working on different forks simultaneously?
