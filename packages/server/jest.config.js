module.exports = {
    // Use ts-jest preset for testing TypeScript files with Jest
    preset: 'ts-jest',
    // Set the test environment to Node.js
    testEnvironment: 'node',

    // Define the root directory for tests and modules
    roots: ['<rootDir>/src'],

    // Use ts-jest to transform TypeScript files
    transform: {
        '^.+\\.tsx?$': 'ts-jest'
    },

    // Regular expression to find test files
    testRegex: '.*\\.test\\.tsx?$',

    // File extensions to recognize in module resolution
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

    // uuid v10+ ships ESM-only; redirect to the CJS dist so Jest can require it.
    // typeorm is not resolvable via pnpm symlinks in the test runner; redirect to
    // the shared manual mock so all test files get the same decorator stubs without
    // needing an inline jest.mock() factory.
    moduleNameMapper: {
        '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js',
        '^typeorm$': '<rootDir>/__mocks__/typeorm.ts',
        // @google-cloud/logging-winston and @google-cloud/storage (imported via
        // flowise-components' GCSStorageProvider) pull in google-auth-library, which
        // crashes at require() time under Jest's CJS environment
        // (TypeError: Cannot read properties of undefined (reading 'prototype')).
        // Tests never exercise GCS storage, so stub the whole GCS import surface.
        '^@google-cloud/logging-winston$': '<rootDir>/__mocks__/esm-stub.js',
        '^@google-cloud/storage$': '<rootDir>/__mocks__/esm-stub.js',
        '^multer-cloud-storage$': '<rootDir>/__mocks__/esm-stub.js',
        // Node 24+ removed SlowBuffer (DEP0030); buffer-equal-constant-time@1.0.1
        // patches SlowBuffer.prototype at require() time and crashes on modern Node.
        // It is pulled in transitively (jwa -> jws -> gtoken -> google-auth-library ->
        // @google-cloud/vertexai via llamaindex). No test exercises constant-time
        // buffer comparison (no JWT verify in tests), so stubbing is safe.
        '^buffer-equal-constant-time$': '<rootDir>/__mocks__/esm-stub.js'
    },

    // Include the package's own node_modules so that Jest can resolve
    // symlinked pnpm dependencies when tests live inside src/
    modulePaths: ['<rootDir>/node_modules'],

    // Display individual test results with the test suite hierarchy.
    verbose: true
}
