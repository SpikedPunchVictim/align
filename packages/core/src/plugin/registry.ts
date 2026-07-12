import type { RepoRelativePath } from '../types/branded.js';
import type { Scanner } from '../scanner.js';
import { globMatch } from '../components/glob.js';

export interface LanguagePlugin {
  readonly id: string; // 'typescript' in v1
  readonly fileMatch: readonly string[]; // glob patterns claiming files
  readonly scanner: Scanner;
}

export interface PluginRegistry {
  getPluginForFile(file: RepoRelativePath): LanguagePlugin | undefined;
  getAllPlugins(): readonly LanguagePlugin[];
}

/**
 * v1's registry implementation is a one-element static list — no cross-plugin file-match
 * conflict resolution, no priority ordering, no merged-graph logic across plugins. Those are
 * real problems only a second `LanguagePlugin` creates; the interface is written generically so
 * adding one is additive at the CLI composition root, not an interface rewrite.
 */
export class StaticPluginRegistry implements PluginRegistry {
  constructor(private readonly plugins: readonly LanguagePlugin[]) {}

  getPluginForFile(file: RepoRelativePath): LanguagePlugin | undefined {
    for (const plugin of this.plugins) {
      if (plugin.fileMatch.some((pattern) => globMatch(pattern, file))) return plugin;
    }
    return undefined;
  }

  getAllPlugins(): readonly LanguagePlugin[] {
    return this.plugins;
  }
}
