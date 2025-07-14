// @ts-check

//#region Imports

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

//#endregion

export default tseslint.config(
    {
        rules: {
            semi: ['error', 'always'] // Semicolons (;) are required.
        }
    },
    eslint.configs.recommended, // Recommended ESLint core rules.
    tseslint.configs.recommended // Recommended TypeScript rules.
);
