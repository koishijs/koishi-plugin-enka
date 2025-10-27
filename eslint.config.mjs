import makeConfig from '@hydrooj/eslint-config';

const config = makeConfig({
    ignores: [
        '**/dist',
        '**/*.d.ts',
        '**/node_modules',
        '**/.*.js',
    ],
    stylistic: {
        indent: 4,
    },
    jsonc: false,
    vue: false,
    rules: {
        'yaml/indent': ['warn', 2],
        'ts/no-shadow': 'off',
    },
}, {
    languageOptions: {
        ecmaVersion: 5,
        sourceType: 'module',
    },
});
export default config;
