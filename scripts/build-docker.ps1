param(
    [string]$ComposeFile = "docker/docker-compose.audit.yml"
)

$ErrorActionPreference = "Stop"
docker compose -f $ComposeFile build
