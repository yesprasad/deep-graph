#!/bin/sh
set -e

# deep-graph installer
# Usage: curl -fsSL https://raw.githubusercontent.com/yesprasad/deep-graph/main/install.sh | sh

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo "${CYAN}${BOLD}  deep-graph${RESET} — compiler-aware dependency graph for TypeScript"
echo ""

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "${RED}Error: Node.js is required but not installed.${RESET}"
  echo "Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "${RED}Error: Node.js 18+ required (found v$(node -v | sed 's/v//'))${RESET}"
  echo "Upgrade from https://nodejs.org"
  exit 1
fi

# Check npm
if ! command -v npm >/dev/null 2>&1; then
  echo "${RED}Error: npm is required but not found.${RESET}"
  exit 1
fi

echo "  Installing @yesprasad/deep-graph globally..."
echo ""

npm install -g @yesprasad/deep-graph

echo ""
echo "${GREEN}${BOLD}  Installed successfully.${RESET}"
echo ""
echo "  Commands:"
echo "    ${CYAN}deep-graph analyze${RESET}        Extract dependency graph"
echo "    ${CYAN}deep-graph blast <target>${RESET}  What breaks if you change this?"
echo "    ${CYAN}deep-graph unused${RESET}         Find dead exports"
echo "    ${CYAN}deep-graph mcp-init${RESET}       Set up MCP server for AI tools"
echo ""
echo "  Run ${CYAN}deep-graph mcp-init${RESET} in your project to connect"
echo "  Claude Code, Copilot, Cursor, or CodeRabbit."
echo ""
