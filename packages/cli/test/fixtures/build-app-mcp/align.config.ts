import { defineProject } from '@align/core/dsl';
import type { HostPredicate } from '@align/core';

// No architecture rules authored here on purpose — this fixture's rules come entirely from
// `align build` compiling docs/ARCHITECTURE-RULES.md (ADR 011 build-pipeline tests).
export default defineProject({
  components: { api: 'src/api/**', ui: 'src/ui/**' },
});

// Registers 'route-thinness' so `mcp.test.ts`'s custom.host propose_rules tests can exercise both
// sides of grounding against the SAME doc content: a registered name grounds into a real rule, an
// unregistered one is still flagged (docs/proposals/rule-expansion-evaluation.md §B.0). The
// predicate itself is a harmless no-op — this fixture only needs it to exist and be named
// correctly, not to fire.
export const hostRules: Record<string, HostPredicate> = {
  'route-thinness': () => [],
};
