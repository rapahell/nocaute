/* ════════════════════════════════════════════════════════════
   CONFIGURAÇÃO DA PÁGINA DE AGENDAMENTO E DO PAINEL
   ────────────────────────────────────────────────────────────
   modo 'demo'      → roda sem servidor. Dados ficam só neste
                      aparelho. Serve para testar e apresentar.
   modo 'supabase'  → produção. Tudo vem do banco e o dono
                      edita preços, planos e horários no painel.
                      Preencher supabaseUrl e supabaseAnonKey
                      (a chave pública: "publishable", sb_publishable_...,
                      ou a antiga "anon". A chave secreta / service_role
                      NUNCA vai aqui).
   ════════════════════════════════════════════════════════════ */
window.NC_CONFIG = {
  modo: 'supabase',
  supabaseUrl: 'https://vwpahkckyaclntbpznle.supabase.co',
  supabaseAnonKey: 'sb_publishable_QrbPvqV7kU41OMeV0JHzvg_uJGTdT64',

  fuso: 'America/Sao_Paulo',
  offset: '-03:00',
  siteUrl: 'https://www.barbearianocaute.com.br/',   // site institucional (logo e "Voltar ao site")
  whatsapp: '5562982934041',
  instagram: 'barbearianocaute_',
  endereco: 'Av. T-8, 657, Setor Bueno, Goiânia, GO, 74210-270',

  /* ── Dados do modo demonstração ──
     Espelham os dados iniciais do banco (Booksy, 19/10/2026).
     No modo demo, o que for editado no painel fica guardado
     neste aparelho. Em produção NÃO são usados. */
  demo: {
    config: {
      antecedencia_min: 60, passo_min: 30, intervalo_entre_min: 0, janela_dias: 30,
      cancelamento_antecedencia_h: 2, duracao_padrao_min: 30, exigir_login: true, max_faltas: 2,
      politica_cancelamento: 'Cancelamento gratuito até 2 horas antes do horário marcado.'
    },
    servicos: [
      { id: 'corte',         nome: 'Corte',                                  categoria: 'Cortes',               preco_centavos: 7000,  duracao_min: 40, componentes: [] },
      { id: 'raspado',       nome: 'Corte Máquina Raspado',                  categoria: 'Cortes',               preco_centavos: 5000,  duracao_min: 30, componentes: [] },
      { id: 'pe-cabelo',     nome: 'Pé de Cabelo',                           categoria: 'Cortes',               preco_centavos: 3000,  duracao_min: 15, componentes: [] },
      { id: 'penteado',      nome: 'Penteado (Escova)',                      categoria: 'Cortes',               preco_centavos: 3000,  duracao_min: 20, componentes: [] },
      { id: 'higienizacao',  nome: 'Higienização',                           categoria: 'Cortes',               preco_centavos: 3000,  duracao_min: 30, componentes: [] },
      { id: 'barba',         nome: 'Barba',                                  categoria: 'Barba & Sobrancelha',  preco_centavos: 6000,  duracao_min: 45, componentes: [] },
      { id: 'sobrancelha',   nome: 'Sobrancelha na Navalha',                 categoria: 'Barba & Sobrancelha',  preco_centavos: 3000,  duracao_min: 20, componentes: [] },
      { id: 'selagem',       nome: 'Selagem ou Botox',                       categoria: 'Química & Tratamento', preco_centavos: 13000, duracao_min: 45, componentes: [] },
      { id: 'corte-barba',   nome: 'Corte + Barba',                          categoria: 'Combos',               preco_centavos: 13000, duracao_min: 60, componentes: ['corte', 'barba'] },
      { id: 'corte-selagem', nome: 'Corte + Selagem',                        categoria: 'Combos',               preco_centavos: 19000, duracao_min: 60, componentes: ['corte', 'selagem'] },
      { id: 'corte-cover',   nome: 'Corte + Cover Pintura',                  categoria: 'Combos',               preco_centavos: 17000, duracao_min: 55, componentes: ['corte', 'cover'], preco_a_partir: true },
      { id: 'combo',         nome: 'Combo Corte + Barba + Selagem + Cover',  categoria: 'Combos',               preco_centavos: 28000, duracao_min: 60, componentes: ['corte', 'barba', 'selagem', 'cover'] }
    ].map((s, i) => Object.assign({ descricao: null, preco_a_partir: false, ativo: true, agendavel_online: true, ordem: (i + 1) * 10 }, s)),
    profissionais: [
      // novos barbeiros entram pelo painel (Equipe e ajustes → Novo barbeiro)
      { id: 'danillo', nome: 'Danillo', cargo: 'Barbeiro Especialista', ordem: 1, ativo: true, especialidades: [],
        foto_url: 'https://res.cloudinary.com/dnnnn7njk/image/upload/v1777578776/foto_danillo_swnnhd.png' }
    ],
    funcionamento: [1, 2, 3, 4, 5].map(d => ({ dia_semana: d, abre: '08:30', fecha: '19:00' }))
      .concat([{ dia_semana: 6, abre: '08:30', fecha: '17:00' }]),
    // jornada inicial: igual ao funcionamento, sem almoço (o dono ajusta no painel)
    get jornadas() {
      return this.profissionais.flatMap(p => this.funcionamento.map(f => ({
        profissional_id: p.id, dia_semana: f.dia_semana, inicio: f.abre, fim: f.fecha })));
    },
    // planos de assinatura (arte da barbearia; valores e links da Stone de 13/11/2026)
    planos: [
      { id: 'plano-bronze', nome: 'Plano Bronze', descricao: '2 cortes e 1 barba por mês.', preco_centavos: 18990, ordem: 1,
        link_pagamento: 'https://payment-link-v3.stone.com.br/pl_7knWBxYALKOX1nuELhWYRqvMP932J8yj' },
      { id: 'plano-gold',   nome: 'Plano Gold',   descricao: 'Cortes e barba ilimitados.',  preco_centavos: 23990, ordem: 2,
        link_pagamento: 'https://payment-link-v3.stone.com.br/pl_7BaDJGox0yEOKk5tJXSrONmMz3V9kKeW' }
    ].map(p => Object.assign({ periodicidade: 'mensal', limite_usos_ciclo: null, vigencia_meses: null,
        regras: 'Mediante marcação com antecedência. +10% em qualquer produto da barbearia.',
        renovacao: 'Mensal, no cartão de crédito, pelo link de pagamento da Stone.', cobranca_recorrente: true,
        cancelamento: null, restricoes: { dias_semana: [1, 2, 3] },
        termos_versao: 1, ativo: true, disponivel_contratacao: true }, p)),
    planoServicos: [
      { plano_id: 'plano-bronze', servico_id: 'corte', limite_por_ciclo: 2 },
      { plano_id: 'plano-bronze', servico_id: 'barba', limite_por_ciclo: 1 },
      { plano_id: 'plano-gold', servico_id: 'corte', limite_por_ciclo: null },
      { plano_id: 'plano-gold', servico_id: 'barba', limite_por_ciclo: null },
      { plano_id: 'plano-gold', servico_id: 'corte-barba', limite_por_ciclo: null }
    ]
  }
};
