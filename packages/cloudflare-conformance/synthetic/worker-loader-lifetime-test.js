// Worker Loader behavior that upstream's worker-loader-test does not reach: what a loaded Worker
// keeps after the event that loaded it ends, module names that nest, and the entrypoint stub's
// shape. Upstream runs each test in one event, so these run a step per event through SELF.
import assert from 'node:assert';
import { WorkerEntrypoint } from 'cloudflare:workers';

export class Greeter extends WorkerEntrypoint {
  greet(name) {
    return `${this.ctx.props.greeting}, ${name}!`;
  }
}

export class Outbound extends WorkerEntrypoint {
  fetch(request) {
    return new Response(`outbound saw ${new URL(request.url).pathname}`);
  }
}

const header = `import { WorkerEntrypoint } from 'cloudflare:workers';`;

// Each case is the code for one Worker, whose default entrypoint's use() reports what it sees.
const cases = {
  globalOutbound: (ctx) => ({
    globalOutbound: ctx.exports.Outbound({ props: {} }),
    use: `return (await fetch('http://outbound.test/x')).text();`,
  }),
  blockedOutbound: () => ({
    globalOutbound: null,
    use: `try { await fetch('http://outbound.test/x'); return 'fetched'; } catch { return 'blocked'; }`,
  }),
  envEntrypoint: (ctx) => ({
    env: { greeter: ctx.exports.Greeter({ props: { greeting: 'Hello' } }) },
    use: `return this.env.greeter.greet('Ada');`,
  }),
  envPlainValues: () => ({
    env: { plain: { list: [1, 2], name: 'ada' } },
    use: `return this.env.plain;`,
  }),
  moduleState: () => ({
    use: `globalThis.calls = (globalThis.calls ?? 0) + 1; return globalThis.calls;`,
  }),
};

function load(env, ctx, name, id) {
  return env.loader.get(id, () => {
    const { use, ...code } = cases[name](ctx);
    return {
      compatibilityDate: '2025-06-01',
      mainModule: 'main.js',
      modules: {
        'main.js': `${header}\nexport default class extends WorkerEntrypoint { async use() { ${use} } }`,
      },
      ...code,
    };
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const name = url.searchParams.get('case');
    try {
      const value = await load(env, ctx, name, url.searchParams.get('id')).getEntrypoint().use();
      return Response.json({ value });
    } catch (error) {
      return Response.json({ error: String(error) });
    }
  },
};

// Runs the case once per event, each in its own event, on the same loaded Worker.
async function inTwoEvents(env, name) {
  const id = `${name}-${crypto.randomUUID()}`;
  const results = [];
  for (let event = 0; event < 2; event++) {
    const response = await env.SELF.fetch(`http://self/?case=${name}&id=${id}`);
    results.push(await response.json());
  }
  return results;
}

export const globalOutboundOutlivesLoadingEvent = {
  async test(ctrl, env) {
    assert.deepStrictEqual(await inTwoEvents(env, 'globalOutbound'), [
      { value: 'outbound saw /x' },
      { value: 'outbound saw /x' },
    ]);
  },
};

export const blockedOutboundStaysBlocked = {
  async test(ctrl, env) {
    assert.deepStrictEqual(await inTwoEvents(env, 'blockedOutbound'), [
      { value: 'blocked' },
      { value: 'blocked' },
    ]);
  },
};

export const envEntrypointOutlivesLoadingEvent = {
  async test(ctrl, env) {
    assert.deepStrictEqual(await inTwoEvents(env, 'envEntrypoint'), [
      { value: 'Hello, Ada!' },
      { value: 'Hello, Ada!' },
    ]);
  },
};

export const envPlainValuesOutliveLoadingEvent = {
  async test(ctrl, env) {
    const plain = { list: [1, 2], name: 'ada' };
    assert.deepStrictEqual(await inTwoEvents(env, 'envPlainValues'), [{ value: plain }, { value: plain }]);
  },
};

export const moduleStateOutlivesLoadingEvent = {
  async test(ctrl, env) {
    assert.deepStrictEqual(await inTwoEvents(env, 'moduleState'), [{ value: 1 }, { value: 2 }]);
  },
};

function loadModules(env, modules) {
  return env.loader.get(`modules-${crypto.randomUUID()}`, () => ({
    compatibilityDate: '2025-06-01',
    mainModule: 'main.js',
    modules,
  }));
}

// Module names are keys, so a module and another named under it load side by side.
export const moduleNamedUnderAnotherModule = {
  async test(ctrl, env) {
    const worker = loadModules(env, {
      'main.js': `${header}
        import { a } from 'apps';
        import { b } from 'apps/host';
        export default class extends WorkerEntrypoint { sum() { return a + b; } }`,
      apps: { js: 'export const a = 1;' },
      'apps/host': { js: 'export const b = 2;' },
    });
    assert.strictEqual(await worker.getEntrypoint().sum(), 3);
  },
};

export const relativeImportFromNestedModule = {
  async test(ctrl, env) {
    const worker = loadModules(env, {
      'main.js': `${header}
        import { value } from './lib/a.js';
        export default class extends WorkerEntrypoint { value() { return value; } }`,
      'lib/a.js': `import { b } from './b.js'; import { c } from '../c.js'; export const value = b + c;`,
      'lib/b.js': `export const b = 'b';`,
      'c.js': `export const c = 'c';`,
    });
    assert.strictEqual(await worker.getEntrypoint().value(), 'bc');
  },
};

export const nestedModulesOfEveryType = {
  async test(ctrl, env) {
    const worker = loadModules(env, {
      'main.js': `${header}
        import text from 'data/x.txt';
        import bytes from 'data/x.bin';
        import json from 'data/x.json';
        import cjs from 'data/x.cjs';
        export default class extends WorkerEntrypoint {
          read() { return { text, bytes: [...new Uint8Array(bytes)], json, cjs }; }
        }`,
      'data/x.txt': { text: 'hi' },
      'data/x.bin': { data: new Uint8Array([1, 2]) },
      'data/x.json': { json: { ok: true } },
      'data/x.cjs': { cjs: 'module.exports = { from: "cjs" };' },
    });
    assert.deepStrictEqual(await worker.getEntrypoint().read(), {
      bytes: [1, 2],
      cjs: { from: 'cjs' },
      json: { ok: true },
      text: 'hi',
    });
  },
};

// An entrypoint stub is an RPC stub: an object that has every method name but `then`.
export const entrypointStubShape = {
  async test(ctrl, env) {
    const stub = loadModules(env, {
      'main.js': `${header}
        export default class extends WorkerEntrypoint { ping() { return 'pong'; } }`,
    }).getEntrypoint();
    assert.strictEqual(typeof stub, 'object');
    assert.ok('ping' in stub);
    assert.ok('anyMethod' in stub);
    assert.strictEqual(await stub.ping(), 'pong');
  },
};

export const namedEntrypointWithProps = {
  async test(ctrl, env) {
    const worker = loadModules(env, {
      'main.js': `${header}
        export default class extends WorkerEntrypoint {}
        export class Named extends WorkerEntrypoint { hello() { return 'named ' + this.ctx.props.who; } }`,
    });
    assert.strictEqual(await worker.getEntrypoint('Named', { props: { who: 'ada' } }).hello(), 'named ada');
  },
};

// Calling a method the entrypoint does not have rejects with a TypeError.
export const missingMethodRejects = {
  async test(ctrl, env) {
    const stub = loadModules(env, {
      'main.js': `${header}\nexport default class extends WorkerEntrypoint {}`,
    }).getEntrypoint();
    await assert.rejects(() => stub.nope(), TypeError);
  },
};
