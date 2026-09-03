#!/bin/bash
set -e

# Post-merge setup — runs after every task merge.
# Must be idempotent and non-interactive.

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Initialising database schema..."
pnpm --filter @workspace/api-server run db:init

echo "Post-merge setup complete."
