#!/usr/bin/env bash
# Sobe um Postgres temporário, aplica a migração e roda os testes.
# Uso: bash tests/sql/run.sh
set -eo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
DADOS="$(mktemp -d)"
PORTA="${PORTA:-54329}"
export PGHOST="$DADOS" PGPORT="$PORTA" PGDATABASE=postgres

limpar() { "$PGBIN/pg_ctl" -D "$DADOS/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DADOS"; }
trap limpar EXIT

"$PGBIN/initdb" -D "$DADOS/db" -A trust -U postgres >/dev/null
"$PGBIN/pg_ctl" -D "$DADOS/db" -o "-k $DADOS -p $PORTA -c listen_addresses=''" -l "$DADOS/log" -w start >/dev/null
export PGUSER=postgres PGOPTIONS="-c client_min_messages=warning"

psql -q -v ON_ERROR_STOP=1 -f "$AQUI/supabase_stub.sql"
for m in "$RAIZ"/supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -f "$m"; done
echo "migrações aplicadas (e reaplicadas para checar idempotência):"
for m in "$RAIZ"/supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -f "$m" 2>&1 | grep -v NOTICE || true; done

PGOPTIONS="" psql -q -f "$AQUI/${TESTES:-testes.sql}" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  /' | grep -v '^$'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1

psql -q -c "update config set exigir_login = false"
echo
echo "── 5. CORRIDA: 12 clientes tentando o MESMO horário ao mesmo tempo ──"
ALVO=$(psql -Atc "select ((t.seg() + 2) + time '15:00') at time zone 'America/Sao_Paulo'")
for i in $(seq 1 12); do
  ( psql -Atq -c "set role anon; select criar_agendamento(jsonb_build_object('servicos','[\"corte-barba\"]'::jsonb,'profissional','danillo','inicio','$ALVO','nome','Corrida $i','telefone','6297000$(printf %04d $i)'))->>'codigo'" \
      >"$DADOS/r$i" 2>&1 || true ) &
done
wait
OK=$(grep -l "^NC" "$DADOS"/r* | wc -l || true)
NEG=$(grep -l 'HORARIO_INDISPONIVEL' "$DADOS"/r* | wc -l || true)
echo "  reservas aceitas: $OK | recusadas por conflito: $NEG"
[ "$OK" -eq 1 ] && [ "$NEG" -eq 11 ] && echo "ok  5a só uma reserva passou" || { echo "FALHOU 5a"; exit 1; }

echo "── 5b. CORRIDA com 'qualquer profissional': 6 clientes, 2 barbeiros ──"
ALVO2=$(psql -Atc "select ((t.seg() + 2) + time '17:00') at time zone 'America/Sao_Paulo'")
for i in $(seq 1 6); do
  ( psql -Atq -c "set role anon; select criar_agendamento(jsonb_build_object('servicos','[\"corte\"]'::jsonb,'inicio','$ALVO2','nome','Q $i','telefone','6296000$(printf %04d $i)'))->'profissional'->>'id'" \
      >"$DADOS/q$i" 2>&1 || true ) &
done
wait
OKQ=$(cat "$DADOS"/q* | grep -cE '^(danillo|andre)$' || true)
DIST=$(cat "$DADOS"/q* | grep -E '^(danillo|andre)$' | sort -u | wc -l || true)
echo "  aceitas: $OKQ (barbeiros distintos: $DIST)"
[ "$OKQ" -eq 2 ] && [ "$DIST" -eq 2 ] && echo "ok  5b cada barbeiro recebeu exatamente um" || { echo "FALHOU 5b"; exit 1; }
SOBREP=$(psql -Atc "select count(*) from agendamentos a join agendamentos b on a.id < b.id and a.profissional_id = b.profissional_id and a.ocupado && b.ocupado where a.status = 'confirmado' and b.status = 'confirmado'")
[ "$SOBREP" -eq 0 ] && echo "ok  5c nenhuma sobreposição no banco" || { echo "FALHOU 5c"; exit 1; }
