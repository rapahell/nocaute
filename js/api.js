/* ════════════════════════════════════════════════════════════
   Camada de dados. Site e painel conversam só com
   NC_API.criar(config), que devolve as mesmas funções nos modos:
   • demo      → tudo no navegador (localStorage), sem servidor.
   • supabase  → funções do banco (Supabase).
   ════════════════════════════════════════════════════════════ */
(function (raiz) {
  'use strict';
  const R = raiz.NC_Regras;

  function Erro(codigo, extra) {
    const e = new Error(codigo);
    e.codigo = codigo;
    if (extra) Object.assign(e, extra);
    return e;
  }

  /* ════════════════ MODO SUPABASE ════════════════ */
  function criarSupabase(cfg) {
    const base = cfg.supabaseUrl.replace(/\/$/, '');
    const CHAVE_SESSAO = 'nc_sessao';

    function sessao() {
      try {
        const s = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || 'null');
        if (s && s.expira > Date.now()) return s;
      } catch (e) { /* armazenamento indisponível */ }
      return null;
    }
    function salvarSessao(s) { try { localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s)); } catch (e) {} }

    async function chamar(url, opcoes) {
      const s = sessao();
      // chave pública só no cabeçalho apikey (vale para a chave nova "publishable" e para a antiga "anon");
      // o token do usuário vai em Authorization só quando há alguém logado
      const headers = Object.assign({ apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
        s ? { Authorization: 'Bearer ' + s.access_token } : {}, (opcoes && opcoes.headers) || {});
      let r;
      try { r = await fetch(url, Object.assign({}, opcoes, { headers })); }
      catch (e) { throw Erro('SEM_CONEXAO'); }
      const txt = await r.text();
      let dados = null;
      try { dados = txt ? JSON.parse(txt) : null; } catch (e) { dados = txt; }
      if (!r.ok) {
        const msg = (dados && (dados.message || dados.erro || dados.error_description || dados.msg)) || 'ERRO_SERVIDOR';
        const codigo = /^[A-Z_]+$/.test(msg) ? msg : (r.status === 401 || r.status === 403 ? 'SEM_PERMISSAO' : 'ERRO_SERVIDOR');
        throw Erro(codigo, { detalhe: msg, status: r.status });
      }
      return dados;
    }
    const rpc = (fn, args) => chamar(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}) });
    const tabela = (t, q) => chamar(`${base}/rest/v1/${t}?${q}`, { method: 'GET' });

    async function guardarTokens(t) {
      const r = await fetch(`${base}/auth/v1/user`, { headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + t.access_token } });
      if (!r.ok) throw Erro('LOGIN_CANCELADO');
      const u = await r.json();
      const meta = u.user_metadata || {};
      salvarSessao({ access_token: t.access_token, refresh_token: t.refresh_token, email: u.email,
                     nome: meta.full_name || meta.name || null, expira: Date.now() + ((t.expires_in || 3600) - 60) * 1000 });
    }

    return {
      modo: 'supabase',
      async catalogo() {
        const [config, servicos, profissionais, funcionamento, jornadas, planos, planoServicos] = await Promise.all([
          tabela('config', 'select=*'),
          tabela('servicos', 'select=*&ativo=eq.true&order=ordem'),
          tabela('profissionais', 'select=*&ativo=eq.true&order=ordem'),
          tabela('horarios_funcionamento', 'select=*'),
          tabela('jornadas', 'select=*'),
          tabela('planos', 'select=*&ativo=eq.true&order=ordem'),
          tabela('plano_servicos', 'select=*')
        ]);
        return { config: config[0], servicos, profissionais, funcionamento, jornadas, planos, planoServicos };
      },
      diasDisponiveis: (de, ate, servicos, prof) =>
        rpc('dias_disponiveis', { p_de: de, p_ate: ate, p_servicos: servicos, p_profissional: prof || null }),
      async disponibilidade(data, servicos, prof) {
        const r = await rpc('disponibilidade', { p_data: data, p_servicos: servicos, p_profissional: prof || null });
        return r.map(x => {
          const local = R.agoraNoFuso(cfg.fuso, new Date(x.horario));
          return { hora: R.minParaHora(local.min), min: local.min, inicio: x.horario, profissionais: x.profissionais_livres };
        });
      },
      criarAgendamento: dados => rpc('criar_agendamento', { p: dados }),
      consultar: (codigo, token) => rpc('consultar_agendamento', { p_codigo: codigo, p_token: token }),
      cancelar: (codigo, token) => rpc('cancelar_agendamento', { p_codigo: codigo, p_token: token, p_motivo: 'cancelado pelo cliente' }),
      cancelarLogado: codigo => rpc('cancelar_meu_agendamento', { p_codigo: codigo }),

      // ── login: Google (OAuth do Supabase) ou código no e-mail ──
      sessao,
      entrarGoogle() {
        const volta = location.href.split('#')[0];
        location.href = `${base}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(volta)}`;
        return new Promise(() => {});
      },
      async capturarRetornoOAuth() {
        const h = new URLSearchParams(location.hash.slice(1));
        if (h.get('error_description')) { history.replaceState(null, '', location.pathname + location.search); throw Erro('LOGIN_CANCELADO'); }
        if (!h.get('access_token')) return false;
        history.replaceState(null, '', location.pathname + location.search);
        await guardarTokens({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: Number(h.get('expires_in') || 3600) });
        return true;
      },
      async renovarSessao() {
        let s = null;
        try { s = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || 'null'); } catch (e) {}
        if (!s || s.expira > Date.now() || !s.refresh_token) return;
        try { await guardarTokens(await chamar(`${base}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', body: JSON.stringify({ refresh_token: s.refresh_token }) })); }
        catch (e) { this.sair(); }
      },
      async enviarCodigo(email) {
        await chamar(`${base}/auth/v1/otp`, { method: 'POST', body: JSON.stringify({ email, create_user: true }) });
        return { demo: false };
      },
      async verificarCodigo(email, codigo) {
        await guardarTokens(await chamar(`${base}/auth/v1/verify`, { method: 'POST', body: JSON.stringify({ type: 'email', email, token: codigo }) }));
        return sessao();
      },
      sair() { try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) {} },
      perfil: () => rpc('meu_perfil'),
      salvarPerfil: dados => rpc('salvar_perfil', { p: dados }),
      meusAgendamentos: () => rpc('meus_agendamentos'),
      minhasAssinaturas: () => rpc('minhas_assinaturas'),
      solicitarPlano: dados => rpc('solicitar_plano', { p: dados }),
      cancelarAssinatura: id => rpc('cancelar_assinatura', { p_id: id }),

      // ── painel ──
      adminEu: () => rpc('admin_eu'),
      adminAgenda: (de, ate, prof) => rpc('admin_agenda', { p_de: de, p_ate: ate, p_profissional: prof || null, p_status: null }),
      adminBloqueios: (de, ate, prof) => rpc('admin_bloqueios', { p_de: de, p_ate: ate, p_profissional: prof || null }),
      adminBloquear: (prof, inicio, fim, motivo) => rpc('admin_bloquear', { p_profissional: prof || null, p_inicio: inicio, p_fim: fim, p_motivo: motivo }),
      adminRemoverBloqueio: id => rpc('admin_remover_bloqueio', { p_id: id }),
      adminStatus: (id, status, motivo) => rpc('admin_atualizar_status', { p_id: id, p_status: status, p_motivo: motivo || null }),
      adminCliente: id => rpc('admin_cliente', { p_agendamento: id }),
      adminCatalogo: () => rpc('admin_catalogo'),
      adminSalvarServico: s => rpc('admin_salvar_servico', { p: s }),
      adminExcluirServico: id => rpc('admin_excluir_servico', { p_id: id }),
      adminSalvarPlano: p => rpc('admin_salvar_plano', { p }),
      adminSalvarFuncionamento: lista => rpc('admin_salvar_funcionamento', { p: lista }),
      adminSalvarJornada: (prof, lista) => rpc('admin_salvar_jornada', { p_profissional: prof, p: lista }),
      adminSalvarProfissional: p => rpc('admin_salvar_profissional', { p }),
      adminSalvarConfig: c => rpc('admin_salvar_config', { p: c }),
      adminFicha: id => rpc('admin_ficha', { p_cliente: id }),
      adminClientes: (busca, ordem, sumidos) => rpc('admin_clientes', { p_busca: busca || null, p_ordem: ordem || 'recentes', p_sumidos_dias: sumidos || null }),
      adminResumo: mes => rpc('admin_resumo', { p_mes: mes || null }),
      adminZerarFaltas: id => rpc('admin_zerar_faltas', { p_cliente: id }),
      adminAcessos: () => rpc('admin_acessos'),
      adminLiberarAcesso: (email, papel, prof) => rpc('admin_liberar_acesso', { p_email: email, p_papel: papel, p_profissional: prof || null }),
      adminRemoverAcesso: uid => rpc('admin_remover_acesso', { p_user: uid }),
      adminAssinaturas: () => rpc('admin_assinaturas'),
      adminAssinatura: (id, acao) => rpc('admin_assinatura', { p_id: id, p_acao: acao })
    };
  }

  /* ════════════════ MODO DEMONSTRAÇÃO ════════════════ */
  function criarDemo(cfg) {
    const D = cfg.demo;
    const CHAVE = 'nc_demo_v5';
    // site e painel guardam o login separado: dá para apresentar os dois lado a lado
    const SESS = (typeof location !== 'undefined' && /admin\.html$/.test(location.pathname)) ? 'sessaoPainel' : 'sessao';
    const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const novoId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
    const copia = o => JSON.parse(JSON.stringify(o));
    const slug = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

    // cada operação relê o armazenamento: duas abas abertas enxergam uma à outra
    let memoria = null;
    function sync() { try { const s = JSON.parse(localStorage.getItem(CHAVE) || 'null'); if (s) memoria = s; } catch (e) {} }
    function ler() {
      if (!memoria) sync();
      if (!memoria) {
        memoria = { clientes: [], agendamentos: [], assinaturas: [], utilizacoes: [], bloqueios: [], sessao: null,
                    acessos: [], historico: [],
                    cat: { config: copia(D.config), servicos: copia(D.servicos), profissionais: copia(D.profissionais),
                           funcionamento: copia(D.funcionamento), jornadas: copia(D.jornadas), planos: copia(D.planos),
                           planoServicos: copia(D.planoServicos) } };
      }
      return memoria;
    }
    const K = () => ler().cat;
    function gravar() { try { localStorage.setItem(CHAVE, JSON.stringify(memoria)); } catch (e) {} }
    const espera = ms => new Promise(r => setTimeout(r, ms || 200 + Math.random() * 200)).then(sync);
    const agora = () => R.agoraNoFuso(cfg.fuso);
    const ativosAg = () => ler().agendamentos.filter(a => a.status === 'confirmado');
    const ocupacoes = () => ativosAg().map(a => ({ profissional_id: a.profissional_id, data: a.data, ini: a.ini, fim: a.fim + K().config.intervalo_entre_min }));
    function contexto(ids) {
      const v = R.validarServicos(ids, K().servicos, K().config);
      if (!v.ok) throw Erro(v.erro);
      return v;
    }
    const base = (data, dur, prof) => ({ data, dur, prof, cfg: K().config, funcionamento: K().funcionamento, jornadas: K().jornadas,
      profissionais: K().profissionais, bloqueios: ler().bloqueios, ocupacoes: ocupacoes(), agora: agora() });
    function agJson(a) {
      const p = K().profissionais.find(x => x.id === a.profissional_id) || { id: a.profissional_id, nome: a.profissional_id };
      const limite = new Date(a.inicio).getTime() - K().config.cancelamento_antecedencia_h * 3600000;
      return { codigo: a.codigo, status: a.status, inicio: a.inicio, fim: a.fim_iso, profissional: { id: p.id, nome: p.nome },
               nome_cliente: a.nome_cliente, itens: a.itens, valor_bruto_centavos: a.valor_bruto, desconto_centavos: a.desconto,
               valor_total_centavos: a.total, valor_a_confirmar: a.a_confirmar, valor_a_partir: a.a_partir,
               coberto_plano: !!a.assinatura_id, pode_cancelar: a.status === 'confirmado' && Date.now() <= limite };
    }
    function porToken(codigo, token) {
      const a = ler().agendamentos.find(x => x.codigo === String(codigo || '').trim().toUpperCase());
      if (!a || a.token !== token) throw Erro('AGENDAMENTO_NAO_ENCONTRADO');
      return a;
    }
    function clienteLogado() {
      const db = ler();
      if (!db[SESS]) return null;
      return db.clientes.find(c => c.user_email === db[SESS].email) || db.clientes.find(c => c.email === db[SESS].email && !c.user_email) || null;
    }
    function cancelarInterno(a, por) {
      if (a.status !== 'confirmado') throw Erro('AGENDAMENTO_NAO_CANCELAVEL');
      a.status = 'cancelado'; a.cancelado_por = por || 'cliente'; a.atualizado_em = Date.now();
      ler().utilizacoes.forEach(u => { if (u.agendamento_id === a.id) u.estornada = true; });
      gravar();
      return agJson(a);
    }
    // mesma regra do banco: faltas dos últimos 6 meses registradas depois da última vez que a barbearia zerou
    const maxFaltas = () => K().config.max_faltas ?? 2;
    function faltasRecentes(cli) {
      const corte = Date.now() - 180 * 86400000;
      return ler().agendamentos.filter(a => a.cliente_id === cli.id && a.status === 'nao_compareceu'
        && new Date(a.inicio).getTime() > corte && (a.atualizado_em || 0) > (cli.faltas_zeradas_em || 0)).length;
    }
    function numeros(cli) {
      const dele = ler().agendamentos.filter(a => a.cliente_id === cli.id), agoraMs = Date.now();
      const conta = f => dele.filter(f).length;
      const atendidos = dele.filter(a => a.status === 'concluido').map(a => a.inicio).sort();
      const futuros = dele.filter(a => a.status === 'confirmado' && new Date(a.inicio).getTime() > agoraMs).map(a => a.inicio).sort();
      const fr = faltasRecentes(cli);
      return { marcados: dele.length, atendidos: atendidos.length,
               cancelados_cliente: conta(a => a.status === 'cancelado' && a.cancelado_por !== 'barbearia'),
               cancelados_barbearia: conta(a => a.status === 'cancelado' && a.cancelado_por === 'barbearia'),
               faltas: conta(a => a.status === 'nao_compareceu'), ultima_visita: atendidos[atendidos.length - 1] || null,
               proximo: futuros[0] || null, faltas_recentes: fr, bloqueado: maxFaltas() > 0 && fr >= maxFaltas() };
    }
    function ficha(c) {
      const db = ler();
      const dele = db.agendamentos.filter(x => x.cliente_id === c.id).sort((x, y) => y.inicio.localeCompare(x.inicio));
      const s = db.assinaturas.find(x => x.cliente_id === c.id && ['pendente', 'ativa', 'inadimplente'].includes(x.status));
      const n = numeros(c);
      return { cliente_id: c.id, nome: c.nome, telefone: c.telefone, email: c.user_email || null, atendimentos: n.atendidos, numeros: n,
               plano: s ? `${(K().planos.find(p => p.id === s.plano_id) || {}).nome} · ${s.status}` : null,
               historico: dele.slice(0, 12).map(x => Object.assign(agJson(x), { cancelado_por: x.cancelado_por || null })), registro: [] };
    }
    function eu() {
      const s = ler()[SESS];
      if (!s || !s.admin) throw Erro('SEM_PERMISSAO');
      return s.admin;
    }
    const exigirDono = () => { if (eu().papel !== 'dono') throw Erro('SEM_PERMISSAO'); };
    function atualizarAssinaturas() {
      const hoje = agora().data;
      ler().assinaturas.forEach(s => {
        // cobrança recorrente no cartão: o mês vira sozinho até a barbearia cancelar
        while (s.status === 'ativa' && s.renova_sozinho && s.ciclo_fim < hoje) { s.ciclo_inicio = R.somarDias(s.ciclo_fim, 1); s.ciclo_fim = umMes(s.ciclo_inicio); }
        if (s.status === 'ativa' && s.ciclo_fim < hoje) s.status = 'inadimplente';
      });
    }
    const umMes = ini => { const d = new Date(ini + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

    return {
      modo: 'demo',
      async catalogo() {
        await espera(120);
        const c = K();
        return { config: c.config, servicos: c.servicos.filter(s => s.ativo), profissionais: c.profissionais.filter(p => p.ativo),
                 funcionamento: c.funcionamento, jornadas: c.jornadas, planos: c.planos.filter(p => p.ativo), planoServicos: c.planoServicos };
      },
      async diasDisponiveis(de, ate, ids, prof) {
        await espera();
        const { duracao } = contexto(ids);
        const out = [];
        for (let d = de; d <= ate; d = R.somarDias(d, 1)) if (R.horariosLivres(base(d, duracao, prof)).length) out.push(d);
        return out;
      },
      async disponibilidade(data, ids, prof) {
        await espera();
        const { duracao } = contexto(ids);
        return R.horariosLivres(base(data, duracao, prof)).map(s => Object.assign(s, { inicio: R.isoLocal(data, s.min, cfg.offset) }));
      },
      async criarAgendamento(p) {
        await espera(400);
        const db = ler(), c = K().config;
        if (!db[SESS]) {
          if (c.exigir_login !== false) throw Erro('LOGIN_NECESSARIO');
          if (!R.validarNome(p.nome)) throw Erro('NOME_INVALIDO');
          if (!R.validarTelefone(p.telefone)) throw Erro('TELEFONE_INVALIDO');
        }
        const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(p.inicio || '');
        if (!m) throw Erro('HORARIO_INVALIDO');
        const v = contexto(p.servicos);
        const data = m[1], ini = R.horaParaMin(m[2]);
        const contar = id => ativosAg().filter(z => z.profissional_id === id && z.data === data).length;
        const escolhido = K().profissionais.filter(x => x.ativo && (!p.profissional || x.id === p.profissional))
          .sort((a, b) => contar(a.id) - contar(b.id) || a.ordem - b.ordem)
          .find(x => R.slotLivre(Object.assign(base(data, v.duracao), { prof: x.id, ini })));
        if (!escolhido) throw Erro('HORARIO_INDISPONIVEL');

        let cli;
        if (db[SESS]) {
          cli = clienteLogado();
          if (!cli) throw Erro('PERFIL_INCOMPLETO');
          cli.user_email = db[SESS].email;
        } else {
          const tel = R.soDigitos(p.telefone);
          cli = db.clientes.find(x => x.telefone === tel);
          if (!cli) { cli = { id: novoId(), nome: p.nome.trim(), telefone: tel, criado_em: Date.now() }; db.clientes.push(cli); }
        }
        if (maxFaltas() > 0 && faltasRecentes(cli) >= maxFaltas()) throw Erro('MUITAS_FALTAS');
        let cobertos = [], ass = null;
        if (db[SESS]) {
          atualizarAssinaturas();
          ass = db.assinaturas.find(s => s.cliente_id === cli.id && s.status === 'ativa' && data >= s.ciclo_inicio && data <= s.ciclo_fim);
          if (ass) {
            const plano = K().planos.find(x => x.id === ass.plano_id);
            cobertos = R.coberturaPlano({ assinatura: ass, plano, planoServicos: K().planoServicos,
              usosNoCiclo: db.utilizacoes.filter(u => u.assinatura_id === ass.id && u.ciclo_inicio === ass.ciclo_inicio && !u.estornada),
              ids: p.servicos, data, ini, dur: v.duracao });
          }
        }
        const sel = K().servicos.filter(s => p.servicos.includes(s.id));
        const desconto = sel.filter(s => cobertos.includes(s.id)).reduce((t, s) => t + (s.preco_centavos || 0), 0);
        let codigo;
        do { codigo = 'NC' + Array.from({ length: 6 }, () => ALFA[Math.floor(Math.random() * ALFA.length)]).join(''); }
        while (db.agendamentos.some(x => x.codigo === codigo));
        const a = {
          id: novoId(), codigo, token: novoId() + novoId(), cliente_id: cli.id, nome_cliente: cli.nome,
          profissional_id: escolhido.id, data, ini, fim: ini + v.duracao,
          inicio: R.isoLocal(data, ini, cfg.offset), fim_iso: R.isoLocal(data, ini + v.duracao, cfg.offset),
          status: 'confirmado', valor_bruto: v.preco, desconto, total: Math.max(v.preco - desconto, 0),
          a_confirmar: sel.some(s => s.preco_centavos == null && !cobertos.includes(s.id)),
          a_partir: sel.some(s => s.preco_a_partir && !cobertos.includes(s.id)),
          assinatura_id: cobertos.length ? ass.id : null, criado_em: Date.now(),
          itens: sel.map(s => ({ id: s.id, nome: s.nome, preco_centavos: s.preco_centavos, duracao_min: s.duracao_min || c.duracao_padrao_min, coberto_plano: cobertos.includes(s.id) }))
        };
        db.agendamentos.push(a);
        cobertos.forEach(id => db.utilizacoes.push({ assinatura_id: ass.id, agendamento_id: a.id, servico_id: id, ciclo_inicio: ass.ciclo_inicio, estornada: false }));
        gravar();
        return Object.assign(agJson(a), { token: a.token });
      },
      async consultar(codigo, token) { await espera(100); return agJson(porToken(codigo, token)); },
      async cancelar(codigo, token) {
        await espera();
        const a = porToken(codigo, token);
        if (a.status === 'confirmado' && !agJson(a).pode_cancelar) throw Erro('CANCELAMENTO_FORA_DO_PRAZO');
        return cancelarInterno(a, 'cliente');
      },
      async cancelarLogado(codigo) {
        const cli = clienteLogado(); if (!cli) throw Erro('LOGIN_NECESSARIO');
        const a = ler().agendamentos.find(x => x.codigo === codigo && x.cliente_id === cli.id);
        if (!a) throw Erro('AGENDAMENTO_NAO_ENCONTRADO');
        return this.cancelar(a.codigo, a.token);
      },

      sessao() { sync(); const s = ler()[SESS]; return s ? { email: s.email, nome: s.nome || null } : null; },
      async capturarRetornoOAuth() { return false; },
      async renovarSessao() {},
      async entrarGoogle() {
        await espera(300);
        ler()[SESS] = { email: 'cliente.demo@gmail.com', nome: 'Cliente Demonstração' }; gravar();
        return this.sessao();
      },
      async enviarCodigo(email) {
        await espera();
        if (!email || !R.validarEmail(email)) throw Erro('EMAIL_INVALIDO');
        return { demo: true, codigo: '123456' };
      },
      async verificarCodigo(email, codigo) {
        await espera();
        if (codigo !== '123456') throw Erro('CODIGO_INVALIDO');
        const db = ler(); db[SESS] = { email: email.trim().toLowerCase() };
        const acesso = db.acessos.find(x => x.email === db[SESS].email);
        if (acesso) db[SESS].admin = { papel: acesso.papel, profissional_id: acesso.profissional_id };
        gravar();
        return { email: db[SESS].email };
      },
      sair() { sync(); ler()[SESS] = null; gravar(); },
      async perfil() {
        await espera(100);
        const cli = clienteLogado();
        return cli ? { nome: cli.nome, telefone: cli.telefone, email: cli.email || cli.user_email } : null;
      },
      async salvarPerfil(p) {
        await espera();
        const db = ler();
        if (!db[SESS]) throw Erro('LOGIN_NECESSARIO');
        if (!R.validarNome(p.nome)) throw Erro('NOME_INVALIDO');
        if (!R.validarTelefone(p.telefone)) throw Erro('TELEFONE_INVALIDO');
        const tel = R.soDigitos(p.telefone);
        let cli = clienteLogado();
        const dono = db.clientes.find(x => x.telefone === tel);
        if (dono && dono !== cli && dono.user_email && dono.user_email !== db[SESS].email) throw Erro('TELEFONE_VINCULADO');
        if (!cli) { cli = dono || { id: novoId() }; if (!dono) db.clientes.push(cli); }
        Object.assign(cli, { nome: p.nome.trim(), telefone: tel, user_email: db[SESS].email });
        gravar();
        return { nome: cli.nome, telefone: cli.telefone, email: db[SESS].email };
      },
      async meusAgendamentos() {
        await espera();
        const cli = clienteLogado(); if (!cli) return [];
        return ler().agendamentos.filter(a => a.cliente_id === cli.id).sort((a, b) => b.inicio.localeCompare(a.inicio)).map(agJson);
      },
      async minhasAssinaturas() {
        await espera(100);
        const cli = clienteLogado(); if (!cli) return [];
        const db = ler(); atualizarAssinaturas();
        return db.assinaturas.filter(s => s.cliente_id === cli.id).map(s => {
          const pl = K().planos.find(x => x.id === s.plano_id) || { nome: s.plano_id };
          return { id: s.id, plano: pl.nome, plano_id: s.plano_id, status: s.status, ciclo_inicio: s.ciclo_inicio, ciclo_fim: s.ciclo_fim,
                   limite_usos_ciclo: pl.limite_usos_ciclo,
                   usos_no_ciclo: db.utilizacoes.filter(u => u.assinatura_id === s.id && u.ciclo_inicio === s.ciclo_inicio && !u.estornada).length,
                   renova_sozinho: !!s.renova_sozinho, link_pagamento: pl.link_pagamento || null };
        });
      },
      async solicitarPlano(p) {
        await espera(400);
        const db = ler();
        if (!db[SESS]) throw Erro('LOGIN_NECESSARIO');
        const pl = K().planos.find(x => x.id === p.plano_id && x.ativo && x.disponivel_contratacao);
        if (!pl) throw Erro('PLANO_INDISPONIVEL');
        if (p.aceite !== true || Number(p.termos_versao) !== pl.termos_versao) throw Erro('ACEITE_OBRIGATORIO');
        const cli = clienteLogado();
        if (!cli) throw Erro('PERFIL_INCOMPLETO');
        if (db.assinaturas.some(s => s.cliente_id === cli.id && s.plano_id === pl.id && ['pendente', 'ativa', 'inadimplente'].includes(s.status))) throw Erro('ASSINATURA_EXISTENTE');
        const s = { id: novoId(), cliente_id: cli.id, plano_id: pl.id, status: 'pendente', termos_versao: pl.termos_versao, criada_em: new Date().toISOString(),
                    renova_sozinho: !!(pl.link_pagamento && pl.cobranca_recorrente) };
        db.assinaturas.push(s); gravar();
        return { assinatura_id: s.id, status: 'pendente', link_pagamento: pl.link_pagamento || null };
      },
      async cancelarAssinatura(id) {
        await espera();
        const cli = clienteLogado(); const s = ler().assinaturas.find(x => x.id === id && cli && x.cliente_id === cli.id);
        if (!s) throw Erro('ASSINATURA_NAO_ENCONTRADA');
        s.status = 'cancelada'; s.cancelada_em = new Date().toISOString(); gravar();
        return { id, status: 'cancelada' };
      },
      limparDemo() { memoria = null; try { localStorage.removeItem(CHAVE); } catch (e) {} },

      /* ── painel (demonstração) ── */
      async entrarDemoComo(perfil) {
        await espera(150);
        const db = ler();
        const p = K().profissionais.find(x => x.id === perfil);
        db[SESS] = perfil === 'recepcao' ? { email: 'recepcao.demo@nocaute', nome: 'Recepção', admin: { papel: 'recepcao', profissional_id: null } }
          : p ? { email: `${p.id}.demo@nocaute`, nome: p.nome, admin: { papel: 'barbeiro', profissional_id: p.id } }
              : { email: 'dono.demo@nocaute', nome: 'Dono', admin: { papel: 'dono', profissional_id: null } };
        gravar();
        return this.sessao();
      },
      async adminEu() {
        await espera(80);
        const a = eu(), p = K().profissionais.find(x => x.id === a.profissional_id);
        return Object.assign({ email: ler()[SESS].email, profissional_nome: p ? p.nome : null }, a);
      },
      async adminAgenda(de, ate, prof) {
        const e = eu(); await espera(120);
        const db = ler();
        return db.agendamentos
          .filter(a => a.data >= de && a.data <= ate && (!prof || a.profissional_id === prof) && (e.papel !== 'barbeiro' || a.profissional_id === e.profissional_id))
          .sort((a, b) => a.inicio.localeCompare(b.inicio))
          .map(a => Object.assign(agJson(a), { id: a.id, telefone: (db.clientes.find(c => c.id === a.cliente_id) || {}).telefone }));
      },
      async adminBloqueios(de, ate, prof) {
        const e = eu();
        return ler().bloqueios
          .filter(b => b.data >= de && b.data <= ate && (!prof || !b.profissional_id || b.profissional_id === prof)
                    && (e.papel !== 'barbeiro' || !b.profissional_id || b.profissional_id === e.profissional_id))
          .map(b => ({ id: b.id, profissional_id: b.profissional_id, motivo: b.motivo, origem: b.origem,
                       inicio: R.isoLocal(b.data, b.ini, cfg.offset), fim: R.isoLocal(b.data, Math.min(b.fim, 1439), cfg.offset) }));
      },
      async adminBloquear(prof, inicio, fim, motivo) {
        const e = eu();
        if (e.papel === 'barbeiro' && prof !== e.profissional_id) throw Erro('SEM_PERMISSAO');
        const a = R.agoraNoFuso(cfg.fuso, new Date(inicio)), b = R.agoraNoFuso(cfg.fuso, new Date(fim));
        const fimMin = b.data > a.data ? 1440 : b.min;
        if (fimMin <= a.min) throw Erro('PERIODO_INVALIDO');
        ler().bloqueios.push({ id: novoId(), profissional_id: prof || null, data: a.data, ini: a.min, fim: fimMin, motivo, origem: 'manual' });
        gravar();
      },
      async adminRemoverBloqueio(id) {
        const e = eu(), db = ler(), b = db.bloqueios.find(x => x.id === id);
        if (!b) throw Erro('BLOQUEIO_NAO_ENCONTRADO');
        if (e.papel === 'barbeiro' && b.profissional_id !== e.profissional_id) throw Erro('SEM_PERMISSAO');
        db.bloqueios = db.bloqueios.filter(x => x !== b); gravar();
      },
      async adminStatus(id, status) {
        const e = eu(), a = ler().agendamentos.find(x => x.id === id);
        if (!a) throw Erro('AGENDAMENTO_NAO_ENCONTRADO');
        if (e.papel === 'barbeiro' && a.profissional_id !== e.profissional_id) throw Erro('SEM_PERMISSAO');
        if (status === 'cancelado') return cancelarInterno(a, 'barbearia');
        if (a.status !== 'confirmado') throw Erro('TRANSICAO_INVALIDA');
        a.status = status; a.atualizado_em = Date.now(); gravar();
        return agJson(a);
      },
      async adminCliente(id) {
        const e = eu();
        const db = ler(), a = db.agendamentos.find(x => x.id === id);
        if (!a) throw Erro('AGENDAMENTO_NAO_ENCONTRADO');
        if (e.papel === 'barbeiro' && a.profissional_id !== e.profissional_id) throw Erro('SEM_PERMISSAO');
        return ficha(db.clientes.find(x => x.id === a.cliente_id) || {});
      },
      async adminFicha(id) {
        if (eu().papel === 'barbeiro') throw Erro('SEM_PERMISSAO');
        const c = ler().clientes.find(x => x.id === id);
        if (!c) throw Erro('CLIENTE_NAO_ENCONTRADO');
        return ficha(c);
      },
      async adminClientes(busca, ordem, sumidos) {
        if (eu().papel === 'barbeiro') throw Erro('SEM_PERMISSAO');
        await espera(120);
        const db = ler(), b = String(busca || '').trim().toLowerCase(), dig = R.soDigitos(busca);
        let lista = db.clientes.filter(c => !b || c.nome.toLowerCase().includes(b) || (dig && c.telefone.includes(dig))).map(c => {
          const n = numeros(c), ass = db.assinaturas.find(x => x.cliente_id === c.id && x.status === 'ativa');
          return Object.assign({ id: c.id, nome: c.nome, telefone: c.telefone, plano: ass ? (K().planos.find(p => p.id === ass.plano_id) || {}).nome : null }, n);
        });
        if (sumidos) lista = lista.filter(c => !c.proximo && c.ultima_visita && new Date(c.ultima_visita).getTime() < Date.now() - sumidos * 86400000);
        const ult = c => c.ultima_visita ? new Date(c.ultima_visita).getTime() : -Infinity;
        const crit = { nome: (a, b) => a.nome.localeCompare(b.nome), frequentes: (a, b) => b.atendidos - a.atendidos,
                       faltas: (a, b) => (b.faltas + b.cancelados_cliente) - (a.faltas + a.cancelados_cliente) }[ordem];
        return lista.sort((a, b) => (crit ? crit(a, b) : 0) || ult(b) - ult(a) || a.nome.localeCompare(b.nome)).slice(0, 300);
      },
      async adminResumo(mes) {
        exigirDono(); await espera(120); atualizarAssinaturas();
        const db = ler(), m = (mes || agora().data).slice(0, 7);
        const doMes = db.agendamentos.filter(a => a.data.slice(0, 7) === m);
        const primeira = {};
        db.agendamentos.forEach(a => { if (!primeira[a.cliente_id] || a.data < primeira[a.cliente_id]) primeira[a.cliente_id] = a.data; });
        return {
          mes: m + '-01',
          barbeiros: K().profissionais.filter(p => p.ativo || doMes.some(a => a.profissional_id === p.id)).map(p => {
            const dele = doMes.filter(a => a.profissional_id === p.id), feitos = dele.filter(a => a.status === 'concluido');
            return { id: p.id, nome: p.nome, atendidos: feitos.length, valor_centavos: feitos.reduce((t, a) => t + (a.total || 0), 0),
                     agendados: dele.filter(a => a.status === 'confirmado').length };
          }),
          cancelados_cliente: doMes.filter(a => a.status === 'cancelado' && a.cancelado_por !== 'barbearia').length,
          cancelados_barbearia: doMes.filter(a => a.status === 'cancelado' && a.cancelado_por === 'barbearia').length,
          faltas: doMes.filter(a => a.status === 'nao_compareceu').length,
          clientes_novos: Object.values(primeira).filter(d => d.slice(0, 7) === m).length,
          planos_ativos: db.assinaturas.filter(s => s.status === 'ativa').length,
          planos_pendentes: db.assinaturas.filter(s => s.status === 'pendente').length,
          planos_atrasados: db.assinaturas.filter(s => s.status === 'inadimplente').length
        };
      },
      async adminZerarFaltas(id) {
        if (eu().papel === 'barbeiro') throw Erro('SEM_PERMISSAO');
        const c = ler().clientes.find(x => x.id === id);
        if (!c) throw Erro('CLIENTE_NAO_ENCONTRADO');
        c.faltas_zeradas_em = Date.now(); gravar();
        return numeros(c);
      },

      // catálogo completo (inclui inativos) e edição
      async adminCatalogo() {
        eu(); await espera(100);
        const c = K();
        return { config: c.config, servicos: c.servicos, profissionais: c.profissionais, funcionamento: c.funcionamento,
                 jornadas: c.jornadas, planos: c.planos, plano_servicos: c.planoServicos };
      },
      async adminSalvarServico(s) {
        exigirDono(); await espera();
        if (!s.nome || s.nome.trim().length < 2) throw Erro('NOME_INVALIDO');
        if (s.duracao_min != null && (s.duracao_min < 5 || s.duracao_min > 480)) throw Erro('DURACAO_INVALIDA');
        const lista = K().servicos;
        let alvo = s.id && lista.find(x => x.id === s.id);
        if (!alvo) {
          let id = slug(s.nome); while (lista.some(x => x.id === id)) id += '-' + Math.floor(Math.random() * 90 + 10);
          alvo = { id, ordem: Math.max(0, ...lista.map(x => x.ordem)) + 10 }; lista.push(alvo);
        }
        Object.assign(alvo, { nome: s.nome.trim(), descricao: s.descricao || null, categoria: s.categoria || 'Outros',
          preco_centavos: s.preco_centavos == null ? null : Number(s.preco_centavos), preco_a_partir: !!s.preco_a_partir,
          duracao_min: s.duracao_min == null ? null : Number(s.duracao_min), componentes: s.componentes || [],
          ativo: s.ativo !== false, agendavel_online: s.agendavel_online !== false });
        gravar();
        return alvo;
      },
      async adminExcluirServico(id) {
        exigirDono(); await espera();
        const usado = ler().agendamentos.some(a => a.itens.some(i => i.id === id)) || K().planoServicos.some(x => x.servico_id === id);
        if (usado) { K().servicos.find(x => x.id === id).ativo = false; gravar(); return 'desativado'; }
        K().servicos = K().servicos.filter(x => x.id !== id); gravar(); return 'excluido';
      },
      async adminSalvarPlano(p) {
        exigirDono(); await espera();
        if (!p.nome || p.nome.trim().length < 2) throw Erro('NOME_INVALIDO');
        if (!(p.preco_centavos > 0)) throw Erro('PRECO_INVALIDO');
        if (!p.servicos || !p.servicos.length) throw Erro('PLANO_SEM_SERVICOS');
        if (p.link_pagamento && !/^https:\/\/\S+$/.test(p.link_pagamento)) throw Erro('LINK_INVALIDO');
        const lista = K().planos;
        let alvo = p.id && lista.find(x => x.id === p.id), mudou = false;
        if (!alvo) {
          let id = slug(p.nome); while (lista.some(x => x.id === id)) id += '-' + Math.floor(Math.random() * 90 + 10);
          alvo = { id, termos_versao: 1, periodicidade: 'mensal', ordem: lista.length + 1 }; lista.push(alvo);
        } else {
          mudou = JSON.stringify([alvo.preco_centavos, alvo.limite_usos_ciclo, alvo.regras, alvo.renovacao, alvo.cancelamento, alvo.restricoes, !!alvo.cobranca_recorrente])
               !== JSON.stringify([p.preco_centavos, p.limite_usos_ciclo || null, p.regras || null, p.renovacao || null, p.cancelamento || null, p.restricoes || {}, !!p.cobranca_recorrente]);
        }
        Object.assign(alvo, { nome: p.nome.trim(), descricao: p.descricao || null, preco_centavos: p.preco_centavos, limite_usos_ciclo: p.limite_usos_ciclo || null,
          regras: p.regras || null, renovacao: p.renovacao || null, cancelamento: p.cancelamento || null, restricoes: p.restricoes || {},
          ativo: p.ativo !== false, disponivel_contratacao: p.disponivel_contratacao !== false,
          link_pagamento: p.link_pagamento || null, cobranca_recorrente: !!p.cobranca_recorrente });
        if (mudou) alvo.termos_versao += 1;
        K().planoServicos = K().planoServicos.filter(x => x.plano_id !== alvo.id)
          .concat(p.servicos.map(x => ({ plano_id: alvo.id, servico_id: x.servico_id, limite_por_ciclo: x.limite_por_ciclo || null })));
        gravar();
        return alvo;
      },
      async adminSalvarFuncionamento(lista) {
        exigirDono(); await espera();
        if (lista.some(x => x.fecha <= x.abre)) throw Erro('PERIODO_INVALIDO');
        K().funcionamento = lista; gravar();
      },
      async adminSalvarJornada(prof, lista) {
        exigirDono(); await espera();
        if (lista.some(x => x.fim <= x.inicio)) throw Erro('PERIODO_INVALIDO');
        K().jornadas = K().jornadas.filter(j => j.profissional_id !== prof).concat(lista.map(x => Object.assign({ profissional_id: prof }, x)));
        gravar();
      },
      async adminSalvarProfissional(p) {
        exigirDono(); await espera();
        if (!p.nome || p.nome.trim().length < 2) throw Erro('NOME_INVALIDO');
        const lista = K().profissionais;
        let alvo = p.id && lista.find(x => x.id === p.id);
        if (!alvo) {
          let id = slug(p.nome.split(' ')[0]); while (lista.some(x => x.id === id)) id += '-' + Math.floor(Math.random() * 90 + 10);
          alvo = { id, ordem: lista.length + 1, especialidades: [] }; lista.push(alvo);
          K().jornadas.push(...K().funcionamento.map(f => ({ profissional_id: id, dia_semana: f.dia_semana, inicio: f.abre, fim: f.fecha })));
        }
        Object.assign(alvo, { nome: p.nome.trim(), foto_url: p.foto_url || null, ativo: p.ativo !== false, cargo: (p.cargo || '').trim() || 'Barbeiro' });
        gravar();
        return alvo;
      },
      async adminSalvarConfig(c) {
        exigirDono(); await espera();
        const lim = { antecedencia_min: [0, 1440], passo_min: [5, 120], intervalo_entre_min: [0, 120], janela_dias: [1, 120], cancelamento_antecedencia_h: [0, 72], max_faltas: [0, 10] };
        Object.entries(lim).forEach(([k, [a, b]]) => { if (c[k] != null && (c[k] < a || c[k] > b)) throw Erro('VALOR_FORA_DO_LIMITE'); });
        Object.assign(K().config, c); gravar();
        return K().config;
      },
      async adminAcessos() {
        exigirDono(); await espera(80);
        return [{ user_id: 'demo-dono', papel: 'dono', email: 'dono.demo@nocaute', eu: true }].concat(ler().acessos);
      },
      async adminLiberarAcesso(email, papel, prof) {
        exigirDono(); await espera();
        if (!email || !R.validarEmail(email)) throw Erro('EMAIL_INVALIDO');
        if (papel === 'barbeiro' && !prof) throw Erro('PROFISSIONAL_OBRIGATORIO');
        const db = ler();
        db.acessos = db.acessos.filter(x => x.email !== email.toLowerCase())
          .concat([{ user_id: novoId(), email: email.toLowerCase(), papel, profissional_id: papel === 'barbeiro' ? prof : null }]);
        gravar();
      },
      async adminRemoverAcesso(uid) {
        exigirDono(); if (uid === 'demo-dono') throw Erro('NAO_REMOVE_A_SI_MESMO');
        ler().acessos = ler().acessos.filter(x => x.user_id !== uid); gravar();
      },
      async adminAssinaturas() {
        if (eu().papel === 'barbeiro') throw Erro('SEM_PERMISSAO');
        await espera(100); atualizarAssinaturas();
        const db = ler(), ordem = { pendente: 0, inadimplente: 1, ativa: 2 };
        return db.assinaturas.map(s => {
          const pl = K().planos.find(x => x.id === s.plano_id) || {}, c = db.clientes.find(x => x.id === s.cliente_id) || {};
          return { id: s.id, status: s.status, plano: pl.nome, plano_id: s.plano_id, preco_centavos: pl.preco_centavos, cliente: c.nome, telefone: c.telefone,
                   criada_em: s.criada_em, ciclo_inicio: s.ciclo_inicio, ciclo_fim: s.ciclo_fim, limite_usos_ciclo: pl.limite_usos_ciclo,
                   usos_no_ciclo: db.utilizacoes.filter(u => u.assinatura_id === s.id && u.ciclo_inicio === s.ciclo_inicio && !u.estornada).length,
                   renova_sozinho: !!s.renova_sozinho, link_pagamento: pl.link_pagamento || null, cancelada_em: s.cancelada_em || null };
        }).sort((a, b) => (ordem[a.status] ?? 3) - (ordem[b.status] ?? 3));
      },
      async adminAssinatura(id, acao) {
        if (eu().papel === 'barbeiro') throw Erro('SEM_PERMISSAO');
        await espera();
        const s = ler().assinaturas.find(x => x.id === id);
        if (!s) throw Erro('ASSINATURA_NAO_ENCONTRADA');
        const hoje = agora().data;
        if (acao === 'ativar' || acao === 'renovar') {
          if (['cancelada', 'expirada'].includes(s.status)) throw Erro('ASSINATURA_ENCERRADA');
          const ini = s.ciclo_fim && s.ciclo_fim >= hoje ? R.somarDias(s.ciclo_fim, 1) : hoje;
          Object.assign(s, { status: 'ativa', ciclo_inicio: ini, ciclo_fim: umMes(ini) });
        } else if (acao === 'cancelar') s.status = 'cancelada';
        gravar();
        return s;
      }
    };
  }

  raiz.NC_API = {
    criar(cfg) {
      if (cfg.modo === 'supabase') {
        if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error('Configure supabaseUrl e supabaseAnonKey em js/config.js');
        return criarSupabase(cfg);
      }
      return criarDemo(cfg);
    }
  };
})(window);
