(function () {
  'use strict';

  var API_URL = ''; 

  // ПРИНУДИТЕЛЬНО ПРЯЧЕМ ПЛЕЕР ПРИ СТАРТЕ
  var pcInit = document.getElementById('playerContainer'); if (pcInit) pcInit.hidden = true;
  var plInit = document.getElementById('player'); if (plInit) plInit.hidden = true;

  var TG = window.Telegram && window.Telegram.WebApp;
  if (TG) {
    try { TG.ready(); TG.expand(); TG.setHeaderColor && TG.setHeaderColor('#0e1a27'); } catch (e) {}
    var tgHeader = document.getElementById('tgHeader');
    if (tgHeader) tgHeader.style.display = 'none';
    document.body.classList.add('telegram-mode');
  }

  var THEME_KEY = 'evu_theme';
  var ALBUM_KEY = 'evu_albums_v1';
  var LANG_KEY = 'evu_language';

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

  var trackRegistry = {};
  var searchTimer = null;
  var searchRequestId = 0;   

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function coverColor(n) { return COVER_COLORS[(n || 0) % COVER_COLORS.length]; }
  function coverLetter(t) { return (t || '?').charAt(0).toUpperCase(); }
  function toast(msg) { var el = $('#toast'); if(!el) return; el.textContent = msg; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(function () { el.hidden = true; }, 2200); }

  // ===== API Запросы =====
  function getAuthHeader() { return (TG && TG.initData) ? { 'Authorization': TG.initData } : {}; }

  async function loadUserData() {
    if (!TG || !TG.initData) return;
    try {
      var res = await fetch(API_URL + '/api/user_data', { headers: getAuthHeader() });
      if (!res.ok) throw new Error('Auth failed');
      var data = await res.json();
      favs = data.favorites || []; library = data.library || []; playlists = data.playlists || [];
      favs.forEach(registerTrack); library.forEach(registerTrack); playlists.forEach(function(p) { if(p.tracks) p.tracks.forEach(registerTrack); });
      refreshAll(); renderPlaylists(); 
    } catch (e) { console.error(e); }
  }

  async function apiToggleFav(tr) {
    try {
      var res = await fetch(API_URL + '/api/favorites', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
        body: JSON.stringify({ id: String(tr.id), title: tr.title, artist: tr.artist, duration: tr.dur || '', cover: tr.cover || '', source: tr.source || '' })
      });
      if (!res.ok) throw new Error();
      var data = await res.json();
      if (data.status === 'added') { favs.push(tr); toast('Добавлено в любимое'); } 
      else { favs = favs.filter(function(f) { return String(f.id) !== String(tr.id); }); toast('Убрано из любимого'); }
      refreshAll();
    } catch (e) { toast('Ошибка сохранения'); }
  }

  async function apiCreatePlaylist(name) {
    try {
      var res = await fetch(API_URL + '/api/playlists', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
        body: JSON.stringify({ title: name })
      });
      if (!res.ok) throw new Error();
      return await res.json();
    } catch (e) { toast('Ошибка создания'); return null; }
  }

  async function apiAddTrackToPlaylist(playlistId, tr) {
    try {
      var res = await fetch(API_URL + '/api/playlists/add_track', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
        body: JSON.stringify({ playlist_id: playlistId, id: String(tr.id), title: tr.title, artist: tr.artist, duration: tr.dur || '', cover: tr.cover || '', source: tr.source || '' })
      });
      return res.ok;
    } catch (e) { return false; }
  }

  // ===== Тема =====
  function applyTheme(name) {
    theme = name; document.documentElement.setAttribute('data-theme', name);
    var meta = document.querySelector('meta[name=theme-color]'); if(meta) meta.setAttribute('content', name === 'white' ? '#ffffff' : name === 'black' ? '#000000' : '#0b1622');
    var tv = $('#themeValue'); if (tv) tv.textContent = THEME_NAMES[name] || name;
    $$('.theme-option').forEach(function (b) { b.classList.toggle('selected', b.getAttribute('data-theme-pick') === name); });
    save(THEME_KEY, name);
  }
  applyTheme(theme);

  // ===== Навигация =====
  (function installSupportBannerOnPages() {
    var original = document.querySelector('#page-mymusic .support-banner'); if (!original) return;
    document.querySelectorAll('.page:not(#page-settings)').forEach(function(page) { if (!page.querySelector('.support-banner')) page.insertBefore(original.cloneNode(true), page.firstChild); });
  })();

  function goPage(name) {
    $$('.page').forEach(function (p) { p.classList.remove('active'); });
    var page = $('#page-' + name); if (page) page.classList.add('active');
    $$('.nav__item[data-page]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-page') === name); });
    var content = $('.content'); if(content) content.scrollTop = 0;
  }
  $$('.nav__item[data-page]').forEach(function (btn) { btn.addEventListener('click', function () { goPage(btn.getAttribute('data-page')); }); });
  $$('[data-goto]').forEach(function (btn) { btn.addEventListener('click', function () { goPage(btn.getAttribute('data-goto')); }); });

  // ===== Tabs =====
  function bindTabs(selector, attr, onChange) {
    $$(selector).forEach(function (tab) { tab.addEventListener('click', function () { $$(selector).forEach(function (t) { t.classList.remove('active'); }); tab.classList.add('active'); onChange(tab.getAttribute(attr)); }); });
  }
  bindTabs('[data-mymusic-tab]', 'data-mymusic-tab', function (v) { mymusicTab = v; renderMyMusic(); });
  bindTabs('[data-search-tab]', 'data-search-tab', function (v) { searchTab = v; renderSearch(); });

  function registerTrack(t) { if (!t || t.id == null) return t; trackRegistry[String(t.id)] = t; return t; }

  // ===== Поиск =====
  function absUrl(u) { if (!u) return ''; if (u.indexOf('http') === 0) return u; return API_URL + u; }

  function fetchTracks(query) {
    var url = API_URL + '/api/search?q=' + encodeURIComponent(query);
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('backend HTTP ' + r.status); return r.json(); }).then(function (d) {
      return (d.tracks || []).map(function (t) {
        var dur = t.dur || (t.duration ? Math.floor(t.duration / 60) + ':' + ('0' + (t.duration % 60)).slice(-2) : '');
        return { id: String(t.id), title: t.title, artist: t.artist || '', dur: dur, cover: absUrl(t.cover || ''), preview: absUrl(t.preview_url || t.preview || t.stream_url || ''), full: t.full !== false, source: t.source || 'ru' };
      }).filter(function (t) { return !!t.preview && t.full !== false; });
    });
  }

  // ===== Отрисовка =====
  function isFav(id) { return favs.some(function(f) { return String(f.id) === String(id); }); }
  function playSvg() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l12 7-12 7V5z"/></svg>'; }
  function pauseSvg() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'; }

  function coverFallback(t) {
    var title = String((t && t.title) || 'Без названия').slice(0, 48); var artist = String((t && t.artist) || 'EvuMusic').slice(0, 42);
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

  var trackCoverCache = load('evu_track_cover_cache_v6', {}); var coverRequests = {};
  function hydrateTrackCovers(container) {
    container.querySelectorAll('.js-track-cover').forEach(function(img) {
      var title = (img.getAttribute('data-title') || '').trim(); var artist = (img.getAttribute('data-artist') || '').trim(); if (!title) return;
      var key = (title + '|' + artist).toLowerCase();
      img.addEventListener('error', function() { img.onerror = null; img.src = coverFallback({id: img.closest('.track') && img.closest('.track').getAttribute('data-id'), title: title, artist: artist}); }, {once:true});
      
      if (trackCoverCache[key]) { img.src = trackCoverCache[key]; return; }
      if (coverRequests[key]) return;
      coverRequests[key] = true;
      
      fetch(API_URL + '/api/track-cover?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist || '')).then(function(r) { return r.json(); }).then(function(d) {
        if (!d || !d.cover) return;
        var image = d.cover;
        trackCoverCache[key] = image; try { save('evu_track_cover_cache_v6', trackCoverCache); } catch(e) {}
        
        document.querySelectorAll('.js-track-cover[data-title]').forEach(function(el) {
          if (((el.getAttribute('data-title') || '') + '|' + (el.getAttribute('data-artist') || '')).toLowerCase() === key) el.src = image;
        });

        if (previewTrackId) {
            var playingTrack = trackRegistry[previewTrackId];
            if (playingTrack && ((playingTrack.title || '') + '|' + (playingTrack.artist || '')).toLowerCase() === key) {
                playingTrack.cover = image;
                var pc = document.getElementById('playerCover');
                if (pc) { pc.innerHTML = '<img src="' + esc(image) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'; pc.style.background = 'none'; }
            }
        }
      }).catch(function() {}).then(function(){ delete coverRequests[key]; });
    });
  }

  function trackHTML(t) {
    var fav = isFav(t.id);
    var ownCover = trackCoverCache[(String(t.title || '') + '|' + String(t.artist || '')).toLowerCase()] || (t.cover ? absUrl(t.cover) : '') || coverFallback(t);
    t.cover = ownCover;
    var cover = '<img class="track__cover track__cover-image js-track-cover" data-title="' + esc(t.title || '') + '" data-artist="' + esc(t.artist || '') + '" src="' + ownCover + '" alt="" loading="lazy">';
    return '<div class="track" data-id="' + esc(String(t.id)) + '">' + cover +
      '<div class="track__meta"><div class="track__title">' + esc(t.title) + '</div><div class="track__artist">' + esc(t.artist) + (t.dur ? ' · ' + esc(t.dur) : '') + '</div></div>' +
      '<div class="track__actions"><button class="track__btn js-play" title="Играть">' + playSvg() + '</button>' +
      '<button class="track__btn js-fav' + (fav ? ' active' : '') + '" title="В избранное">' + (fav ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.7-7.5-10A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.5 3c0 5.3-7.5 10-7.5 10z"/></svg>' : '<svg viewBox="0 0 24 24" fill="none"><path d="M12 20.5s-7.5-4.7-7.5-10A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.5 3c0 5.3-7.5 10-7.5 10z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>') + '</button>' +
      '<button class="track__btn js-addpl" title="В плейлист"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h12M4 12h12M4 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18 13.5V9l3 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16.5" cy="16" r="2" stroke="currentColor" stroke-width="2"/></svg></button></div></div>';
  }

  function renderList(container, tracks) { if (!container) return; container.innerHTML = tracks.map(trackHTML).join(''); hydrateTrackCovers(container); updateRowPlayState(); }

  // ===== Страницы =====
  
  // ОБЪЕДИНЕННАЯ МОЯ МУЗЫКА (Все треки / Любимое)
  function renderMyMusic() { 
    var tracks = (mymusicTab === 'all') ? library : favs; 
    var title = (mymusicTab === 'all') ? 'Моя музыка' : 'Любимое';
    
    var titleEl = $('#myPageTitle'); if (titleEl) titleEl.textContent = title;
    var el = $('#myEmpty'); if(el) el.hidden = tracks.length > 0; 
    var c = $('#myCount'); if(c) c.textContent = 'Треков: ' + tracks.length; 
    renderList($('#myList'), tracks); 
  }

  function renderCollection() { var tracks = library; var el = $('#collEmpty'); if(el) el.hidden = tracks.length > 0; var c = $('#collCount'); if(c) c.textContent = 'Треков: ' + tracks.length; renderList($('#collList'), tracks); }

  function renderSearch() {
    var input = $('#searchInput'); if (!input) return; var q = (input.value || '').trim();
    if (searchTab === 'albums') { renderAlbumSearch(q); renderCollection(); return; }
    if (!q) { var empty = $('#searchEmpty'); if(empty) { empty.hidden = false; empty.innerHTML = '<p>Начни вводить название — полные треки</p>'; } var res = $('#searchResults'); if(res) res.innerHTML = ''; renderCollection(); return; }
    var empty = $('#searchEmpty'); if(empty) empty.hidden = true; var res = $('#searchResults'); if(res) res.innerHTML = '<div class="search-hint">Ищу треки…</div>';
    var reqId = ++searchRequestId;
    fetchTracks(q).then(function (tracks) {
      if (reqId !== searchRequestId) return; tracks.forEach(registerTrack);
      if (!tracks || !tracks.length) { if(empty) { empty.hidden = false; empty.innerHTML = '<p>Ничего не найдено по «' + esc(q) + '»</p>'; } if(res) res.innerHTML = ''; return; }
      if(empty) empty.hidden = true; renderList(res, tracks);
    }).catch(function () { if (reqId !== searchRequestId) return; if(empty) { empty.hidden = false; empty.innerHTML = '<p>Ошибка поиска. Попробуй ещё раз.</p>'; } if(res) res.innerHTML = ''; });
    renderCollection();
  }

  $('#searchInput').addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 700); });
  $('#searchInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearTimeout(searchTimer); renderSearch(); } });

  // ===== Альбомы (iTunes) =====
  var albumSearchRequestId = 0;
  function renderAlbumSearch(query) {
    var results = $('#searchResults'); var empty = $('#searchEmpty');
    if (!query) { if(results) results.innerHTML = ''; if(empty) { empty.hidden = false; empty.innerHTML = '<p>Введи название альбома или исполнителя</p>'; } return; }
    var requestId = ++albumSearchRequestId; if(empty) empty.hidden = true; if(results) results.innerHTML = '<div class="search-hint">Ищу альбомы…</div>';
    fetch(API_URL + '/api/search/albums?q=' + encodeURIComponent(query)).then(function(r) { return r.json(); }).then(function(data) {
      if (requestId !== albumSearchRequestId || searchTab !== 'albums') return;
      var items = data.albums || [];
      if (!items.length) { if(results) results.innerHTML = ''; if(empty) { empty.hidden = false; empty.innerHTML = '<p>Альбомы не найдены.</p>'; } return; }
      if(empty) empty.hidden = true;
      if(results) {
        results.innerHTML = '<div class="search-album-grid">' + items.map(function(a) {
          return '<button class="search-album-card" data-deezer-album="' + esc(a.id) + '"><img src="' + esc(absUrl(a.cover || '')) + '" alt="" loading="lazy"><span class="search-album-card__meta"><b>' + esc(a.title || 'Без названия') + '</b><small>' + esc(a.artist || 'Неизвестен') + '</small><small>' + esc(String(a.nb_tracks || 0)) + ' треков</small></span></button>';
        }).join('') + '</div>';
        results.querySelectorAll('[data-deezer-album]').forEach(function(card) { card.addEventListener('click', function() { openAlbumTracks(card.getAttribute('data-deezer-album')); }); });
      }
    }).catch(function() { if (requestId !== albumSearchRequestId) return; if(results) results.innerHTML = ''; if(empty) { empty.hidden = false; empty.innerHTML = '<p>Ошибка загрузки альбомов.</p>'; } });
  }

  function openAlbumTracks(albumId) {
    var results = $('#searchResults'); var empty = $('#searchEmpty');
    if(results) results.innerHTML = '<div class="search-hint">Загружаю альбом…</div>'; if(empty) empty.hidden = true;
    // ИСПРАВЛЕНО: /api/deezer/album/ заменен на /api/itunes/album/
    fetch(API_URL + '/api/itunes/album/' + encodeURIComponent(albumId)).then(function(r) { return r.json(); }).then(function(data) {
      var tracks = (data.tracks || []).map(function(t) {
        var track = { id: 'itunes_' + t.id, title: t.title || 'Без названия', artist: t.artist || '', dur: t.dur || '', cover: absUrl(t.cover || ''), preview: t.preview || '', full: false, source: 'itunes' };
        registerTrack(track); return track;
      });
      if(results) {
        results.innerHTML = '<div class="album-search-detail"><button class="btn-back" id="albumTracksBack">← Назад</button><div class="album-search-heading"><img src="' + esc(absUrl(data.album.cover || '')) + '" alt=""><div><h3>' + esc(data.album.title || 'Альбом') + '</h3><p>' + esc(data.album.artist || '') + '</p></div></div><div class="track-list" id="albumTracksList"></div></div>';
        var db = $('#albumTracksBack'); if(db) db.addEventListener('click', function() { renderAlbumSearch(($('#searchInput').value || '').trim()); });
        renderList($('#albumTracksList'), tracks);
      }
    }).catch(function() { if(results) results.innerHTML = '<p class="search-empty">Ошибка загрузки.</p>'; });
  }

  // ===== Добавление в плейлист =====
  var addToPlaylistTrackId = null; var activePlIdx = null;

  function openAddToPlaylist(trackId) {
    addToPlaylistTrackId = trackId; var list = $('#playlistPickList');
    var picks = playlists.map(function (p, idx) { return '<button class="playlist-pick-item" data-pl-idx="' + idx + '"><span>🎵</span><b>' + esc(p.name) + '</b><span>' + (p.count || 0) + ' треков</span></button>'; });
    albums.forEach(function (a, idx) { picks.push('<button class="playlist-pick-item" data-album-idx="' + idx + '"><span>💿</span><b>' + esc(a.name) + '</b><span>' + (a.tracks || []).length + ' треков</span></button>'); });
    if(list) list.innerHTML = picks.length ? picks.join('') : '<p class="empty-hint">Пока нет плейлистов.</p>';
    var row = $('#plNewRow'); if(row) row.hidden = true; var modal = $('#addToPlaylistModal'); if(modal) modal.hidden = false;
  }
  function closeAddToPlaylist() { var modal = $('#addToPlaylistModal'); if(modal) modal.hidden = true; addToPlaylistTrackId = null; }
  var cAdd = document.getElementById('cancelAddToPlaylist'); if(cAdd) cAdd.addEventListener('click', closeAddToPlaylist);
  
  var crInline = document.getElementById('createPlaylistInline');
  if (crInline) crInline.addEventListener('click', function () { var row = $('#plNewRow'); if(row) row.hidden = false; var inp = $('#plNewInput'); if(inp) inp.focus(); });
  
  async function createPlFromInline() {
    var inp = $('#plNewInput'); if (!inp) return; var name = (inp.value || '').trim();
    if (!name) { toast('Введи название'); return; }
    var btn = $('#plNewSave'); if(btn) btn.disabled = true; var newPl = await apiCreatePlaylist(name); if(btn) btn.disabled = false;
    if (newPl) { playlists.push(newPl); inp.value = ''; var row = $('#plNewRow'); if(row) row.hidden = true; renderPlaylists(); openAddToPlaylist(addToPlaylistTrackId); toast('Плейлист создан'); }
  }
  var plSave = document.getElementById('plNewSave'); if(plSave) plSave.addEventListener('click', createPlFromInline);

  var addMod = document.getElementById('addToPlaylistModal');
  if (addMod) addMod.addEventListener('click', async function (e) {
    var btn = e.target.closest('.playlist-pick-item'); if (!btn) return;
    if (!addToPlaylistTrackId) return; var tr = findTrack(addToPlaylistTrackId); if (!tr) return;
    var albumIdx = btn.hasAttribute('data-album-idx') ? parseInt(btn.getAttribute('data-album-idx'), 10) : -1;
    if (albumIdx >= 0) {
        var target = albums[albumIdx]; if (!target.tracks) target.tracks = [];
        if (!target.tracks.some(function (x) { return String(x.id) === String(tr.id); })) { target.tracks.push(tr); save(ALBUM_KEY, albums); toast('Добавлено в альбом'); renderAlbums(); }
        closeAddToPlaylist();
    } else {
        var pl = playlists[parseInt(btn.getAttribute('data-pl-idx'), 10)]; if (!pl) return;
        btn.disabled = true; var success = await apiAddTrackToPlaylist(pl.id, tr); btn.disabled = false;
        if (success) { if(!pl.tracks) pl.tracks = []; if(!pl.tracks.some(function(x){ return String(x.id) === String(tr.id); })) { pl.tracks.push(tr); pl.count = pl.tracks.length; } toast('Добавлено в плейлист'); renderPlaylists(); closeAddToPlaylist(); }
        else toast('Ошибка сервера');
    }
  });

  // ===== Действия =====
  function findTrack(id) { return trackRegistry[id] || favs.find(function (f) { return String(f.id) === String(id); }) || library.find(function (l) { return String(l.id) === String(id); }); }
  function triggerPlay(row) {
    if (!row) return; var id = row.getAttribute('data-id'); var tr = findTrack(id); if (!tr) return;
    if (!tr.preview) { toast('Нет превью'); return; }
    queueIds = []; row.parentElement.querySelectorAll('.track').forEach(function (r) { queueIds.push(r.getAttribute('data-id')); }); playPreview(tr);
  }

  var contentEl = document.getElementById('content');
  if (contentEl) contentEl.addEventListener('click', function (e) {
    var coverEl = e.target.closest('.track__cover'); if (coverEl) { triggerPlay(coverEl.closest('.track')); return; }
    var btn = e.target.closest('.track__btn'); if (!btn) return; var row = btn.closest('.track'); var id = row.getAttribute('data-id'); var tr = findTrack(id);
    if (btn.classList.contains('js-play')) triggerPlay(row);
    else if (btn.classList.contains('js-fav')) { if (!tr) return; btn.disabled = true; apiToggleFav(tr).then(function() { btn.disabled = false; }); }
    else if (btn.classList.contains('js-addpl')) { if (!tr) return; openAddToPlaylist(id); }
  });

  function refreshAll() { renderMyMusic(); renderSearch(); }

  function renderPlaylists() {
    var grid = $('#playlistGrid'); if (!grid) return; var html = '';
    playlists.forEach(function (p, idx) { html += '<div class="playlist-card" data-pl="' + idx + '"><span class="playlist-card__plus">🎵</span><b>' + esc(p.name) + '</b><span>' + (p.count || 0) + ' треков</span></div>'; });
    html += '<button class="playlist-card playlist-card--new" id="newPlaylistCard"><span class="playlist-card__plus">+</span><b>Новый плейлист</b><span>Добавить плейлист</span></button>'; grid.innerHTML = html;
    var newPl = $('#newPlaylistCard'); if(newPl) newPl.addEventListener('click', openPlaylistModal);
    $$('.playlist-card[data-pl]').forEach(function (card) { card.addEventListener('click', function () { openPlaylist(parseInt(card.getAttribute('data-pl'), 10)); }); });
  }
  var plBack = $('#plBack'); if (plBack) plBack.addEventListener('click', function () { goPage('playlists'); });
  function openPlaylist(idx) { if (!playlists[idx]) { goPage('playlists'); return; } activePlIdx = idx; renderPlaylistDetail(); goPage('plview'); }
  function renderPlaylistDetail() { var pl = playlists[activePlIdx]; if (!pl) return; var t = $('#plViewTitle'); if(t) t.textContent = pl.name; var tracks = (pl.tracks || []).filter(Boolean); var e = $('#plViewEmpty'); if(e) e.hidden = tracks.length > 0; renderList($('#plViewList'), tracks); }
  function openPlaylistModal() { var inp = $('#playlistNameInput'); if(inp) inp.value = ''; var m = $('#playlistModal'); if(m) m.hidden = false; }
  function closePlaylistModal() { var m = $('#playlistModal'); if(m) m.hidden = true; }
  
  var createPlBtn = $('#btnCreatePlaylist'); if (createPlBtn) createPlBtn.addEventListener('click', openPlaylistModal);
  var cancelPl = $('#cancelPlaylist'); if (cancelPl) cancelPl.addEventListener('click', closePlaylistModal);
  var savePl = $('#savePlaylist'); if (savePl) savePl.addEventListener('click', async function () {
    var inp = $('#playlistNameInput'); if (!inp) return; var name = (inp.value || '').trim(); if (!name) { toast('Введи название'); return; }
    savePl.disabled = true; var newPl = await apiCreatePlaylist(name); savePl.disabled = false;
    if (newPl) { playlists.push(newPl); closePlaylistModal(); renderPlaylists(); toast('Плейлист создан'); }
  });

  // ===== Альбомы (Локально) =====
  function renderAlbums() {
    var grid = $('#albumGrid'); if (!grid) return; var e = $('#albumEmpty'); if(e) e.hidden = albums.length > 0;
    grid.innerHTML = albums.map(function (a, idx) { return '<button class="playlist-card" data-album="' + idx + '"><span class="playlist-card__plus">💿</span><b>' + esc(a.name) + '</b><span>' + ((a.tracks || []).length) + ' треков</span></button>'; }).join('');
    grid.querySelectorAll('[data-album]').forEach(function (card) { card.addEventListener('click', function () { openAlbum(parseInt(card.dataset.album, 10)); }); });
  }
  function openAlbum(idx) { if (!albums[idx]) return; activeAlbumIdx = idx; renderAlbumDetail(); goPage('alview'); }
  function renderAlbumDetail() { var a = albums[activeAlbumIdx]; if (!a) return; var t = $('#albumViewTitle'); if(t) t.textContent = a.name; var tracks = (a.tracks || []).filter(Boolean); var e = $('#albumViewEmpty'); if(e) e.hidden = tracks.length > 0; renderList($('#albumViewList'), tracks); }
  function openAlbumModal() { var inp = $('#albumNameInput'); if(inp) inp.value = ''; var m = $('#albumModal'); if(m) m.hidden = false; }
  
  var btnAl = $('#btnCreateAlbum'); if (btnAl) btnAl.addEventListener('click', openAlbumModal);
  var cancelAl = $('#cancelAlbum'); if (cancelAl) cancelAl.addEventListener('click', function () { var m = $('#albumModal'); if(m) m.hidden = true; });
  var saveAl = $('#saveAlbum'); if (saveAl) saveAl.addEventListener('click', function () {
    var inp = $('#albumNameInput'); if (!inp) return; var name = (inp.value || '').trim(); if (!name) { toast('Введи название'); return; }
    if (albums.some(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })) { toast('Такой альбом уже есть'); return; }
    albums.push({ name: name, tracks: [], createdAt: Date.now() }); save(ALBUM_KEY, albums); var m = $('#albumModal'); if(m) m.hidden = true; renderAlbums(); toast('Альбом создан');
  });
  var alBack = $('#albumBack'); if (alBack) alBack.addEventListener('click', function () { goPage('albums'); });

  // ===== Настройки =====
  var openT = $('#openThemeModal'); if (openT) openT.addEventListener('click', function () { var m = $('#themeModal'); if(m) m.hidden = false; });
  var closeT = $('#closeThemeModal'); if (closeT) closeT.addEventListener('click', function () { var m = $('#themeModal'); if(m) m.hidden = true; });
  var tMod = $('#themeModal'); if (tMod) tMod.addEventListener('click', function (e) { if (e.target === tMod) tMod.hidden = true; });
  $$('.theme-option').forEach(function (b) { b.addEventListener('click', function () { applyTheme(b.getAttribute('data-theme-pick')); toast('Тема: ' + THEME_NAMES[b.getAttribute('data-theme-pick')]); }); });
  var btnFeed = $('#btnFeedback'); if (btnFeed) btnFeed.addEventListener('click', function () { window.open('https://t.me/EvuMusic', '_blank'); });
  
  var confirmCb = null;
  function showConfirm(text, cb) { var t = $('#confirmText'); if(t) t.textContent = text; var o = $('#confirmOverlay'); if(o) o.hidden = false; confirmCb = cb; }
  var cCancel = $('#confirmCancel'); if (cCancel) cCancel.addEventListener('click', function () { var o = $('#confirmOverlay'); if(o) o.hidden = true; confirmCb = null; });
  var cOk = $('#confirmOk'); if (cOk) cOk.addEventListener('click', function () { var o = $('#confirmOverlay'); if(o) o.hidden = true; if (confirmCb) confirmCb(); confirmCb = null; });
  var btnDel = $('#btnDelete'); if (btnDel) btnDel.addEventListener('click', function () { showConfirm('Удалить личный кабинет?', function () { library = []; favs = []; playlists = []; albums = []; save(ALBUM_KEY, albums); refreshAll(); renderPlaylists(); renderAlbums(); toast('Локальные данные удалены'); }); });

  // ===== Плеер =====
  var previewAudio = null; var previewTrackId = null; var playerState = { playing: false };
  window.__evuAudio = function () { return previewAudio; };

  function startAudio(url, t) {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    previewTrackId = String(t.id); previewAudio = new Audio(url);
    previewAudio.preload = 'auto'; previewAudio.crossOrigin = 'anonymous'; previewAudio.volume = volume / 100; previewAudio.currentTime = 0; previewAudio.load();
    var playPromise = previewAudio.play(); if (playPromise && playPromise.catch) playPromise.catch(function () {});
    showPlayer(t); setPlayingUI(true);
    previewAudio.ontimeupdate = function () { if (previewAudio && !seekDrag) { var dur = (previewAudio.duration && isFinite(previewAudio.duration) && previewAudio.duration > 0) ? previewAudio.duration : 30; var p = $('#playerProgress'); if(p) p.style.width = Math.min(100, (previewAudio.currentTime / dur * 100)) + '%'; } };
    previewAudio.onended = function () { var p = $('#playerProgress'); if(p) p.style.width = '0%'; var idx = queueIds.indexOf(previewTrackId); if (idx >= 0 && idx < queueIds.length - 1) { var nextT = (trackRegistry[queueIds[idx + 1]] || findTrack(queueIds[idx + 1])); if (nextT && nextT.preview) { playPreview(nextT); return; } } setPlayingUI(false); };
    previewAudio.onplay = function () { setPlayingUI(true); }; previewAudio.onpause = function () { setPlayingUI(false); };
  }

  function playPreview(t) {
    if (previewAudio && previewTrackId === String(t.id)) { if (previewAudio.paused) { previewAudio.play(); setPlayingUI(true); } else { previewAudio.pause(); setPlayingUI(false); } return; }
    var key = ((t.title || '') + '|' + (t.artist || '')).toLowerCase();
    if (trackCoverCache[key]) t.cover = trackCoverCache[key];
    startAudio(t.preview, t); showPlayer(t); setPlayingUI(true);
  }
  function setPlayingUI(on) {
    playerState.playing = on; var ip = $('#iconPlay'); if(ip) ip.toggleAttribute('hidden', on); var ipa = $('#iconPause'); if(ipa) ipa.toggleAttribute('hidden', !on); var pl = $('#player'); if(pl) pl.classList.toggle('is-playing', on); updateRowPlayState();
  }
  function updateRowPlayState() { $$('.track').forEach(function (r) { var b = r.querySelector('.track__btn.js-play'); if (!b) return; var cur = !!(onPlaying() && previewTrackId && r.getAttribute('data-id') === previewTrackId); r.classList.toggle('is-current', cur); b.innerHTML = cur ? pauseSvg() : playSvg(); }); }
  function onPlaying() { return !!playerState.playing; }
  
  function showPlayer(t) {
    var pc = $('#playerContainer'); if(pc) pc.hidden = false;
    var pl = $('#player'); if(pl) pl.hidden = false; 
    var pt = $('#playerTitle'); if(pt) pt.textContent = t.title; 
    var pa = $('#playerArtist'); if(pa) pa.textContent = t.artist; 
    var c = $('#playerCover');
    if (c) { 
        var key = ((t.title || '') + '|' + (t.artist || '')).toLowerCase();
        var art = trackCoverCache[key] || t.cover || ''; 
        if (art) { c.innerHTML = '<img src="' + esc(art) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'; c.style.background = 'none'; } 
        else { c.innerHTML = ''; c.style.background = coverColor(String(t.id).length + (t.title || '').length); c.textContent = coverLetter(t.title); } 
    }
    setPlayingUI(true);
  }
  function stopPreview() { if (previewAudio) { previewAudio.pause(); previewAudio = null; previewTrackId = null; } }

  var queueIds = []; function queueTracks() { return queueIds.map(function (id) { return trackRegistry[id] || favs.find(function (f) { return String(f.id) === id; }); }).filter(Boolean); }
  var pPrev = $('#playerPrev'); if (pPrev) pPrev.addEventListener('click', function () { if (!previewAudio || !previewTrackId) return; var q = queueTracks(); var idx = q.findIndex(function (t) { return String(t.id) === String(previewTrackId); }); if (idx > 0) { playPreview(q[idx - 1]); return; } try { previewAudio.currentTime = 0; } catch (e) {} if (previewAudio.paused) { previewAudio.play().catch(function () {}); } var p = $('#playerProgress'); if(p) p.style.width = '0%'; setPlayingUI(true); });
  var pNext = $('#playerNext'); if (pNext) pNext.addEventListener('click', function () { if (!previewTrackId) return; var q = queueTracks(); var idx = q.findIndex(function (t) { return String(t.id) === String(previewTrackId); }); if (idx >= 0 && idx < q.length - 1) { playPreview(q[idx + 1]); } else if (q.length) { playPreview(q[0]); } });

  var seekDrag = false; var seekEl = $('#playerSeek');
  function seekByPoint(clientX) { if (!seekEl) return; var r = seekEl.getBoundingClientRect(); if (!r.width) return; var p = Math.min(1, Math.max(0, (clientX - r.left) / r.width)); var pr = $('#playerProgress'); if(pr) pr.style.width = (p * 100) + '%'; if (previewAudio && previewAudio.duration && isFinite(previewAudio.duration) && previewAudio.duration > 0) previewAudio.currentTime = p * previewAudio.duration; }
  function seekStart(clientX) { if (!previewAudio) return; seekDrag = true; var pr = $('#playerProgress'); if(pr) pr.classList.add('dragging'); seekByPoint(clientX); setPlayingUI(true); }
  if (seekEl) { seekEl.addEventListener('mousedown', function (e) { e.preventDefault(); seekStart(e.clientX); }); seekEl.addEventListener('touchstart', function (e) { seekStart(e.touches[0].clientX); }, { passive: true }); }
  window.addEventListener('mousemove', function (e) { if (seekDrag) seekByPoint(e.clientX); });
  window.addEventListener('mouseup', function () { if (seekDrag) { seekDrag = false; var pr = $('#playerProgress'); if(pr) pr.classList.remove('dragging'); } });
  window.addEventListener('touchmove', function (e) { if (seekDrag && e.touches[0]) seekByPoint(e.touches[0].clientX); });
  window.addEventListener('touchend', function () { if (seekDrag) { seekDrag = false; var pr = $('#playerProgress'); if(pr) pr.classList.remove('dragging'); } });

  var pToggle = $('#playerToggle'); if (pToggle) pToggle.addEventListener('click', function () { if (previewAudio) { if (previewAudio.paused) { previewAudio.play(); setPlayingUI(true); } else { previewAudio.pause(); setPlayingUI(false); } return; } setPlayingUI(!playerState.playing); });

  var volume = 100; var lastVolume = 100;
  try { var savedVol = parseInt(localStorage.getItem('evu_volume') || '100', 10); if (savedVol >= 0 && savedVol <= 100) volume = savedVol; if (volume > 0) lastVolume = volume; } catch (e) {}
  function applyVolume(v) { var val = Math.max(0, Math.min(100, parseInt(v, 10) || 0)); if (previewAudio) previewAudio.volume = val / 100; var slider = $('#playerVolume'); if (slider) { slider.value = val; slider.style.setProperty('--vol', val + '%'); } var ivo = $('#iconVolOn'); if(ivo) ivo.toggleAttribute('hidden', val === 0); var ivf = $('#iconVolOff'); if(ivf) ivf.toggleAttribute('hidden', val !== 0); try { localStorage.setItem('evu_volume', String(val)); } catch (e) {} }
  applyVolume(volume);
  var vSlider = $('#playerVolume'); if (vSlider) vSlider.addEventListener('input', function () { volume = parseInt(this.value, 10); if (volume > 0) lastVolume = volume; applyVolume(volume); });
  var muteBtn = $('#playerMute'); if (muteBtn) muteBtn.addEventListener('click', function () { if (volume > 0) { lastVolume = volume; volume = 0; } else { volume = lastVolume || 100; } applyVolume(volume); });
  var closeBtn = $('#playerClose'); if (closeBtn) closeBtn.addEventListener('click', function () { stopPreview(); playerState.playing = false; var pc = $('#playerContainer'); if(pc) pc.hidden = true; var pl = $('#player'); if(pl) pl.hidden = true; var pr = $('#playerProgress'); if(pr) pr.style.width = '0%'; });

  // ===== Init =====
  renderPlaylists(); renderAlbums(); loadUserData();
})();
