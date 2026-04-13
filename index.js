const http = require('http');
const url = require('url');
const cron = require('node-cron');
const { executarF1, executarF2, limparMemoria } = require('./fluxos');
const tokenManager = require('./tokenManager');
const { trocarCodigoPorToken, gerarUrlAutorizacao } = require('./mlTokenManager');

const PORT = process.env.PORT || 3000;

let f1Rodando = false;
let f2Rodando = false;

async function rodarF1(origem = 'cron') {
  if (f1Rodando) { console.log(`[index] F1 já em execução (origem: ${origem}) — pulando.`); return; }
  f1Rodando = true;
  try { await executarF1(); } catch (e) { console.error('[index] Erro não tratado em F1:', e.message); }
  finally { f1Rodando = false; }
}

async function rodarF2(origem = 'cron') {
  if (f2Rodando) { console.log(`[index] F2 já em execução (origem: ${origem}) — pulando.`); return; }
  f2Rodando = true;
  try { await executarF2(); } catch (e) { console.error('[index] Erro não tratado em F2:', e.message); }
  finally { f2Rodando = false; }
}

// F1: a cada 3 minutos entre 06:00 e 23:59
cron.schedule('*/3 6-23 * * *', () => {
  console.log('[cron] Disparando F1 (3min)...');
  rodarF1('cron-3min');
}, { timezone: 'America/Sao_Paulo' });

// F2: 00:10 — limpa memória + F2
cron.schedule('10 0 * * *', () => {
  console.log('[cron] 00:10 — Limpando memória e rodando F2...');
  limparMemoria();
  rodarF2('cron-00:10');
}, { timezone: 'America/Sao_Paulo' });

// F2: 06:00, 06:30, 07:00
cron.schedule('0 6 * * *',  () => { console.log('[cron] 06:00 — F2...'); rodarF2('cron-06:00'); }, { timezone: 'America/Sao_Paulo' });
cron.schedule('30 6 * * *', () => { console.log('[cron] 06:30 — F2...'); rodarF2('cron-06:30'); }, { timezone: 'America/Sao_Paulo' });
cron.schedule('0 7 * * *',  () => { console.log('[cron] 07:00 — F2...'); rodarF2('cron-07:00'); }, { timezone: 'America/Sao_Paulo' });

// F2: a cada 15min das 06h às 23h
cron.schedule('*/15 6-23 * * *', () => {
  console.log('[cron] F2 diurno (15min)...');
  rodarF2('cron-15min');
}, { timezone: 'America/Sao_Paulo' });

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  const json = (statusCode, obj) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (method === 'GET' && pathname === '/health') {
      return json(200, { status: 'ok', timestamp: new Date().toISOString(), f1Rodando, f2Rodando, timezone: process.env.TZ || 'não definido' });
    }

    if (method === 'GET' && pathname === '/callback') {
      const code = parsedUrl.query.code;
      if (!code) return json(400, { erro: 'Parâmetro "code" não encontrado.' });
      await tokenManager.exchangeCodeForToken(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<h2>✅ Token Bling obtido com sucesso! Pode fechar esta janela.</h2>');
    }

    if (method === 'GET' && pathname === '/callback-ml') {
      const code = parsedUrl.query.code;
      if (!code) return json(400, { erro: 'Parâmetro "code" não encontrado.' });
      await trocarCodigoPorToken(code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<h2>✅ Token ML obtido com sucesso! Pode fechar esta janela.</h2>');
    }

    if (method === 'POST' && pathname === '/setup') {
      const clientId = process.env.BLING_CLIENT_ID;
      const redirectUri = process.env.BLING_REDIRECT_URI;
      const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=good`;
      return json(200, { mensagem: 'Abra a URL abaixo no navegador para autorizar. O código expira em ~60 segundos!', url: authUrl });
    }

    if (method === 'POST' && pathname === '/setup-ml') {
      const authUrl = gerarUrlAutorizacao();
      return json(200, { mensagem: 'Abra a URL abaixo no navegador para autorizar o ML.', url: authUrl });
    }

    if (method === 'POST' && pathname === '/run/expedicao') {
      if (f1Rodando) return json(409, { mensagem: 'F1 já está em execução.' });
      rodarF1('manual');
      return json(202, { mensagem: 'F1 iniciado. Acompanhe os logs.' });
    }

    if (method === 'POST' && pathname === '/run/virada') {
      limparMemoria();
      if (f2Rodando) return json(409, { mensagem: 'Memória limpa. F2 já está em execução.' });
      rodarF2('manual-virada');
      return json(202, { mensagem: 'Memória limpa e F2 iniciado. Acompanhe os logs.' });
    }

    if (method === 'POST' && pathname === '/run/manha') {
      if (f2Rodando) return json(409, { mensagem: 'F2 já está em execução.' });
      rodarF2('manual-manha');
      return json(202, { mensagem: 'F2 iniciado. Acompanhe os logs.' });
    }

    if (method === 'GET' && pathname.startsWith('/buscar-pedido/')) {
      const idPedido = pathname.split('/').pop();
      try {
        const detalhe = await blingApi.buscarDetalhePedido(idPedido);
        return json(200, detalhe);
      } catch (e) { return json(500, { erro: e.message }); }
    }

    return json(404, { erro: `Rota não encontrada: ${method} ${pathname}` });

  } catch (e) {
    console.error('[index] Erro no servidor HTTP:', e.message);
    return json(500, { erro: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🌻 Girassol - Mover Pedidos iniciado na porta ${PORT}`);
  console.log(`   Situação AGUARDANDO: ${process.env.SITUACAO_AGUARDANDO || '745122'}`);
  console.log(`   Lojas ML: ${process.env.ME_LOJA_IDS || '(não definido)'}`);
  console.log(`   Janela: ${process.env.JANELA_ULTIMOS_DIAS || '15'} dias`);
  console.log(`   Timezone: ${process.env.TZ || 'não definido'}`);
  console.log('   Crons: F1 a cada 3min (06-23h) | F2 a cada 15min + 00:10, 06:00, 06:30, 07:00\n');
});
