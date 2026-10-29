#!/usr/bin/env python3
"""Interactively persist one agent route in an installed OpenCode Hybrid project.

Requires Python 3, Node.js and the existing OpenCode CLI. No Python dependencies.
Only explicit confirmation writes; reload is a separate, optional action.
"""

import argparse
import json
from pathlib import Path
import subprocess
import sys


BRIDGE = Path(__file__).resolve().with_suffix(".mjs")
DEFAULT_PROJECT = Path(__file__).resolve().parents[1]


class BridgeError(Exception):
    """A sanitized bridge or subprocess failure."""


def bridge(workspace, action, **fields):
    request = {"action": action, "workspace": str(workspace), **fields}
    try:
        result = subprocess.run(
            ["node", str(BRIDGE)],
            input=json.dumps(request), capture_output=True, text=True,
            encoding="utf-8", timeout=90, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise BridgeError("Could not run the Node bridge (missing Node.js or timeout).") from None
    try:
        response = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise BridgeError("The Node bridge did not return a valid response.") from None
    if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
        raise BridgeError("The Node bridge did not return a valid response.")
    if not response["ok"]:
        # The bridge emits only static, sanitized errors, never CLI stderr/configs.
        message = response.get("error")
        raise BridgeError(message if isinstance(message, str) else "The operation was refused.")
    if result.returncode or not isinstance(response.get("data"), dict):
        raise BridgeError("The Node bridge did not complete successfully.")
    return response["data"]


def display(value):
    """Keep model/catalog names from sending terminal control characters."""
    return "".join(char if char.isprintable() else "?" for char in str(value))


def effort(variant):
    return "(default / no setting)" if variant is None else display(variant)


def route_text(agent):
    return " -> ".join(
        f"{display(entry['model'])} [{effort(entry['variant'])}]"
        for entry in agent["models"]
    )


def show_agents(state):
    print(f"\nProject: {display(state['workspace'])}")
    print(f"Profile: {display(state['profile'])} | Preset: {display(state['preset'])}")
    for index, agent in enumerate(state["agents"], 1):
        disabled = " (disabled; selection does not enable it)" if agent.get("disabled") else ""
        print(f"{index:2}. {display(agent['name'])}: {route_text(agent)}{disabled}")


def choose_agent(agents):
    while True:
        answer = input("\nAgent number or exact name (q to quit): ").strip()
        if answer.lower() in {"q", "quit"}:
            return None
        if answer.isdigit() and 1 <= int(answer) <= len(agents):
            return agents[int(answer) - 1]
        for agent in agents:
            if agent["name"] == answer:
                return agent
        print("Choose a listed agent number or exact name.")


def show_models(models):
    for index, model in enumerate(models, 1):
        print(f"{index:3}. {display(model['id'])} — {display(model['name'])}")


def choose_model(models):
    if not models:
        print("No enabled models are available for this project.")
        return None
    visible = models
    show_models(visible)
    while True:
        answer = input("\nModel number, exact ID, or search (empty = all, q = back): ").strip()
        if answer.lower() in {"q", "quit"}:
            return None
        if answer.isdigit() and 1 <= int(answer) <= len(visible):
            return visible[int(answer) - 1]
        for model in models:
            if model["id"] == answer:
                return model
        query = answer.casefold()
        visible = [model for model in models if query in model["id"].casefold() or query in model["name"].casefold()]
        if visible:
            show_models(visible)
        else:
            print("No matching models. Try another search or an empty search for all.")


def choose_variant(model):
    variants = model["variants"]
    print("\nSupported efforts (from this model's current metadata):")
    print(" 0. (default / no setting)")
    for index, variant in enumerate(variants, 1):
        print(f"{index:2}. {display(variant)}")
    while True:
        answer = input("Effort number or exact ID (0 = default, q = back): ").strip()
        if answer.lower() in {"q", "quit"}:
            return False, None
        if answer == "0":
            return True, None
        if answer in variants:
            return True, answer
        if answer.isdigit() and 1 <= int(answer) <= len(variants):
            return True, variants[int(answer) - 1]
        print("Choose one of the listed efforts or 0 for no explicit setting.")


def confirmed(prompt):
    return input(prompt).strip().lower() in {"y", "yes"}


def interactive(workspace):
    while True:
        state = bridge(workspace, "inspect")
        show_agents(state)
        agent = choose_agent(state["agents"])
        if agent is None:
            return 0
        try:
            model = choose_model(bridge(workspace, "catalog")["models"])
            if model is None:
                continue
            selected, variant = choose_variant(model)
            if not selected:
                continue
            print("\nProposed persistent change (active exact-profile override only):")
            print(f"  Project: {display(state['workspace'])}")
            print(f"  Profile: {display(state['profile'])}")
            print(f"  Agent:   {display(agent['name'])}")
            print(f"  Old:     {route_text(agent)}")
            print(f"  New:     {display(model['id'])} [{effort(variant)}]")
            if agent.get("fallback") or len(agent["models"]) > 1:
                print("  The existing fallback array will be replaced by this single model (no fallback).")
            if variant is None:
                print("  Removes inherited effort settings from all bindings for this agent.")
            if not confirmed("Apply this change? [y/N]: "):
                print("Cancelled; no changes made.")
                continue
            bridge(workspace, "apply", token=state["token"], agent=agent["name"], model=model["id"], variant=variant)
            print("Saved persistently. Other agents and policies are unchanged.")
            if confirmed("Reload OpenCode for this project now? [y/N]: "):
                try:
                    bridge(workspace, "reload")
                    print("OpenCode reloaded.")
                except BridgeError as error:
                    print(f"Reload failed: {display(error)}\nThe saved selection remains applied; reload manually when ready.")
            else:
                print("Reload skipped. Reload/restart OpenCode when ready.")
        except BridgeError as error:
            print(f"Selection refused: {display(error)}", file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=DEFAULT_PROJECT, metavar="PATH", help="installed Hybrid project (default: this tool's project)")
    parser.add_argument("--list", action="store_true", help="list configured agents without loading models, changing files or reloading")
    args = parser.parse_args(argv)
    try:
        workspace = args.project.expanduser().resolve()
        if args.list:
            show_agents(bridge(workspace, "inspect"))
            return 0
        return interactive(workspace)
    except (EOFError, KeyboardInterrupt):
        print("\nExiting. No further changes or reload requested.")
        return 0
    except BridgeError as error:
        print(f"Error: {display(error)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
