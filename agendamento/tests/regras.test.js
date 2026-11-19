// Testes das regras do navegador (mesma lógica do servidor). Rodar: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const R = require('../js/regras.js');

global.window = {};
require('../js/config.js');
const D = global.window.NC_CONFIG.demo;
// a equipe começa só com o Danillo; os testes usam um segundo barbeiro, como o dono cadastraria no painel
D.profissionais.push({ id: 'andre', nome: 'André Luiz', cargo: 'Barbeiro', ordem: 2, ativo: true, especialidades: [] });
const cfg = D.config;

const segunda = '2026-11-02';             // uma segunda-feira
const agora = { data: '2026-10-30', min: 600 };
const base = (o) => Object.assign({ data: segunda, cfg, funcionamento: D.funcionamento, jornadas: D.jornadas,
  profissionais: D.profissionais, bloqueios: [], ocupacoes: [], agora }, o);

test('1. combinação de serviços', () => {
  assert.ok(R.validarServicos(['corte', 'barba'], D.servicos, cfg).ok);
  assert.equal(R.validarServicos(['corte-barba', 'corte'], D.servicos, cfg).erro, 'COMBINACAO_INVALIDA');
  assert.equal(R.validarServicos(['corte-barba', 'combo'], D.servicos, cfg).erro, 'COMBINACAO_INVALIDA');
  assert.equal(R.validarServicos(['corte', 'corte'], D.servicos, cfg).erro, 'SERVICO_REPETIDO');
  assert.equal(R.validarServicos([], D.servicos, cfg).erro, 'SERVICO_OBRIGATORIO');
  assert.equal(R.validarServicos(['a', 'b', 'c', 'd', 'e'], D.servicos, cfg).erro, 'SERVICOS_DEMAIS');
  assert.ok(R.incompativeis(['corte'], D.servicos).has('corte-barba'));
  assert.ok(!R.incompativeis(['corte'], D.servicos).has('barba'));
});

test('2. preço e duração somados', () => {
  const v = R.validarServicos(['corte', 'barba'], D.servicos, cfg);
  assert.equal(v.duracao, 85); assert.equal(v.preco, 13000); assert.equal(v.aConfirmar, false); assert.equal(v.aPartir, false);
  assert.equal(R.validarServicos(['corte-cover'], D.servicos, cfg).aPartir, true);                  // "a partir de R$ 170"
  assert.equal(R.fmtPrecoServico(D.servicos.find(s => s.id === 'corte-cover')), 'a partir de R$ 170');
  // serviço sem preço/duração cadastrados (o dono pode deixar em branco no painel)
  const extra = D.servicos.concat([{ id: 'novo', nome: 'Novo', ativo: true, preco_centavos: null, duracao_min: null, componentes: [] }]);
  const w = R.validarServicos(['corte', 'novo'], extra, cfg);
  assert.equal(w.duracao, 70); assert.equal(w.preco, 7000); assert.equal(w.aConfirmar, true); assert.equal(w.duracaoEstimada, true);
});

test('3. horários disponíveis (08h30 às 19h, sábado até 17h)', () => {
  const s = R.horariosLivres(base({ dur: 30 }));
  assert.equal(s[0].hora, '08:30'); assert.equal(s[s.length - 1].hora, '18:30');
  assert.deepEqual(s[0].profissionais, ['danillo', 'andre']);
  assert.equal(R.horariosLivres(base({ dur: 60 })).slice(-1)[0].hora, '18:00');
  assert.equal(R.horariosLivres(base({ dur: 30, data: '2026-11-07' })).slice(-1)[0].hora, '16:30');   // sábado
  assert.equal(R.horariosLivres(base({ dur: 30, data: '2026-11-01' })).length, 0);                    // domingo
  // hoje, 10:00 + 1h de antecedência: primeiro horário 11:00
  assert.equal(R.horariosLivres(base({ dur: 30, data: '2026-10-30' }))[0].hora, '11:00');
  // fora da janela de 30 dias
  assert.equal(R.horariosLivres(base({ dur: 30, data: '2026-12-15' })).length, 0);
  // almoço configurado no painel (jornada partida) tira 12h e 12h30
  const jorn = D.jornadas.filter(j => !(j.profissional_id === 'andre' && j.dia_semana === 1))
    .concat([{ profissional_id: 'andre', dia_semana: 1, inicio: '08:30', fim: '12:00' }, { profissional_id: 'andre', dia_semana: 1, inicio: '13:00', fim: '19:00' }]);
  const sj = R.horariosLivres(base({ dur: 30, jornadas: jorn }));
  assert.deepEqual(sj.find(x => x.hora === '12:00').profissionais, ['danillo']);
  assert.deepEqual(sj.find(x => x.hora === '13:00').profissionais, ['danillo', 'andre']);
});

test('4. ocupação e bloqueio removem horários', () => {
  const oc = [{ profissional_id: 'danillo', data: segunda, ini: 600, fim: 660 }];
  const s = R.horariosLivres(base({ dur: 30, ocupacoes: oc }));
  assert.deepEqual(s.find(x => x.hora === '10:00').profissionais, ['andre']);
  assert.deepEqual(s.find(x => x.hora === '09:30').profissionais, ['danillo', 'andre']);
  const s2 = R.horariosLivres(base({ dur: 60, ocupacoes: oc }));
  assert.deepEqual(s2.find(x => x.hora === '09:30').profissionais, ['andre']);   // 09:30-10:30 invade
  const bl = [{ profissional_id: null, data: segunda, ini: 720, fim: 780 }];
  assert.ok(!R.horariosLivres(base({ dur: 30, bloqueios: bl })).some(x => x.hora === '12:00'));
  assert.ok(!R.slotLivre(base({ prof: 'danillo', ini: 610, dur: 30 })));   // fora do passo
  assert.ok(!R.slotLivre(base({ prof: 'danillo', ini: 540 + 15, dur: 30 })));  // 09:15 fora da grade de 08:30
});

test('10/11. cobertura de plano respeita limites e restrições', () => {
  const ass = { status: 'ativa', ciclo_inicio: '2026-11-01', ciclo_fim: '2026-11-30' };
  // planos reais: Bronze (2 cortes, 1 barba) e Gold (ilimitado), de segunda a quarta
  const planoReal = id => D.planos.find(p => p.id === id);
  const usa = (id, ids, usos, data) => R.coberturaPlano({ assinatura: ass, plano: planoReal(id), planoServicos: D.planoServicos,
    usosNoCiclo: usos || [], ids, data: data || segunda, ini: 600, dur: 30 });
  const vezes = (srv, n) => Array.from({ length: n }, () => ({ servico_id: srv }));
  assert.deepEqual(usa('plano-bronze', ['corte', 'barba']), ['corte', 'barba']);
  assert.deepEqual(usa('plano-bronze', ['corte'], vezes('corte', 2)), []);                          // 3º corte
  assert.deepEqual(usa('plano-bronze', ['corte', 'barba'], vezes('barba', 1)), ['corte']);          // 2ª barba
  assert.deepEqual(usa('plano-bronze', ['corte'], [], '2026-11-05'), []);                           // quinta não vale
  assert.deepEqual(usa('plano-gold', ['corte', 'barba'], vezes('corte', 20).concat(vezes('barba', 20))), ['corte', 'barba']);
  assert.deepEqual(usa('plano-gold', ['corte-barba'], [], '2026-11-04'), ['corte-barba']);         // quarta, combo
  assert.deepEqual(usa('plano-gold', ['corte'], [], '2026-11-07'), []);                             // sábado não vale
  // plano montado no painel: barba 2x/mês, total 4, só seg a sex
  const plano = { id: 'teste', limite_usos_ciclo: 4, restricoes: { dias_semana: [1, 2, 3, 4, 5] } };
  const ps = [{ plano_id: 'teste', servico_id: 'corte', limite_por_ciclo: null }, { plano_id: 'teste', servico_id: 'barba', limite_por_ciclo: 2 }];
  const o = (ids, usos, data) => R.coberturaPlano({ assinatura: ass, plano, planoServicos: ps,
    usosNoCiclo: usos || [], ids, data: data || segunda, ini: 600, dur: 30 });
  assert.deepEqual(o(['corte', 'barba']), ['corte', 'barba']);
  assert.deepEqual(o(['barba'], [{ servico_id: 'barba' }, { servico_id: 'barba' }]), []);          // limite do serviço
  assert.deepEqual(o(['corte'], [1, 2, 3, 4].map(() => ({ servico_id: 'x' }))), []);               // limite total
  assert.deepEqual(o(['corte'], [], '2026-11-07'), []);                                             // sábado não
  assert.deepEqual(o(['corte'], [], '2026-12-02'), []);                                             // fora do ciclo
  for (const st of ['pendente', 'inadimplente', 'cancelada'])                                       // só ativa cobre
    assert.deepEqual(R.coberturaPlano({ assinatura: Object.assign({}, ass, { status: st }), plano, planoServicos: ps,
      usosNoCiclo: [], ids: ['corte'], data: segunda, ini: 600, dur: 30 }), []);
});

test('6. validação de dados do cliente', () => {
  assert.ok(R.validarTelefone('(62) 98293-4041')); assert.ok(!R.validarTelefone('123'));
  assert.ok(!R.validarTelefone('(02) 98293-4041'));
  assert.ok(R.validarNome('Ana')); assert.ok(!R.validarNome('A'));
  assert.ok(R.validarEmail('')); assert.ok(R.validarEmail('a@b.co')); assert.ok(!R.validarEmail('a@b'));
  assert.ok(R.validarCPF('529.982.247-25')); assert.ok(!R.validarCPF('111.111.111-11')); assert.ok(!R.validarCPF('529.982.247-24'));
  assert.equal(R.mascaraTelefone('62982934041'), '(62) 98293-4041');
  assert.equal(R.mascaraCPF('52998224725'), '529.982.247-25');
});

test('datas no fuso de Goiânia, independente do aparelho', () => {
  // 00:30 UTC do dia 17 = 21:30 do dia 16 em Goiânia
  assert.deepEqual(R.agoraNoFuso('America/Sao_Paulo', new Date('2026-10-17T00:30:00Z')), { data: '2026-10-16', min: 1290 });
  assert.equal(R.somarDias('2026-10-31', 1), '2026-11-01');
  assert.equal(R.diaSemana('2026-11-02'), 1);
  assert.equal(R.isoLocal('2026-11-02', 570, '-03:00'), '2026-11-02T09:30:00-03:00');
  assert.equal(R.fmtPreco(13000).replace(/\s/g, ' '), 'R$ 130');
  assert.equal(R.fmtDur(75), '1 h 15 min');
});
