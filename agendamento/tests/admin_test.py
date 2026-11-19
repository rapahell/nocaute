"""Teste do painel no modo demonstração (Playwright).
Uso: python3 tests/admin_test.py [pasta_para_capturas]
"""
import asyncio, sys, os, urllib.parse
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ui_test as U

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADMIN = "file://" + os.path.join(RAIZ, "admin.html")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
falhas = []
def ok(nome, cond):
    print(("ok  " if cond else "FALHOU ") + nome)
    if not cond: falhas.append(nome)

DISP = """async ([dia, prof]) => (await window.NC_API.criar(window.NC_CONFIG).disponibilidade(dia, ['corte'], prof)).map(s => s.hora)"""

async def run():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for nome, vp, movel in [("desk", {"width": 1366, "height": 900}, False), ("mob", {"width": 390, "height": 844}, True)]:
            ctx = await b.new_context(viewport=vp, is_mobile=movel, has_touch=movel, timezone_id="America/Sao_Paulo", locale="pt-BR")
            await ctx.add_init_script(U.SEGUNDO_BARBEIRO)
            await ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith("file:") else r.abort())
            erros = []

            # cliente marca dois horários no site (Danillo e André, mesmo dia)
            site = await ctx.new_page()
            site.on("pageerror", lambda e: erros.append(str(e)))
            await site.goto(U.URL); await site.wait_for_selector("#painel .item")
            h1 = await U.escolher_horario(site, ["corte-barba"], prof="danillo")
            dia = site.dia_reservado
            await U.identificar(site, via="google"); await U.confirmar(site)
            await site.wait_for_selector(".codigo-reserva")
            await site.click("[data-acao='novo']")
            await site.click("#painel [data-servico='corte']"); await site.click("#btnAvancar")
            await site.click("#painel [data-prof='andre']"); await site.wait_for_selector("#painel .slot")
            await site.click(f"#painel .cal-dia[data-dia='{dia}']"); await site.wait_for_timeout(600)
            await site.locator("#painel .slot").nth(2).click(); await site.click("#btnAvancar")
            await site.wait_for_selector("text=Tudo certo?"); await site.click("#btnAvancar")
            await site.wait_for_selector(".codigo-reserva")
            await site.close()

            # painel: dono
            page = await ctx.new_page()
            page.on("pageerror", lambda e: erros.append(str(e)))
            await page.goto(ADMIN)
            await page.wait_for_selector("[data-demo='dono']")
            ok(f"[{nome}] login do site não vale para o painel", "Painel da barbearia" in await page.inner_text("#app"))
            # e-mail de cliente comum não tem acesso
            await page.evaluate("window.NC_API.criar(window.NC_CONFIG).verificarCodigo('ana@teste.com', '123456')")
            await page.reload(); await page.wait_for_selector("text=Sem acesso ao painel")
            ok(f"[{nome}] cliente comum logado não entra no painel", "não está liberada" in await page.inner_text("#app"))
            await page.click("#sair")
            await page.wait_for_selector("[data-demo='dono']")
            ok(f"[{nome}] tela de entrada do painel", "Painel da barbearia" in await page.inner_text("#app"))
            await page.click("[data-demo='dono']")
            await page.wait_for_selector("#linhaTempo")
            await page.fill("#dataInput", dia); await page.dispatch_event("#dataInput", "change")
            await page.wait_for_selector("#linhaTempo .ag")
            await page.screenshot(path=f"{OUT}/admin_{nome}_dia.png", full_page=True)
            ok(f"[{nome}] dono vê os 2 horários do dia", await page.locator("#linhaTempo .ag").count() == 2)
            ok(f"[{nome}] números do dia (R$ 200 previsto)", "200" in await page.inner_text("#numeros"))
            ok(f"[{nome}] botão de WhatsApp com o telefone", "wa.me/5562999990000" in (await page.get_attribute("#linhaTempo .ag a.btn", "href")))
            await page.click("#abas [data-prof='danillo']"); await page.wait_for_timeout(500)
            ok(f"[{nome}] filtro por barbeiro", await page.locator("#linhaTempo .ag").count() == 1)

            # ficha
            await page.locator("[data-ficha]").first.click()
            await page.wait_for_selector("#dlgCorpo .ficha-linha")
            ok(f"[{nome}] ficha do cliente", "Ana Teste" in await page.inner_text("#dlgCorpo"))
            await page.click("#dlg [data-fechar]")

            # atendido
            await page.click("[data-status='concluido']"); await page.wait_for_timeout(700)
            ok(f"[{nome}] marcar como atendido", "atendido" in (await page.inner_text("#linhaTempo")).lower())

            # bloquear 16:00-17:00 do Danillo e conferir no site
            livres = await page.evaluate(DISP, [dia, "danillo"])
            ok(f"[{nome}] 16:00 livre antes do bloqueio", "16:00" in livres)
            await page.click("[data-acao='bloquear']")
            await page.select_option("#bProf", "danillo"); await page.fill("#bIni", "16:00"); await page.fill("#bFim", "17:00"); await page.fill("#bMotivo", "Médico")
            await page.click("#dlgRodape .btn.cheio"); await page.wait_for_selector("#linhaTempo .bloq")
            ok(f"[{nome}] bloqueio aparece no dia", "Médico" in await page.inner_text("#linhaTempo"))
            livres = await page.evaluate(DISP, [dia, "danillo"])
            # corte = 40 min: 15:30 também invadiria o bloqueio das 16h
            ok(f"[{nome}] bloqueio tira 15:30, 16:00 e 16:30 do site", not {"15:30", "16:00", "16:30"} & set(livres) and "15:00" in livres)
            await page.click("[data-desbloquear]"); await page.wait_for_timeout(700)
            ok(f"[{nome}] liberar devolve o horário", "16:00" in await page.evaluate(DISP, [dia, "danillo"]))

            # cancelar o do André
            await page.click("#abas [data-prof='andre']"); await page.wait_for_timeout(500)
            await page.click("[data-cancelar]"); await page.fill("#motivo", "barbeiro doente")
            await page.click("#dlgRodape .btn.cheio"); await page.wait_for_timeout(800)
            ok(f"[{nome}] cancelado some da lista", await page.locator("#linhaTempo .ag").count() == 0)
            await page.check("#verCancelados")
            ok(f"[{nome}] aparece ao mostrar cancelados", "cancelado" in (await page.inner_text("#linhaTempo")).lower())

            ok(f"[{nome}] painel sem Google Agenda", await page.locator("#caixaGoogle, [data-gconectar]").count() == 0)

            # ── gestão (dono) ──
            CAT = "window.NC_API.criar(window.NC_CONFIG).catalogo()"
            await page.click("[data-secao=servicos]"); await page.wait_for_selector("[data-editar-servico='corte']")
            ok(f"[{nome}] lista de serviços com os preços reais", "R$ 70" in (await page.inner_text(".linha-ed:has([data-editar-servico='corte'])")).replace("\xa0", " "))
            await page.click("[data-editar-servico='corte']"); await page.fill("#sPreco", "75"); await page.fill("#sDur", "45")
            await page.click("#dlgRodape .btn.cheio"); await page.wait_for_timeout(900)
            corte = await page.evaluate(CAT + ".then(c => c.servicos.find(s => s.id === 'corte'))")
            ok(f"[{nome}] preço e duração editados chegam ao site", corte["preco_centavos"] == 7500 and corte["duracao_min"] == 45)
            await page.click("[data-novo-servico]"); await page.fill("#sNome", "Relaxamento"); await page.fill("#sCat", "Química & Tratamento")
            await page.fill("#sPreco", "90"); await page.fill("#sDur", "40"); await page.click("#dlgRodape .btn.cheio"); await page.wait_for_timeout(900)
            ok(f"[{nome}] serviço novo aparece no site", await page.evaluate(CAT + ".then(c => c.servicos.some(s => s.nome === 'Relaxamento'))"))
            await page.locator(".linha-ed:has-text('Relaxamento') button").click()
            await page.click("#dlgRodape .btn.perigo"); await page.wait_for_timeout(900)
            ok(f"[{nome}] serviço sem uso é excluído", not await page.evaluate(CAT + ".then(c => c.servicos.some(s => s.nome === 'Relaxamento'))"))

            await page.click("[data-secao=planos]"); await page.wait_for_selector("[data-editar-plano='plano-bronze']")
            await page.click("[data-editar-plano='plano-bronze']"); await page.fill("#pPreco", "199,90")
            await page.check(".pInc[value='sobrancelha']"); await page.fill(".pIncLim[data-servico='sobrancelha']", "2")
            await page.click("#dlgRodape .btn.cheio"); await page.wait_for_timeout(900)
            pl = await page.evaluate(CAT + ".then(c => ({ l: c.planos.find(p => p.id === 'plano-bronze').link_pagamento, p: c.planos.find(p => p.id === 'plano-bronze').preco_centavos, b: c.planoServicos.find(x => x.plano_id === 'plano-bronze' && x.servico_id === 'sobrancelha') }))")
            ok(f"[{nome}] editar o plano mantém o link da Stone", (pl.get("l") or "").startswith("https://payment-link-v3.stone.com.br/"))
            ok(f"[{nome}] card do plano no painel diz cartão pela Stone", "cartão pela stone" in (await page.inner_text(".cards-ed")).lower())
            ok(f"[{nome}] plano editado: R$ 199,90 e sobrancelha 2x/mês", pl["p"] == 19990 and pl["b"] and pl["b"]["limite_por_ciclo"] == 2)

            await page.click("[data-secao=horarios]"); await page.wait_for_selector(".fAberto")
            await page.fill(".fFecha[data-dia='6']", "14:00"); await page.click("[data-salvar-func]"); await page.wait_for_timeout(900)
            sab = await page.evaluate(CAT + ".then(c => c.funcionamento.find(f => f.dia_semana === 6).fecha)")
            ok(f"[{nome}] sábado passa a fechar às 14h", sab.startswith("14:00"))
            linha = page.locator("[data-jprof='andre'][data-jdia='2']")
            await linha.locator(".jPausa").check(); await page.click("[data-salvar-jornada='andre']"); await page.wait_for_timeout(900)
            j = await page.evaluate(CAT + ".then(c => c.jornadas.filter(j => j.profissional_id === 'andre' && j.dia_semana === 2).length)")
            ok(f"[{nome}] almoço do André na terça divide a jornada", j == 2)

            await page.click("[data-secao=equipe]"); await page.wait_for_selector("#aEmail")
            ok(f"[{nome}] André Luiz na equipe", "André Luiz" in await page.inner_text("#app"))
            await page.click("[data-novo-prof]"); await page.fill("#prNome", "Carlos Novo"); await page.fill("#prCargo", "Barbeiro Júnior")
            await page.click("#dlgRodape .btn.cheio"); await page.wait_for_timeout(900)
            novo = await page.evaluate(CAT + ".then(c => { const p = c.profissionais.find(x => x.nome === 'Carlos Novo'); return p && { id: p.id, cargo: p.cargo, jornadas: c.jornadas.filter(j => j.profissional_id === p.id).length }; })")
            ok(f"[{nome}] dono cadastra barbeiro novo com cargo e jornada", bool(novo) and novo["cargo"] == "Barbeiro Júnior" and novo["jornadas"] == 6)
            await page.locator(".card-ed:has-text('Carlos Novo') [data-editar-prof]").click(); await page.uncheck("#prAtivo")
            await page.click("#dlgRodape .btn.cheio"); await page.wait_for_timeout(900)
            ok(f"[{nome}] barbeiro que saiu some do site", not await page.evaluate(CAT + ".then(c => c.profissionais.some(x => x.nome === 'Carlos Novo'))"))
            await page.fill("#aEmail", "recepcao@gmail.com"); await page.select_option("#aPapel", "recepcao")
            await page.click("[data-liberar]"); await page.wait_for_timeout(900)
            ok(f"[{nome}] acesso liberado aparece na lista", "recepcao@gmail.com" in await page.inner_text("#acessos"))
            await page.screenshot(path=f"{OUT}/admin_{nome}_equipe.png", full_page=True)
            sw = await page.evaluate("document.documentElement.scrollWidth")
            ok(f"[{nome}] sem rolagem lateral ({sw}px)", sw <= vp["width"])

            # ── clientes, resumo do mês e lembretes ──
            await page.click("[data-secao=clientes]"); await page.wait_for_selector("#listaClientes .ass")
            txt = await page.inner_text("#listaClientes")
            ok(f"[{nome}] lista de clientes com os números da Ana", "Ana Teste" in txt and "Marcou 2" in txt and "Atendido 1" in txt and "pela barbearia" in txt)
            ok(f"[{nome}] resumo do mês por barbeiro", "danillo" in (await page.inner_text("#resumo")).lower() and "clientes novos" in (await page.inner_text("#resumo")).lower())
            await page.fill("#clBusca", "zzz"); await page.wait_for_timeout(700)
            ok(f"[{nome}] busca sem resultado avisa", "Ninguém encontrado" in await page.inner_text("#listaClientes"))
            await page.fill("#clBusca", "99999"); await page.wait_for_timeout(700)
            ok(f"[{nome}] busca por parte do WhatsApp", "Ana Teste" in await page.inner_text("#listaClientes"))
            await page.click("[data-ficha-cliente]"); await page.wait_for_selector("#dlgCorpo .ficha-linha")
            ok(f"[{nome}] ficha aberta pela lista, com o histórico somado", "Marcou 2" in await page.inner_text("#dlgCorpo"))
            await page.screenshot(path=f"{OUT}/admin_{nome}_clientes.png", full_page=True)
            await page.click("#dlg [data-fechar]")
            sw = await page.evaluate("document.documentElement.scrollWidth")
            ok(f"[{nome}] aba Clientes sem rolagem lateral ({sw}px)", sw <= vp["width"])

            await page.click("[data-secao=agenda]"); await page.click("[data-acao='lembretes']")
            await page.wait_for_selector("#dlgCorpo .ass, #dlgCorpo .vazio:not(:has(.spinner))")
            corpo = await page.inner_text("#dlgCorpo")
            amanha_tem = await page.locator("#dlgCorpo [data-enviar]").count()
            ok(f"[{nome}] lembretes de amanhã ({amanha_tem} horário(s))", amanha_tem > 0 or "Nenhum horário" in corpo)
            if amanha_tem:
                href = await page.get_attribute("#dlgCorpo [data-enviar]", "href")
                ok(f"[{nome}] lembrete com mensagem pronta e link para cancelar", "Lembrete" in urllib.parse.unquote(href) and "index.html" in urllib.parse.unquote(href))
            await page.click("#dlgRodape .btn")

            # ── regra de faltas: 1 falta bloqueia (configurado no painel) ──
            await page.click("[data-secao=equipe]"); await page.wait_for_selector("#cFaltas")
            await page.fill("#cFaltas", "1"); await page.click("[data-salvar-config]"); await page.wait_for_timeout(800)
            site = await ctx.new_page(); site.on("pageerror", lambda e: erros.append(str(e)))
            await site.goto(U.URL); await site.evaluate("sessionStorage.clear()"); await site.reload(); await site.wait_for_selector("#painel .item")
            await U.escolher_horario(site, ["corte"], prof="danillo", slot_idx=4)
            dia_falta = site.dia_reservado
            await site.wait_for_selector("text=Tudo certo?"); await site.click("#btnAvancar"); await site.wait_for_selector(".codigo-reserva")
            await page.click("[data-secao=agenda]"); await page.wait_for_selector("#linhaTempo")
            await page.fill("#dataInput", dia_falta); await page.dispatch_event("#dataInput", "change"); await page.wait_for_timeout(700)
            await page.click("#abas [data-prof='danillo']"); await page.wait_for_timeout(700)
            await page.locator("#linhaTempo [data-status='nao_compareceu']").first.click(); await page.wait_for_timeout(800)
            await site.click("[data-acao='novo']")
            await U.escolher_horario(site, ["corte"], prof="danillo", slot_idx=6)
            await site.wait_for_selector("text=Tudo certo?"); await site.click("#btnAvancar")
            await site.wait_for_selector("#dlgTitulo:has-text('Fale com a barbearia')", timeout=8000)
            ok(f"[{nome}] cliente com falta é mandado para o WhatsApp", await site.locator("#dlgRodape a[href*='wa.me']").count() == 1)
            await site.screenshot(path=f"{OUT}/admin_{nome}_faltas_site.png")
            await site.keyboard.press("Escape")
            await page.click("[data-secao=clientes]"); await page.wait_for_selector("#listaClientes .ass")
            ok(f"[{nome}] lista marca o cliente bloqueado", "bloqueado por faltas" in (await page.inner_text("#listaClientes")).lower())
            await page.click("[data-ficha-cliente]"); await page.wait_for_selector("#dlgCorpo [data-zerar]")
            await page.click("#dlgCorpo [data-zerar]"); await page.wait_for_timeout(900)
            ok(f"[{nome}] liberar tira o bloqueio da ficha", await page.locator("#dlgCorpo [data-zerar]").count() == 0)
            await page.click("#dlg [data-fechar]")
            await site.click("#btnAvancar"); await site.wait_for_selector(".codigo-reserva", timeout=8000)
            ok(f"[{nome}] depois de liberado, marca pelo site", True)
            await site.close()

            # recepção: agenda, clientes e assinantes
            await page.click("#sair"); await page.click("[data-demo='recepcao']"); await page.wait_for_selector("#secoes button")
            abas = await page.locator("#secoes button").all_inner_texts()
            ok(f"[{nome}] recepção vê Agenda, Clientes e Assinantes", [a.lower() for a in abas] == ["agenda", "clientes", "assinantes"])

            # barbeiro: só a própria agenda
            await page.click("#sair"); await page.wait_for_selector("[data-demo='andre']")
            await page.click("[data-demo='andre']"); await page.wait_for_selector("#linhaTempo")
            ok(f"[{nome}] barbeiro sem abas de gestão", await page.is_hidden("#secoes"))
            ok(f"[{nome}] barbeiro não vê abas de outros", await page.locator("#abas").count() == 0)
            await page.fill("#dataInput", dia); await page.dispatch_event("#dataInput", "change"); await page.wait_for_timeout(600)
            await page.check("#verCancelados")
            ok(f"[{nome}] barbeiro vê só os seus horários", "Corte + Barba" not in await page.inner_text("#linhaTempo"))
            await page.screenshot(path=f"{OUT}/admin_{nome}_barbeiro.png", full_page=True)
            ok(f"[{nome}] sem erros de JavaScript {erros}", not erros)
            await ctx.close()
        await b.close()
    print("\nPAINEL:", "TODOS PASSARAM" if not falhas else f"{len(falhas)} FALHAS")
    sys.exit(1 if falhas else 0)

asyncio.run(run())
