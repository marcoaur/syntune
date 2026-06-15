// Fontes factuais: consolidação/ranking (src/services/metadata-sources.js).
// Só lógica pura — sem rede (mbFetch/itunesLookup não são exercitados).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fuzzyMatch, normName, parseArtistTitle, consolidateFacts, factsBlock, mbToMatches
} from '../src/services/metadata-sources.js';

test('normName: sem acentos/pontuação, espaços simples', () => {
  assert.equal(normName('Áéí, Test!'), 'aei test');
});

test('fuzzyMatch: igual ou contido (ignora acento)', () => {
  assert.equal(fuzzyMatch('The Beatles', 'beatles'), true);
  assert.equal(fuzzyMatch('Açaí', 'acai'), true);
  assert.equal(fuzzyMatch('abc', 'xyz'), false);
});

test('parseArtistTitle: separa "Artista - Título" e limpa parênteses', () => {
  assert.deepEqual(parseArtistTitle('Band - Song (Official Video)'),
    { artist: 'Band', title: 'Song' });
  assert.deepEqual(parseArtistTitle('Só Um Título'),
    { artist: '', title: 'Só Um Título' });
});

test('consolidateFacts: ano = mais antigo entre fontes confiáveis; gênero do iTunes', () => {
  const c = consolidateFacts({
    musicbrainz: { confident: true, artist: 'Band', title: 'Song', album: 'A', year: '1975', trackNumber: '3', releaseMbid: 'mb1' },
    itunes: { confident: true, artist: 'Band', title: 'Song', album: 'A2', year: '1990', genre: 'Rock', artworkUrl: 'u' },
    sources: ['MusicBrainz', 'iTunes']
  });
  assert.equal(c.year, '1975');
  assert.equal(c.genre, 'Rock');
  assert.equal(c.confident, true);
  assert.equal(c.album, 'A'); // álbum prefere MusicBrainz confiável
});

test('consolidateFacts: nenhuma fonte confiável → confident false', () => {
  const c = consolidateFacts({ itunes: { confident: false, artist: 'X', title: 'Y', year: '2001' }, sources: ['iTunes'] });
  assert.equal(c.confident, false);
  assert.equal(c.year, '2001');
});

test('factsBlock: vazio → aviso; populado → contém confiança ALTA', () => {
  assert.match(factsBlock(null), /nenhum dado factual/);
  assert.match(factsBlock({ artist: 'A', title: 'B', confident: true, sources: ['MusicBrainz'] }), /Confiança do match: ALTA/);
});

test('mbToMatches: vazio → []; ranqueia estúdio/oficial e extrai faixa', () => {
  assert.deepEqual(mbToMatches({ recordings: [] }), []);
  const m = mbToMatches({
    recordings: [{
      id: 'r1', title: 'Song', score: 90, 'artist-credit': [{ name: 'Band' }],
      releases: [{
        title: 'Album', date: '1980-05-01', status: 'Official',
        'release-group': { 'primary-type': 'Album', 'secondary-types': [] },
        media: [{ 'track-count': 10, track: [{ number: '3' }] }]
      }]
    }]
  });
  assert.equal(m.length, 1);
  assert.equal(m[0].title, 'Song');
  assert.equal(m[0].artist, 'Band');
  assert.equal(m[0].album, 'Album');
  assert.equal(m[0].year, '1980');
  assert.equal(m[0].trackNumber, '3');
  assert.equal(m[0].totalTracks, '10');
});
