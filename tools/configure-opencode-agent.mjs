// Narrow JSON bridge for the standard-library Python agent picker.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANAGED = [
  '.opencode/opencode.jsonc',
  '.opencode/oh-my-opencode-slim.jsonc',
  '.opencode/oh-my-opencode-slim/project-instructions.md',
  '.opencode/oh-my-opencode-slim/orchestrator_append.md',
  '.opencode/skills/project-workflow/SKILL.md',
];
const HYBRID = '.opencode/hybrid';
const STATE = `${HYBRID}/state.json`;
const JOURNAL = `${HYBRID}/.switch-journal.json`;
const LOCK = `${HYBRID}/.switch.lock`;
const MODULES = ['config.mjs', 'storage.mjs', 'launch.mjs', 'runtime.json'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const owns = (object, key) => Object.hasOwn(object ?? {}, key);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const modelID = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[^\s\x00-\x1f\x7f]+$/.test(value);

class Refusal extends Error {}
function refuse(message) { throw new Refusal(message); }

// Bootstrap only known module paths before storage.localPath is available.
function bootstrapPath(workspace, relative) {
  let path = workspace;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      refuse('Linked or invalid Hybrid input; no changes made.');
    }
  }
  return path;
}

async function load(workspace) {
  const boot = Object.fromEntries(MODULES.map(name => {
    const relative = `${HYBRID}/${name}`;
    return [relative, digest(readFileSync(bootstrapPath(workspace, relative)))];
  }));
  const config = await import(pathToFileURL(join(workspace, HYBRID, 'config.mjs')).href);
  const storage = await import(pathToFileURL(join(workspace, HYBRID, 'storage.mjs')).href);
  const launcher = await import(pathToFileURL(join(workspace, HYBRID, 'launch.mjs')).href);
  config.assertSupportedNode();
  return { workspace, config, storage, launcher, boot, directory: join(workspace, HYBRID) };
}

function textAt(context, relative) {
  const path = context.storage.localPath(context.workspace, relative);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function fingerprints(context, paths) {
  return Object.fromEntries(paths.map(relative => {
    const path = context.storage.localPath(context.workspace, relative);
    return [relative, existsSync(path) ? digest(readFileSync(path)) : null];
  }));
}

function tokenFor(context, fingerprints) {
  return digest(JSON.stringify([context.workspace, fingerprints]));
}

// Never give status/assertOwned an unvetted state: they read EVERY owned path.
function guardedState(context, locked = false) {
  const { storage, config, workspace } = context;
  if (existsSync(storage.localPath(workspace, JOURNAL))) {
    refuse('Hybrid recovery is pending. Recover it with the Hybrid tools first.');
  }
  if (!locked && existsSync(storage.localPath(workspace, LOCK))) {
    refuse('Hybrid is locked. Finish or recover the existing operation first.');
  }
  const text = textAt(context, STATE);
  if (text === null) refuse('This project is not managed by Hybrid.');
  const state = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!record(state) || state.version !== 1 || !record(state.hashes) ||
      Object.keys(state).some(key => !['version', 'profile', 'hashes'].includes(key)) ||
      !config.profileIDs.includes(state.profile) ||
      Object.keys(state.hashes).length !== MANAGED.length ||
      MANAGED.some(path => !owns(state.hashes, path) || !/^[a-f0-9]{64}$/.test(state.hashes[path]))) {
    refuse('Unsupported Hybrid ownership metadata; only the five standard managed files are allowed.');
  }
  for (const relative of MANAGED) storage.localPath(workspace, relative);
  return { state, text };
}

function inspect(context, { locked = false } = {}) {
  const { config, storage, workspace, directory } = context;
  const { state, text } = guardedState(context, locked);
  const manifest = `${HYBRID}/profiles/${state.profile}.json`;
  const manifestText = textAt(context, manifest);
  const info = JSON.parse(manifestText ?? 'null');
  if (!record(info) || info.id !== state.profile || !['openai', 'go'].includes(info.family)) {
    refuse('Invalid active Hybrid profile.');
  }
  const exact = `${HYBRID}/overrides/${state.profile}.json`;
  const sources = [
    ...MODULES.map(name => `${HYBRID}/${name}`), manifest,
    ...['core.json', 'slim.json', 'instructions.md', 'orchestrator-append.md', 'workflow.md']
      .map(name => `${HYBRID}/families/${info.family}/${name}`),
    ...['common', info.family, state.profile].map(name => `${HYBRID}/overrides/${name}.json`),
    ...['instructions.md', 'orchestrator-append.md', 'workflow.md'].map(name => `${HYBRID}/overrides/${name}`),
  ];
  const paths = [...sources, STATE, ...MANAGED];
  const before = fingerprints(context, paths);
  if (before[STATE] !== digest(text) || before[manifest] !== digest(manifestText) ||
      Object.entries(context.boot).some(([path, hash]) => before[path] !== hash)) {
    refuse('Hybrid inputs changed; reopen the selector.');
  }
  // All paths (including absent override paths) have now passed localPath.
  const current = storage.status(workspace);
  if (current.dirty.length) refuse('Generated Hybrid files are dirty; restore them through Hybrid before selecting a route.');
  const generated = config.generate(state.profile, {
    directory, overridesDirectory: join(directory, 'overrides'),
  });
  if (Object.keys(generated.files).length !== MANAGED.length ||
      MANAGED.some(path => !owns(generated.files, path))) {
    refuse('Unsupported generator outputs; only the five standard files are allowed.');
  }
  storage.assertOwned(workspace, generated.files);
  if (MANAGED.some(path => before[path] !== digest(generated.files[path]))) {
    refuse('Hybrid inputs have unapplied changes. Regenerate them with Hybrid before selecting a route.');
  }
  if (JSON.stringify(before) !== JSON.stringify(fingerprints(context, paths))) {
    refuse('Hybrid inputs changed; reopen the selector.');
  }
  const agents = config.routes(generated.core, generated.slim).map(([name, route]) => {
    const models = config.modelEntries(route).map(entry => ({ model: entry.model, variant: entry.variant ?? null }));
    return {
      name, model: models[0].model, variant: models[0].variant, models,
      fallback: Array.isArray(route.model),
      disabled: route.disabled === true || route.disable === true || generated.core.agent?.[name]?.disable === true,
    };
  });
  if (new Set(agents.map(agent => agent.name)).size !== agents.length) refuse('Ambiguous agent names in the active configuration.');
  return { generated, before, paths, exact, agents, token: tokenFor(context, before) };
}

function view(context, current) {
  return {
    workspace: context.workspace, profile: current.generated.info.id,
    preset: current.generated.slim.preset,
    councilPreset: current.generated.slim.council.default_preset,
    token: current.token, agents: current.agents,
  };
}

function invoke(context, current, args) {
  try {
    const env = { ...process.env, ...current.generated.env };
    const executable = context.launcher.cliExecutable(env);
    const invocation = context.launcher.cliInvocation(executable, args, env);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: context.workspace, env: invocation.env, encoding: 'utf8',
      timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) refuse('OpenCode CLI failed or timed out. No CLI diagnostics are exposed.');
    return result.stdout;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('OpenCode CLI could not be started. Check its installation or OPENCODE_BIN.');
  }
}

function normalizedDirectory(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function providerAllowed(core, provider) {
  return !core.disabled_providers?.includes(provider) &&
    (!Array.isArray(core.enabled_providers) || core.enabled_providers.includes(provider));
}

function catalog(context, current) {
  const output = invoke(context, current, [
    'api', 'get', '/api/model', '--header', `x-opencode-directory:${encodeURIComponent(context.workspace)}`,
  ]);
  let response;
  try { response = JSON.parse(output); } catch { refuse('OpenCode returned an invalid model catalog.'); }
  if (!record(response) || typeof response.location?.directory !== 'string' ||
      !isAbsolute(response.location.directory) ||
      normalizedDirectory(response.location.directory) !== normalizedDirectory(context.workspace) ||
      !Array.isArray(response.data)) {
    refuse('OpenCode model catalog did not confirm the requested project context.');
  }
  const models = [];
  const seen = new Set();
  for (const item of response.data) {
    if (!record(item) || typeof item.enabled !== 'boolean') refuse('OpenCode returned an invalid model catalog.');
    if (!item.enabled) continue;
    if (!identifier(item.providerID) || typeof item.id !== 'string' || !item.id ||
        typeof item.name !== 'string' || !item.name || !Array.isArray(item.variants)) {
      refuse('OpenCode returned an invalid model catalog.');
    }
    const id = item.id.startsWith(`${item.providerID}/`) ? item.id : `${item.providerID}/${item.id}`;
    if (!modelID(id) || seen.has(id)) refuse('OpenCode returned ambiguous or invalid model IDs.');
    seen.add(id);
    const variants = item.variants.map(variant => {
      if (!record(variant) || !identifier(variant.id)) refuse('OpenCode returned invalid model variants.');
      return variant.id;
    });
    if (new Set(variants).size !== variants.length) refuse('OpenCode returned duplicate model variants.');
    if (providerAllowed(current.generated.core, item.providerID)) models.push({ id, name: item.name, variants });
  }
  // Nothing from the raw response, including variant overlays, leaves this scope.
  return { models };
}

function routePaths(context, current, name) {
  const { core, slim } = current.generated;
  if (context.config.nativeNames.includes(name)) return [['core', 'agent', name]];
  const paths = [];
  if (context.config.slimNames.includes(name)) {
    paths.push(['slim', 'presets', slim.preset, name]);
    if (record(slim.agents?.[name])) paths.push(['slim', 'agents', name]);
  } else if (name.startsWith('councillor-') && owns(slim.council.presets[slim.council.default_preset], name.slice(11))) {
    paths.push(['slim', 'council', 'presets', slim.council.default_preset, name.slice(11)]);
  } else {
    paths.push(['slim', 'agents', name]);
  }
  if (owns(core.agent?.[name], 'model') || owns(core.agent?.[name], 'variant')) paths.push(['core', 'agent', name]);
  return paths;
}

function setRoute(patch, path, model, variant) {
  let node = patch;
  for (const key of path) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) refuse('Unsupported route name.');
    if (!owns(node, key)) node[key] = {};
    if (!record(node[key])) refuse('The selected route has an incompatible override.');
    node = node[key];
  }
  node.model = model;
  // Keep the null tombstone in the override, rather than merge-deleting it here.
  node.variant = variant;
}

function withoutRouting(configs, paths) {
  const copy = structuredClone(configs);
  for (const path of paths) {
    let node = copy;
    const parents = [];
    for (const key of path) {
      if (!record(node?.[key])) { node = null; break; }
      parents.push([node, key]);
      node = node[key];
    }
    if (!node) continue;
    delete node.model;
    delete node.variant;
    for (const [parent, key] of parents.reverse()) {
      if (Object.keys(parent[key]).length) break;
      delete parent[key];
    }
  }
  return copy;
}

// Ignore structural object-key reinsertion by merge(), but never permission order.
function controls(value, key = '') {
  if (key === 'permission') return JSON.stringify(value);
  if (Array.isArray(value)) return value.map(entry => controls(entry));
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(name => [name, controls(value[name], name)]));
}

function propose(context, current, request) {
  const { config, directory } = context;
  const originalText = textAt(context, current.exact);
  const original = originalText === null ? {} : JSON.parse(originalText.replace(/^\uFEFF/, ''));
  const override = structuredClone(original);
  const paths = routePaths(context, current, request.agent);
  for (const path of paths) setRoute(override, path, request.model, request.variant);
  const sameControls = (before, after) => JSON.stringify(controls(withoutRouting(before, paths))) ===
    JSON.stringify(controls(withoutRouting(after, paths)));
  if (!sameControls(original, override)) refuse('The proposal would change unrelated override controls.');

  // Reapply the exact same merge layers as generate(). No temporary config or
  // credential-bearing copies are needed, and key ordering matches regeneration.
  const stock = config.generate(current.generated.info.id, { directory });
  let core = stock.core;
  let slim = stock.slim;
  for (const name of ['common', current.generated.info.family, current.generated.info.id]) {
    const text = textAt(context, `${HYBRID}/overrides/${name}.json`);
    const patch = name === current.generated.info.id ? override : text === null ? {} : JSON.parse(text.replace(/^\uFEFF/, ''));
    core = config.merge(core, patch.core ?? {});
    slim = config.merge(slim, patch.slim ?? {});
  }
  config.validateConfiguration(core, slim, config.readJSON(join(directory, 'runtime.json')));
  if (!sameControls({ core: current.generated.core, slim: current.generated.slim }, { core, slim })) {
    refuse('The proposal would change unrelated configuration controls.');
  }
  const route = config.routes(core, slim).find(([name]) => name === request.agent)?.[1];
  if (!route || route.model !== request.model || (route.variant ?? null) !== request.variant) {
    refuse('The selected route did not resolve to the requested model and effort.');
  }
  const generated = {
    ...current.generated, core, slim,
    files: { ...current.generated.files, [MANAGED[0]]: config.json(core), [MANAGED[1]]: config.json(slim) },
  };
  return { generated, override: config.json(override) };
}

async function apply(context, request) {
  if (typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token) ||
      typeof request.agent !== 'string' || !modelID(request.model) ||
      !(request.variant === null || identifier(request.variant))) {
    refuse('Apply requires a preview token, configured agent, model ID and explicit variant (or null).');
  }
  // Refuse unsafe ownership before even acquiring a write lock.
  const initial = inspect(context);
  if (initial.token !== request.token) refuse('The project changed since the preview. Reopen the selector.');
  return context.storage.withLock(context.workspace, async () => {
    const current = inspect(context, { locked: true });
    if (current.token !== request.token) refuse('The project changed since the preview. Reopen the selector.');
    if (!current.agents.some(agent => agent.name === request.agent)) refuse('The selected agent is not configured.');
    const chosen = catalog(context, current).models.find(model => model.id === request.model);
    if (!chosen) refuse('The selected model is unavailable or its provider is disabled.');
    if (request.variant !== null && !chosen.variants.includes(request.variant)) refuse('The selected effort is not supported by this model.');
    const proposed = propose(context, current, request);
    const files = { [current.exact]: proposed.override, ...context.storage.filesWithState(proposed.generated) };
    const expected = { ...current.before };
    for (const [path, text] of Object.entries(files)) expected[path] = digest(text);
    context.storage.assertOwned(context.workspace, proposed.generated.files);
    await context.storage.transaction(context.workspace, files, {
      beforeWrite: () => {
        const fresh = inspect(context, { locked: true });
        if (fresh.token !== request.token) refuse('The project changed before writing. Reopen the selector.');
      },
      beforeCommit: () => {
        if (JSON.stringify(fingerprints(context, current.paths)) !== JSON.stringify(expected)) {
          refuse('Concurrent changes detected during commit; the selection was rolled back.');
        }
        const actual = context.config.generate(current.generated.info.id, {
          directory: context.directory, overridesDirectory: join(context.directory, 'overrides'),
        });
        if (Object.keys(actual.files).length !== MANAGED.length || MANAGED.some(path => actual.files[path] !== proposed.generated.files[path])) {
          refuse('Regeneration did not match the preview; the selection was rolled back.');
        }
        const stateText = context.config.json({
          version: 1, profile: actual.info.id,
          hashes: Object.fromEntries(Object.entries(actual.files).map(([path, text]) => [path, context.storage.hash(text)])),
        });
        if (textAt(context, STATE) !== stateText ||
            JSON.stringify(fingerprints(context, current.paths)) !== JSON.stringify(expected)) {
          refuse('Commit verification failed; the selection was rolled back.');
        }
      },
    });
    return {
      profile: proposed.generated.info.id, agent: request.agent, model: request.model,
      variant: request.variant, token: tokenFor(context, expected),
    };
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65536) refuse('Request is too large.');
  }
  let request;
  try { request = JSON.parse(input); } catch { refuse('Expected one JSON request on stdin.'); }
  if (!record(request) || !['inspect', 'catalog', 'apply', 'reload'].includes(request.action) ||
      typeof request.workspace !== 'string' || !request.workspace || /[\x00-\x1f]/.test(request.workspace)) {
    refuse('Expected an action and project workspace.');
  }
  const context = await load(resolve(request.workspace));
  if (request.action === 'apply') return apply(context, request);
  const current = inspect(context);
  if (request.action === 'inspect') return view(context, current);
  if (request.action === 'catalog') {
    const result = catalog(context, current);
    if (inspect(context).token !== current.token) refuse('The project changed while loading models. Reopen the selector.');
    return result;
  }
  invoke(context, current, ['reload']);
  return { reloaded: true };
}

try {
  const data = await main();
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
} catch (error) {
  const message = error instanceof Refusal ? error.message :
    'Operation refused. Check the Hybrid installation, ownership, inputs and recovery state. No internal diagnostics are exposed.';
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}
