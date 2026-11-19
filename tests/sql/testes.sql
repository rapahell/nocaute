-- Testes do banco. Rodar com tests/sql/run.sh
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned

create schema t;
grant usage on schema t to anon, authenticated, service_role;
-- segunda-feira da semana que vem (sempre no futuro e dentro da janela)
create function t.seg() returns date language sql stable as $$
  select ((now() at time zone 'America/Sao_Paulo')::date + ((8 - extract(dow from (now() at time zone 'America/Sao_Paulo'))::int) % 7) + 7)
$$;
create function t.ts(p_hora text, p_dias int default 0) returns timestamptz language sql stable as $$
  select ((t.seg() + p_dias) + p_hora::time) at time zone 'America/Sao_Paulo'
$$;
create function t.tenta(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'OK'; exception when others then return sqlerrm; end $$;
create function t.ok(p_nome text, p_cond boolean) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FALHOU: %', p_nome; end if;
  raise notice 'ok  %', p_nome;
end $$;
create function t.reserva(p_srv text[], p_prof text, p_ini timestamptz, p_tel text default '62999990000') returns jsonb language sql as $$
  select criar_agendamento(jsonb_build_object('servicos', to_jsonb(p_srv), 'profissional', p_prof,
         'inicio', p_ini, 'nome', 'Cliente Teste', 'telefone', p_tel))
$$;
create function t.como(p_uid text, p_email text default '') returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_uid, false), set_config('request.jwt.claim.email', p_email, false), null::void
$$;
grant execute on all functions in schema t to anon, authenticated, service_role;

-- contas usadas nos testes
insert into auth.users values ('11111111-1111-1111-1111-111111111111', 'joao@gmail.com'),
  ('22222222-2222-2222-2222-222222222222', 'recepcao@nocaute.com'), ('33333333-3333-3333-3333-333333333333', 'andre@gmail.com'),
  ('44444444-4444-4444-4444-444444444444', 'bia@gmail.com'), ('55555555-5555-5555-5555-555555555555', 'outro@gmail.com'),
  ('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
insert into admins (user_id, papel) values ('99999999-9999-9999-9999-999999999999', 'dono');

-- ═════════ 0. DADOS INICIAIS E LEITURA PÚBLICA ═════════
set role anon;
select t.ok('0a 12 serviços do Booksy', (select count(*) = 12 from servicos));
select t.ok('0b preços conferem (corte 70, raspado 50, sobrancelha 30, combo 280)',
  (select array_agg(preco_centavos order by id) from servicos where id in ('corte','raspado','sobrancelha','combo')) = '{28000,7000,5000,3000}');
select t.ok('0c Corte + Cover é "a partir de" R$ 170', (select preco_a_partir and preco_centavos = 17000 from servicos where id = 'corte-cover'));
select t.ok('0d só o Danillo na equipe, com cargo para o site', (select array_agg(nome || ':' || cargo order by ordem) from profissionais) = '{"Danillo:Barbeiro Especialista"}');
select t.ok('0e funcionamento 08:30-19:00 e sábado até 17:00',
  (select abre = '08:30' and fecha = '19:00' from horarios_funcionamento where dia_semana = 1)
  and (select fecha = '17:00' from horarios_funcionamento where dia_semana = 6)
  and not exists (select 1 from horarios_funcionamento where dia_semana = 0));
select t.ok('0f Plano Bronze R$ 189,90 com link da Stone: 2 cortes e 1 barba, segunda a quarta',
  (select preco_centavos = 18990 and link_pagamento like 'https://payment-link-v3.stone.com.br/%' and cobranca_recorrente and restricoes = '{"dias_semana":[1,2,3]}' from planos where id = 'plano-bronze')
  and (select array_agg(servico_id || ':' || limite_por_ciclo order by servico_id) from plano_servicos where plano_id = 'plano-bronze') = '{barba:1,corte:2}');
select t.ok('0f2 Plano Gold R$ 239,90 com link da Stone: corte, barba e combo ilimitados',
  (select preco_centavos = 23990 and link_pagamento like 'https://payment-link-v3.stone.com.br/%' from planos where id = 'plano-gold')
  and (select count(*) = 3 and bool_and(limite_por_ciclo is null) from plano_servicos where plano_id = 'plano-gold'));
select t.ok('0g nada de pagamento no banco', not exists (select 1 from information_schema.tables where table_name in ('pagamentos','webhook_eventos')));
reset role;

-- ═════════ 0b. DONO CADASTRA UM BARBEIRO NOVO PELO PAINEL (usado no resto dos testes) ═════════
select t.como('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
set role authenticated;
select t.ok('0h barbeiro novo cadastrado pelo painel', (admin_salvar_profissional('{"nome":"André Luiz","cargo":"Barbeiro"}') ->> 'id') = 'andre');
reset role;
select t.ok('0i barbeiro novo já nasce com a jornada da barbearia', (select count(*) = 6 from jornadas where profissional_id = 'andre'));
set role anon;
select t.ok('0j site lê o barbeiro novo com o cargo', (select cargo = 'Barbeiro' from profissionais where id = 'andre'));
reset role;
select t.como('');

-- ═════════ 16. LOGIN OBRIGATÓRIO E CADASTRO ÚNICO ═════════
set role anon;
select t.ok('16a visitante não agenda com exigir_login ligado',
  t.tenta($$select t.reserva('{corte}', 'danillo', t.ts('09:00', 2))$$) like '%LOGIN_NECESSARIO%');
reset role;
select t.como('44444444-4444-4444-4444-444444444444', 'bia@gmail.com');
set role authenticated;
select t.ok('16b conta nova ainda sem cadastro', meu_perfil() is null);
select t.ok('16c logado sem cadastro não agenda',
  t.tenta($$select criar_agendamento(jsonb_build_object('servicos','["corte"]'::jsonb,'profissional','danillo','inicio',t.ts('09:00', 2)))$$) like '%PERFIL_INCOMPLETO%');
select t.ok('16d WhatsApp inválido recusado', t.tenta($$select salvar_perfil('{"nome":"Bia","telefone":"12"}')$$) like '%TELEFONE_INVALIDO%');
select t.ok('16e cadastro salvo uma vez', (salvar_perfil('{"nome":"Bia Souza","telefone":"(62) 97777-1111"}') ->> 'telefone') = '62977771111');
select t.ok('16f agenda sem digitar nome nem telefone',
  (criar_agendamento(jsonb_build_object('servicos','["corte"]'::jsonb,'profissional','danillo','inicio',t.ts('09:00', 2))) ->> 'nome_cliente') = 'Bia Souza');
select t.ok('16g histórico da conta', jsonb_array_length(meus_agendamentos()) = 1);
reset role;
select t.como('55555555-5555-5555-5555-555555555555', 'outro@gmail.com');
set role authenticated;
select t.ok('16h WhatsApp de outra conta não pode ser tomado', t.tenta($$select salvar_perfil('{"nome":"Outro","telefone":"62977771111"}')$$) like '%TELEFONE_VINCULADO%');
select t.ok('16i outra conta não vê o histórico da Bia', jsonb_array_length(meus_agendamentos()) = 0);
reset role;
select t.como('');
update config set exigir_login = false;   -- daqui em diante, também modo visitante

-- ═════════ 1. SELEÇÃO E COMBINAÇÃO ═════════
set role anon;
select t.ok('1a corte + barba', t.tenta($$select disponibilidade(t.seg(), '{corte,barba}')$$) = 'OK');
select t.ok('1b combo + item incluso recusado', t.tenta($$select disponibilidade(t.seg(), '{corte-barba,corte}')$$) like '%COMBINACAO_INVALIDA%');
select t.ok('1c dois combos com item em comum recusados', t.tenta($$select disponibilidade(t.seg(), '{corte-barba,combo}')$$) like '%COMBINACAO_INVALIDA%');
select t.ok('1d Corte + Cover com Combo completo recusado (os dois têm cover)', t.tenta($$select disponibilidade(t.seg(), '{corte-cover,combo}')$$) like '%COMBINACAO_INVALIDA%');
select t.ok('1e serviço repetido', t.tenta($$select disponibilidade(t.seg(), '{corte,corte}')$$) like '%SERVICO_REPETIDO%');
select t.ok('1f serviço inexistente', t.tenta($$select disponibilidade(t.seg(), '{xyz}')$$) like '%SERVICO_INDISPONIVEL%');

-- ═════════ 2. PREÇO E DURAÇÃO ═════════
reset role;
select t.ok('2a corte + barba = 85 min e R$ 130', (select duracao = 85 and preco = 13000 and not a_confirmar from _validar_servicos('{corte,barba}')));
select t.ok('2b sobrancelha + pé de cabelo = 35 min e R$ 60', (select duracao = 35 and preco = 6000 from _validar_servicos('{sobrancelha,pe-cabelo}')));
select t.ok('2c Corte + Cover marca "a partir de"', (select a_partir from _validar_servicos('{corte-cover}')));

-- ═════════ 3. HORÁRIOS ═════════
set role anon;
select t.ok('3a segunda começa 08:30 e o último corte (40 min) é 18:00',
  (select min(horario) = t.ts('08:30') and max(horario) = t.ts('18:00') from disponibilidade(t.seg(), '{corte}')));
select t.ok('3b grade de 30 em 30 a partir de 08:30', (select bool_and(extract(minute from horario at time zone 'America/Sao_Paulo') in (0, 30)) from disponibilidade(t.seg(), '{corte}')));
select t.ok('3c sábado: último corte 16:00 (termina 16:40)', (select max(horario) = t.ts('16:00', 5) from disponibilidade(t.seg() + 5, '{corte}')));
select t.ok('3d domingo fechado', (select count(*) = 0 from disponibilidade(t.seg() - 1, '{corte}')));
select t.ok('3e passado não aparece', (select count(*) = 0 from disponibilidade((now() at time zone 'America/Sao_Paulo')::date - 1, '{corte}')));
select t.ok('3f fora da janela de 30 dias', (select count(*) = 0 from disponibilidade(t.seg() + 60, '{corte}')));
select t.ok('3g os dois barbeiros livres às 10:00', (select profissionais_livres = '{danillo,andre}' from disponibilidade(t.seg(), '{corte}') where horario = t.ts('10:00')));
reset role;
insert into bloqueios (profissional_id, periodo, motivo) values ('danillo', tstzrange(t.ts('14:00'), t.ts('16:00')), 'teste');
select t.como('99999999-9999-9999-9999-999999999999');
set role authenticated;
-- almoço do André pelo painel: 08:30-12:00 e 13:00-19:00 na segunda
select admin_salvar_jornada('andre', (select jsonb_agg(x) from (
  select jsonb_build_object('dia_semana', d, 'inicio', '08:30', 'fim', '19:00') x from generate_series(2, 5) d
  union all select jsonb_build_object('dia_semana', 6, 'inicio', '08:30', 'fim', '17:00')
  union all select jsonb_build_object('dia_semana', 1, 'inicio', '08:30', 'fim', '12:00')
  union all select jsonb_build_object('dia_semana', 1, 'inicio', '13:00', 'fim', '19:00')) z));
reset role; select t.como('');
set role anon;
select t.ok('3h bloqueio tira o Danillo das 14:00', (select profissionais_livres = '{andre}' from disponibilidade(t.seg(), '{corte}') where horario = t.ts('14:00')));
select t.ok('3i almoço do André: 12:00 só com Danillo', (select profissionais_livres = '{danillo}' from disponibilidade(t.seg(), '{corte}') where horario = t.ts('12:00')));
select t.ok('3j corte das 11:30 do André não invade o almoço', (select not ('andre' = any(profissionais_livres)) from disponibilidade(t.seg(), '{corte}') where horario = t.ts('11:30')));
select t.ok('3k dias_disponiveis pula domingo',
  (select not ((t.seg() - 1) = any(array_agg(d))) and t.seg() = any(array_agg(d)) from dias_disponiveis(t.seg() - 2, t.seg() + 2, '{corte}') d));

-- ═════════ 4. CONFLITOS ═════════
select t.ok('4a reserva confirmada direto (sem pagamento)', (t.reserva('{corte}', 'danillo', t.ts('10:00')) ->> 'status') = 'confirmado');
select t.ok('4b mesmo horário recusado', t.tenta($$select t.reserva('{corte}', 'danillo', t.ts('10:00'))$$) like '%HORARIO_INDISPONIVEL%');
select t.ok('4c sobreposição parcial recusada', t.tenta($$select t.reserva('{corte-barba}', 'danillo', t.ts('09:30'))$$) like '%HORARIO_INDISPONIVEL%');
select t.ok('4d "qualquer barbeiro" cai no André', (t.reserva('{corte}', null, t.ts('10:00'), '62999990001') -> 'profissional' ->> 'id') = 'andre');
select t.ok('4e fora da grade (10:10) recusado', t.tenta($$select t.reserva('{corte}', 'danillo', t.ts('10:10'))$$) like '%HORARIO_INDISPONIVEL%');
select t.ok('4f no bloqueio recusado', t.tenta($$select t.reserva('{corte}', 'danillo', t.ts('14:00'))$$) like '%HORARIO_INDISPONIVEL%');
reset role;
select t.ok('4g o banco impede sobreposição mesmo fora da função',
  t.tenta($$insert into agendamentos (codigo, cliente_id, nome_cliente, profissional_id, inicio, fim, ocupado, token_hash)
            select 'NCXXXXXX', cliente_id, 'x', 'danillo', t.ts('10:15'), t.ts('10:45'), tstzrange(t.ts('10:15'), t.ts('10:45')), 'x'
              from agendamentos limit 1$$) like '%agendamentos_sem_conflito%');

-- ═════════ 6/7. DADOS, CRIAÇÃO E CONSULTA ═════════
set role anon;
select t.ok('6a telefone inválido', t.tenta($$select criar_agendamento('{"servicos":["corte"],"inicio":"2030-01-01T10:00:00-03:00","nome":"Ana","telefone":"123"}')$$) like '%TELEFONE_INVALIDO%');
select t.ok('6b nome curto', t.tenta($$select criar_agendamento('{"servicos":["corte"],"inicio":"2030-01-01T10:00:00-03:00","nome":"A","telefone":"62999990000"}')$$) like '%NOME_INVALIDO%');
select t.ok('6c horário inválido', t.tenta($$select criar_agendamento('{"servicos":["corte"],"inicio":"amanha","nome":"Ana","telefone":"62999990000"}')$$) like '%HORARIO_INVALIDO%');
select t.reserva('{corte-cover}', 'danillo', t.ts('11:00'), '62999990002') as r7 \gset
select (:'r7'::jsonb ->> 'codigo') as cod7, (:'r7'::jsonb ->> 'token') as tok7 \gset
select t.ok('7a "a partir de" gravado na reserva', (:'r7'::jsonb ->> 'valor_a_partir')::boolean and (:'r7'::jsonb ->> 'valor_total_centavos')::int = 17000);
select t.ok('7b consulta com token certo', (consultar_agendamento(:'cod7', :'tok7') ->> 'codigo') = :'cod7');
select t.ok('7c token errado negado', t.tenta(format('select consultar_agendamento(%L, %L)', :'cod7', 'errado')) like '%AGENDAMENTO_NAO_ENCONTRADO%');
select t.ok('7d resposta pública sem telefone', not (consultar_agendamento(:'cod7', :'tok7') ? 'telefone'));

-- ═════════ 8. CANCELAMENTO ═════════
select t.reserva('{corte}', 'danillo', t.ts('17:00'), '62999990004') as r8 \gset
select (:'r8'::jsonb ->> 'codigo') as cod8, (:'r8'::jsonb ->> 'token') as tok8 \gset
select t.ok('8a token errado não cancela', t.tenta(format('select cancelar_agendamento(%L, %L)', :'cod8', 'x')) like '%AGENDAMENTO_NAO_ENCONTRADO%');
select t.ok('8b cancela no prazo', (cancelar_agendamento(:'cod8', :'tok8') ->> 'status') = 'cancelado');
select t.ok('8c horário volta a ficar livre', (t.reserva('{corte}', 'danillo', t.ts('17:00'), '62999990005') ->> 'status') = 'confirmado');
select t.ok('8d não cancela duas vezes', t.tenta(format('select cancelar_agendamento(%L, %L)', :'cod8', :'tok8')) like '%AGENDAMENTO_NAO_CANCELAVEL%');
reset role;
-- simula um horário que começa daqui a 1 hora (prazo é de 2 h)
update agendamentos set inicio = now() + interval '1 hour', fim = now() + interval '2 hours' where codigo = :'cod7';
set role anon;
select t.ok('8e fora do prazo recusado', t.tenta(format('select cancelar_agendamento(%L, %L)', :'cod7', :'tok7')) like '%CANCELAMENTO_FORA_DO_PRAZO%');
reset role;
select t.ok('8f histórico registra', (select count(*) >= 2 from historico h join agendamentos a on a.id::text = h.entidade_id where a.codigo = :'cod8'));

-- ═════════ 9-11. PLANO: PEDIDO, ATIVAÇÃO NA BARBEARIA, USO ═════════
select t.como('11111111-1111-1111-1111-111111111111', 'joao@gmail.com');
set role authenticated;
select t.ok('9a sem cadastro não pede plano', t.tenta($$select solicitar_plano('{"plano_id":"plano-bronze","aceite":true,"termos_versao":1}')$$) like '%PERFIL_INCOMPLETO%');
select salvar_perfil('{"nome":"João","telefone":"62988887777"}') is not null as x \gset
select t.ok('9b sem aceite recusado', t.tenta($$select solicitar_plano('{"plano_id":"plano-bronze","aceite":false,"termos_versao":1}')$$) like '%ACEITE_OBRIGATORIO%');
select t.ok('9c versão dos termos errada recusada', t.tenta($$select solicitar_plano('{"plano_id":"plano-bronze","aceite":true,"termos_versao":99}')$$) like '%ACEITE_OBRIGATORIO%');
select solicitar_plano('{"plano_id":"plano-bronze","aceite":true,"termos_versao":1}') as pedido \gset
select :'pedido'::jsonb ->> 'assinatura_id' as ass \gset
select t.ok('9f pedido devolve o link de pagamento da Stone', (:'pedido'::jsonb ->> 'link_pagamento') like 'https://payment-link-v3.stone.com.br/%');
select t.ok('9d pedido fica pendente', (select x->>'status' from jsonb_array_elements(minhas_assinaturas()) x where x->>'id' = :'ass') = 'pendente');
select t.ok('9e não pede o mesmo plano duas vezes', t.tenta($$select solicitar_plano('{"plano_id":"plano-bronze","aceite":true,"termos_versao":1}')$$) like '%ASSINATURA_EXISTENTE%');
select t.ok('10a pendente não dá benefício', (t.reserva('{corte}', 'danillo', t.ts('08:30', 1)) ->> 'desconto_centavos')::int = 0);
select t.ok('10b cliente não ativa o próprio plano', t.tenta(format('select admin_assinatura(%L, %L)', :'ass', 'ativar')) like '%SEM_PERMISSAO%');
reset role;
-- recepção ativa depois de receber no balcão
insert into admins (user_id, papel) values ('22222222-2222-2222-2222-222222222222', 'recepcao');
select t.como('22222222-2222-2222-2222-222222222222');
set role authenticated;
select t.ok('10c recepção vê o pedido pendente em primeiro', (admin_assinaturas() -> 0 ->> 'id') = :'ass' and (admin_assinaturas() -> 0 ->> 'status') = 'pendente');
select t.ok('10d recepção ativa: ciclo de um mês', (select (x->>'status') = 'ativa' and (x->>'ciclo_fim')::date > (x->>'ciclo_inicio')::date
  from admin_assinatura(:'ass', 'ativar') x));
reset role;
select t.como('11111111-1111-1111-1111-111111111111', 'joao@gmail.com');
set role authenticated;
select t.reserva('{corte}', 'danillo', t.ts('10:00', 1)) as r10 \gset
select t.ok('11a corte coberto pelo plano: total zero', (:'r10'::jsonb ->> 'valor_total_centavos')::int = 0 and (:'r10'::jsonb ->> 'coberto_plano')::boolean);
select t.ok('11b segundo corte do mês também coberto', (t.reserva('{corte}', 'danillo', t.ts('11:00', 2)) ->> 'valor_total_centavos')::int = 0);
select t.ok('11c terceiro corte passa do limite: cobrado', (t.reserva('{corte}', 'danillo', t.ts('13:00', 1)) ->> 'valor_total_centavos')::int = 7000);
select t.ok('11d primeira barba coberta', (t.reserva('{barba}', 'danillo', t.ts('10:00', 2)) ->> 'valor_total_centavos')::int = 0);
select t.ok('11e segunda barba cobrada', (t.reserva('{barba}', 'danillo', t.ts('15:00', 1)) ->> 'valor_total_centavos')::int = 6000);
select t.ok('11f cancelar devolve o uso', (cancelar_meu_agendamento(:'r10'::jsonb ->> 'codigo') ->> 'status') = 'cancelado');
select t.ok('11g quinta-feira o plano não vale, mesmo com uso sobrando', (t.reserva('{corte}', 'danillo', t.ts('15:00', 3)) ->> 'valor_total_centavos')::int = 7000);
select t.ok('11h na terça volta a cobrir o corte devolvido', (t.reserva('{corte}', 'danillo', t.ts('16:00', 1)) ->> 'valor_total_centavos')::int = 0);
reset role;
select t.ok('11i usos registrados sem duplicidade', (select count(*) = 3 from utilizacoes where assinatura_id = :'ass' and not estornada));
select t.ok('14r plano no cartão fica marcado para renovar sozinho', (select renova_sozinho from assinaturas where id = :'ass'));
update assinaturas set ciclo_inicio = (now() at time zone 'America/Sao_Paulo')::date - 61, ciclo_fim = (now() at time zone 'America/Sao_Paulo')::date - 31 where id = :'ass';
select atualizar_assinaturas() as x \gset
select t.ok('14s cobrança no cartão: o mês vira sozinho e continua ativo (mesmo atrasado 2 meses)',
  (select status = 'ativa' and ciclo_inicio <= (now() at time zone 'America/Sao_Paulo')::date and ciclo_fim >= (now() at time zone 'America/Sao_Paulo')::date from assinaturas where id = :'ass'));
-- daqui em diante, o caminho do pagamento no balcão (sem renovação automática)
update assinaturas set renova_sozinho = false, ciclo_fim = (now() at time zone 'America/Sao_Paulo')::date - 1 where id = :'ass';
select t.ok('14a rotina de vencimento rodou', atualizar_assinaturas() >= 1);
select t.ok('14a ciclo vencido sem renovar vira "pagamento em atraso"', (select status from assinaturas where id = :'ass') = 'inadimplente');
select t.como('22222222-2222-2222-2222-222222222222');
set role authenticated;
select t.ok('14b renovar atrasado recomeça hoje', (select (x->>'status') = 'ativa' and (x->>'ciclo_inicio')::date = (now() at time zone 'America/Sao_Paulo')::date
  from admin_assinatura(:'ass', 'renovar') x));
select t.ok('14c renovar em dia emenda no ciclo seguinte', (select (x->>'ciclo_inicio')::date > (now() at time zone 'America/Sao_Paulo')::date
  from admin_assinatura(:'ass', 'renovar') x));
select t.ok('14d cancelar encerra', (admin_assinatura(:'ass', 'cancelar') ->> 'status') = 'cancelada');
select t.ok('14e encerrada não reativa', t.tenta(format('select admin_assinatura(%L, %L)', :'ass', 'ativar')) like '%ASSINATURA_ENCERRADA%');
-- recepção não mexe em preço
select t.ok('15a recepção não edita serviço', t.tenta($$select admin_salvar_servico('{"id":"corte","nome":"Corte","categoria":"Cortes","preco_centavos":1}')$$) like '%SEM_PERMISSAO%');
reset role;

-- ═════════ 18. EDIÇÃO PELO DONO ═════════
select t.como('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
set role authenticated;
select t.ok('18a dono altera preço e duração do corte',
  (admin_salvar_servico('{"id":"corte","nome":"Corte","categoria":"Cortes","preco_centavos":7500,"duracao_min":45,"ativo":true}') ->> 'preco_centavos')::int = 7500);
select (admin_salvar_servico('{"nome":"Luzes Platinadas","categoria":"Química & Tratamento","preco_centavos":15000,"preco_a_partir":true,"duracao_min":90}') ->> 'id') as novo_srv \gset
select t.ok('18b cria serviço novo com id gerado do nome', :'novo_srv' = 'luzes-platinadas');
select t.ok('18c serviço inválido recusado', t.tenta($$select admin_salvar_servico('{"nome":"X","preco_centavos":1}')$$) like '%NOME_INVALIDO%');
select t.ok('18d serviço nunca usado é excluído', admin_excluir_servico(:'novo_srv') = 'excluido');
select t.ok('18e serviço nunca usado sai, usado só desativa', admin_excluir_servico('higienizacao') = 'excluido');
select t.ok('18e serviço usado é só desativado', admin_excluir_servico('barba') = 'desativado');
reset role; select t.como('');
set role anon;
select t.ok('18f site já mostra o preço novo e esconde o desativado',
  (select preco_centavos from servicos where id = 'corte') = 7500 and not exists (select 1 from servicos where id = 'barba'));
select t.ok('18g serviço desativado não agenda', t.tenta($$select disponibilidade(t.seg(), '{barba}')$$) like '%SERVICO_INDISPONIVEL%');
reset role;
select t.como('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
set role authenticated;
select admin_salvar_servico('{"id":"barba","nome":"Barba","categoria":"Barba & Sobrancelha","preco_centavos":6000,"duracao_min":45,"ativo":true}') is not null as x \gset
-- plano: mudar condição gera nova versão dos termos
select t.ok('18h alterar preço do plano sobe a versão dos termos',
  (admin_salvar_plano('{"id":"plano-gold","nome":"Plano Gold","preco_centavos":24990,"restricoes":{"dias_semana":[1,2,3]},"regras":"Mediante marcação com antecedência. +10% em qualquer produto da barbearia.","renovacao":"Mensal, pago na barbearia.","servicos":[{"servico_id":"corte"},{"servico_id":"barba"},{"servico_id":"corte-barba"}]}') ->> 'termos_versao')::int = 2);
select t.ok('18i salvar sem mudar condições mantém a versão',
  (admin_salvar_plano('{"id":"plano-gold","nome":"Plano Gold","descricao":"Texto novo","preco_centavos":24990,"restricoes":{"dias_semana":[1,2,3]},"regras":"Mediante marcação com antecedência. +10% em qualquer produto da barbearia.","renovacao":"Mensal, pago na barbearia.","servicos":[{"servico_id":"corte"},{"servico_id":"barba"},{"servico_id":"corte-barba"}]}') ->> 'termos_versao')::int = 2);
select (admin_salvar_plano('{"nome":"Plano Barba","preco_centavos":9900,"limite_usos_ciclo":4,"restricoes":{"dias_semana":[1,2,3]},"servicos":[{"servico_id":"barba","limite_por_ciclo":4}]}') ->> 'id') as pl2 \gset
select t.ok('18j plano novo com limite e dias', :'pl2' = 'plano-barba' and (select limite_por_ciclo = 4 from plano_servicos where plano_id = 'plano-barba'));
select t.ok('18k plano sem serviços recusado', t.tenta($$select admin_salvar_plano('{"nome":"Vazio","preco_centavos":100,"servicos":[]}')$$) like '%PLANO_SEM_SERVICOS%');
select t.ok('18l link de pagamento só https', t.tenta($$select admin_salvar_plano('{"nome":"Link ruim","preco_centavos":100,"link_pagamento":"javascript:alert(1)","servicos":[{"servico_id":"corte"}]}')$$) like '%LINK_INVALIDO%');
select t.ok('18z link e cobrança recorrente salvos pelo painel',
  (select (x->>'link_pagamento') = 'https://exemplo.com/pl' and (x->>'cobranca_recorrente')::boolean
     from admin_salvar_plano(('{"id":"'||:'pl2'||'","nome":"Plano Barba","preco_centavos":9900,"link_pagamento":"https://exemplo.com/pl","cobranca_recorrente":true,"servicos":[{"servico_id":"barba"}]}')::jsonb) x));
-- horários
select admin_salvar_funcionamento('[{"dia_semana":1,"abre":"09:00","fecha":"19:00"},{"dia_semana":2,"abre":"08:30","fecha":"19:00"},{"dia_semana":3,"abre":"08:30","fecha":"19:00"},{"dia_semana":4,"abre":"08:30","fecha":"19:00"},{"dia_semana":5,"abre":"08:30","fecha":"19:00"},{"dia_semana":6,"abre":"08:30","fecha":"17:00"}]'::jsonb) is null as x \gset
select t.ok('18l horário de funcionamento inválido recusado', t.tenta($$select admin_salvar_funcionamento('[{"dia_semana":1,"abre":"19:00","fecha":"09:00"}]')$$) like '%PERIODO_INVALIDO%');
reset role; select t.como('');
set role anon;
select t.ok('18m segunda abrindo 09:00 tira o 08:30 do site', (select min(horario) = t.ts('09:00') from disponibilidade(t.seg(), '{corte}')));
reset role;
select t.como('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
set role authenticated;
-- equipe
select (admin_salvar_profissional('{"nome":"Carlos Henrique"}') ->> 'id') as prof3 \gset
select t.ok('18n barbeiro novo já sai com a jornada da barbearia', :'prof3' = 'carlos' and (select count(*) = 6 from jornadas where profissional_id = 'carlos'));
select t.ok('18o desativar barbeiro some do site', (admin_salvar_profissional('{"id":"carlos","nome":"Carlos Henrique","ativo":false}') ->> 'ativo')::boolean = false);
-- regras
select t.ok('18p altera antecedência e política', (admin_salvar_config('{"antecedencia_min":120,"politica_cancelamento":"Avise com 3 h."}') ->> 'antecedencia_min')::int = 120);
select t.ok('18q valor fora do limite recusado', t.tenta($$select admin_salvar_config('{"passo_min":1}')$$) like '%VALOR_FORA_DO_LIMITE%');
select admin_salvar_config('{"antecedencia_min":60}') is not null as x \gset
-- acessos
select t.ok('18r liberar quem nunca entrou explica', t.tenta($$select admin_liberar_acesso('ninguem@x.com', 'recepcao')$$) like '%USUARIO_NAO_ENCONTRADO%');
select t.ok('18s libera André como barbeiro pelo e-mail', t.tenta($$select admin_liberar_acesso('andre@gmail.com', 'barbeiro', 'andre')$$) = 'OK');
select t.ok('18t barbeiro sem barbeiro escolhido recusado', t.tenta($$select admin_liberar_acesso('bia@gmail.com', 'barbeiro')$$) like '%PROFISSIONAL_OBRIGATORIO%');
select t.ok('18u lista de acessos com e-mails', (select count(*) = 3 from jsonb_array_elements(admin_acessos())));
select t.ok('18v dono não remove a si mesmo', t.tenta($$select admin_remover_acesso('99999999-9999-9999-9999-999999999999')$$) like '%NAO_REMOVE_A_SI_MESMO%');
select t.ok('18w catálogo do painel inclui inativos', (select count(*) = 3 from jsonb_array_elements(admin_catalogo() -> 'profissionais')));
reset role;

-- ═════════ 15. PROTEÇÕES ═════════
select t.como('');
set role anon;
select t.ok('15b anônimo não lê agendamentos', t.tenta('select * from agendamentos') like '%permission denied%');
select t.ok('15c anônimo não lê clientes', t.tenta('select * from clientes') like '%permission denied%');
select t.ok('15d anônimo não usa o painel', t.tenta('select admin_eu()') like '%permission denied%');
select t.ok('15e anônimo não edita serviço', t.tenta($$select admin_salvar_servico('{}')$$) like '%permission denied%');
reset role;
select t.como('11111111-1111-1111-1111-111111111111', 'joao@gmail.com');
set role authenticated;
select t.ok('15g cliente não é do painel', t.tenta('select admin_eu()') like '%SEM_PERMISSAO%');
select t.ok('15h cliente não edita a tabela direto', t.tenta($$update servicos set preco_centavos = 1$$) like '%permission denied%');
select t.ok('15i cliente não lê agendamentos de outros', t.tenta('select count(*) from agendamentos') like '%permission denied%');
reset role;
-- barbeiro André
select t.como('33333333-3333-3333-3333-333333333333', 'andre@gmail.com');
set role authenticated;
select t.ok('15j barbeiro se identifica', (admin_eu() ->> 'profissional_id') = 'andre');
select t.ok('15k barbeiro vê só a própria agenda',
  (select bool_and(e -> 'profissional' ->> 'id' = 'andre') from jsonb_array_elements(admin_agenda(t.seg(), t.seg() + 7)) e));
select t.ok('15l barbeiro não bloqueia o colega', t.tenta($$select admin_bloquear('danillo', t.ts('18:00'), t.ts('18:30'), 'x')$$) like '%SEM_PERMISSAO%');
select t.ok('15m barbeiro bloqueia a própria agenda', t.tenta($$select admin_bloquear('andre', t.ts('18:00'), t.ts('18:30'), 'x')$$) = 'OK');
select t.ok('15n barbeiro não mexe em preço', t.tenta($$select admin_salvar_servico('{"id":"corte","nome":"Corte","preco_centavos":1}')$$) like '%SEM_PERMISSAO%');
select t.ok('15o barbeiro não vê assinantes', t.tenta('select admin_assinaturas()') like '%SEM_PERMISSAO%');
select t.ok('15p barbeiro não libera acessos', t.tenta($$select admin_liberar_acesso('bia@gmail.com', 'dono')$$) like '%SEM_PERMISSAO%');
reset role;
select id as ag_danillo from agendamentos where profissional_id = 'danillo' limit 1 \gset
select t.como('33333333-3333-3333-3333-333333333333', 'andre@gmail.com');
set role authenticated;
select t.ok('15q barbeiro não abre ficha de cliente do colega', t.tenta(format('select admin_cliente(%L)', :'ag_danillo')) like '%SEM_PERMISSAO%');
select t.ok('15r barbeiro marca atendido o que é dele',
  (admin_atualizar_status((select (e->>'id')::uuid from jsonb_array_elements(admin_agenda(t.seg(), t.seg())) e limit 1), 'concluido') ->> 'status') = 'concluido');
reset role;

select t.como('');

-- ═════════ 19. CLIENTES, RESUMO E REGRA DE FALTAS ═════════
select id as cli_joao from clientes where telefone = '62988887777' \gset
select count(*) as n_joao from agendamentos where cliente_id = :'cli_joao' \gset
select t.como('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
set role authenticated;
select t.ok('19a ficha soma o histórico inteiro',
  (select (n->>'marcados')::int = :n_joao
          and (n->>'cancelados_cliente')::int >= 1 from (select admin_ficha(:'cli_joao') -> 'numeros' n) x));
select t.ok('19b busca por parte do WhatsApp', (admin_clientes('8888-7777') -> 0 ->> 'nome') = 'João');
select t.ok('19c busca por nome sem diferenciar maiúsculas', jsonb_array_length(admin_clientes('JOÃO')) = 1);
select t.ok('19d resumo do mês com os dois barbeiros', jsonb_array_length(admin_resumo() -> 'barbeiros') = 2);
reset role;
select t.como('22222222-2222-2222-2222-222222222222');
set role authenticated;
select t.ok('19e recepção vê a lista de clientes', jsonb_array_length(admin_clientes()) >= 1);
select t.ok('19f recepção não vê o resumo com valores', t.tenta('select admin_resumo()') like '%SEM_PERMISSAO%');
reset role;
select t.como('33333333-3333-3333-3333-333333333333', 'andre@gmail.com');
set role authenticated;
select t.ok('19g barbeiro não vê a lista de clientes', t.tenta('select admin_clientes()') like '%SEM_PERMISSAO%');
reset role;
-- cliente novo falta duas vezes
select t.como('55555555-5555-5555-5555-555555555555', 'outro@gmail.com');
set role authenticated;
select salvar_perfil('{"nome":"Carlos Falta","telefone":"62966665555"}') is not null as x \gset
select (t.reserva('{corte}', 'danillo', t.ts('09:00', 4)) ->> 'codigo') as f1 \gset
select (t.reserva('{corte}', 'danillo', t.ts('10:00', 4)) ->> 'codigo') as f2 \gset
select (t.reserva('{corte}', 'danillo', t.ts('11:00', 4)) ->> 'codigo') as f3 \gset
reset role;
select id as cli_carlos from clientes where telefone = '62966665555' \gset
select (select id from agendamentos where codigo = :'f1') as id1, (select id from agendamentos where codigo = :'f2') as id2,
       (select id from agendamentos where codigo = :'f3') as id3 \gset
select t.como('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
set role authenticated;
select admin_atualizar_status(:'id1', 'nao_compareceu') is not null as x \gset
select t.ok('19h uma falta ainda deixa marcar', (admin_ficha(:'cli_carlos') -> 'numeros' ->> 'bloqueado')::boolean = false);
select admin_atualizar_status(:'id2', 'nao_compareceu') is not null as x \gset
select admin_atualizar_status(:'id3', 'cancelado') is not null as x \gset
reset role;
select t.ok('19j cancelamento da barbearia gravado', (select cancelado_por from agendamentos where codigo = :'f3') = 'barbearia');
select t.ok('19k cancelamento do cliente gravado', exists (select 1 from agendamentos where cliente_id = :'cli_joao' and cancelado_por = 'cliente'));
select t.como('55555555-5555-5555-5555-555555555555', 'outro@gmail.com');
set role authenticated;
select t.ok('19l duas faltas: site recusa e manda para o WhatsApp', t.tenta($$select t.reserva('{corte}', 'danillo', t.ts('14:00', 4))$$) like '%MUITAS_FALTAS%');
reset role;
select t.como('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
set role authenticated;
select t.ok('19m ficha mostra o cliente bloqueado', (admin_ficha(:'cli_carlos') -> 'numeros' ->> 'bloqueado')::boolean);
select t.ok('19n lista ordenada por faltas traz ele primeiro', (admin_clientes(null, 'faltas') -> 0 ->> 'nome') = 'Carlos Falta');
select t.ok('19o zerar faltas libera', (admin_zerar_faltas(:'cli_carlos') ->> 'bloqueado')::boolean = false);
select t.ok('19p total de faltas continua no histórico', (admin_ficha(:'cli_carlos') -> 'numeros' ->> 'faltas')::int = 2);
reset role;
select t.como('55555555-5555-5555-5555-555555555555', 'outro@gmail.com');
set role authenticated;
select t.ok('19q depois de zerar, marca de novo', (t.reserva('{corte}', 'danillo', t.ts('14:00', 4)) ->> 'status') = 'confirmado');
reset role;
select t.como('99999999-9999-9999-9999-999999999999', 'dono@nocaute.com');
set role authenticated;
select t.ok('19r regra configurável (0 desliga)', (admin_salvar_config('{"max_faltas":0}') ->> 'max_faltas')::int = 0);
select t.ok('19s limite da regra validado', t.tenta($$select admin_salvar_config('{"max_faltas":50}')$$) like '%VALOR_FORA_DO_LIMITE%');
select t.ok('19t clientes sumidos: ninguém atendido há mais de 45 dias ainda', jsonb_array_length(admin_clientes(null, 'recentes', 45)) = 0);
reset role;
select t.como('');

\echo 'TODOS OS TESTES SQL PASSARAM'
