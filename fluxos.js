const blingApi = require('./blingApi');
const mlApi = require('./mlApi');

// IDs de situação
const SITUACAO_ATENDIDO = 9;
const SITUACAO_AGUARDANDO = parseInt(process.env.SITUACAO_AGUARDANDO || '7259');

// IDs das lojas ML no Bling (separados por vírgula)
const ME_LOJA_IDS = (process.env.ME_LOJA_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)
  .map(Number);

const MAX_PEDIDOS_F1 = parseInt(process.env.MAX_PEDIDOS_F1 || '500');
const MAX_PEDIDOS_F2 = parseInt(process.env.MAX_PEDIDOS_F2 || '500');
const JANELA_DIAS = parseInt(process.env.JANELA_ULTIMOS_DIAS || '15');

// Memória de pedidos já movidos hoje (evita reprocessamento e loop)
// Estrutura: Set de blingId (number)
const memoriaMovidos = new Set();

// Reseta memória à meia-noite (controlado externamente via /run/virada)
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
  } catch {
    return false;
  }
}

function temRastreioNoBling(detalhe) {
  try {
    const rastreio = detalhe?.transporte?.codigoRastreamento || '';
    return rastreio.trim().length > 0;
  } catch {
    return false;
  }
}

function extrairNumeroLoja(detalhe) {
  // numeroLoja é o shipment ID do ML
  return detalhe?.numeroloja || detalhe?.numeroLoja || null;
}

/**
 * F1: ATENDIDO → AGUARDANDO
 * Pedidos ML sem etiqueta disponível são movidos para tirar da tela dos estoquistas.
 */
async function executarF1() {
  console.log('\n========== F1: ATENDIDO → AGUARDANDO ==========');
  const inicio = Date.now();
  let movidos = 0;
  let ignorados = 0;
  let erros = 0;

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

    if (memoriaMovidos.has(blingId)) {
      ignorados++;
      continue;
    }

    let detalhe;
    try {
      detalhe = await blingApi.buscarDetalhePedido(blingId);
    } catch (e) {
      console.error(`[F1] Erro ao buscar detalhe do pedido ${blingId}:`, e.message);
      erros++;
      continue;
    }

    if (!detalhe) {
      console.warn(`[F1] Detalhe nulo para pedido ${blingId}, pulando.`);
      erros++;
      continue;
    }

    // FLEX → nunca mover para AGUARDANDO
    if (ehFlex(detalhe)) {
      console.log(`[F1] Pedido ${blingId} é FLEX — ignorando.`);
      ignorados++;
      continue;
    }

    // Tem rastreio no Bling → etiqueta já disponível → não mover
    if (temRastreioNoBling(detalhe)) {
      console.log(`[F1] Pedido ${blingId} tem rastreio no Bling — ignorando.`);
      ignorados++;
      continue;
    }

    // Sem rastreio → consultar ML
    const shipmentId = extrairNumeroLoja(detalhe);
    if (!shipmentId) {
      console.warn(`[F1] Pedido ${blingId} sem numeroLoja/shipmentId — ignorando.`);
      ignorados++;
      continue;
    }

    const substatus = await mlApi.consultarSubstatusShipment(shipmentId);

    if (substatus === 'buffered') {
      // Sem etiqueta → mover para AGUARDANDO
      try {
        await blingApi.alterarSituacaoPedido(blingId, SITUACAO_AGUARDANDO);
        memoriaMovidos.add(blingId);
        movidos++;
        console.log(`[F1] ✅ Pedido ${blingId} (shipment ${shipmentId}) movido para AGUARDANDO.`);
      } catch (e) {
        console.error(`[F1] Erro ao mover pedido ${blingId}:`, e.message);
        erros++;
      }
    } else {
      console.log(`[F1] Pedido ${blingId} substatus="${substatus}" — tem etiqueta, ignorando.`);
      ignorados++;
    }
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`[F1] Concluído em ${duracao}s — Movidos: ${movidos} | Ignorados: ${ignorados} | Erros: ${erros}`);
}

/**
 * F2: AGUARDANDO → ATENDIDO
 * Pedidos ML com etiqueta disponível (ou FLEX) são devolvidos para os estoquistas.
 */
async function executarF2() {
  console.log('\n========== F2: AGUARDANDO → ATENDIDO ==========');
  const inicio = Date.now();
  let movidos = 0;
  let ignorados = 0;
  let erros = 0;

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
      erros++;
      continue;
    }

    if (!detalhe) {
      console.warn(`[F2] Detalhe nulo para pedido ${blingId}, pulando.`);
      erros++;
      continue;
    }

    // FLEX → sempre mover para ATENDIDO
    if (ehFlex(detalhe)) {
      try {
        await blingApi.alterarSituacaoPedido(blingId, SITUACAO_ATENDIDO);
        movidos++;
        console.log(`[F2] ✅ Pedido FLEX ${blingId} movido para ATENDIDO.`);
      } catch (e) {
        console.error(`[F2] Erro ao mover pedido FLEX ${blingId}:`, e.message);
        erros++;
      }
      continue;
    }

    // Tem rastreio no Bling → etiqueta disponível → mover
    if (temRastreioNoBling(detalhe)) {
      try {
        await blingApi.alterarSituacaoPedido(blingId, SITUACAO_ATENDIDO);
        movidos++;
        console.log(`[F2] ✅ Pedido ${blingId} tem rastreio — movido para ATENDIDO.`);
      } catch (e) {
        console.error(`[F2] Erro ao mover pedido ${blingId}:`, e.message);
        erros++;
      }
      continue;
    }

    // Sem rastreio → consultar ML
    const shipmentId = extrairNumeroLoja(detalhe);
    if (!shipmentId) {
      console.warn(`[F2] Pedido ${blingId} sem numeroLoja/shipmentId — ignorando.`);
      ignorados++;
      continue;
    }

    const substatus = await mlApi.consultarSubstatusShipment(shipmentId);

    if (substatus !== null && substatus !== 'buffered') {
      // Etiqueta disponível → mover para ATENDIDO
      try {
        await blingApi.alterarSituacaoPedido(blingId, SITUACAO_ATENDIDO);
        movidos++;
        console.log(`[F2] ✅ Pedido ${blingId} substatus="${substatus}" — movido para ATENDIDO.`);
      } catch (e) {
        console.error(`[F2] Erro ao mover pedido ${blingId}:`, e.message);
        erros++;
      }
    } else if (substatus === 'buffered') {
      console.log(`[F2] Pedido ${blingId} ainda buffered — mantém em AGUARDANDO.`);
      ignorados++;
    } else {
      console.warn(`[F2] Pedido ${blingId} substatus nulo (erro ML) — ignorando.`);
      ignorados++;
    }
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`[F2] Concluído em ${duracao}s — Movidos: ${movidos} | Ignorados: ${ignorados} | Erros: ${erros}`);
}

module.exports = { executarF1, executarF2, limparMemoria };
