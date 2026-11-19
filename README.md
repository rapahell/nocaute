# Barbearia Nocaute · Agendamento online

Página própria de agendamento para substituir o Booksy, com painel para a barbearia. Funciona sozinha, com URL própria, e depois é ligada ao botão "Agendar" do site institucional.

**Marcar horário não tem pagamento pelo site:** o cliente marca e paga na barbearia. **Os planos mensais são pagos no cartão**, pelo link de pagamento da Stone que cada plano tem cadastrado: o cliente pede pelo site, é levado para a página da Stone e o plano é ativado no painel quando o pagamento aparece. Plano sem link continua pago no balcão.

Visual: mesmas cores, fontes (Cinzel, Barlow, Barlow Condensed), logo, botões e padrões do site atual.

---

## 1. Arquivos

```
index.html                       página de agendamento (marcação e estilos)
admin.html                       painel da barbearia (marcação e estilos)
js/config.js                     configuração: modo demo/supabase, chaves públicas, dados de demonstração
js/regras.js                     regras puras: combinação, preço, duração, horários, planos, validações
js/api.js                        camada de dados (modo demo no navegador ou Supabase)
js/app.js                        telas do agendamento
js/admin.js                      telas do painel

supabase/migrations/20261020000000_nocaute.sql   banco completo: tabelas, regras, RLS, funções, painel, dados iniciais

tests/sql/run.sh + testes.sql    testes do banco (Postgres temporário)
tests/regras.test.js             testes das regras do navegador (Node)
tests/ui_test.py                 agendamento no modo demonstração (Playwright)
tests/admin_test.py              painel no modo demonstração (Playwright)
tests/e2e/run.sh                 ponta a ponta: Postgres + PostgREST + navegador
```

## 2. O que está implementado

**Página de agendamento**
- Logo de cara, duas escolhas: **Marcar horário** ou **Plano mensal**, e "Já é cliente? Entrar". Conectado, mostra "Olá, Fulano".
- Serviços em lista simples (nome, tempo, preço), seleção múltipla e bloqueio de combinações inválidas (ex.: "Corte + Barba" com "Corte"). Preço variável aparece como "a partir de".
- Fluxo: serviços → barbeiro ("Qualquer barbeiro" incluso) → calendário e horários → identificação → revisão → confirmação. Pagamento: "Na barbearia".
- Conta do cliente: escolhe tudo primeiro e só entra na hora de confirmar, com **Google** ou **código no e-mail** (sem senha). Na primeira vez informa o WhatsApp; nas próximas vai direto para a revisão.
- Confirmação com código da reserva, valor, orientações e arquivo .ics para a agenda do celular.
- Minha conta: próximos horários, histórico, plano com usos do mês, alterar dados, sair. Cancelamento com confirmação e respeito ao prazo.
- Planos: card com preço, serviços incluídos, limites, dias, regras e forma de pagamento. "Quero assinar" → aceite das condições → entrar (se preciso) → WhatsApp (se faltar) → **Continuar para o pagamento** → aviso "Falta só o pagamento" com o botão **Pagar no cartão**, que abre o link da Stone. Até a ativação, o card e a Minha conta mantêm o botão de pagar. Ativado, o card vira "Você assina · Agendar" e os serviços cobertos saem sem custo na reserva.
- Celular primeiro, teclado, foco visível, contraste, estados de carregamento, prevenção de clique duplo.
- Link direto com serviço ou barbeiro pré-escolhido: `?servico=corte-barba` e `?barbeiro=danillo`.

**Painel da barbearia (`admin.html`)**

| Aba | Quem vê | O que faz |
|---|---|---|
| Agenda | todos | dia com setas e calendário, filtro por barbeiro, WhatsApp do cliente, Atendido, Não veio, Cancelar, Ficha, bloquear horário ou dia, números do dia, **Lembrar clientes de amanhã** (abre o WhatsApp de cada um com a mensagem pronta e marca quem já recebeu) |
| Clientes | dono e recepção | busca por nome ou WhatsApp; por cliente: marcou, atendido, cancelou, faltou, cancelados pela barbearia, última visita e próximo horário; ordem por última visita, mais atendimentos, mais faltas e cancelamentos ou nome; filtro de **sumidos** há 30, 45, 60 ou 90 dias, com WhatsApp pronto para chamar de volta. Só o dono vê o **resumo do mês**: atendimentos e valor por barbeiro, cancelamentos, faltas, clientes novos e planos |
| Serviços e preços | dono | editar nome, categoria, preço, "a partir de", duração, descrição, o que o combo inclui; criar; desativar ou excluir (serviço já usado é só desativado) |
| Planos / Assinantes | dono (planos e assinantes), recepção (assinantes) | editar plano: preço, **link de pagamento da Stone** e se ele é de cobrança mensal automática, serviços incluídos e limite de cada um, limite total, dias válidos, regras, aberto para pedidos. Assinantes: **Recebi · Ativar**, **Recebi · Renovar** (+1 mês), Cancelar, WhatsApp |
| Horários | dono | horário da barbearia por dia; jornada de cada barbeiro com almoço opcional; "Igual ao horário da barbearia" |
| Equipe e ajustes | dono | barbeiros (nome, cargo, foto, ativo, novo; barbeiro que saiu é desmarcado e o histórico fica), regras do agendamento (antecedência, prazo de cancelamento, intervalo, passo dos horários, janela de dias, exigir conta, faltas para bloquear) e **acesso ao painel** por e-mail |

- Barbeiro vê só a própria agenda.
- **Ficha do cliente**: totais do histórico inteiro (marcou, atendido, cancelou, faltou e o que a barbearia cancelou), última visita, próximo horário e os 12 últimos horários, cada um dizendo quem cancelou.
- **Regra de faltas**: com 2 faltas nos últimos 6 meses (número ajustável; 0 desliga), o cliente não marca mais pelo site e recebe um botão para combinar pelo WhatsApp. Na ficha, "Liberar para marcar pelo site" zera a contagem; o total de faltas continua no histórico.
- As reservas ficam só no sistema: a agenda de cada barbeiro é a aba Agenda do painel (sem integração com o Google Agenda).
- Tudo que é editado vale no site na hora.
- Mudança de preço ou regras de um plano vale para quem pedir dali em diante; quem já assina segue com as condições que aceitou (versão dos termos).
- Plano com cobrança mensal no cartão vira o mês sozinho enquanto estiver ativo; se a cobrança falhar na Stone, a barbearia cancela no painel. Ao cancelar (pelo painel ou pelo cliente), o painel lembra de encerrar a cobrança recorrente no app da Stone: o sistema não fala com a Stone.
- Plano pago no balcão sem renovação passa para "Renovação atrasada" no fim do mês e deixa de cobrir serviços sozinho.

**Servidor (Supabase)**
- Disponibilidade calculada no banco: funcionamento, jornada de cada barbeiro (com pausas), duração somada, intervalo, bloqueios, reservas existentes, antecedência, janela de dias. Horários na grade da jornada (08:30, 09:00, 09:30…).
- Reserva validada de novo no servidor. Duas proteções contra conflito: trava por dia (`pg_advisory_xact_lock`) e restrição `EXCLUDE`, que impede sobreposição mesmo se alguém burlar a função.
- Planos: pendente → ativa (painel) → inadimplente (fim do mês sem renovação) → cancelada/expirada. Limite por ciclo e por serviço, restrição de dias, uso registrado sem duplicidade e devolvido ao cancelar.
- Quem pode o quê é decidido no banco (`dono`, `recepcao`, `barbeiro`), não na tela.
- Segurança: RLS em todas as tabelas, navegador só lê o catálogo e chama funções específicas, telefone e e-mail não saem nas respostas públicas, token de acesso guardado como hash. Histórico de alterações em `historico`.

## 3. Tecnologias

HTML, CSS e JavaScript puros (sem framework, sem build) e Supabase (Postgres + PostgREST + Auth). Não há função de servidor para publicar: tudo roda no banco.

## 4. Dados iniciais (Booksy, 19/10/2026)

O banco já nasce com estes dados. Depois, o dono muda tudo pelo painel.

| Serviço | Duração | Preço |
|---|---|---|
| Corte | 40 min | R$ 70 |
| Corte Máquina Raspado | 30 min | R$ 50 |
| Pé de Cabelo | 15 min | R$ 30 |
| Penteado (Escova) | 20 min | R$ 30 |
| Higienização | 30 min | R$ 30 |
| Barba | 45 min | R$ 60 |
| Sobrancelha na Navalha | 20 min | R$ 30 |
| Selagem ou Botox | 45 min | R$ 130 |
| Corte + Barba | 1 h | R$ 130 |
| Corte + Selagem | 1 h | R$ 190 |
| Corte + Cover Pintura | 55 min | a partir de R$ 170 |
| Combo Corte + Barba + Selagem + Cover | 1 h | R$ 280 |

- **Planos** (válidos de segunda a quarta, mediante marcação com antecedência, +10% em qualquer produto da barbearia, pagos no cartão pela Stone com cobrança mensal):
  - **Plano Bronze**, R$ 189,90/mês: 2 cortes e 1 barba por mês. [Link de pagamento](https://payment-link-v3.stone.com.br/pl_7knWBxYALKOX1nuELhWYRqvMP932J8yj).
  - **Plano Gold**, R$ 239,90/mês: cortes e barba ilimitados (cobre também o combo Corte + Barba). [Link de pagamento](https://payment-link-v3.stone.com.br/pl_7BaDJGox0yEOKk5tJXSrONmMz3V9kKeW).
- **Horário:** segunda a sexta 08h30 às 19h, sábado 08h30 às 17h, domingo fechado.
- **Barbeiros:** só o Danillo. Barbeiro novo entra pelo painel (Equipe e ajustes → Novo barbeiro), já com a jornada da barbearia, e aparece no agendamento e no site institucional.
- **Regras:** horários de 30 em 30 min, 1 h de antecedência, cancelamento até 2 h antes, agenda aberta 30 dias, conta obrigatória.

No navegador (`js/config.js`) vão só `supabaseUrl` e `supabaseAnonKey` (a chave pública: a nova `sb_publishable_...` ou a antiga `anon`; o sistema aceita as duas). A `service_role` **nunca** vai para o navegador.

## 5. Testes executados

| Teste | Resultado |
|---|---|
| Banco: 150 verificações (agendamento, conflitos, login, planos, link da Stone e renovação automática, ativação e renovação, edição pelo dono, clientes, resumo, regra de faltas, permissões) | todas passaram |
| Corrida: 12 clientes no mesmo horário ao mesmo tempo | 1 aceito |
| Corrida: "qualquer barbeiro", 2 barbeiros | 1 para cada |
| Regras do navegador (Node) | 7 grupos, todos passaram |
| Agendamento no modo demonstração, desktop e celular (inclui pedido de plano, passo de pagamento na Stone e ativação pela recepção) | 73 verificações, todas passaram |
| Painel no modo demonstração, desktop e celular (agenda, clientes, lembretes, regra de faltas, preços, planos, horários, equipe, acessos, papéis) | 92 verificações, todas passaram |
| Ponta a ponta com banco real: site + painel + bloqueio + cancelamento + clientes e resumo + plano + edição de preço e horário | 27 verificações, todas passaram |

**Não testado:** as telas reais do Google e do e-mail com código, que dependem do Supabase Auth do projeto configurado. No teste de ponta a ponta, a volta do login é simulada com um token válido.

## 6. Pendências

1. **Login**:
   - **Google**: no Google Cloud Console, credencial OAuth (tipo "Aplicativo da Web") com retorno `https://<projeto>.supabase.co/auth/v1/callback`. No Supabase: Authentication → Providers → Google → Client ID e Secret. Em Authentication → URL Configuration, cadastrar os endereços da página e do painel em "Redirect URLs".
   - **E-mail com código**: Authentication → Providers → Email ligado; nos modelos "Magic Link" e "Confirm signup", usar `{{ .Token }}` para mandar o código de 6 dígitos, em português. Configurar SMTP próprio (o envio padrão do Supabase só entrega para a equipe do projeto).
   - Tela de consentimento do Google com nome e logo da Nocaute e link da política de privacidade.
2. **Agendador (pg_cron)**: ativar a extensão em Database → Extensions **antes** de rodar a migração, para a virada diária das assinaturas se criar sozinha.
3. **Lembretes** por e-mail ou WhatsApp: a tabela `historico` registra cada evento; falta escolher o serviço de envio.
4. **Política de privacidade (LGPD)**: publicar texto e link e prazo de retenção dos dados.

## 7. Rodar localmente

**Modo demonstração:** abra `index.html` (agendamento) e `admin.html` (painel) no navegador. Não precisa de servidor. Os dados ficam no aparelho; o código de login de teste é `123456`. No painel, os botões "Entrar como dono / recepção / barbeiro" simulam cada perfil. Site e painel têm logins separados, então dá para apresentar os dois lado a lado.

**Testes:**
```bash
node --test tests/regras.test.js
bash tests/sql/run.sh                         # precisa de Postgres (não rodar como root)
python3 tests/ui_test.py /tmp                 # precisa de Playwright
python3 tests/admin_test.py /tmp
POSTGREST=/caminho/postgrest bash tests/e2e/run.sh /tmp
```

## 8. Publicar

1. Criar um projeto no Supabase e ativar `pg_cron`.
2. SQL Editor → colar e rodar `supabase/migrations/20261020000000_nocaute.sql`.
3. Em `js/config.js`: `modo: 'supabase'`, `supabaseUrl`, `supabaseAnonKey` e `siteUrl`.
4. **Primeiro acesso do dono** (só uma vez): o Danillo entra no painel com o Google dele (vai ver "Sem acesso"); depois, no SQL Editor:
   ```sql
   insert into admins (user_id, papel)
   select id, 'dono' from auth.users where email = 'email-do-danillo@gmail.com';
   ```
   A partir daí, ele mesmo libera recepção e barbeiros em **Equipe e ajustes → Acesso ao painel** (a pessoa precisa ter entrado uma vez antes).
5. Publicar a pasta no GitHub Pages ou Cloudflare Pages, em subdomínio (`agendar.dominio.com.br`) ou em pasta do site (`/agendar/`).

## 9. Site institucional ligado ao painel

O `barbearia-nocaute.html` tem, no topo do script, `supabaseUrl` e `supabaseKey` (os mesmos valores do `js/config.js`). Preenchidos, a seção Equipe, os serviços com preços e o horário de funcionamento vêm do painel: barbeiro novo, barbeiro que saiu, preço ou horário mudado aparecem no site sem mexer no arquivo. Vazios, ou se o Supabase não responder, o site usa os dados escritos no arquivo (hoje: Danillo, a tabela do Booksy e 08h30 às 19h / sábado até 17h). Com um barbeiro só, o card da equipe fica deitado; com dois ou mais, volta à grade.

## 10. Ligar ao botão "Agendar" do site

Só depois de validar a página publicada. No site institucional, os botões hoje abrem o modal. A troca é no script do site:

```js
const AGENDA_URL = 'https://agendar.seudominio.com.br/';   // ajustar

document.addEventListener('click', e => {
  const t = e.target.closest('[data-agendar], [data-servico], [data-barbeiro]');
  if (!t) return;
  e.preventDefault();
  const q = new URLSearchParams();
  if (t.dataset.servico) q.set('servico', t.dataset.servico);     // os ids são os mesmos nos dois
  if (t.dataset.barbeiro) q.set('barbeiro', t.dataset.barbeiro);
  location.href = AGENDA_URL + (q.toString() ? '?' + q : '') + '#agendar';
});
```

Depois disso o modal antigo e o selo do Booksy no rodapé podem sair do site.
