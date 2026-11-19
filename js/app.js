/* ════════════════════════════════════════════════════════════
   Página de agendamento.
   Só tela e navegação: dados vêm de NC_API e cálculos de NC_Regras.
   Ordem pensada para pouco atrito: serviço → barbeiro → horário →
   entrar (Google ou e-mail) → confirmar. Sem pagamento pelo site:
   o cliente paga na barbearia.
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const C = window.NC_CONFIG;
  const R = window.NC_Regras;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let api;
  try { api = window.NC_API.criar(C); }
  catch (e) { $('#painel').innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; return; }

  const MSG = {
    HORARIO_INDISPONIVEL: 'Esse horário acabou de ser reservado por outra pessoa. Escolha outro, por favor.',
    MUITAS_FALTAS: 'Por causa de faltas em horários anteriores, o próximo agendamento precisa ser combinado com a barbearia pelo WhatsApp.',
    COMBINACAO_INVALIDA: 'Essa combinação não é possível: o combo já inclui um dos serviços escolhidos.',
    SERVICO_INDISPONIVEL: 'Um dos serviços escolhidos não está disponível para agendamento online.',
    SERVICO_OBRIGATORIO: 'Escolha pelo menos um serviço.',
    SERVICOS_DEMAIS: 'Escolha no máximo 4 serviços por agendamento.',
    NOME_INVALIDO: 'Informe seu nome completo.',
    TELEFONE_INVALIDO: 'Informe um WhatsApp válido com DDD.',
    EMAIL_INVALIDO: 'Informe um e-mail válido.',
    AGENDAMENTO_NAO_ENCONTRADO: 'Não encontramos esse agendamento.',
    AGENDAMENTO_NAO_CANCELAVEL: 'Esse agendamento não pode mais ser cancelado.',
    CANCELAMENTO_FORA_DO_PRAZO: 'O prazo para cancelar pelo site terminou. Fale com a barbearia pelo WhatsApp.',
    LOGIN_NECESSARIO: 'Entre na sua conta para continuar.',
    LOGIN_CANCELADO: 'O login não foi concluído. Tente de novo.',
    PERFIL_INCOMPLETO: 'Falta informar seu WhatsApp.',
    CODIGO_INVALIDO: 'Código incorreto ou expirado.',
    PLANO_INDISPONIVEL: 'Esse plano não está disponível no momento.',
    ACEITE_OBRIGATORIO: 'É preciso aceitar as condições do plano.',
    ASSINATURA_EXISTENTE: 'Você já pediu esse plano ou ele já está ativo.',
    TELEFONE_VINCULADO: 'Esse WhatsApp já está em outra conta. Fale com a barbearia.',
    SEM_CONEXAO: 'Sem conexão com o servidor. Verifique sua internet e tente de novo.',
    SEM_PERMISSAO: 'Sua sessão expirou. Entre de novo.'
  };
  const msgErro = e => MSG[e && e.codigo] || 'Algo deu errado. Tente de novo em instantes.';

  /* ───────── estado ───────── */
  const NOMES = { servicos: 'Serviços', profissional: 'Barbeiro', horario: 'Data e horário', conta: 'Identificação',
                  revisao: 'Revisão', confirmacao: 'Confirmação' };
  const novoFluxo = () => ({ passo: 'servicos', servicos: [], prof: null, data: null, hora: null, inicio: null, mes: null,
                             visitante: false, nome: '', tel: '', ag: null, agDados: null, tentou: false });
  let F;
  try { F = Object.assign(novoFluxo(), JSON.parse(sessionStorage.getItem('nc_fluxo') || 'null')); } catch (e) { F = novoFluxo(); }
  const salvar = () => { try { sessionStorage.setItem('nc_fluxo', JSON.stringify(F)); } catch (e) {} };

  const P = { sessao: null, perfil: null, assinaturas: [] };

  // reservas sem conta feitas neste aparelho (só se a barbearia permitir agendar sem conta)
  const meusLocais = () => { try { return JSON.parse(localStorage.getItem('nc_meus') || '[]'); } catch (e) { return []; } };
  const guardarLocal = (codigo, token) => {
    const l = meusLocais().filter(x => x.codigo !== codigo); l.unshift({ codigo, token });
    try { localStorage.setItem('nc_meus', JSON.stringify(l.slice(0, 30))); } catch (e) {}
  };

  let CAT = null, seq = 0;
  const cacheDias = {}, cacheSlots = {};
  const limparCache = () => { Object.keys(cacheDias).forEach(k => delete cacheDias[k]); Object.keys(cacheSlots).forEach(k => delete cacheSlots[k]); };

  /* ───────── utilidades ───────── */
  function toast(txt, erro) {
    const t = $('#toast');
    t.textContent = txt; t.classList.toggle('erro', !!erro); t.classList.add('mostrar');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('mostrar'), 4200);
  }
  function ocupado(btn, sim, texto) {
    if (!btn) return;
    if (sim) { btn.dataset.txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(texto || 'Aguarde')}</span>`; }
    else { btn.disabled = false; if (btn.dataset.txt) btn.innerHTML = btn.dataset.txt; }
  }
  const fmtData = iso => new Intl.DateTimeFormat('pt-BR', { timeZone: C.fuso, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
  const fmtDataCurta = iso => new Intl.DateTimeFormat('pt-BR', { timeZone: C.fuso, weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(iso)).replace('.', '');
  const fmtHora = iso => new Intl.DateTimeFormat('pt-BR', { timeZone: C.fuso, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const dataDaChave = k => k + 'T12:00:00' + C.offset;
  const primeiroNome = n => String(n || '').trim().split(' ')[0];
  const STATUS = { confirmado: 'Confirmado', cancelado: 'Cancelado', concluido: 'Atendido', nao_compareceu: 'Não compareceu',
                   pendente: 'Aguardando ativação', ativa: 'Ativo', inadimplente: 'Renovação pendente', cancelada: 'Cancelado', expirada: 'Encerrado' };
  const ICONE_GOOGLE = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>';
  // "R$ 130" / "a partir de R$ 170" / "a confirmar"
  function valorTexto(total, aConfirmar, aPartir) {
    if (aConfirmar && !total) return 'A confirmar na barbearia';
    return (aPartir ? 'a partir de ' : '') + R.fmtPreco(total) + (aConfirmar ? ' + itens a confirmar' : '');
  }
  const linkWhats = txt => `https://wa.me/${C.whatsapp}?text=${encodeURIComponent(txt)}`;

  /* ───────── diálogo ───────── */
  const dlg = $('#dlg');
  function abrirDialogo(titulo, corpo, botoes) {
    $('#dlgTitulo').textContent = titulo;
    $('#dlgCorpo').innerHTML = corpo;
    const rod = $('#dlgRodape'); rod.innerHTML = '';
    (botoes || []).forEach(b => {
      const el = document.createElement(b.href ? 'a' : 'button');
      if (b.href) { el.href = b.href; el.target = '_blank'; el.rel = 'noopener'; } else el.type = 'button';
      el.className = b.classe || 'btn-line';
      el.innerHTML = b.classe === 'btn-fill' ? `<span>${esc(b.texto)}</span>` : esc(b.texto);
      if (b.acao) el.addEventListener('click', () => b.acao(el));
      rod.appendChild(el);
    });
    rod.hidden = !(botoes && botoes.length);
    if (!dlg.open) dlg.showModal();
  }
  const fecharDialogo = () => dlg.open && dlg.close();
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-fechar]')) fecharDialogo(); });
  const confirmar = (titulo, texto, rotulo) => new Promise(ok => {
    abrirDialogo(titulo, `<p>${texto}</p>`, [
      { texto: 'Voltar', acao: () => { fecharDialogo(); ok(false); } },
      { texto: rotulo || 'Confirmar', classe: 'btn-fill', acao: () => { fecharDialogo(); ok(true); } }
    ]);
    dlg.addEventListener('close', () => ok(false), { once: true });
  });

  /* ═════════════ CONTA ═════════════ */
  async function carregarConta() {
    P.sessao = api.sessao();
    P.perfil = null; P.assinaturas = [];
    if (!P.sessao) return;
    try { P.perfil = await api.perfil(); }
    catch (e) { if (e.codigo === 'SEM_PERMISSAO') { api.sair(); P.sessao = null; return; } }
    try { P.assinaturas = await api.minhasAssinaturas(); } catch (e) {}
  }
  const exigeLogin = () => !CAT || CAT.config.exigir_login !== false;
  const identificado = () => (P.sessao && P.perfil) || (F.visitante && !exigeLogin());

  function montarLogin(alvo, aoEntrar, contexto) {
    alvo.innerHTML = `<div class="entrar">
      <button type="button" class="btn-google" data-google>${ICONE_GOOGLE}<span>Continuar com Google</span></button>
      <div class="divisor">ou com seu e-mail</div>
      <div class="campo"><label for="lgEmail-${contexto}">E-mail</label><input type="email" id="lgEmail-${contexto}" class="lg-email" autocomplete="email" inputmode="email"></div>
      <div class="lg-etapa2" hidden><div class="campo"><label for="lgCod-${contexto}">Código que chegou no e-mail</label>
        <input type="text" id="lgCod-${contexto}" class="lg-codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></div><p class="campo-dica lg-dica"></p></div>
      <div class="lg-erro"></div>
      <button type="button" class="btn-line lg-btn" style="width:100%">Receber código</button>
    </div>`;
    const btn = $('.lg-btn', alvo), erro = $('.lg-erro', alvo);
    let enviado = false;
    $('[data-google]', alvo).addEventListener('click', async e => {
      const b = e.currentTarget; erro.innerHTML = '';
      try { sessionStorage.setItem('nc_pos_login', JSON.stringify(contexto === 'plano' ? { plano: alvo.dataset.plano } : { contexto })); } catch (x) {}
      ocupado(b, true, 'Abrindo o Google');
      try { await api.entrarGoogle(); await depoisDoLogin(aoEntrar); }
      catch (x) { ocupado(b, false); erro.innerHTML = `<div class="aviso erro">${esc(msgErro(x))}</div>`; }
    });
    const tentar = async () => {
      const email = $('.lg-email', alvo).value.trim();
      erro.innerHTML = '';
      try {
        if (!enviado) {
          if (!email || !R.validarEmail(email)) throw { codigo: 'EMAIL_INVALIDO' };
          ocupado(btn, true, 'Enviando');
          const r = await api.enviarCodigo(email);
          enviado = true; ocupado(btn, false); btn.textContent = 'Entrar';
          $('.lg-etapa2', alvo).hidden = false;
          $('.lg-dica', alvo).textContent = r.demo ? `Demonstração: use o código ${r.codigo}.` : 'Confira também a caixa de spam.';
          $('.lg-email', alvo).readOnly = true;
          $('.lg-codigo', alvo).focus();
        } else {
          ocupado(btn, true, 'Entrando');
          await api.verificarCodigo(email, $('.lg-codigo', alvo).value.trim());
          await depoisDoLogin(aoEntrar);
        }
      } catch (x) { ocupado(btn, false); if (enviado) btn.textContent = 'Entrar'; erro.innerHTML = `<div class="aviso erro">${esc(msgErro(x))}</div>`; }
    };
    btn.addEventListener('click', tentar);
    alvo.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); tentar(); } });
  }
  async function depoisDoLogin(aoEntrar) {
    try { sessionStorage.removeItem('nc_pos_login'); } catch (e) {}
    await carregarConta();
    renderContaTopo(); renderMeus(); renderPlanos();
    if (aoEntrar) await aoEntrar();
  }

  function formPerfil(prefixo) {
    const nome = (P.perfil && P.perfil.nome) || (P.sessao && P.sessao.nome) || F.nome || '';
    const tel = (P.perfil && R.mascaraTelefone(P.perfil.telefone)) || F.tel || '';
    return `<div class="campos">
      <div class="campo"><label for="${prefixo}Nome">Nome completo</label><input type="text" id="${prefixo}Nome" autocomplete="name" autocapitalize="words" value="${esc(nome)}"></div>
      <div class="campo"><label for="${prefixo}Tel">WhatsApp</label><input type="tel" id="${prefixo}Tel" inputmode="numeric" autocomplete="tel-national" placeholder="(62) 99999-9999" value="${esc(tel)}"></div>
    </div><div id="${prefixo}Erro"></div>`;
  }
  function ligarMascara(id) { const el = $('#' + id); if (el) el.addEventListener('input', () => { el.value = R.mascaraTelefone(el.value); }); }
  async function salvarPerfilDe(prefixo, btn) {
    const nome = $(`#${prefixo}Nome`).value, tel = $(`#${prefixo}Tel`).value, box = $(`#${prefixo}Erro`);
    box.innerHTML = '';
    if (!R.validarNome(nome)) { box.innerHTML = `<div class="aviso erro">${MSG.NOME_INVALIDO}</div>`; $(`#${prefixo}Nome`).focus(); return false; }
    if (!R.validarTelefone(tel)) { box.innerHTML = `<div class="aviso erro">${MSG.TELEFONE_INVALIDO}</div>`; $(`#${prefixo}Tel`).focus(); return false; }
    ocupado(btn, true, 'Salvando');
    try { P.perfil = await api.salvarPerfil({ nome: nome.trim(), telefone: R.soDigitos(tel) }); ocupado(btn, false); renderContaTopo(); return true; }
    catch (e) { ocupado(btn, false); box.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return false; }
  }
  async function sair() {
    api.sair(); await carregarConta();
    F.visitante = false;
    if (F.passo === 'revisao') F.passo = 'conta';
    toast('Você saiu da conta.'); renderContaTopo(); renderMeus(); renderPlanos(); render();
  }

  /* ═════════════ CÁLCULOS ═════════════ */
  const servico = id => CAT.servicos.find(s => s.id === id);
  const profissional = id => CAT.profissionais.find(p => p.id === id);
  const selecao = () => R.validarServicos(F.servicos, CAT.servicos, CAT.config);
  const umProfissional = () => CAT.profissionais.length === 1;
  function listaPassos() {
    const p = ['servicos'];
    if (!umProfissional()) p.push('profissional');
    p.push('horario');
    if (!identificado() || F.passo === 'conta') p.push('conta');
    p.push('revisao', 'confirmacao');
    return p;
  }
  const precoTexto = v => (v && v.ok) ? valorTexto(v.preco, v.aConfirmar, v.aPartir) : null;
  function cobertosPeloPlano() {
    const out = new Set();
    P.assinaturas.filter(a => a.status === 'ativa').forEach(a =>
      (CAT.planoServicos || []).filter(ps => ps.plano_id === a.plano_id).forEach(ps => out.add(ps.servico_id)));
    return out;
  }

  /* ═════════════ RENDERIZAÇÃO DO FLUXO ═════════════ */
  function render(focar) {
    if (!CAT) return;
    const passos = listaPassos();
    if (!passos.includes(F.passo)) F.passo = 'servicos';
    const i = passos.indexOf(F.passo);
    $('#passos').innerHTML = passos.map((p, k) => `<li class="${k <= i ? 'feito' : ''}"></li>`).join('');
    $('#passoAtual').innerHTML = `Passo ${i + 1} de ${passos.length} · <strong>${NOMES[F.passo]}</strong>`;
    $('#passoProximo').textContent = passos[i + 1] ? 'Depois: ' + NOMES[passos[i + 1]] : '';
    ({ servicos: pServicos, profissional: pProfissional, horario: pHorario, conta: pConta,
       revisao: pRevisao, confirmacao: pConfirmacao })[F.passo]();
    renderResumo(); atualizarBarra(); salvar();
    if (focar) {
      const t = $('#painel .painel-titulo');
      if (t) t.focus({ preventScroll: true });
      const topo = $('#agendar').getBoundingClientRect().top;
      if (topo < 0 || topo > window.innerHeight * 0.5) $('#passos').scrollIntoView({ block: 'start' });
    }
  }
  function irPara(passo) { F.passo = passo; render(true); }
  function proximo() { const p = listaPassos(); irPara(p[p.indexOf(F.passo) + 1]); }
  function anterior() { const p = listaPassos(); irPara(p[Math.max(0, p.indexOf(F.passo) - 1)]); }

  function rodape(voltar, avancarTexto, avancarOk) {
    $('#painelRodape').hidden = false;
    $('#btnVoltar').style.visibility = voltar ? 'visible' : 'hidden';
    const b = $('#btnAvancar');
    b.hidden = !avancarTexto; b.disabled = !avancarOk;
    b.innerHTML = `<span>${esc(avancarTexto || '')}</span>`;
    delete b.dataset.txt;
  }
  const semRodape = () => { $('#painelRodape').hidden = true; };
  const titulo = (t, sub) => `<h3 class="painel-titulo" tabindex="-1">${esc(t)}</h3>${sub ? `<p class="painel-sub">${sub}</p>` : ''}`;
  const precoItem = s => s.preco_centavos == null ? '<span class="item-preco mudo">a confirmar</span>'
    : `<span class="item-preco">${s.preco_a_partir ? '<small>a partir de</small> ' : ''}${R.fmtPreco(s.preco_centavos)}</span>`;

  /* ─── serviços ─── */
  function pServicos() {
    const inc = R.incompativeis(F.servicos, CAT.servicos);
    const plano = cobertosPeloPlano();
    const v = F.servicos.length ? selecao() : null;
    const cats = [...new Set(CAT.servicos.map(s => s.categoria))];
    $('#painel').innerHTML = titulo('O que você vai fazer?', 'Pode marcar mais de um. Valor e tempo somam sozinhos.') +
      (v && !v.ok ? `<div class="aviso erro">${esc(msgErro({ codigo: v.erro }))}</div>` : '') +
      cats.map(cat => `<p class="lista-cat">${esc(cat)}</p><div class="lista">` +
        CAT.servicos.filter(s => s.categoria === cat).map(s => {
          const sel = F.servicos.includes(s.id);
          const bloq = !sel && (inc.has(s.id) || s.agendavel_online === false || F.servicos.length >= 4);
          const nota = !sel && inc.has(s.id) ? '<small>já incluso na sua escolha</small>' : (s.descricao ? `<small>${esc(s.descricao)}</small>` : '');
          return `<button type="button" class="item" data-servico="${s.id}" aria-pressed="${sel}" ${bloq ? 'disabled' : ''}>
            <span class="marca" aria-hidden="true">${sel ? '✓' : ''}</span>
            <span class="item-nome">${esc(s.nome)}${plano.has(s.id) ? '<span class="selo-plano">plano</span>' : ''}${nota}</span>
            <span class="item-dur">${s.duracao_min ? R.fmtDur(s.duracao_min) : ''}</span>
            ${precoItem(s)}
          </button>`;
        }).join('') + '</div>').join('');
    rodape(false, v && v.ok ? `Continuar · ${R.fmtDur(v.duracao)} · ${precoTexto(v)}` : 'Continuar', v && v.ok);
  }
  function alternarServico(id) {
    const i = F.servicos.indexOf(id);
    if (i >= 0) F.servicos.splice(i, 1);
    else {
      if (R.incompativeis(F.servicos, CAT.servicos).has(id)) { toast(MSG.COMBINACAO_INVALIDA, true); return false; }
      if (F.servicos.length >= 4) { toast(MSG.SERVICOS_DEMAIS, true); return false; }
      F.servicos.push(id);
    }
    F.hora = null; F.inicio = null;
    return true;
  }

  /* ─── barbeiro ─── */
  function pProfissional() {
    const item = (id, nome, sub, avatar) => `<button type="button" class="item" data-prof="${id}" aria-pressed="${F.prof === id}">
      <span class="marca redonda" aria-hidden="true"></span>${avatar}
      <span class="item-nome">${esc(nome)}<small>${esc(sub)}</small></span></button>`;
    $('#painel').innerHTML = titulo('Com quem?') + '<div class="lista">' +
      item('qualquer', 'Qualquer barbeiro', 'mostra mais horários', '<span class="avatar-letra avatar-qualquer" aria-hidden="true">✦</span>') +
      CAT.profissionais.map(p => item(p.id, p.nome, (p.especialidades || []).join(', ') || 'Barbeiro',
        p.foto_url ? `<img class="avatar" src="${esc(p.foto_url)}" alt="" data-inicial="${esc(p.nome[0])}">` : `<span class="avatar-letra">${esc(p.nome[0])}</span>`)).join('') +
      '</div>';
    rodape(true, 'Continuar', !!F.prof);
  }

  /* ─── data e horário ─── */
  const profParam = () => (umProfissional() ? CAT.profissionais[0].id : (F.prof === 'qualquer' ? null : F.prof));
  const hojeLocal = () => R.agoraNoFuso(C.fuso).data;
  async function pHorario() {
    const minha = ++seq;
    const hoje = hojeLocal();
    const limite = R.somarDias(hoje, CAT.config.janela_dias);
    if (!F.mes) F.mes = (F.data || hoje).slice(0, 7);
    const [ano, mes] = F.mes.split('-').map(Number);
    const primeiro = `${F.mes}-01`;
    const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    const ultimo = `${F.mes}-${String(ultimoDia).padStart(2, '0')}`;
    const de = primeiro < hoje ? hoje : primeiro;
    const ate = ultimo > limite ? limite : ultimo;
    const chave = F.servicos.join(',') + '|' + (profParam() || '*') + '|' + F.mes;
    const nomeMes = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(ano, mes - 1, 15))).replace(/^./, c => c.toUpperCase());
    const podeAntes = F.mes > hoje.slice(0, 7);
    const podeDepois = F.mes < limite.slice(0, 7);

    const desenhar = (dias, carregando) => {
      let grade = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map(d => `<span class="cal-dow" aria-hidden="true">${d}</span>`).join('');
      grade += '<span class="cal-vazio"></span>'.repeat(R.diaSemana(primeiro));
      for (let d = 1; d <= ultimoDia; d++) {
        const k = `${F.mes}-${String(d).padStart(2, '0')}`;
        const livre = dias && dias.includes(k);
        const rot = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(k + 'T12:00:00Z'));
        grade += `<button type="button" class="cal-dia ${k === hoje ? 'hoje' : ''}" data-dia="${k}" aria-pressed="${F.data === k}"
                   ${livre ? '' : 'disabled'} aria-label="${rot}${livre ? '' : ', sem horários'}">${d}</button>`;
      }
      return `<div class="cal ${carregando ? 'cal-carregando' : ''}">
        <div class="cal-topo">
          <button type="button" class="cal-nav" data-mes="-1" ${podeAntes ? '' : 'disabled'} aria-label="Mês anterior">‹</button>
          <span class="cal-mes" aria-live="polite">${nomeMes}${carregando ? ' <span class="spinner" style="width:12px;height:12px"></span>' : ''}</span>
          <button type="button" class="cal-nav" data-mes="1" ${podeDepois ? '' : 'disabled'} aria-label="Próximo mês">›</button>
        </div>
        <div class="cal-grade">${grade}</div></div>`;
    };
    const cabecalho = titulo('Quando?', `${esc(R.fmtDur(selecao().duracao))} de atendimento${F.prof && F.prof !== 'qualquer' ? ' com ' + esc(profissional(F.prof).nome) : ''}. Só aparecem horários livres.`);

    $('#painel').innerHTML = cabecalho + desenhar(cacheDias[chave], !cacheDias[chave]) + '<div id="slots"></div>';
    rodape(true, 'Continuar', !!F.inicio);

    let dias = cacheDias[chave];
    if (!dias) {
      $('#slots').innerHTML = '<div class="slots">' + '<div class="esqueleto"></div>'.repeat(8) + '</div>';
      try { dias = await api.diasDisponiveis(de, ate, F.servicos, profParam()); }
      catch (e) { if (minha === seq) $('#slots').innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return; }
      cacheDias[chave] = dias;
      if (minha !== seq) return;
    }
    if (F.data && F.data.slice(0, 7) === F.mes && !dias.includes(F.data)) { F.data = null; F.hora = null; F.inicio = null; }
    if (!F.data && dias.length) F.data = dias[0];
    if (!dias.length && podeDepois && !pHorario.pulou) { pHorario.pulou = true; F.mes = R.somarDias(ultimo, 1).slice(0, 7); return pHorario(); }
    pHorario.pulou = false;
    renderResumo(); salvar();
    $('#painel').innerHTML = cabecalho + desenhar(dias, false) + '<div id="slots"></div>';
    rodape(true, 'Continuar', !!F.inicio);
    if (!F.data || F.data.slice(0, 7) !== F.mes) {
      $('#slots').innerHTML = `<p class="vazio">${dias.length ? 'Escolha um dia no calendário.' : 'Nenhum horário livre neste período.<br>Tente outro barbeiro ou fale com a gente no WhatsApp.'}</p>`;
      return;
    }
    carregarSlots(minha);
  }
  async function carregarSlots(minha) {
    const chave = F.servicos.join(',') + '|' + (profParam() || '*') + '|' + F.data;
    const alvo = $('#slots');
    if (!cacheSlots[chave]) {
      alvo.innerHTML = '<div class="slots">' + '<div class="esqueleto"></div>'.repeat(8) + '</div>';
      try { cacheSlots[chave] = await api.disponibilidade(F.data, F.servicos, profParam()); }
      catch (e) { if (minha === seq) alvo.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return; }
      if (minha !== seq) return;
    }
    const lista = cacheSlots[chave];
    if (F.inicio && !lista.some(s => s.inicio === F.inicio)) { F.hora = null; F.inicio = null; renderResumo(); }
    const grupos = [['Manhã', 0, 720], ['Tarde', 720, 1080], ['Noite', 1080, 1440]];
    $('#slots').innerHTML = `<p class="slot-titulo" style="color:var(--white);margin-bottom:1rem">${esc(fmtData(dataDaChave(F.data)))}</p>` +
      (lista.length ? grupos.map(([n, a, b]) => {
        const g = lista.filter(s => s.min >= a && s.min < b);
        return g.length ? `<div class="slot-grupo"><p class="slot-titulo">${n}</p><div class="slots">${g.map(s =>
          `<button type="button" class="slot" data-inicio="${esc(s.inicio)}" data-hora="${s.hora}" aria-pressed="${F.inicio === s.inicio}">${s.hora}</button>`).join('')}</div></div>` : '';
      }).join('') : '<p class="vazio">Esse dia lotou. Escolha outra data.</p>');
    rodape(true, 'Continuar', !!F.inicio);
  }

  /* ─── identificação ─── */
  function pConta() {
    if (!P.sessao && !F.visitante) {
      $('#painel').innerHTML = titulo('Entre para confirmar', 'Assim seus horários ficam guardados e você não precisa digitar seus dados da próxima vez.') +
        '<div id="contaLogin"></div>' +
        (!exigeLogin() ? '<p style="margin-top:1.4rem"><button type="button" class="btn-link" data-acao="visitante">Continuar sem conta</button></p>' : '');
      montarLogin($('#contaLogin'), async () => { if (P.perfil) { toast(`Olá, ${primeiroNome(P.perfil.nome)}!`); proximo(); } else render(true); }, 'fluxo');
      rodape(true, '', false);
      return;
    }
    if (P.sessao && P.perfil) {
      $('#painel').innerHTML = titulo('Você já está conectado') +
        `<div class="quem"><span>Agendando como <strong>${esc(P.perfil.nome)}</strong></span><button type="button" class="btn-link" data-acao="sair">Trocar conta</button></div>`;
      rodape(true, 'Continuar', true);
      return;
    }
    if (P.sessao && !P.perfil) {
      $('#painel').innerHTML = titulo('Só falta seu WhatsApp', `Conectado como ${esc(P.sessao.email)}. Pedimos uma única vez, para confirmar seus horários.`) +
        formPerfil('pf') + '<p class="campo-dica">Usamos seus dados apenas para seus agendamentos, conforme a LGPD.</p>';
      ligarMascara('pfTel');
      rodape(true, 'Salvar e continuar', true);
      return;
    }
    const nomeOk = R.validarNome(F.nome), telOk = R.validarTelefone(F.tel);
    $('#painel').innerHTML = titulo('Seus dados', 'Sem conta, você acompanha o horário só neste aparelho.') +
      `<div class="campos">
        <div class="campo"><label for="fNome">Nome completo</label><input type="text" id="fNome" autocomplete="name" value="${esc(F.nome)}" aria-invalid="${F.tentou && !nomeOk}">
          ${F.tentou && !nomeOk ? `<p class="campo-erro">${MSG.NOME_INVALIDO}</p>` : ''}</div>
        <div class="campo"><label for="fTel">WhatsApp</label><input type="tel" id="fTel" inputmode="numeric" autocomplete="tel-national" placeholder="(62) 99999-9999" value="${esc(F.tel)}" aria-invalid="${F.tentou && !telOk}">
          ${F.tentou && !telOk ? `<p class="campo-erro">${MSG.TELEFONE_INVALIDO}</p>` : ''}</div>
      </div><p><button type="button" class="btn-link" data-acao="quero-conta">Prefiro entrar com Google ou e-mail</button></p>`;
    const n = $('#fNome'), t = $('#fTel');
    n.addEventListener('input', () => { F.nome = n.value; salvar(); });
    t.addEventListener('input', () => { t.value = R.mascaraTelefone(t.value); F.tel = t.value; salvar(); });
    rodape(true, 'Continuar', true);
  }

  /* ─── revisão ─── */
  function linhasResumo(o) {
    const L = (k, v, cls) => `<div class="linha"><span class="linha-k">${k}</span><span class="linha-v ${cls || ''}">${v}</span></div>`;
    return L('Serviços', o.itens.map(i => esc(i.nome) + (i.coberto ? ' <small>coberto pelo plano</small>' : '')).join('<br>')) +
      L('Barbeiro', esc(o.prof)) + L('Data', esc(o.data)) + L('Horário', esc(o.hora)) + L('Duração', esc(o.dur)) +
      (o.desconto ? L('Plano', '− ' + R.fmtPreco(o.desconto)) : '') +
      L('Valor', esc(o.total), 'destaque') + L('Pagamento', 'Na barbearia') + (o.status ? L('Situação', esc(o.status)) : '');
  }
  function pRevisao() {
    const v = selecao(), cfg = CAT.config;
    const p = F.prof === 'qualquer' || !F.prof ? 'Qualquer barbeiro' : profissional(F.prof).nome;
    const quem = P.perfil ? `${esc(P.perfil.nome)} · ${esc(R.mascaraTelefone(P.perfil.telefone))}` : `${esc(F.nome)} · ${esc(F.tel)}`;
    const plano = cobertosPeloPlano();
    $('#painel').innerHTML = titulo('Tudo certo?') +
      `<div class="quem"><span>Agendando como <strong>${quem}</strong></span>${P.sessao ? '<button type="button" class="btn-link" data-acao="sair">Trocar conta</button>' : ''}</div>
      <div class="resumo-corpo" style="border:1px solid var(--gray-line);margin-bottom:1.4rem">${linhasResumo({
        itens: F.servicos.map(id => ({ nome: servico(id).nome })), prof: p, data: fmtData(F.inicio), hora: fmtHora(F.inicio),
        dur: R.fmtDur(v.duracao), total: precoTexto(v) })}</div>
      ${F.servicos.some(id => plano.has(id)) ? '<div class="aviso ok">Seu plano cobre parte disso. O desconto entra ao confirmar.</div>' : ''}
      <p class="campo-dica"><strong>Cancelamento:</strong> ${esc(cfg.politica_cancelamento || `até ${cfg.cancelamento_antecedencia_h} h antes do horário.`)}</p>`;
    rodape(true, 'Confirmar agendamento', true);
  }

  /* ─── confirmação ─── */
  function pConfirmacao() {
    const a = F.agDados;
    if (!a) return irPara('servicos');
    $('#painel').innerHTML = `<div class="sucesso">
        <div class="sucesso-icone" aria-hidden="true">✦</div>
        <h3 class="painel-titulo" tabindex="-1">Agendamento confirmado!</h3>
        <p class="painel-sub" style="margin:0">${esc(primeiroNome(a.nome_cliente))}, guarde o código da sua reserva:</p>
        <div class="codigo-reserva">${esc(a.codigo)}</div>
        <div class="resumo-corpo">${linhasResumo({
          itens: a.itens.map(i => ({ nome: i.nome, coberto: i.coberto_plano })), prof: a.profissional.nome,
          data: fmtData(a.inicio), hora: `${fmtHora(a.inicio)} às ${fmtHora(a.fim)}`,
          dur: R.fmtDur(Math.round((new Date(a.fim) - new Date(a.inicio)) / 60000)),
          desconto: a.desconto_centavos, total: valorTexto(a.valor_total_centavos, a.valor_a_confirmar, a.valor_a_partir), status: STATUS[a.status] })}</div>
        <ul class="orientacoes">
          <li>Chegue alguns minutos antes. Endereço: ${esc(C.endereco)}.</li>
          <li>O pagamento é feito na barbearia, no dia do atendimento.</li>
          <li>${esc(CAT.config.politica_cancelamento || '')} Você cancela em “Minha conta”.</li>
        </ul>
        <div class="acoes">
          <button type="button" class="btn-line" data-acao="ics">Adicionar à agenda</button>
          <a class="btn-line" href="#conta">Minha conta</a>
          <button type="button" class="btn-fill" data-acao="novo"><span>Novo agendamento</span></button>
        </div>
      </div>`;
    semRodape();
  }

  function renderResumo() {
    if (!CAT) return;
    const v = F.servicos.length ? selecao() : null;
    const L = (k, val) => `<div class="linha"><span class="linha-k">${k}</span><span class="linha-v ${val ? '' : 'vazio-v'}">${val || 'a escolher'}</span></div>`;
    const p = F.prof === 'qualquer' ? 'Qualquer um' : (F.prof ? profissional(F.prof).nome : null);
    $('#resumo').innerHTML =
      L('Serviços', F.servicos.length ? F.servicos.map(id => esc(servico(id).nome)).join('<br>') : null) +
      (umProfissional() ? '' : L('Barbeiro', p && esc(p))) +
      L('Data', F.inicio ? esc(fmtDataCurta(F.inicio)) : (F.data ? esc(fmtDataCurta(dataDaChave(F.data))) : null)) +
      L('Horário', F.inicio ? fmtHora(F.inicio) : null) +
      L('Duração', v && v.ok ? R.fmtDur(v.duracao) : null) +
      L('Valor', v && v.ok ? `<span style="color:var(--accent);font-family:Cinzel,serif;font-weight:700">${esc(precoTexto(v))}</span>` : null);
    $('#resumoNota').textContent = 'Pagamento na barbearia. ' + (CAT.config.politica_cancelamento || '');
  }

  /* ═════════════ AÇÕES ═════════════ */
  async function avancar() {
    const b = $('#btnAvancar');
    if (b.disabled) return;
    if (F.passo === 'conta') {
      if (P.sessao && P.perfil) return proximo();
      if (P.sessao && !P.perfil) { if (await salvarPerfilDe('pf', b)) { toast('Cadastro salvo.'); proximo(); } return; }
      F.tentou = true;
      if (!R.validarNome(F.nome) || !R.validarTelefone(F.tel)) return pConta();
      F.tentou = false;
      return proximo();
    }
    if (F.passo === 'revisao') return criarReserva(b);
    proximo();
  }

  async function criarReserva(btn) {
    ocupado(btn, true, 'Confirmando');
    try {
      const dados = { servicos: F.servicos, profissional: profParam(), inicio: F.inicio };
      if (!P.sessao) Object.assign(dados, { nome: F.nome.trim(), telefone: R.soDigitos(F.tel) });
      const r = await api.criarAgendamento(dados);
      F.ag = { codigo: r.codigo, token: r.token };
      delete r.token;
      F.agDados = r;
      if (!P.sessao) guardarLocal(F.ag.codigo, F.ag.token);
      limparCache(); renderMeus();
      irPara('confirmacao');
    } catch (e) {
      ocupado(btn, false);
      if (e.codigo === 'HORARIO_INDISPONIVEL') {
        limparCache(); F.hora = null; F.inicio = null;
        toast(MSG.HORARIO_INDISPONIVEL, true); irPara('horario');
      } else if (e.codigo === 'MUITAS_FALTAS') {
        const quando = F.inicio ? new Intl.DateTimeFormat('pt-BR', { timeZone: C.fuso, weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(F.inicio)) : '';
        const nomes = F.servicos.map(id => (servico(id) || {}).nome).filter(Boolean).join(' + ');
        abrirDialogo('Fale com a barbearia', `<p>${esc(MSG.MUITAS_FALTAS)}</p>`,
          [{ texto: 'Voltar', acao: fecharDialogo },
           { texto: 'Chamar no WhatsApp', classe: 'btn-fill', href: linkWhats(`Olá! Quero marcar ${nomes}${quando ? ` para ${quando}` : ''}.`) }]);
      } else if (['LOGIN_NECESSARIO', 'PERFIL_INCOMPLETO', 'SEM_PERMISSAO'].includes(e.codigo)) {
        if (e.codigo === 'SEM_PERMISSAO') api.sair();
        await carregarConta(); toast(msgErro(e), true); irPara('conta');
      } else toast(msgErro(e), true);
    }
  }

  function baixarICS(a) {
    const z = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Barbearia Nocaute//Agendamento//PT', 'BEGIN:VEVENT',
      `UID:${a.codigo}@barbearianocaute`, `DTSTAMP:${z(new Date().toISOString())}`, `DTSTART:${z(a.inicio)}`, `DTEND:${z(a.fim)}`,
      `SUMMARY:Barbearia Nocaute · ${a.itens.map(i => i.nome).join(' + ')}`,
      `DESCRIPTION:Reserva ${a.codigo} com ${a.profissional.nome}`, `LOCATION:${C.endereco.replace(/,/g, '\\,')}`,
      'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Seu horário na Nocaute', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const l = document.createElement('a'); l.href = url; l.download = `nocaute-${a.codigo}.ics`; l.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const reiniciar = extra => { const { nome, tel, visitante } = F; Object.assign(F, novoFluxo(), { nome, tel, visitante }, extra || {}); limparCache(); };

  $('#btnAvancar').addEventListener('click', avancar);
  $('#btnVoltar').addEventListener('click', anterior);

  $('#painel').addEventListener('click', async e => {
    const t = e.target.closest('button, a');
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.servico) { if (alternarServico(d.servico)) render(); }
    else if (d.prof) {
      F.prof = d.prof; F.hora = null; F.inicio = null; render();
      setTimeout(() => { if (F.passo === 'profissional') proximo(); }, 200);
    }
    else if (d.mes) { F.mes = R.somarDias(`${F.mes}-01`, Number(d.mes) > 0 ? 32 : -1).slice(0, 7); F.data = null; F.hora = null; F.inicio = null; pHorario(); }
    else if (d.dia) { F.data = d.dia; F.hora = null; F.inicio = null; $$('.cal-dia').forEach(b => b.setAttribute('aria-pressed', b.dataset.dia === d.dia)); renderResumo(); carregarSlots(++seq); salvar(); }
    else if (d.inicio) {
      F.inicio = d.inicio; F.hora = d.hora;
      $$('.slot').forEach(b => b.setAttribute('aria-pressed', b === t));
      rodape(true, 'Continuar', true); renderResumo(); salvar();
      $('#btnAvancar').focus({ preventScroll: true });
    }
    else if (d.acao === 'visitante') { F.visitante = true; render(true); }
    else if (d.acao === 'quero-conta') { F.visitante = false; render(true); }
    else if (d.acao === 'sair') sair();
    else if (d.acao === 'ics') baixarICS(F.agDados);
    else if (d.acao === 'novo') { reiniciar(); render(true); }
  });

  /* ═════════════ PLANOS ═════════════ */
  const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const DIAS_LONGOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  // [1,2,3] -> "Segunda a quarta" · [1,3,5] -> "seg, qua, sex"
  function diasTexto(dias) {
    const d = [...dias].sort((a, b) => a - b);
    const seguidos = d.length > 2 && d.every((x, i) => !i || x === d[i - 1] + 1);
    const t = seguidos ? `${DIAS_LONGOS[d[0]]} a ${DIAS_LONGOS[d[d.length - 1]]}` : d.map(x => DIAS_CURTOS[x]).join(', ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  const limiteTexto = (lim, sufixo) => lim ? `até ${lim}x ${sufixo}` : 'ilimitado';
  function renderPlanos() {
    if (!CAT) return;
    const planos = (CAT.planos || []).filter(p => p.ativo);
    if (!planos.length) {
      $('#listaPlanos').innerHTML = `<div class="planos-vazio">Os planos mensais da Nocaute estão sendo preparados.<br>
        Quer saber primeiro? <a href="https://wa.me/${C.whatsapp}" target="_blank" rel="noopener" style="color:var(--accent)">Chame a gente no WhatsApp</a>.</div>`;
      return;
    }
    const minhas = new Map(P.assinaturas.filter(a => ['ativa', 'pendente', 'inadimplente'].includes(a.status)).map(a => [a.plano_id, a]));
    const nomesServ = p => CAT.planoServicos.filter(x => x.plano_id === p.id)
      .map(x => `${esc(servico(x.servico_id) ? servico(x.servico_id).nome : x.servico_id)} · ${limiteTexto(x.limite_por_ciclo, 'por mês')}`);
    $('#listaPlanos').innerHTML = '<div class="planos-grade">' + planos.map(p => {
      const r = p.restricoes || {};
      const restr = r.dias_semana && r.dias_semana.length ? diasTexto(r.dias_semana) : '';
      const meu = minhas.get(p.id);
      const botao = !meu ? `<button type="button" class="btn-fill" data-plano="${p.id}" ${p.disponivel_contratacao ? '' : 'disabled'}>
          <span>${p.disponivel_contratacao ? 'Quero assinar' : 'Indisponível no momento'}</span></button>`
        : meu.status === 'ativa' ? `<a href="#agendar" class="btn-fill" data-usar-plano><span>Você assina · Agendar</span></a>`
        : meu.status === 'pendente' ? (p.link_pagamento
            ? `<a class="btn-fill" target="_blank" rel="noopener" href="${esc(p.link_pagamento)}"><span>Pedido enviado · Pagar no cartão</span></a>`
            : `<a class="btn-line" style="width:100%" target="_blank" rel="noopener" href="${linkWhats(`Olá! Pedi o ${p.nome} pelo site e quero combinar o pagamento.`)}">Pedido enviado · falar no WhatsApp</a>`)
        : `<a class="btn-line" style="width:100%" target="_blank" rel="noopener" href="${linkWhats(`Olá! Quero renovar o meu ${p.nome}.`)}">Renovar na barbearia</a>`;
      return `<article class="plano">
        <div class="plano-topo">
          <h3 class="plano-nome">${esc(p.nome)}</h3>
          <p class="plano-preco">${R.fmtPreco(p.preco_centavos)} <small>/ mês</small></p>
          ${p.descricao ? `<p class="plano-desc">${esc(p.descricao)}</p>` : ''}
        </div>
        <div class="plano-corpo"><dl>
          <div><dt>Inclui</dt><dd><ul>${nomesServ(p).map(x => `<li>${x}</li>`).join('')}</ul></dd></div>
          ${p.limite_usos_ciclo ? `<div><dt>Limite total</dt><dd>${p.limite_usos_ciclo} atendimentos por mês</dd></div>` : ''}
          ${restr ? `<div><dt>Dias</dt><dd>${esc(restr)}</dd></div>` : ''}
          ${p.regras ? `<div><dt>Regras</dt><dd>${esc(p.regras)}</dd></div>` : ''}
          <div><dt>Pagamento</dt><dd>${esc(p.renovacao || 'Mensal, pago na barbearia.')}</dd></div>
        </dl></div>
        <div class="plano-rodape">${botao}</div>
      </article>`;
    }).join('') + '</div>';
  }

  function termosHTML(p) {
    const r = p.restricoes || {};
    return `<dl class="termos">
      <dt>Plano</dt><dd>${esc(p.nome)}</dd>
      <dt>Valor</dt><dd>${R.fmtPreco(p.preco_centavos)} por mês, ${p.link_pagamento ? 'no cartão de crédito, pela página de pagamento da Stone' : 'pago na barbearia'}. O plano começa a valer quando a barbearia confirma o primeiro pagamento.</dd>
      <dt>O que inclui</dt><dd>${CAT.planoServicos.filter(x => x.plano_id === p.id).map(x => `${esc(servico(x.servico_id) ? servico(x.servico_id).nome : x.servico_id)} (${limiteTexto(x.limite_por_ciclo, 'por mês')})`).join('; ')}.${p.limite_usos_ciclo ? ` Limite total de ${p.limite_usos_ciclo} atendimentos por mês.` : ''} Usos não acumulam para o mês seguinte.</dd>
      ${r.dias_semana && r.dias_semana.length ? `<dt>Dias</dt><dd>Benefício válido apenas ${r.dias_semana.map(d => DIAS_CURTOS[d]).join(', ')}.</dd>` : ''}
      ${p.regras ? `<dt>Regras de uso</dt><dd>${esc(p.regras)}</dd>` : ''}
      <dt>Renovação</dt><dd>${esc(p.renovacao || 'Mensal, pago na barbearia.')} ${p.link_pagamento && p.cobranca_recorrente
        ? 'A cobrança se repete todo mês no cartão até o plano ser cancelado.' : 'Sem a renovação, os benefícios ficam suspensos.'}</dd>
      <dt>Cancelamento</dt><dd>${esc(p.cancelamento || 'Você pode cancelar quando quiser em Minha conta. Os benefícios param no momento do cancelamento.')}${p.link_pagamento && p.cobranca_recorrente ? ' A barbearia é avisada para encerrar a cobrança no cartão.' : ''}</dd>
    </dl>`;
  }

  // assinar: termos → entrar → WhatsApp (se faltar) → pedido → ativação na barbearia
  function contratar(planoId, jaAceitou) {
    const p = CAT.planos.find(x => x.id === planoId);
    if (!p) return;
    const seguir = () => (!P.sessao ? etapaLogin() : (!P.perfil ? etapaPerfil() : etapaConfirmar()));
    const etapaTermos = () => {
      abrirDialogo('Assinar plano', `<p>Leia as condições antes de continuar.</p>${termosHTML(p)}
        <label class="check"><input type="checkbox" id="aceiteTermos"> <span>Li e aceito as condições do ${esc(p.nome)}.</span></label>`,
        [{ texto: 'Voltar', acao: fecharDialogo },
         { texto: 'Aceitar e continuar', classe: 'btn-fill', acao: () => {
           if (!$('#aceiteTermos').checked) { toast(MSG.ACEITE_OBRIGATORIO, true); $('#aceiteTermos').focus(); return; }
           seguir();
         } }]);
    };
    const etapaLogin = () => {
      abrirDialogo('Entrar', '<p>Entre para assinar. Se você já é cliente, use a mesma conta.</p><div id="dlgLogin" data-plano="' + esc(p.id) + '"></div>', []);
      montarLogin($('#dlgLogin'), seguir, 'plano');
    };
    const etapaPerfil = () => {
      abrirDialogo('Só falta seu WhatsApp', `<p>Conectado como ${esc(P.sessao.email)}.</p>${formPerfil('pl')}`,
        [{ texto: 'Salvar e continuar', classe: 'btn-fill', acao: async el => { if (await salvarPerfilDe('pl', el)) seguir(); } }]);
      ligarMascara('plTel');
    };
    const etapaConfirmar = () => {
      abrirDialogo('Confirmar pedido', `<div class="quem"><span>Assinando como <strong>${esc(P.perfil.nome)}</strong></span></div>
        <div class="resumo-corpo" style="border:1px solid var(--gray-line)">
          <div class="linha"><span class="linha-k">Plano</span><span class="linha-v">${esc(p.nome)}</span></div>
          <div class="linha"><span class="linha-k">Valor</span><span class="linha-v destaque">${R.fmtPreco(p.preco_centavos)} / mês</span></div>
          <div class="linha"><span class="linha-k">Pagamento</span><span class="linha-v">${p.link_pagamento ? `Cartão de crédito (Stone)${p.cobranca_recorrente ? ', todo mês' : ''}` : 'Na barbearia'}</span></div>
        </div>${p.link_pagamento ? '<p style="margin-top:1rem">No próximo passo abre a página segura da Stone para você pagar no cartão.</p>' : ''}<div id="plErro"></div>`,
        [{ texto: 'Voltar', acao: fecharDialogo },
         { texto: p.link_pagamento ? 'Continuar para o pagamento' : 'Enviar pedido', classe: 'btn-fill', acao: async el => {
           ocupado(el, true, 'Enviando');
           try {
             const r = await api.solicitarPlano({ plano_id: p.id, aceite: true, termos_versao: p.termos_versao });
             await carregarConta(); renderPlanos(); renderMeus();
             const link = (r && r.link_pagamento) || p.link_pagamento;
             if (link) return abrirDialogo('Falta só o pagamento', `<p>Pronto, ${esc(primeiroNome(P.perfil.nome))}! Seu pedido do <strong>${esc(p.nome)}</strong> foi registrado.</p>
               <p>Agora pague no cartão, na página segura da Stone (${R.fmtPreco(p.preco_centavos)}${p.cobranca_recorrente ? ' por mês' : ''}). O plano começa a valer assim que a barbearia confirmar o pagamento.</p>
               <p>Se fechar agora, o botão de pagar continua no card do plano.</p>`,
               [{ texto: 'Depois', acao: fecharDialogo },
                { texto: 'Pagar no cartão', classe: 'btn-fill', href: link }]);
             abrirDialogo('Pedido enviado', `<p>Pronto, ${esc(primeiroNome(P.perfil.nome))}! Seu pedido do <strong>${esc(p.nome)}</strong> chegou na barbearia.</p>
               <p>O plano começa a valer assim que você fizer o primeiro pagamento no balcão. Depois disso, ele entra sozinho nos seus agendamentos.</p>`,
               [{ texto: 'Fechar', acao: fecharDialogo },
                { texto: 'Combinar pelo WhatsApp', classe: 'btn-fill', href: linkWhats(`Olá! Sou ${P.perfil.nome} e pedi o ${p.nome} pelo site. Quero combinar o pagamento.`) }]);
           } catch (e) { ocupado(el, false); $('#plErro').innerHTML = `<div class="aviso erro" style="margin-top:1rem">${esc(msgErro(e))}</div>`; }
         } }]);
    };
    jaAceitou ? seguir() : etapaTermos();
  }
  $('#listaPlanos').addEventListener('click', e => { const b = e.target.closest('[data-plano]'); if (b && !b.disabled) contratar(b.dataset.plano); });

  /* ═════════════ MINHA CONTA ═════════════ */
  function renderContaTopo() {
    const nav = $('#navConta'), hero = $('#heroConta');
    if (P.sessao) {
      const nome = (P.perfil && P.perfil.nome) || P.sessao.nome || P.sessao.email;
      nav.innerHTML = `<span class="avatar-letra" aria-hidden="true">${esc(nome[0].toUpperCase())}</span><span class="txt">Minha conta</span>`;
      nav.setAttribute('aria-label', 'Minha conta');
      hero.innerHTML = `Olá, ${esc(primeiroNome(nome))}. <a href="#conta">Ver meus horários</a>`;
    } else {
      nav.innerHTML = '<span class="txt">Entrar</span>';
      nav.setAttribute('aria-label', 'Entrar');
      hero.innerHTML = 'Já é cliente? <a href="#conta">Entrar</a> para ver seus horários e seu plano.';
    }
  }

  async function renderMeus() {
    const lista = $('#listaMeus'), caixa = $('#caixaLogin');
    if (P.sessao) {
      const nome = (P.perfil && P.perfil.nome) || P.sessao.nome || '';
      caixa.innerHTML = `<h3>${esc(nome || 'Sua conta')}</h3><p>${esc(P.sessao.email)}${P.perfil ? '<br>WhatsApp ' + esc(R.mascaraTelefone(P.perfil.telefone)) : ''}</p>
        ${P.perfil ? '<button type="button" class="btn-line" style="width:100%;margin-bottom:0.6rem" data-editar>Alterar dados</button>' : ''}
        <button type="button" class="btn-line" style="width:100%" data-sair>Sair</button>`;
    } else {
      caixa.innerHTML = '<h3>Entre na sua conta</h3><p>Veja seus horários, seu histórico e seu plano em qualquer aparelho.</p><div id="caixaForm"></div>';
      montarLogin($('#caixaForm'), () => toast('Pronto, você entrou.'), 'conta');
    }

    lista.innerHTML = '<p class="vazio"><span class="spinner"></span></p>';
    const porCodigo = new Map();
    if (P.sessao) { try { (await api.meusAgendamentos()).forEach(a => porCodigo.set(a.codigo, a)); } catch (e) {} }
    await Promise.all(meusLocais().filter(l => !porCodigo.has(l.codigo)).map(async l => {
      try { porCodigo.set(l.codigo, Object.assign(await api.consultar(l.codigo, l.token), { _token: l.token })); } catch (e) {}
    }));
    const agora = Date.now();
    const todos = [...porCodigo.values()].sort((a, b) => a.inicio.localeCompare(b.inicio));
    const futuros = todos.filter(a => new Date(a.fim) > agora && a.status === 'confirmado');
    const outros = todos.filter(a => !futuros.includes(a)).reverse().slice(0, 15);
    const item = a => `<div class="reserva">
        <div><p class="reserva-data">${esc(fmtData(a.inicio))} · ${fmtHora(a.inicio)}</p></div>
        <p class="reserva-info">${a.itens.map(i => esc(i.nome)).join(' + ')} · ${esc(a.profissional.nome)}<br>
          ${esc(a.codigo)} · ${esc(a.coberto_plano && !a.valor_total_centavos ? 'Coberto pelo plano' : valorTexto(a.valor_total_centavos, a.valor_a_confirmar, a.valor_a_partir))}</p>
        <div class="reserva-acoes">
          <span class="selo ${a.status}">${esc(STATUS[a.status] || a.status)}</span>
          ${a.pode_cancelar ? `<button type="button" class="btn-link" data-cancelar="${a.codigo}">Cancelar</button>` : ''}
        </div>
      </div>`;
    if (!P.sessao && !todos.length) {
      lista.innerHTML = '<p class="vazio" style="text-align:left">Entre para ver seus horários e seu histórico.</p>';
      lista._dados = porCodigo; return;
    }
    lista.innerHTML =
      (P.assinaturas.length ? '<p class="grupo-titulo">Plano</p>' + P.assinaturas.map(x => `<div class="reserva">
          <div><p class="reserva-data">${esc(x.plano)}</p></div>
          <p class="reserva-info">${x.status === 'pendente' ? (x.link_pagamento
              ? `Aguardando o pagamento no cartão. <a href="${esc(x.link_pagamento)}" target="_blank" rel="noopener" style="color:var(--accent)">Pagar agora</a>`
              : 'Começa a valer após o primeiro pagamento na barbearia.')
            : `${x.ciclo_fim ? `${x.renova_sozinho && x.status === 'ativa' ? 'Renova no cartão em' : 'Mês pago até'} ${esc(x.renova_sozinho && x.status === 'ativa' ? R.somarDias(x.ciclo_fim, 1).split('-').reverse().join('/') : x.ciclo_fim.split('-').reverse().join('/'))} · ` : ''}${x.usos_no_ciclo} ${x.usos_no_ciclo === 1 ? 'uso' : 'usos'} neste mês${x.limite_usos_ciclo ? ` de ${x.limite_usos_ciclo}` : ''}`}</p>
          <div class="reserva-acoes"><span class="selo ${x.status}">${esc(STATUS[x.status] || x.status)}</span>
          ${['ativa', 'pendente', 'inadimplente'].includes(x.status) ? `<button type="button" class="btn-link" data-cancelar-plano="${x.id}">Cancelar plano</button>` : ''}</div>
        </div>`).join('') : '') +
      '<p class="grupo-titulo">Próximos horários</p>' + (futuros.length ? futuros.map(item).join('') : '<p class="vazio" style="text-align:left;padding:0.5rem 0 1rem">Nenhum horário marcado. <a href="#agendar" style="color:var(--accent)">Agendar agora</a></p>') +
      (outros.length ? '<p class="grupo-titulo">Histórico</p>' + outros.map(item).join('') : '');
    lista._dados = porCodigo;
  }
  $('#listaMeus').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    const dados = $('#listaMeus')._dados;
    if (t.dataset.cancelar) {
      const a = dados.get(t.dataset.cancelar);
      if (!(await confirmar('Cancelar agendamento', `Cancelar ${esc(a.itens.map(i => i.nome).join(' + '))} em ${esc(fmtData(a.inicio))} às ${fmtHora(a.inicio)}? O horário será liberado.`, 'Cancelar agendamento'))) return;
      ocupado(t, true, '');
      try {
        if (a._token) await api.cancelar(a.codigo, a._token); else await api.cancelarLogado(a.codigo);
        limparCache();
        if (F.ag && F.ag.codigo === a.codigo) { reiniciar(); render(); }
        toast('Agendamento cancelado.'); await carregarConta(); renderMeus();
      } catch (err) { ocupado(t, false); toast(msgErro(err), true); }
    } else if (t.dataset.cancelarPlano) {
      const ass = P.assinaturas.find(x => x.id === t.dataset.cancelarPlano) || {};
      if (!(await confirmar('Cancelar plano', ass.renova_sozinho
            ? 'Os benefícios do plano param a partir de agora e a barbearia é avisada para encerrar a cobrança mensal no cartão.'
            : 'Os benefícios do plano param a partir de agora.', 'Cancelar plano'))) return;
      try { await api.cancelarAssinatura(t.dataset.cancelarPlano); toast('Plano cancelado.'); await carregarConta(); renderMeus(); renderPlanos(); } catch (err) { toast(msgErro(err), true); }
    }
  });
  $('#caixaLogin').addEventListener('click', e => {
    if (e.target.closest('[data-sair]')) sair();
    else if (e.target.closest('[data-editar]')) {
      abrirDialogo('Seus dados', formPerfil('ed'), [
        { texto: 'Cancelar', acao: fecharDialogo },
        { texto: 'Salvar', classe: 'btn-fill', acao: async el => { if (await salvarPerfilDe('ed', el)) { fecharDialogo(); toast('Dados atualizados.'); renderMeus(); } } }]);
      ligarMascara('edTel');
    }
  });

  /* ═════════════ NAVEGAÇÃO, BARRA FIXA, STATUS ═════════════ */
  const hamburger = $('#hamburger'), navLinks = $('#navLinks');
  const setMenu = aberto => { navLinks.classList.toggle('open', aberto); hamburger.setAttribute('aria-expanded', aberto); hamburger.setAttribute('aria-label', aberto ? 'Fechar menu' : 'Abrir menu'); };
  hamburger.addEventListener('click', () => setMenu(!navLinks.classList.contains('open')));
  navLinks.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('click', e => { if (navLinks.classList.contains('open') && !e.target.closest('#navbar')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

  let fluxoVisivel = false;
  new IntersectionObserver(en => { fluxoVisivel = en[0].isIntersecting; document.body.classList.toggle('fluxo-ativo', fluxoVisivel); atualizarBarra(); },
    { rootMargin: '-20% 0px -20% 0px' }).observe($('#agendar'));
  const navObs = new IntersectionObserver(en => en.forEach(x => {
    if (x.isIntersecting) $$('.nav-links a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + x.target.id));
  }), { rootMargin: '-45% 0px -50% 0px' });
  ['agendar', 'planos', 'conta'].forEach(id => navObs.observe(document.getElementById(id)));
  let ultimaAtualizacao = 0;
  const atualizarConta = () => { if (CAT && Date.now() - ultimaAtualizacao > 3000) { ultimaAtualizacao = Date.now(); renderMeus(); } };
  new IntersectionObserver(en => { if (en[0].isIntersecting) atualizarConta(); }, { threshold: 0.15 }).observe($('#conta'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizarConta(); });

  function atualizarBarra() {
    if (!CAT) return;
    const v = F.servicos.length ? selecao() : null;
    if (v && v.ok) {
      $('#barraTitulo').textContent = F.servicos.map(id => servico(id).nome).join(' + ');
      $('#barraSub').textContent = `${R.fmtDur(v.duracao)} · ${precoTexto(v)}`;
      $('#barraBtn').innerHTML = '<span>Continuar</span>';
    } else {
      $('#barraTitulo').textContent = 'Agende seu horário';
      $('#barraSub').textContent = 'Escolha o serviço para começar';
      $('#barraBtn').innerHTML = '<span>Agendar</span>';
    }
    $('#barra').classList.toggle('mostrar', !fluxoVisivel && window.scrollY > 300);
  }
  window.addEventListener('scroll', atualizarBarra, { passive: true });

  const hFmt = x => { const [h, m] = x.slice(0, 5).split(':'); return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`; };
  function statusAberto() {
    const ag = R.agoraNoFuso(C.fuso), dow = R.diaSemana(ag.data);
    const f = d => CAT.funcionamento.find(h => h.dia_semana === d);
    const hoje = f(dow);
    let txt, aberto = false;
    if (hoje && ag.min >= R.horaParaMin(hoje.abre) && ag.min < R.horaParaMin(hoje.fecha)) { aberto = true; txt = `<strong>Aberto agora</strong> · fecha às ${hFmt(hoje.fecha)}`; }
    else if (hoje && ag.min < R.horaParaMin(hoje.abre)) txt = `Fechado · abre hoje às ${hFmt(hoje.abre)}`;
    else {
      let i = 1; while (i <= 7 && !f((dow + i) % 7)) i++;
      const p = f((dow + i) % 7);
      txt = p ? `Fechado · abre ${i === 1 ? 'amanhã' : ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][(dow + i) % 7]} às ${hFmt(p.abre)}` : 'Fechado';
    }
    $('#statusAberto').classList.toggle('is-open', aberto);
    $('#statusTexto').innerHTML = txt;
    $('#ano').textContent = ag.data.slice(0, 4);
  }

  document.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName !== 'IMG' || !img.dataset.inicial) return;
    const s = document.createElement('span'); s.className = 'avatar-letra'; s.textContent = img.dataset.inicial; s.setAttribute('aria-hidden', 'true');
    img.replaceWith(s);
  }, true);

  /* ═════════════ INÍCIO ═════════════ */
  $$('#logoLink, #linkSite').forEach(a => { a.href = C.siteUrl || '/'; });
  if (api.modo === 'demo') {
    $('#demoBar').hidden = false; document.body.classList.add('tem-demo');
    $('#limparDemo').addEventListener('click', async () => {
      if (!(await confirmar('Limpar dados de teste', 'Apaga reservas, planos, login e edições de demonstração deste aparelho.', 'Limpar'))) return;
      api.limparDemo(); localStorage.removeItem('nc_meus'); sessionStorage.removeItem('nc_fluxo'); location.reload();
    });
  }

  (async function iniciar() {
    let erroLogin = null;
    try { await api.capturarRetornoOAuth(); } catch (e) { erroLogin = e; }
    try { await api.renovarSessao(); } catch (e) {}
    try { CAT = (await Promise.all([api.catalogo(), carregarConta()]))[0]; }
    catch (e) {
      $('#painel').innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div><p class="vazio">Você também pode agendar pelo <a style="color:var(--accent)" href="https://wa.me/${C.whatsapp}" target="_blank" rel="noopener">WhatsApp</a>.</p>`;
      return;
    }
    F.servicos = F.servicos.filter(id => servico(id));
    if (umProfissional()) F.prof = CAT.profissionais[0].id;
    if (F.prof && F.prof !== 'qualquer' && !profissional(F.prof)) F.prof = null;
    if (F.passo === 'confirmacao') { if (!F.ag) F.passo = 'servicos'; }
    else if (F.passo !== 'servicos' && !selecao().ok) F.passo = 'servicos';
    else if (F.passo === 'revisao' && !F.inicio) F.passo = 'horario';
    if (F.passo === 'conta' && identificado()) F.passo = 'revisao';
    const q = new URLSearchParams(location.search);
    if (q.get('servico') && servico(q.get('servico'))) { F.servicos = [q.get('servico')]; F.passo = 'servicos'; F.ag = null; }
    if (q.get('barbeiro') && profissional(q.get('barbeiro'))) F.prof = q.get('barbeiro');

    statusAberto(); setInterval(statusAberto, 60000);
    renderContaTopo(); render(); renderPlanos(); renderMeus();
    if (erroLogin) toast(msgErro(erroLogin), true);

    let pos = null;
    try { pos = JSON.parse(sessionStorage.getItem('nc_pos_login') || 'null'); sessionStorage.removeItem('nc_pos_login'); } catch (e) {}
    if (pos && pos.plano && P.sessao) { $('#planos').scrollIntoView(); contratar(pos.plano, true); }
    else if (pos && pos.contexto === 'fluxo' && P.sessao) $('#agendar').scrollIntoView();
  })();
})();
