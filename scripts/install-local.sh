#!/usr/bin/env sh
set -eu

TOOLS_DIR=".audit-tools"
INSTALL_PYTHON=0
INSTALL_NODE=0
INSTALL_RUST=0
INSTALL_GO=0
INSTALL_FOUNDRY=0

if [ "$#" -eq 0 ]; then
  INSTALL_PYTHON=1
  INSTALL_NODE=1
  INSTALL_RUST=1
  INSTALL_GO=1
  INSTALL_FOUNDRY=1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tools-dir)
      TOOLS_DIR="$2"
      shift 2
      ;;
    --all)
      INSTALL_PYTHON=1
      INSTALL_NODE=1
      INSTALL_RUST=1
      INSTALL_GO=1
      INSTALL_FOUNDRY=1
      shift
      ;;
    --python) INSTALL_PYTHON=1; shift ;;
    --node) INSTALL_NODE=1; shift ;;
    --rust) INSTALL_RUST=1; shift ;;
    --go) INSTALL_GO=1; shift ;;
    --foundry) INSTALL_FOUNDRY=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$TOOLS_DIR/bin" "$TOOLS_DIR/cache" "$TOOLS_DIR/node" "$TOOLS_DIR/cargo/bin" "$TOOLS_DIR/go/bin" "$TOOLS_DIR/foundry/bin"
mkdir -p "$TOOLS_DIR/venvs"

export AUDIT_TOOLS_DIR="$TOOLS_DIR"
export CARGO_HOME="$AUDIT_TOOLS_DIR/cargo"
export GOBIN="$AUDIT_TOOLS_DIR/go/bin"
export FOUNDRY_DIR="$AUDIT_TOOLS_DIR/foundry"
export npm_config_prefix="$AUDIT_TOOLS_DIR/node"
export PATH="$AUDIT_TOOLS_DIR/python/bin:$AUDIT_TOOLS_DIR/node/node_modules/.bin:$AUDIT_TOOLS_DIR/cargo/bin:$AUDIT_TOOLS_DIR/go/bin:$AUDIT_TOOLS_DIR/foundry/bin:$PATH"

run_optional() {
  name="$1"
  shift
  echo "==> $name"
  if ! "$@"; then
    echo "warning: $name failed" >&2
  fi
}

install_python_tool() {
  name="$1"
  package="$2"
  executable="$3"
  venv="$TOOLS_DIR/venvs/$name"
  run_optional "create venv $name" python -m venv "$venv"
  run_optional "upgrade pip $name" "$venv/bin/python" -m pip install --upgrade pip wheel setuptools
  run_optional "pip install $package" "$venv/bin/python" -m pip install --upgrade "$package"
  if [ -x "$venv/bin/$executable" ]; then
    cat > "$TOOLS_DIR/bin/$executable" <<EOF
#!/usr/bin/env sh
exec "$venv/bin/$executable" "\$@"
EOF
    chmod +x "$TOOLS_DIR/bin/$executable"
  else
    echo "warning: installed executable not found: $executable" >&2
  fi
}

if [ "$INSTALL_PYTHON" -eq 1 ]; then
  install_python_tool slither slither-analyzer slither
  install_python_tool semgrep semgrep semgrep
  install_python_tool mythril mythril myth
  install_python_tool manticore manticore manticore
  install_python_tool wake eth-wake wake
  install_python_tool halmos halmos halmos
  install_python_tool certora certora-cli certoraRun
  install_python_tool solc-select solc-select solc-select
fi

if [ "$INSTALL_NODE" -eq 1 ]; then
  for package in solhint eth-scribble @remix-project/remix-analyzer forta-agent; do
    run_optional "npm install $package" npm install --prefix "$TOOLS_DIR/node" "$package"
  done
fi

if [ "$INSTALL_RUST" -eq 1 ]; then
  for package in aderyn heimdall-rs; do
    run_optional "cargo install $package" cargo install --root "$TOOLS_DIR/cargo" "$package"
  done
fi

if [ "$INSTALL_GO" -eq 1 ]; then
  run_optional "go install medusa" go install github.com/crytic/medusa@latest
fi

if [ "$INSTALL_FOUNDRY" -eq 1 ]; then
  run_optional "install Foundry" sh -c 'curl -L https://foundry.paradigm.xyz | bash && foundryup'
fi

echo ""
echo "Project-local audit tools were installed under: $TOOLS_DIR"
echo "Activate them with: source $TOOLS_DIR/env.sh"
