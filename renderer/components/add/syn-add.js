// <syn-add> — VIEW inteligente (ARCHITECTURE-V2) do "Adicionar música" + motor de downloads.
// Controller montado uma vez (<syn-add> vazio); OWNS por id o overlay #addBar e a barra
// (#addBtn/#ytUrl/#ytBtn/#pickMp3/#addCancel/#addError). Dono do estado dos jobs (pendingJobs)
// e do pipeline download→enriquecimento→salvar (worker/IA no main, máx. 2 simultâneos).
//
// Os cards de job aparecem no TOPO da lista da biblioteca: a library pede via pendingCards()
// (a folha hospeda os cards de outro subsistema sem que este conheça a library). Efeitos
// cross-subsistema saem por INTENTS: syn:library:refresh (re-render), syn:library:reload
// (recarrega do disco), syn:devices:resync, syn:toolbar:refresh. Injetados pelo renderer:
// t, toast, showScanIndicator, hideScanIndicator, collapseSearch, makeCenterCrop.
const MAX_DOWNLOADS = 2; // no máximo 2 downloads simultâneos

export class SynAdd extends HTMLElement {
  constructor() {
    super();
    this.t = (k) => k;
    this.toast = () => {};
    this.showScanIndicator = () => {};
    this.hideScanIndicator = () => {};
    this.collapseSearch = () => {};
    this.makeCenterCrop = async (s) => s;
    this.pendingJobs = []; // downloads/enriquecimentos em andamento (transientes)
    this._wired = false;
  }

  #g(id) { return document.getElementById(id); }
  #emit(name, detail) { document.dispatchEvent(new CustomEvent(name, { detail })); }
  #refreshList() { this.#emit('syn:library:refresh'); }
  #reloadLibrary() { this.#emit('syn:library:reload'); }
  #resync() { this.#emit('syn:devices:resync'); }
  #refreshToolbar() { this.#emit('syn:toolbar:refresh'); }

  connectedCallback() {
    if (this._wired) return;
    this._wired = true;

    this.#g('addBtn').addEventListener('click', () => { this.isOpen() ? this.close() : this.open(); });
    this.#g('addCancel').addEventListener('click', () => { this.#g('ytUrl').value = ''; this.close(); });
    this.#g('ytBtn').addEventListener('click', () => this.#enqueue());
    this.#g('pickMp3').addEventListener('click', () => this.#importMp3());
    this.#g('ytUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.#enqueue();
      else if (e.key === 'Escape') { this.#g('ytUrl').value = ''; this.close(); }
    });

    // progresso do download (yt-dlp), por jobId -> 2–58%
    window.api.onYoutubeProgress(({ jobId, msg, percent }) => {
      const job = this.pendingJobs.find((j) => j.id === jobId);
      if (!job || job.status !== 'downloading') return;
      if (percent != null && percent > 0) job.progress = 2 + Math.round((percent / 100) * 56);
      job.statusMsg = (percent != null && percent > 0) ? this.t('jobs.downloadingPct', { p: percent }) : (msg || this.t('jobs.downloading'));
      this.#updateJobEl(job);
    });
    // progresso do pipeline Gemini, por jobId -> 60–92% (flags estruturadas, independem do idioma)
    window.api.onGeminiProgress(({ jobId, msg, waiting, step }) => {
      const job = this.pendingJobs.find((j) => j.id === jobId);
      if (!job) return;
      job.statusMsg = msg;
      if (waiting) { /* em espera de rate limit: mantém a barra, só o texto */ }
      else if (step === 1) job.progress = 68;
      else if (step === 2) job.progress = 84;
      this.#updateJobEl(job);
    });
  }

  // ---- API pública p/ a biblioteca/toolbar ----
  /** Cards de job (renderizados no topo da lista da biblioteca). */
  pendingCards() { return this.pendingJobs.map((j) => this.#buildCard(j)); }
  hasPending() { return this.pendingJobs.length > 0; }
  /** Mensagem de status dos jobs ativos p/ a barra superior (ou null). */
  jobStatusMsg() {
    const active = this.pendingJobs.filter((j) => j.status === 'downloading' || j.status === 'enriching' || j.status === 'saving');
    if (active.length === 1) return active[0].statusMsg || this.t('jobs.processing');
    if (active.length > 1) return this.t('jobs.nProcessing', { n: active.length });
    return null;
  }

  // ---- overlay ----
  isOpen() { return this.#g('addBar').classList.contains('open'); }
  open() {
    this.collapseSearch(); // o adicionar sobrepõe a busca
    this.#g('addBar').classList.add('open');
    this.#g('addError').classList.add('hidden');
    setTimeout(() => this.#g('ytUrl').focus(), 40);
  }
  close() {
    this.#g('addBar').classList.remove('open');
    this.#g('addError').classList.add('hidden');
  }

  #isYouTubeUrl(url) {
    return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(url || '');
  }
  #enqueue() {
    const url = this.#g('ytUrl').value.trim();
    const errEl = this.#g('addError');
    if (!url) return;
    if (!this.#isYouTubeUrl(url)) {
      errEl.textContent = this.t('main.invalidUrl');
      errEl.classList.remove('hidden', 'closing');
      return;
    }
    this.#g('ytUrl').value = '';
    this.close();
    this.pendingJobs.push({
      id: 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      url, status: 'queued', progress: 0, statusMsg: this.t('jobs.queued'),
      title: '', artist: '', year: '', coverDataUrl: null, error: null,
    });
    this.#refreshList();
    this.#pump();
  }

  async #importMp3() {
    const p = await window.api.selectMp3();
    if (!p) return;
    this.#g('ytUrl').value = '';
    this.close();
    this.showScanIndicator(this.t('jobs.importing'));
    const res = await window.api.libraryImport(p);
    if (res.error) { this.hideScanIndicator(); this.toast(res.error, 'error'); return; }
    this.showScanIndicator(this.t('jobs.fetchingLyrics')); // enriquecimento: letra sincronizada
    try { await window.api.enrichLyricsFile(res.filePath); } catch { /* sem letra: segue */ }
    this.hideScanIndicator();
    this.#reloadLibrary();
    this.#resync();
    this.toast(this.t('jobs.mp3Added'), 'success');
  }

  // ---- cards de job ----
  #buildCard(job) {
    const t = this.t;
    const card = document.createElement('div');
    card.className = 'song-card pending' + (job.status === 'error' ? ' error' : '');
    card.dataset.jobId = job.id;

    const thumb = document.createElement('div');
    thumb.className = 'song-thumb';
    if (job.coverDataUrl) {
      const img = document.createElement('img');
      img.src = job.coverDataUrl; img.alt = '';
      thumb.appendChild(img);
    } else thumb.innerHTML = '<span class="ph">♪</span>';

    const info = document.createElement('div');
    info.className = 'song-info';
    const title = document.createElement('div');
    title.className = 'song-title';
    title.textContent = job.title || t('jobs.newSong');
    const sub = document.createElement('div');
    sub.className = 'song-sub';
    sub.textContent = job.status === 'error' ? ('⚠ ' + (job.error || t('jobs.failed'))) : (job.statusMsg || t('jobs.queued'));
    info.append(title, sub);

    if (job.status !== 'error') {
      const prog = document.createElement('div');
      prog.className = 'progress';
      const bar = document.createElement('div');
      bar.className = 'progress-bar';
      bar.style.width = (job.progress || 0) + '%';
      prog.appendChild(bar);
      info.appendChild(prog);
    }
    card.append(thumb, info);

    if (job.status === 'error') {
      const retry = document.createElement('button'); // tentar novamente → volta p/ a fila
      retry.className = 'song-menu';
      retry.textContent = '↻';
      retry.title = t('jobs.retry');
      retry.addEventListener('click', () => {
        job.status = 'queued'; job.error = null; job.progress = 0; job.statusMsg = t('jobs.queued');
        this.#refreshList(); this.#pump();
      });
      const dismiss = document.createElement('button'); // descartar job com erro
      dismiss.className = 'song-menu';
      dismiss.textContent = '✕';
      dismiss.title = t('jobs.dismiss');
      dismiss.addEventListener('click', () => {
        this.pendingJobs = this.pendingJobs.filter((j) => j !== job);
        this.#refreshList();
      });
      card.append(retry, dismiss);
    }
    return card;
  }

  // atualização leve só da barra/texto de um job (evita re-render completo a cada tick)
  #updateJobEl(job) {
    const el = document.querySelector(`.song-card.pending[data-job-id="${job.id}"]`);
    if (!el) { this.#refreshList(); return; }
    const bar = el.querySelector('.progress-bar');
    if (bar) bar.style.width = (job.progress || 0) + '%';
    const sub = el.querySelector('.song-sub');
    if (sub) sub.textContent = job.statusMsg || this.t('jobs.processing');
    const title = el.querySelector('.song-title');
    if (title && job.title) title.textContent = job.title;
    if (job.coverDataUrl) {
      const thumb = el.querySelector('.song-thumb');
      if (thumb && !thumb.querySelector('img')) thumb.innerHTML = `<img src="${job.coverDataUrl}" alt="" />`;
    }
    this.#refreshToolbar(); // resumo de loading sempre visível na barra superior
  }

  // ---- motor de fila ----
  #pump() {
    const downloading = this.pendingJobs.filter((j) => j.status === 'downloading').length;
    let slots = MAX_DOWNLOADS - downloading;
    for (const job of this.pendingJobs) {
      if (slots <= 0) break;
      if (job.status === 'queued') { slots--; this.#startJob(job); }
    }
  }

  async #startJob(job) {
    const t = this.t;
    job.status = 'downloading'; job.progress = 2; job.statusMsg = t('jobs.starting');
    this.#updateJobEl(job);
    try {
      // 1) baixar áudio + contexto da página
      const dl = await window.api.youtubeDownload({ jobId: job.id, url: job.url });
      if (dl.error) throw new Error(dl.error);
      job.tempPath = dl.filePath; job.ytContext = dl.ytContext; job.thumb = dl.thumbnailDataUrl;
      job.title = dl.videoTitle || t('jobs.newSong');

      job.status = 'enriching'; job.progress = 60; job.statusMsg = t('jobs.enrichQueue');
      this.#updateJobEl(job);
      this.#pump(); // download concluído → libera vaga

      // 2) enriquecer metadados (rate-limited no main)
      let data = {};
      let factualCover = null;
      if (dl.ytContext) {
        const meta = await window.api.smartMetadata({
          jobId: job.id, ytContext: dl.ytContext, hint: '',
          raw: { fileName: dl.videoTitle, title: '', artist: '', album: '' },
        });
        if (meta.error) throw new Error(meta.error);
        data = meta.data || {};
        factualCover = meta.coverDataUrl || null;
      }

      // 3) capa: prioriza a factual em alta sobre a thumbnail
      let coverDataUrl = null;
      const coverSource = factualCover || dl.thumbnailDataUrl;
      if (coverSource) {
        try { coverDataUrl = await this.makeCenterCrop(coverSource); }
        catch { coverDataUrl = coverSource; }
      }
      job.title = data.title || dl.videoTitle; job.artist = data.artist || '';
      job.year = data.year || ''; job.coverDataUrl = coverDataUrl;
      this.#updateJobEl(job);

      // 3.5) letra sincronizada (LRCLIB)
      if (data.title || data.artist || dl.videoTitle) {
        job.statusMsg = t('jobs.fetchingLyrics'); job.progress = 90;
        this.#updateJobEl(job);
        try {
          const ly = await window.api.fetchSyncedLyrics({
            artist: data.artist || '', title: data.title || dl.cleanName || dl.videoTitle || '',
            album: data.album || '', duration: 0,
          });
          if (ly && !ly.error && (ly.synced || ly.plain)) data.lyrics = ly.synced || ly.plain;
        } catch { /* sem letra: segue */ }
      }

      // 4) salvar direto na biblioteca
      job.status = 'saving'; job.progress = 94; job.statusMsg = t('jobs.savingLibrary');
      this.#updateJobEl(job);
      const suggested = (data.artist && data.title) ? `${data.artist} - ${data.title}`
        : (data.title || dl.cleanName || dl.videoTitle || 'audio');
      const save = await window.api.saveTags({
        filePath: dl.filePath, source: 'library', suggestedName: suggested,
        imageDataUrl: coverDataUrl, fields: data,
      });
      if (save.error) throw new Error(save.error);

      const title = job.title;
      this.pendingJobs = this.pendingJobs.filter((j) => j !== job);
      this.#reloadLibrary();
      this.toast(t('jobs.added', { title }), 'success');
      this.#resync(); // leva a nova música ao dispositivo, se houver sync
    } catch (err) {
      job.status = 'error';
      job.error = (err && err.message) ? err.message : String(err);
      this.#refreshList();
    } finally {
      this.#pump(); // garante a continuidade da fila
    }
  }
}
customElements.define('syn-add', SynAdd);
