#!/bin/bash
set -e
docker compose config 1>/dev/null
cleanup() {
    echo -e "Shutting down..."
    docker compose down
    exit 130
}
trap cleanup SIGINT
echo "Starting..."
docker compose up --build 2>&1 | grep --line-buffered 'ams-api'
