const blingApi = require('./blingApi');
const mlApi = require('./mlApi');
const mlTokenManager = require('./mlTokenManager');

const SITUACAO_ATENDIDO = 9;
const SITUACAO_AGUARDANDO = parseInt(process.env.SITUACAO_AGUARDANDO || '7259');

const ME_LOJA_IDS = (process.env.ME_LOJA_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)
  .map(Number);

const MAX_PEDIDOS_F1 = parseInt(process.env.MAX_PEDIDOS_F1 || '500');
const MAX_PEDIDOS_F2 = parseInt(process.env.MAX_PEDIDOS_F2 || '500');
const JANELA_DIAS = parseInt(process.env.JANELA_ULTIMOS_DIAS || '15');

const memoriaMovidos = new Set();

function limparMemoria() {
  const antes = memoriaMovidos.size;
  memoriaMovidos.clear();
  console.log(`[fluxos] Memória limpa. Havia ${antes} pedidos registrados.`);
}

function ehLojaML(pedido) {
  const lojaId = pedido?.loja?.id;
  if (!lojaId) return false;
  return ME_LOJA_IDS.includes(Number(lojaId));
}

function ehFlex(detalhe) {
  try {
    const servico = detalhe?.transporte?.volumes?.[0]?.servico || '';
    return servico.toUpperCase().includes('FLEX');
  } catch { return false; }
}

function temRastreioNoBling(detalhe) {
  try {
    const rastreio = detalhe?.transporte?.codigoRastreamento || '';
    return rastreio.trim().length > 0;
  } catch { return false; }
}

function extrairNumeroLoja(detalhe) {
  return detalhe?.numeroloja || detalhe?.numeroLoja || null;
}

async function executarF1() {
  console.log('\n========== F1: ATENDIDO → AGUARDANDO ==========');
  const inicio = Date.now();
  let movidos = 0, ignorados = 0, erros = 0;

  let mlToken = null;
  try { mlToken = await mlTokenManager.getAccessToken(); } catch (e) {
    console.warn('[F1] Sem token ML:', e.message);
  }

  let pedidos;
  try {
    pedidos = await blingApi.buscarPedidosPorSituacao(SITUACAO_ATENDIDO, JANELA_DIAS, MAX_PEDIDOS_F1);
  } catch (e) {
    console.error('[F1] Erro ao buscar pedidos ATENDIDO:', e.message);
    return;
  }

  console.log(`[F1] Total pedidos em ATENDIDO: ${pedidos.length}`);
  const pedidosML = pedidos.filter(ehLojaML);
  console.log(`[F1] Pedidos ML filtrados: ${pedidosML.length}`);

  for (const pedido of pedidosML) {
    const blingId = pedido.id;

    if (memoriaMovidos.has(blingId)) { ignorados++; continue; }

    let detalhe;
    try {
      detalhe = await blingApi.buscarDetalhePedido(blingId);
    } catch (e) {
      console.error(`[F1] Erro ao buscar detalhe do pedido ${blingId}:`, e.message);
      erros++; continue;
    }

    if (!detalhe) { erros++; continue; }
    // Só mover se realmente está em AGUARDANDO
    if (detalhe?.situacao?.id !== SITUACAO_AGUARDANDO) {
      ignorados++; continue;
    }

    if (ehFlex(detalhe)) {
      console.log(`[F1] Pedido ${blingId} é FLEX — ignorando.`);
      ignorados++; continue;
    }

    if (temRastreioNoBling(detalhe)) {
      console.log(`[F1] Pedido ${blingId} tem rastreio no Bling — ignorando.`);
      ignorados++; continue;
    }

    const numeroLoja = extrairNumeroLoja(detalhe);
    if (!numeroLoja) {
      console.warn(`[F1] Pedido ${blingId} sem numeroLoja — ignorando.`);
      ignorados++; continue;
    }

    if (!mlToken) {
      console.warn(`[F1] Sem token ML, movendo ${blingId} para AGUARDANDO por precaução.`);
    } else {
      const substatus = await mlApi.consultarSubstatusShipment(mlToken, numeroLoja);
      if (substatus !== 'buffered') {
        console.log(`[F1] Pedido ${blingId} substatus="${substatus}" — tem etiqueta, ignorando.`);
        ignorados++; continue;
      }
    }

    try {
      await blingApi.alterarSituacaoPedido(blingId, SITUACAO_AGUARDANDO);
      memoriaMovidos.add(blingId);
      movidos++;
      console.log(`[F1] ✅ Pedido ${blingId} movido para AGUARDANDO.`);
    } catch (e) {
      console.error(`[F1] Erro ao mover pedido ${blingId}:`, e.message);
      erros++;
    }
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`[F1] Concluído em ${duracao}s — Movidos: ${movidos} | Ignorados: ${ignorados} | Erros: ${erros}`);
}

async function executarF2() {
  console.log('\n========== F2: AGUARDANDO → ATENDIDO ==========');
  const inicio = Date.now();
  let movidos = 0, ignorados = 0, erros = 0;

  let mlToken = null;
  try { mlToken = await mlTokenManager.getAccessToken(); } catch (e) {
    console.warn('[F2] Sem token ML:', e.message);
  }

  let pedidos;
  try {
    pedidos = await blingApi.buscarPedidosPorSituacao(SITUACAO_AGUARDANDO, JANELA_DIAS, MAX_PEDIDOS_F2);
  } catch (e) {
    console.error('[F2] Erro ao buscar pedidos AGUARDANDO:', e.message);
    return;
  }

  console.log(`[F2] Total pedidos em AGUARDANDO: ${pedidos.length}`);
  const pedidosML = pedidos.filter(ehLojaML);
  console.log(`[F2] Pedidos ML filtrados: ${pedidosML.length}`);

  for (const pedido of pedidosML) {
    const blingId = pedido.id;

    let detalhe;
    try {
      detalhe = await blingApi.buscarDetalhePedido(blingId);
    } catch (e) {
      console.error(`[F2] Erro ao buscar detalhe do pedido ${blingId}:`, e.message);
      erros++; continue;
    }

    if (!detalhe) { erros++; continue; }

    if (ehFlex(detalhe)) {
      try {
        await blingApi.alterarSituacaoPedido(blingId, SITUACAO_ATENDIDO);
        movidos++;
        console.log(`[F2] ✅ Pedido FLEX ${blingId} movido para ATENDIDO.`);
      } catch (e) { erros++; }
      continue;
    }

    if (temRastreioNoBling(detalhe)) {
      try {
        await blingApi.alterarSituacaoPedido(blingId, SITUACAO_ATENDIDO);
        movidos++;
        console.log(`[F2] ✅ Pedido ${blingId} tem rastreio — movido para ATENDIDO.`);
      } catch (e) { erros++; }
      continue;
    }

    const numeroLoja = extrairNumeroLoja(detalhe);
    if (!numeroLoja || !mlToken) { ignorados++; continue; }

    const substatus = await mlApi.consultarSubstatusShipment(mlToken, numeroLoja);
    if (substatus !== null && substatus !== 'buffered') {
      try {
        await blingApi.alterarSituacaoPedido(blingId, SITUACAO_ATENDIDO);
        movidos++;
        console.log(`[F2] ✅ Pedido ${blingId} substatus="${substatus}" — movido para ATENDIDO.`);
      } catch (e) { erros++; }
    } else {
      ignorados++;
    }
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`[F2] Concluído em ${duracao}s — Movidos: ${movidos} | Ignorados: ${ignorados} | Erros: ${erros}`);
}

module.exports = { executarF1, executarF2, limparMemoria };
