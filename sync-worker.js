/**
 * @module  sync-worker
 * @badge   🟨 DEVICE · WORKER-THREAD · IPC(parentPort)
 * @role    Host worker_threads: recebe { id, type, params }, executa scan/sync (I/O pesado) via sync-engine fora da thread principal e devolve progresso/resultado.
 * @inputs  mensagens do processo principal (parentPort)
 * @outputs mensagens de progresso e resultado
 * @deps    worker_threads, ./sync-engine
 */
// ====================================================================
// Worker thread de sincronização. Recebe tarefas { id, type, params }
// do processo principal, executa scan/sync (operações de I/O pesadas)
// fora da thread principal e devolve progresso e resultado por mensagem.
// ====================================================================
const { parentPort } = require('worker_threads');
const engine = require('./sync-engine');

parentPort.on('message', async (task) => {
  const { id, type, params } = task || {};
  const onProgress = (payload) => {
    parentPort.postMessage({ id, type: 'progress', payload: payload || {} });
  };
  try {
    let result;
    if (type === 'scan') result = await engine.scan(params, onProgress);
    else if (type === 'sync') result = await engine.sync(params, onProgress);
    else if (type === 'playlist') result = await engine.syncPlaylist(params, onProgress);
    else throw new Error('Tarefa de sincronização desconhecida: ' + type);
    parentPort.postMessage({ id, type: 'result', result });
  } catch (err) {
    parentPort.postMessage({ id, type: 'error', error: (err && err.message) ? err.message : String(err) });
  }
});
