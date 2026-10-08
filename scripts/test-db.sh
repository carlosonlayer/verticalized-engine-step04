#!/usr/bin/env bash
# Sobe um PostgreSQL 16 local e descartável para os testes de migração.
# Uso: bash scripts/test-db.sh up|down
# Depois do "up": export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DATA_DIR="${TEST_PG_DATA:-/tmp/verticalized-test-pg}"
PORT="${TEST_PG_PORT:-54329}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then RUN_AS=(runuser -u postgres --); fi

case "${1:-up}" in
  up)
    if [ ! -d "$DATA_DIR" ]; then
      mkdir -p "$DATA_DIR"
      [ "$(id -u)" = "0" ] && chown postgres:postgres "$DATA_DIR"
      "${RUN_AS[@]}" "$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --auth=trust >/dev/null
    fi
    "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA_DIR/log.txt" -w start >/dev/null
    echo "postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  down)
    "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast stop >/dev/null || true
    rm -rf "$DATA_DIR"
    ;;
  *)
    echo "uso: $0 up|down" >&2; exit 1 ;;
esac
