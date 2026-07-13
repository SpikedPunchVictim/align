import type { FixProposal, RepoRelativePath } from '@spikedpunch/align-core';
import type { FixProvider, FixProviderInput } from '../src/fixProvider.js';

export type ScriptedResponse = FixProposal | ((input: FixProviderInput) => FixProposal);

/**
 * Deterministic, no-network `FixProvider` for tests — scripted by file: each call for a given
 * file pops the next response off that file's queue (so REPAIR retries can be scripted to fix
 * progressively, or to oscillate, or to fail validation).
 */
export class FakeFixProvider implements FixProvider {
  private readonly queues = new Map<RepoRelativePath, ScriptedResponse[]>();
  public readonly calls: FixProviderInput[] = [];

  script(file: RepoRelativePath, responses: readonly ScriptedResponse[]): void {
    this.queues.set(file, [...responses]);
  }

  async proposeFix(input: FixProviderInput): Promise<FixProposal> {
    this.calls.push(input);
    const file = [...input.fileContents.keys()][0];
    if (file === undefined) throw new Error('FakeFixProvider: input has no files');
    const queue = this.queues.get(file);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`FakeFixProvider: no scripted response left for ${file}`);
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error(`FakeFixProvider: no scripted response left for ${file}`);
    return typeof next === 'function' ? next(input) : next;
  }
}
