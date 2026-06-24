// Stub mínimo de window.api p/ os testes de componentes CONECTADOS que importam o
// app-root/core-store — estes instanciam ApiService no eval do módulo (que exige
// window.api do preload, ausente no browser de teste). DEVE ser importado ANTES deles:
// o ESM avalia imports estáticos em ordem, então este precede a cadeia que toca o core-store.
// Nenhum método é exercido nos specs que dependem disto.
if (typeof window !== 'undefined' && !window.api) window.api = {};
