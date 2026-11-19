-- ════════════════════════════════════════════════════════════════════
--  Barbearia Nocaute · Agendamento online + painel
--  Supabase (Postgres 15+). Rodar uma vez no SQL Editor ou pela CLI.
--  Pode ser rodada de novo sem perder dados.
--
--  Sem pagamento pelo site: o cliente paga na barbearia.
--  Princípios:
--   • Toda regra de horário e reserva roda AQUI, no servidor.
--   • Conflito de horário: trava por dia + restrição EXCLUDE no banco.
--   • O navegador só lê o catálogo e chama funções específicas.
--   • Preços, serviços, planos, horários e equipe são editados pelo
--     painel (funções admin_*), sem mexer em código.
-- ════════════════════════════════════════════════════════════════════

-- No Supabase as extensões ficam no schema "extensions"; por isso as funções usam
-- search_path = public, extensions (sem isso, gen_random_bytes e digest não são encontrados).
create extension if not exists btree_gist;
create extension if not exists pgcrypto;

do $$ begin
  create type status_agendamento as enum ('confirmado','cancelado','concluido','nao_compareceu');
exception when duplicate_object then null; end $$;
do $$ begin
  create type status_assinatura as enum ('pendente','ativa','inadimplente','cancelada','expirada');
exception when duplicate_object then null; end $$;

-- ───────────────────────── REGRAS DA BARBEARIA ─────────────────────────
create table if not exists config (
  id                           int primary key default 1 check (id = 1),
  fuso                         text    not null default 'America/Sao_Paulo',
  antecedencia_min             int     not null default 60  check (antecedencia_min between 0 and 1440),
  passo_min                    int     not null default 30  check (passo_min between 5 and 120),
  intervalo_entre_min          int     not null default 0   check (intervalo_entre_min between 0 and 120),
  janela_dias                  int     not null default 30  check (janela_dias between 1 and 120),
  cancelamento_antecedencia_h  int     not null default 2   check (cancelamento_antecedencia_h between 0 and 72),
  duracao_padrao_min           int     not null default 30  check (duracao_padrao_min between 5 and 480),
  exigir_login                 boolean not null default true,
  politica_cancelamento        text,
  atualizado_em                timestamptz not null default now()
);

-- ───────────────────────── CATÁLOGO ─────────────────────────
create table if not exists servicos (
  id               text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  nome             text not null check (length(btrim(nome)) between 2 and 80),
  descricao        text,
  categoria        text not null,
  preco_centavos   int  check (preco_centavos >= 0),      -- null = a confirmar
  preco_a_partir   boolean not null default false,        -- "a partir de R$ X"
  duracao_min      int  check (duracao_min between 5 and 480),
  componentes      text[] not null default '{}',          -- o que um combo já inclui
  imagem_url       text,
  ativo            boolean not null default true,
  agendavel_online boolean not null default true,
  ordem            int not null default 0
);

create table if not exists profissionais (
  id             text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  nome           text not null,
  foto_url       text,
  especialidades text[] not null default '{}',
  ativo          boolean not null default true,
  ordem          int not null default 0
);

create table if not exists horarios_funcionamento (
  dia_semana int primary key check (dia_semana between 0 and 6),   -- 0 = domingo
  abre  time not null,
  fecha time not null,
  check (fecha > abre)
);

-- jornada de cada barbeiro (duas linhas no mesmo dia = pausa no meio)
create table if not exists jornadas (
  id              bigserial primary key,
  profissional_id text not null references profissionais on delete cascade,
  dia_semana      int  not null check (dia_semana between 0 and 6),
  inicio          time not null,
  fim             time not null,
  check (fim > inicio)
);
create index if not exists jornadas_prof_dia on jornadas (profissional_id, dia_semana);

-- folgas, férias, almoço avulso. profissional_id null = barbearia inteira
create table if not exists bloqueios (
  id              bigserial primary key,
  profissional_id text references profissionais on delete cascade,
  periodo         tstzrange not null,
  motivo          text,
  origem          text not null default 'manual',
  criado_por      uuid,
  criado_em       timestamptz not null default now()
);
create index if not exists bloqueios_periodo on bloqueios using gist (periodo);

-- ───────────────────────── CLIENTES E AGENDAMENTOS ─────────────────────────
create table if not exists clientes (
  id               uuid primary key default gen_random_uuid(),
  nome             text not null,
  telefone         text not null unique check (telefone ~ '^[0-9]{10,11}$'),
  email            text,
  user_id          uuid unique,
  consentimento_em timestamptz not null default now(),
  criado_em        timestamptz not null default now()
);

create table if not exists agendamentos (
  id                   uuid primary key default gen_random_uuid(),
  codigo               text not null unique,
  cliente_id           uuid not null references clientes,
  nome_cliente         text not null,
  profissional_id      text not null references profissionais,
  inicio               timestamptz not null,
  fim                  timestamptz not null,
  ocupado              tstzrange not null,    -- [inicio, fim + intervalo entre atendimentos)
  status               status_agendamento not null default 'confirmado',
  valor_bruto_centavos int  not null default 0,
  desconto_centavos    int  not null default 0,
  valor_total_centavos int  not null default 0,
  valor_a_confirmar    boolean not null default false,
  valor_a_partir       boolean not null default false,
  token_hash           text not null,
  assinatura_id        uuid,
  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now(),
  cancelado_em         timestamptz,
  motivo_cancelamento  text,
  check (fim > inicio),
  -- GARANTIA FINAL: nenhum barbeiro com dois atendimentos sobrepostos
  constraint agendamentos_sem_conflito exclude using gist (
    profissional_id with =, ocupado with &&
  ) where (status = 'confirmado')
);
create index if not exists agendamentos_inicio on agendamentos (inicio);
create index if not exists agendamentos_cliente on agendamentos (cliente_id);

create table if not exists agendamento_itens (
  agendamento_id uuid not null references agendamentos on delete cascade,
  servico_id     text not null references servicos,
  nome           text not null,
  preco_centavos int,
  duracao_min    int not null,
  coberto_plano  boolean not null default false,
  primary key (agendamento_id, servico_id)
);

-- ───────────────────────── PLANOS E ASSINATURAS ─────────────────────────
-- Pagamento do plano é na barbearia; quem ativa e renova é o painel.
create table if not exists planos (
  id                     text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  nome                   text not null,
  descricao              text,
  preco_centavos         int  not null check (preco_centavos > 0),
  periodicidade          text not null default 'mensal' check (periodicidade in ('mensal')),
  limite_usos_ciclo      int  check (limite_usos_ciclo > 0),   -- null = sem limite total
  regras                 text,
  vigencia_meses         int  check (vigencia_meses > 0),
  renovacao              text,
  cancelamento           text,
  restricoes             jsonb not null default '{}',          -- {"dias_semana":[1,2,3]}
  termos_versao          int  not null default 1,
  ativo                  boolean not null default true,
  disponivel_contratacao boolean not null default true,
  ordem                  int not null default 0
);

create table if not exists plano_servicos (
  plano_id         text not null references planos on delete cascade,
  servico_id       text not null references servicos,
  limite_por_ciclo int check (limite_por_ciclo > 0),           -- null = sem limite
  primary key (plano_id, servico_id)
);

create table if not exists assinaturas (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references clientes,
  plano_id        text not null references planos,
  status          status_assinatura not null default 'pendente',
  termos_versao   int not null,
  aceite_em       timestamptz not null,
  criada_em       timestamptz not null default now(),
  inicio          date,
  ciclo_inicio    date,
  ciclo_fim       date,
  cancelada_em    timestamptz
);
create unique index if not exists assinatura_unica_viva on assinaturas (cliente_id, plano_id)
  where status in ('pendente','ativa','inadimplente');

create table if not exists utilizacoes (
  id             bigserial primary key,
  assinatura_id  uuid not null references assinaturas,
  agendamento_id uuid not null references agendamentos,
  servico_id     text not null references servicos,
  ciclo_inicio   date not null,
  estornada      boolean not null default false,
  criado_em      timestamptz not null default now(),
  unique (agendamento_id, servico_id)
);

-- ── colunas acrescentadas depois (rodar o arquivo de novo atualiza bancos antigos) ──
alter table config add column if not exists max_faltas int not null default 2 check (max_faltas between 0 and 10);  -- 0 = desligado
alter table clientes add column if not exists faltas_zeradas_em timestamptz;
alter table agendamentos add column if not exists cancelado_por text check (cancelado_por in ('cliente','barbearia'));
-- plano pago por link de pagamento no cartão (Stone); recorrente = a cobrança mensal é automática
alter table planos add column if not exists link_pagamento text check (link_pagamento ~ '^https://');
alter table planos add column if not exists cobranca_recorrente boolean not null default false;
alter table assinaturas add column if not exists renova_sozinho boolean not null default false;
-- cargo mostrado no site institucional, embaixo do nome do barbeiro
alter table profissionais add column if not exists cargo text not null default 'Barbeiro';
update agendamentos set cancelado_por = case when motivo_cancelamento ilike '%cliente%' then 'cliente' else 'barbearia' end
 where status = 'cancelado' and cancelado_por is null;

-- ───────────────────────── REGISTRO E ACESSOS ─────────────────────────
create table if not exists historico (
  id          bigserial primary key,
  entidade    text not null,
  entidade_id text not null,
  acao        text not null,
  dados       jsonb not null default '{}',
  ator        text not null,
  criado_em   timestamptz not null default now()
);
create index if not exists historico_entidade on historico (entidade, entidade_id);

create table if not exists admins (
  user_id         uuid primary key,
  papel           text not null check (papel in ('dono','recepcao','barbeiro')),
  profissional_id text references profissionais on delete set null,
  email           text,
  criado_em       timestamptz not null default now()
);


-- ════════════════════════════════════════════════════════════════════
--  FUNÇÕES INTERNAS
-- ════════════════════════════════════════════════════════════════════
create or replace function _cfg() returns config
language sql stable security definer set search_path = public, extensions as $$ select * from config where id = 1 $$;

create or replace function _ator() returns text
language sql stable as $$ select coalesce(auth.uid()::text, 'sistema') $$;

create or replace function _log(p_ent text, p_id text, p_acao text, p_dados jsonb default '{}') returns void
language sql security definer set search_path = public, extensions as $$
  insert into historico (entidade, entidade_id, acao, dados, ator)
  values (p_ent, p_id, p_acao, coalesce(p_dados, '{}'), _ator());
$$;

create or replace function _hash(p text) returns text
language sql immutable set search_path = public, extensions as $$ select encode(digest(coalesce(p, ''), 'sha256'), 'hex') $$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from admins where user_id = auth.uid())
$$;

create or replace function _hoje() returns date
language sql stable security definer set search_path = public, extensions as $$ select (now() at time zone (_cfg()).fuso)::date $$;

-- assinatura com ciclo vencido e sem renovação
create or replace function atualizar_assinaturas() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v_hoje date := _hoje(); v_n int := 0; v_k int;
begin
  -- cobrança recorrente no cartão: o mês vira sozinho até a barbearia cancelar
  loop
    update assinaturas set ciclo_inicio = ciclo_fim + 1, ciclo_fim = (ciclo_fim + 1 + interval '1 month' - interval '1 day')::date
     where status = 'ativa' and renova_sozinho and ciclo_fim < v_hoje;
    get diagnostics v_k = row_count;
    exit when v_k = 0;
    v_n := v_n + v_k;
  end loop;
  update assinaturas set status = 'inadimplente' where status = 'ativa' and ciclo_fim < v_hoje;
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  update assinaturas set status = 'expirada' where status = 'inadimplente' and ciclo_fim < v_hoje - 30;
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  return v_n;
end $$;

-- valida a combinação de serviços e devolve duração e preço somados
create or replace function _validar_servicos(p_servicos text[], out duracao int, out preco int,
                                             out a_confirmar boolean, out a_partir boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_cfg config := _cfg(); v_ok int;
begin
  if p_servicos is null or cardinality(p_servicos) = 0 then raise exception 'SERVICO_OBRIGATORIO'; end if;
  if cardinality(p_servicos) > 4 then raise exception 'SERVICOS_DEMAIS'; end if;
  if (select count(distinct x) from unnest(p_servicos) x) <> cardinality(p_servicos) then raise exception 'SERVICO_REPETIDO'; end if;
  select count(*) into v_ok from servicos where id = any(p_servicos) and ativo and agendavel_online;
  if v_ok <> cardinality(p_servicos) then raise exception 'SERVICO_INDISPONIVEL'; end if;
  -- combo + item que ele já inclui, ou dois combos com item em comum
  if exists (
    select 1 from servicos a join servicos b on a.id < b.id
     where a.id = any(p_servicos) and b.id = any(p_servicos)
       and (a.id = any(b.componentes) or b.id = any(a.componentes) or a.componentes && b.componentes)
  ) then raise exception 'COMBINACAO_INVALIDA'; end if;
  select sum(coalesce(s.duracao_min, v_cfg.duracao_padrao_min))::int, coalesce(sum(s.preco_centavos), 0)::int,
         bool_or(s.preco_centavos is null), bool_or(s.preco_a_partir)
    into duracao, preco, a_confirmar, a_partir
    from servicos s where s.id = any(p_servicos);
end $$;

-- o horário cabe na jornada, no funcionamento e não colide com nada?
create or replace function _slot_livre(p_prof text, p_inicio timestamptz, p_dur int) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  c          config    := _cfg();
  v_local    timestamp := p_inicio at time zone c.fuso;
  v_dia      date      := v_local::date;
  v_dow      int       := extract(dow from v_local)::int;
  v_ini      time      := v_local::time;
  v_fim_loc  timestamp := v_local + make_interval(mins => p_dur);
  v_ocupado  tstzrange := tstzrange(p_inicio, p_inicio + make_interval(mins => p_dur + c.intervalo_entre_min), '[)');
begin
  if p_inicio < now() + make_interval(mins => c.antecedencia_min) then return false; end if;
  if v_dia > _hoje() + c.janela_dias then return false; end if;
  if v_fim_loc::date <> v_dia then return false; end if;
  if not exists (select 1 from profissionais where id = p_prof and ativo) then return false; end if;
  if not exists (select 1 from horarios_funcionamento h
                  where h.dia_semana = v_dow and v_ini >= h.abre and v_fim_loc::time <= h.fecha) then return false; end if;
  -- o horário precisa cair na grade da jornada (ex.: 08:30, 09:00, 09:30...)
  if not exists (select 1 from jornadas j
                  where j.profissional_id = p_prof and j.dia_semana = v_dow
                    and v_ini >= j.inicio and v_fim_loc::time <= j.fim
                    and (extract(epoch from (v_ini - j.inicio)) / 60)::int % c.passo_min = 0
                    and extract(second from v_ini) = 0) then return false; end if;
  if exists (select 1 from bloqueios b
              where (b.profissional_id is null or b.profissional_id = p_prof)
                and b.periodo && tstzrange(p_inicio, p_inicio + make_interval(mins => p_dur), '[)')) then return false; end if;
  if exists (select 1 from agendamentos a
              where a.profissional_id = p_prof and a.status = 'confirmado' and a.ocupado && v_ocupado) then return false; end if;
  return true;
end $$;

create or replace function _gerar_codigo() returns text
language plpgsql set search_path = public, extensions as $$
declare v_alfa text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; v_b bytea; v_out text; i int;
begin
  loop
    v_b := gen_random_bytes(6); v_out := 'NC';
    for i in 0..5 loop v_out := v_out || substr(v_alfa, (get_byte(v_b, i) % length(v_alfa)) + 1, 1); end loop;
    exit when not exists (select 1 from agendamentos where codigo = v_out);
  end loop;
  return v_out;
end $$;

-- representação pública de um agendamento (sem telefone/e-mail)
create or replace function _ag_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'codigo', a.codigo, 'status', a.status, 'inicio', a.inicio, 'fim', a.fim,
    'profissional', jsonb_build_object('id', p.id, 'nome', p.nome),
    'nome_cliente', a.nome_cliente,
    'itens', (select jsonb_agg(jsonb_build_object('id', i.servico_id, 'nome', i.nome, 'preco_centavos', i.preco_centavos,
                                                  'duracao_min', i.duracao_min, 'coberto_plano', i.coberto_plano) order by i.nome)
                from agendamento_itens i where i.agendamento_id = a.id),
    'valor_bruto_centavos', a.valor_bruto_centavos, 'desconto_centavos', a.desconto_centavos,
    'valor_total_centavos', a.valor_total_centavos, 'valor_a_confirmar', a.valor_a_confirmar, 'valor_a_partir', a.valor_a_partir,
    'coberto_plano', a.assinatura_id is not null,
    'pode_cancelar', a.status = 'confirmado'
                     and a.inicio - now() >= make_interval(hours => (_cfg()).cancelamento_antecedencia_h)
  )
  from agendamentos a join profissionais p on p.id = a.profissional_id
  where a.id = p_id
$$;

-- cliente logado (e-mail confirmado pelo Supabase Auth)
create or replace function _cliente_logado() returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  if auth.uid() is null then raise exception 'LOGIN_NECESSARIO'; end if;
  select id into v from clientes where user_id = auth.uid();
  if v is null and auth.email() is not null then
    -- vincula cadastro antigo com o mesmo e-mail
    update clientes set user_id = auth.uid()
     where id = (select id from clientes where lower(email) = lower(auth.email()) and user_id is null order by criado_em limit 1)
    returning id into v;
  end if;
  return v;
end $$;

-- ════════════════════════════════════════════════════════════════════
--  SITE (RPC públicas)
-- ════════════════════════════════════════════════════════════════════
create or replace function disponibilidade(p_data date, p_servicos text[], p_profissional text default null)
returns table (horario timestamptz, profissionais_livres text[])
language plpgsql security definer set search_path = public, extensions as $$
declare c config := _cfg(); v_dur int;
begin
  select s.duracao into v_dur from _validar_servicos(p_servicos) s;
  return query
  with slots as (
    select distinct (g at time zone c.fuso) as t
      from jornadas j
      cross join lateral generate_series(p_data + j.inicio, p_data + j.fim - make_interval(mins => v_dur),
                                         make_interval(mins => c.passo_min)) g
     where j.dia_semana = extract(dow from p_data)::int
       and j.fim - j.inicio >= make_interval(mins => v_dur)
       and (p_profissional is null or j.profissional_id = p_profissional)
  )
  select s.t, array_agg(p.id order by p.ordem)
    from slots s cross join profissionais p
   where p.ativo and (p_profissional is null or p.id = p_profissional) and _slot_livre(p.id, s.t, v_dur)
   group by s.t order by s.t;
end $$;

create or replace function dias_disponiveis(p_de date, p_ate date, p_servicos text[], p_profissional text default null)
returns setof date
language plpgsql security definer set search_path = public, extensions as $$
declare d date;
begin
  if p_ate - p_de > 62 then raise exception 'PERIODO_LONGO'; end if;
  perform _validar_servicos(p_servicos);
  for d in select generate_series(p_de, p_ate, interval '1 day')::date loop
    if exists (select 1 from disponibilidade(d, p_servicos, p_profissional)) then return next d; end if;
  end loop;
end $$;

-- faltas que contam para a regra: últimos 6 meses, depois da última vez que a barbearia zerou
create or replace function _faltas(p_cli uuid) returns int
language sql stable security definer set search_path = public, extensions as $$
  select count(*)::int from agendamentos a join clientes c on c.id = a.cliente_id
   where a.cliente_id = p_cli and a.status = 'nao_compareceu'
     and a.inicio > now() - interval '180 days'
     and a.atualizado_em > coalesce(c.faltas_zeradas_em, '-infinity')   -- falta registrada depois de zerar
$$;

create or replace function criar_agendamento(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c          config := _cfg();
  v_servicos text[] := case when jsonb_typeof(p->'servicos') = 'array'
                             then array(select jsonb_array_elements_text(p->'servicos')) else '{}' end;
  v_prof     text   := nullif(p->>'profissional', '');
  v_inicio   timestamptz;
  v_nome     text   := btrim(coalesce(p->>'nome', ''));
  v_tel      text   := regexp_replace(coalesce(p->>'telefone', ''), '\D', '', 'g');
  v_dur int; v_preco int; v_conf boolean; v_apartir boolean;
  v_escolhido text; v_cli uuid; v_ag uuid; v_token text;
  v_desc int := 0; v_ass assinaturas; v_plano planos; v_cobertos text[] := '{}';
  v_total int; v_dia date; v_usos int; v_usos_srv int; v_existente uuid;
  r record;
begin
  begin v_inicio := (p->>'inicio')::timestamptz;
  exception when others then raise exception 'HORARIO_INVALIDO'; end;
  if v_inicio is null then raise exception 'HORARIO_OBRIGATORIO'; end if;

  if auth.uid() is not null then
    v_cli := _cliente_logado();
    if v_cli is null then raise exception 'PERFIL_INCOMPLETO'; end if;
    select nome into v_nome from clientes where id = v_cli;
  else
    if c.exigir_login then raise exception 'LOGIN_NECESSARIO'; end if;
    if length(v_nome) < 2 or length(v_nome) > 120 then raise exception 'NOME_INVALIDO'; end if;
    if v_tel !~ '^[1-9][0-9]{9,10}$' then raise exception 'TELEFONE_INVALIDO'; end if;
  end if;

  -- quem faltou demais nos últimos 6 meses marca pelo WhatsApp (o dono pode zerar no painel)
  v_existente := coalesce(v_cli, (select id from clientes where telefone = v_tel));
  if c.max_faltas > 0 and v_existente is not null and _faltas(v_existente) >= c.max_faltas then
    raise exception 'MUITAS_FALTAS';
  end if;

  select s.duracao, s.preco, s.a_confirmar, s.a_partir into v_dur, v_preco, v_conf, v_apartir from _validar_servicos(v_servicos) s;
  v_dia := (v_inicio at time zone c.fuso)::date;

  -- serializa reservas do mesmo dia: duas pessoas no mesmo segundo não passam juntas
  perform pg_advisory_xact_lock(hashtext('nocaute.agenda'), hashtext(v_dia::text));

  -- escolhe o barbeiro (ou o menos ocupado no dia, se "qualquer um")
  for r in
    select p2.id from profissionais p2
     where p2.ativo and (v_prof is null or p2.id = v_prof)
     order by (select count(*) from agendamentos a where a.profissional_id = p2.id and a.status = 'confirmado'
                and (a.inicio at time zone c.fuso)::date = v_dia), p2.ordem
  loop
    if _slot_livre(r.id, v_inicio, v_dur) then v_escolhido := r.id; exit; end if;
  end loop;
  if v_escolhido is null then raise exception 'HORARIO_INDISPONIVEL'; end if;

  if v_cli is null then
    insert into clientes (nome, telefone) values (v_nome, v_tel)
    on conflict (telefone) do update set nome = clientes.nome
    returning id into v_cli;
  end if;

  -- benefício de plano ativo (só com conta: telefone sozinho não prova identidade)
  if auth.uid() is not null then
    select a.* into v_ass from assinaturas a
     where a.cliente_id = v_cli and a.status = 'ativa' and v_dia between a.ciclo_inicio and a.ciclo_fim
     order by a.criada_em limit 1 for update;
    if v_ass.id is not null then
      select * into v_plano from planos where id = v_ass.plano_id;
      if (v_plano.restricoes->'dias_semana' is null or jsonb_array_length(v_plano.restricoes->'dias_semana') = 0
            or v_plano.restricoes->'dias_semana' @> to_jsonb(extract(dow from v_inicio at time zone c.fuso)::int))
      then
        select count(*) into v_usos from utilizacoes where assinatura_id = v_ass.id and ciclo_inicio = v_ass.ciclo_inicio and not estornada;
        for r in select ps.servico_id, ps.limite_por_ciclo from plano_servicos ps
                  where ps.plano_id = v_plano.id and ps.servico_id = any(v_servicos)
        loop
          exit when v_plano.limite_usos_ciclo is not null and v_usos >= v_plano.limite_usos_ciclo;
          select count(*) into v_usos_srv from utilizacoes
           where assinatura_id = v_ass.id and ciclo_inicio = v_ass.ciclo_inicio and servico_id = r.servico_id and not estornada;
          if r.limite_por_ciclo is null or v_usos_srv < r.limite_por_ciclo then
            v_cobertos := v_cobertos || r.servico_id; v_usos := v_usos + 1;
          end if;
        end loop;
        select coalesce(sum(preco_centavos), 0) into v_desc from servicos where id = any(v_cobertos);
      end if;
    end if;
  end if;

  v_total := greatest(v_preco - v_desc, 0);
  v_conf := exists (select 1 from servicos where id = any(v_servicos) and preco_centavos is null and not (id = any(v_cobertos)));
  v_apartir := exists (select 1 from servicos where id = any(v_servicos) and preco_a_partir and not (id = any(v_cobertos)));
  v_token := encode(gen_random_bytes(24), 'hex');

  begin
    insert into agendamentos (codigo, cliente_id, nome_cliente, profissional_id, inicio, fim, ocupado, status,
                              valor_bruto_centavos, desconto_centavos, valor_total_centavos, valor_a_confirmar, valor_a_partir,
                              token_hash, assinatura_id)
    values (_gerar_codigo(), v_cli, v_nome, v_escolhido, v_inicio, v_inicio + make_interval(mins => v_dur),
            tstzrange(v_inicio, v_inicio + make_interval(mins => v_dur + c.intervalo_entre_min), '[)'),
            'confirmado', v_preco, v_desc, v_total, v_conf, v_apartir, _hash(v_token),
            case when cardinality(v_cobertos) > 0 then v_ass.id end)
    returning id into v_ag;
  exception when exclusion_violation then raise exception 'HORARIO_INDISPONIVEL';
  end;

  insert into agendamento_itens (agendamento_id, servico_id, nome, preco_centavos, duracao_min, coberto_plano)
  select v_ag, s.id, s.nome, s.preco_centavos, coalesce(s.duracao_min, c.duracao_padrao_min), s.id = any(v_cobertos)
    from servicos s where s.id = any(v_servicos);
  if cardinality(v_cobertos) > 0 then
    insert into utilizacoes (assinatura_id, agendamento_id, servico_id, ciclo_inicio)
    select v_ass.id, v_ag, x, v_ass.ciclo_inicio from unnest(v_cobertos) x;
  end if;

  perform _log('agendamento', v_ag::text, 'criado', jsonb_build_object('servicos', v_servicos, 'profissional', v_escolhido, 'inicio', v_inicio));
  return _ag_json(v_ag) || jsonb_build_object('token', v_token);
end $$;

create or replace function _ag_por_token(p_codigo text, p_token text) returns agendamentos
language plpgsql stable security definer set search_path = public, extensions as $$
declare v agendamentos;
begin
  select * into v from agendamentos where codigo = upper(btrim(p_codigo));
  if v.id is null or v.token_hash <> _hash(p_token) then raise exception 'AGENDAMENTO_NAO_ENCONTRADO'; end if;
  return v;
end $$;

create or replace function consultar_agendamento(p_codigo text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin return _ag_json((_ag_por_token(p_codigo, p_token)).id); end $$;

create or replace function _cancelar(p_id uuid, p_motivo text, p_forcar boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v agendamentos; c config := _cfg();
begin
  select * into v from agendamentos where id = p_id for update;
  if v.status <> 'confirmado' then raise exception 'AGENDAMENTO_NAO_CANCELAVEL'; end if;
  if not p_forcar and v.inicio - now() < make_interval(hours => c.cancelamento_antecedencia_h) then
    raise exception 'CANCELAMENTO_FORA_DO_PRAZO';
  end if;
  update agendamentos set status = 'cancelado', cancelado_em = now(), atualizado_em = now(), motivo_cancelamento = left(p_motivo, 300),
         cancelado_por = case when p_forcar then 'barbearia' else 'cliente' end
   where id = p_id;
  update utilizacoes set estornada = true where agendamento_id = p_id and not estornada;
  perform _log('agendamento', p_id::text, 'cancelado', jsonb_build_object('motivo', p_motivo));
  return _ag_json(p_id);
end $$;

create or replace function cancelar_agendamento(p_codigo text, p_token text, p_motivo text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin return _cancelar((_ag_por_token(p_codigo, p_token)).id, coalesce(p_motivo, 'cancelado pelo cliente'), false); end $$;

-- ── conta do cliente ──
create or replace function meu_perfil() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_cli uuid := _cliente_logado(); v clientes;
begin
  if v_cli is null then return null; end if;
  select * into v from clientes where id = v_cli;
  return jsonb_build_object('nome', v.nome, 'telefone', v.telefone, 'email', v.email);
end $$;

create or replace function salvar_perfil(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cli  uuid := _cliente_logado();
  v_nome text := btrim(coalesce(p->>'nome', ''));
  v_tel  text := regexp_replace(coalesce(p->>'telefone', ''), '\D', '', 'g');
begin
  if length(v_nome) < 2 or length(v_nome) > 120 then raise exception 'NOME_INVALIDO'; end if;
  if v_tel !~ '^[1-9][0-9]{9,10}$' then raise exception 'TELEFONE_INVALIDO'; end if;
  if v_cli is not null then
    if exists (select 1 from clientes where telefone = v_tel and id <> v_cli) then raise exception 'TELEFONE_VINCULADO'; end if;
    update clientes set nome = v_nome, telefone = v_tel, email = coalesce(email, auth.email()) where id = v_cli;
  else
    insert into clientes (nome, telefone, email, user_id) values (v_nome, v_tel, auth.email(), auth.uid())
    on conflict (telefone) do update set user_id = auth.uid(), nome = excluded.nome, email = coalesce(clientes.email, excluded.email)
      where clientes.user_id is null
    returning id into v_cli;
    if v_cli is null then raise exception 'TELEFONE_VINCULADO'; end if;
  end if;
  perform _log('cliente', v_cli::text, 'perfil_salvo', '{}');
  return meu_perfil();
end $$;

create or replace function meus_agendamentos() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_cli uuid := _cliente_logado();
begin
  if v_cli is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(_ag_json(a.id) order by a.inicio desc) from agendamentos a where a.cliente_id = v_cli), '[]'::jsonb);
end $$;

create or replace function cancelar_meu_agendamento(p_codigo text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_cli uuid := _cliente_logado(); v agendamentos;
begin
  select * into v from agendamentos where codigo = upper(p_codigo) and cliente_id = v_cli;
  if v.id is null then raise exception 'AGENDAMENTO_NAO_ENCONTRADO'; end if;
  return _cancelar(v.id, 'cancelado pelo cliente', false);
end $$;

-- pedido de plano: fica pendente até a barbearia ativar (pagamento no balcão)
create or replace function solicitar_plano(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_plano planos; v_cli uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'LOGIN_NECESSARIO'; end if;
  select * into v_plano from planos where id = p->>'plano_id' and ativo and disponivel_contratacao;
  if v_plano.id is null then raise exception 'PLANO_INDISPONIVEL'; end if;
  if coalesce((p->>'aceite')::boolean, false) is not true or (p->>'termos_versao')::int is distinct from v_plano.termos_versao then
    raise exception 'ACEITE_OBRIGATORIO';
  end if;
  v_cli := _cliente_logado();
  if v_cli is null then raise exception 'PERFIL_INCOMPLETO'; end if;
  begin
    insert into assinaturas (cliente_id, plano_id, status, termos_versao, aceite_em, renova_sozinho)
    values (v_cli, v_plano.id, 'pendente', v_plano.termos_versao, now(),
            v_plano.link_pagamento is not null and v_plano.cobranca_recorrente) returning id into v_id;
  exception when unique_violation then raise exception 'ASSINATURA_EXISTENTE';
  end;
  perform _log('assinatura', v_id::text, 'solicitada', jsonb_build_object('plano', v_plano.id, 'termos', v_plano.termos_versao));
  return jsonb_build_object('assinatura_id', v_id, 'status', 'pendente', 'link_pagamento', v_plano.link_pagamento);
end $$;

create or replace function minhas_assinaturas() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_cli uuid := _cliente_logado();
begin
  perform atualizar_assinaturas();
  if v_cli is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'plano', pl.nome, 'plano_id', pl.id, 'status', a.status, 'ciclo_inicio', a.ciclo_inicio, 'ciclo_fim', a.ciclo_fim,
      'limite_usos_ciclo', pl.limite_usos_ciclo, 'renova_sozinho', a.renova_sozinho, 'link_pagamento', pl.link_pagamento,
      'usos_no_ciclo', (select count(*) from utilizacoes u where u.assinatura_id = a.id and u.ciclo_inicio = a.ciclo_inicio and not u.estornada)
    ) order by a.criada_em desc)
    from assinaturas a join planos pl on pl.id = a.plano_id where a.cliente_id = v_cli), '[]'::jsonb);
end $$;

create or replace function cancelar_assinatura(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_cli uuid := _cliente_logado(); v assinaturas;
begin
  select * into v from assinaturas where id = p_id and cliente_id = v_cli for update;
  if v.id is null then raise exception 'ASSINATURA_NAO_ENCONTRADA'; end if;
  if v.status not in ('pendente','ativa','inadimplente') then raise exception 'ASSINATURA_NAO_CANCELAVEL'; end if;
  update assinaturas set status = 'cancelada', cancelada_em = now() where id = p_id;
  perform _log('assinatura', p_id::text, 'cancelada_pelo_cliente', '{}');
  return jsonb_build_object('id', p_id, 'status', 'cancelada');
end $$;

-- ════════════════════════════════════════════════════════════════════
--  PAINEL: agenda (dono, recepção e barbeiro)
-- ════════════════════════════════════════════════════════════════════
create or replace function _eu() returns admins
language plpgsql stable security definer set search_path = public, extensions as $$
declare v admins;
begin
  select * into v from admins where user_id = auth.uid();
  if v.user_id is null then raise exception 'SEM_PERMISSAO'; end if;
  return v;
end $$;

-- barbeiro só mexe no que é dele
create or replace function _exigir_admin(p_prof text default null) returns admins
language plpgsql stable security definer set search_path = public, extensions as $$
declare v admins := _eu();
begin
  if v.papel = 'barbeiro' and p_prof is distinct from v.profissional_id then raise exception 'SEM_PERMISSAO'; end if;
  return v;
end $$;

-- catálogo, preços, horários e equipe: só o dono
create or replace function _exigir_dono() returns admins
language plpgsql stable security definer set search_path = public, extensions as $$
declare v admins := _eu();
begin
  if v.papel <> 'dono' then raise exception 'SEM_PERMISSAO'; end if;
  return v;
end $$;

create or replace function admin_eu() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v admins := _eu();
begin
  return jsonb_build_object('user_id', v.user_id, 'papel', v.papel, 'profissional_id', v.profissional_id,
    'profissional_nome', (select nome from profissionais where id = v.profissional_id), 'email', auth.email());
end $$;

create or replace function admin_agenda(p_de date, p_ate date, p_profissional text default null, p_status text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v admins := _eu(); c config := _cfg();
begin
  return coalesce((
    select jsonb_agg(_ag_json(a.id) || jsonb_build_object('telefone', cl.telefone, 'id', a.id) order by a.inicio)
      from agendamentos a join clientes cl on cl.id = a.cliente_id
     where (a.inicio at time zone c.fuso)::date between p_de and p_ate
       and (p_profissional is null or a.profissional_id = p_profissional)
       and (v.papel <> 'barbeiro' or a.profissional_id = v.profissional_id)
       and (p_status is null or a.status::text = p_status)), '[]'::jsonb);
end $$;

create or replace function admin_bloquear(p_profissional text, p_inicio timestamptz, p_fim timestamptz, p_motivo text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint;
begin
  perform _exigir_admin(p_profissional);
  if p_fim <= p_inicio then raise exception 'PERIODO_INVALIDO'; end if;
  insert into bloqueios (profissional_id, periodo, motivo, criado_por)
  values (p_profissional, tstzrange(p_inicio, p_fim, '[)'), left(p_motivo, 120), auth.uid()) returning id into v_id;
  perform _log('bloqueio', v_id::text, 'criado', jsonb_build_object('profissional', p_profissional, 'inicio', p_inicio, 'fim', p_fim));
  return v_id;
end $$;

create or replace function admin_bloqueios(p_de date, p_ate date, p_profissional text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v admins := _eu(); c config := _cfg();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'profissional_id', b.profissional_id,
             'inicio', lower(b.periodo), 'fim', upper(b.periodo), 'motivo', b.motivo, 'origem', b.origem) order by lower(b.periodo))
      from bloqueios b
     where b.periodo && tstzrange((p_de::timestamp) at time zone c.fuso, ((p_ate + 1)::timestamp) at time zone c.fuso, '[)')
       and (p_profissional is null or b.profissional_id = p_profissional or b.profissional_id is null)
       and (v.papel <> 'barbeiro' or b.profissional_id = v.profissional_id or b.profissional_id is null)), '[]'::jsonb);
end $$;

create or replace function admin_remover_bloqueio(p_id bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare b bloqueios;
begin
  select * into b from bloqueios where id = p_id;
  if b.id is null then raise exception 'BLOQUEIO_NAO_ENCONTRADO'; end if;
  perform _exigir_admin(b.profissional_id);
  delete from bloqueios where id = p_id;
  perform _log('bloqueio', p_id::text, 'removido', jsonb_build_object('profissional', b.profissional_id));
end $$;

create or replace function admin_atualizar_status(p_id uuid, p_status status_agendamento, p_motivo text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v agendamentos;
begin
  select * into v from agendamentos where id = p_id;
  if v.id is null then raise exception 'AGENDAMENTO_NAO_ENCONTRADO'; end if;
  perform _exigir_admin(v.profissional_id);
  if p_status = 'cancelado' then return _cancelar(p_id, coalesce(p_motivo, 'cancelado pela barbearia'), true); end if;
  if p_status not in ('concluido','nao_compareceu') or v.status <> 'confirmado' then raise exception 'TRANSICAO_INVALIDA'; end if;
  update agendamentos set status = p_status, atualizado_em = now() where id = p_id;
  perform _log('agendamento', p_id::text, 'status_' || p_status::text, jsonb_build_object('motivo', p_motivo));
  return _ag_json(p_id);
end $$;

-- números de um cliente, contando o histórico inteiro
create or replace function _numeros_cliente(p_cli uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'marcados', count(*),
    'atendidos', count(*) filter (where status = 'concluido'),
    'cancelados_cliente', count(*) filter (where status = 'cancelado' and cancelado_por is distinct from 'barbearia'),
    'cancelados_barbearia', count(*) filter (where status = 'cancelado' and cancelado_por = 'barbearia'),
    'faltas', count(*) filter (where status = 'nao_compareceu'),
    'ultima_visita', max(inicio) filter (where status = 'concluido'),
    'proximo', min(inicio) filter (where status = 'confirmado' and inicio > now()),
    'faltas_recentes', _faltas(p_cli),
    'bloqueado', (_cfg()).max_faltas > 0 and _faltas(p_cli) >= (_cfg()).max_faltas)
  from agendamentos where cliente_id = p_cli
$$;

create or replace function _ficha(p_cli uuid, p_ag uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'cliente_id', cl.id, 'nome', cl.nome, 'telefone', cl.telefone, 'email', cl.email, 'cliente_desde', cl.criado_em,
    'atendimentos', (_numeros_cliente(cl.id) ->> 'atendidos')::int,
    'numeros', _numeros_cliente(cl.id),
    'plano', (select pl.nome || ' · ' || s.status from assinaturas s join planos pl on pl.id = s.plano_id
               where s.cliente_id = cl.id and s.status in ('pendente','ativa','inadimplente') order by s.criada_em desc limit 1),
    'historico', coalesce((select jsonb_agg(_ag_json(x.id) || jsonb_build_object('cancelado_por', x.cancelado_por) order by x.inicio desc)
                             from (select id, inicio, cancelado_por from agendamentos where cliente_id = cl.id order by inicio desc limit 12) x), '[]'::jsonb),
    'registro', coalesce((select jsonb_agg(jsonb_build_object('acao', h.acao, 'quando', h.criado_em) order by h.criado_em)
                            from historico h where p_ag is not null and h.entidade = 'agendamento' and h.entidade_id = p_ag::text), '[]'::jsonb))
  from clientes cl where cl.id = p_cli
$$;

-- ficha aberta a partir de um horário da agenda (barbeiro só dos próprios)
create or replace function admin_cliente(p_agendamento uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a agendamentos;
begin
  select * into a from agendamentos where id = p_agendamento;
  if a.id is null then raise exception 'AGENDAMENTO_NAO_ENCONTRADO'; end if;
  perform _exigir_admin(a.profissional_id);
  return _ficha(a.cliente_id, a.id);
end $$;

-- ═════════ CLIENTES, RESUMO DO MÊS E FALTAS (dono e recepção) ═════════
create or replace function _exigir_balcao() returns admins
language plpgsql stable security definer set search_path = public, extensions as $$
declare v admins := _eu();
begin
  if v.papel = 'barbeiro' then raise exception 'SEM_PERMISSAO'; end if;
  return v;
end $$;

create or replace function admin_ficha(p_cliente uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _exigir_balcao();
  if not exists (select 1 from clientes where id = p_cliente) then raise exception 'CLIENTE_NAO_ENCONTRADO'; end if;
  return _ficha(p_cliente, null);
end $$;

-- lista de clientes: busca por nome ou WhatsApp, ordem e filtro de quem sumiu
create or replace function admin_clientes(p_busca text default null, p_ordem text default 'recentes', p_sumidos_dias int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_busca text := nullif(btrim(coalesce(p_busca, '')), ''); v_dig text;
begin
  perform _exigir_balcao();
  v_dig := nullif(regexp_replace(coalesce(v_busca, ''), '\D', '', 'g'), '');
  return coalesce((
    select jsonb_agg(to_jsonb(y) - 'ordem' order by y.ordem)
      from (
        select x.*, row_number() over (order by
                 case when p_ordem = 'nome' then x.nome end,
                 case when p_ordem = 'frequentes' then x.atendidos end desc,
                 case when p_ordem = 'faltas' then x.faltas + x.cancelados_cliente end desc,
                 x.ultima_visita desc nulls last, x.nome) ordem
          from (
            select cl.id, cl.nome, cl.telefone,
                   (n->>'marcados')::int marcados, (n->>'atendidos')::int atendidos,
                   (n->>'cancelados_cliente')::int cancelados_cliente, (n->>'cancelados_barbearia')::int cancelados_barbearia,
                   (n->>'faltas')::int faltas, (n->>'ultima_visita')::timestamptz ultima_visita, (n->>'proximo')::timestamptz proximo,
                   (n->>'bloqueado')::boolean bloqueado,
                   (select pl.nome from assinaturas s join planos pl on pl.id = s.plano_id
                     where s.cliente_id = cl.id and s.status = 'ativa' limit 1) plano
              from clientes cl, lateral _numeros_cliente(cl.id) n
             where (v_busca is null or cl.nome ilike '%' || v_busca || '%' or (v_dig is not null and cl.telefone like '%' || v_dig || '%'))
          ) x
         where p_sumidos_dias is null
            or (x.proximo is null and x.ultima_visita is not null and x.ultima_visita < now() - make_interval(days => p_sumidos_dias))
      ) y
     where y.ordem <= 300), '[]'::jsonb);
end $$;

-- resumo de um mês (só o dono: tem valores)
create or replace function admin_resumo(p_mes date default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c config := _cfg();
  v_ini date := date_trunc('month', coalesce(p_mes, (now() at time zone c.fuso)::date))::date;
  v_fim date := (v_ini + interval '1 month')::date;
begin
  perform _exigir_dono();
  perform atualizar_assinaturas();
  return jsonb_build_object(
    'mes', v_ini,
    'barbeiros', coalesce((
      select jsonb_agg(to_jsonb(b) - 'ordem' order by b.ordem) from (
        select p.id, p.nome, p.ordem,
               count(a.id) filter (where a.status = 'concluido') atendidos,
               coalesce(sum(a.valor_total_centavos) filter (where a.status = 'concluido'), 0) valor_centavos,
               count(a.id) filter (where a.status = 'confirmado') agendados
          from profissionais p
          left join agendamentos a on a.profissional_id = p.id
                and (a.inicio at time zone c.fuso)::date >= v_ini and (a.inicio at time zone c.fuso)::date < v_fim
         where p.ativo or a.id is not null
         group by p.id, p.nome, p.ordem) b), '[]'::jsonb),
    'cancelados_cliente', (select count(*) from agendamentos a where a.status = 'cancelado' and a.cancelado_por is distinct from 'barbearia'
                             and (a.inicio at time zone c.fuso)::date >= v_ini and (a.inicio at time zone c.fuso)::date < v_fim),
    'cancelados_barbearia', (select count(*) from agendamentos a where a.status = 'cancelado' and a.cancelado_por = 'barbearia'
                             and (a.inicio at time zone c.fuso)::date >= v_ini and (a.inicio at time zone c.fuso)::date < v_fim),
    'faltas', (select count(*) from agendamentos a where a.status = 'nao_compareceu'
                 and (a.inicio at time zone c.fuso)::date >= v_ini and (a.inicio at time zone c.fuso)::date < v_fim),
    'clientes_novos', (select count(*) from clientes cl where (select min(a.inicio) from agendamentos a where a.cliente_id = cl.id) >= (v_ini::timestamp at time zone c.fuso)
                         and (select min(a.inicio) from agendamentos a where a.cliente_id = cl.id) < (v_fim::timestamp at time zone c.fuso)),
    'planos_ativos', (select count(*) from assinaturas where status = 'ativa'),
    'planos_pendentes', (select count(*) from assinaturas where status = 'pendente'),
    'planos_atrasados', (select count(*) from assinaturas where status = 'inadimplente'));
end $$;

-- a barbearia perdoa as faltas: o cliente volta a marcar pelo site
create or replace function admin_zerar_faltas(p_cliente uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _exigir_balcao();
  update clientes set faltas_zeradas_em = now() where id = p_cliente;
  if not found then raise exception 'CLIENTE_NAO_ENCONTRADO'; end if;
  perform _log('cliente', p_cliente::text, 'faltas_zeradas', '{}');
  return _numeros_cliente(p_cliente);
end $$;

-- ════════════════════════════════════════════════════════════════════
--  PAINEL: catálogo, planos, horários, equipe, regras (só o dono)
-- ════════════════════════════════════════════════════════════════════
create or replace function _slug(p text) returns text
language sql immutable as $$
  select left(trim(both '-' from regexp_replace(lower(translate(coalesce(p, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn')), '[^a-z0-9]+', '-', 'g')), 40)
$$;

-- tudo o que o painel precisa para editar, inclusive itens inativos
create or replace function admin_catalogo() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _eu();
  return jsonb_build_object(
    'config', (select to_jsonb(c) - 'id' from config c where id = 1),
    'servicos', coalesce((select jsonb_agg(to_jsonb(s) order by s.ordem, s.nome) from servicos s), '[]'),
    'profissionais', coalesce((select jsonb_agg(to_jsonb(p) order by p.ordem) from profissionais p), '[]'),
    'funcionamento', coalesce((select jsonb_agg(to_jsonb(h) order by h.dia_semana) from horarios_funcionamento h), '[]'),
    'jornadas', coalesce((select jsonb_agg(to_jsonb(j) order by j.profissional_id, j.dia_semana, j.inicio) from jornadas j), '[]'),
    'planos', coalesce((select jsonb_agg(to_jsonb(pl) order by pl.ordem) from planos pl), '[]'),
    'plano_servicos', coalesce((select jsonb_agg(to_jsonb(ps)) from plano_servicos ps), '[]'));
end $$;

create or replace function admin_salvar_servico(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id text := nullif(p->>'id', ''); v servicos; v_novo boolean;
begin
  perform _exigir_dono();
  if length(btrim(coalesce(p->>'nome', ''))) < 2 then raise exception 'NOME_INVALIDO'; end if;
  if nullif(p->>'preco_centavos', '') is not null and (p->>'preco_centavos')::int < 0 then raise exception 'PRECO_INVALIDO'; end if;
  if nullif(p->>'duracao_min', '') is not null and (p->>'duracao_min')::int not between 5 and 480 then raise exception 'DURACAO_INVALIDA'; end if;
  v_novo := v_id is null or not exists (select 1 from servicos where id = v_id);
  if v_id is null then
    v_id := _slug(p->>'nome');
    while exists (select 1 from servicos where id = v_id) loop v_id := left(v_id, 36) || '-' || floor(random() * 90 + 10)::int; end loop;
  end if;
  insert into servicos as s (id, nome, descricao, categoria, preco_centavos, preco_a_partir, duracao_min, componentes, ativo, agendavel_online, ordem)
  values (v_id, btrim(p->>'nome'), nullif(btrim(p->>'descricao'), ''), coalesce(nullif(btrim(p->>'categoria'), ''), 'Outros'),
          nullif(p->>'preco_centavos', '')::int, coalesce((p->>'preco_a_partir')::boolean, false), nullif(p->>'duracao_min', '')::int,
          coalesce(array(select jsonb_array_elements_text(p->'componentes')), '{}'),
          coalesce((p->>'ativo')::boolean, true), coalesce((p->>'agendavel_online')::boolean, true),
          coalesce(nullif(p->>'ordem', '')::int, (select coalesce(max(ordem), 0) + 10 from servicos)))
  on conflict (id) do update set nome = excluded.nome, descricao = excluded.descricao, categoria = excluded.categoria,
    preco_centavos = excluded.preco_centavos, preco_a_partir = excluded.preco_a_partir, duracao_min = excluded.duracao_min,
    componentes = excluded.componentes, ativo = excluded.ativo, agendavel_online = excluded.agendavel_online,
    ordem = coalesce(nullif(p->>'ordem', '')::int, s.ordem)
  returning * into v;
  perform _log('servico', v.id, case when v_novo then 'criado' else 'alterado' end, to_jsonb(v));
  return to_jsonb(v);
end $$;

-- exclui se nunca foi usado; senão só desativa
create or replace function admin_excluir_servico(p_id text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _exigir_dono();
  if exists (select 1 from agendamento_itens where servico_id = p_id) or exists (select 1 from plano_servicos where servico_id = p_id) then
    update servicos set ativo = false where id = p_id;
    perform _log('servico', p_id, 'desativado', '{}');
    return 'desativado';
  end if;
  delete from servicos where id = p_id;
  perform _log('servico', p_id, 'excluido', '{}');
  return 'excluido';
end $$;

create or replace function admin_salvar_plano(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id text := nullif(p->>'id', ''); v planos; v_antigo planos; v_mudou boolean; v_inc jsonb := coalesce(p->'servicos', '[]');
begin
  perform _exigir_dono();
  if length(btrim(coalesce(p->>'nome', ''))) < 2 then raise exception 'NOME_INVALIDO'; end if;
  if coalesce(nullif(p->>'preco_centavos', '')::int, 0) <= 0 then raise exception 'PRECO_INVALIDO'; end if;
  if jsonb_array_length(v_inc) = 0 then raise exception 'PLANO_SEM_SERVICOS'; end if;
  if nullif(btrim(p->>'link_pagamento'), '') !~ '^https://[^\s]+$' then raise exception 'LINK_INVALIDO'; end if;
  if v_id is null then
    v_id := _slug(p->>'nome');
    while exists (select 1 from planos where id = v_id) loop v_id := left(v_id, 36) || '-' || floor(random() * 90 + 10)::int; end loop;
  end if;
  select * into v_antigo from planos where id = v_id;
  insert into planos as pl (id, nome, descricao, preco_centavos, limite_usos_ciclo, regras, renovacao, cancelamento, restricoes,
                            ativo, disponivel_contratacao, ordem, link_pagamento, cobranca_recorrente)
  values (v_id, btrim(p->>'nome'), nullif(btrim(p->>'descricao'), ''), (p->>'preco_centavos')::int,
          nullif(p->>'limite_usos_ciclo', '')::int, nullif(btrim(p->>'regras'), ''), nullif(btrim(p->>'renovacao'), ''),
          nullif(btrim(p->>'cancelamento'), ''), coalesce(p->'restricoes', '{}'),
          coalesce((p->>'ativo')::boolean, true), coalesce((p->>'disponivel_contratacao')::boolean, true),
          coalesce(nullif(p->>'ordem', '')::int, (select coalesce(max(ordem), 0) + 10 from planos)),
          nullif(btrim(p->>'link_pagamento'), ''), coalesce((p->>'cobranca_recorrente')::boolean, false))
  on conflict (id) do update set link_pagamento = excluded.link_pagamento, cobranca_recorrente = excluded.cobranca_recorrente,
    nome = excluded.nome, descricao = excluded.descricao, preco_centavos = excluded.preco_centavos,
    limite_usos_ciclo = excluded.limite_usos_ciclo, regras = excluded.regras, renovacao = excluded.renovacao,
    cancelamento = excluded.cancelamento, restricoes = excluded.restricoes, ativo = excluded.ativo,
    disponivel_contratacao = excluded.disponivel_contratacao
  returning * into v;
  delete from plano_servicos where plano_id = v_id;
  insert into plano_servicos (plano_id, servico_id, limite_por_ciclo)
  select v_id, x->>'servico_id', nullif(x->>'limite_por_ciclo', '')::int from jsonb_array_elements(v_inc) x;
  -- condições mudaram: quem assinar daqui em diante aceita a versão nova
  v_mudou := v_antigo.id is not null and (v_antigo.preco_centavos, v_antigo.limite_usos_ciclo, v_antigo.regras, v_antigo.renovacao,
             v_antigo.cancelamento, v_antigo.restricoes, v_antigo.cobranca_recorrente) is distinct from (v.preco_centavos, v.limite_usos_ciclo,
             v.regras, v.renovacao, v.cancelamento, v.restricoes, v.cobranca_recorrente);
  if v_mudou then update planos set termos_versao = termos_versao + 1 where id = v_id returning * into v; end if;
  perform _log('plano', v_id, case when v_antigo.id is null then 'criado' else 'alterado' end, to_jsonb(v));
  return to_jsonb(v);
end $$;

-- funcionamento da barbearia: [{dia_semana, abre, fecha}] (dia ausente = fechado)
create or replace function admin_salvar_funcionamento(p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _exigir_dono();
  if exists (select 1 from jsonb_array_elements(p) x where (x->>'fecha')::time <= (x->>'abre')::time) then raise exception 'PERIODO_INVALIDO'; end if;
  delete from horarios_funcionamento;
  insert into horarios_funcionamento (dia_semana, abre, fecha)
  select (x->>'dia_semana')::int, (x->>'abre')::time, (x->>'fecha')::time from jsonb_array_elements(p) x;
  perform _log('config', 'funcionamento', 'alterado', p);
end $$;

-- jornada de um barbeiro: [{dia_semana, inicio, fim}] (pausa = duas linhas no mesmo dia)
create or replace function admin_salvar_jornada(p_profissional text, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _exigir_dono();
  if not exists (select 1 from profissionais where id = p_profissional) then raise exception 'PROFISSIONAL_NAO_ENCONTRADO'; end if;
  if exists (select 1 from jsonb_array_elements(p) x where (x->>'fim')::time <= (x->>'inicio')::time) then raise exception 'PERIODO_INVALIDO'; end if;
  delete from jornadas where profissional_id = p_profissional;
  insert into jornadas (profissional_id, dia_semana, inicio, fim)
  select p_profissional, (x->>'dia_semana')::int, (x->>'inicio')::time, (x->>'fim')::time from jsonb_array_elements(p) x;
  perform _log('jornada', p_profissional, 'alterada', p);
end $$;

create or replace function admin_salvar_profissional(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id text := nullif(p->>'id', ''); v profissionais; v_novo boolean;
begin
  perform _exigir_dono();
  if length(btrim(coalesce(p->>'nome', ''))) < 2 then raise exception 'NOME_INVALIDO'; end if;
  v_novo := v_id is null;
  if v_novo then
    v_id := _slug(split_part(btrim(p->>'nome'), ' ', 1));
    while exists (select 1 from profissionais where id = v_id) loop v_id := left(v_id, 36) || '-' || floor(random() * 90 + 10)::int; end loop;
  end if;
  insert into profissionais as pr (id, nome, foto_url, especialidades, ativo, ordem, cargo)
  values (v_id, btrim(p->>'nome'), nullif(btrim(p->>'foto_url'), ''),
          coalesce(array(select jsonb_array_elements_text(p->'especialidades')), '{}'), coalesce((p->>'ativo')::boolean, true),
          coalesce(nullif(p->>'ordem', '')::int, (select coalesce(max(ordem), 0) + 1 from profissionais)),
          coalesce(nullif(btrim(left(p->>'cargo', 60)), ''), 'Barbeiro'))
  on conflict (id) do update set nome = excluded.nome, foto_url = excluded.foto_url, especialidades = excluded.especialidades,
    ativo = excluded.ativo, cargo = excluded.cargo
  returning * into v;
  -- barbeiro novo começa com a jornada igual ao funcionamento da barbearia
  if v_novo then
    insert into jornadas (profissional_id, dia_semana, inicio, fim) select v_id, dia_semana, abre, fecha from horarios_funcionamento;
  end if;
  perform _log('profissional', v_id, case when v_novo then 'criado' else 'alterado' end, to_jsonb(v));
  return to_jsonb(v);
end $$;

create or replace function admin_salvar_config(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v config;
begin
  perform _exigir_dono();
  update config set
    antecedencia_min = coalesce(nullif(p->>'antecedencia_min', '')::int, antecedencia_min),
    passo_min = coalesce(nullif(p->>'passo_min', '')::int, passo_min),
    intervalo_entre_min = coalesce(nullif(p->>'intervalo_entre_min', '')::int, intervalo_entre_min),
    janela_dias = coalesce(nullif(p->>'janela_dias', '')::int, janela_dias),
    cancelamento_antecedencia_h = coalesce(nullif(p->>'cancelamento_antecedencia_h', '')::int, cancelamento_antecedencia_h),
    exigir_login = coalesce((p->>'exigir_login')::boolean, exigir_login),
    max_faltas = coalesce(nullif(p->>'max_faltas', '')::int, max_faltas),
    politica_cancelamento = case when p ? 'politica_cancelamento' then nullif(btrim(p->>'politica_cancelamento'), '') else politica_cancelamento end,
    atualizado_em = now()
  where id = 1 returning * into v;
  perform _log('config', 'regras', 'alterado', to_jsonb(v));
  return to_jsonb(v) - 'id';
exception when check_violation then raise exception 'VALOR_FORA_DO_LIMITE';
end $$;

-- ── acessos ao painel ──
create or replace function admin_acessos() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _exigir_dono();
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'papel', a.papel, 'profissional_id', a.profissional_id,
                    'email', coalesce(a.email, u.email), 'eu', a.user_id = auth.uid()) order by a.criado_em)
                     from admins a left join auth.users u on u.id = a.user_id), '[]'::jsonb);
end $$;

-- a pessoa precisa ter entrado uma vez (no site ou no painel) para existir a conta
create or replace function admin_liberar_acesso(p_email text, p_papel text, p_profissional text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid;
begin
  perform _exigir_dono();
  if p_papel not in ('dono','recepcao','barbeiro') then raise exception 'PAPEL_INVALIDO'; end if;
  if p_papel = 'barbeiro' and not exists (select 1 from profissionais where id = p_profissional) then raise exception 'PROFISSIONAL_OBRIGATORIO'; end if;
  select id into v_uid from auth.users where lower(email) = lower(btrim(p_email));
  if v_uid is null then raise exception 'USUARIO_NAO_ENCONTRADO'; end if;
  insert into admins (user_id, papel, profissional_id, email)
  values (v_uid, p_papel, case when p_papel = 'barbeiro' then p_profissional end, lower(btrim(p_email)))
  on conflict (user_id) do update set papel = excluded.papel, profissional_id = excluded.profissional_id, email = excluded.email;
  perform _log('acesso', v_uid::text, 'liberado', jsonb_build_object('papel', p_papel, 'profissional', p_profissional));
end $$;

create or replace function admin_remover_acesso(p_user uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _exigir_dono();
  if p_user = auth.uid() then raise exception 'NAO_REMOVE_A_SI_MESMO'; end if;
  delete from admins where user_id = p_user;
  perform _log('acesso', p_user::text, 'removido', '{}');
end $$;

-- ── assinantes (dono e recepção) ──
create or replace function admin_assinaturas() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v admins := _eu();
begin
  if v.papel = 'barbeiro' then raise exception 'SEM_PERMISSAO'; end if;
  perform atualizar_assinaturas();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status, 'plano', pl.nome, 'plano_id', pl.id,
             'preco_centavos', pl.preco_centavos, 'cliente', c.nome, 'telefone', c.telefone, 'criada_em', a.criada_em,
             'ciclo_inicio', a.ciclo_inicio, 'ciclo_fim', a.ciclo_fim, 'limite_usos_ciclo', pl.limite_usos_ciclo,
             'usos_no_ciclo', (select count(*) from utilizacoes u where u.assinatura_id = a.id and u.ciclo_inicio = a.ciclo_inicio and not u.estornada),
             'renova_sozinho', a.renova_sozinho, 'link_pagamento', pl.link_pagamento, 'cancelada_em', a.cancelada_em)
           order by case a.status when 'pendente' then 0 when 'inadimplente' then 1 when 'ativa' then 2 else 3 end, a.criada_em desc)
      from assinaturas a join planos pl on pl.id = a.plano_id join clientes c on c.id = a.cliente_id), '[]'::jsonb);
end $$;

-- ativar (recebeu o 1º pagamento), renovar (recebeu o mês seguinte) ou cancelar
create or replace function admin_assinatura(p_id uuid, p_acao text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v admins := _eu(); a assinaturas; v_ini date;
begin
  if v.papel = 'barbeiro' then raise exception 'SEM_PERMISSAO'; end if;
  select * into a from assinaturas where id = p_id for update;
  if a.id is null then raise exception 'ASSINATURA_NAO_ENCONTRADA'; end if;
  if p_acao in ('ativar', 'renovar') then
    if a.status in ('cancelada', 'expirada') then raise exception 'ASSINATURA_ENCERRADA'; end if;
    -- renovação em dia emenda no ciclo atual; atrasada recomeça hoje
    v_ini := case when a.ciclo_fim is not null and a.ciclo_fim >= _hoje() then a.ciclo_fim + 1 else _hoje() end;
    update assinaturas set status = 'ativa', inicio = coalesce(inicio, v_ini), ciclo_inicio = v_ini,
           ciclo_fim = (v_ini + interval '1 month' - interval '1 day')::date
     where id = p_id returning * into a;
  elsif p_acao = 'cancelar' then
    update assinaturas set status = 'cancelada', cancelada_em = now() where id = p_id returning * into a;
  else raise exception 'ACAO_INVALIDA';
  end if;
  perform _log('assinatura', p_id::text, p_acao, jsonb_build_object('ciclo_inicio', a.ciclo_inicio, 'ciclo_fim', a.ciclo_fim));
  return to_jsonb(a);
end $$;

-- ════════════════════════════════════════════════════════════════════
--  SEGURANÇA: RLS + permissões
-- ════════════════════════════════════════════════════════════════════
do $$ declare t text; begin
  foreach t in array array['config','servicos','profissionais','horarios_funcionamento','jornadas','bloqueios','clientes',
                           'agendamentos','agendamento_itens','planos','plano_servicos','assinaturas','utilizacoes',
                           'historico','admins'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
-- leitura pública só do catálogo ativo
grant select on config, servicos, profissionais, horarios_funcionamento, jornadas, planos, plano_servicos to anon, authenticated;
drop policy if exists leitura_publica on config;                 create policy leitura_publica on config for select using (true);
drop policy if exists leitura_publica on servicos;               create policy leitura_publica on servicos for select using (ativo);
drop policy if exists leitura_publica on profissionais;          create policy leitura_publica on profissionais for select using (ativo);
drop policy if exists leitura_publica on horarios_funcionamento; create policy leitura_publica on horarios_funcionamento for select using (true);
drop policy if exists leitura_publica on jornadas;               create policy leitura_publica on jornadas for select using (true);
drop policy if exists leitura_publica on planos;                 create policy leitura_publica on planos for select using (ativo);
drop policy if exists leitura_publica on plano_servicos;         create policy leitura_publica on plano_servicos for select using (true);
-- todas as escritas passam pelas funções acima (validadas e registradas no histórico)

revoke execute on all functions in schema public from public;
do $$ begin execute 'revoke execute on all functions in schema public from anon, authenticated'; exception when undefined_object then null; end $$;

grant execute on function disponibilidade(date, text[], text), dias_disponiveis(date, date, text[], text), criar_agendamento(jsonb),
  consultar_agendamento(text, text), cancelar_agendamento(text, text, text), is_admin()
  to anon, authenticated;
grant execute on function meu_perfil(), salvar_perfil(jsonb), meus_agendamentos(), cancelar_meu_agendamento(text),
  solicitar_plano(jsonb), minhas_assinaturas(), cancelar_assinatura(uuid),
  admin_eu(), admin_agenda(date, date, text, text), admin_bloquear(text, timestamptz, timestamptz, text),
  admin_bloqueios(date, date, text), admin_remover_bloqueio(bigint), admin_atualizar_status(uuid, status_agendamento, text),
  admin_cliente(uuid), admin_catalogo(), admin_salvar_servico(jsonb), admin_excluir_servico(text), admin_salvar_plano(jsonb),
  admin_salvar_funcionamento(jsonb), admin_salvar_jornada(text, jsonb), admin_salvar_profissional(jsonb), admin_salvar_config(jsonb),
  admin_acessos(), admin_liberar_acesso(text, text, text), admin_remover_acesso(uuid), admin_assinaturas(), admin_assinatura(uuid, text),
  admin_ficha(uuid), admin_clientes(text, text, int), admin_resumo(date), admin_zerar_faltas(uuid)
  to authenticated;
do $$ begin
  execute 'grant execute on function atualizar_assinaturas() to service_role';
  execute 'grant all on agendamentos, agendamento_itens, clientes, bloqueios, config, historico to service_role';
  execute 'grant usage on all sequences in schema public to service_role';
exception when undefined_object then null; end $$;

-- ════════════════════════════════════════════════════════════════════
--  DADOS INICIAIS (do Booksy da barbearia, 19/10/2026). Editáveis no painel.
--  Só entram se a tabela estiver vazia, para não sobrescrever o que o dono mudar.
-- ════════════════════════════════════════════════════════════════════
insert into config (id, politica_cancelamento)
values (1, 'Cancelamento gratuito até 2 horas antes do horário marcado.')
on conflict (id) do nothing;

insert into servicos (id, nome, categoria, preco_centavos, preco_a_partir, duracao_min, componentes, ordem)
select * from (values
  ('corte',         'Corte',                       'Cortes',               7000,  false, 40, '{}'::text[], 10),
  ('raspado',       'Corte Máquina Raspado',       'Cortes',               5000,  false, 30, '{}'::text[], 20),
  ('pe-cabelo',     'Pé de Cabelo',                'Cortes',               3000,  false, 15, '{}'::text[], 30),
  ('penteado',      'Penteado (Escova)',           'Cortes',               3000,  false, 20, '{}'::text[], 40),
  ('higienizacao',  'Higienização',                'Cortes',               3000,  false, 30, '{}'::text[], 50),
  ('barba',         'Barba',                       'Barba & Sobrancelha',  6000,  false, 45, '{}'::text[], 60),
  ('sobrancelha',   'Sobrancelha na Navalha',      'Barba & Sobrancelha',  3000,  false, 20, '{}'::text[], 70),
  ('selagem',       'Selagem ou Botox',            'Química & Tratamento', 13000, false, 45, '{}'::text[], 80),
  ('corte-barba',   'Corte + Barba',               'Combos',               13000, false, 60, '{corte,barba}'::text[], 90),
  ('corte-selagem', 'Corte + Selagem',             'Combos',               19000, false, 60, '{corte,selagem}'::text[], 100),
  ('corte-cover',   'Corte + Cover Pintura',       'Combos',               17000, true,  55, '{corte,cover}'::text[], 110),
  ('combo',         'Combo Corte + Barba + Selagem + Cover', 'Combos',      28000, false, 60, '{corte,barba,selagem,cover}'::text[], 120)
) as v(id, nome, categoria, preco, a_partir, dur, comp, ordem)
where not exists (select 1 from servicos);

-- novos barbeiros entram pelo painel (Equipe e ajustes → Novo barbeiro)
insert into profissionais (id, nome, foto_url, ordem, cargo)
select * from (values
  ('danillo', 'Danillo', 'https://res.cloudinary.com/dnnnn7njk/image/upload/v1777578776/foto_danillo_swnnhd.png', 1, 'Barbeiro Especialista')
) as v(id, nome, foto, ordem, cargo)
where not exists (select 1 from profissionais);

insert into horarios_funcionamento (dia_semana, abre, fecha)
select * from (values (1,'08:30'::time,'19:00'::time),(2,'08:30','19:00'),(3,'08:30','19:00'),(4,'08:30','19:00'),(5,'08:30','19:00'),(6,'08:30','17:00')) v
where not exists (select 1 from horarios_funcionamento);

insert into jornadas (profissional_id, dia_semana, inicio, fim)
select p.id, h.dia_semana, h.abre, h.fecha from profissionais p cross join horarios_funcionamento h
where not exists (select 1 from jornadas);

-- planos de assinatura (arte da barbearia; valores e links da Stone de 13/11/2026): válidos de segunda a quarta,
-- pagos no cartão pelo link da Stone, com cobrança mensal automática
insert into planos (id, nome, descricao, preco_centavos, limite_usos_ciclo, regras, renovacao, restricoes, ordem, link_pagamento, cobranca_recorrente)
select * from (values
  ('plano-bronze', 'Plano Bronze', '2 cortes e 1 barba por mês.', 18990, null::int, 'Mediante marcação com antecedência. +10% em qualquer produto da barbearia.', 'Mensal, no cartão de crédito, pelo link de pagamento da Stone.', '{"dias_semana":[1,2,3]}'::jsonb, 1, 'https://payment-link-v3.stone.com.br/pl_7knWBxYALKOX1nuELhWYRqvMP932J8yj', true),
  ('plano-gold',   'Plano Gold',   'Cortes e barba ilimitados.',  23990, null::int, 'Mediante marcação com antecedência. +10% em qualquer produto da barbearia.', 'Mensal, no cartão de crédito, pelo link de pagamento da Stone.', '{"dias_semana":[1,2,3]}'::jsonb, 2, 'https://payment-link-v3.stone.com.br/pl_7BaDJGox0yEOKk5tJXSrONmMz3V9kKeW', true)) v
where not exists (select 1 from planos);
-- Gold cobre também o combo Corte + Barba (corte e barba já são ilimitados)
insert into plano_servicos (plano_id, servico_id, limite_por_ciclo)
select * from (values ('plano-bronze', 'corte', 2), ('plano-bronze', 'barba', 1),
                      ('plano-gold', 'corte', null::int), ('plano-gold', 'barba', null::int), ('plano-gold', 'corte-barba', null::int)) v
where not exists (select 1 from plano_servicos) and exists (select 1 from planos where id = 'plano-gold');

-- limpeza diária de assinaturas vencidas (ativar pg_cron no painel do Supabase antes)
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('nocaute-assinaturas', '5 3 * * *', 'select public.atualizar_assinaturas();');
  end if;
end $$;
