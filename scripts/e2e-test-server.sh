#!/bin/bash

set -e

# Set NODE_ENV to test so Next.js loads .env.test instead of .env.development
export NODE_ENV=${NODE_ENV:-test}

set -o allexport
source .env.test
if [ "$CI" != "true" ] && [ -f ".env.test.local" ]; then
  source .env.test.local
fi
set +o allexport

if [ "$CI" = "true" ]; then
  export PLAYWRIGHT_USE_PREBUILT=1
fi

function kill_process_listening_on_port {
  lsof -i :$1 | grep LISTEN | awk '{print $2}' | xargs -r kill -9
}

echo "Starting application services"

kill_process_listening_on_port 3020

export NODE_TLS_REJECT_UNAUTHORIZED=0

if [ "$PLAYWRIGHT_USE_PREBUILT" = "1" ]; then 
  echo "📦 Mode: Production build (pnpm with-test-env next start -p 3020)"
  pnpm with-test-env next start -p 3020
  else 
  echo "⚡ Mode: Development server (pnpm with-test-env next dev -p 3020 --turbopack)"
  pnpm with-test-env next dev -p 3020 --turbopack
fi
