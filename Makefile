.DEFAULT_GOAL := help
PYTHON ?= python3
VENV := .setup/testnet-venv
PY := $(VENV)/bin/python
DEPS := $(VENV)/.requirements-installed
FORGE ?= $(if $(wildcard .setup/foundry-bin/forge),.setup/foundry-bin/forge,forge)

.PHONY: help setup start stop status logs test verify verify-tbill verify-sources seed-demo
help:
	@echo "make start   Run Atlas in this terminal (checks every 60s, Ctrl-C to stop)"
	@echo "make stop    Gracefully stop the relay"
	@echo "make status  Show worker state and last completed check"
	@echo "make megafuel-status   Read testnet sponsor credit and expiry"
	@echo "make megafuel-extend UNTIL=...   Extend expiry (date with UTC offset)"
	@echo "make logs    Show the last 25 worker log lines"
	@echo "make setup   Install Python dependencies and contract submodules"
	@echo "make test    Run Foundry, the frozen ABI checks and Python tests"
	@echo "make verify  Replay payment, swap and T-bill transactions (read-only)"
	@echo "make verify-tbill  Replay the T-bill deposit, withdrawal and payout (read-only)"
	@echo "make verify-sources  Check the eight published BscScan sources (read-only)"
	@echo "make seed-demo  Prepare the three BSC testnet payees and simulate the payroll"

$(PY):
	$(PYTHON) -m venv "$(VENV)"

$(DEPS): scripts/requirements-testnet.txt $(PY)
	"$(PY)" -m pip --disable-pip-version-check install -r scripts/requirements-testnet.txt
	@touch "$@"

setup: $(DEPS)
	git submodule update --init --recursive

start: $(DEPS)
	@exec "$(PYTHON)" scripts/relayctl.py start

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

verify: $(DEPS) verify-tbill
	"$(PY)" scripts/check-testnet.py --nodereal
	"$(PY)" scripts/check_atlas_swap.py

verify-tbill: $(DEPS)
	"$(PY)" scripts/check_tbill.py

seed-demo: $(DEPS)
	"$(PY)" scripts/seed_demo.py

verify-sources: $(DEPS)
	"$(FORGE)" build --quiet --root contracts
	"$(PY)" scripts/verify-testnet.py --check

.PHONY: megafuel-status megafuel-extend
megafuel-status: $(DEPS)
	@"$(PY)" scripts/megafuel.py

megafuel-extend: export MEGAFUEL_UNTIL := $(value UNTIL)
megafuel-extend: $(DEPS)
	@"$(PY)" scripts/megafuel.py --until "$$MEGAFUEL_UNTIL"
