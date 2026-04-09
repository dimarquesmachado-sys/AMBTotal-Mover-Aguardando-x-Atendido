const fetch = require('node-fetch');
const tokenManager = require('./tokenManager');

const BASE_URL = 'https://api.bling.com.br/Api/v3';
const PAUSA_MS = parseInt(process.env.PAUSA_MS || '700');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function blingGet(path, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const token = await tokenManager.getAccessToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.status === 429) {
      const wait = attempt * 2000;
      console.warn(`[blingApi] Rate limit 429 em GET ${path}. Aguardando ${wait}ms...`);
      await sleep(wait);
      continue;
    }

    if (res.status === 401 && attempt < retries) {
      console.warn('[blingApi] 401 em GET, tentando renovar token...');
      // força renovação na próxima chamada de getAccessToken
      await sleep(1000);
      continue;
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Bling GET ${path} falhou: ${res.status} ${txt}`);
    }

    return res.json();
  }
  throw new Error(`Bling GET ${path} falhou após ${retries} tentativas.`);
}

async function blingPatch(path, body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const token = await tokenManager.getAccessToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (res.status === 429) {
      const wait = attempt * 2000;
      console.warn(`[blingApi] Rate limit 429 em PATCH ${path}. Aguardando ${wait}ms...`);
      await sleep(wait);
      continue;
    }

    if (res.status === 401 && attempt < retries) {
      console.warn('[blingApi] 401 em PATCH, tentando renovar token...');
      await sleep(1000);
      continue;
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Bling PATCH ${path} falhou: ${res.status} ${txt}`);
    }

    // PATCH pode retornar 204 sem corpo
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  }
  throw new Error(`Bling PATCH ${path} falhou após ${retries} tentativas.`);
}

/**
 * Busca pedidos por situação com paginação.
 * @param {number} situacaoId - ID da situação no Bling
 * @param {number} janelaDias - quantos dias para trás buscar
 * @param {number} max - limite máximo de pedidos
 */
async function buscarPedidosPorSituacao(situacaoId, janelaDias, max) {
  const dataInicio = new Date();
  dataInicio.setDate(dataInicio.getDate() - janelaDias);
  const dataStr = dataInicio.toISOString().split('T')[0];

  let pagina = 1;
  let todos = [];

  while (todos.length < max) {
    const url = `/pedidos/vendas?situacao=${situacaoId}&dataInicial=${dataStr}&pagina=${pagina}&limite=100`;
    await sleep(300);
    const data = await blingGet(url);

    const items = data?.data || [];
    if (items.length === 0) break;

    todos = todos.concat(items);
    if (items.length < 100) break;
    pagina++;
  }

  return todos.slice(0, max);
}

/**
 * Busca o detalhe completo de um pedido (inclui transporte, volumes, etc.)
 */
async function buscarDetalhePedido(pedidoId) {
  await sleep(300);
  const data = await blingGet(`/pedidos/vendas/${pedidoId}`);
  return data?.data || null;
}

/**
 * Altera a situação de um pedido.
 */
async function alterarSituacaoPedido(pedidoId, situacaoId) {
  await sleep(PAUSA_MS);
  return await blingPatch(`/pedidos/vendas/${pedidoId}/situacoes/${situacaoId}`, {});
}

module.exports = {
  buscarPedidosPorSituacao,
  buscarDetalhePedido,
  alterarSituacaoPedido
};
