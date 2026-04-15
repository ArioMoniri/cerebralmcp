#!/bin/bash
# CerebralMCP — Start all services

set -e

echo "========================================="
echo "  CerebralMCP — Pre-Visit AI Assistant"
echo "========================================="

# Check for .env
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
elif [ -f config/.env ]; then
    export $(grep -v '^#' config/.env | xargs)
fi

# Start backend
echo "[1/2] Starting backend API on :8000..."
cd "$(dirname "$0")"
uvicorn src.api.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir src/api --reload-dir src/mcp --reload-dir src/voice &
BACKEND_PID=$!

# Start frontend
echo "[2/2] Starting frontend on :3000..."
cd src/frontend
if [ ! -d node_modules ]; then
    echo "  Installing dependencies..."
    npm install
fi
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:3000"
echo "  API Docs: http://localhost:8000/docs"
echo ""
echo "  Press Ctrl+C to stop all services"

# Cleanup on exit
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
