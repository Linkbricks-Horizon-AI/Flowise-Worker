module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/nodes', '<rootDir>/src'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest'
    },
    testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    verbose: true,
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    moduleNameMapper: {
        '^../../../src/(.*)$': '<rootDir>/src/$1',
        // @modelcontextprotocol/sdk is ESM-only (type:module, no exports map, no CJS builds).
        // It cannot be require()'d in Jest's CJS environment and crashes the worker.
        // The MCP core tests only exercise pure validation functions that don't
        // use these imports, so stubbing them out is safe.
        // Note: @langchain/core is NOT stubbed here because it ships CJS builds
        // (e.g. tools.cjs) that Jest can require() normally.
        '^@modelcontextprotocol/sdk/(.*)$': '<rootDir>/__mocks__/esm-stub.js',
        // multer-azure-blob-storage transitively pulls in azure-storage -> request@2.88.2 -> uuid/v4.
        // The uuid/v4 sub-path no longer exists in modern uuid versions, breaking module resolution.
        // Tests don't exercise Azure storage, so stubbing it out avoids the chain entirely.
        '^multer-azure-blob-storage$': '<rootDir>/__mocks__/esm-stub.js',
        // @google-cloud/logging-winston and @google-cloud/storage pull in google-auth-library,
        // which crashes at require() time under Jest's CJS environment
        // (TypeError: Cannot read properties of undefined (reading 'prototype') in its gaxios chain).
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
    }
}
