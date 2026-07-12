import { describe, expect, it } from 'vitest';
import { defineProject } from '../src/dsl/index.js';

describe('defineProject', () => {
  it('is valid with only components and no rules callback (zero-DSL day-one value, ADR 002/009)', () => {
    const ir = defineProject({ components: { api: 'application/api/**' } });
    expect(ir.irVersion).toBe('1');
    expect(ir.rules).toEqual([]);
    expect(ir.components['api']).toEqual({
      name: 'api',
      selector: { kind: 'glob', patterns: ['application/api/**'] },
      allowEmpty: false,
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
});
