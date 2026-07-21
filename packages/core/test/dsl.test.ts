import { describe, expect, it } from 'vitest';
import { defineProject } from '../src/dsl/index.js';
import { external } from '../src/dsl/factories.js';

describe('defineProject', () => {
  it('is valid with only components and no rules callback (zero-DSL day-one value, ADR 002/009)', () => {
    const ir = defineProject({ components: { api: 'application/api/**' } });
    expect(ir.irVersion).toBe('1');
    expect(ir.rules).toEqual([]);
    expect(ir.components['api']).toEqual({
      name: 'api',
      selector: { kind: 'glob', patterns: ['application/api/**'] },
      empty: 'fail',
    });
  });

  describe('greenfield mode: component empty policy (ADR 003 amendment)', () => {
    it("a bare string component declaration defaults to empty: 'fail' (unchanged safety)", () => {
      const ir = defineProject({ components: { api: 'application/api/**' } });
      expect(ir.components['api']?.empty).toBe('fail');
    });

    it("allowEmpty: true (deprecated alias) resolves to empty: 'allow' — back-compat for align's own history and external adopters (e.g. kluster's sdd component)", () => {
      const ir = defineProject({ components: { api: { pattern: 'application/api/**', allowEmpty: true } } });
      expect(ir.components['api']?.empty).toBe('allow');
    });

    it("empty: 'allow' is authored directly", () => {
      const ir = defineProject({ components: { api: { pattern: 'application/api/**', empty: 'allow' } } });
      expect(ir.components['api']?.empty).toBe('allow');
    });

    it("empty: 'until-populated' is authored directly (greenfield authoring form)", () => {
      const ir = defineProject({ components: { api: { pattern: 'application/api/**', empty: 'until-populated' } } });
      expect(ir.components['api']?.empty).toBe('until-populated');
    });

    it('empty wins when both empty and the deprecated allowEmpty are authored together', () => {
      const ir = defineProject({
        components: { api: { pattern: 'application/api/**', allowEmpty: true, empty: 'until-populated' } },
      });
      expect(ir.components['api']?.empty).toBe('until-populated');
    });

    it('allowEmpty: false alone still resolves to fail (does not accidentally opt in)', () => {
      const ir = defineProject({ components: { api: { pattern: 'application/api/**', allowEmpty: false } } });
      expect(ir.components['api']?.empty).toBe('fail');
    });
  });

  it('parses a package: selector shorthand', () => {
    const ir = defineProject({ components: { api: 'package:@kluster/api' } });
    expect(ir.components['api']?.selector).toEqual({ kind: 'package', packageNames: ['@kluster/api'] });
  });

  it('canOnlyDependOn compiles to a single-entry arch.layers rule', () => {
    const ir = defineProject({
      components: { api: 'application/api/**', core: 'packages/core/**' },
      rules: (c) => [c.arch.layer(c.api).canOnlyDependOn(c.core)],
    });
    expect(ir.rules).toHaveLength(1);
    expect(ir.rules[0]).toMatchObject({
      kind: 'arch.layers',
      layers: [{ layer: 'api', canDependOn: ['core'] }],
    });
  });

  it('cannotDependOn compiles to one arch.no-dependency rule per forbidden ref', () => {
    const ir = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**', cli: 'packages/cli/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui, c.cli)],
    });
    expect(ir.rules).toHaveLength(2);
    expect(ir.rules.every((r) => r.kind === 'arch.no-dependency')).toBe(true);
  });

  describe('external(...) selectors (ADR 017 Part A)', () => {
    it('cannotDependOn(external(...)) compiles to an arch.no-dependency rule with an external `to`', () => {
      const ir = defineProject({
        components: { core: 'packages/core/**' },
        rules: (c) => [c.arch.layer(c.core).cannotDependOn(external('node:child_process'))],
      });
      expect(ir.rules).toHaveLength(1);
      expect(ir.rules[0]).toMatchObject({
        kind: 'arch.no-dependency',
        from: 'core',
        to: { kind: 'external', pattern: 'node:child_process', includeTypeOnly: false },
      });
    });

    it('external(pattern, { includeTypeOnly: true }) carries includeTypeOnly through to the IR', () => {
      const ir = defineProject({
        components: { core: 'packages/core/**' },
        rules: (c) => [c.arch.layer(c.core).cannotDependOn(external('react', { includeTypeOnly: true }))],
      });
      expect(ir.rules[0]).toMatchObject({ to: { kind: 'external', pattern: 'react', includeTypeOnly: true } });
    });

    it('cannotDependOn mixes components and external selectors, one rule per ref', () => {
      const ir = defineProject({
        components: { core: 'packages/core/**', ui: 'application/ui/**' },
        rules: (c) => [c.arch.layer(c.core).cannotDependOn(c.ui, external('node:*'))],
      });
      expect(ir.rules).toHaveLength(2);
      expect(ir.rules[0]).toMatchObject({ kind: 'arch.no-dependency', to: 'ui' });
      expect(ir.rules[1]).toMatchObject({ kind: 'arch.no-dependency', to: { kind: 'external', pattern: 'node:*' } });
    });

    it('canOnlyDependOn(external(...)) compiles to an arch.layers rule whose canDependOn includes the external selector', () => {
      const ir = defineProject({
        components: { web: 'application/web/**', shared: 'packages/shared/**' },
        rules: (c) => [c.arch.layer(c.web).canOnlyDependOn(c.shared, external('lodash'))],
      });
      expect(ir.rules).toHaveLength(1);
      expect(ir.rules[0]).toMatchObject({
        kind: 'arch.layers',
        layers: [{ layer: 'web', canDependOn: ['shared', { kind: 'external', pattern: 'lodash', includeTypeOnly: false }] }],
      });
    });

    it('canOnlyDependOn(external(...)) alone (no components) expresses a default-deny external allow-list', () => {
      const ir = defineProject({
        components: { web: 'application/web/**' },
        rules: (c) => [c.arch.layer(c.web).canOnlyDependOn(external('lodash'))],
      });
      expect(ir.rules[0]).toMatchObject({
        layers: [{ layer: 'web', canDependOn: [{ kind: 'external', pattern: 'lodash', includeTypeOnly: false }] }],
      });
    });

    it('an external-targeting rule id embeds the pattern and stays distinct from a component-targeting one', () => {
      const ir = defineProject({
        components: { core: 'packages/core/**' },
        rules: (c) => [c.arch.layer(c.core).cannotDependOn(external('node:child_process'))],
      });
      expect(ir.rules[0]?.id).toContain('node:child_process');
    });
  });

  it('isIsolated compiles to bidirectional no-dependency rules against every other component', () => {
    const ir = defineProject({
      components: { core: 'packages/core/**', a: 'packages/a/**', b: 'packages/b/**' },
      rules: (c) => [c.arch.component(c.core).isIsolated()],
    });
    // 2 other components * 2 directions = 4 rules
    expect(ir.rules).toHaveLength(4);
  });

  it('noCycles compiles to an arch.no-cycles rule with includeTypeOnly defaulting to false', () => {
    const ir = defineProject({
      components: { core: 'packages/core/**' },
      rules: (c) => [c.arch.noCycles()],
    });
    expect(ir.rules[0]).toMatchObject({ kind: 'arch.no-cycles', scope: 'repo', includeTypeOnly: false });
  });

  it('maxLinesPerFile compiles to a single arch.metric rule with metric: "loc" (ADR 002 vocabulary promotion)', () => {
    const ir = defineProject({
      components: { api: 'application/api/**' },
      rules: (c) => [c.arch.component(c.api).maxLinesPerFile(800)],
    });
    expect(ir.rules).toHaveLength(1);
    expect(ir.rules[0]).toMatchObject({
      kind: 'arch.metric',
      id: 'arch.metric:loc:api',
      target: 'api',
      metric: 'loc',
      max: 800,
    });
  });

  it('maxLinesPerFile supports .because() like every rule', () => {
    const ir = defineProject({
      components: { api: 'application/api/**' },
      rules: (c) => [c.arch.component(c.api).maxLinesPerFile(800).because('Route/service files should decompose before they become build-worker.ts-shaped.')],
    });
    expect(ir.rules[0]?.provenance.because).toBe(
      'Route/service files should decompose before they become build-worker.ts-shaped.',
    );
  });

  it('.because() hoists into provenance', () => {
    const ir = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui).because('The API must remain headless.')],
    });
    expect(ir.rules[0]?.provenance.because).toBe('The API must remain headless.');
  });

  it('assigns stable, human-readable rule ids and disambiguates real collisions', () => {
    const ir = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [
        c.arch.layer(c.api).cannotDependOn(c.ui),
        c.arch.layer(c.api).cannotDependOn(c.ui), // deliberate duplicate
      ],
    });
    expect(ir.rules[0]?.id).toBe('arch.no-dependency:api->ui');
    expect(ir.rules[1]?.id).toBe('arch.no-dependency:api->ui-2');
  });

  it('golden snapshot: a realistic layered project compiles to a stable IR shape', () => {
    const ir = defineProject({
      components: {
        api: 'application/api/**',
        ui: 'application/ui/**',
        core: 'packages/core/**',
      },
      rules: (c) => [
        c.arch.layer(c.api).canOnlyDependOn(c.core),
        c.arch.component(c.core).isIsolated(),
        c.arch.noCycles(),
      ],
    });
    expect(ir).toMatchSnapshot();
  });

  it('golden snapshot: maxLinesPerFile compiles to a stable arch.metric IR shape', () => {
    const ir = defineProject({
      components: { api: 'application/api/**' },
      rules: (c) => [c.arch.component(c.api).maxLinesPerFile(800).because('Route/service files should decompose before they become build-worker.ts-shaped.')],
    });
    expect(ir).toMatchSnapshot();
  });

  it('custom.host compiles to a portable:false custom.host rule referencing the given hostRuleName (ADR 002 §B.0)', () => {
    const ir = defineProject({
      components: { api: 'application/api/**' },
      rules: (c) => [c.custom.host('route-thinness')],
    });
    expect(ir.rules).toHaveLength(1);
    expect(ir.rules[0]).toMatchObject({
      kind: 'custom.host',
      id: 'custom.host:route-thinness',
      hostRuleName: 'route-thinness',
      portable: false,
    });
  });

  it('custom.host supports .because() like every rule', () => {
    const ir = defineProject({
      components: { api: 'application/api/**' },
      rules: (c) => [c.custom.host('route-thinness').because('Route handlers stay thin.')],
    });
    expect(ir.rules[0]?.provenance.because).toBe('Route handlers stay thin.');
  });

  it('custom.host disambiguates a real id collision, same as every other rule kind', () => {
    const ir = defineProject({
      components: { api: 'application/api/**' },
      rules: (c) => [c.custom.host('route-thinness'), c.custom.host('route-thinness')],
    });
    expect(ir.rules[0]?.id).toBe('custom.host:route-thinness');
    expect(ir.rules[1]?.id).toBe('custom.host:route-thinness-2');
  });

  it('golden snapshot: custom.host compiles to a stable IR shape', () => {
    const ir = defineProject({
      components: { api: 'application/api/**' },
      rules: (c) => [c.custom.host('route-thinness').because('Route handlers stay thin.')],
    });
    expect(ir).toMatchSnapshot();
  });

  describe('c.security.manifest (ADR 013)', () => {
    it('sourceHygiene compiles to a single security.manifest.source-hygiene rule with a stable id', () => {
      const ir = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.security.manifest.sourceHygiene()],
      });
      expect(ir.rules).toHaveLength(1);
      expect(ir.rules[0]).toMatchObject({
        kind: 'security.manifest.source-hygiene',
        id: 'security.manifest.source-hygiene',
      });
    });

    it('newDependencyGate compiles to a single security.manifest.new-dependency rule with a stable id', () => {
      const ir = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.security.manifest.newDependencyGate()],
      });
      expect(ir.rules).toHaveLength(1);
      expect(ir.rules[0]).toMatchObject({
        kind: 'security.manifest.new-dependency',
        id: 'security.manifest.new-dependency',
      });
    });

    it('both verbs support .because() like every rule', () => {
      const ir = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [
          c.security.manifest.sourceHygiene().because('Non-registry deps need human sign-off.'),
          c.security.manifest.newDependencyGate().because('New deps require explicit review.'),
        ],
      });
      expect(ir.rules[0]?.provenance.because).toBe('Non-registry deps need human sign-off.');
      expect(ir.rules[1]?.provenance.because).toBe('New deps require explicit review.');
    });

    it('a component named `security` is a compile-time error (reserved factory name, ADR 002/013) — runtime smoke: the factory is real and does not collide with a component token', () => {
      const ir = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.security.manifest.sourceHygiene()],
      });
      expect(ir.components['api']).toBeDefined();
    });

    it('golden snapshot: security.manifest rules compile to a stable IR shape', () => {
      const ir = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [
          c.security.manifest.sourceHygiene(),
          c.security.manifest.newDependencyGate(),
        ],
      });
      expect(ir).toMatchSnapshot();
    });
  });
});
