import type { Command } from 'commander';
import { DOCS_TOPICS, findDocsTopic, renderDocsIndex } from '../docs/topics.js';
import { ALIGN_VERSION } from '../telemetry/index.js';

export interface DocsOptions {
  /** The requested topic id, or undefined for the index. */
  readonly topic?: string;
}

/**
 * `align docs [topic]` — version-matched documentation printed from the installed binary. No topic
 * prints a cheap index; a topic prints one section (see `docs/topics.ts`). `program` is threaded in
 * (not imported) so the `commands` topic can render the live CLI inventory without a cycle back to
 * `program.ts`. Returns the process exit code.
 */
export function runDocs(program: Command, options: DocsOptions): number {
  if (options.topic === undefined) {
    console.log(renderDocsIndex(ALIGN_VERSION));
    return 0;
  }

  const topic = findDocsTopic(options.topic);
  if (topic === undefined) {
    const known = DOCS_TOPICS.map((t) => t.id).join(', ');
    console.error(
      `Unknown docs topic '${options.topic}'. Known topics: ${known}. Run \`align docs\` for the index.`,
    );
    return 1;
  }

  console.log(`# align docs: ${topic.id}\n\n${topic.render(program)}`);
  return 0;
}
