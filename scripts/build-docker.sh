#!/usr/bin/env sh
set -eu

COMPOSE_FILE="${1:-docker/docker-compose.audit.yml}"
docker compose -f "$COMPOSE_FILE" build
