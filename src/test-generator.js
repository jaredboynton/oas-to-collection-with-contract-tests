#!/usr/bin/env node

/**
 * Contract Test Generator
 * 
 * Generates Postman test scripts from OpenAPI spec metadata.
 * These tests are injected into Spec Hub-generated collections.
 */

import { extractEndpoints, getResponseSchema, getRequiredFields } from './parser.js';

/**
 * Generate test scripts for all endpoints in a spec
 * @param {Object} api - Parsed OpenAPI spec
 * @returns {Object} Map of endpoint names to test scripts
 */
export function generateTestScriptsForSpec(api) {
  const endpoints = extractEndpoints(api);
  const testScripts = {};

  for (const endpoint of endpoints) {
    const testName = endpoint.name || `${endpoint.method} ${endpoint.path}`;
    testScripts[testName] = generateTestScript(endpoint);
  }

  // Add default test script for any unmatched endpoints
  testScripts['default'] = generateDefaultTestScript();

  return testScripts;
}

/**
 * Generate test script for a single endpoint
 * @param {Object} endpoint - Endpoint object from parser
 * @returns {Array} Test script lines
 */
function generateTestScript(endpoint) {
  const tests = [];

  // Header comment
  tests.push(`// Contract tests for: ${endpoint.method} ${endpoint.path}`);
  tests.push(`// Generated from OpenAPI spec`);
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
 * Generate default test script for unmatched endpoints
 * @returns {Array} Default test script lines
 */
function generateDefaultTestScript() {
  return [
    '// Default contract tests',
    'pm.test("Status code is valid", function () {',
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
  generateTestScriptsForSpec,
  generatePreRequestScript
};
