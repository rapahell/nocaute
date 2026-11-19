/* ════════════════════════════════════════════════════════════
   Painel da barbearia.
   • Dono: agenda, clientes e resumo do mês, serviços e preços, planos e
     assinantes, horários, equipe, regras e acessos.
   • Recepção: agenda, clientes e assinantes.
   • Barbeiro: só a própria agenda.
   Quem pode o quê é decidido no banco; aqui é só a tela.
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const C = window.NC_CONFIG, R = window.NC_Regras;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = window.NC_API.criar(C);

  const MSG = {
    SEM_PERMISSAO: 'Você não tem permissão para isso.', TRANSICAO_INVALIDA: 'Esse horário não pode mudar para essa situação.',
    AGENDAMENTO_NAO_CANCELAVEL: 'Esse horário não pode mais ser cancelado.', PERIODO_INVALIDO: 'O fim precisa ser depois do início.',
    PROFISSIONAL_OBRIGATORIO: 'Escolha o barbeiro.', CODIGO_INVALIDO: 'Código incorreto ou expirado.', EMAIL_INVALIDO: 'Informe um e-mail válido.',
    SEM_CONEXAO: 'Sem conexão com o servidor.', LOGIN_CANCELADO: 'O login não foi concluído.',
    NOME_INVALIDO: 'Informe um nome com pelo menos 2 letras.', PRECO_INVALIDO: 'Informe um preço válido.',
    DURACAO_INVALIDA: 'A duração precisa ficar entre 5 e 480 minutos.', PLANO_SEM_SERVICOS: 'Marque pelo menos um serviço incluso no plano.',
    VALOR_FORA_DO_LIMITE: 'Um dos valores está fora do permitido.', USUARIO_NAO_ENCONTRADO: 'Essa pessoa ainda não entrou no sistema. Peça para ela entrar uma vez no painel com esse e-mail e tente de novo.',
    CLIENTE_NAO_ENCONTRADO: 'Cliente não encontrado.', LINK_INVALIDO: 'O link de pagamento precisa começar com https://',
    NAO_REMOVE_A_SI_MESMO: 'Você não pode remover o seu próprio acesso.', ASSINATURA_ENCERRADA: 'Essa assinatura foi encerrada. O cliente precisa fazer um novo pedido.'
  };
  const msgErro = e => MSG[e && e.codigo] || 'Algo deu errado. Tente de novo.';
  const STATUS = { confirmado: 'Confirmado', cancelado: 'Cancelado', concluido: 'Atendido', nao_compareceu: 'Não veio' };
  const STATUS_ASS = { pendente: 'Aguardando pagamento', ativa: 'Ativa', inadimplente: 'Renovação atrasada', cancelada: 'Cancelada', expirada: 'Encerrada' };
  const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const DIAS_C = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const ICONE_GOOGLE = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>';

  const hoje = () => R.agoraNoFuso(C.fuso).data;
  const fmtHora = iso => new Intl.DateTimeFormat('pt-BR', { timeZone: C.fuso, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const fmtDiaLongo = k => new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(k + 'T12:00:00Z'));
  const fmtDataHora = iso => new Intl.DateTimeFormat('pt-BR', { timeZone: C.fuso, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const fmtDataBR = d => d ? d.split('-').reverse().join('/') : '';
  const primeiro = n => String(n || '').trim().split(' ')[0];
  const hhmm = t => String(t || '').slice(0, 5);
  // "70" / "70,50" / "R$ 70" -> centavos
  const paraCentavos = v => { const t = String(v || '').replace(/[^\d,.]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'); return t === '' ? null : Math.round(parseFloat(t) * 100); };
  const deCentavos = c => c == null ? '' : (c / 100).toFixed(2).replace('.', ',').replace(',00', '');

  const A = { eu: null, cat: null, adm: null, secao: 'agenda', dia: hoje(), prof: null, cancelados: false, agenda: [], bloqueios: [] };

  function toast(txt, erro) {
    const t = $('#toast'); t.textContent = txt; t.classList.toggle('erro', !!erro); t.classList.add('mostrar');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('mostrar'), 4000);
  }
  function ocupado(b, sim, txt) {
    if (!b) return;
    if (sim) { b.dataset.txt = b.innerHTML; b.disabled = true; b.innerHTML = `<span class="spinner"></span> ${esc(txt || '')}`; }
    else { b.disabled = false; if (b.dataset.txt) b.innerHTML = b.dataset.txt; }
  }
  const dlg = $('#dlg');
  function dialogo(titulo, corpo, botoes) {
    $('#dlgTitulo').textContent = titulo; $('#dlgCorpo').innerHTML = corpo;
    const r = $('#dlgRodape'); r.innerHTML = '';
    (botoes || []).forEach(b => {
      const el = document.createElement('button'); el.type = 'button'; el.className = 'btn ' + (b.classe || ''); el.textContent = b.texto;
      el.addEventListener('click', () => b.acao(el)); r.appendChild(el);
    });
    r.hidden = !(botoes && botoes.length);
    if (!dlg.open) dlg.showModal();
  }
  const fechar = () => dlg.open && dlg.close();
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-fechar]')) fechar(); });
  const erroNo = (id, e) => { const box = $('#' + id); if (box) box.innerHTML = `<div class="aviso erro">${esc(typeof e === 'string' ? e : msgErro(e))}</div>`; };
  async function salvarCom(el, fn, ok, erroId) {
    ocupado(el, true, 'Salvando');
    try { await fn(); fechar(); if (ok) toast(ok); await recarregarCatalogo(); }
    catch (e) { ocupado(el, false); erroId ? erroNo(erroId, e) : toast(msgErro(e), true); }
  }

  /* ═════════════ ENTRAR ═════════════ */
  function telaEntrar() {
    $('#quem').innerHTML = ''; $('#secoes').hidden = true;
    const demo = api.modo === 'demo';
    $('#app').innerHTML = `<div class="entrar">
      <p class="rotulo">// Barbearia Nocaute</p>
      <h1 class="titulo">Painel da barbearia</h1>
      <p>Entre com a conta liberada pelo dono. Cada barbeiro vê a própria agenda.</p>
      ${demo ? `<div style="display:grid;gap:0.5rem">
          <button type="button" class="btn cheio" data-demo="dono">Entrar como dono</button>
          <button type="button" class="btn" data-demo="recepcao">Entrar como recepção</button>
          ${A.cat.profissionais.map(p => `<button type="button" class="btn" data-demo="${p.id}">Entrar como ${esc(p.nome)} (barbeiro)</button>`).join('')}
        </div><p style="margin:1rem 0 0;font-size:0.82rem">Demonstração: escolha um perfil. No ar, cada um entra com o próprio Google.</p>` : `
        <button type="button" class="btn-google" data-google>${ICONE_GOOGLE}<span>Entrar com Google</span></button>
        <div class="divisor">ou com e-mail</div>
        <div class="campo"><label for="lgEmail">E-mail</label><input type="email" id="lgEmail" autocomplete="email"></div>
        <div class="campo" id="lgCodCampo" hidden><label for="lgCod">Código do e-mail</label><input type="text" id="lgCod" inputmode="numeric" autocomplete="one-time-code"></div>
        <div id="lgErro"></div>
        <button type="button" class="btn" style="width:100%" id="lgBtn">Receber código</button>`}
    </div>`;
    $('#app').onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.demo) { ocupado(b, true); await api.entrarDemoComo(b.dataset.demo); return iniciar(); }
        if (b.dataset.google !== undefined) { ocupado(b, true, 'Abrindo o Google'); await api.entrarGoogle(); return iniciar(); }
        if (b.id === 'lgBtn') {
          const email = $('#lgEmail').value.trim();
          if ($('#lgCodCampo').hidden) {
            if (!email || !R.validarEmail(email)) throw { codigo: 'EMAIL_INVALIDO' };
            ocupado(b, true); await api.enviarCodigo(email); ocupado(b, false);
            $('#lgCodCampo').hidden = false; $('#lgEmail').readOnly = true; b.textContent = 'Entrar'; $('#lgCod').focus();
          } else { ocupado(b, true); await api.verificarCodigo(email, $('#lgCod').value.trim()); return iniciar(); }
        }
      } catch (x) { ocupado(b, false); const box = $('#lgErro'); if (box) box.innerHTML = `<div class="aviso erro">${esc(msgErro(x))}</div>`; else toast(msgErro(x), true); }
    };
  }
  function telaSemAcesso() {
    const s = api.sessao();
    $('#secoes').hidden = true;
    $('#quem').innerHTML = `<button type="button" class="btn mini" id="sair">Sair</button>`;
    $('#sair').onclick = () => { api.sair(); iniciar(); };
    $('#app').innerHTML = `<div class="entrar"><h1 class="titulo">Sem acesso ao painel</h1>
      <p>A conta <strong>${esc(s && s.email)}</strong> não está liberada. Peça ao dono para liberar esse e-mail em Equipe e ajustes.</p>
      <a class="btn" href="index.html">Ir para o agendamento</a></div>`;
  }

  /* ═════════════ ESTRUTURA ═════════════ */
  const ehBarbeiro = () => A.eu.papel === 'barbeiro';
  const ehDono = () => A.eu.papel === 'dono';
  const nomeProf = id => { const p = (A.adm ? A.adm.profissionais : A.cat.profissionais).find(x => x.id === id); return p ? p.nome : 'Barbearia'; };
  const SECOES = () => ehDono() ? [['agenda', 'Agenda'], ['clientes', 'Clientes'], ['servicos', 'Serviços e preços'], ['planos', 'Planos'], ['horarios', 'Horários'], ['equipe', 'Equipe e ajustes']]
    : A.eu.papel === 'recepcao' ? [['agenda', 'Agenda'], ['clientes', 'Clientes'], ['planos', 'Assinantes']] : [];

  function montarPainel() {
    const nome = ehBarbeiro() ? A.eu.profissional_nome : (ehDono() ? 'Dono' : 'Recepção');
    $('#quem').innerHTML = `<span><strong>${esc(nome)}</strong> <span class="papel">· ${esc(A.eu.email || '')}</span></span><button type="button" class="btn mini" id="sair">Sair</button>`;
    $('#sair').onclick = () => { api.sair(); toast('Você saiu.'); iniciar(); };
    const s = SECOES();
    $('#secoes').hidden = !s.length;
    $('#secoes').innerHTML = s.map(([id, n]) => `<button type="button" role="tab" data-secao="${id}" aria-selected="${A.secao === id}">${n}</button>`).join('');
    $('#secoes').onclick = e => { const b = e.target.closest('[data-secao]'); if (b) abrirSecao(b.dataset.secao); };
    if (ehBarbeiro()) A.prof = A.eu.profissional_id;
    abrirSecao(s.some(x => x[0] === A.secao) ? A.secao : 'agenda');
  }
  function abrirSecao(id) {
    A.secao = id;
    try { sessionStorage.setItem('nc_painel_secao', id); } catch (e) {}
    $$('#secoes [data-secao]').forEach(b => b.setAttribute('aria-selected', b.dataset.secao === id));
    $('#app').onclick = null;
    ({ agenda: secaoAgenda, clientes: secaoClientes, servicos: secaoServicos, planos: secaoPlanos, horarios: secaoHorarios, equipe: secaoEquipe })[id]();
  }
  async function recarregarCatalogo() {
    if (ehBarbeiro()) return;
    A.adm = await api.adminCatalogo();
    if (A.secao !== 'agenda') abrirSecao(A.secao);
  }

  /* ═════════════ AGENDA ═════════════ */
  function secaoAgenda() {
    const profs = (A.adm ? A.adm.profissionais : A.cat.profissionais).filter(p => p.ativo);
    $('#app').innerHTML = `
      <div class="barra-dia">
        <div class="navdia">
          <button type="button" class="seta" data-dia="-1" aria-label="Dia anterior">‹</button>
          <div class="dia-titulo" id="diaTitulo"></div>
          <button type="button" class="seta" data-dia="1" aria-label="Próximo dia">›</button>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
          <input type="date" class="data-input" id="dataInput" aria-label="Escolher data">
          <button type="button" class="btn" data-acao="hoje">Hoje</button>
          <button type="button" class="btn cheio" data-acao="bloquear">Bloquear horário</button>
        </div>
      </div>
      ${ehBarbeiro() ? '' : `<div class="abas" id="abas" style="margin-bottom:1.2rem">
          <button type="button" data-prof="" aria-pressed="${!A.prof}">Todos</button>
          ${profs.map(p => `<button type="button" data-prof="${p.id}" aria-pressed="${A.prof === p.id}">${esc(p.nome)}</button>`).join('')}
        </div>`}
      <div class="numeros" id="numeros"></div>
      <div class="grade">
        <div>
          <div class="linha-tempo" id="linhaTempo"><p class="vazio"><span class="spinner"></span></p></div>
          <label class="check mostrar-cancelados"><input type="checkbox" id="verCancelados" ${A.cancelados ? 'checked' : ''}> Mostrar cancelados</label>
        </div>
        <aside class="lado">
          <div class="caixa"><h2 class="titulo">Lembretes</h2>
            <p>Mande pelo WhatsApp um lembrete para cada cliente com horário amanhã. Diminui as faltas.</p>
            <button type="button" class="btn cheio" style="width:100%" data-acao="lembretes">Lembrar clientes de amanhã</button></div>
          <div class="caixa"><h2 class="titulo">Atalhos</h2>
            <p>Abra o agendamento para marcar um cliente que ligou ou chegou sem horário.</p>
            <a class="btn" style="width:100%" href="index.html#agendar" target="_blank" rel="noopener">Abrir agendamento</a></div>
        </aside>
      </div>`;
    $('#verCancelados').onchange = e => { A.cancelados = e.target.checked; desenharDia(); };
    $('#dataInput').onchange = e => { if (e.target.value) { A.dia = e.target.value; carregarDia(); } };
    $('#app').onclick = cliqueAgenda;
    carregarDia();
  }

  async function carregarDia(silencioso) {
    if (A.secao !== 'agenda') return;
    const dia = A.dia;
    $('#diaTitulo').innerHTML = `${dia === hoje() ? '<small>Hoje</small>' : (dia === R.somarDias(hoje(), 1) ? '<small>Amanhã</small>' : '<small>&nbsp;</small>')}${esc(fmtDiaLongo(dia).replace(/^./, c => c.toUpperCase()))}`;
    $('#dataInput').value = dia;
    $$('#abas button').forEach(b => b.setAttribute('aria-pressed', (b.dataset.prof || null) === A.prof));
    if (!silencioso) $('#linhaTempo').innerHTML = '<p class="vazio"><span class="spinner"></span></p>';
    try {
      const [ag, bl] = await Promise.all([api.adminAgenda(dia, dia, A.prof), api.adminBloqueios(dia, dia, A.prof)]);
      if (dia !== A.dia || A.secao !== 'agenda') return;
      A.agenda = ag; A.bloqueios = bl;
      desenharDia();
    } catch (e) {
      if (e.codigo === 'SEM_PERMISSAO') return iniciar();
      $('#linhaTempo').innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`;
    }
  }
  const valorTxt = d => d.coberto_plano && !d.valor_total_centavos ? 'plano' :
    d.valor_a_confirmar && !d.valor_total_centavos ? 'valor a confirmar' : (d.valor_a_partir ? 'a partir de ' : '') + R.fmtPreco(d.valor_total_centavos) + (d.valor_a_confirmar ? ' + a confirmar' : '');

  function desenharDia() {
    const agora = Date.now();
    const valendo = A.agenda.filter(a => ['confirmado', 'concluido'].includes(a.status));
    const previsto = valendo.reduce((t, a) => t + (a.valor_total_centavos || 0), 0);
    $('#numeros').innerHTML = `
      <div class="numero"><span class="rotulo">Horários</span><b>${valendo.length}</b></div>
      <div class="numero"><span class="rotulo">Atendidos</span><b>${A.agenda.filter(a => a.status === 'concluido').length}</b></div>
      <div class="numero ouro"><span class="rotulo">Previsto</span><b>${R.fmtPreco(previsto)}</b></div>
      <div class="numero"><span class="rotulo">Bloqueios</span><b>${A.bloqueios.length}</b></div>`;
    const itens = [
      ...A.agenda.filter(a => A.cancelados || a.status !== 'cancelado').map(a => ({ t: 'ag', inicio: a.inicio, d: a })),
      ...A.bloqueios.map(b => ({ t: 'bl', inicio: b.inicio, d: b }))
    ].sort((x, y) => new Date(x.inicio) - new Date(y.inicio));
    if (!itens.length) {
      $('#linhaTempo').innerHTML = `<p class="vazio">Nenhum horário marcado neste dia.${A.dia === hoje() ? '' : '<br>Use as setas para ver outros dias.'}</p>`;
      return;
    }
    const mostraProf = !A.prof;
    $('#linhaTempo').innerHTML = itens.map(({ t, d }) => {
      if (t === 'bl') {
        const diaTodo = fmtHora(d.inicio) === '00:00' && (fmtHora(d.fim) === '00:00' || fmtHora(d.fim) === '23:59');
        return `<div class="bloq">
          <div class="ag-hora">${diaTodo ? 'Dia todo' : fmtHora(d.inicio)}<small>${diaTodo ? '' : 'até ' + fmtHora(d.fim)}</small></div>
          <div><div class="ag-nome">Bloqueado${d.motivo ? ' · ' + esc(d.motivo) : ''}</div>
            <div class="ag-info">${d.profissional_id ? esc(nomeProf(d.profissional_id)) : 'Barbearia inteira'}</div></div>
          <div class="ag-acoes"><button type="button" class="btn mini" data-desbloquear="${d.id}">Liberar</button></div>
        </div>`;
      }
      const ini = new Date(d.inicio).getTime(), fim = new Date(d.fim).getTime();
      const classe = A.dia === hoje() && agora >= ini && agora < fim ? 'agora' : (fim < agora ? 'passado' : '');
      const tel = d.telefone ? R.soDigitos(d.telefone) : '';
      const msgWa = encodeURIComponent(`Olá, ${primeiro(d.nome_cliente)}! Aqui é da Barbearia Nocaute, sobre seu horário de ${fmtDiaLongo(A.dia)} às ${fmtHora(d.inicio)}.`);
      return `<div class="ag ${classe}">
        <div class="ag-hora">${fmtHora(d.inicio)}<small>até ${fmtHora(d.fim)}</small></div>
        <div>
          <div class="ag-nome">${esc(d.nome_cliente)} <span class="selo ${d.status}">${esc(STATUS[d.status] || d.status)}</span></div>
          <div class="ag-info">${d.itens.map(i => esc(i.nome)).join(' + ')}${mostraProf ? ' · ' + esc(d.profissional.nome) : ''}<br>${esc(valorTxt(d))} · ${esc(d.codigo)}</div>
        </div>
        <div class="ag-acoes">
          ${tel ? `<a class="btn mini" href="https://wa.me/55${tel}?text=${msgWa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          ${d.status === 'confirmado' ? `<button type="button" class="btn mini" data-status="concluido" data-id="${d.id}">Atendido</button>
            <button type="button" class="btn mini" data-status="nao_compareceu" data-id="${d.id}">Não veio</button>
            <button type="button" class="btn mini perigo" data-cancelar="${d.id}">Cancelar</button>` : ''}
          <button type="button" class="btn mini" data-ficha="${d.id}">Ficha</button>
        </div>
      </div>`;
    }).join('');
  }

  async function cliqueAgenda(e) {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const d = b.dataset;
    if (d.dia) { A.dia = R.somarDias(A.dia, Number(d.dia)); carregarDia(); }
    else if (d.acao === 'hoje') { A.dia = hoje(); carregarDia(); }
    else if (d.prof !== undefined && b.closest('#abas')) { A.prof = d.prof || null; carregarDia(); }
    else if (d.acao === 'bloquear') abrirBloqueio();
    else if (d.acao === 'lembretes') abrirLembretes();
    else if (d.status) {
      ocupado(b, true);
      try { await api.adminStatus(d.id, d.status); toast(d.status === 'concluido' ? 'Marcado como atendido.' : 'Marcado como não compareceu.'); carregarDia(true); }
      catch (x) { ocupado(b, false); toast(msgErro(x), true); }
    }
    else if (d.cancelar) {
      const a = A.agenda.find(x => x.id === d.cancelar);
      dialogo('Cancelar horário', `<p style="color:var(--txt-2);line-height:1.6;margin-bottom:1rem">${esc(a.nome_cliente)} · ${fmtHora(a.inicio)} · ${a.itens.map(i => esc(i.nome)).join(' + ')}.<br>O horário volta a ficar livre no site. Avise o cliente pelo WhatsApp.</p>
        <div class="campo"><label for="motivo">Motivo (opcional)</label><input type="text" id="motivo" maxlength="200"></div>`,
        [{ texto: 'Voltar', acao: fechar },
         { texto: 'Cancelar horário', classe: 'cheio', acao: async el => {
           ocupado(el, true);
           try { await api.adminStatus(a.id, 'cancelado', $('#motivo').value.trim() || 'cancelado pela barbearia'); fechar(); toast('Horário cancelado.'); carregarDia(true); }
           catch (x) { ocupado(el, false); toast(msgErro(x), true); }
         } }]);
    }
    else if (d.ficha) abrirFicha(d.ficha);
    else if (d.desbloquear) {
      ocupado(b, true);
      try { await api.adminRemoverBloqueio(isNaN(d.desbloquear) ? d.desbloquear : Number(d.desbloquear)); toast('Horário liberado.'); carregarDia(true); }
      catch (x) { ocupado(b, false); toast(msgErro(x), true); }
    }
  }

  function abrirBloqueio() {
    const profs = (A.adm ? A.adm.profissionais : A.cat.profissionais).filter(p => p.ativo);
    const opcoes = ehBarbeiro() ? [[A.eu.profissional_id, A.eu.profissional_nome]] : [...profs.map(p => [p.id, p.nome]), ['', 'Barbearia inteira']];
    dialogo('Bloquear horário', `
      <div class="campo"><label for="bProf">Barbeiro</label><select id="bProf">${opcoes.map(([v, n]) => `<option value="${v}" ${v === (A.prof || opcoes[0][0]) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
      <div class="campo"><label for="bData">Data</label><input type="date" id="bData" value="${A.dia}"></div>
      <label class="check"><input type="checkbox" id="bDiaTodo"> Dia inteiro (folga, férias)</label>
      <div class="campos" id="bHoras">
        <div class="campo"><label for="bIni">Das</label><input type="time" id="bIni" value="12:00" step="900"></div>
        <div class="campo"><label for="bFim">Até</label><input type="time" id="bFim" value="13:00" step="900"></div>
      </div>
      <div class="campo"><label for="bMotivo">Motivo</label><input type="text" id="bMotivo" placeholder="Almoço, folga, médico…" maxlength="120"></div>
      <div id="bErro"></div>`,
      [{ texto: 'Voltar', acao: fechar },
       { texto: 'Bloquear', classe: 'cheio', acao: async el => {
         const data = $('#bData').value, todo = $('#bDiaTodo').checked;
         const ini = todo ? `${data}T00:00:00${C.offset}` : `${data}T${$('#bIni').value}:00${C.offset}`;
         const fim = todo ? `${R.somarDias(data, 1)}T00:00:00${C.offset}` : `${data}T${$('#bFim').value}:00${C.offset}`;
         if (!data || new Date(fim) <= new Date(ini)) return erroNo('bErro', MSG.PERIODO_INVALIDO);
         ocupado(el, true);
         try {
           await api.adminBloquear($('#bProf').value || null, ini, fim, $('#bMotivo').value.trim() || (todo ? 'Folga' : 'Bloqueado'));
           fechar(); toast('Horário bloqueado. Ele já sumiu do site.'); A.dia = data; carregarDia();
         } catch (x) { ocupado(el, false); erroNo('bErro', x); }
       } }]);
    $('#bDiaTodo').onchange = e => { $('#bHoras').hidden = e.target.checked; };
  }

  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  // "Marcou 14 · Atendido 11 · Cancelou 2 · Faltou 1 · 1 cancelado pela barbearia"
  function numerosTxt(n) {
    return [`Marcou ${n.marcados}`, `Atendido ${n.atendidos}`, `Cancelou ${n.cancelados_cliente}`, `Faltou ${n.faltas}`]
      .concat(n.cancelados_barbearia ? [`${n.cancelados_barbearia} cancelado${n.cancelados_barbearia > 1 ? 's' : ''} pela barbearia`] : []).join(' · ');
  }
  const statusHist = h => h.status === 'cancelado' ? (h.cancelado_por === 'barbearia' ? 'Cancelado pela barbearia' : 'Cancelado pelo cliente') : (STATUS[h.status] || h.status);

  async function abrirFicha(id, porCliente) {
    dialogo('Ficha do cliente', '<p class="vazio"><span class="spinner"></span></p>', []);
    try {
      const f = porCliente ? await api.adminFicha(id) : await api.adminCliente(id);
      const n = f.numeros;
      const L = (k, v) => `<div class="ficha-linha"><span>${k}</span><span>${v}</span></div>`;
      const balcao = !ehBarbeiro();
      $('#dlgCorpo').innerHTML =
        (n.bloqueado ? `<div class="aviso erro" style="margin-bottom:1rem">${esc(plural(n.faltas_recentes, 'falta', 'faltas'))} nos últimos 6 meses: não consegue marcar pelo site e é orientado a chamar no WhatsApp.
            ${balcao ? '<br><button type="button" class="btn mini" style="margin-top:0.6rem" data-zerar>Liberar para marcar pelo site</button>' : ''}</div>` : '') +
        L('Nome', esc(f.nome)) +
        L('WhatsApp', f.telefone ? `<a href="https://wa.me/55${esc(f.telefone)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(R.mascaraTelefone(f.telefone))}</a>` : '') +
        (f.email ? L('E-mail', esc(f.email)) : '') +
        (f.plano ? L('Plano', esc(f.plano)) : '') +
        L('Histórico', esc(numerosTxt(n))) +
        (n.ultima_visita ? L('Última visita', fmtDataHora(n.ultima_visita).split(',')[0]) : '') +
        (n.proximo ? L('Próximo horário', fmtDataHora(n.proximo)) : '') +
        '<p class="rotulo" style="margin:1.2rem 0 0.4rem">Últimos horários</p>' +
        ((f.historico || []).map(h => `<div class="hist"><span>${fmtDataHora(h.inicio)} · ${h.itens.map(i => esc(i.nome)).join(' + ')}</span><span class="selo ${h.status}">${esc(statusHist(h))}</span></div>`).join('') || '<p class="vazio">Nenhum horário ainda.</p>') +
        ((f.registro || []).length ? '<p class="rotulo" style="margin:1.2rem 0 0.4rem">Registro deste horário</p>' +
          f.registro.map(r => `<div class="hist"><span>${esc(r.acao.replace(/_/g, ' '))}</span><span>${fmtDataHora(r.quando)}</span></div>`).join('') : '');
      const z = $('#dlgCorpo [data-zerar]');
      if (z) z.onclick = async () => {
        ocupado(z, true);
        try { await api.adminZerarFaltas(f.cliente_id); toast(`${primeiro(f.nome)} pode marcar pelo site de novo.`); abrirFicha(f.cliente_id, true); if (A.secao === 'clientes') carregarClientes(); }
        catch (x) { ocupado(z, false); toast(msgErro(x), true); }
      };
    } catch (x) { $('#dlgCorpo').innerHTML = `<div class="aviso erro">${esc(msgErro(x))}</div>`; }
  }

  /* ═════════════ LEMBRETES DA VÉSPERA ═════════════ */
  // quem já recebeu fica marcado só neste aparelho (é uma ajuda para não mandar duas vezes)
  const LEMB = 'nc_lembretes_enviados';
  const lidos = () => { try { return JSON.parse(localStorage.getItem(LEMB) || '{}'); } catch (e) { return {}; } };
  function marcarEnviado(id) {
    const m = lidos(); m[id] = Date.now();
    Object.keys(m).forEach(k => { if (Date.now() - m[k] > 7 * 86400000) delete m[k]; });
    try { localStorage.setItem(LEMB, JSON.stringify(m)); } catch (e) {}
  }
  async function abrirLembretes() {
    const amanha = R.somarDias(hoje(), 1);
    const quando = fmtDiaLongo(amanha);
    dialogo(`Lembretes de amanhã`, '<p class="vazio"><span class="spinner"></span></p>', [{ texto: 'Fechar', acao: fechar }]);
    let lista;
    try { lista = (await api.adminAgenda(amanha, amanha, A.prof)).filter(a => a.status === 'confirmado'); }
    catch (x) { $('#dlgCorpo').innerHTML = `<div class="aviso erro">${esc(msgErro(x))}</div>`; return; }
    if (!lista.length) { $('#dlgCorpo').innerHTML = `<p class="vazio">Nenhum horário marcado para amanhã (${esc(quando)}).</p>`; return; }
    const linkSite = new URL('index.html#conta', location.href).href;
    const env = lidos();
    $('#dlgCorpo').innerHTML = `<p style="color:var(--txt-2);line-height:1.6;margin-bottom:0.8rem">${esc(quando.replace(/^./, c => c.toUpperCase()))} · ${plural(lista.length, 'horário', 'horários')}. Toque em Enviar: o WhatsApp abre com a mensagem pronta.</p>` +
      lista.map(a => {
        const tel = a.telefone ? R.soDigitos(a.telefone) : '';
        const msg = `Olá, ${primeiro(a.nome_cliente)}! Lembrete do seu horário na Barbearia Nocaute amanhã (${quando}) às ${fmtHora(a.inicio)}, com ${a.profissional.nome}: ${a.itens.map(i => i.nome).join(' + ')}. Se não puder vir, cancele pelo site: ${linkSite}`;
        return `<div class="ass" data-lembrete="${a.id}">
          <div class="nome">${fmtHora(a.inicio)} · ${esc(a.nome_cliente)} ${env[a.id] ? '<span class="selo concluido">Enviado</span>' : ''}</div>
          <div class="info">${esc(a.profissional.nome)} · ${a.itens.map(i => esc(i.nome)).join(' + ')}</div>
          <div class="acoes">${tel ? `<a class="btn mini ${env[a.id] ? '' : 'cheio'}" data-enviar="${a.id}" href="https://wa.me/55${tel}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${env[a.id] ? 'Enviar de novo' : 'Enviar'}</a>` : '<span class="info">sem WhatsApp</span>'}</div>
        </div>`;
      }).join('');
    $$('#dlgCorpo [data-enviar]').forEach(el => el.addEventListener('click', () => {
      marcarEnviado(el.dataset.enviar);
      const nome = el.closest('.ass').querySelector('.nome');
      if (!nome.querySelector('.selo')) nome.insertAdjacentHTML('beforeend', ' <span class="selo concluido">Enviado</span>');
      el.classList.remove('cheio'); el.textContent = 'Enviar de novo';
    }));
  }

  /* ═════════════ CLIENTES E RESUMO DO MÊS ═════════════ */
  const C_ = { busca: '', ordem: 'recentes', sumidos: '', mes: null };
  const fmtMes = k => new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(k + 'T12:00:00Z'));
  const somarMes = (k, n) => { const d = new Date(k + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n, 1); return d.toISOString().slice(0, 10); };

  function secaoClientes() {
    C_.mes = C_.mes || hoje().slice(0, 8) + '01';
    $('#app').innerHTML = (ehDono() ? `<div class="cab-secao"><div><h1>Resumo do mês</h1></div>
        <div class="navdia"><button type="button" class="seta" data-mes="-1" aria-label="Mês anterior">‹</button>
          <div class="dia-titulo" id="mesTitulo" style="min-width:11rem"></div>
          <button type="button" class="seta" data-mes="1" aria-label="Próximo mês">›</button></div></div>
      <div id="resumo"><p class="vazio"><span class="spinner"></span></p></div>` : '') + `
      <div class="cab-secao" style="margin-top:${ehDono() ? '2.2rem' : '0'}"><div><h1>Clientes</h1>
        <p>Quantas vezes cada um marcou, foi atendido, cancelou e faltou. Toque em Ficha para ver o histórico.</p></div></div>
      <div class="filtros">
        <div class="campo"><label for="clBusca">Buscar</label><input type="search" id="clBusca" placeholder="Nome ou WhatsApp" value="${esc(C_.busca)}"></div>
        <div class="campo"><label for="clOrdem">Ordem</label><select id="clOrdem">
          ${[['recentes', 'Última visita'], ['frequentes', 'Mais atendimentos'], ['faltas', 'Mais faltas e cancelamentos'], ['nome', 'Nome']]
            .map(([v, n]) => `<option value="${v}" ${C_.ordem === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="campo"><label for="clSumidos">Mostrar</label><select id="clSumidos">
          ${[['', 'Todos'], ['30', 'Sumidos há 30+ dias'], ['45', 'Sumidos há 45+ dias'], ['60', 'Sumidos há 60+ dias'], ['90', 'Sumidos há 90+ dias']]
            .map(([v, n]) => `<option value="${v}" ${C_.sumidos === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <div id="listaClientes"><p class="vazio"><span class="spinner"></span></p></div>`;
    let t;
    $('#clBusca').oninput = e => { C_.busca = e.target.value; clearTimeout(t); t = setTimeout(carregarClientes, 300); };
    $('#clOrdem').onchange = e => { C_.ordem = e.target.value; carregarClientes(); };
    $('#clSumidos').onchange = e => { C_.sumidos = e.target.value; carregarClientes(); };
    $('#app').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.mes) { C_.mes = somarMes(C_.mes, Number(b.dataset.mes)); carregarResumo(); }
      else if (b.dataset.fichaCliente) abrirFicha(b.dataset.fichaCliente, true);
    };
    if (ehDono()) carregarResumo();
    carregarClientes();
  }

  async function carregarResumo() {
    const box = $('#resumo'); if (!box) return;
    $('#mesTitulo').textContent = fmtMes(C_.mes).replace(/^./, c => c.toUpperCase());
    let r;
    try { r = await api.adminResumo(C_.mes); } catch (e) { box.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return; }
    if (!$('#resumo')) return;
    const total = r.barbeiros.reduce((t, b) => t + b.valor_centavos, 0), atend = r.barbeiros.reduce((t, b) => t + b.atendidos, 0);
    const N = (rot, val, sub, ouro) => `<div class="numero ${ouro ? 'ouro' : ''}"><span class="rotulo">${rot}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    box.innerHTML = `<div class="numeros">
        ${N('Atendimentos', atend)}${N('Valor atendido', R.fmtPreco(total), '', true)}
        ${N('Cancelamentos', r.cancelados_cliente + r.cancelados_barbearia, r.cancelados_barbearia ? `${r.cancelados_barbearia} pela barbearia` : '')}
        ${N('Faltas', r.faltas)}
      </div>
      <div class="numeros">
        ${r.barbeiros.map(b => N(esc(b.nome), plural(b.atendidos, 'atendimento', 'atendimentos'), `${R.fmtPreco(b.valor_centavos)}${b.agendados ? ` · ${b.agendados} agendado${b.agendados > 1 ? 's' : ''}` : ''}`)).join('')}
        ${N('Clientes novos', r.clientes_novos)}
        ${N('Planos ativos', r.planos_ativos, [r.planos_pendentes ? `${r.planos_pendentes} aguardando` : '', r.planos_atrasados ? `${r.planos_atrasados} atrasado${r.planos_atrasados > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · '))}
      </div>
      <p class="dica" style="color:var(--txt-3);font-size:0.82rem;margin-top:-0.6rem">Valor atendido = soma dos horários marcados como Atendido no mês (o que o site calculou; não inclui produtos).</p>`;
  }

  async function carregarClientes() {
    const box = $('#listaClientes'); if (!box) return;
    let lista;
    try { lista = await api.adminClientes(C_.busca.trim(), C_.ordem, Number(C_.sumidos) || null); }
    catch (e) { box.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return; }
    if (!$('#listaClientes')) return;
    if (!lista.length) { box.innerHTML = `<p class="vazio">${C_.busca || C_.sumidos ? 'Ninguém encontrado com esse filtro.' : 'Nenhum cliente ainda.'}</p>`; return; }
    const linkSite = new URL('index.html', location.href).href;
    box.innerHTML = `<p class="dica" style="color:var(--txt-3);font-size:0.82rem;margin-bottom:0.4rem">${plural(lista.length, 'cliente', 'clientes')}${lista.length === 300 ? ' (mostrando os 300 primeiros; use a busca)' : ''}</p>` + lista.map(c => {
      const tel = c.telefone ? R.soDigitos(c.telefone) : '';
      const msg = C_.sumidos ? `Olá, ${primeiro(c.nome)}! Aqui é da Barbearia Nocaute. Faz um tempo que você não vem por aqui. Quando quiser marcar: ${linkSite}` : '';
      return `<div class="ass">
        <div class="nome">${esc(c.nome)} ${c.plano ? `<span class="selo ativa">${esc(c.plano)}</span>` : ''} ${c.bloqueado ? '<span class="selo nao_compareceu">Bloqueado por faltas</span>' : ''}</div>
        <div class="info">${esc(numerosTxt(c))}${c.ultima_visita ? ` · última visita ${fmtDataHora(c.ultima_visita).split(',')[0]}` : ''}${c.proximo ? ` · próximo ${fmtDataHora(c.proximo)}` : ''}</div>
        <div class="acoes">
          ${tel ? `<a class="btn mini" href="https://wa.me/55${tel}${msg ? `?text=${encodeURIComponent(msg)}` : ''}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          <button type="button" class="btn mini" data-ficha-cliente="${c.id}">Ficha</button>
        </div>
      </div>`;
    }).join('');
  }

  /* ═════════════ SERVIÇOS E PREÇOS ═════════════ */
  function secaoServicos() {
    const lista = A.adm.servicos;
    const cats = [...new Set(lista.map(s => s.categoria))];
    $('#app').innerHTML = `<div class="cab-secao"><div><h1>Serviços e preços</h1>
        <p>O que aparece no site para o cliente escolher. Mudou aqui, muda no site na hora. Serviço desativado some do site, mas continua no histórico.</p></div>
        <button type="button" class="btn cheio" data-novo-servico>Novo serviço</button></div>` +
      cats.map(cat => `<p class="grupo">${esc(cat)}</p>` + lista.filter(s => s.categoria === cat).map(s => `
        <div class="linha-ed ${s.ativo ? '' : 'off'}">
          <span class="nome">${esc(s.nome)}${s.ativo ? '' : ' <small>desativado</small>'}${s.componentes && s.componentes.length ? `<small>inclui ${s.componentes.map(c => esc(nomeServ(c))).join(', ')}</small>` : ''}</span>
          <span class="dur">${s.duracao_min ? R.fmtDur(s.duracao_min) : ''}</span>
          <span class="preco">${s.preco_a_partir ? '<small>a partir de</small> ' : ''}${s.preco_centavos == null ? '<small>a confirmar</small>' : R.fmtPreco(s.preco_centavos)}</span>
          <button type="button" class="btn mini" data-editar-servico="${s.id}">Editar</button>
        </div>`).join('')).join('');
    $('#app').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.novoServico !== undefined) editarServico(null);
      else if (b.dataset.editarServico) editarServico(lista.find(x => x.id === b.dataset.editarServico));
    };
  }
  const nomeServ = id => { const s = A.adm.servicos.find(x => x.id === id); return s ? s.nome.replace(/ ou .*/, '') : ({ cover: 'Cover' }[id] || id); };

  function editarServico(s) {
    const novo = !s; s = s || { ativo: true, componentes: [], categoria: '' };
    const cats = [...new Set(A.adm.servicos.map(x => x.categoria))];
    const simples = A.adm.servicos.filter(x => !(x.componentes || []).length && x.id !== s.id);
    dialogo(novo ? 'Novo serviço' : 'Editar serviço', `
      <div class="campo"><label for="sNome">Nome</label><input type="text" id="sNome" value="${esc(s.nome || '')}" maxlength="80"></div>
      <div class="campo"><label for="sCat">Categoria</label><input type="text" id="sCat" list="sCats" value="${esc(s.categoria)}">
        <datalist id="sCats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="campos">
        <div class="campo"><label for="sPreco">Preço (R$)</label><input type="text" id="sPreco" inputmode="decimal" value="${deCentavos(s.preco_centavos)}" placeholder="70"></div>
        <div class="campo"><label for="sDur">Duração (min)</label><input type="number" id="sDur" min="5" max="480" step="5" value="${s.duracao_min || ''}"></div>
      </div>
      <label class="check"><input type="checkbox" id="sAPartir" ${s.preco_a_partir ? 'checked' : ''}> Mostrar como “a partir de” (valor pode variar)</label>
      <div class="campo"><label for="sDesc">Descrição (opcional)</label><input type="text" id="sDesc" value="${esc(s.descricao || '')}" maxlength="160"></div>
      <div class="campo"><label>É um combo? Marque o que ele já inclui</label>
        <div class="opcoes-check">${simples.map(x => `<label class="check"><input type="checkbox" class="sComp" value="${x.id}" ${(s.componentes || []).includes(x.id) ? 'checked' : ''}> ${esc(x.nome)}</label>`).join('')}
          <label class="check"><input type="checkbox" class="sComp" value="cover" ${(s.componentes || []).includes('cover') ? 'checked' : ''}> Cover (pintura)</label></div>
        <p class="dica">Assim o site não deixa o cliente marcar o combo junto com um item que ele já tem.</p></div>
      <label class="check"><input type="checkbox" id="sAtivo" ${s.ativo !== false ? 'checked' : ''}> Aparece no site</label>
      <div id="sErro"></div>`,
      [...(novo ? [] : [{ texto: 'Excluir', classe: 'perigo', acao: async el => {
          ocupado(el, true);
          try { const r = await api.adminExcluirServico(s.id); fechar(); toast(r === 'excluido' ? 'Serviço excluído.' : 'Serviço já usado em agendamentos: foi desativado.'); await recarregarCatalogo(); }
          catch (x) { ocupado(el, false); erroNo('sErro', x); }
        } }]),
       { texto: 'Cancelar', acao: fechar },
       { texto: 'Salvar', classe: 'cheio', acao: el => {
         const preco = paraCentavos($('#sPreco').value), dur = $('#sDur').value ? Number($('#sDur').value) : null;
         if ($('#sPreco').value && (preco == null || isNaN(preco))) return erroNo('sErro', MSG.PRECO_INVALIDO);
         salvarCom(el, () => api.adminSalvarServico({ id: s.id || null, nome: $('#sNome').value.trim(), categoria: $('#sCat').value.trim(),
           preco_centavos: preco, preco_a_partir: $('#sAPartir').checked, duracao_min: dur, descricao: $('#sDesc').value.trim(),
           componentes: $$('.sComp:checked').map(x => x.value), ativo: $('#sAtivo').checked }), 'Serviço salvo. Já está no site.', 'sErro');
       } }]);
  }

  /* ═════════════ PLANOS E ASSINANTES ═════════════ */
  async function secaoPlanos() {
    const planos = ehDono() ? A.adm.planos : [];
    $('#app').innerHTML = (ehDono() ? `<div class="cab-secao"><div><h1>Planos</h1>
        <p>Plano com link de pagamento: o cliente pede pelo site e é levado para pagar no cartão, na Stone. Sem link, paga na barbearia. Nos dois casos ele aparece em Assinantes como “Aguardando pagamento”: quando o pagamento aparecer na Stone (ou no caixa), toque em Ativar.</p></div>
        <button type="button" class="btn cheio" data-novo-plano>Novo plano</button></div>
      <div class="cards-ed">${planos.map(p => {
        const inc = A.adm.plano_servicos.filter(x => x.plano_id === p.id);
        return `<div class="card-ed ${p.ativo ? '' : 'off'}">
          <h3>${esc(p.nome)}${p.ativo ? '' : ' · desativado'}</h3>
          <span class="preco">${R.fmtPreco(p.preco_centavos)} <small style="font-size:0.8rem;color:var(--gray-text)">/ mês</small></span>
          ${p.descricao ? `<p>${esc(p.descricao)}</p>` : ''}
          <ul>${inc.map(x => `<li>✦ ${esc(nomeServ(x.servico_id))} · ${x.limite_por_ciclo ? `até ${x.limite_por_ciclo}x/mês` : 'ilimitado'}</li>`).join('')}</ul>
          <p>${p.link_pagamento ? `Cartão pela Stone${p.cobranca_recorrente ? ', cobrança todo mês' : ''}` : 'Pago na barbearia'}</p>
          ${!p.disponivel_contratacao ? '<p>Fechado para novos pedidos.</p>' : ''}
          <div class="acoes"><button type="button" class="btn mini" data-editar-plano="${p.id}">Editar</button></div>
        </div>`;
      }).join('')}</div>` : '') + `
      <div class="cab-secao" style="margin-top:2.2rem"><div><h1>Assinantes</h1>
        <p>Ative quando o primeiro pagamento aparecer. Plano com cobrança mensal no cartão vira o mês sozinho; se a cobrança falhar na Stone, cancele aqui. Plano pago no balcão precisa de “Renovar” a cada mês pago; sem isso, o benefício para no fim do mês.</p></div></div>
      <div id="listaAss"><p class="vazio"><span class="spinner"></span></p></div>`;
    $('#app').onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.novoPlano !== undefined) editarPlano(null);
      else if (b.dataset.editarPlano) editarPlano(planos.find(x => x.id === b.dataset.editarPlano));
      else if (b.dataset.ass) {
        const [id, acao] = b.dataset.ass.split('|');
        const fazer = async el => {
          ocupado(el, true);
          try { await api.adminAssinatura(id, acao); fechar(); toast({ ativar: 'Plano ativado por 1 mês.', renovar: 'Plano renovado por mais 1 mês.', cancelar: 'Assinatura cancelada.' }[acao]); carregarAssinantes(); }
          catch (x) { ocupado(el, false); toast(msgErro(x), true); }
        };
        const a = (A.assinantes || []).find(x => x.id === id) || {};
        if (acao === 'cancelar') dialogo('Cancelar assinatura', `<p style="color:var(--txt-2);line-height:1.6">O cliente perde o benefício a partir de agora. Para voltar, ele faz um novo pedido.</p>
          ${a.renova_sozinho ? '<div class="aviso erro" style="margin-top:0.8rem">Este plano é cobrado todo mês no cartão. Encerre também a cobrança recorrente no app da Stone, senão o cliente continua sendo cobrado.</div>' : ''}`,
          [{ texto: 'Voltar', acao: fechar }, { texto: 'Cancelar assinatura', classe: 'cheio', acao: fazer }]);
        else fazer(b);
      }
    };
    carregarAssinantes();
  }
  async function carregarAssinantes() {
    const box = $('#listaAss'); if (!box) return;
    let lista;
    try { lista = await api.adminAssinaturas(); } catch (e) { box.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return; }
    A.assinantes = lista;
    if (!lista.length) { box.innerHTML = '<p class="vazio">Nenhum assinante ainda.</p>'; return; }
    const recente = iso => iso && Date.now() - new Date(iso).getTime() < 30 * 86400000;
    box.innerHTML = lista.map(a => {
      const tel = a.telefone ? R.soDigitos(a.telefone) : '';
      const vivo = ['pendente', 'ativa', 'inadimplente'].includes(a.status);
      return `<div class="ass">
        <div class="nome">${esc(a.cliente || 'Cliente')} <span class="selo ${a.status}">${esc(STATUS_ASS[a.status] || a.status)}</span></div>
        <div class="info">${esc(a.plano)} · ${R.fmtPreco(a.preco_centavos)}/mês${a.renova_sozinho ? ' no cartão' : ''}${a.ciclo_fim ? (a.renova_sozinho && a.status === 'ativa' ? ` · próxima cobrança ${fmtDataBR(R.somarDias(a.ciclo_fim, 1))}` : ` · pago até ${fmtDataBR(a.ciclo_fim)}`) : ''}${a.status === 'ativa' ? ` · ${a.usos_no_ciclo} ${a.usos_no_ciclo === 1 ? 'uso' : 'usos'} no mês${a.limite_usos_ciclo ? ` de ${a.limite_usos_ciclo}` : ''}` : ''}</div>
        <div class="acoes">
          ${tel ? `<a class="btn mini" href="https://wa.me/55${tel}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          ${a.status === 'pendente' ? `<button type="button" class="btn mini cheio" data-ass="${a.id}|ativar">${a.link_pagamento ? 'Pagou na Stone · Ativar' : 'Recebi · Ativar'}</button>` : ''}
          ${['ativa', 'inadimplente'].includes(a.status) && !(a.renova_sozinho && a.status === 'ativa') ? `<button type="button" class="btn mini" data-ass="${a.id}|renovar">Recebi · Renovar</button>` : ''}
          ${vivo ? `<button type="button" class="btn mini perigo" data-ass="${a.id}|cancelar">Cancelar</button>` : ''}
        </div>
        ${a.status === 'cancelada' && a.renova_sozinho && recente(a.cancelada_em) ? '<div class="info" style="grid-column:1/-1;color:var(--erro)">Cancelado: confira se a cobrança recorrente foi encerrada na Stone.</div>' : ''}
      </div>`;
    }).join('');
  }

  function editarPlano(p) {
    const novo = !p; p = p || { ativo: true, disponivel_contratacao: true, restricoes: {} };
    const inc = new Map(A.adm.plano_servicos.filter(x => x.plano_id === p.id).map(x => [x.servico_id, x.limite_por_ciclo]));
    const dias = (p.restricoes && p.restricoes.dias_semana) || [];
    dialogo(novo ? 'Novo plano' : 'Editar plano', `
      <div class="campo"><label for="pNome">Nome</label><input type="text" id="pNome" value="${esc(p.nome || '')}" maxlength="60"></div>
      <div class="campos">
        <div class="campo"><label for="pPreco">Preço por mês (R$)</label><input type="text" id="pPreco" inputmode="decimal" value="${deCentavos(p.preco_centavos)}" placeholder="179,90"></div>
        <div class="campo"><label for="pLim">Limite total por mês</label><input type="number" id="pLim" min="1" value="${p.limite_usos_ciclo || ''}" placeholder="sem limite"></div>
      </div>
      <div class="campo"><label for="pDesc">Descrição curta</label><input type="text" id="pDesc" value="${esc(p.descricao || '')}" maxlength="160" placeholder="2 cortes e 1 barba por mês."></div>
      <div class="campo"><label>Serviços incluídos e limite de cada um por mês</label>
        ${A.adm.servicos.filter(s => s.ativo || inc.has(s.id)).map(s => `<div class="inc-servico">
          <label class="check"><input type="checkbox" class="pInc" value="${s.id}" ${inc.has(s.id) ? 'checked' : ''}> ${esc(s.nome)}</label>
          <input type="number" min="1" class="pIncLim" data-servico="${s.id}" value="${inc.get(s.id) || ''}" placeholder="ilimitado" ${inc.has(s.id) ? '' : 'disabled'} aria-label="Limite de ${esc(s.nome)}">
        </div>`).join('')}
        <p class="dica">Deixe o limite em branco para ilimitado.</p></div>
      <div class="campo"><label>Dias em que o plano vale (nenhum marcado = todos)</label>
        <div class="dias-check">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" class="pDia" value="${d}" ${dias.includes(d) ? 'checked' : ''}>${DIAS_C[d]}</label>`).join('')}</div></div>
      <div class="campo"><label for="pRegras">Regras de uso (opcional)</label><textarea id="pRegras" maxlength="500">${esc(p.regras || '')}</textarea></div>
      <div class="campo"><label for="pLink">Link de pagamento (Stone)</label><input type="url" id="pLink" value="${esc(p.link_pagamento || '')}" placeholder="https://payment-link-v3.stone.com.br/...">
        <p class="dica">Com link, o cliente é levado para pagar no cartão logo depois do pedido. Sem link, ele paga na barbearia.</p></div>
      <label class="check"><input type="checkbox" id="pRecorrente" ${p.cobranca_recorrente ? 'checked' : ''}> O link é de assinatura: a Stone cobra todo mês sozinha (o plano renova sem precisar tocar em Renovar)</label>
      <div class="campo"><label for="pRenov">Texto de pagamento no site</label><input type="text" id="pRenov" value="${esc(p.renovacao || 'Mensal, pago na barbearia.')}" maxlength="200"></div>
      <div class="campo"><label for="pCanc">Cancelamento (opcional)</label><input type="text" id="pCanc" value="${esc(p.cancelamento || '')}" maxlength="200" placeholder="Pode cancelar quando quiser em Minha conta."></div>
      <label class="check"><input type="checkbox" id="pDisp" ${p.disponivel_contratacao !== false ? 'checked' : ''}> Aberto para novos pedidos</label>
      <label class="check"><input type="checkbox" id="pAtivo" ${p.ativo !== false ? 'checked' : ''}> Aparece no site</label>
      ${novo ? '' : '<p class="dica" style="color:var(--txt-3);font-size:0.82rem">Mudanças de preço ou regras valem para quem pedir daqui em diante. Quem já assina segue com as condições que aceitou.</p>'}
      <div id="pErro"></div>`,
      [{ texto: 'Cancelar', acao: fechar },
       { texto: 'Salvar', classe: 'cheio', acao: el => {
         const preco = paraCentavos($('#pPreco').value);
         if (!preco) return erroNo('pErro', MSG.PRECO_INVALIDO);
         const servicos = $$('.pInc:checked').map(x => ({ servico_id: x.value, limite_por_ciclo: Number($(`.pIncLim[data-servico="${x.value}"]`).value) || null }));
         const diasSel = $$('.pDia:checked').map(x => Number(x.value));
         salvarCom(el, () => api.adminSalvarPlano({ id: p.id || null, nome: $('#pNome').value.trim(), preco_centavos: preco,
           limite_usos_ciclo: Number($('#pLim').value) || null, descricao: $('#pDesc').value.trim(), servicos,
           restricoes: diasSel.length ? { dias_semana: diasSel } : {}, regras: $('#pRegras').value.trim(),
           renovacao: $('#pRenov').value.trim(), cancelamento: $('#pCanc').value.trim(),
           disponivel_contratacao: $('#pDisp').checked, ativo: $('#pAtivo').checked,
           link_pagamento: $('#pLink').value.trim(), cobranca_recorrente: $('#pRecorrente').checked }), 'Plano salvo.', 'pErro');
       } }]);
    $$('.pInc').forEach(c => c.addEventListener('change', () => { $(`.pIncLim[data-servico="${c.value}"]`).disabled = !c.checked; }));
  }

  /* ═════════════ HORÁRIOS ═════════════ */
  function secaoHorarios() {
    const f = new Map(A.adm.funcionamento.map(h => [h.dia_semana, h]));
    const profs = A.adm.profissionais.filter(p => p.ativo);
    const ordem = [1, 2, 3, 4, 5, 6, 0];
    const linhaFunc = d => { const h = f.get(d); return `<div class="dia-ed">
      <label class="check"><input type="checkbox" class="fAberto" data-dia="${d}" ${h ? 'checked' : ''}> ${DIAS[d]}</label>
      <div class="horas">das <input type="time" class="fAbre" data-dia="${d}" value="${hhmm(h ? h.abre : '08:30')}" ${h ? '' : 'disabled'} step="900">
        às <input type="time" class="fFecha" data-dia="${d}" value="${hhmm(h ? h.fecha : '19:00')}" ${h ? '' : 'disabled'} step="900"></div></div>`; };
    const linhaJornada = (prof, d) => {
      const js = A.adm.jornadas.filter(j => j.profissional_id === prof && j.dia_semana === d).sort((a, b) => a.inicio.localeCompare(b.inicio));
      const trab = js.length > 0, ini = js.length ? hhmm(js[0].inicio) : '08:30', fim = js.length ? hhmm(js[js.length - 1].fim) : '19:00';
      const pausa = js.length > 1 ? [hhmm(js[0].fim), hhmm(js[1].inicio)] : null;
      return `<div class="dia-ed" data-jprof="${prof}" data-jdia="${d}">
        <label class="check"><input type="checkbox" class="jTrab" ${trab ? 'checked' : ''}> ${DIAS[d]}</label>
        <div class="horas">das <input type="time" class="jIni" value="${ini}" ${trab ? '' : 'disabled'} step="900"> às <input type="time" class="jFim" value="${fim}" ${trab ? '' : 'disabled'} step="900">
          <span class="pausa"><label class="check" style="margin:0"><input type="checkbox" class="jPausa" ${pausa ? 'checked' : ''} ${trab ? '' : 'disabled'}> almoço</label>
            <input type="time" class="jPIni" value="${pausa ? pausa[0] : '12:00'}" ${pausa && trab ? '' : 'disabled'} step="900"> às <input type="time" class="jPFim" value="${pausa ? pausa[1] : '13:00'}" ${pausa && trab ? '' : 'disabled'} step="900"></span></div></div>`;
    };
    $('#app').innerHTML = `<div class="cab-secao"><div><h1>Horário da barbearia</h1>
        <p>Dias e horas em que a barbearia abre. Para um dia específico (feriado, evento), use “Bloquear horário” na Agenda.</p></div></div>
      <div class="semana">${ordem.map(linhaFunc).join('')}</div>
      <div id="fErro"></div><div class="rodape-ed"><button type="button" class="btn cheio" data-salvar-func>Salvar horário da barbearia</button></div>
      ${profs.map(p => `<div class="cab-secao" style="margin-top:2.4rem"><div><h1>Jornada de ${esc(p.nome)}</h1>
          <p>Quando ${esc(primeiro(p.nome))} atende. O site só oferece horários dentro da jornada e do horário da barbearia.</p></div></div>
        <div class="semana">${ordem.map(d => linhaJornada(p.id, d)).join('')}</div>
        <div id="jErro-${p.id}"></div><div class="rodape-ed"><button type="button" class="btn" data-copiar-func="${p.id}">Igual ao horário da barbearia</button>
          <button type="button" class="btn cheio" data-salvar-jornada="${p.id}">Salvar jornada de ${esc(primeiro(p.nome))}</button></div>`).join('')}`;
    $('#app').onchange = e => {
      const t = e.target;
      if (t.classList.contains('fAberto')) $$(`.fAbre[data-dia="${t.dataset.dia}"], .fFecha[data-dia="${t.dataset.dia}"]`).forEach(x => { x.disabled = !t.checked; });
      const linha = t.closest('[data-jprof]');
      if (linha && (t.classList.contains('jTrab') || t.classList.contains('jPausa'))) {
        const trab = $('.jTrab', linha).checked, pausa = $('.jPausa', linha).checked;
        $('.jIni', linha).disabled = $('.jFim', linha).disabled = $('.jPausa', linha).disabled = !trab;
        $('.jPIni', linha).disabled = $('.jPFim', linha).disabled = !(trab && pausa);
      }
    };
    $('#app').onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.salvarFunc !== undefined) {
        const lista = $$('.fAberto:checked').map(c => ({ dia_semana: Number(c.dataset.dia), abre: $(`.fAbre[data-dia="${c.dataset.dia}"]`).value, fecha: $(`.fFecha[data-dia="${c.dataset.dia}"]`).value }));
        if (lista.some(x => !x.abre || !x.fecha || x.fecha <= x.abre)) return erroNo('fErro', MSG.PERIODO_INVALIDO);
        salvarCom(b, () => api.adminSalvarFuncionamento(lista), 'Horário da barbearia salvo.', 'fErro');
      } else if (b.dataset.salvarJornada) {
        const prof = b.dataset.salvarJornada, lista = [];
        for (const linha of $$(`[data-jprof="${prof}"]`)) {
          if (!$('.jTrab', linha).checked) continue;
          const d = Number(linha.dataset.jdia), ini = $('.jIni', linha).value, fim = $('.jFim', linha).value;
          if ($('.jPausa', linha).checked) {
            const pi = $('.jPIni', linha).value, pf = $('.jPFim', linha).value;
            if (!(ini < pi && pi < pf && pf < fim)) return erroNo('jErro-' + prof, `${DIAS[d]}: o almoço precisa ficar dentro da jornada.`);
            lista.push({ dia_semana: d, inicio: ini, fim: pi }, { dia_semana: d, inicio: pf, fim });
          } else {
            if (!(ini < fim)) return erroNo('jErro-' + prof, `${DIAS[d]}: ${MSG.PERIODO_INVALIDO}`);
            lista.push({ dia_semana: d, inicio: ini, fim });
          }
        }
        salvarCom(b, () => api.adminSalvarJornada(prof, lista), `Jornada de ${nomeProf(prof)} salva.`, 'jErro-' + prof);
      } else if (b.dataset.copiarFunc) {
        const prof = b.dataset.copiarFunc;
        $$(`[data-jprof="${prof}"]`).forEach(linha => {
          const h = f.get(Number(linha.dataset.jdia));
          $('.jTrab', linha).checked = !!h; $('.jPausa', linha).checked = false;
          if (h) { $('.jIni', linha).value = hhmm(h.abre); $('.jFim', linha).value = hhmm(h.fecha); }
          $('.jTrab', linha).dispatchEvent(new Event('change', { bubbles: true }));
        });
        toast('Copiado. Toque em Salvar para confirmar.');
      }
    };
  }

  /* ═════════════ EQUIPE E AJUSTES ═════════════ */
  async function secaoEquipe() {
    const c = A.adm.config;
    $('#app').innerHTML = `<div class="cab-secao"><div><h1>Barbeiros</h1><p>Quem aparece no agendamento e na seção Equipe do site da barbearia. Barbeiro que saiu: abra Editar e desmarque “Aparece no site”; o histórico dele continua.</p></div>
        <button type="button" class="btn cheio" data-novo-prof>Novo barbeiro</button></div>
      <div class="cards-ed">${A.adm.profissionais.map(p => `<div class="card-ed ${p.ativo ? '' : 'off'}" style="flex-direction:row;align-items:center;gap:1rem">
          ${p.foto_url ? `<img class="foto-mini" src="${esc(p.foto_url)}" alt="">` : `<span class="foto-mini" style="display:flex;align-items:center;justify-content:center;font-family:Cinzel,serif;color:var(--accent)">${esc(p.nome[0])}</span>`}
          <div style="flex:1"><h3>${esc(p.nome)}</h3><p>${esc(p.cargo || 'Barbeiro')} · ${p.ativo ? 'atendendo' : 'fora do site'}</p></div>
          <button type="button" class="btn mini" data-editar-prof="${p.id}">Editar</button></div>`).join('')}</div>

      <div class="cab-secao" style="margin-top:2.4rem"><div><h1>Regras do agendamento</h1></div></div>
      <div class="caixa" style="max-width:720px">
        <div class="campos">
          <div class="campo"><label for="cAnt">Antecedência mínima para marcar (min)</label><input type="number" id="cAnt" min="0" max="1440" step="15" value="${c.antecedencia_min}"></div>
          <div class="campo"><label for="cCanc">Cliente cancela até (horas antes)</label><input type="number" id="cCanc" min="0" max="72" value="${c.cancelamento_antecedencia_h}"></div>
          <div class="campo"><label for="cPasso">Horários de quanto em quanto (min)</label><select id="cPasso">${[15, 20, 30, 45, 60].map(v => `<option ${v === c.passo_min ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="campo"><label for="cInt">Intervalo entre atendimentos (min)</label><input type="number" id="cInt" min="0" max="120" step="5" value="${c.intervalo_entre_min}"></div>
          <div class="campo"><label for="cJan">Agenda aberta para os próximos (dias)</label><input type="number" id="cJan" min="1" max="120" value="${c.janela_dias}"></div>
        </div>
        <div class="campo"><label for="cPol">Texto da política de cancelamento</label><input type="text" id="cPol" value="${esc(c.politica_cancelamento || '')}" maxlength="200"></div>
        <div class="campo"><label for="cFaltas">Faltas para bloquear o agendamento pelo site</label><input type="number" id="cFaltas" min="0" max="10" value="${c.max_faltas ?? 2}">
          <p class="dica">Conta as faltas dos últimos 6 meses. Quem chega nesse número só marca falando com a barbearia pelo WhatsApp; dá para liberar na ficha do cliente. 0 desliga a regra.</p></div>
        <label class="check"><input type="checkbox" id="cLogin" ${c.exigir_login !== false ? 'checked' : ''}> Exigir conta (Google ou e-mail) para agendar</label>
        <div id="cErro"></div>
        <div class="rodape-ed"><button type="button" class="btn cheio" data-salvar-config>Salvar regras</button></div>
      </div>

      <div class="cab-secao" style="margin-top:2.4rem"><div><h1>Acesso ao painel</h1>
        <p>A pessoa precisa entrar uma vez no painel com o e-mail dela. Depois, libere aqui.</p></div></div>
      <div id="acessos" style="max-width:720px"><p class="vazio"><span class="spinner"></span></p></div>`;
    $('#app').onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.novoProf !== undefined) editarProf(null);
      else if (b.dataset.editarProf) editarProf(A.adm.profissionais.find(x => x.id === b.dataset.editarProf));
      else if (b.dataset.salvarConfig !== undefined) {
        salvarCom(b, () => api.adminSalvarConfig({ antecedencia_min: Number($('#cAnt').value), cancelamento_antecedencia_h: Number($('#cCanc').value),
          passo_min: Number($('#cPasso').value), intervalo_entre_min: Number($('#cInt').value), janela_dias: Number($('#cJan').value),
          politica_cancelamento: $('#cPol').value.trim(), exigir_login: $('#cLogin').checked, max_faltas: Number($('#cFaltas').value) }), 'Regras salvas.', 'cErro');
      } else if (b.dataset.liberar !== undefined) {
        const email = $('#aEmail').value.trim(), papel = $('#aPapel').value, prof = $('#aProf').value;
        if (!R.validarEmail(email) || !email) return erroNo('aErro', MSG.EMAIL_INVALIDO);
        ocupado(b, true);
        try { await api.adminLiberarAcesso(email, papel, papel === 'barbeiro' ? prof : null); toast('Acesso liberado.'); carregarAcessos(); }
        catch (x) { ocupado(b, false); erroNo('aErro', x); }
      } else if (b.dataset.remover) {
        ocupado(b, true);
        try { await api.adminRemoverAcesso(b.dataset.remover); toast('Acesso removido.'); carregarAcessos(); }
        catch (x) { ocupado(b, false); toast(msgErro(x), true); }
      }
    };
    carregarAcessos();
  }
  async function carregarAcessos() {
    const box = $('#acessos'); if (!box) return;
    let lista;
    try { lista = await api.adminAcessos(); } catch (e) { box.innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return; }
    const papel = a => a.papel === 'dono' ? 'Dono' : a.papel === 'recepcao' ? 'Recepção' : `Barbeiro · ${nomeProf(a.profissional_id)}`;
    const profs = A.adm.profissionais.filter(p => p.ativo);
    box.innerHTML = lista.map(a => `<div class="linha-ed" style="grid-template-columns:minmax(0,1fr) auto">
        <span class="nome">${esc(a.email || a.user_id)}<small>${esc(papel(a))}${a.eu ? ' · você' : ''}</small></span>
        ${a.eu ? '<span></span>' : `<button type="button" class="btn mini perigo" data-remover="${a.user_id}">Remover</button>`}</div>`).join('') + `
      <div class="campos" style="margin-top:1.2rem;grid-template-columns:2fr 1fr 1fr;align-items:end">
        <div class="campo"><label for="aEmail">E-mail</label><input type="email" id="aEmail" placeholder="email@gmail.com"></div>
        <div class="campo"><label for="aPapel">Papel</label><select id="aPapel"><option value="barbeiro">Barbeiro</option><option value="recepcao">Recepção</option><option value="dono">Dono</option></select></div>
        <div class="campo"><label for="aProf">Barbeiro</label><select id="aProf">${profs.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></div>
      </div><div id="aErro"></div>
      <div class="rodape-ed" style="margin-top:0"><button type="button" class="btn" data-liberar>Liberar acesso</button></div>`;
    $('#aPapel').onchange = e => { $('#aProf').disabled = e.target.value !== 'barbeiro'; };
  }
  function editarProf(p) {
    const novo = !p; p = p || { ativo: true };
    dialogo(novo ? 'Novo barbeiro' : 'Editar barbeiro', `
      <div class="campo"><label for="prNome">Nome</label><input type="text" id="prNome" value="${esc(p.nome || '')}" maxlength="60"></div>
      <div class="campo"><label for="prCargo">Cargo (aparece no site)</label><input type="text" id="prCargo" value="${esc(p.cargo || 'Barbeiro')}" maxlength="60" placeholder="Barbeiro"></div>
      <div class="campo"><label for="prFoto">Link da foto</label><input type="url" id="prFoto" value="${esc(p.foto_url || '')}" placeholder="https://res.cloudinary.com/...">
        <p class="dica">Suba a foto no Cloudinary (ou outro serviço) e cole o link aqui.</p></div>
      <label class="check"><input type="checkbox" id="prAtivo" ${p.ativo !== false ? 'checked' : ''}> Aparece no site para agendamento</label>
      ${novo ? '<p class="dica" style="color:var(--txt-3);font-size:0.82rem">Ele começa com a jornada igual ao horário da barbearia. Ajuste em Horários.</p>' : ''}
      <div id="prErro"></div>`,
      [{ texto: 'Cancelar', acao: fechar },
       { texto: 'Salvar', classe: 'cheio', acao: el => salvarCom(el, () => api.adminSalvarProfissional({ id: p.id || null, nome: $('#prNome').value.trim(),
           foto_url: $('#prFoto').value.trim(), cargo: $('#prCargo').value.trim(), ativo: $('#prAtivo').checked }), 'Barbeiro salvo.', 'prErro') }]);
  }

  /* ═════════════ INÍCIO ═════════════ */
  let relogio = null;
  async function iniciar() {
    clearInterval(relogio);
    try { await api.capturarRetornoOAuth(); } catch (e) { toast(msgErro(e), true); }
    try { await api.renovarSessao(); } catch (e) {}
    try { A.cat = await api.catalogo(); }
    catch (e) { $('#app').innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`; return; }
    if (!api.sessao()) return telaEntrar();
    try { A.eu = await api.adminEu(); }
    catch (e) { return e.codigo === 'SEM_PERMISSAO' ? telaSemAcesso() : ($('#app').innerHTML = `<div class="aviso erro">${esc(msgErro(e))}</div>`); }
    A.adm = null;
    if (!ehBarbeiro()) { try { A.adm = await api.adminCatalogo(); } catch (e) {} }
    try { A.secao = sessionStorage.getItem('nc_painel_secao') || 'agenda'; } catch (e) {}
    montarPainel();
    relogio = setInterval(() => { if (!document.hidden && !dlg.open && A.secao === 'agenda') carregarDia(true); }, 60000);
  }

  if (api.modo === 'demo') $('#demoBar').hidden = false;
  iniciar();
})();
