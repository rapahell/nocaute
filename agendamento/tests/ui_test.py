"""Teste de interface no modo demonstração (Playwright).
Uso: python3 tests/ui_test.py [pasta_para_capturas]
"""
import asyncio, sys, os, re
from playwright.async_api import async_playwright

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "file://" + os.path.join(RAIZ, "index.html")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp"

# A equipe começa só com o Danillo. Os testes simulam um segundo barbeiro já cadastrado
# pelo dono no painel (o cadastro em si é testado em admin_test.py).
SEGUNDO_BARBEIRO = """
(() => {
  let cfg;
  Object.defineProperty(window, 'NC_CONFIG', { configurable: true,
    get() { return cfg; },
    set(v) {
      if (v && v.demo && !v.demo.profissionais.some(p => p.id === 'andre'))
        v.demo.profissionais.push({ id: 'andre', nome: 'André Luiz', cargo: 'Barbeiro', ordem: 2, ativo: true, especialidades: [], foto_url: null });
      cfg = v;
    } });
})();
"""
falhas = []

def ok(nome, cond):
    print(("ok  " if cond else "FALHOU ") + nome)
    if not cond: falhas.append(nome)

async def escolher_horario(page, servicos, prof="danillo", dia_idx=1, slot_idx=0, foto=None):
    for s in servicos:
        await page.click(f"#painel [data-servico='{s}']")
    await page.click("#btnAvancar")
    await page.click(f"#painel [data-prof='{prof}']")
    await page.wait_for_selector("#painel .slot", timeout=10000)
    dias = page.locator("#painel .cal-dia:not([disabled])")
    if dia_idx and await dias.count() > dia_idx:      # evita hoje (prazo de cancelamento)
        await dias.nth(dia_idx).click()
        await page.wait_for_timeout(300)
        await page.wait_for_selector("#painel .slot", timeout=10000)
    page.dia_reservado = await page.get_attribute("#painel .cal-dia[aria-pressed=true]", "data-dia")
    slot = page.locator("#painel .slot").nth(slot_idx)
    hora = await slot.inner_text()
    await slot.click()
    if foto: await page.screenshot(path=f"{OUT}/{foto}_horario.png")
    await page.click("#btnAvancar")
    return hora

async def identificar(page, via="google", foto=None):
    """Passo Identificação: entra (se precisar) e completa o WhatsApp (se faltar)."""
    titulo = await page.inner_text("#painel .painel-titulo")
    if "Entre para confirmar" in titulo:
        if foto: await page.screenshot(path=f"{OUT}/{foto}_entrar.png")
        if via == "google":
            await page.click("#painel [data-google]")
        else:
            await page.fill("#painel .lg-email", "ana@teste.com")
            await page.click("#painel .lg-btn")
            await page.wait_for_selector("#painel .lg-codigo", state="visible")
            await page.fill("#painel .lg-codigo", "123456")
            await page.click("#painel .lg-btn")
        await page.wait_for_function("() => !document.querySelector('#painel .painel-titulo').textContent.includes('Entre para')")
        titulo = await page.inner_text("#painel .painel-titulo")
    if "WhatsApp" in titulo:
        if foto: await page.screenshot(path=f"{OUT}/{foto}_whatsapp.png")
        await page.click("#btnAvancar")          # sem telefone: deve recusar
        await page.wait_for_timeout(200)
        page.erro_tel = "Informe" in await page.inner_text("#pfErro")
        await page.fill("#pfNome", "Ana Teste")
        await page.fill("#pfTel", "62999990000")
        await page.click("#btnAvancar")
    await page.wait_for_selector("text=Tudo certo?", timeout=8000)

async def confirmar(page, foto=None):
    if foto: await page.screenshot(path=f"{OUT}/{foto}_revisao.png")
    await page.click("#btnAvancar")

async def run():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for nome, vp, movel in [("desk", {"width": 1366, "height": 900}, False), ("mob", {"width": 390, "height": 844}, True)]:
            ctx = await b.new_context(viewport=vp, is_mobile=movel, has_touch=movel, timezone_id="America/Sao_Paulo", locale="pt-BR")
            await ctx.add_init_script(SEGUNDO_BARBEIRO)
            await ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith("file:") else r.abort())
            page = await ctx.new_page()
            erros = []
            page.on("pageerror", lambda e: erros.append(str(e)))
            await page.goto(URL)
            await page.wait_for_selector("#painel .item")
            ok(f"[{nome}] escolha inicial: marcar horário ou plano", await page.locator(".escolhas .escolha").count() == 2)
            ok(f"[{nome}] visitante vê 'Entrar'", "Entrar" in await page.inner_text("#heroConta"))
            await page.screenshot(path=f"{OUT}/{nome}_inicio.png")

            # 1/2. lista simples, combinação e soma
            await page.click("#painel [data-servico='corte']")
            await page.click("#painel [data-servico='barba']")
            ok(f"[{nome}] combo que inclui corte fica bloqueado", await page.is_disabled("#painel [data-servico='corte-barba']"))
            ok(f"[{nome}] botão mostra 1 h 25 min e R$ 130", "1 h 25 min" in (await page.inner_text("#btnAvancar")).lower() and "130" in await page.inner_text("#btnAvancar"))
            ok(f"[{nome}] combo com cover mostra 'a partir de'", "a partir de" in (await page.inner_text("#painel [data-servico='corte-cover']")).lower())
            altura = await page.eval_on_selector("#painel .item", "e => e.getBoundingClientRect().height")
            ok(f"[{nome}] linha da lista compacta ({altura:.0f}px)", altura <= 64)
            await page.screenshot(path=f"{OUT}/{nome}_lista.png")
            await page.click("#painel [data-servico='corte']")
            await page.click("#painel [data-servico='barba']")

            # 3-7. primeira reserva: escolhe tudo, depois entra e informa o WhatsApp uma vez
            hora = await escolher_horario(page, ["corte-barba"], foto=nome)
            ok(f"[{nome}] pede para entrar depois de escolher o horário", "Entre para confirmar" in await page.inner_text("#painel"))
            await identificar(page, via="google" if not movel else "email", foto=nome)
            ok(f"[{nome}] WhatsApp obrigatório no primeiro acesso", getattr(page, "erro_tel", False))
            ok(f"[{nome}] revisão mostra quem está agendando", "Ana Teste" in await page.inner_text("#painel .quem"))
            ok(f"[{nome}] revisão diz que o pagamento é na barbearia", "Na barbearia" in await page.inner_text("#painel"))
            ok(f"[{nome}] nada de Pix ou cartão na tela", not re.search(r"pix|cart[aã]o|CPF", await page.inner_text("#painel"), re.I))
            await confirmar(page, foto=nome)
            await page.wait_for_selector(".codigo-reserva", timeout=8000)
            codigo = await page.inner_text(".codigo-reserva")
            ok(f"[{nome}] confirmação com código {codigo}", bool(re.match(r"^NC[A-Z0-9]{6}$", codigo)))
            await page.screenshot(path=f"{OUT}/{nome}_confirmacao.png")
            ok(f"[{nome}] topo mostra a pessoa conectada", "Olá, Ana" in await page.inner_text("#heroConta"))

            # 2ª reserva: já conectado, não pede nada de novo
            await page.click("[data-acao='novo']")
            await escolher_horario(page, ["corte"])
            titulo = await page.inner_text("#painel .painel-titulo")
            ok(f"[{nome}] segunda vez vai direto para a revisão", "Tudo certo?" in titulo)
            await page.click("#btnVoltar")
            await page.click(f"#painel .cal-dia[data-dia='{page.dia_reservado}']")
            await page.wait_for_timeout(800)
            horas = await page.locator("#painel .slot").all_inner_texts()
            ok(f"[{nome}] {hora} reservado não aparece mais", hora not in horas)

            # 5. conflito: outra aba reserva o horário escolhido aqui
            await page.locator("#painel .slot").first.click()
            alvo = await page.locator("#painel .slot[aria-pressed=true]").inner_text()
            await page.click("#btnAvancar")
            await page.wait_for_selector("text=Tudo certo?")
            outra = await ctx.new_page()
            await outra.goto(URL); await outra.evaluate("sessionStorage.clear()"); await outra.reload()
            await outra.wait_for_selector("#painel .item")
            await outra.click("#painel [data-servico='corte']"); await outra.click("#btnAvancar")
            await outra.click("#painel [data-prof='danillo']"); await outra.wait_for_selector("#painel .slot")
            await outra.click(f"#painel .cal-dia[data-dia='{page.dia_reservado}']"); await outra.wait_for_timeout(700)
            await outra.click(f"#painel .slot[data-hora='{alvo}']"); await outra.click("#btnAvancar")
            await outra.wait_for_selector("text=Tudo certo?"); await outra.click("#btnAvancar")
            await outra.wait_for_selector(".codigo-reserva"); await outra.close()
            await page.click("#btnAvancar")
            await page.wait_for_timeout(1500)
            ok(f"[{nome}] conflito detectado volta para escolher horário",
               "Quando?" in await page.inner_text("#painel") and "reservado" in await page.inner_text("#toast"))

            # 8. minha conta: histórico e cancelamento
            await page.evaluate("document.getElementById('conta').scrollIntoView()")
            await page.wait_for_timeout(1500)
            await page.wait_for_selector("#listaMeus .reserva")
            await page.screenshot(path=f"{OUT}/{nome}_conta.png")
            n = await page.locator("#listaMeus .reserva").count()
            ok(f"[{nome}] minha conta lista as 2 reservas ({n})", n == 2)
            await page.locator("#listaMeus [data-cancelar]").first.click()
            await page.click("#dlgRodape .btn-fill")
            await page.wait_for_selector("#listaMeus .selo.cancelado", timeout=8000)
            ok(f"[{nome}] cancelamento com confirmação vai para o histórico", "cancelado" in (await page.inner_text("#listaMeus")).lower())

            # 9-11. plano: pedido pelo site, ativação pela recepção no painel
            await page.click("#listaPlanos [data-plano='plano-gold']")
            await page.click("#dlgRodape .btn-fill")
            ok(f"[{nome}] sem aceite não segue", await page.is_visible("#aceiteTermos"))
            await page.check("#aceiteTermos")
            await page.click("#dlgRodape .btn-fill")
            await page.wait_for_selector("text=Confirmar pedido")
            ok(f"[{nome}] pedido do plano diz cartão pela Stone", "Cartão de crédito (Stone), todo mês" in await page.inner_text("#dlgCorpo"))
            ok(f"[{nome}] botão leva ao pagamento", "pagamento" in (await page.inner_text("#dlgRodape .btn-fill")).lower())
            await page.click("#dlgRodape .btn-fill")
            await page.wait_for_selector("#dlgTitulo:has-text('Falta só o pagamento')")
            href = await page.get_attribute("#dlgRodape a.btn-fill", "href")
            ok(f"[{nome}] botão Pagar abre o link do Plano Gold na Stone", href == "https://payment-link-v3.stone.com.br/pl_7BaDJGox0yEOKk5tJXSrONmMz3V9kKeW")
            ok(f"[{nome}] valor certo no aviso (R$ 239,90)", "239,90" in await page.inner_text("#dlgCorpo"))
            await page.screenshot(path=f"{OUT}/{nome}_plano_pedido.png")
            await page.keyboard.press("Escape"); await page.wait_for_timeout(800)
            ok(f"[{nome}] conta mostra 'Aguardando ativação'", "aguardando ativação" in (await page.inner_text("#listaMeus")).lower())
            ok(f"[{nome}] card do plano vira 'Pedido enviado · Pagar no cartão'", "pagar no cartão" in (await page.inner_text("#listaPlanos")).lower()
               and await page.locator("#listaPlanos a[href*='stone.com.br']").count() == 1)
            ok(f"[{nome}] Minha conta tem o link para pagar", await page.locator("#listaMeus a[href*='stone.com.br']").count() == 1)

            painel = await ctx.new_page()
            await painel.goto(URL.replace("index.html", "admin.html"))
            await painel.click("text=Entrar como recepção")
            await painel.click("[data-secao=planos]")
            await painel.wait_for_selector("#listaAss .ass")
            ok(f"[{nome}] recepção vê o pedido aguardando pagamento", "aguardando pagamento" in (await painel.inner_text("#listaAss")).lower())
            ok(f"[{nome}] botão de ativar fala da Stone", "pagou na stone" in (await painel.inner_text("#listaAss")).lower())
            await painel.click("#listaAss [data-ass$='|ativar']")
            await painel.wait_for_selector("#listaAss .selo.ativa", timeout=8000)
            ass_txt = (await painel.inner_text("#listaAss")).lower()
            ok(f"[{nome}] plano no cartão mostra a próxima cobrança, sem botão Renovar", "próxima cobrança" in ass_txt and "renovar" not in ass_txt)
            await painel.close()
            await page.reload(); await page.wait_for_selector("#heroConta:has-text('Olá')", timeout=8000)
            ok(f"[{nome}] cliente continua logado no site depois do painel", "Olá, Ana" in await page.inner_text("#heroConta"))
            await page.evaluate("document.getElementById('conta').scrollIntoView()"); await page.wait_for_timeout(1200)
            ok(f"[{nome}] plano ativo na conta", "ativo" in (await page.inner_text("#listaMeus")).lower())
            ok(f"[{nome}] card do plano vira 'Você assina'", await page.locator("[data-usar-plano]").count() == 1)

            # benefício: corte em dia útil
            await page.evaluate("sessionStorage.removeItem('nc_fluxo')"); await page.reload()
            await page.wait_for_selector("#painel .item")
            ok(f"[{nome}] lista marca serviços do plano", await page.locator("#painel [data-servico='corte'] .selo-plano").count() == 1)
            await page.click("#painel [data-servico='corte']"); await page.click("#btnAvancar")
            await page.click("#painel [data-prof='andre']")
            await page.wait_for_selector("#painel .cal-dia:not([disabled])")
            dias = page.locator("#painel .cal-dia:not([disabled])")      # plano vale de segunda a quarta
            for i in range(1, await dias.count()):
                if (await dias.nth(i).get_attribute("aria-label")).split(",")[0].strip().lower() in ("segunda-feira", "terça-feira", "quarta-feira"):
                    await dias.nth(i).click(); break
            await page.wait_for_timeout(500)
            await page.locator("#painel .slot").first.click(); await page.click("#btnAvancar")
            await page.wait_for_selector("text=Tudo certo?"); await page.click("#btnAvancar")
            await page.wait_for_selector(".codigo-reserva")
            ok(f"[{nome}] benefício do plano aplicado", "coberto pelo plano" in (await page.inner_text("#painel")).lower())

            # sair e a conta some da tela
            await page.evaluate("document.getElementById('conta').scrollIntoView()")
            await page.click("#caixaLogin [data-sair]"); await page.wait_for_timeout(600)
            ok(f"[{nome}] sair volta a pedir login", "Entre na sua conta" in await page.inner_text("#caixaLogin"))

            if movel:
                await page.evaluate("window.scrollTo(0,0)")
                await page.click("#hamburger")
                await page.wait_for_timeout(400)
                await page.screenshot(path=f"{OUT}/mob_menu.png")
                await page.click(".nav-links a[href='#planos']")
                await page.wait_for_timeout(600)
                ok("[mob] menu fecha ao navegar", not await page.eval_on_selector("#navLinks", "e => e.classList.contains('open')"))

            ok(f"[{nome}] sem erros de JavaScript {erros}", not erros)
            await ctx.close()
        await b.close()
    print("\nRESULTADO:", "TODOS PASSARAM" if not falhas else f"{len(falhas)} FALHAS")
    sys.exit(1 if falhas else 0)

if __name__ == '__main__':
    asyncio.run(run())
