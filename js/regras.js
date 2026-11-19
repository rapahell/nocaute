/* ════════════════════════════════════════════════════════════
   Regras de negócio puras (sem tela, sem rede).
   Usadas pela interface para cálculos imediatos e pelo modo
   demonstração. Em produção, a palavra final é SEMPRE do servidor
   (supabase/migrations), que repete estas mesmas regras.
   ════════════════════════════════════════════════════════════ */
(function (raiz) {
  'use strict';

  const pad = n => String(n).padStart(2, '0');

  /* ───── datas no fuso da barbearia ───── */
  // "agora" como relógio de parede do fuso, independente do aparelho
  function agoraNoFuso(fuso, base) {
    const d = base || new Date();
    const p = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
    return { data: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
  }
  function chaveParaDate(k) { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function dateParaChave(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  function somarDias(k, n) { const d = chaveParaDate(k); d.setUTCDate(d.getUTCDate() + n); return dateParaChave(d); }
  function diaSemana(k) { return chaveParaDate(k).getUTCDay(); }
  function difDias(a, b) { return Math.round((chaveParaDate(b) - chaveParaDate(a)) / 86400000); }
  const minParaHora = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const horaParaMin = h => { const [a, b] = String(h).split(':').map(Number); return a * 60 + b; };
  // ISO com o deslocamento fixo do fuso (Brasil sem horário de verão desde 2019)
  const isoLocal = (k, min, offset) => `${k}T${minParaHora(min)}:00${offset || '-03:00'}`;

  /* ───── serviços ───── */
  function validarServicos(ids, servicos, cfg) {
    if (!ids || !ids.length) return { ok: false, erro: 'SERVICO_OBRIGATORIO' };
    if (ids.length > 4) return { ok: false, erro: 'SERVICOS_DEMAIS' };
    if (new Set(ids).size !== ids.length) return { ok: false, erro: 'SERVICO_REPETIDO' };
    const sel = ids.map(id => servicos.find(s => s.id === id));
    if (sel.some(s => !s || !s.ativo || s.agendavel_online === false)) return { ok: false, erro: 'SERVICO_INDISPONIVEL' };
    for (let i = 0; i < sel.length; i++) {
      for (let j = i + 1; j < sel.length; j++) {
        const a = sel[i], b = sel[j], ca = a.componentes || [], cb = b.componentes || [];
        if (cb.includes(a.id) || ca.includes(b.id) || ca.some(x => cb.includes(x))) {
          return { ok: false, erro: 'COMBINACAO_INVALIDA', conflito: [a.id, b.id] };
        }
      }
    }
    const duracao = sel.reduce((t, s) => t + (s.duracao_min || cfg.duracao_padrao_min), 0);
    const preco = sel.reduce((t, s) => t + (s.preco_centavos || 0), 0);
    const aConfirmar = sel.some(s => s.preco_centavos == null);
    const aPartir = sel.some(s => s.preco_a_partir);
    const duracaoEstimada = sel.some(s => s.duracao_min == null);
    return { ok: true, duracao, preco, aConfirmar, aPartir, duracaoEstimada };
  }

  // quais outros serviços ficam incompatíveis com a seleção atual
  function incompativeis(ids, servicos) {
    const out = new Set();
    const sel = ids.map(id => servicos.find(s => s.id === id)).filter(Boolean);
    servicos.forEach(s => {
      if (ids.includes(s.id)) return;
      const cs = s.componentes || [];
      if (sel.some(a => { const ca = a.componentes || []; return cs.includes(a.id) || ca.includes(s.id) || ca.some(x => cs.includes(x)); })) out.add(s.id);
    });
    return out;
  }

  /* ───── disponibilidade (mesma lógica de _slot_livre no servidor) ───── */
  // ocupacoes/bloqueios: [{ profissional_id|null, data:'YYYY-MM-DD', ini:min, fim:min }]
  function slotLivre(o) {
    const { prof, data, ini, dur, cfg, funcionamento, jornadas, bloqueios, ocupacoes, agora, profissionais } = o;
    const fim = ini + dur;
    if (fim > 24 * 60) return false;
    const dias = difDias(agora.data, data);
    if (dias < 0 || (dias === 0 && ini < agora.min + cfg.antecedencia_min)) return false;
    if (dias > cfg.janela_dias) return false;
    const p = profissionais.find(x => x.id === prof);
    if (!p || !p.ativo) return false;
    const dow = diaSemana(data);
    const f = funcionamento.find(h => h.dia_semana === dow);
    if (!f || ini < horaParaMin(f.abre) || fim > horaParaMin(f.fecha)) return false;
    // precisa cair na grade da jornada (ex.: 08:30, 09:00, 09:30...)
    if (!jornadas.some(j => j.profissional_id === prof && j.dia_semana === dow
                       && ini >= horaParaMin(j.inicio) && fim <= horaParaMin(j.fim)
                       && (ini - horaParaMin(j.inicio)) % cfg.passo_min === 0)) return false;
    if (bloqueios.some(b => (b.profissional_id == null || b.profissional_id === prof)
                         && b.data === data && b.ini < fim && ini < b.fim)) return false;
    const fimOcupado = fim + cfg.intervalo_entre_min;
    if (ocupacoes.some(a => a.profissional_id === prof && a.data === data && a.ini < fimOcupado && ini < a.fim)) return false;
    return true;
  }

  function horariosLivres(o) {
    const { data, dur, prof, cfg, jornadas, profissionais } = o;
    const dow = diaSemana(data);
    const candidatos = new Set();
    jornadas.filter(j => j.dia_semana === dow && (!prof || j.profissional_id === prof)).forEach(j => {
      for (let m = horaParaMin(j.inicio); m + dur <= horaParaMin(j.fim); m += cfg.passo_min) candidatos.add(m);
    });
    const ativos = profissionais.filter(p => p.ativo && (!prof || p.id === prof)).sort((a, b) => a.ordem - b.ordem);
    return [...candidatos].sort((a, b) => a - b).map(ini => ({
      min: ini,
      hora: minParaHora(ini),
      profissionais: ativos.filter(p => slotLivre(Object.assign({}, o, { prof: p.id, ini }))).map(p => p.id)
    })).filter(s => s.profissionais.length);
  }

  /* ───── planos ───── */
  // devolve os ids de serviço cobertos pela assinatura nesse agendamento
  function coberturaPlano(o) {
    const { assinatura, plano, planoServicos, usosNoCiclo, ids, data, ini, dur } = o;
    if (!assinatura || assinatura.status !== 'ativa') return [];
    if (data < assinatura.ciclo_inicio || data > assinatura.ciclo_fim) return [];
    const r = plano.restricoes || {};
    if (r.dias_semana && r.dias_semana.length && !r.dias_semana.includes(diaSemana(data))) return [];
    if (r.hora_inicio && ini < horaParaMin(r.hora_inicio)) return [];
    if (r.hora_fim && ini + dur > horaParaMin(r.hora_fim)) return [];
    let total = usosNoCiclo.length;
    const cobertos = [];
    planoServicos.filter(ps => ps.plano_id === plano.id && ids.includes(ps.servico_id)).forEach(ps => {
      if (plano.limite_usos_ciclo != null && total >= plano.limite_usos_ciclo) return;
      const usosSrv = usosNoCiclo.filter(u => u.servico_id === ps.servico_id).length;
      if (ps.limite_por_ciclo == null || usosSrv < ps.limite_por_ciclo) { cobertos.push(ps.servico_id); total++; }
    });
    return cobertos;
  }

  /* ───── validação de dados do cliente ───── */
  const soDigitos = v => String(v || '').replace(/\D/g, '');
  const validarNome = v => { const n = String(v || '').trim(); return n.length >= 2 && n.length <= 120; };
  const validarTelefone = v => /^[1-9][0-9]{9,10}$/.test(soDigitos(v));
  const validarEmail = v => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim());
  function validarCPF(v) {
    const c = soDigitos(v);
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    for (let t = 9; t < 11; t++) {
      let s = 0;
      for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
      if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
    }
    return true;
  }
  function mascaraTelefone(v) {
    const n = soDigitos(v).slice(0, 11);
    if (n.length <= 2) return n.length ? `(${n}` : '';
    if (n.length <= 6) return `(${n.slice(0, 2)}) ${n.slice(2)}`;
    if (n.length <= 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
    return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  }
  function mascaraCPF(v) {
    const n = soDigitos(v).slice(0, 11);
    return n.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }

  /* ───── formatação ───── */
  const fmtPreco = c => c == null ? null : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: c % 100 ? 2 : 0 });
  // "R$ 170" / "a partir de R$ 170" / "a confirmar"
  const fmtPrecoServico = s => s.preco_centavos == null ? 'a confirmar' : (s.preco_a_partir ? 'a partir de ' : '') + fmtPreco(s.preco_centavos);
  function fmtDur(m) {
    if (m == null) return null;
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
  }

  const API = {
    agoraNoFuso, somarDias, diaSemana, difDias, minParaHora, horaParaMin, isoLocal,
    validarServicos, incompativeis, slotLivre, horariosLivres, coberturaPlano,
    soDigitos, validarNome, validarTelefone, validarEmail, validarCPF, mascaraTelefone, mascaraCPF,
    fmtPreco, fmtPrecoServico, fmtDur
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else raiz.NC_Regras = API;
})(typeof window !== 'undefined' ? window : globalThis);
