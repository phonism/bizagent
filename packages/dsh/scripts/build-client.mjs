import { build } from 'esbuild'

const moduleId = '@bizagent/dsh'

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  // DSH's browser runtime does not import plugin bundles as native ESM.
  // Loading a bundle must only register a lazy CommonJS factory; the module
  // body is materialized later, after its declared dependencies are ready.
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: false,
  banner: {
    js: `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(moduleId)},\n  factory: (require) => {\n    const module = { exports: {} };\n    const exports = module.exports;`,
  },
  footer: {
    js: '    return module.exports\n  },\n});',
  },
  // Modules the DSH web frontend shares with every plugin bundle.
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  logLevel: 'info',
})
