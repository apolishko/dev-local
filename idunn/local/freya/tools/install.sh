#!/bin/bash

if [ "$1" = "--clean" ]; then
  sudo rm -rf node_modules package-lock.json
fi

docker compose run --rm api npm install
