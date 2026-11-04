(function () {
  'use strict';

  // ===== Конфигурация =====
  // ВАЖНО: Твой URL на Render (без слэша на конце)
  var API_URL = 'https://evumus.onrender.com'; 
  // URL твоего поисковика музыки (если он крутится на другом сервере)
  var BACKEND_URL = 'http://localhost:8001'; 

  // ===== Telegram SDK =====
  var TG = window.Telegram && window.Telegram.WebApp;
  if (TG) {
    try { TG.ready(); TG.expand(); TG.setHeaderColor && TG.setHeaderColor('#0e1a27'); } catch (e) {}
    document.getElementById('tgHeader').style.display = 'none';
    document.body.classList.add('telegram-mode');
  }

  // ===== Состояние =====
  var THEME_KEY = 'evu_theme';
  var ALBUM_KEY = 'evu_albums_v1'; // Альбомы пока храним в localStorage
  var LANG_KEY = 'evu_language';
  var GLASS_KEY = 'evu_glass_mode';
  
  var THEME_NAMES = { blue: 'Синяя', white: 'Белая', black: 'Чёрная' };
  
  // Данные, которые будут загружаться с сервера
  var library = [];
  var favs = [];
  var playlists = [];
  
  // Локальные данные
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
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  // ===== Работа с API Бэкенда (Neon) =====
  function getAuthHeader() {
    if (!TG || !TG.initData) return {};
    return { 'Authorization': TG.initData };
  }

  async function loadUserData() {
    if (!TG || !TG.initData) {
      console.warn('Открыто вне Telegram, данные не загружены');
      return;
    }
    try {
      var res = await fetch(API_URL + '/api/user_data', {
        headers: getAuthHeader()
      });
      if (!res.ok) throw new Error('Auth failed');
      
      var data = await res.json();
      favs = data.favorites || [];
      library = data.library || [];
      playlists = data.playlists || [];
      
      // Регистрируем треки для плеера
      favs.forEach(registerTrack);
      library.forEach(registerTrack);
      playlists.forEach(function(p) { p.tracks.forEach(registerTrack); });

      // Перерисовываем интерфейс
      refreshAll();
      renderPlaylists();
      favTitle();
    } catch (e) {
      console.error(e);
      toast('Ошибка синхронизации с сервером');
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
      toast('Ошибка создания плейлиста');
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

  // ===== Theme & i18n =====
  function applyTheme(name) {
    theme = name;
    document.documentElement.setAttribute('data-theme', name);
    document.querySelector('meta[name=theme-color]').setAttribute('content',
      name === 'white' ? '#ffffff' : name === 'black' ? '#000000' : '#0b1622');
    $('#themeValue').textContent = THEME_NAMES[name] || name;
    document.documentElement.classList.toggle('glass-mode', !!load(GLASS_KEY, false));
    $$('.theme-option').forEach(function (b) {
      b.classList.toggle('selected', b.getAttribute('data-theme-pick') === name);
    });
    save(THEME_KEY, name);
  }
  applyTheme(theme);
  $('#glassModeToggle').checked = !!load(GLASS_KEY, false);
  $('#glassModeToggle').addEventListener('change', function () {
    save(GLASS_KEY, this.checked);
    document.documentElement.classList.toggle('glass-mode', this.checked);
  });

  // (I18N пропущен для краткости, он у тебя был без изменений)
  // ... вставь сюда свой код I18N и applyLanguage, он не требует правок ...

  // ===== Navigation =====
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
    $('.content').scrollTop = 0;
  }
  $$('.nav__item[data-page]').forEach(function (btn) { btn.addEventListener('click', function () { goPage(btn.getAttribute('data-page')); }); });
  $$('[data-goto]').forEach(function (btn) { btn.addEventListener('click', function () { goPage(btn.getAttribute('data-goto')); }); });

  // ===== Tabs =====
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

  // ===== fetchTracks (Поиск музыки) =====
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

  // ===== Track rendering =====
  function isFav(id) { return favs.some(function(f) { return String(f.id) === String(id); }); }
  
  function playSvg() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l12 7-12 7V5z"/></svg>'; }
  function pauseSvg() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'; }

  // Твой генератор обложек
  function coverFallback(t) { /* Твой старый код coverFallback */ }

  var trackCoverCache = load('evu_track_cover_cache_v6', {});
  var coverRequests = {};
  
  function trackHTML(t) {
    var fav = isFav(t.id);
    var ownCover = t.cover || coverFallback(t);
    t.cover = ownCover;
    
    var cover = '<img class="track__cover track__cover-image js-track-cover" data-title="' + esc(t.title || '') +
      '" data-artist="' + esc(t.artist || '') + '" src="' + ownCover + '" alt="Обложка ' + esc(t.title || '') + '" loading="lazy">';
      
    return '<div class="track" data-id="' + esc(String(t.id)) + '">' +
      cover +
      '<div class="track__meta"><div class="track__title">' + esc(t.title) + '</div>' +
      '<div class="track__artist">' + esc(t.artist) + (t.dur ? ' · ' + esc(t.dur) : '') + '</div></div>' +
      '<div class="track__actions">' +
      '<button class="track__btn js-play" title="Играть" aria-label="Играть">' + playSvg() + '</button>' +
      '<button class="track__btn js-fav' + (fav ? ' active' : '') + '" title="В избранное">' +
      (fav ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.7-7.5-10A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.5 3c0 5.3-7.5 10-7.5 10z"/></svg>'
           : '<svg viewBox="0 0 24 24" fill="none"><path d="M12 20.5s-7.5-4.7-7.5-10A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.5 3c0 5.3-7.5 10-7.5 10z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>') +
      '</button>' +
      '<button class="track__btn js-addpl" title="В плейлист"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h12M4 12h12M4 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18 13.5V9l3 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16.5" cy="16" r="2" stroke="currentColor" stroke-width="2"/></svg></button>' +
      '</div></div>';
  }

  function hydrateTrackCovers(container) { /* Твой старый код */ }
  
  function renderList(container, tracks) {
    container.innerHTML = tracks.map(trackHTML).join('');
    hydrateTrackCovers(container);
    updateRowPlayState();
  }

  // ===== Pages =====
  function renderMyMusic() {
    var tracks = library;
    $('#myEmpty').hidden = tracks.length > 0;
    $('#myCount').textContent = 'Треков: ' + tracks.length;
    renderList($('#myList'), tracks);
  }
  function favTitle() {
    $('#favTitle').textContent = favTab === 'fav' ? 'Любимое' : 'Моя музыка';
  }
  function renderFavs() {
    var tracks = favs;
    $('#favEmpty').hidden = tracks.length > 0;
    $('#favCount').textContent = 'Треков: ' + tracks.length;
    renderList($('#favList'), tracks);
    $('#favBadge').textContent = favs.length;
  }
  function renderCollection() {
    var tracks = library;
    $('#collEmpty').hidden = tracks.length > 0;
    $('#collCount').textContent = 'Треков: ' + tracks.length;
    renderList($('#collList'), tracks);
  }

  // ===== Search =====
  function renderSearch() { /* Твой старый код renderSearch */ }
  $('#searchInput').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSearch, 700);
  });
  $('#searchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { clearTimeout(searchTimer); renderSearch(); }
  });

  // ===== Add to playlist =====
  var addToPlaylistTrackId = null;
  var activePlIdx = null;

  function openAddToPlaylist(trackId) {
    addToPlaylistTrackId = trackId;
    var list = $('#playlistPickList');
    var picks = playlists.map(function (p, idx) { return '<button class="playlist-pick-item" data-pl-idx="' + idx + '"><span>🎵</span><b>' + esc(p.name) + '</b><span>' + (p.count || 0) + ' треков</span></button>'; });
    // Альбомы добавляем локально
    albums.forEach(function (a, idx) { picks.push('<button class="playlist-pick-item" data-album-idx="' + idx + '"><span>💿</span><b>' + esc(a.name) + '</b><span>' + (a.tracks || []).length + ' треков · альбом</span></button>'); });
    
    list.innerHTML = picks.length ? picks.join('') : '<p class="empty-hint">Пока нет плейлистов или альбомов.</p>';
    $('#plNewRow').hidden = true;
    $('#addToPlaylistModal').hidden = false;
  }
  
  function closeAddToPlaylist() { $('#addToPlaylistModal').hidden = true; addToPlaylistTrackId = null; }
  document.getElementById('cancelAddToPlaylist').addEventListener('click', closeAddToPlaylist);

  document.getElementById('createPlaylistInline').addEventListener('click', function () {
    $('#plNewRow').hidden = false;
    $('#plNewInput').focus();
  });
  
  async function createPlFromInline() {
    var name = ($('#plNewInput').value || '').trim();
    if (!name) { toast('Введи название'); return; }
    if (playlists.some(function (p) { return (p.name || '').toLowerCase() === name.toLowerCase(); })) {
      toast('Такой плейлист уже есть'); return;
    }
    
    $('#plNewSave').disabled = true;
    var newPl = await apiCreatePlaylist(name);
    $('#plNewSave').disabled = false;

    if (newPl) {
        playlists.push(newPl);
        $('#plNewInput').value = '';
        $('#plNewRow').hidden = true;
        renderPlaylists();
        openAddToPlaylist(addToPlaylistTrackId); 
        toast('Плейлист «' + name + '» создан');
    }
  }
  document.getElementById('plNewSave').addEventListener('click', createPlFromInline);

  document.getElementById('addToPlaylistModal').addEventListener('click', async function (e) {
    var btn = e.target.closest('.playlist-pick-item');
    if (!btn) return;
    if (!addToPlaylistTrackId) { toast('Трек не найден'); return; }
    
    var tr = findTrack(addToPlaylistTrackId);
    if (!tr) return;

    var albumIdx = btn.hasAttribute('data-album-idx') ? parseInt(btn.getAttribute('data-album-idx'), 10) : -1;
    
    if (albumIdx >= 0) {
        // Локальные альбомы
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
        // Плейлисты на сервере
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

  // ===== Actions =====
  function findTrack(id) {
    return trackRegistry[id] || favs.find(function (f) { return String(f.id) === String(id); }) || library.find(function (l) { return String(l.id) === String(id); });
  }
  
  function triggerPlay(row) { /* Твой старый код */ }

  document.getElementById('content').addEventListener('click', function (e) {
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

  // ===== Playlists =====
  function renderPlaylists() {
    var grid = $('#playlistGrid');
    var html = '';
    playlists.forEach(function (p, idx) {
      html += '<div class="playlist-card" data-pl="' + idx + '"><span class="playlist-card__plus">🎵</span><b>' + esc(p.name) + '</b><span>' + (p.count || 0) + ' треков</span></div>';
    });
    html += '<button class="playlist-card playlist-card--new" id="newPlaylistCard"><span class="playlist-card__plus">+</span><b>Новый плейлист</b><span>Добавить плейлист</span></button>';
    grid.innerHTML = html;
    $('#newPlaylistCard').addEventListener('click', openPlaylistModal);
    $$('.playlist-card[data-pl]').forEach(function (card) {
      card.addEventListener('click', function () { openPlaylist(parseInt(card.getAttribute('data-pl'), 10)); });
    });
  }
  $('#plBack').addEventListener('click', function () { goPage('playlists'); });
  
  function openPlaylist(idx) {
    if (!playlists[idx]) { goPage('playlists'); return; }
    activePlIdx = idx;
    renderPlaylistDetail();
    goPage('plview');
  }
  function renderPlaylistDetail() {
    var pl = playlists[activePlIdx];
    if (!pl) return;
    $('#plViewTitle').textContent = pl.name;
    var tracks = (pl.tracks || []).filter(Boolean);
    $('#plViewEmpty').hidden = tracks.length > 0;
    renderList($('#plViewList'), tracks);
  }
  function openPlaylistModal() {
    $('#playlistNameInput').value = '';
    $('#playlistModal').hidden = false;
    setTimeout(function () { $('#playlistNameInput').focus(); }, 50);
  }
  function closePlaylistModal() { $('#playlistModal').hidden = true; }
  $('#btnCreatePlaylist').addEventListener('click', openPlaylistModal);
  $('#cancelPlaylist').addEventListener('click', closePlaylistModal);
  
  $('#savePlaylist').addEventListener('click', async function () {
    var name = ($('#playlistNameInput').value || '').trim();
    if (!name) { toast('Введи название'); return; }
    $('#savePlaylist').disabled = true;
    var newPl = await apiCreatePlaylist(name);
    $('#savePlaylist').disabled = false;
    
    if (newPl) {
        playlists.push(newPl);
        closePlaylistModal();
        renderPlaylists();
        toast('Плейлист «' + name + '» создан');
    }
  });

  // ===== Albums (Локально) =====
  function renderAlbums() { /* Твой старый код */ }
  function openAlbum(idx) { /* Твой старый код */ }
  function renderAlbumDetail() { /* Твой старый код */ }
  function openAlbumModal() { /* Твой старый код */ }
  // Обработчики альбомов оставляем как было

  // ===== Player & Settings =====
  // Оставляем весь старый код для плеера, перемотки, громкости, смены темы и настроек
  // (Вставь сюда свой старый код от "// ===== Theme modal =====" до "// ===== Init =====")
  
  // ... ВСТАВЬ СЮДА ОСТАЛЬНОЙ КОД ИЗ СВОЕГО ФАЙЛА (ПЛЕЕР, ГРОМКОСТЬ, НАСТРОЙКИ) ...

  // ===== Init =====
  renderPlaylists();
  renderAlbums();
  
  // Запускаем загрузку данных с сервера после инициализации
  loadUserData();
  
})();
