# assets/demo — faixa(s) de demonstração semeada(s)

Os `.mp3` desta pasta são copiados para a biblioteca **no primeiro run** (ver
`seedDemoLibrary()` em `main.js`), para que um usuário novo veja o app já populado
e tocando — **sem rede, sem yt-dlp e sem chave de IA**. É o "primeiro uau" offline.

## Como colocar a faixa
Deixe o `.mp3` aqui, já **enriquecido** (capa embutida + tags + letra sincronizada).
A forma mais fácil de enriquecer é pelo próprio app: importe/baixe a faixa, deixe o
app taguear, sincronize a letra no editor e copie o `.mp3` resultante para esta pasta.

## Contrato do auto-imersivo
Ao clicar na faixa, o app abre direto no modo imersivo + karaokê quando ela tem
**artista `Syntune` e álbum `Demo`** (ver `isDemoTrack()` em `renderer/renderer.js`).
Garanta essas duas tags na faixa demo.

## Regras
- Use faixa **Creative Commons** ou própria — **NÃO** colocar conteúdo com copyright
  (vai dentro do instalador). Se a licença for CC-BY, cite autor/licença no campo
  `comment` da faixa.
- Para o karaokê funcionar, a letra precisa estar **sincronizada** (formato LRC,
  `[mm:ss.xx]`) no campo de letra do MP3.
- Pode haver mais de 1 `.mp3`; todos são semeados.
- Pasta vazia = seeding vira no-op (o app só marca `demoSeeded` e segue).
