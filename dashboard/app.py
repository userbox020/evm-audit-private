"""Loopback-only Flask application for the local watchboard."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from flask import Flask, abort, jsonify, render_template, request
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from .artifacts import ArtifactReader
from .canary import build_canary
from .catalog import BY_ID
from .deployed_contracts import build_deployed_contracts
from .jobs import JobsInspector
from .liquidity import build_liquidity
from .findings import build_findings
from .ops import build_ops
from .service import legacy_state_valid, snapshot, venus_state_valid
from .targets import build_inventory, build_targets
from .targets_history import build_targets_history
from .wallets import (
    MAX_BODY_BYTES,
    WatchlistError,
    WalletStore,
    auto_refresh,
    collector_hint,
    collector_status,
    start_refresh,
)

HOST_V4 = re.compile(r"^(127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?$", re.IGNORECASE)
HOST_V6 = re.compile(r"^\[::1\](?::([0-9]{1,5}))?$")
WALLET_WRITE_PATHS = {
    "/api/v1/wallets/addresses",
    "/api/v1/wallets/addresses/remove",
    "/api/v1/wallets/refresh",
}
ALLOWED_ORIGINS = {
    "http://127.0.0.1:5050",
    "http://localhost:5050",
    "http://[::1]:5050",
}


def _valid_port(value: str | None) -> bool:
    return value is None or (value.isascii() and value.isdigit() and 1 <= int(value) <= 65_535)


def _valid_host(value: Any) -> bool:
    """Accept only explicit loopback host forms and syntactically valid ports."""

    if not isinstance(value, str) or not value or value != value.strip():
        return False
    if any(ord(character) < 33 or ord(character) > 126 for character in value):
        return False
    if value == "::1":
        return True
    ipv6 = HOST_V6.fullmatch(value)
    if ipv6 is not None:
        return _valid_port(ipv6.group(1))
    ipv4 = HOST_V4.fullmatch(value)
    return bool(ipv4 and _valid_port(ipv4.group(2)))


def create_app(root: str | Path | None = None) -> Flask:
    """Create the read-only dashboard application rooted at local fixtures."""

    app = Flask(__name__)
    app.config.update(
        ROOT=str(root or Path(__file__).resolve().parents[1]),
        DEBUG=False,
        # Framework-level bound. Wallet POST bodies are read through a bounded
        # stream read below, so the limit is enforced before the whole body is
        # buffered (declared Content-Length and terminated/unknown-length streams).
        MAX_CONTENT_LENGTH=MAX_BODY_BYTES,
    )
    reader = ArtifactReader(app.config["ROOT"])
    store = WalletStore(app.config["ROOT"])
    jobs_inspector = JobsInspector()
    app.extensions["jobs_inspector"] = jobs_inspector

    @app.before_request
    def local_only() -> None:
        method = request.method
        if method in {"GET", "HEAD", "OPTIONS"}:
            pass
        elif method == "POST" and request.path in WALLET_WRITE_PATHS:
            pass
        else:
            abort(405)
        host = request.environ.get("HTTP_HOST")
        if request.remote_addr not in {"127.0.0.1", "::1"} or not _valid_host(host):
            abort(403)

    @app.errorhandler(HTTPException)
    def api_error(error: HTTPException) -> Any:
        if request.path.startswith("/api/"):
            reason = re.sub(r"[^A-Z0-9]+", "_", error.name.upper()).strip("_")
            return (
                jsonify({"ok": False, "reason": reason, "status": error.code}),
                error.code,
            )
        return error

    @app.errorhandler(RequestEntityTooLarge)
    def api_too_large(error: RequestEntityTooLarge) -> Any:
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "reason": "BODY_TOO_LARGE"}), 413
        return error

    @app.after_request
    def secure(response: Any) -> Any:
        response.headers.update(
            {
                "Content-Security-Policy": "default-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
            }
        )
        return response

    @app.route("/")
    def index() -> str:
        return render_template(
            "index.html",
            data=snapshot(reader),
            selected=request.args.get("disposition", ""),
            coverage_filter=request.args.get("coverage", ""),
        )

    @app.route("/monitors/<ident>")
    def monitor(ident: str) -> str:
        if ident not in BY_ID:
            abort(404)
        data = snapshot(reader)
        record = next(item for item in data["monitors"] if item["id"] == ident)
        events = sorted(
            (event for event in data["alarms"] if event["monitor_id"] == ident),
            key=lambda event: event.get("event_at") or "",
            reverse=True,
        )[:20]
        return render_template("monitor.html", monitor=record, events=events)

    @app.route("/alarms")
    def alarms() -> str:
        return render_template("alarms.html", data=snapshot(reader))

    @app.route("/canary")
    def canary() -> str:
        now = time.time()
        data = build_canary(reader, now)
        balances = data["balances"]
        refresh = auto_refresh(
            app.config["ROOT"],
            available=balances["available"],
            age=balances["age"],
            now=now,
        )
        return render_template(
            "canary.html",
            data=data,
            refresh=refresh,
            collector=collector_status(),
            collector_hint=collector_hint(),
        )

    @app.route("/api/v1/snapshot")
    def api() -> Any:
        return jsonify(snapshot(reader))

    @app.get("/jobs")
    def jobs() -> str:
        if len(request.query_string) > 4096:
            abort(400)
        snap = jobs_inspector.snapshot()
        return render_template("jobs.html", jobs=snap, deployed=build_deployed_contracts(snap, request.args), title="Jobs")

    @app.get("/api/v1/jobs")
    def jobs_api() -> Any:
        return jsonify(jobs_inspector.snapshot())

    @app.get("/api/v1/jobs/contracts")
    def deployed_contracts_api() -> Any:
        if len(request.query_string) > 4096:
            abort(400)
        return jsonify(build_deployed_contracts(jobs_inspector.snapshot(), request.args))

    @app.route("/api/v1/canary")
    def canary_api() -> Any:
        return jsonify(build_canary(reader, time.time()))

    @app.route("/api/v1/ops")
    def ops_api() -> Any:
        return jsonify(build_ops(reader, time.time()))

    @app.get("/targets")
    def targets() -> str:
        if len(request.query_string) > 4096:
            abort(400)
        return render_template("targets.html", data=build_targets(reader, time.time(), request.args))

    @app.get("/api/v1/targets")
    def targets_api() -> Any:
        if len(request.query_string) > 4096:
            abort(400)
        return jsonify(build_targets(reader, time.time(), request.args))

    @app.get("/liquidity")
    def liquidity_page() -> str:
        if len(request.query_string) > 4096:
            abort(400)
        return render_template("liquidity.html", data=build_liquidity(request.args))

    @app.get("/api/v1/liquidity")
    def liquidity_api() -> Any:
        if len(request.query_string) > 4096:
            abort(400)
        return jsonify(build_liquidity(request.args))

    @app.get("/findings")
    def findings_page() -> str:
        if len(request.query_string) > 4096:
            abort(400)
        return render_template("findings.html", data=build_findings(request.args))

    @app.get("/api/v1/findings")
    def findings_api() -> Any:
        if len(request.query_string) > 4096:
            abort(400)
        return jsonify(build_findings(request.args))

    @app.get("/inventory")
    def inventory() -> str:
        if len(request.query_string) > 4096:
            abort(400)
        return render_template("targets.html", data=build_inventory(reader, time.time(), request.args))

    @app.get("/targets/history")
    def targets_history_page() -> str:
        if len(request.query_string) > 4096:
            abort(400)
        return render_template("targets_history.html", history=build_targets_history(reader, time.time(), request.args))

    @app.get("/api/v1/targets/history")
    def targets_history_api() -> Any:
        if len(request.query_string) > 4096:
            abort(400)
        return jsonify(build_targets_history(reader, time.time(), request.args))

    @app.get("/targets/history/<record_id>")
    def targets_history_detail_page(record_id: str) -> str:
        if len(request.query_string) > 4096:
            abort(400)
        history = build_targets_history(reader, time.time(), record_id=record_id)
        if history is None:
            abort(404)
        return render_template("targets_history_detail.html", history=history)

    @app.get("/api/v1/targets/history/<record_id>")
    def targets_history_detail_api(record_id: str) -> Any:
        if len(request.query_string) > 4096:
            abort(400)
        history = build_targets_history(reader, time.time(), record_id=record_id)
        if history is None:
            abort(404)
        return jsonify(history)

    @app.get("/api/v1/inventory")
    def inventory_api() -> Any:
        if len(request.query_string) > 4096:
            abort(400)
        return jsonify(build_inventory(reader, time.time(), request.args))

    def wallet_payload() -> tuple[dict[str, Any] | None, Any]:
        if request.mimetype != "application/json":
            return None, (jsonify({"ok": False, "reason": "UNSUPPORTED_MEDIA_TYPE"}), 415)
        origin = request.headers.get("Origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            return None, (jsonify({"ok": False, "reason": "FORBIDDEN_ORIGIN"}), 403)
        # Reject a declared oversize before touching the body, then read the
        # stream in bounded chunks so an unknown-length/terminated body cannot
        # be buffered past the limit.
        length = request.content_length
        if length is not None and length > MAX_BODY_BYTES:
            return None, (jsonify({"ok": False, "reason": "BODY_TOO_LARGE"}), 413)
        try:
            stream = request.stream
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = stream.read(min(65536, MAX_BODY_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_BODY_BYTES:
                    raise RequestEntityTooLarge()
        except RequestEntityTooLarge:
            return None, (jsonify({"ok": False, "reason": "BODY_TOO_LARGE"}), 413)
        raw = b"".join(chunks)
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            return None, (jsonify({"ok": False, "reason": "INVALID_JSON"}), 400)
        if not isinstance(payload, dict):
            return None, (jsonify({"ok": False, "reason": "INVALID_JSON"}), 400)
        return payload, None

    @app.post("/api/v1/wallets/addresses")
    def wallets_add() -> Any:
        payload, error = wallet_payload()
        if error is not None:
            return error
        payload = payload or {}
        try:
            result = store.add(payload.get("address"), payload.get("label"), payload.get("family"))
        except WatchlistError as failure:
            return jsonify({"ok": False, "reason": failure.reason}), failure.status
        started = start_refresh(app.config["ROOT"], changed=True)
        return (
            jsonify(
                {
                    "ok": True,
                    "count": len(result["addresses"]),
                    "addresses": result["addresses"],
                    "refresh": "started" if started else "already_running",
                }
            ),
            201,
        )

    @app.post("/api/v1/wallets/addresses/remove")
    def wallets_remove() -> Any:
        payload, error = wallet_payload()
        if error is not None:
            return error
        payload = payload or {}
        try:
            result = store.remove(payload.get("address"), payload.get("family"))
        except WatchlistError as failure:
            return jsonify({"ok": False, "reason": failure.reason}), failure.status
        start_refresh(app.config["ROOT"], changed=True)
        return jsonify({"ok": True, "count": len(result["addresses"]), "addresses": result["addresses"]}), 200

    @app.post("/api/v1/wallets/refresh")
    def wallets_refresh() -> Any:
        _payload, error = wallet_payload()
        if error is not None:
            return error
        if not start_refresh(app.config["ROOT"]):
            return jsonify({"ok": False, "reason": "COLLECTOR_RUNNING", "collector": collector_status()}), 409
        return jsonify({"ok": True, "collector": collector_status()}), 202

    @app.route("/healthz")
    def health() -> Any:
        legacy = reader.read_json("state")
        venus = reader.read_json("venus_psr", validator=venus_state_valid)
        legacy_available = legacy.current and legacy_state_valid(legacy.value)
        venus_available = venus.current and venus_state_valid(venus.value)

        def source_status(read: Any, available: bool) -> str:
            if available:
                return "available"
            return "invalid" if read.source else "unavailable"

        return jsonify(
            {
                "available": legacy_available or venus_available,
                "parser": "ready",
                "sources": {
                    "legacy": {
                        "available": legacy_available,
                        "source": source_status(legacy, legacy_available),
                    },
                    "venus_psr": {
                        "available": venus_available,
                        "source": source_status(venus, venus_available),
                    },
                },
            }
        )

    return app
