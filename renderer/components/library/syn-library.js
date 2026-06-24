// <syn-library> — VIEW inteligente (ARCHITECTURE-V2) da tela principal: lista de faixas,
// busca expansível, agrupamento por gênero (carrosséis de artista) e página do artista.
// Controller montado uma vez (<syn-library> vazio); OWNS por id o #songList, a busca
// (#searchBtn/#searchInput/#searchClose/#groupToggle) e a #artistPage — markup espalhado
// no layout principal, por isso controller-by-id (não wrapper).
//
// Estado central nos STORES (libraryStore.songs + devicesStore.deviceOnlySongs; playerStore.
// visibleList = base da fila). Cards de faixa = folha buildSongCard. Cards de JOB (downloads)
// vêm da ilha syn-add via pendingCards()/hasPending() (injetados). Efeitos cross-subsistema
// por INTENTS: syn:player:play-list (tocar), syn:player:mark-cards (re-marcar tocando).
// Injetados pelo renderer (glue/UI): t, tn, toast, closeView, getPalette, coverUrl,
// coverState, spawnPlayBurst, refreshToolbarStatus, pendingCards, hasPending.
import { normalizeText, normPart, artistInitials } from '../../modules/format.js';
import { ICONS } from '../../modules/icons.js';
import { libraryStore, devicesStore, playerStore } from '../../services/core-store.js';
import { buildSongCard } from '../song/build-song-card.js';

export class SynLibrary extends HTMLElement {
  constructor() {
    super();
    this.t = (k) => k;
    this.tn = (k) => k;
    this.toast = () => {};
    this.closeView = (el) => el.classList.add('hidden');
    this.getPalette = async () => null;
    this.coverUrl = () => '';
    this.coverState = new Map();
    this.spawnPlayBurst = () => {};
    this.refreshToolbarStatus = () => {};
    this.pendingCards = () => [];
    this.hasPending = () => false;
    // estado da view
    this.searchQuery = '';
    this.groupBy = false;
    this.collapsedArtists = new Set();
    this.listEntrance = true;
    this.artistPageSongs = [];
    this.artistImgCache = {};   // normArtist -> URL | null
    this.artistImgPending = {}; // normArtist -> Promise
    this._wired = false;
  }

  #g(id) { return document.getElementById(id); }
  #emit(name, detail) { document.dispatchEvent(new CustomEvent(name, { detail })); }
  #playList(songs) { this.#emit('syn:player:play-list', { songs }); }

  connectedCallback() {
    if (this._wired) return;
    this._wired = true;

    // busca expansível
    this.#g('searchBtn').addEventListener('click', () => this.#expandSearch());
    this.#g('searchInput').addEventListener('input', () => { this.searchQuery = this.#g('searchInput').value; this.listEntrance = true; this.refresh(); });
    this.#g('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.#clearAndCollapseSearch(); } });
    this.#g('searchInput').addEventListener('blur', () => { if (!this.#g('searchInput').value.trim()) this.collapseSearch(); });
    this.#g('searchClose').addEventListener('click', () => this.#clearAndCollapseSearch());
    this.#g('groupToggle').addEventListener('click', () => {
      this.groupBy = !this.groupBy;
      this.#g('groupToggle').classList.toggle('active', this.groupBy);
      try { localStorage.setItem('lib.groupBy', this.groupBy ? '1' : '0'); } catch { /* ok */ }
      this.listEntrance = true;
      this.refresh();
    });

    // página do artista
    this.#g('apBack').addEventListener('click', () => this.closeArtist());
    this.#g('apPlay').addEventListener('click', () => this.#playList(this.artistPageSongs));

    // restaura preferências de visualização
    try { this.groupBy = localStorage.getItem('lib.groupBy') === '1'; } catch { /* ok */ }
    try { const c = JSON.parse(localStorage.getItem('lib.collapsed') || '[]'); if (Array.isArray(c)) this.collapsedArtists = new Set(c); } catch { /* ok */ }
    this.#g('groupToggle').classList.toggle('active', this.groupBy);
  }

  // ---- helpers de dados ----
  #sort(list) {
    const k = (s, f) => (s[f] || '').toString().toLowerCase();
    return list.slice().sort((a, b) =>
      k(a, 'artist').localeCompare(k(b, 'artist'), this.t('meta.locale')) ||
      (a.year || '').localeCompare(b.year || '', this.t('meta.locale')) ||
      k(a, 'album').localeCompare(k(b, 'album'), this.t('meta.locale')) ||
      k(a, 'title').localeCompare(k(b, 'title'), this.t('meta.locale'))
    );
  }
  #matches(s, terms) {
    if (!terms.length) return true;
    const hay = normalizeText(`${s.title || ''} ${s.artist || ''} ${s.album || ''}`);
    return terms.every((t) => hay.includes(t));
  }
  #artistKeyOf(s) { return (s.artist || '').trim() || this.t('library.noArtist'); }

  // ---- render principal (acionador externo: refresh) ----
  refresh() {
    const list = this.#g('songList');
    list.innerHTML = '';
    list.classList.toggle('no-entrance', !this.listEntrance); // consome o "ticket" de animação
    this.listEntrance = false;

    // jobs em andamento (downloads) no topo — fornecidos pela ilha syn-add
    for (const c of this.pendingCards()) list.appendChild(c);

    // biblioteca + faixas só-do-dispositivo, filtradas pela busca
    const all = libraryStore.songs.concat(devicesStore.deviceOnlySongs);
    const terms = normalizeText(this.searchQuery).split(/\s+/).filter(Boolean);
    const filtered = terms.length ? all.filter((s) => this.#matches(s, terms)) : all;
    const sorted = this.#sort(filtered);
    playerStore.visibleList = sorted; // base da fila de reprodução (na ordem exibida)

    if (this.groupBy) this.#renderShelves(list, sorted);
    else {
      let i = 0;
      for (const s of sorted) {
        const card = buildSongCard(s);
        card.style.setProperty('--i', String(Math.min(i++, 24)));
        list.appendChild(card);
      }
    }

    const hasLib = all.length > 0;
    this.#g('searchBox').classList.toggle('hidden', !hasLib);
    this.#g('groupToggle').classList.toggle('hidden', !hasLib);
    const empty = !this.hasPending() && all.length === 0;
    const noResults = all.length > 0 && sorted.length === 0;
    this.#g('emptyState').classList.toggle('hidden', !empty);
    this.#g('noResults').classList.toggle('hidden', !noResults);

    this.refreshToolbarStatus();
    this.#emit('syn:player:mark-cards'); // remonta o viz no card que está tocando
  }

  // ---- foto do artista (Genius), lazy + cache + dedupe ----
  async #fillArtistAvatar(el, name) {
    const k = normPart(name);
    if (!k) return;
    const apply = (url) => { if (url) el.innerHTML = `<img src="${url}" alt="" />`; };
    if (this.artistImgCache[k] !== undefined) { apply(this.artistImgCache[k]); return; }
    if (!this.artistImgPending[k]) {
      this.artistImgPending[k] = window.api.artistImage({ name })
        .then((r) => { this.artistImgCache[k] = (r && (r.url || r.dataUrl)) || null; return this.artistImgCache[k]; })
        .catch(() => { this.artistImgCache[k] = null; return null; })
        .finally(() => { delete this.artistImgPending[k]; });
    }
    apply(await this.artistImgPending[k]);
  }
  /** Acionador externo (settings geniusChanged): invalida o cache de fotos de artista. */
  clearArtistCache() { this.artistImgCache = {}; this.artistImgPending = {}; }

  // ---- visão agrupada: carrosséis por gênero, cards de artista ----
  #renderShelves(list, sorted) {
    const OTHERS = this.t('library.others');
    const genres = new Map();
    for (const s of sorted) {
      const gk = (s.genre || '').trim() || OTHERS;
      let g = genres.get(gk);
      if (!g) { g = { display: gk, artists: new Map() }; genres.set(gk, g); }
      const ak = this.#artistKeyOf(s);
      let a = g.artists.get(ak);
      if (!a) { a = { display: s.artist || this.t('library.noArtist'), songs: [] }; g.artists.set(ak, a); }
      a.songs.push(s);
    }
    const shelves = [...genres.values()].sort((x, y) => {
      if (x.display === OTHERS) return 1;
      if (y.display === OTHERS) return -1;
      return y.artists.size - x.artists.size || x.display.localeCompare(y.display, this.t('meta.locale'));
    });

    let gi = 0;
    for (const g of shelves) {
      const shelf = document.createElement('div');
      shelf.className = 'genre-shelf';
      shelf.style.setProperty('--i', String(Math.min(gi++, 6)));

      const head = document.createElement('div');
      head.className = 'genre-head';
      const gTitle = document.createElement('div'); gTitle.className = 'genre-title'; gTitle.textContent = g.display;
      const c = document.createElement('div'); c.className = 'genre-count'; c.textContent = this.tn('count.artist', g.artists.size);
      head.append(gTitle, c);
      shelf.appendChild(head);

      const car = document.createElement('div');
      car.className = 'carousel';
      const artists = [...g.artists.values()].sort((a, b) => a.display.localeCompare(b.display, this.t('meta.locale')));
      let ai = 0;
      for (const a of artists) {
        const ac = this.#buildArtistCard(a);
        ac.style.setProperty('--i', String(Math.min(ai++, 12)));
        car.appendChild(ac);
      }
      car.addEventListener('wheel', (e) => { // roda vertical → rolagem horizontal
        if (!e.deltaY) return;
        const before = car.scrollLeft;
        car.scrollLeft += e.deltaY;
        if (car.scrollLeft !== before) e.preventDefault();
      }, { passive: false });

      shelf.appendChild(car);
      list.appendChild(shelf);
    }
  }

  #buildArtistCard(a) {
    const card = document.createElement('div');
    card.className = 'artist-card';
    const photo = document.createElement('div');
    photo.className = 'a-photo';
    const inner = document.createElement('div');
    inner.className = 'a-photo-inner';
    inner.textContent = artistInitials(a.display);
    const play = document.createElement('button');
    play.className = 'a-play';
    play.title = this.t('common.play');
    play.innerHTML = ICONS.play;
    play.addEventListener('click', (e) => { e.stopPropagation(); this.spawnPlayBurst(card); this.#playList(this.#sort(a.songs)); });
    photo.append(inner, play);
    this.#fillArtistAvatar(inner, a.display).then(async () => {
      const dataUrl = this.artistImgCache[normPart(a.display)];
      if (!dataUrl) return;
      const pal = await this.getPalette(dataUrl);
      if (pal) card.style.setProperty('--cv', `${pal.r}, ${pal.g}, ${pal.b}`);
    });

    const name = document.createElement('div');
    name.className = 'a-name';
    name.textContent = a.display;
    const sub = document.createElement('div');
    sub.className = 'a-sub';
    sub.textContent = this.tn('count.song', a.songs.length);

    card.append(photo, name, sub);
    card.addEventListener('click', () => this.#openArtist(a));
    return card;
  }

  // ---- página do artista ----
  #openArtist(a) {
    const sorted = this.#sort(a.songs);
    this.artistPageSongs = sorted;
    const $ = (id) => this.#g(id);
    $('apName').textContent = a.display;

    const albums = new Set(sorted.map((s) => normalizeText(s.album || '')).filter(Boolean));
    $('apStats').textContent = this.tn('count.song', sorted.length) + (albums.size ? ` · ${this.tn('count.album', albums.size)}` : '');

    const photo = $('apPhoto');
    photo.innerHTML = `<span class="ap-initials">${artistInitials(a.display)}</span>`;
    $('artistPage').style.setProperty('--cv', '124, 92, 255');

    this.#renderArtistTracks($('apTracks'), sorted);
    $('artistPage').classList.remove('hidden', 'closing');
    $('apTracks').parentElement.scrollTop = 0;

    $('apLastfmInfo').classList.add('hidden');
    $('apListeners').textContent = '—';
    $('apPlaycount').textContent = '—';
    $('apGlobalTags').innerHTML = '';
    $('apTagsCard').classList.add('hidden');
    $('apBio').innerHTML = '';
    $('apBioCard').classList.add('hidden');

    this.#fillArtistAvatar(photo, a.display).then(async () => {
      const dataUrl = this.artistImgCache[normPart(a.display)];
      if (dataUrl) { const pal = await this.getPalette(dataUrl); if (pal) $('artistPage').style.setProperty('--cv', `${pal.r}, ${pal.g}, ${pal.b}`); }
    });

    window.api.lastfmGetArtistInfo({ artist: a.display }).then((res) => {
      if (res && window.getComputedStyle($('artistPage')).display !== 'none' && $('apName').textContent === a.display) {
        $('apLastfmInfo').classList.remove('hidden', 'closing');
        $('apListeners').textContent = res.listeners ? parseInt(res.listeners).toLocaleString(this.t('meta.numberLocale')) : '—';
        $('apPlaycount').textContent = res.playcount ? parseInt(res.playcount).toLocaleString(this.t('meta.numberLocale')) : '—';
        if (res.tags && res.tags.length > 0) {
          res.tags.forEach((tag) => { const pill = document.createElement('span'); pill.className = 'ev-tag'; pill.textContent = tag; $('apGlobalTags').appendChild(pill); });
          $('apTagsCard').classList.remove('hidden', 'closing');
        }
        if (res.bio) {
          const bioHtml = res.bio.replace(/<a href="https:\/\/www\.last\.fm.*?>Read more on Last\.fm<\/a>/, '').trim();
          if (bioHtml.length > 10) {
            $('apBio').innerHTML = bioHtml;
            $('apBioCard').classList.remove('hidden', 'closing');
            $('apBio').onclick = () => $('apBio').classList.toggle('expanded');
          }
        }
      }
    });
  }
  closeArtist() { this.closeView(this.#g('artistPage')); }

  #renderArtistTracks(container, sortedSongs) {
    container.innerHTML = '';
    const albums = new Map();
    for (const s of sortedSongs) {
      const ak = normalizeText(s.album || '') || '__none__';
      let al = albums.get(ak);
      if (!al) { al = { display: s.album || this.t('library.noAlbum'), year: s.year || '', songs: [] }; albums.set(ak, al); }
      al.songs.push(s);
    }
    for (const [, al] of albums) {
      if (al.display && al.display !== this.t('library.noAlbum')) {
        const ah = document.createElement('div');
        ah.className = 'group-album';
        const firstSong = al.songs[0];
        const th = document.createElement('div');
        th.className = 'group-album-thumb';
        if (!firstSong || this.coverState.get(firstSong.filePath) === false) th.textContent = '♪';
        else {
          const ai = document.createElement('img');
          ai.alt = ''; ai.loading = 'lazy';
          ai.onerror = () => { this.coverState.set(firstSong.filePath, false); th.textContent = '♪'; };
          ai.src = this.coverUrl(firstSong);
          th.appendChild(ai);
        }
        const name = document.createElement('span'); name.className = 'group-album-name'; name.textContent = al.display;
        const meta = document.createElement('span'); meta.className = 'group-album-meta';
        meta.textContent = (al.year ? `${al.year} · ` : '') + this.tn('count.track', al.songs.length);
        ah.append(th, name, meta);
        container.appendChild(ah);
      }
      for (const s of al.songs) container.appendChild(buildSongCard(s, sortedSongs));
    }
  }

  // ---- busca ----
  #expandSearch() {
    this.#emit('syn:add:close'); // o adicionar sobrepõe a busca
    this.#g('searchBox').classList.add('expanded');
    this.#g('toolbar').classList.add('searching');
    this.#g('searchInput').focus();
  }
  collapseSearch() {
    this.#g('searchBox').classList.remove('expanded');
    this.#g('toolbar').classList.remove('searching');
  }
  #clearAndCollapseSearch() {
    this.searchQuery = '';
    this.#g('searchInput').value = '';
    this.collapseSearch();
    this.listEntrance = true;
    this.refresh();
  }
}
customElements.define('syn-library', SynLibrary);
