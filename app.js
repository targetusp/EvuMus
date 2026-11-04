(function () {
  'use strict';

  // ===== Конфигурация =====
  var API_URL = 'https://evumus.onrender.com'; 
  var BACKEND_URL = 'https://evumus.onrender.com'; 

  // ===== Telegram SDK =====
  var TG = window.Telegram && window.Telegram.WebApp;
  if (TG) {
    try { TG.ready(); TG.expand(); TG.setHeaderColor && TG.setHeaderColor('#0e1a27'); } catch (e) {}
    var tgHeader = document.getElementById('tgHeader');
    if (tgHeader) tgHeader.style.display = 'none';
    document.body.classList.add('telegram-mode');
  }

  // ===== Состояние =====
  var THEME_KEY = 'evu_theme';
  var ALBUM_KEY = 'evu_albums_v1';
  var LANG_KEY = 'evu_language';
  var GLASS_KEY = 'evu_glass_mode';

  var THEME_NAMES = { blue: 'Синяя', white: 'Белая', black: 'Чёрная' };
  
  var library = [];
  var favs = [];
  var playlists = [];
  
  var albums = load(ALBUM_KEY, []);
  var language = load(LANG_KEY, 'ru');
  var activeAlbumIdx = null;
  var COVER_COLORS = ['#e85d75','#6c8ee0','#5bb98c','#d4a04c','#9b6dd6','#e07850','#4cb5d4','#d45c9e','#7bc65a','#c05a5a','#5a7bd4','#b8a04c','#8c6ce0','#4cc0a8','#d47898'];

  function load(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  var theme = load(THEME_KEY, 'blue');
  if (!Array.isArray(albums)) albums = [];

  var mymusicTab = 'all';
  var searchTab = 'tracks';
  var favTab = 'fav';

  var trackRegistry = {};
  var searchTimer = null;
  var searchRequestId = 0;   

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function coverColor(n) { return COVER_COLORS[(n || 0) % COVER_COLORS.length]; }
  function coverLetter(t) { return (t || '?').charAt(0).toUpperCase(); }

  function toast(msg) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  // ===== API Запросы (Neon) =====
  function getAuthHeader() {
    if (!TG || !TG.initData) return {};
    return { 'Authorization': TG.initData };
  }

  async function loadUserData() {
    if (!TG || !TG.initData) return;
    try {
      var res = await fetch(API_URL + '/api/user_data', { headers: getAuthHeader() });
      if (!res.ok) throw new Error('Auth failed');
      
      var data = await res.json();
      favs = data.favorites || [];
      library = data.library || [];
      playlists = data.playlists || [];
      
      favs.forEach(registerTrack);
      library.forEach(registerTrack);
      playlists.forEach(function(p) { if(p.tracks) p.tracks.forEach(registerTrack); });

      refreshAll();
      renderPlaylists();
      favTitle();
    } catch (e) {
      console.error(e);
      toast('Ошибка синхронизации');
    }
  }

  async function apiToggleFav(tr) {
    try {
      var res = await fetch(API_URL + '/api/favorites', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
        body: JSON.stringify({ 
            id: String(tr.id), title: tr.title, artist: tr.artist, 
            duration: tr.dur || '', cover: tr.cover || '', source: tr.source || '' 
        })
      });
      if (!res.ok) throw new Error();
      
      var data = await res.json();
      if (data.status === 'added') {
        favs.push(tr);
        toast('Добавлено в любимое');
      } else {
        favs = favs.filter(function(f) { return String(f.id) !== String(tr.id); });
        toast('Убрано из любимого');
      }
      refreshAll();
    } catch (e) {
      toast('Ошибка сохранения');
    }
  }

  async function apiCreatePlaylist(name) {
    try {
      var res = await fetch(API_URL + '/api/playlists', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
        body: JSON.stringify({ title: name })
      });
      if (!res.ok) throw new Error();
      return await res.json();
    } catch (e) {
      toast('Ошибка создания');
      return null;
    }
  }

  async function apiAddTrackToPlaylist(playlistId, tr) {
    try {
      var res = await fetch(API_URL + '/api/playlists/add_track', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
        body: JSON.stringify({ 
            playlist_id: playlistId, id: String(tr.id), title: tr.title, 
            artist: tr.artist, duration: tr.dur || '', cover: tr.cover || '', source: tr.source || '' 
        })
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  // ===== Тема =====
  function applyTheme(name) {
    theme = name;
    document.documentElement.setAttribute('data-theme', name);
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', name === 'white' ? '#ffffff' : name === 'black' ? '#000000' : '#0b1622');
    
    var themeVal = $('#themeValue');
    if (themeVal) themeVal.textContent = THEME_NAMES[name] || name;
    
    document.documentElement.classList.toggle('glass-mode', !!load(GLASS_KEY, false));
    $$('.theme-option').forEach(function (b) {
      b.classList.toggle('selected', b.getAttribute('data-theme-pick') === name);
    });
    save(THEME_KEY, name);
  }
  applyTheme(theme);
  
  var glassToggle = $('#glassModeToggle');
  if (glassToggle) {
      glassToggle.checked = !!load(GLASS_KEY, false);
      glassToggle.addEventListener('change', function () {
        save(GLASS_KEY, this.checked);
        document.documentElement.classList.toggle('glass-mode', this.checked);
      });
  }

  // ===== Языки (I18N) =====
  var I18N = {
    ru: {my:'Моя музыка',search:'Поиск',favorites:'Любимое',playlists:'Плейлисты',albums:'Альбомы',settings:'Настройки',channel:'Канал с обновлениями',all:'Все треки',tracks:'Треки',searchMusic:'Поиск музыки',searchHint:'Находи свои треки и новую музыку',searchPlaceholder:'Название песни или исполнитель...',advanced:'Расширенный поиск',collection:'Твоя коллекция',noTracks:'Здесь пока нет треков',addMusic:'Добавляй музыку из поиска и собирай свои плейлисты.',goSearch:'Перейти к поиску',theme:'Оформление',language:'Язык',general:'Основное',support:'Связь и поддержка',feedback:'Обратная связь',help:'Помочь проекту',account:'Аккаунт',delete:'Удалить личный кабинет',create:'Создать',newAlbum:'Новый альбом',albumHint:'Собирай треки в собственные альбомы'},
    en: {my:'My music',search:'Search',favorites:'Favorites',playlists:'Playlists',albums:'Albums',settings:'Settings',channel:'Updates channel',all:'All tracks',tracks:'Tracks',searchMusic:'Music search',searchHint:'Find your tracks and discover new music',searchPlaceholder:'Song title or artist...',advanced:'Advanced search',collection:'Your collection',noTracks:'No tracks yet',addMusic:'Add music from search and build your playlists.',goSearch:'Go to search',theme:'Appearance',language:'Language',general:'General',support:'Help & support',feedback:'Feedback',help:'Support the project',account:'Account',delete:'Delete account',create:'Create',newAlbum:'New album',albumHint:'Collect tracks in your own albums'}
  };
  function applyLanguage(code) {
    language = I18N[code] ? code : 'ru';
    var d = I18N[language];
    document.documentElement.lang = language;
    
    var nav = $$('.nav__item[data-page]');
    var navKeys = ['my','search','favorites','playlists','albums','settings'];
    nav.forEach(function (el, i) { var span = el.querySelector('span:not(.nav__badge)'); if (span && d[navKeys[i]]) span.textContent = d[navKeys[i]]; });
    var link = $('.nav__item--link span'); if (link) link.textContent = d.channel;
    
    var setText = function (sel, val) { var el = $(sel); if (el && val) el.textContent = val; };
    setText('#page-mymusic .section-head h2', d.my); setText('#page-search .section-head h2', d.searchMusic);
    setText('#page-search .section-sub', d.searchHint); setText('#page-mymusic .empty-card h3', d.noTracks);
    setText('#page-mymusic .empty-card p', d.addMusic); setText('#page-mymusic .empty-card .btn-primary', d.goSearch);
    setText('#collectionHead h2', d.collection); setText('#page-playlists .section-head h2', d.playlists);
    setText('#page-albums .section-head h2', d.albums); setText('.album-sub', d.albumHint);
    setText('#page-settings .page-title', d.settings); setText('#page-settings .settings-label', d.general);
    setText('#openThemeModal .settings-item__title', d.theme); setText('#btnLang .settings-item__title', d.language);
    setText('#btnFeedback .settings-item__title', d.feedback); setText('#page-settings .settings-label:nth-of-type(2)', d.support);
    setText('#page-settings .settings-label:nth-of-type(3)', d.account); setText('#btnDelete .settings-item__title', d.delete);
    setText('#btnCreatePlaylist', d.create); setText('#btnCreateAlbum', '＋ ' + d.create);
    
    var input = $('#searchInput'); if (input) input.placeholder = d.searchPlaceholder;
    $$('.tab[data-mymusic-tab]').forEach(function (el) { el.textContent = el.dataset.mymusicTab === 'all' ? d.all : d.favorites; });
    $$('.tab[data-search-tab]').forEach(function (el) { el.textContent = el.dataset.searchTab === 'tracks' ? d.tracks : d.albums; });
    $$('.language-option').forEach(function (el) { el.classList.toggle('selected', el.dataset.lang === language); });
    
    var langValue = $('#btnLang .settings-item__value'); 
    if (langValue) langValue.textContent = ({ru:'Русский',en:'English'})[language];
    save(LANG_KEY, language);
  }
  
  var btnLang = $('#btnLang');
  if (btnLang) btnLang.addEventListener('click', function () { var m = $('#languageModal'); if(m) m.hidden = false; });
  var closeLang = $('#closeLanguageModal');
  if (closeLang) closeLang.addEventListener('click', function () { var m = $('#languageModal'); if(m) m.hidden = true; });
  var langModal = $('#languageModal');
  if (langModal) langModal.addEventListener('click', function (e) { if (e.target === langModal) langModal.hidden = true; });
  
  $$('.language-option').forEach(function (el) { el.addEventListener('click', function () { applyLanguage(el.dataset.lang); }); });
  applyLanguage(language);

  // ===== Навигация =====
  (function installSupportBannerOnPages() {
    var original = document.querySelector('#page-mymusic .support-banner');
    if (!original) return;
    document.querySelectorAll('.page:not(#page-settings)').forEach(function(page) {
      if (page.querySelector('.support-banner')) return;
      page.insertBefore(original.cloneNode(true), page.firstChild);
    });
  })();

  function goPage(name) {
    $$('.page').forEach(function (p) { p.classList.remove('active'); });
    var page = $('#page-' + name);
    if (page) page.classList.add('active');
    $$('.nav__item[data-page]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-page') === name); });
    var content = $('.content');
    if (content) content.scrollTop = 0;
  }
  
  $$('.nav__item[data-page]').forEach(function (btn) { btn.addEventListener('click', function () { goPage(btn.getAttribute('data-page')); }); });
  $$('[data-goto]').forEach(function (btn) { btn.addEventListener('click', function () { goPage(btn.getAttribute('data-goto')); }); });

  // ===== Табы =====
  function bindTabs(selector, attr, onChange) {
    $$(selector).forEach(function (tab) {
      tab.addEventListener('click', function () {
        $$(selector).forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        onChange(tab.getAttribute(attr));
      });
    });
  }
  bindTabs('[data-mymusic-tab]', 'data-mymusic-tab', function (v) { mymusicTab = v; renderMyMusic(); });
  bindTabs('[data-search-tab]', 'data-search-tab', function (v) { searchTab = v; renderSearch(); });
  bindTabs('[data-fav-tab]', 'data-fav-tab', function (v) { favTab = v; favTitle(); renderFavs(); });

  function registerTrack(t) {
    if (!t || t.id == null) return t;
    trackRegistry[String(t.id)] = t;
    return t;
  }

  // ===== Поиск музыки =====
  function absUrl(u) {
    if (!u) return '';
    if (u.indexOf('http') === 0) return u;
    return BACKEND_URL + u;
  }

  function fetchTracks(query) {
    if (BACKEND_URL) {
      var url = BACKEND_URL + '/api/search?q=' + encodeURIComponent(query);
      return fetch(url)
        .then(function (r) { if (!r.ok) throw new Error('backend HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          var tracks = (d.tracks || []).map(function (t) {
            var dur = t.dur || (t.duration ? Math.floor(t.duration / 60) + ':' + ('0' + (t.duration % 60)).slice(-2) : '');
            return {
              id: String(t.id), title: t.title, artist: t.artist || '',
              dur: dur, cover: absUrl(t.cover || ''),
              preview: absUrl(t.preview_url || t.preview || t.stream_url || ''),
              full: t.full !== false, source: t.source || 'ru'
            };
          }).filter(function (t) { return !!t.preview; });
          return tracks;
        });
    }
    return Promise.resolve([]);
  }

  // ===== Отрисовка =====
  function isFav(id) { return favs.some(function(f) { return String(f.id) === String(id); }); }
  function playSvg() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l12 7-12 7V5z"/></svg>'; }
  function pauseSvg() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'; }

  function coverFallback(t) {
    var title = String((t && t.title) || 'Без названия').slice(0, 48);
    var artist = String((t && t.artist) || 'EvuMusic').slice(0, 42);
    var hash = 0, seed = String((t && t.id) || title + artist);
    for (var i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    var hue = Math.abs(hash) % 360;
    function xml(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
    function fit(v, max) { return v.length > max ? v.slice(0, max - 1) + '…' : v; }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(' + hue + ',58%,35%)"/><stop offset="1" stop-color="#07111f"/></linearGradient></defs>' +
      '<rect width="600" height="600" rx="48" fill="url(#g)"/>' +
      '<text x="54" y="420" fill="#fff" font-family="Arial,sans-serif" font-size="34" font-weight="700">' + xml(fit(title, 25)) + '</text>' +
      '<text x="56" y="465" fill="#fff" fill-opacity=".72" font-family="Arial,sans-serif" font-size="22">' + xml(fit(artist, 32)) + '</text></svg>';
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  }

  function trackHTML(t) {
    var fav = isFav(t.id);
    var ownCover = t.cover || coverFallback(t);
    t.cover = ownCover;
    var cover = '<img class="track__cover track__cover-image js-track-cover" src="' + ownCover + '" alt="" loading="lazy">';
    return '<div class="track" data-id="' + esc(String(t.id)) + '">' +
      cover +
      '<div class="track__meta"><div class="track__title">' + esc(t.title) + '</div>' +
      '<div class="track__artist">' + esc(t.artist) + (t.dur ? ' · ' + esc(t.dur) : '') + '</div></div>' +
      '<div class="track__actions">' +
      '<button class="track__btn js-play" title="Играть">' + playSvg() + '</button>' +
      '<button class="track__btn js-fav' + (fav ? ' active' : '') + '" title="В избранное">' +
      (fav ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.7-7.5-10A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.5 3c0 5.3-7.5 10-7.5 10z"/></svg>'
           : '<svg viewBox="0 0 24 24" fill="none"><path d="M12 20.5s-7.5-4.7-7.5-10A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.5 3c0 5.3-7.5 10-7.5 10z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>') +
      '</button>' +
      '<button class="track__btn js-addpl" title="В плейлист"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h12M4 12h12M4 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18 13.5V9l3 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16.5" cy="16" r="2" stroke="currentColor" stroke-width="2"/></svg></button>' +
      '</div></div>';
  }

  function renderList(container, tracks) {
    if (!container) return;
    container.innerHTML = tracks.map(trackHTML).join('');
    updateRowPlayState();
  }

  // ===== Страницы =====
  function renderMyMusic() {
    var tracks = library;
    var myEmpty = $('#myEmpty'); if (myEmpty) myEmpty.hidden = tracks.length > 0;
    var myCount = $('#myCount'); if (myCount) myCount.textContent = 'Треков: ' + tracks.length;
    renderList($('#myList'), tracks);
  }
  function favTitle() {
    var ft = $('#favTitle'); if (ft) ft.textContent = favTab === 'fav' ? 'Любимое' : 'Моя музыка';
  }
  function renderFavs() {
    var tracks = favs;
    var favEmpty = $('#favEmpty'); if (favEmpty) favEmpty.hidden = tracks.length > 0;
    var favCount = $('#favCount'); if (favCount) favCount.textContent = 'Треков: ' + tracks.length;
    renderList($('#favList'), tracks);
    var fb = $('#favBadge'); if (fb) fb.textContent = favs.length;
  }
  function renderCollection() {
    var tracks = library;
    var collEmpty = $('#collEmpty'); if (collEmpty) collEmpty.hidden = tracks.length > 0;
    var collCount = $('#collCount'); if (collCount) collCount.textContent = 'Треков: ' + tracks.length;
    renderList($('#collList'), tracks);
  }

  function renderSearch() {
    var input = $('#searchInput');
    if (!input) return;
    var q = (input.value || '').trim();
    
    var empty = $('#searchEmpty');
    var results = $('#searchResults');
    
    if (searchTab === 'albums' || !q) {
      if (empty) { empty.hidden = false; empty.innerHTML = '<p>Начни вводить название — полные треки</p>'; }
      if (results) results.innerHTML = '';
      renderCollection();
      return;
    }

    if (empty) empty.hidden = true;
    if (results) results.innerHTML = '<div class="search-hint">Ищу треки…</div>';
    var reqId = ++searchRequestId;

    fetchTracks(q).then(function (tracks) {
      if (reqId !== searchRequestId) return;
      tracks.forEach(registerTrack);
      if (!tracks || !tracks.length) {
        if (empty) { empty.hidden = false; empty.innerHTML = '<p>Ничего не найдено по «' + esc(q) + '»</p>'; }
        if (results) results.innerHTML = '';
        return;
      }
      if (empty) empty.hidden = true;
      renderList(results, tracks);
    }).catch(function () {
      if (reqId !== searchRequestId) return;
      if (empty) { empty.hidden = false; empty.innerHTML = '<p>Ошибка поиска. Попробуй ещё раз.</p>'; }
      if (results) results.innerHTML = '';
    });
    renderCollection();
  }

  var searchInp = $('#searchInput');
  if (searchInp) {
      searchInp.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderSearch, 700);
      });
      searchInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { clearTimeout(searchTimer); renderSearch(); }
      });
  }

  // ===== Плейлисты =====
  var addToPlaylistTrackId = null;
  var activePlIdx = null;

  function openAddToPlaylist(trackId) {
    addToPlaylistTrackId = trackId;
    var list = $('#playlistPickList');
    var picks = playlists.map(function (p, idx) { return '<button class="playlist-pick-item" data-pl-idx="' + idx + '"><span>🎵</span><b>' + esc(p.name) + '</b><span>' + (p.count || 0) + ' треков</span></button>'; });
    albums.forEach(function (a, idx) { picks.push('<button class="playlist-pick-item" data-album-idx="' + idx + '"><span>💿</span><b>' + esc(a.name) + '</b><span>' + (a.tracks || []).length + ' треков · альбом</span></button>'); });
    if (list) list.innerHTML = picks.length ? picks.join('') : '<p class="empty-hint">Пока нет плейлистов или альбомов.</p>';
    var row = $('#plNewRow'); if (row) row.hidden = true;
    var modal = $('#addToPlaylistModal'); if (modal) modal.hidden = false;
  }
  function closeAddToPlaylist() { 
      var modal = $('#addToPlaylistModal'); if (modal) modal.hidden = true; 
      addToPlaylistTrackId = null; 
  }

  var cancelAdd = document.getElementById('cancelAddToPlaylist'); if (cancelAdd) cancelAdd.addEventListener('click', closeAddToPlaylist);
  var addModal = document.getElementById('addToPlaylistModal'); if (addModal) addModal.addEventListener('click', function (e) { if (e.target === addModal) closeAddToPlaylist(); });

  var createInline = document.getElementById('createPlaylistInline');
  if (createInline) createInline.addEventListener('click', function () {
    var row = $('#plNewRow'); if (row) row.hidden = false;
    var inp = $('#plNewInput'); if (inp) inp.focus();
  });
  
  async function createPlFromInline() {
    var inp = $('#plNewInput'); if (!inp) return;
    var name = (inp.value || '').trim();
    if (!name) { toast('Введи название'); return; }
    if (playlists.some(function (p) { return (p.name || '').toLowerCase() === name.toLowerCase(); })) {
      toast('Такой плейлист уже есть'); return;
    }
    var btn = $('#plNewSave'); if (btn) btn.disabled = true;
    var newPl = await apiCreatePlaylist(name);
    if (btn) btn.disabled = false;
    if (newPl) {
        playlists.push(newPl);
        inp.value = '';
        var row = $('#plNewRow'); if (row) row.hidden = true;
        renderPlaylists();
        openAddToPlaylist(addToPlaylistTrackId); 
        toast('Плейлист «' + name + '» создан');
    }
  }
  var plSaveBtn = document.getElementById('plNewSave'); if (plSaveBtn) plSaveBtn.addEventListener('click', createPlFromInline);
  var plNewInput = document.getElementById('plNewInput'); if (plNewInput) plNewInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') createPlFromInline(); });

  if (addModal) addModal.addEventListener('click', async function (e) {
    var btn = e.target.closest('.playlist-pick-item');
    if (!btn) return;
    if (!addToPlaylistTrackId) { toast('Трек не найден'); return; }
    var tr = findTrack(addToPlaylistTrackId);
    if (!tr) return;

    var albumIdx = btn.hasAttribute('data-album-idx') ? parseInt(btn.getAttribute('data-album-idx'), 10) : -1;
    
    if (albumIdx >= 0) {
        var target = albums[albumIdx];
        if (!target.tracks) target.tracks = [];
        var already = target.tracks.some(function (x) { var xid = (x && typeof x === 'object') ? x.id : x; return String(xid) === String(tr.id); });
        if (!already) {
            target.tracks.push(tr);
            save(ALBUM_KEY, albums);
            toast('Добавлено в «' + target.name + '»');
            renderAlbums(); 
        } else { toast('Уже добавлено'); }
        closeAddToPlaylist();
    } else {
        var plIdx = parseInt(btn.getAttribute('data-pl-idx'), 10);
        var pl = playlists[plIdx];
        if (!pl) return;

        btn.disabled = true;
        var success = await apiAddTrackToPlaylist(pl.id, tr);
        btn.disabled = false;

        if (success) {
            if(!pl.tracks) pl.tracks = [];
            if(!pl.tracks.some(function(x){ return String(x.id) === String(tr.id); })) {
                pl.tracks.push(tr);
                pl.count = pl.tracks.length;
            }
            toast('Добавлено в «' + pl.name + '»');
            renderPlaylists();
            if (activePlIdx === plIdx) renderPlaylistDetail();
            closeAddToPlaylist();
        } else {
            toast('Ошибка сервера');
        }
    }
  });

  // ===== Действия с треками =====
  function findTrack(id) {
    return trackRegistry[id] || favs.find(function (f) { return String(f.id) === String(id); }) || library.find(function (l) { return String(l.id) === String(id); });
  }
  
  function triggerPlay(row) {
    if (!row) return;
    var id = row.getAttribute('data-id');
    var tr = findTrack(id);
    if (!tr) { toast('Трек не найден'); return; }
    if (!tr.preview) { toast('Нет превью для этого трека'); return; }
    queueIds = [];
    row.parentElement.querySelectorAll('.track').forEach(function (r) { queueIds.push(r.getAttribute('data-id')); });
    playPreview(tr);
  }

  var contentEl = document.getElementById('content');
  if (contentEl) contentEl.addEventListener('click', function (e) {
    var coverEl = e.target.closest('.track__cover');
    if (coverEl) { triggerPlay(coverEl.closest('.track')); return; }
    var btn = e.target.closest('.track__btn');
    if (!btn) return;
    var row = btn.closest('.track');
    var id = row.getAttribute('data-id');
    var tr = findTrack(id);

    if (btn.classList.contains('js-play')) {
      triggerPlay(row);
    } else if (btn.classList.contains('js-fav')) {
      if (!tr) return;
      btn.disabled = true;
      apiToggleFav(tr).then(function() { btn.disabled = false; });
    } else if (btn.classList.contains('js-addpl')) {
      if (!tr) return;
      openAddToPlaylist(id);
    }
  });

  function refreshAll() {
    renderMyMusic();
    renderFavs();
    renderSearch();
  }

  function renderPlaylists() {
    var grid = $('#playlistGrid');
    if (!grid) return;
    var html = '';
    playlists.forEach(function (p, idx) {
      html += '<div class="playlist-card" data-pl="' + idx + '"><span class="playlist-card__plus">🎵</span><b>' + esc(p.name) + '</b><span>' + (p.count || 0) + ' треков</span></div>';
    });
    html += '<button class="playlist-card playlist-card--new" id="newPlaylistCard"><span class="playlist-card__plus">+</span><b>Новый плейлист</b><span>Добавить плейлист</span></button>';
    grid.innerHTML = html;
    
    var newPlBtn = $('#newPlaylistCard'); if (newPlBtn) newPlBtn.addEventListener('click', openPlaylistModal);
    $$('.playlist-card[data-pl]').forEach(function (card) {
      card.addEventListener('click', function () { openPlaylist(parseInt(card.getAttribute('data-pl'), 10)); });
    });
  }
  var plBack = $('#plBack'); if (plBack) plBack.addEventListener('click', function () { goPage('playlists'); });
  
  function openPlaylist(idx) {
    if (!playlists[idx]) { goPage('playlists'); return; }
    activePlIdx = idx;
    renderPlaylistDetail();
    goPage('plview');
  }
  function renderPlaylistDetail() {
    var pl = playlists[activePlIdx];
    if (!pl) return;
    var title = $('#plViewTitle'); if (title) title.textContent = pl.name;
    var tracks = (pl.tracks || []).filter(Boolean);
    var empty = $('#plViewEmpty'); if (empty) empty.hidden = tracks.length > 0;
    renderList($('#plViewList'), tracks);
  }
  function openPlaylistModal() {
    var inp = $('#playlistNameInput'); if (inp) inp.value = '';
    var modal = $('#playlistModal'); if (modal) modal.hidden = false;
    setTimeout(function () { var i = $('#playlistNameInput'); if (i) i.focus(); }, 50);
  }
  function closePlaylistModal() { var modal = $('#playlistModal'); if (modal) modal.hidden = true; }
  
  var btnCreatePl = $('#btnCreatePlaylist'); if (btnCreatePl) btnCreatePl.addEventListener('click', openPlaylistModal);
  var cancelPl = $('#cancelPlaylist'); if (cancelPl) cancelPl.addEventListener('click', closePlaylistModal);
  
  var savePl = $('#savePlaylist'); if (savePl) savePl.addEventListener('click', async function () {
    var inp = $('#playlistNameInput'); if (!inp) return;
    var name = (inp.value || '').trim();
    if (!name) { toast('Введи название'); return; }
    savePl.disabled = true;
    var newPl = await apiCreatePlaylist(name);
    savePl.disabled = false;
    if (newPl) {
        playlists.push(newPl);
        closePlaylistModal();
        renderPlaylists();
        toast('Плейлист «' + name + '» создан');
    }
  });
  var plInp = $('#playlistNameInput'); if (plInp) plInp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && savePl) savePl.click(); });

  // ===== Альбомы =====
  function renderAlbums() {
    var grid = $('#albumGrid');
    if (!grid) return;
    var empty = $('#albumEmpty'); if (empty) empty.hidden = albums.length > 0;
    grid.innerHTML = albums.map(function (a, idx) {
      return '<button class="playlist-card" data-album="' + idx + '"><span class="playlist-card__plus">💿</span><b>' + esc(a.name) + '</b><span>' + ((a.tracks || []).length) + ' треков</span></button>';
    }).join('');
    grid.querySelectorAll('[data-album]').forEach(function (card) { card.addEventListener('click', function () { openAlbum(parseInt(card.dataset.album, 10)); }); });
  }
  function openAlbum(idx) { if (!albums[idx]) return; activeAlbumIdx = idx; renderAlbumDetail(); goPage('alview'); }
  function renderAlbumDetail() {
    var a = albums[activeAlbumIdx]; if (!a) return;
    var title = $('#albumViewTitle'); if (title) title.textContent = a.name;
    var tracks = (a.tracks || []).filter(Boolean);
    var empty = $('#albumViewEmpty'); if (empty) empty.hidden = tracks.length > 0;
    renderList($('#albumViewList'), tracks);
  }
  function openAlbumModal() { var i = $('#albumNameInput'); if (i) i.value = ''; var m = $('#albumModal'); if (m) m.hidden = false; var i2 = $('#albumNameInput'); if (i2) i2.focus(); }
  
  var btnCreateAl = $('#btnCreateAlbum'); if (btnCreateAl) btnCreateAl.addEventListener('click', openAlbumModal);
  var cancelAl = $('#cancelAlbum'); if (cancelAl) cancelAl.addEventListener('click', function () { var m = $('#albumModal'); if (m) m.hidden = true; });
  
  var saveAl = $('#saveAlbum'); if (saveAl) saveAl.addEventListener('click', function () {
    var inp = $('#albumNameInput'); if (!inp) return;
    var name = (inp.value || '').trim();
    if (!name) { toast('Введи название альбома'); return; }
    if (albums.some(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })) { toast('Такой альбом уже есть'); return; }
    albums.push({ name: name, tracks: [], createdAt: Date.now() }); save(ALBUM_KEY, albums);
    var m = $('#albumModal'); if (m) m.hidden = true; 
    renderAlbums(); toast('Альбом «' + name + '» создан');
  });
  var alInp = $('#albumNameInput'); if (alInp) alInp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && saveAl) saveAl.click(); });
  var alBack = $('#albumBack'); if (alBack) alBack.addEventListener('click', function () { goPage('albums'); });

  // ===== Настройки =====
  var openTheme = $('#openThemeModal'); if (openTheme) openTheme.addEventListener('click', function () { var m = $('#themeModal'); if (m) m.hidden = false; });
  var closeTheme = $('#closeThemeModal'); if (closeTheme) closeTheme.addEventListener('click', function () { var m = $('#themeModal'); if (m) m.hidden = true; });
  var themeModal = $('#themeModal'); if (themeModal) themeModal.addEventListener('click', function (e) { if (e.target === themeModal) themeModal.hidden = true; });
  
  $$('.theme-option').forEach(function (b) {
    b.addEventListener('click', function () { applyTheme(b.getAttribute('data-theme-pick')); toast('Тема: ' + THEME_NAMES[b.getAttribute('data-theme-pick')]); });
  });

  var btnFeed = $('#btnFeedback'); if (btnFeed) btnFeed.addEventListener('click', function () { window.open('https://t.me/EvuMusic', '_blank'); });
  
  var confirmCb = null;
  function showConfirm(text, cb) { var t = $('#confirmText'); if (t) t.textContent = text; var o = $('#confirmOverlay'); if (o) o.hidden = false; confirmCb = cb; }
  var confCancel = $('#confirmCancel'); if (confCancel) confCancel.addEventListener('click', function () { var o = $('#confirmOverlay'); if (o) o.hidden = true; confirmCb = null; });
  var confOk = $('#confirmOk'); if (confOk) confOk.addEventListener('click', function () { var o = $('#confirmOverlay'); if (o) o.hidden = true; if (confirmCb) confirmCb(); confirmCb = null; });
  
  var btnDel = $('#btnDelete'); if (btnDel) btnDel.addEventListener('click', function () {
    showConfirm('Удалить личный кабинет? Это действие нельзя отменить.', function () {
      library = []; favs = []; playlists = []; albums = [];
      save(ALBUM_KEY, albums);
      refreshAll(); renderPlaylists(); renderAlbums();
      toast('Личный кабинет удалён локально');
    });
  });

  // ===== Плеер =====
  var previewAudio = null;
  var previewTrackId = null;
  var playerState = { playing: false };
  window.__evuAudio = function () { return previewAudio; };

  function startAudio(url, t) {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    previewTrackId = String(t.id);
    previewAudio = new Audio(url);
    previewAudio.preload = 'auto';
    previewAudio.crossOrigin = 'anonymous';
    previewAudio.volume = volume / 100;
    previewAudio.currentTime = 0;
    previewAudio.load();
    var playPromise = previewAudio.play();
    if (playPromise && playPromise.catch) playPromise.catch(function () {});
    showPlayer(t);
    setPlayingUI(true);
    previewAudio.ontimeupdate = function () {
      if (previewAudio && !seekDrag) {
        var dur = (previewAudio.duration && isFinite(previewAudio.duration) && previewAudio.duration > 0) ? previewAudio.duration : 30;
        var prog = $('#playerProgress'); if (prog) prog.style.width = Math.min(100, (previewAudio.currentTime / dur * 100)) + '%';
      }
    };
    previewAudio.onended = function () {
      var prog = $('#playerProgress'); if (prog) prog.style.width = '0%';
      var idx = queueIds.indexOf(previewTrackId);
      if (idx >= 0 && idx < queueIds.length - 1) {
        var nextT = (trackRegistry[queueIds[idx + 1]] || findTrack(queueIds[idx + 1]));
        if (nextT && nextT.preview) { playPreview(nextT); return; }
      }
      setPlayingUI(false);
    };
    previewAudio.onplay = function () { setPlayingUI(true); };
    previewAudio.onpause = function () { setPlayingUI(false); };
  }

  function playPreview(t) {
    if (previewAudio && previewTrackId === String(t.id)) {
      if (previewAudio.paused) { previewAudio.play(); setPlayingUI(true); }
      else { previewAudio.pause(); setPlayingUI(false); }
      return;
    }
    var audioUrl = t.preview;
    startAudio(audioUrl, t);
    showPlayer(t);
    setPlayingUI(true);
  }
  
  function setPlayingUI(on) {
    playerState.playing = on;
    var ip = $('#iconPlay'); if (ip) ip.toggleAttribute('hidden', on);
    var ipa = $('#iconPause'); if (ipa) ipa.toggleAttribute('hidden', !on);
    var pl = $('#player'); if (pl) pl.classList.toggle('is-playing', on);
    updateRowPlayState();
  }

  function updateRowPlayState() {
    $$('.track').forEach(function (r) {
      var b = r.querySelector('.track__btn.js-play');
      if (!b) return;
      var cur = !!(onPlaying() && previewTrackId && r.getAttribute('data-id') === previewTrackId);
      r.classList.toggle('is-current', cur);
      b.innerHTML = cur ? pauseSvg() : playSvg();
    });
  }
  function onPlaying() { return !!playerState.playing; }
  function showPlayer(t) {
    var pl = $('#player'); if (pl) pl.hidden = false;
    var pt = $('#playerTitle'); if (pt) pt.textContent = t.title;
    var pa = $('#playerArtist'); if (pa) pa.textContent = t.artist;
    var c = $('#playerCover');
    if (c) {
        var art = t.cover || '';
        if (art) {
          c.innerHTML = '<img src="' + esc(art) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">';
          c.style.background = 'none';
        } else {
          c.innerHTML = '';
          c.style.background = coverColor(String(t.id).length + (t.title || '').length);
          c.textContent = coverLetter(t.title);
        }
    }
    setPlayingUI(true);
  }
  function stopPreview() {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; previewTrackId = null; }
  }

  var queueIds = []; 
  function queueTracks() {
    return queueIds.map(function (id) { return trackRegistry[id] || favs.find(function (f) { return String(f.id) === id; }); }).filter(Boolean);
  }
  var prevBtn = $('#playerPrev'); if (prevBtn) prevBtn.addEventListener('click', function () {
    if (!previewAudio || !previewTrackId) return;
    var q = queueTracks();
    var idx = q.findIndex(function (t) { return String(t.id) === String(previewTrackId); });
    if (idx > 0) { playPreview(q[idx - 1]); return; }
    try { previewAudio.currentTime = 0; } catch (e) {}
    if (previewAudio.paused) { previewAudio.play().catch(function () {}); }
    var prog = $('#playerProgress'); if (prog) prog.style.width = '0%';
    setPlayingUI(true);
  });
  var nextBtn = $('#playerNext'); if (nextBtn) nextBtn.addEventListener('click', function () {
    if (!previewTrackId) return;
    var q = queueTracks();
    var idx = q.findIndex(function (t) { return String(t.id) === String(previewTrackId); });
    if (idx >= 0 && idx < q.length - 1) { playPreview(q[idx + 1]); }
    else if (q.length) { playPreview(q[0]); } 
  });

  var seekDrag = false;
  var seekEl = $('#playerSeek');

  function seekByPoint(clientX) {
    if (!seekEl) return;
    var r = seekEl.getBoundingClientRect();
    if (!r.width) return;
    var p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    var prog = $('#playerProgress'); if (prog) prog.style.width = (p * 100) + '%';
    if (previewAudio && previewAudio.duration && isFinite(previewAudio.duration) && previewAudio.duration > 0) {
      previewAudio.currentTime = p * previewAudio.duration;
    }
  }
  function seekStart(clientX) {
    if (!previewAudio) return;
    seekDrag = true;
    var prog = $('#playerProgress'); if (prog) prog.classList.add('dragging');
    seekByPoint(clientX);
    setPlayingUI(true);
  }
  if (seekEl) {
      seekEl.addEventListener('mousedown', function (e) { e.preventDefault(); seekStart(e.clientX); });
      seekEl.addEventListener('touchstart', function (e) { seekStart(e.touches[0].clientX); }, { passive: true });
  }
  window.addEventListener('mousemove', function (e) { if (seekDrag) seekByPoint(e.clientX); });
  window.addEventListener('mouseup', function () { if (seekDrag) { seekDrag = false; var prog = $('#playerProgress'); if (prog) prog.classList.remove('dragging'); } });
  window.addEventListener('touchmove', function (e) { if (seekDrag && e.touches[0]) seekByPoint(e.touches[0].clientX); });
  window.addEventListener('touchend', function () { if (seekDrag) { seekDrag = false; var prog = $('#playerProgress'); if (prog) prog.classList.remove('dragging'); } });

  var playToggle = $('#playerToggle'); if (playToggle) playToggle.addEventListener('click', function () {
    if (previewAudio) {
      if (previewAudio.paused) { previewAudio.play(); setPlayingUI(true); }
      else { previewAudio.pause(); setPlayingUI(false); }
      return;
    }
    setPlayingUI(!playerState.playing);
  });

  var volume = 100;
  var lastVolume = 100;
  try {
    var savedVol = parseInt(localStorage.getItem('evu_volume') || '100', 10);
    if (savedVol >= 0 && savedVol <= 100) volume = savedVol;
    if (volume > 0) lastVolume = volume;
  } catch (e) {}

  function applyVolume(v) {
    var val = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    if (previewAudio) previewAudio.volume = val / 100;
    var slider = $('#playerVolume');
    if (slider) {
        slider.value = val;
        slider.style.setProperty('--vol', val + '%');
    }
    var ivo = $('#iconVolOn'); if (ivo) ivo.toggleAttribute('hidden', val === 0);
    var ivf = $('#iconVolOff'); if (ivf) ivf.toggleAttribute('hidden', val !== 0);
    try { localStorage.setItem('evu_volume', String(val)); } catch (e) {}
  }
  applyVolume(volume);

  var volSlider = $('#playerVolume'); if (volSlider) volSlider.addEventListener('input', function () {
    volume = parseInt(this.value, 10);
    if (volume > 0) lastVolume = volume;
    applyVolume(volume);
  });
  var muteBtn = $('#playerMute'); if (muteBtn) muteBtn.addEventListener('click', function () {
    if (volume > 0) { lastVolume = volume; volume = 0; }
    else { volume = lastVolume || 100; }
    applyVolume(volume);
  });

  var closeBtn = $('#playerClose'); if (closeBtn) closeBtn.addEventListener('click', function () {
    stopPreview();
    playerState.playing = false;
    var pl = $('#player'); if (pl) pl.hidden = true;
    var prog = $('#playerProgress'); if (prog) prog.style.width = '0%';
  });

  // ===== Инициализация =====
  renderPlaylists();
  renderAlbums();
  loadUserData(); // Загружаем любимое и плейлисты с сервера
  
})();
