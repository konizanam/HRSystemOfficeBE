// Runs TypeScript entry points that need Nest dependency injection (the seed). Nest reads
// constructor types from decorator metadata, which tsx (esbuild) cannot emit, so .ts files are
// compiled with @swc/core (already used by the test runner) with legacy decorators and metadata.
const { transformSync } = require('@swc/core');
const { readFileSync } = require('node:fs');

require.extensions['.ts'] = function compileTypeScript(module, filename) {
  const { code } = transformSync(readFileSync(filename, 'utf8'), {
    filename,
    sourceMaps: 'inline',
    module: { type: 'commonjs' },
    jsc: {
      target: 'es2022',
      keepClassNames: true,
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  });
  module._compile(code, filename);
};
