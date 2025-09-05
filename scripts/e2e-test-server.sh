#!/bin/bash

set -e

function kill_process_listening_on_port {
  lsof -i :$1 | grep LISTEN | awk '{print $2}' | xargs -r kill -9
}

echo "Starting application services"

kill_process_listening_on_port 3020

export NODE_TLS_REJECT_UNAUTHORIZED=0

pnpm with-test-env next start -p 3020
