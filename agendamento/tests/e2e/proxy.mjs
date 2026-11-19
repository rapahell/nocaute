// Simula o roteamento do Supabase num só endereço local:
//   /rest/v1/*            -> PostgREST
//   /functions/v1/<nome>  -> Edge Function <nome> rodando no Deno
// Uso: node proxy.mjs <porta> <porta_postgrest> nome=porta[,nome=porta...]
import http from 'node:http';
const [porta, pgrst, mapa] = process.argv.slice(2);
const funcoes = Object.fromEntries((mapa || '').split(',').filter(Boolean).map(x => x.split('=')).map(([n, p]) => [n, Number(p)]));

http.createServer((req, res) => {
  let destino, caminho;
  if (req.url.startsWith('/rest/v1/')) { destino = Number(pgrst); caminho = req.url.slice('/rest/v1'.length); }
  else if (req.url.startsWith('/functions/v1/')) {
    const [nome, ...resto] = req.url.slice('/functions/v1/'.length).split('/');
    const [base, q] = nome.split('?');
    destino = funcoes[base]; caminho = '/' + resto.join('/') + (q ? '?' + q : '');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
    return res.end();
  }
  if (!destino) { res.writeHead(404); return res.end('{}'); }
  const p = http.request({ host: '127.0.0.1', port: destino, path: caminho, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode, Object.assign({}, r.headers, { 'access-control-allow-origin': '*' }));
    r.pipe(res);
  });
  p.on('error', e => { res.writeHead(502); res.end(String(e)); });
  req.pipe(p);
}).listen(Number(porta), '127.0.0.1');
