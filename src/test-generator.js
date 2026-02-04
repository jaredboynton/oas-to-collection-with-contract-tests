#!/usr/bin/env node

/**
 * Test Generator
 * 
 * Generates Postman test scripts from OpenAPI spec metadata.
 * Supports two test levels:
 * - smoke: Basic health checks (status code, response time)
 * - contract: Comprehensive validation (schemas, fields, content-types)
 * 
 * These tests are injected into Spec Hub-generated collections.
 */

import { extractEndpoints, getResponseSchema, getRequiredFields } from './parser.js';

/**
 * Test level enumeration
 */
export const TestLevel = {
  SMOKE: 'smoke',
  CONTRACT: 'contract'
};

/**
 * Generate test scripts for all endpoints in a spec
 * @param {Object} api - Parsed OpenAPI spec
 * @param {string} level - Test level ('smoke' or 'contract')
 * @returns {Object} Map of endpoint names to test scripts
 */
export function generateTestScriptsForSpec(api, level = TestLevel.CONTRACT) {
  const endpoints = extractEndpoints(api);
  const testScripts = {};

  for (const endpoint of endpoints) {
    const testName = endpoint.name || `${endpoint.method} ${endpoint.path}`;
    testScripts[testName] = generateTestScript(endpoint, level);
  }

  // Add default test script for any unmatched endpoints
  testScripts['default'] = level === TestLevel.SMOKE 
    ? generateDefaultSmokeTestScript() 
    : generateDefaultContractTestScript();

  return testScripts;
}

/**
 * Generate test script for a single endpoint
 * @param {Object} endpoint - Endpoint object from parser
 * @param {string} level - Test level ('smoke' or 'contract')
 * @returns {Array} Test script lines
 */
function generateTestScript(endpoint, level) {
  if (level === TestLevel.SMOKE) {
    return generateSmokeTestScript(endpoint);
  } else {
    return generateContractTestScript(endpoint);
  }
}

/**
 * Generate SMOKE test script - Basic health checks only
 * @param {Object} endpoint - Endpoint object from parser
 * @returns {Array} Test script lines
 */
function generateSmokeTestScript(endpoint) {
  const tests = [];

  // Header comment
  tests.push(`// Smoke tests for: ${endpoint.method} ${endpoint.path}`);
  tests.push(`// Basic health checks - generated from OpenAPI spec`);
  tests.push('');

  // 1. Status code validation - only check it's a success code
  const statusCodes = Object.keys(endpoint.responses);
  const successCodes = statusCodes.filter(code => code.startsWith('2'));
  if (successCodes.length > 0) {
    tests.push(`// Status code validation`);
    tests.push(`pm.test("Status code is success", function () {`);
    tests.push(`    pm.expect(pm.response.code).to.be.oneOf([${successCodes.join(', ')}]);`);
    tests.push(`});`);
    tests.push('');
  }

  // 2. Response time check only
  tests.push(`// Performance check`);
  tests.push(`pm.test("Response time is acceptable", function () {`);
  tests.push(`    const threshold = parseInt(pm.environment.get("RESPONSE_TIME_THRESHOLD") || "2000");`);
  tests.push(`    pm.expect(pm.response.responseTime).to.be.below(threshold);`);
  tests.push(`});`);
  tests.push('');

  // 3. Basic response body check (not empty for success codes)
  tests.push(`// Response body exists`);
  tests.push(`pm.test("Response body is not empty", function () {`);
  tests.push(`    if (pm.response.code >= 200 && pm.response.code < 300) {`);
  tests.push(`        const contentType = pm.response.headers.get("Content-Type");`);
  tests.push(`        if (contentType && contentType.includes("application/json")) {`);
  tests.push(`            const jsonData = pm.response.json();`);
  tests.push(`            pm.expect(jsonData).to.not.be.undefined;`);
  tests.push(`        }`);
  tests.push(`    }`);
  tests.push(`});`);

  return tests;
}

/**
 * Generate CONTRACT test script - Comprehensive validation
 * @param {Object} endpoint - Endpoint object from parser
 * @returns {Array} Test script lines
 */
function generateContractTestScript(endpoint) {
  const tests = [];

  // Header comment
  tests.push(`// Contract tests for: ${endpoint.method} ${endpoint.path}`);
  tests.push(`// Comprehensive validation - generated from OpenAPI spec`);
  tests.push('');

  // 1. Status code validation
  const statusCodes = Object.keys(endpoint.responses);
  const successCodes = statusCodes.filter(code => code.startsWith('2'));
  if (successCodes.length > 0) {
    const expectedCode = successCodes[0];
    tests.push(`// Status code validation`);
    tests.push(`pm.test("Status code is ${expectedCode}", function () {`);
    tests.push(`    pm.response.to.have.status(${expectedCode});`);
    tests.push(`});`);
    tests.push('');
  }

  // 2. Response time check
  tests.push(`// Performance baseline check`);
  tests.push(`pm.test("Response time is acceptable", function () {`);
  tests.push(`    const threshold = parseInt(pm.environment.get("RESPONSE_TIME_THRESHOLD") || "2000");`);
  tests.push(`    pm.expect(pm.response.responseTime).to.be.below(threshold);`);
  tests.push(`});`);
  tests.push('');

  // 3. Content-Type validation
  const successResponse = endpoint.responses['200'] || endpoint.responses['201'];
  if (successResponse?.content) {
    const contentTypes = Object.keys(successResponse.content);
    if (contentTypes.length > 0) {
      const expectedType = contentTypes[0].split(';')[0];
      tests.push(`// Content-Type validation`);
      tests.push(`pm.test("Content-Type is ${expectedType}", function () {`);
      tests.push(`    pm.response.to.have.header("Content-Type");`);
      tests.push(`    const contentType = pm.response.headers.get("Content-Type");`);
      tests.push(`    pm.expect(contentType).to.include("${expectedType}");`);
      tests.push(`});`);
      tests.push('');
    }
  }

  // 4. JSON Schema validation
  const schemaInfo = getResponseSchema(endpoint.responses, '200') ||
                     getResponseSchema(endpoint.responses, '201');
  
  if (schemaInfo?.schema) {
    tests.push(`// JSON Schema validation`);
    tests.push(`pm.test("Response matches schema structure", function () {`);
    tests.push(`    const jsonData = pm.response.json();`);
    tests.push(`    `);
    tests.push(`    // Basic type validation`);
    if (schemaInfo.schema.type === 'object') {
      tests.push(`    pm.expect(jsonData).to.be.an('object');`);
    } else if (schemaInfo.schema.type === 'array') {
      tests.push(`    pm.expect(jsonData).to.be.an('array');`);
    }
    tests.push(`});`);
    tests.push('');

    // 5. Required field checks
    const requiredFields = getRequiredFields(schemaInfo.schema);
    if (requiredFields.length > 0) {
      tests.push(`// Required field validation`);
      tests.push(`pm.test("Response has required fields", function () {`);
      tests.push(`    const jsonData = pm.response.json();`);
      tests.push(`    const dataToCheck = Array.isArray(jsonData) ? (jsonData[0] || {}) : jsonData;`);
      tests.push(`    `);
      for (const field of requiredFields) {
        tests.push(`    pm.expect(dataToCheck).to.have.property('${field}');`);
      }
      tests.push(`});`);
      tests.push('');
    }

    // 6. Advanced schema validations (enum, format, patterns, constraints)
    const advancedValidations = generateAdvancedSchemaValidations(schemaInfo.schema);
    if (advancedValidations.length > 0) {
      tests.push(`// Advanced schema validations (enum, format, constraints)`);
      tests.push(`pm.test("Field values match schema constraints", function () {`);
      tests.push(`    const jsonData = pm.response.json();`);
      tests.push(`    const dataToCheck = Array.isArray(jsonData) ? (jsonData[0] || {}) : jsonData;`);
      tests.push(`    `);
      for (const validation of advancedValidations) {
        tests.push(`    ${validation}`);
      }
      tests.push(`});`);
      tests.push('');
    }
  }

  // 6. Error response structure validation
  const errorCodes = statusCodes.filter(code => code.startsWith('4') || code.startsWith('5'));
  if (errorCodes.length > 0) {
    tests.push(`// Error response structure validation`);
    tests.push(`pm.test("Error responses have proper structure", function () {`);
    tests.push(`    if (pm.response.code >= 400) {`);
    tests.push(`        const jsonData = pm.response.json();`);
    tests.push(`        const hasErrorField = jsonData.hasOwnProperty('error') || jsonData.hasOwnProperty('message') || jsonData.hasOwnProperty('detail');`);
    tests.push(`        pm.expect(hasErrorField).to.be.true;`);
    tests.push(`    }`);
    tests.push(`});`);
    tests.push('');
  }

  return tests;
}

/**
 * Generate advanced schema validation assertions
 * Validates: enum, format, pattern, numeric constraints, string constraints
 * @param {Object} schema - JSON Schema object
 * @param {string} path - Current property path (for nested objects)
 * @returns {Array} Array of assertion strings
 */
function generateAdvancedSchemaValidations(schema, path = 'dataToCheck') {
  const validations = [];
  
  if (!schema || typeof schema !== 'object') {
    return validations;
  }

  // Handle array items
  if (schema.type === 'array' && schema.items) {
    validations.push(...generateAdvancedSchemaValidations(schema.items, `${path}[0]`));
    
    // Array constraints
    if (schema.minItems !== undefined) {
      validations.push(`pm.expect(${path}).to.have.length.of.at.least(${schema.minItems});`);
    }
    if (schema.maxItems !== undefined) {
      validations.push(`pm.expect(${path}).to.have.length.of.at.most(${schema.maxItems});`);
    }
    if (schema.uniqueItems) {
      validations.push(`// Note: uniqueItems validation requires deep comparison`);
    }
    return validations;
  }

  // Handle object properties
  if (schema.type === 'object' && schema.properties) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      const propPath = `${path}['${propName}']`;
      
      // Only validate if property exists (required check is separate)
      validations.push(`if (${propPath} !== undefined) {`);
      
      // Type validation
      if (propSchema.type) {
        const typeMap = {
          'string': 'string',
          'integer': 'number',
          'number': 'number',
          'boolean': 'boolean',
          'array': 'array',
          'object': 'object'
        };
        if (typeMap[propSchema.type]) {
          validations.push(`    pm.expect(${propPath}).to.be.a('${typeMap[propSchema.type]}');`);
        }
      }
      
      // Enum validation
      if (propSchema.enum && propSchema.enum.length > 0) {
        const enumValues = propSchema.enum.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ');
        validations.push(`    pm.expect(${propPath}).to.be.oneOf([${enumValues}]);`);
      }
      
      // Format validation (strings)
      if (propSchema.format && propSchema.type === 'string') {
        const formatPattern = getFormatPattern(propSchema.format);
        if (formatPattern) {
          validations.push(`    pm.expect(${propPath}).to.match(${formatPattern});`);
        }
      }
      
      // Pattern validation (regex)
      if (propSchema.pattern && propSchema.type === 'string') {
        const escapedPattern = propSchema.pattern.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        validations.push(`    pm.expect(${propPath}).to.match(/${escapedPattern}/);`);
      }
      
      // String constraints
      if (propSchema.type === 'string') {
        if (propSchema.minLength !== undefined) {
          validations.push(`    pm.expect(${propPath}).to.have.length.of.at.least(${propSchema.minLength});`);
        }
        if (propSchema.maxLength !== undefined) {
          validations.push(`    pm.expect(${propPath}).to.have.length.of.at.most(${propSchema.maxLength});`);
        }
      }
      
      // Numeric constraints
      if (propSchema.type === 'number' || propSchema.type === 'integer') {
        if (propSchema.minimum !== undefined) {
          const operator = propSchema.exclusiveMinimum ? '>' : '>=';
          validations.push(`    pm.expect(${propPath}).to.be${operator === '>' ? '.above' : '.at.least'}(${propSchema.minimum});`);
        }
        if (propSchema.maximum !== undefined) {
          const operator = propSchema.exclusiveMaximum ? '<' : '<=';
          validations.push(`    pm.expect(${propPath}).to.be${operator === '<' ? '.below' : '.at.most'}(${propSchema.maximum});`);
        }
        if (propSchema.multipleOf !== undefined) {
          validations.push(`    pm.expect(${propPath} % ${propSchema.multipleOf}).to.equal(0);`);
        }
      }
      
      // Nested object/array validation
      if (propSchema.type === 'object' || propSchema.type === 'array') {
        const nested = generateAdvancedSchemaValidations(propSchema, propPath);
        for (const nestedValidation of nested) {
          validations.push(`    ${nestedValidation}`);
        }
      }
      
      validations.push(`}`);
    }
  }
  
  return validations;
}

/**
 * Get regex pattern for common OpenAPI formats
 * @param {string} format - OpenAPI format string
 * @returns {string|null} Regex pattern string for Postman test
 */
function getFormatPattern(format) {
  const patterns = {
    'date': '/^\\d{4}-\\d{2}-\\d{2}$/',
    'date-time': '/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/',
    'email': '/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/',
    'uuid': '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
    'uri': '/^https?:\\/\\/.+/',
    'hostname': '/^[a-zA-Z0-9]([a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?)*$/',
    'ipv4': '/^(\\d{1,3}\\.){3}\\d{1,3}$/',
    'ipv6': '/^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/',
    'byte': '/^[A-Za-z0-9+\\/]*={0,2}$/'
  };
  
  return patterns[format] || null;
}

/**
 * Generate default SMOKE test script for unmatched endpoints
 * @returns {Array} Default smoke test script lines
 */
function generateDefaultSmokeTestScript() {
  return [
    '// Default smoke tests',
    'pm.test("Status code is success", function () {',
    '    pm.expect(pm.response.code).to.be.oneOf([200, 201, 204]);',
    '});',
    '',
    'pm.test("Response time is acceptable", function () {',
    '    const threshold = parseInt(pm.environment.get("RESPONSE_TIME_THRESHOLD") || "2000");',
    '    pm.expect(pm.response.responseTime).to.be.below(threshold);',
    '});'
  ];
}

/**
 * Generate default CONTRACT test script for unmatched endpoints
 * @returns {Array} Default contract test script lines
 */
function generateDefaultContractTestScript() {
  return [
    '// Default contract tests',
    'pm.test("Status code is valid", function () {',
    '    pm.expect(pm.response.code).to.be.oneOf([200, 201, 204]);',
    '});',
    '',
    'pm.test("Response time is acceptable", function () {',
    '    const threshold = parseInt(pm.environment.get("RESPONSE_TIME_THRESHOLD") || "2000");',
    '    pm.expect(pm.response.responseTime).to.be.below(threshold);',
    '});',
    '',
    'pm.test("Response body is valid JSON", function () {',
    '    pm.response.to.be.json;',
    '});'
  ];
}

/**
 * Generate pre-request script for authentication setup
 * @param {Object} endpoint - Endpoint object
 * @returns {Array} Pre-request script lines
 */
export function generatePreRequestScript(endpoint) {
  const scripts = [];

  scripts.push(`// Pre-request script for: ${endpoint.method} ${endpoint.path}`);
  scripts.push('');

  // Set path parameters
  const pathParams = endpoint.path.match(/\{([^}]+)\}/g) || [];
  if (pathParams.length > 0) {
    scripts.push('// Set path parameters if not defined');
    for (const param of pathParams) {
      const paramName = param.replace(/[{}]/g, '');
      scripts.push(`if (!pm.variables.get("${paramName}")) {`);
      scripts.push(`    pm.variables.set("${paramName}", "test-${paramName}-001");`);
      scripts.push(`}`);
    }
    scripts.push('');
  }

  // Auth setup
  if (endpoint.security?.length > 0) {
    scripts.push('// Authentication setup');
    scripts.push('// Set auth token via environment: pm.environment.set("auth_token", "your-token")');
    scripts.push('');
  }

  return scripts;
}

export default {
  TestLevel,
  generateTestScriptsForSpec,
  generatePreRequestScript
};
