import type { LanguagePlugin } from '@spikedpunch/align-core';
import { TypeScriptScanner } from './scanner.js';

export class TypeScriptPlugin implements LanguagePlugin {
  readonly id = 'typescript';
  readonly fileMatch = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
  readonly scanner = new TypeScriptScanner();
}
