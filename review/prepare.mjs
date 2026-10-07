import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse, stringify } from '../runtime/takt/node_modules/yaml/dist/index.js';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const taktRoot = join(repository, 'runtime/takt/node_modules/takt');
const integrity = 'sha512-92yoikSQ6kyj/PYMrefONIOKkNW9CdiJrAl2REPdsmdKp3M3XUMZnxDOjCtf1mAnOMadJpVGlGa5sYuaI1hjcw==';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// 独立したconfigを新規作成する。原本/global/project設定への書き込みはしない。
export async function prepareReview({ output, input = join(repository, 'examples/takt') }) {
  const configDir = resolve(output);
  const pkg = JSON.parse(readFileSync(join(taktRoot, 'package.json')));
  const lock = JSON.parse(readFileSync(join(repository, 'runtime/takt/package-lock.json'))).packages['node_modules/takt'];
  if (pkg.version !== '0.68.0' || lock.version !== pkg.version || lock.integrity !== integrity) throw Error('TAKT pin mismatch');
  const { GlobalConfigSchema } = await import('../runtime/takt/node_modules/takt/dist/core/models/config-schemas.js');
  const { RuntimeProviderFileSchema } = await import('../runtime/takt/node_modules/takt/dist/infra/config/runtime-provider/schema.js');
  const configBytes = readFileSync(join(input, 'config.yaml'));
  const runtimeBytes = readFileSync(join(input, 'runtime.yaml'));
  const config = parse(configBytes.toString());
  GlobalConfigSchema.parse(config);
  if (Object.keys(config).some(key => !['language', 'branch_name_strategy', 'auto_pr', 'concurrency', 'observability', 'assistant'].includes(key))) {
    throw Error('Unsupported global override: use a dedicated review config');
  }
  if (config.language !== 'ja') throw Error('Review resources currently require language: ja');
  RuntimeProviderFileSchema.parse(parse(runtimeBytes.toString()));
  // mkdirのexclusiveな失敗で既存runの上書きを防ぐ。
  mkdirSync(configDir, { mode: 0o700 });
  mkdirSync(join(configDir, 'workflows'));
  mkdirSync(join(configDir, 'facets'));
  writeFileSync(join(configDir, 'config.yaml'), stringify({ ...config, auto_pr: false }), { mode: 0o600 });
  writeFileSync(join(configDir, 'runtime.yaml'), runtimeBytes, { mode: 0o600 });
  const sources = {};
  const builtin = name => {
    const bytes = readFileSync(join(taktRoot, 'builtins/ja/workflows', `${name}.yaml`));
    sources[name] = sha(bytes);
    return parse(bytes.toString());
  };
  const facets = {};
  for (const kind of ['persona', 'instruction', 'report']) {
    const source = join(repository, 'review/facets', `${kind}.md`);
    const directory = { persona: 'personas', instruction: 'instructions', report: 'output-contracts' }[kind];
    mkdirSync(join(configDir, 'facets', directory));
    const destination = join(configDir, 'facets', directory, 'private-agent-quality.md');
    copyFileSync(source, destination);
    facets[kind] = 'private-agent-quality';
    sources[kind] = sha(readFileSync(source));
  }
  const quality = {
    name: 'quality-review',
    capabilities: 'readonly', tags: ['review'], edit: false,
    persona: facets.persona, instruction: facets.instruction,
    policy: ['review', 'contract-change'],
    knowledge: ['architecture', 'security', 'security-data', 'security-dependencies', 'implementation-semantics'],
    pass_previous_response: false,
    output_contracts: { report: [{ name: 'quality-review.md', format: facets.report }] },
    rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
  };
  const workflows = {};
  for (const route of ['external', 'takt']) {
    const suite = builtin('development-review');
    suite.name = `private-agent-review-${route}`;
    const step = suite.steps[0];
    if (route === 'external') {
      step.parallel.fixed.push(quality);
      step.rules.parallel['quality-review'] = quality.rules;
    } else {
      delete step.uses;
      step.tags = ['review'];
      step.parallel = [quality];
      step.rules = step.rules.self;
    }
    const workflow = builtin('review-fix');
    workflow.name = `private-agent-review-fix-${route}`;
    workflow.steps.find(s => s.name === 'reviewers').args.reviewer_suite = suite.name;
    for (const document of [suite, workflow]) {
      writeFileSync(join(configDir, 'workflows', `${document.name}.yaml`), stringify(document));
    }
    workflows[route] = workflow.name;
  }
  writeFileSync(join(configDir, 'manifest.json'), JSON.stringify({
    taktVersion: pkg.version, integrity, workflows, sources,
    input: { config: sha(configBytes), runtime: sha(runtimeBytes) }, overrides: { auto_pr: false },
  }, null, 2));
  return { configDir, workflows };
}
