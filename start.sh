#!/usr/bin/env bash
# macOS / Linux 실행 스크립트
cd "$(dirname "$0")" || exit 1
NODE=node
[ -x "./node/bin/node" ] && NODE="./node/bin/node"
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "Node.js 가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  read -r -p "Enter 를 누르면 닫힙니다." _
  exit 1
fi
exec "$NODE" server.js
