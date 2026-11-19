"""Página em modo 'supabase' contra Postgres + PostgREST + Edge Function locais."""
import asyncio, os, sys, json, time
from playwright.async_api import async_playwright

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SITE = "http://127.0.0.1:8090"
URL, ADMIN = SITE + "/index.html", SITE + "/admin.html"
SUPA_URL, ANON, USUARIO = os.environ["SUPA_URL"], os.environ["SUPA_ANON"], os.environ["SUPA_USUARIO"]
DONO = os.environ["SUPA_DONO"]
import urllib.request
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
falhas = []
def ok(nome, cond):
    print(("ok  " if cond else "FALHOU ") + nome)
    if not cond: falhas.append(nome)

async def main():
    config = open(os.path.join(RAIZ, "js", "config.js")).read() + \
        f"\nwindow.NC_CONFIG.modo='supabase';window.NC_CONFIG.supabaseUrl='{SUPA_URL}';window.NC_CONFIG.supabaseAnonKey='{ANON}';\n"
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1366, "height": 900}, timezone_id="America/Sao_Paulo")
        async def rota(r):
            u = r.request.url
            if u.endswith("/js/config.js"): return await r.fulfill(body=config, content_type="application/javascript")
            if u.startswith(SITE) or u.startswith(SUPA_URL): return await r.continue_()
            return await r.abort()
        await ctx.route("**/*", rota)
        page = await ctx.new_page()
        erros = []
        page.on("pageerror", lambda e: erros.append(str(e)))
        await page.goto(URL)
        await page.wait_for_selector("#painel .item", timeout=15000)
        ok("catálogo veio do banco (12 serviços reais)", await page.locator("#painel .item").count() == 12)
        ok("sem faixa de demonstração", not await page.is_visible("#demoBar"))
        planos_txt = await page.inner_text("#listaPlanos")
        ok("Planos Bronze e Gold vêm do banco", "189,90" in planos_txt and "239,90" in planos_txt and "Segunda a quarta" in planos_txt)

        async def escolher(servs, prof, dia_idx=1):
            for s in servs: await page.click(f"#painel [data-servico='{s}']")
            await page.click("#btnAvancar")
            await page.click(f"#painel [data-prof='{prof}']")
            await page.wait_for_selector("#painel .slot", timeout=15000)
            dias = page.locator("#painel .cal-dia:not([disabled])")
            if await dias.count() > dia_idx:
                await dias.nth(dia_idx).click(); await page.wait_for_timeout(500)
                await page.wait_for_selector("#painel .slot", timeout=15000)
            dia = await page.get_attribute("#painel .cal-dia[aria-pressed=true]", "data-dia")
            hora = await page.locator("#painel .slot").first.inner_text()
            await page.locator("#painel .slot").first.click()
            await page.click("#btnAvancar")
            return dia, hora

        # visitante: o servidor exige conta
        dia, hora = await escolher(["corte", "barba"], "danillo")
        ok("visitante é levado a entrar", "Entre para confirmar" in await page.inner_text("#painel"))

        # simula a volta do login (no ar: Google ou código no e-mail pelo Supabase Auth)
        await page.evaluate("""t => localStorage.setItem('nc_sessao', JSON.stringify({access_token: t, email: 'cliente.e2e@gmail.com',
                               nome: 'Cliente E2E', expira: Date.now() + 3600e3}))""", USUARIO)
        await page.reload()
        await page.wait_for_selector("text=Só falta seu WhatsApp", timeout=15000)
        ok("conta nova pede só o WhatsApp, com nome do Google", await page.input_value("#pfNome") == "Cliente E2E")
        await page.fill("#pfTel", "62999990000")
        await page.click("#btnAvancar")
        await page.wait_for_selector("text=Tudo certo?", timeout=15000)
        await page.click("#btnAvancar")
        await page.wait_for_selector(".codigo-reserva", timeout=15000)
        conf = await page.inner_text("#painel")
        ok(f"reserva gravada no banco em nome da conta ({dia} {hora})", "confirmado" in conf.lower() and "Cliente" in conf)

        # segunda reserva, sem pedir dados de novo
        await page.click("[data-acao='novo']")
        await escolher(["corte"], "andre")
        ok("segunda vez vai direto para a revisão", "Tudo certo?" in await page.inner_text("#painel"))
        ok("pagamento na barbearia, sem Pix", "Na barbearia" in await page.inner_text("#painel") and "Pix" not in await page.inner_text("#painel"))
        await page.click("#btnAvancar")
        await page.wait_for_selector(".codigo-reserva", timeout=15000)

        # o horário some do servidor
        await page.click("[data-acao='novo']")
        await page.click("#painel [data-servico='corte']"); await page.click("#btnAvancar")
        await page.click("#painel [data-prof='danillo']")
        await page.wait_for_selector("#painel .slot", timeout=15000)
        await page.click(f"#painel .cal-dia[data-dia='{dia}']"); await page.wait_for_timeout(900)
        ok(f"servidor removeu {hora} do Danillo", hora not in await page.locator("#painel .slot").all_inner_texts())

        # minha conta: histórico vindo do banco e cancelamento
        await page.evaluate("document.getElementById('conta').scrollIntoView()")
        await page.wait_for_timeout(1500)
        await page.wait_for_selector("#listaMeus .reserva", timeout=15000)
        ok("Minha conta lista as 2 reservas da conta", await page.locator("#listaMeus .reserva").count() == 2)
        await page.locator("#listaMeus .reserva", has_text="André").locator("[data-cancelar]").click()
        await page.click("#dlgRodape .btn-fill")
        await page.wait_for_selector("#listaMeus .selo.cancelado", timeout=15000)
        ok("cancelamento pelo servidor", True)
        await page.screenshot(path=f"{OUT}/e2e_conta.png")

        # mais um horário com o André, para quando ele conectar a agenda
        await page.evaluate("sessionStorage.removeItem('nc_fluxo')"); await page.goto(URL); await page.reload()
        await page.wait_for_selector("#painel .item", timeout=15000)
        await escolher(["barba"], "andre")
        await page.wait_for_selector("text=Tudo certo?"); await page.click("#btnAvancar")
        await page.wait_for_selector(".codigo-reserva", timeout=15000)

        # pedido do Plano Bronze pelo site
        await page.click("#listaPlanos [data-plano='plano-bronze']")
        await page.check("#aceiteTermos"); await page.click("#dlgRodape .btn-fill")
        await page.wait_for_selector("text=Confirmar pedido", timeout=15000)
        await page.click("#dlgRodape .btn-fill")
        await page.wait_for_selector("#dlgTitulo:has-text('Falta só o pagamento')", timeout=15000)
        ok("pedido gravado no banco devolve o link da Stone do Bronze",
           await page.get_attribute("#dlgRodape a.btn-fill", "href") == "https://payment-link-v3.stone.com.br/pl_7knWBxYALKOX1nuELhWYRqvMP932J8yj")
        await page.keyboard.press("Escape")

        # ═════════ PAINEL ═════════
        await page.evaluate("""t => localStorage.setItem('nc_sessao', JSON.stringify({access_token: t, email: 'dono@nocaute.com',
                               nome: 'Dono', expira: Date.now() + 3600e3}))""", DONO)
        await page.goto(ADMIN)
        await page.wait_for_selector("#linhaTempo", timeout=15000)
        ok("dono entra no painel", "Dono" in await page.inner_text("#quem"))
        await page.fill("#dataInput", dia); await page.dispatch_event("#dataInput", "change")
        await page.wait_for_selector("#linhaTempo .ag, #linhaTempo .vazio", timeout=15000)
        await page.wait_for_timeout(800)
        ok("painel mostra a reserva do Danillo com telefone", "Cliente E2E" in await page.inner_text("#linhaTempo")
           and await page.locator("#linhaTempo a[href*='wa.me/5562999990000']").count() >= 1)
        ok("painel sem Google Agenda", await page.locator("#caixaGoogle").count() == 0)

        # bloqueio no painel tira o horário do site
        disp = """async ([d, p]) => (await window.NC_API.criar(window.NC_CONFIG).disponibilidade(d, ['corte'], p)).map(s => s.hora)"""
        ok("15:00 do Danillo livre antes do bloqueio", "15:00" in await page.evaluate(disp, [dia, "danillo"]))
        await page.click("[data-acao='bloquear']")
        await page.select_option("#bProf", "danillo"); await page.fill("#bData", dia)
        await page.fill("#bIni", "15:00"); await page.fill("#bFim", "16:00"); await page.fill("#bMotivo", "Médico")
        await page.click("#dlgRodape .btn.cheio"); await page.wait_for_selector("#linhaTempo .bloq", timeout=15000)
        dan, andre = await page.evaluate(disp, [dia, "danillo"]), await page.evaluate(disp, [dia, "andre"])
        ok("bloqueio gravado no banco tira 15:00 e 15:30 do Danillo", "15:00" not in dan and "15:30" not in dan and "16:00" in dan)
        ok("André segue livre nesse horário", "15:00" in andre)

        # cancelar no painel devolve o horário ao site
        await page.click("#abas [data-prof='danillo']"); await page.wait_for_timeout(900)
        await page.locator("#linhaTempo [data-cancelar]").first.click()
        await page.click("#dlgRodape .btn.cheio"); await page.wait_for_timeout(1200)
        ok(f"cancelar no painel devolve {hora} ao site", hora in await page.evaluate(disp, [dia, "danillo"]))
        await page.screenshot(path=f"{OUT}/e2e_painel.png", full_page=True)

        # ═════════ GESTÃO PELO DONO ═════════
        await page.click("[data-secao=clientes]")
        await page.wait_for_selector("#listaClientes .ass", timeout=15000)
        cl = await page.inner_text("#listaClientes")
        ok("aba Clientes com os números vindos do banco", "Cliente E2E" in cl and "Marcou 3" in cl and "Cancelou 1" in cl and "cancelado pela barbearia" in cl)
        ok("resumo do mês vindo do banco", "danillo" in (await page.inner_text("#resumo")).lower())
        await page.click("[data-ficha-cliente]"); await page.wait_for_selector("#dlgCorpo .ficha-linha", timeout=15000)
        ok("ficha pela lista de clientes", "Marcou 3" in await page.inner_text("#dlgCorpo"))
        await page.click("#dlg [data-fechar]")
        await page.click("[data-secao=planos]")
        await page.wait_for_selector("#listaAss .ass", timeout=15000)
        ok("pedido do cliente aguarda pagamento no painel", "Cliente E2E" in await page.inner_text("#listaAss"))
        await page.click("#listaAss [data-ass$='|ativar']")
        await page.wait_for_selector("#listaAss .selo.ativa", timeout=15000)
        ok("dono ativa o plano depois do pagamento na Stone", "próxima cobrança" in await page.inner_text("#listaAss"))

        await page.click("[data-secao=servicos]")
        await page.click("[data-editar-servico='corte']"); await page.fill("#sPreco", "75")
        await page.click("#dlgRodape .btn.cheio"); await page.wait_for_timeout(1500)
        req = urllib.request.Request(SUPA_URL + "/rest/v1/servicos?select=preco_centavos&id=eq.corte", headers={"apikey": ANON, "Authorization": "Bearer " + ANON})
        ok("preço novo do corte já sai do banco para o site", json.loads(urllib.request.urlopen(req).read())[0]["preco_centavos"] == 7500)

        await page.click("[data-secao=horarios]"); await page.wait_for_selector(".fAberto")
        await page.fill(".fFecha[data-dia='6']", "16:00"); await page.click("[data-salvar-func]"); await page.wait_for_timeout(1500)
        req = urllib.request.Request(SUPA_URL + "/rest/v1/horarios_funcionamento?select=fecha&dia_semana=eq.6", headers={"apikey": ANON, "Authorization": "Bearer " + ANON})
        ok("horário do sábado salvo no banco", json.loads(urllib.request.urlopen(req).read())[0]["fecha"].startswith("16:00"))
        await page.screenshot(path=f"{OUT}/e2e_painel_horarios.png", full_page=True)

        ok(f"sem erros de JavaScript {erros}", not erros)
        await b.close()
    print("\nE2E:", "TODOS PASSARAM" if not falhas else f"{len(falhas)} FALHAS")
    sys.exit(1 if falhas else 0)

asyncio.run(main())
