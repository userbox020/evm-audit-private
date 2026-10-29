"""Offline selector contract tests; every writable/configuration path is synthetic.

Only the public Hybrid implementation modules are copied from the checkout.  The
fake OPENCODE_BIN never contacts Desktop, a provider, or a model inference API.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "tools" / "configure-opencode-agent.mjs"
CLI = ROOT / "tools" / "configure-opencode-agent.py"
NODE = shutil.which("node")
PROFILE = "openai-balanced"
PRESET = "fixture-active"
BOARD = "custom-board"
CANARY = "SYNTHETIC_SECRET_CANARY"
NATIVE = ("build", "plan", "general", "explore", "title", "summary", "compaction")
SLIM = ("orchestrator", "oracle", "council", "explorer", "librarian", "fixer", "designer", "observer")
REVIEW = ("code-reviewer", "repo-architect", "test-writer", "security-reviewer")
AUDIT = ("audit-reviewer", "defi-auditor")
SEATS = ("deep-review", "deep-audit", "fast-sanity")
GENERATED = (
    ".opencode/opencode.jsonc",
    ".opencode/oh-my-opencode-slim.jsonc",
    ".opencode/oh-my-opencode-slim/project-instructions.md",
    ".opencode/oh-my-opencode-slim/orchestrator_append.md",
    ".opencode/skills/project-workflow/SKILL.md",
)

FAKE_CLI = r"""
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SELECTOR_TEST_CALLS, JSON.stringify(args) + '\n');
function refuse() {
  process.stderr.write('SYNTHETIC_SECRET_CANARY: raw CLI diagnostic');
  process.exit(19);
}
if (args[0] === 'reload') {
  if (args.length > 2 || path.resolve(process.cwd()) !== path.resolve(process.env.SELECTOR_TEST_ROOT) ||
      (args.length === 2 && path.resolve(args[1]) !== path.resolve(process.env.SELECTOR_TEST_ROOT))) refuse();
  process.stdout.write('{}');
  process.exit(0);
}
if (args[0] !== 'api' || args[1] !== 'get' || args[2] !== '/api/model') refuse();
const headers = args.flatMap((arg, index) => arg === '--header' ? [args[index + 1]] : []);
const header = headers.find(value => /^x-opencode-directory:/i.test(value || ''));
if (!header || args.includes('--param') || !header.includes('%20')) refuse();
try {
  const directory = decodeURIComponent(header.slice(header.indexOf(':') + 1).trim());
  if (path.resolve(directory) !== path.resolve(process.env.SELECTOR_TEST_ROOT)) refuse();
} catch { refuse(); }
if (process.env.SELECTOR_TEST_MODE === 'stderr') refuse();
if (process.env.SELECTOR_TEST_MODE === 'malformed') {
  process.stdout.write('not JSON: SYNTHETIC_SECRET_CANARY');
  process.exit(0);
}
process.stdout.write(fs.readFileSync(process.env.SELECTOR_TEST_PAYLOAD, 'utf8'));
"""


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def route(name):
    return {"model": "openai/old", "variant": "high", "description": "keep " + name}


def nested(value, keys):
    for key in keys:
        value = value[key]
    return value


@unittest.skipUnless(NODE, "Node is required by the selector's public bridge")
class ConfigureOpenCodeAgentTest(unittest.TestCase):
    def setUp(self):
        # Never fall back to a live project if either implementation is missing.
        self.assertTrue(BRIDGE.is_file(), "selector bridge implementation is not available yet")
        self.assertTrue(CLI.is_file(), "selector Python implementation is not available yet")
        temp_parent = Path(tempfile.gettempdir()) / "opencode" if os.name == "nt" else None
        if temp_parent is not None:
            temp_parent.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="selector fixture with spaces ", dir=temp_parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.hybrid = self.root / ".opencode" / "hybrid"
        self.hybrid.mkdir(parents=True)
        for name in ("config.mjs", "storage.mjs", "launch.mjs"):
            shutil.copyfile(ROOT / ".opencode" / "hybrid" / name, self.hybrid / name)
        self.tools = self.root / "tools"
        self.tools.mkdir()
        shutil.copyfile(BRIDGE, self.tools / BRIDGE.name)
        shutil.copyfile(CLI, self.tools / CLI.name)
        self.exact = self.hybrid / "overrides" / (PROFILE + ".json")
        self.common = self.hybrid / "overrides" / "common.json"
        write_json(self.common, {})
        write_json(self.exact, {})
        write_json(self.hybrid / "runtime.json", {
            "pluginVersion": "2.2.24",
            "node": {"minimumByMajor": {"24": "24.15.0"}, "minimumNewer": "26.0.0", "recommended": "24.15.0"},
            "modelReplacements": {},
        })
        write_json(self.hybrid / "profiles" / (PROFILE + ".json"), {
            "id": PROFILE, "family": "openai", "preset": PRESET, "label": "Synthetic profile",
        })
        core = {
            "$schema": "https://opencode.ai/config.json",
            "plugin": ["oh-my-opencode-slim@2.2.24"],
            "model": "openai/old", "small_model": "openai/old", "default_agent": "orchestrator",
            "disabled_providers": ["blocked"],
            "agent": {name: route(name) for name in NATIVE},
            "permission": {
                "*": "deny", "read": {"*": "allow", "private/*": "deny"},
                "edit": {"*": "deny", "synthetic/*": "allow"},
            },
        }
        # The core/Slim overlap is valid initially and must stay synchronized.
        core["agent"]["oracle"] = route("core oracle policy")
        slim = {
            "preset": PRESET,
            "presets": {
                PRESET: {name: route(name) for name in SLIM},
                "inactive-sentinel": {name: route("inactive " + name) for name in SLIM},
            },
            "agents": {name: route(name) for name in REVIEW + AUDIT},
            "council": {
                "default_preset": BOARD,
                "presets": {BOARD: {name: route(name) for name in SEATS}},
            },
            "fallback": {"enabled": False},
            "background_subagents": {"wake": False},
            "policy_sentinel": {"preserve": ["local-only", "no-automatic-inference"]},
        }
        slim["agents"]["oracle"] = route("top-level oracle shadow")
        write_json(self.hybrid / "families" / "openai" / "core.json", core)
        write_json(self.hybrid / "families" / "openai" / "slim.json", slim)
        for name in ("instructions.md", "orchestrator-append.md", "workflow.md"):
            (self.hybrid / "families" / "openai" / name).write_text("Synthetic policy " + name + "\n", encoding="utf-8")

        # Inherit only process-launch plumbing, not authentication/configuration.
        inherited = ("PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP")
        self.env = {key: os.environ[key] for key in inherited if key in os.environ}
        home = self.root / "empty user home"
        home.mkdir()
        self.env.update({
            "HOME": str(home), "USERPROFILE": str(home),
            "APPDATA": str(home / "AppData" / "Roaming"),
            "LOCALAPPDATA": str(home / "AppData" / "Local"),
            "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8",
        })
        fake = self.root / "fake opencode.cjs"
        fake.write_text(FAKE_CLI, encoding="utf-8")
        shim = self.root / ("fake opencode.cmd" if os.name == "nt" else "fake opencode")
        if os.name == "nt":
            shim.write_text('@echo off\n"' + str(NODE) + '" "' + str(fake) + '" %*\n', encoding="utf-8")
        else:
            import shlex
            shim.write_text("#!/bin/sh\nexec " + shlex.quote(str(NODE)) + " " + shlex.quote(str(fake)) + ' "$@"\n', encoding="utf-8")
            shim.chmod(0o700)
        self.payload_path = self.root / "synthetic model API.json"
        self.calls_path = self.root / "synthetic API calls.jsonl"
        self.payload = {
            "location": {"directory": str(self.root)},
            "data": [
                {"providerID": "openai", "id": "new", "name": "New", "enabled": True,
                 "variants": [{"id": "high"}, {"id": "max"}],
                 "headers": {"Authorization": CANARY}, "apiKey": CANARY},
                {"providerID": "disabled", "id": "hidden", "name": "Disabled", "enabled": False,
                 "variants": [{"id": "high"}]},
                {"providerID": "blocked", "id": "hidden", "name": "Blocked", "enabled": True,
                 "variants": [{"id": "high"}]},
            ],
        }
        write_json(self.payload_path, self.payload)
        self.env.update({
            "OPENCODE_BIN": str(shim), "SELECTOR_TEST_ROOT": str(self.root),
            "SELECTOR_TEST_PAYLOAD": str(self.payload_path), "SELECTOR_TEST_CALLS": str(self.calls_path),
        })
        self.seed()

    def run_process(self, args, input_text="", cwd=None):
        return subprocess.run(args, input=input_text, text=True, encoding="utf-8", capture_output=True,
                              cwd=cwd or self.root, env=self.env, timeout=40)

    def node_module(self, source):
        result = self.run_process([NODE, "--input-type=module", "-e", source])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def seed(self):
        self.node_module("import {selectProfile} from './.opencode/hybrid/storage.mjs'; "
                         "await selectProfile(process.cwd(), 'openai-balanced');")

    def snapshot(self):
        # This traversal is confined to our synthetic fixture, never the checkout.
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in (self.root / ".opencode").rglob("*") if path.is_file()}

    def calls(self):
        if not self.calls_path.exists():
            return []
        return [json.loads(line) for line in self.calls_path.read_text(encoding="utf-8").splitlines()]

    def request(self, action, ok=True, **fields):
        request = {"action": action, "workspace": str(self.root), **fields}
        result = self.run_process([NODE, str(self.tools / BRIDGE.name)], json.dumps(request))
        self.assertNotIn(CANARY, result.stdout + result.stderr)
        try:
            response = json.loads(result.stdout)
        except ValueError:
            self.fail("bridge did not return one JSON response: " + repr(result.stdout))
        self.assertIs(response.get("ok"), ok, {"response": response, "syntheticCliCalls": self.calls()})
        if ok:
            self.assertEqual(result.returncode, 0, response)
            self.assertIsInstance(response.get("data"), dict)
            return response["data"]
        self.assertNotEqual(result.returncode, 0)
        self.assertIsInstance(response.get("error"), str)
        self.assertTrue(response["error"].strip())
        self.assertNotIn("data", response)
        return response

    def inspect(self):
        return self.request("inspect")

    def apply(self, agent="compaction", model="openai/new", variant="max", token=None, ok=True):
        if token is None:
            token = self.inspect()["token"]
        return self.request("apply", token=token, agent=agent, model=model, variant=variant, ok=ok)

    def generated(self):
        return {"core": read_json(self.root / GENERATED[0]), "slim": read_json(self.root / GENERATED[1])}

    def assert_clean(self):
        state = read_json(self.hybrid / "state.json")
        self.assertEqual(state["profile"], PROFILE)
        self.assertEqual(set(state["hashes"]), set(GENERATED))
        for path, digest in state["hashes"].items():
            self.assertEqual(hashlib.sha256((self.root / path).read_bytes()).hexdigest(), digest, path)
        self.assertFalse((self.hybrid / ".switch.lock").exists())
        self.assertFalse((self.hybrid / ".switch-journal.json").exists())
        self.assertEqual(list((self.root / ".opencode").rglob("*.hybrid-tmp")), [])
        status = json.loads(self.node_module("import {status} from './.opencode/hybrid/storage.mjs'; "
                                            "console.log(JSON.stringify(status(process.cwd())));"))
        self.assertEqual(status["dirty"], [])
        self.assertFalse(status["pendingRecovery"])

    def assert_selected_change(self, agent, paths, variant="max"):
        before = self.snapshot()
        expected = self.generated()
        patch = read_json(self.exact)
        for keys in paths:
            binding = nested(expected, keys)
            binding["model"] = "openai/new"
            if variant is None:
                binding.pop("variant", None)
            else:
                binding["variant"] = variant
            target = patch
            for key in keys:
                target = target.setdefault(key, {})
            target.update({"model": "openai/new", "variant": variant})
        result = self.apply(agent=agent, variant=variant)
        self.assertEqual({key: result[key] for key in ("profile", "agent", "model", "variant")},
                         {"profile": PROFILE, "agent": agent, "model": "openai/new", "variant": variant})
        self.assertEqual(read_json(self.exact), patch, "only selected model/variant patches belong in the exact override")
        actual = self.generated()
        self.assertEqual(actual, expected, "other agents/defaults/policies must not change")
        self.assertEqual(json.dumps(actual["core"]["permission"]), json.dumps(expected["core"]["permission"]))
        allowed = {self.exact.relative_to(self.root).as_posix(), ".opencode/hybrid/state.json"}
        allowed.update(GENERATED[:2])
        after = self.snapshot()
        self.assertEqual(set(after), set(before))
        for path, content in before.items():
            if path not in allowed:
                self.assertEqual(after[path], content, path)
        for group, path in zip(("core", "slim"), GENERATED):
            if not any(keys[0] == group for keys in paths):
                self.assertEqual(after[path], before[path], path)
        self.assert_clean()

    def run_cli(self, lines="", *args, default_project=False):
        command = [sys.executable, "-B", str(self.tools / CLI.name)]
        if not default_project:
            command += ["--project", str(self.root)]
        command += list(args)
        unrelated = self.root / "unrelated working directory"
        unrelated.mkdir(exist_ok=True)
        result = self.run_process(command, lines, cwd=unrelated)
        self.assertNotIn(CANARY, result.stdout + result.stderr)
        return result

    def test_inspect_is_read_only_and_lists_all_effective_routes(self):
        before = self.snapshot()
        info = self.inspect()
        self.assertEqual(Path(info["workspace"]).resolve(), self.root)
        self.assertEqual((info["profile"], info["preset"], info["councilPreset"]), (PROFILE, PRESET, BOARD))
        self.assertTrue(info["token"])
        agents = {agent["name"]: agent for agent in info["agents"]}
        self.assertEqual(len(agents), len(info["agents"]))
        self.assertEqual(set(agents), set(NATIVE + SLIM + REVIEW + AUDIT + tuple("councillor-" + seat for seat in SEATS)))
        for agent in agents.values():
            self.assertEqual((agent["model"], agent["variant"]), ("openai/old", "high"))
            self.assertEqual(agent["models"], [{"model": "openai/old", "variant": "high"}])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.calls(), [])

    def test_catalog_projects_dynamic_variants_and_filters_disabled_providers(self):
        before = self.snapshot()
        catalog = self.request("catalog")
        self.assertEqual(catalog, {"models": [{"id": "openai/new", "name": "New", "variants": ["high", "max"]}]})
        calls = self.calls()
        self.assertTrue(calls)
        self.assertTrue(all(call[:3] == ["api", "get", "/api/model"] for call in calls))
        self.assertTrue(all("--header" in call and "--param" not in call for call in calls))
        self.assertEqual(self.snapshot(), before)

    def test_native_compaction_exact_two_field_patch_and_fresh_hashes(self):
        self.assert_selected_change("compaction", [("core", "agent", "compaction")])
        self.assertEqual(read_json(self.exact), {"core": {"agent": {"compaction": {"model": "openai/new", "variant": "max"}}}})

    def test_slim_preset_shadow_and_core_duplicate_stay_synchronized(self):
        self.assert_selected_change("oracle", [
            ("slim", "presets", PRESET, "oracle"), ("slim", "agents", "oracle"), ("core", "agent", "oracle"),
        ])

    def test_reviewer_and_audit_roles_use_top_level_slim_agents(self):
        for agent in ("code-reviewer", "audit-reviewer"):
            with self.subTest(agent=agent):
                self.assert_selected_change(agent, [("slim", "agents", agent)])

    def test_custom_councillor_uses_active_council_preset_not_builtin_name(self):
        self.assert_selected_change("councillor-deep-audit", [("slim", "council", "presets", BOARD, "deep-audit")])

    def test_default_null_clears_all_selected_inherited_variant_bindings(self):
        write_json(self.common, {"slim": {"agents": {"oracle": {"variant": "high"}}}})
        write_json(self.hybrid / "overrides" / "openai.json", {"core": {"agent": {"oracle": {"variant": "high"}}}})
        write_json(self.exact, {"slim": {"agents": {"oracle": {"description": "keep exact metadata"}}}})
        self.seed()
        self.assert_selected_change("oracle", [
            ("slim", "presets", PRESET, "oracle"), ("slim", "agents", "oracle"), ("core", "agent", "oracle"),
        ], variant=None)
        oracle = next(agent for agent in self.inspect()["agents"] if agent["name"] == "oracle")
        self.assertIsNone(oracle["variant"])

    def test_model_array_inspection_and_selection_replace_only_selected_route(self):
        path = self.hybrid / "families" / "openai" / "slim.json"
        slim = read_json(path)
        slim["presets"][PRESET]["fixer"]["model"] = [
            {"id": "openai/old", "variant": "high"}, {"id": "openai/alternate", "variant": "max"},
        ]
        write_json(path, slim)
        self.seed()
        fixer = next(agent for agent in self.inspect()["agents"] if agent["name"] == "fixer")
        self.assertEqual(fixer["models"], [
            {"model": "openai/old", "variant": "high"}, {"model": "openai/alternate", "variant": "max"},
        ])
        self.assert_selected_change("fixer", [("slim", "presets", PRESET, "fixer")], variant=None)

    def test_invalid_variant_and_unknown_model_fail_without_mutation(self):
        token = self.inspect()["token"]
        before = self.snapshot()
        for model, variant in (("openai/new", "invented-effort"), ("openai/unlisted", "max")):
            with self.subTest(model=model, variant=variant):
                self.apply(token=token, model=model, variant=variant, ok=False)
                self.assertEqual(self.snapshot(), before)

    def test_disabled_provider_cannot_be_applied(self):
        token = self.inspect()["token"]
        before = self.snapshot()
        for model in ("blocked/hidden", "disabled/hidden"):
            with self.subTest(model=model):
                self.apply(token=token, model=model, variant="high", ok=False)
                self.assertEqual(self.snapshot(), before)

    def test_wrong_catalog_workspace_fails_closed(self):
        token = self.inspect()["token"]
        self.payload["location"]["directory"] = str(self.root / "different project")
        write_json(self.payload_path, self.payload)
        before = self.snapshot()
        self.request("catalog", ok=False)
        self.apply(token=token, ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_mangled_catalog_and_raw_cli_error_are_sanitized(self):
        token = self.inspect()["token"]
        before = self.snapshot()
        for mode in ("malformed", "stderr"):
            with self.subTest(mode=mode):
                self.env["SELECTOR_TEST_MODE"] = mode
                self.request("catalog", ok=False)
                self.apply(token=token, ok=False)
                self.assertEqual(self.snapshot(), before)

    def test_invalid_catalog_shape_cannot_supply_an_invented_effort(self):
        token = self.inspect()["token"]
        self.payload["data"][0]["variants"] = "max"
        write_json(self.payload_path, self.payload)
        before = self.snapshot()
        self.apply(token=token, ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_dirty_generated_file_is_not_adopted_or_overwritten(self):
        token = self.inspect()["token"]
        path = self.root / GENERATED[0]
        path.write_bytes(path.read_bytes() + b"\n// user edit must survive\n")
        before = self.snapshot()
        self.apply(token=token, ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_pending_recovery_is_not_automatically_recovered(self):
        token = self.inspect()["token"]
        write_json(self.hybrid / ".switch-journal.json", {"version": 1, "entries": [], "staged": []})
        before = self.snapshot()
        self.apply(token=token, ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_held_switch_lock_is_not_forced_or_deleted(self):
        token = self.inspect()["token"]
        write_json(self.hybrid / ".switch.lock", {"pid": os.getpid()})
        before = self.snapshot()
        self.apply(token=token, ok=False)
        self.assertEqual(self.snapshot(), before)

    def test_stale_token_after_override_edit_preserves_user_changes(self):
        token = self.inspect()["token"]
        write_json(self.common, {"core": {"agent": {"summary": {"description": "intervening edit"}}}})
        self.seed()
        before = self.snapshot()
        self.apply(token=token, ok=False)
        self.assertEqual(self.snapshot(), before)
        self.assert_clean()

    def test_mid_transaction_failure_rolls_back_override_outputs_and_state(self):
        # Inject only into the disposable copy, after its initial real selection.
        storage = self.hybrid / "storage.mjs"
        source = storage.read_text(encoding="utf-8")
        hook = "      await afterWrite?.(index, entry);"
        self.assertEqual(source.count(hook), 1, "public storage transaction hook changed")
        storage.write_text(source.replace(hook, hook + "\n      if (index === 0) throw new Error('synthetic first-rename failure');"), encoding="utf-8")
        token = self.inspect()["token"]
        before = self.snapshot()
        self.apply(token=token, ok=False)
        self.assertEqual(self.snapshot(), before)
        self.assert_clean()

    def test_help_and_list_are_read_only_and_default_project_is_script_parent(self):
        before = self.snapshot()
        for args in (("--help",), ("--list",)):
            with self.subTest(args=args):
                result = self.run_cli("", *args, default_project=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                if args == ("--list",):
                    self.assertIn("compaction", result.stdout)
                    self.assertIn("councillor-deep-audit", result.stdout)
                self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.calls(), [])

    def test_interactive_no_confirmation_cancels_without_mutation(self):
        before = self.snapshot()
        for confirmation in ("n", ""):
            with self.subTest(confirmation=confirmation):
                result = self.run_cli("compaction\nopenai/new\nmax\n" + confirmation + "\nq\n")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.snapshot(), before)
        self.assertTrue(all(call[1] == "get" for call in self.calls()))

    def test_interactive_eof_at_each_selection_stage_never_applies(self):
        before = self.snapshot()
        for lines in ("", "compaction\n", "compaction\nopenai/new\n", "compaction\nopenai/new\nmax\n"):
            with self.subTest(lines=lines):
                result = self.run_cli(lines)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.snapshot(), before)
        self.assertTrue(all(call[1] == "get" for call in self.calls()))

    def test_interactive_explicit_yes_applies_and_no_skips_reload(self):
        before = self.generated()
        result = self.run_cli("compaction\nopenai/new\nmax\ny\nn\nq\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        before["core"]["agent"]["compaction"].update({"model": "openai/new", "variant": "max"})
        self.assertEqual(self.generated(), before)
        self.assertEqual(read_json(self.exact), {"core": {"agent": {"compaction": {"model": "openai/new", "variant": "max"}}}})
        self.assertTrue(self.calls())
        self.assertTrue(all(call[1] == "get" for call in self.calls()))
        self.assert_clean()

    def test_interactive_agent_index_model_search_and_default_effort(self):
        agents = self.inspect()["agents"]
        number = next(index for index, agent in enumerate(agents, 1) if agent["name"] == "compaction")
        before = self.generated()
        result = self.run_cli(str(number) + "\nNew\n1\n0\ny\nn\nq\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        before["core"]["agent"]["compaction"]["model"] = "openai/new"
        before["core"]["agent"]["compaction"].pop("variant")
        self.assertEqual(self.generated(), before)
        self.assertEqual(read_json(self.exact)["core"]["agent"]["compaction"], {"model": "openai/new", "variant": None})
        self.assert_clean()

    def test_interactive_q_backs_out_of_model_and_effort_selection(self):
        before = self.snapshot()
        for lines in ("q\n", "compaction\nq\nq\n", "compaction\nopenai/new\nq\nq\n"):
            with self.subTest(lines=lines):
                result = self.run_cli(lines)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.snapshot(), before)

    def test_reload_uses_only_fake_cli_and_does_not_rewrite_configuration(self):
        before = self.snapshot()
        self.assertEqual(self.request("reload"), {"reloaded": True})
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.calls()[0][0], "reload")
        self.assertEqual(self.snapshot(), before)

    def test_interactive_reload_requires_separate_affirmative_answer(self):
        result = self.run_cli("compaction\nopenai/new\nmax\ny\ny\nq\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(read_json(self.exact)["core"]["agent"]["compaction"], {"model": "openai/new", "variant": "max"})
        self.assertEqual(sum(call[0] == "reload" for call in self.calls()), 1)
        self.assert_clean()


if __name__ == "__main__":
    unittest.main()
