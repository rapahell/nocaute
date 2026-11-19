#!/usr/bin/env bash
# Teste de ponta a ponta do MODO SUPABASE, sem precisar de conta no Supabase:
# Postgres local + PostgREST + página no navegador.
# Requisitos: Postgres 15+, PostgREST (POSTGREST=/caminho/binario), Node, Python com Playwright.
set -eo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
POSTGREST="${POSTGREST:-postgrest}"
DADOS="$(mktemp -d)"; chmod 777 "$DADOS"
SEGREDO='segredo-de-teste-local-com-mais-de-32-caracteres'
PIDS=()

como_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
limpar() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  como_pg "'$PGBIN/pg_ctl' -D '$DADOS/db' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$DADOS"
}
trap limpar EXIT

jwt() { python3 - "$SEGREDO" "$@" <<'PY'
import sys, json, hmac, hashlib, base64, time
b = lambda d: base64.urlsafe_b64encode(d).rstrip(b'=').decode()
seg, role = sys.argv[1], sys.argv[2]
claims = {"role": role, "iss": "teste", "exp": int(time.time()) + 3600}
if len(sys.argv) > 4: claims.update({"sub": sys.argv[3], "email": sys.argv[4]})
h = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
p = b(json.dumps(claims).encode())
s = b(hmac.new(seg.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
print(f"{h}.{p}.{s}")
PY
}
ANON=$(jwt anon); SERVICE=$(jwt service_role)
# cliente logado (no ar, quem emite é o Supabase Auth depois do Google ou do código no e-mail)
USUARIO=$(jwt authenticated 77777777-7777-7777-7777-777777777777 cliente.e2e@gmail.com)
DONO=$(jwt authenticated 88888888-8888-8888-8888-888888888888 dono@nocaute.com)

como_pg "'$PGBIN/initdb' -D '$DADOS/db' -A trust -U postgres >/dev/null"
como_pg "'$PGBIN/pg_ctl' -D '$DADOS/db' -o \"-k $DADOS -p 54330 -c listen_addresses=127.0.0.1\" -l '$DADOS/pg.log' -w start >/dev/null"
export PGHOST=127.0.0.1 PGPORT=54330 PGUSER=postgres PGDATABASE=postgres PGOPTIONS="-c client_min_messages=warning"
psql -q -v ON_ERROR_STOP=1 -f "$RAIZ/tests/sql/supabase_stub.sql"
for m in "$RAIZ"/supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -f "$m"; done
psql -q -v ON_ERROR_STOP=1 <<'SQL'
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
insert into admins (user_id, papel) values ('88888888-8888-8888-8888-888888888888', 'dono');
-- segundo barbeiro, como o dono cadastraria pelo painel
insert into profissionais (id, nome, cargo, ordem) values ('andre', 'André Luiz', 'Barbeiro', 2);
insert into jornadas (profissional_id, dia_semana, inicio, fim) select 'andre', dia_semana, abre, fecha from horarios_funcionamento;
SQL
echo "banco pronto"

PGRST_DB_URI="postgres://authenticator@127.0.0.1:54330/postgres" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$SEGREDO" PGRST_SERVER_PORT=3010 "$POSTGREST" >"$DADOS/pgrst.log" 2>&1 & PIDS+=($!)
node "$AQUI/proxy.mjs" 54321 3010 "" & PIDS+=($!)
python3 -m http.server 8090 --bind 127.0.0.1 --directory "$RAIZ" >/dev/null 2>&1 & PIDS+=($!)

for i in $(seq 1 60); do
  curl -s -o /dev/null http://127.0.0.1:3010/ && curl -s -o /dev/null http://127.0.0.1:8090/ && break
  sleep 1
done
echo "PostgREST e proxy no ar"

if [ -n "$DEPURAR" ]; then curl -s -i http://127.0.0.1:54321/rest/v1/servicos?select=id -H "Authorization: Bearer $ANON" | head -12; fi
SUPA_URL=http://127.0.0.1:54321 SUPA_ANON="$ANON" SUPA_USUARIO="$USUARIO" SUPA_DONO="$DONO" \
  python3 "$AQUI/e2e_ui.py" "${1:-/tmp}" || { echo "--- logs ---"; tail -n 20 "$DADOS/pgrst.log"; exit 1; }

echo "── conferência no banco ──"
psql -At -c "select status, count(*) from agendamentos group by 1 order by 1"
psql -At -c "select p.nome, a.status, a.ciclo_fim from assinaturas a join planos p on p.id = a.plano_id"
psql -At -c "select id, preco_centavos from servicos where id = 'corte'"
