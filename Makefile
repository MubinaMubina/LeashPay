.DEFAULT_GOAL := help
PYTHON ?= python3
VENV := .setup/testnet-venv
PY := $(VENV)/bin/python
DEPS := $(VENV)/.requirements-installed
FORGE ?= $(if $(wildcard .setup/foundry-bin/forge),.setup/foundry-bin/forge,forge)

.PHONY: help setup start stop status logs test verify
help:
	@echo "make start   Start the local Atlas relay (60s polling)"
	@echo "make stop    Gracefully stop the relay"
	@echo "make status  Show worker state and last completed check"
	@echo "make logs    Show the last 25 worker log lines"
	@echo "make setup   Install Python dependencies and contract submodules"
	@echo "make test    Run Foundry, the frozen ABI checks and Python tests"
	@echo "make verify  Replay both recorded testnet proofs (read-only)"

$(PY):
	$(PYTHON) -m venv "$(VENV)"

$(DEPS): scripts/requirements-testnet.txt $(PY)
	"$(PY)" -m pip --disable-pip-version-check install -r scripts/requirements-testnet.txt
	@touch "$@"

setup: $(DEPS)
	git submodule update --init --recursive

start: $(DEPS)
	@$(PYTHON) scripts/relayctl.py start

stop status:
	@$(PYTHON) scripts/relayctl.py $@

logs:
	@if test -f .setup/atlas-worker.log; then tail -n 25 .setup/atlas-worker.log; else echo "No relay log yet."; fi

test: $(DEPS)
	"$(FORGE)" fmt --root contracts --check
	"$(FORGE)" test --root contracts
	node scripts/abi-signatures.mjs --check contracts/abi/frozen-signatures.txt \
	  ILeashVault=contracts/out/LeashVault.sol/LeashVault.json \
	  ILeashVaultFactory=contracts/out/LeashVaultFactory.sol/LeashVaultFactory.json \
	  IPriceFeed=contracts/out/AtlasRelayFeed.sol/AtlasRelayFeed.json \
	  IFaucetToken=contracts/out/MockToken.sol/MockToken.json
	"$(PY)" -m unittest discover -s scripts -p 'test_*.py'

verify: $(DEPS)
	"$(PY)" scripts/check-testnet.py --nodereal
	"$(PY)" scripts/check_atlas_swap.py
