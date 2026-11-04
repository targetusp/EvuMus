(function () {
  'use strict';

  // ===== Telegram SDK =====
  var TG = window.Telegram && window.Telegram.WebApp;
  if (TG) {
    try { TG.ready(); TG.expand(); TG.setHeaderColor && TG.setHeaderColor('#0e1a27'); } catch (e) {}
    document.getElementById('tgHeader').style.display = 'none';
    document.body.classList.add('telegram-mode');
  }
// ===== Состояние =====
  var THEME_KEY = 'evu_theme';
  var LIB_KEY = 'evu_library_v2'; // v2 - новый формат
  var FAV_KEY = 'evu_favs_v2';    // v2 - новый формат
  var PL_KEY = 'evu_playlists';
  var ALBUM_KEY = 'evu_albums_v1';
  var LANG_KEY = 'evu_language';
  var GLASS_KEY = 'evu_glass_mode';

  var THEME_NAMES = { blue: 'Синяя', white: 'Белая', black: 'Чёрная' };
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

  // Очищаем старые данные (где были только ID), чтобы не было ошибок
  var library = load(LIB_KEY, []).filter(function(item) { return typeof item === 'object' && item !== null; });
  var favs = load(FAV_KEY, []).filter(function(item) { return typeof item === 'object' && item !== null; });
  var playlists = load(PL_KEY, []);
  if (!Array.isArray(albums)) albums = [];
  if (!Array.isArray(playlists)) playlists = [];

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

  // ===== Theme =====
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

  // ===== Interface languages (six built-in translations) =====
  var I18N = {
    ru: {my:'Моя музыка',search:'Поиск',favorites:'Любимое',playlists:'Плейлисты',albums:'Альбомы',settings:'Настройки',channel:'Канал с обновлениями',all:'Все треки',tracks:'Треки',searchMusic:'Поиск музыки',searchHint:'Находи свои треки и новую музыку',searchPlaceholder:'Название песни или исполнитель...',advanced:'Расширенный поиск',collection:'Твоя коллекция',noTracks:'Здесь пока нет треков',addMusic:'Добавляй музыку из поиска и собирай свои плейлисты.',goSearch:'Перейти к поиску',theme:'Оформление',language:'Язык',general:'Основное',support:'Связь и поддержка',feedback:'Обратная связь',help:'Помочь проекту',account:'Аккаунт',delete:'Удалить личный кабинет',create:'Создать',newAlbum:'Новый альбом',albumHint:'Собирай треки в собственные альбомы'},
    en: {my:'My music',search:'Search',favorites:'Favorites',playlists:'Playlists',albums:'Albums',settings:'Settings',channel:'Updates channel',all:'All tracks',tracks:'Tracks',searchMusic:'Music search',searchHint:'Find your tracks and discover new music',searchPlaceholder:'Song title or artist...',advanced:'Advanced search',collection:'Your collection',noTracks:'No tracks yet',addMusic:'Add music from search and build your playlists.',goSearch:'Go to search',theme:'Appearance',language:'Language',general:'General',support:'Help & support',feedback:'Feedback',help:'Support the project',account:'Account',delete:'Delete account',create:'Create',newAlbum:'New album',albumHint:'Collect tracks in your own albums'},
    uk: {my:'Моя музика',search:'Пошук',favorites:'Улюблене',playlists:'Плейлисти',albums:'Альбоми',settings:'Налаштування',channel:'Канал оновлень',all:'Усі треки',tracks:'Треки',searchMusic:'Пошук музики',searchHint:'Знаходь свої треки та нову музику',searchPlaceholder:'Назва пісні або виконавець...',advanced:'Розширений пошук',collection:'Твоя колекція',noTracks:'Тут поки немає треків',addMusic:'Додавай музику з пошуку та створюй плейлисти.',goSearch:'До пошуку',theme:'Оформлення',language:'Мова',general:'Основне',support:'Зв’язок і підтримка',feedback:'Зворотний зв’язок',help:'Підтримати проєкт',account:'Обліковий запис',delete:'Видалити обліковий запис',create:'Створити',newAlbum:'Новий альбом',albumHint:'Збирай треки у власні альбоми'},
    de: {my:'Meine Musik',search:'Suche',favorites:'Favoriten',playlists:'Wiedergabelisten',albums:'Alben',settings:'Einstellungen',channel:'Updates-Kanal',all:'Alle Titel',tracks:'Titel',searchMusic:'Musiksuche',searchHint:'Finde deine Titel und neue Musik',searchPlaceholder:'Songtitel oder Interpret...',advanced:'Erweiterte Suche',collection:'Deine Sammlung',noTracks:'Noch keine Titel',addMusic:'Füge Musik hinzu und erstelle Playlists.',goSearch:'Zur Suche',theme:'Design',language:'Sprache',general:'Allgemein',support:'Hilfe & Support',feedback:'Feedback',help:'Projekt unterstützen',account:'Konto',delete:'Konto löschen',create:'Erstellen',newAlbum:'Neues Album',albumHint:'Sammle Titel in eigenen Alben'},
    fr: {my:'Ma musique',search:'Recherche',favorites:'Favoris',playlists:'Playlists',albums:'Albums',settings:'Paramètres',channel:'Canal des mises à jour',all:'Tous les titres',tracks:'Titres',searchMusic:'Recherche musicale',searchHint:'Trouve tes titres et découvre de la musique',searchPlaceholder:'Titre ou artiste...',advanced:'Recherche avancée',collection:'Ta collection',noTracks:'Aucun titre pour le moment',addMusic:'Ajoute de la musique et crée tes playlists.',goSearch:'Aller à la recherche',theme:'Apparence',language:'Langue',general:'Général',support:'Aide et assistance',feedback:'Commentaires',help:'Soutenir le projet',account:'Compte',delete:'Supprimer le compte',create:'Créer',newAlbum:'Nouvel album',albumHint:'Rassemble tes titres dans des albums'},
    es: {my:'Mi música',search:'Buscar',favorites:'Favoritos',playlists:'Listas',albums:'Álbumes',settings:'Ajustes',channel:'Canal de novedades',all:'Todas las canciones',tracks:'Canciones',searchMusic:'Buscar música',searchHint:'Encuentra tus canciones y descubre música',searchPlaceholder:'Título o artista...',advanced:'Búsqueda avanzada',collection:'Tu colección',noTracks:'Todavía no hay canciones',addMusic:'Añade música y crea tus listas.',goSearch:'Ir a buscar',theme:'Apariencia',language:'Idioma',general:'General',support:'Ayuda y soporte',feedback:'Comentarios',help:'Apoyar el proyecto',account:'Cuenta',delete:'Eliminar cuenta',create:'Crear',newAlbum:'Nuevo álbum',albumHint:'Reúne canciones en tus propios álbumes'}
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
    var langValue = $('#btnLang .settings-item__value'); if (langValue) langValue.textContent = ({ru:'Русский',en:'English',uk:'Українська',de:'Deutsch',fr:'Français',es:'Español'})[language];
    save(LANG_KEY, language);
  }
  $('#btnLang').addEventListener('click', function () { $('#languageModal').hidden = false; });
  $('#closeLanguageModal').addEventListener('click', function () { $('#languageModal').hidden = true; });
  $('#languageModal').addEventListener('click', function (e) { if (e.target === $('#languageModal')) $('#languageModal').hidden = true; });
  $$('.language-option').forEach(function (el) { el.addEventListener('click', function () { applyLanguage(el.dataset.lang); }); });
  applyLanguage(language);
  // ===== Navigation =====
  // Один и тот же баннер поддержки на всех страницах, кроме настроек.
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

  // ===== fetchTracks =====
  // API: по умолчанию тот же домен, что и мини-приложение.
  // Если RU backend размещён отдельно, задайте window.EVUMUSIC_API_URL в index.html
  // например: window.EVUMUSIC_API_URL = 'https://api.example.com';
  var BACKEND_URL = String(window.EVUMUSIC_API_URL || '').replace(/\/+$/, '');
  function absUrl(u) {
    if (!u) return '';
    if (u.indexOf('http') === 0) return u;
    return BACKEND_URL + u;
  }

  function audiusTracks(query) {
    return fetch('https://api.audius.co/v1/tracks/search?query=' + encodeURIComponent(query) + '&app_name=test')
      .then(function (r) { if (!r.ok) throw new Error('audius HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var tracks = (d.data || []).map(function (r) {
          var min = Math.floor((r.duration || 0) / 60);
          var sec = (r.duration || 0) % 60;
          return {
            id: 'au' + r.id,
            title: r.title || 'Без названия',
            artist: (r.user && r.user.name) || '',
            dur: (min + ':' + (sec < 10 ? '0' : '') + sec),
            cover: '', // Обложки берём только из Deezer, затем SoundCloud track artwork
            preview: 'https://api.audius.co/v1/tracks/' + r.id + '/stream?app_name=test',
            source: 'audius'
          };
        });
        return Promise.all(tracks.map(function (t) {
          return fetch(t.preview, { method: 'HEAD', mode: 'cors', redirect: 'manual' })
            .then(function (r) { return (r.status !== 403 && r.status !== 404 && r.status !== 401) ? t : null; })
            .catch(function () { return null; });
        })).then(function (results) { return results.filter(Boolean); });
      }).catch(function () { return []; });
  }

  function fetchTracks(query) {
    if (BACKEND_URL) {
      var url = BACKEND_URL + '/api/search?q=' + encodeURIComponent(query);
      return fetch(url)
        .then(function (r) { if (!r.ok) throw new Error('backend HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          var dur;
          var tracks = (d.tracks || []).map(function (t) {
            dur = t.dur || (t.duration ? Math.floor(t.duration / 60) + ':' + ('0' + (t.duration % 60)).slice(-2) : '');
            return {
              id: t.id, title: t.title, artist: t.artist || '',
              dur: dur, cover: absUrl(t.cover || ''),
              preview: absUrl(t.preview_url || t.preview || t.stream_url || ''),
              full: t.full !== false, source: t.source || 'ru'
            };
          }).filter(function (t) { return !!t.preview; });
          if (tracks.length) return tracks;
          return audiusTracks(query);
        }).catch(function () { return audiusTracks(query); });
    }
    return audiusTracks(query);
  }

  // ===== Track rendering =====
  // ТЕПЕРЬ МЫ ИЩЕМ В МАССИВАХ ОБЪЕКТОВ, А НЕ В МАССИВАХ ID
  function isFav(id) { return favs.some(function(f) { return String(f.id) === String(id); }); }
  function isLib(id) { return library.some(function(l) { return String(l.id) === String(id); }); }

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
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(' + hue + ',58%,35%)"/><stop offset="1" stop-color="#07111f"/></linearGradient><radialGradient id="r"><stop stop-color="hsla(' + ((hue+45)%360) + ',90%,70%,.7)"/><stop offset="1" stop-color="hsla(' + hue + ',70%,30%,0)"/></radialGradient></defs>' +
      '<rect width="600" height="600" rx="48" fill="url(#g)"/><circle cx="475" cy="125" r="240" fill="url(#r)"/>' +
      '<circle cx="485" cy="120" r="105" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="2"/><circle cx="485" cy="120" r="75" fill="none" stroke="#ffffff" stroke-opacity=".10"/>' +
      '<path d="M405 330V130l150-28v200" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="18" stroke-linecap="round"/><ellipse cx="372" cy="338" rx="42" ry="26" fill="#fff" fill-opacity=".22"/><ellipse cx="525" cy="310" rx="42" ry="26" fill="#fff" fill-opacity=".22"/>' +
      '<text x="54" y="420" fill="#fff" font-family="Arial,sans-serif" font-size="34" font-weight="700">' + xml(fit(title, 25)) + '</text>' +
      '<text x="56" y="465" fill="#fff" fill-opacity=".72" font-family="Arial,sans-serif" font-size="22">' + xml(fit(artist, 32)) + '</text>' +
      '<text x="56" y="545" fill="#fff" fill-opacity=".45" font-family="Arial,sans-serif" font-size="15" letter-spacing="5">EVUMUSIC • TRACK ART</text></svg>';
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
  }

  function trackHTML(t) {
    var fav = isFav(t.id);
    var ownCover = trackCoverCache[(String(t.title || '') + '|' + String(t.artist || '')).toLowerCase()] || (t.cover ? absUrl(t.cover) : '') || coverFallback(t);
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

  var trackCoverCache = load('evu_track_cover_cache_v6', {});
  var coverRequests = {};
  function coverNorm(v) {
    return String(v || '').toLowerCase().replace(/\b(feat|ft|prod|remaster(ed)?)\b/g, ' ')
      .replace(/[^a-z0-9а-яё]/gi, '');
  }
  function coverArtistMatch(wanted, actual) {
    if (!wanted || !actual) return true;
    var a = coverNorm(wanted), b = coverNorm(actual);
    return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  }
  function exactCoverMatch(item, title, artist) {
    var gotTitle = coverNorm(item.title);
    var gotArtist = coverNorm((item.artist && item.artist.name) || item.user && item.user.username || item.metadata_artist || '');
    return gotTitle === coverNorm(title) && (!artist || (!!gotArtist && coverArtistMatch(artist, gotArtist)));
  }
  var backendCoverWarningShown = false;
  function findVerifiedTrackCover(title, artist) {
    var url = BACKEND_URL + '/api/track-cover?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist || '');
    return fetch(url).then(function(r) {
      if (!r.ok) throw new Error('Track cover lookup failed: ' + r.status);
      return r.json();
    }).then(function(d) { return d && d.cover ? absUrl(d.cover) : ''; })
      .catch(function() {
        if (!backendCoverWarningShown) {
          backendCoverWarningShown = true;
          toast('Для оригинальных обложек запусти start-ru-backend.bat');
        }
        return '';
      });
  }
  function hydrateTrackCovers(container) {
    container.querySelectorAll('.js-track-cover').forEach(function(img) {
      var title = (img.getAttribute('data-title') || '').trim();
      var artist = (img.getAttribute('data-artist') || '').trim();
      if (!title) return;
      var key = (title + '|' + artist).toLowerCase();
      img.addEventListener('error', function() {
        img.onerror = null;
        img.src = coverFallback({id: img.closest('.track') && img.closest('.track').getAttribute('data-id'), title: title, artist: artist});
      }, {once:true});
      if (trackCoverCache[key]) {
        img.src = trackCoverCache[key];
        return;
      }
      if (coverRequests[key]) return;
      coverRequests[key] = true;
      findVerifiedTrackCover(title, artist).then(function(image) {
        if (!image) return;
        trackCoverCache[key] = image;
        try { save('evu_track_cover_cache_v6', trackCoverCache); } catch(e) {}
        Object.keys(trackRegistry).forEach(function(id) {
          var item = trackRegistry[id];
          if (((item.title || '') + '|' + (item.artist || '')).toLowerCase() === key) item.cover = image;
        });
        [library, favs].forEach(function(list) {
          list.forEach(function(item) {
            if (((item.title || '') + '|' + (item.artist || '')).toLowerCase() === key) item.cover = image;
          });
        });
        if (previewTrackId && trackRegistry[String(previewTrackId)] &&
            ((trackRegistry[String(previewTrackId)].title || '') + '|' + (trackRegistry[String(previewTrackId)].artist || '')).toLowerCase() === key) {
          var pc = document.getElementById('playerCover');
          if (pc) { pc.innerHTML = '<img src="' + esc(image) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">'; pc.style.background = 'none'; }
        }
        document.querySelectorAll('.js-track-cover[data-title]').forEach(function(el) {
          if (((el.getAttribute('data-title') || '') + '|' + (el.getAttribute('data-artist') || '')).toLowerCase() === key) {
            el.src = image;
          }
        });
      }).catch(function() {}).then(function(){ delete coverRequests[key]; });
    });
  }
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
  function renderSearch() {
    var q = ($('#searchInput').value || '').trim();
    if (searchTab === 'albums') {
      renderAlbumSearch(q);
      renderCollection();
      return;
    }
    if (!q) {
      $('#searchEmpty').hidden = false;
      $('#searchEmpty').innerHTML = '<p>Начни вводить название — полные треки</p>';
      $('#searchResults').innerHTML = '';
      renderCollection();
      return;
    }

    $('#searchEmpty').hidden = true;
    $('#searchResults').innerHTML = '<div class="search-hint">Ищу треки…</div>';

    var reqId = ++searchRequestId;

    fetchTracks(q).then(function (tracks) {
      if (reqId !== searchRequestId) return;
      tracks.forEach(registerTrack);

      if (!tracks || !tracks.length) {
        $('#searchEmpty').hidden = false;
        $('#searchEmpty').innerHTML = '<p>Ничего не найдено по «' + esc(q) + '»</p>';
        $('#searchResults').innerHTML = '';
        return;
      }
      $('#searchEmpty').hidden = true;
      renderList($('#searchResults'), tracks);
    }).catch(function () {
      if (reqId !== searchRequestId) return;
      $('#searchEmpty').hidden = false;
      $('#searchEmpty').innerHTML = '<p>Ошибка поиска. Попробуй ещё раз.</p>';
      $('#searchResults').innerHTML = '';
    });

    renderCollection();
  }

  // ===== Deezer album search =====
  var albumSearchRequestId = 0;
  function renderAlbumSearch(query) {
    var results = $('#searchResults');
    var empty = $('#searchEmpty');
    if (!query) {
      results.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = '<p>Введи название альбома или исполнителя</p>';
      return;
    }
    var requestId = ++albumSearchRequestId;
    empty.hidden = true;
    results.innerHTML = '<div class="search-hint">Ищу альбомы в Deezer…</div>';
    fetch(BACKEND_URL + '/api/search/albums?q=' + encodeURIComponent(query))
      .then(function(r) { if (!r.ok) throw new Error('Album search failed: ' + r.status); return r.json(); })
      .then(function(data) {
        if (requestId !== albumSearchRequestId || searchTab !== 'albums') return;
        var items = data.albums || [];
        if (!items.length) {
          results.innerHTML = '';
          empty.hidden = false;
          empty.innerHTML = '<p>Альбомы не найдены. Проверь, что запущен RU backend.</p>';
          return;
        }
        empty.hidden = true;
        results.innerHTML = '<div class="search-album-grid">' + items.map(function(a) {
          return '<button class="search-album-card" data-deezer-album="' + esc(a.id) + '">' +
            '<img src="' + esc(absUrl(a.cover || '')) + '" alt="Обложка ' + esc(a.title || '') + '" loading="lazy">' +
            '<span class="search-album-card__meta"><b>' + esc(a.title || 'Без названия') + '</b><small>' + esc(a.artist || 'Неизвестный исполнитель') + '</small><small>' + esc(String(a.nb_tracks || 0)) + ' треков' + (a.release_date ? ' · ' + esc(a.release_date.slice(0,4)) : '') + '</small></span></button>';
        }).join('') + '</div>';
        results.querySelectorAll('[data-deezer-album]').forEach(function(card) {
          card.addEventListener('click', function() { openDeezerAlbum(card.getAttribute('data-deezer-album')); });
        });
      })
      .catch(function() {
        if (requestId !== albumSearchRequestId) return;
        results.innerHTML = '';
        empty.hidden = false;
        empty.innerHTML = '<p>Не удалось загрузить альбомы. Запусти RU backend и попробуй ещё раз.</p>';
      });
  }

  function openDeezerAlbum(albumId) {
    var results = $('#searchResults');
    var empty = $('#searchEmpty');
    results.innerHTML = '<div class="search-hint">Загружаю альбом…</div>';
    empty.hidden = true;
    fetch(BACKEND_URL + '/api/deezer/album/' + encodeURIComponent(albumId))
      .then(function(r) { if (!r.ok) throw new Error('Album details failed'); return r.json(); })
      .then(function(data) {
        var tracks = (data.tracks || []).map(function(t) {
          var track = {
            id: 'deezer_' + t.id,
            title: t.title || 'Без названия',
            artist: t.artist || data.artist || '',
            dur: t.dur || '',
            cover: absUrl(t.cover || data.cover || ''),
            preview: t.preview || '',
            full: false,
            source: 'deezer'
          };
          registerTrack(track);
          return track;
        });
        results.innerHTML = '<div class="album-search-detail"><button class="btn-back" id="deezerAlbumBack">← Назад к альбомам</button><div class="album-search-heading"><img src="' + esc(absUrl(data.cover || '')) + '" alt=""><div><h3>' + esc(data.title || 'Альбом') + '</h3><p>' + esc(data.artist || '') + ' · ' + tracks.length + ' треков</p></div></div><div class="track-list" id="deezerAlbumTracks"></div></div>';
        $('#deezerAlbumBack').addEventListener('click', function() { renderAlbumSearch(($('#searchInput').value || '').trim()); });
        renderList($('#deezerAlbumTracks'), tracks);
        if (!tracks.length) {
          $('#deezerAlbumTracks').innerHTML = '<p class="search-empty">В этом альбоме нет доступных превью</p>';
        }
      })
      .catch(function() {
        results.innerHTML = '<p class="search-empty">Не удалось загрузить альбом. Попробуй ещё раз.</p><button class="btn-back" id="deezerAlbumBack">← Назад</button>';
        $('#deezerAlbumBack').addEventListener('click', function() { renderAlbumSearch(($('#searchInput').value || '').trim()); });
      });
  }

  $('#searchInput').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSearch, 700);
  });
  $('#searchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { clearTimeout(searchTimer); renderSearch(); }
  });

  // ===== Add to playlist =====
  var addToPlaylistTrackId = null;
  var addToPlaylistTrack = null;
  var activePlIdx = null;

  function normalizePlaylistItem(x) {
    if (x && typeof x === 'object') return x;
    return findTrack(x) || null;
  }

  function openAddToPlaylist(trackId) {
    addToPlaylistTrack = findTrack(trackId);
    addToPlaylistTrackId = trackId;
    var list = $('#playlistPickList');
    var picks = playlists.map(function (p, idx) { return '<button class="playlist-pick-item" data-pl-idx="' + idx + '"><span>🎵</span><b>' + esc(p.name) + '</b><span>' + (p.count || 0) + ' треков</span></button>'; });
    albums.forEach(function (a, idx) { picks.push('<button class="playlist-pick-item" data-album-idx="' + idx + '"><span>💿</span><b>' + esc(a.name) + '</b><span>' + (a.tracks || []).length + ' треков · альбом</span></button>'); });
    list.innerHTML = picks.length ? picks.join('') : '<p class="empty-hint">Пока нет плейлистов или альбомов.</p>';
    $('#plNewRow').hidden = true;
    $('#addToPlaylistModal').hidden = false;
  }
  function closeAddToPlaylist() { $('#addToPlaylistModal').hidden = true; addToPlaylistTrackId = null; addToPlaylistTrack = null; }

  document.getElementById('cancelAddToPlaylist').addEventListener('click', closeAddToPlaylist);
  document.getElementById('addToPlaylistModal').addEventListener('click', function (e) { if (e.target === document.getElementById('addToPlaylistModal')) closeAddToPlaylist(); });

  document.getElementById('createPlaylistInline').addEventListener('click', function () {
    $('#plNewRow').hidden = false;
    $('#plNewInput').focus();
  });
  function createPlFromInline() {
    var name = ($('#plNewInput').value || '').trim();
    if (!name) { toast('Введи название'); return; }
    if (playlists.some(function (p) { return (p.name || '').toLowerCase() === name.toLowerCase(); })) {
      toast('Такой плейлист уже есть'); return;
    }
    playlists.push({ name: name, count: 0, tracks: [] });
    save(PL_KEY, playlists);
    $('#plNewInput').value = '';
    $('#plNewRow').hidden = true;
    renderPlaylists();
    openAddToPlaylist(addToPlaylistTrackId);
    toast('Плейлист «' + name + '» создан — жми на него, чтобы добавить трек');
  }
  document.getElementById('plNewSave').addEventListener('click', createPlFromInline);
  document.getElementById('plNewInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') createPlFromInline(); });

  document.getElementById('addToPlaylistModal').addEventListener('click', function (e) {
    var btn = e.target.closest('.playlist-pick-item');
    if (!btn) return;
    if (!addToPlaylistTrackId || !addToPlaylistTrack) { toast('Трек не найден'); return; }
    var albumIdx = btn.hasAttribute('data-album-idx') ? parseInt(btn.getAttribute('data-album-idx'), 10) : -1;
    var target = albumIdx >= 0 ? albums[albumIdx] : playlists[parseInt(btn.getAttribute('data-pl-idx'), 10)];
    if (!target) return;
    if (!target.tracks) target.tracks = [];
    var already = target.tracks.some(function (x) { var xid = (x && typeof x === 'object') ? x.id : x; return String(xid) === String(addToPlaylistTrackId); });
    if (!already) {
      target.tracks.push(addToPlaylistTrack);
      if (albumIdx < 0) target.count = target.tracks.length;
      save(albumIdx >= 0 ? ALBUM_KEY : PL_KEY, albumIdx >= 0 ? albums : playlists);
      toast('Добавлено в «' + target.name + '»');
    } else { toast('Уже добавлено'); }
    renderPlaylists(); renderAlbums();
    if (activePlIdx === parseInt(btn.getAttribute('data-pl-idx'), 10)) renderPlaylistDetail();
    if (activeAlbumIdx === albumIdx && albumIdx >= 0) renderAlbumDetail();
    closeAddToPlaylist();
  });

  // ===== Actions (Логика сохранения полных объектов) =====
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

  document.getElementById('content').addEventListener('click', function (e) {
    var coverEl = e.target.closest('.track__cover');
    if (coverEl) {
      triggerPlay(coverEl.closest('.track'));
      return;
    }
    var btn = e.target.closest('.track__btn');
    if (!btn) return;
    var row = btn.closest('.track');
    var id = row.getAttribute('data-id');
    var tr = findTrack(id);

    if (btn.classList.contains('js-play')) {
      triggerPlay(row);
    } else if (btn.classList.contains('js-fav')) {
      if (!tr) { toast('Трек не найден'); return; }
      var i = favs.findIndex(function (f) { return String(f.id) === String(id); });
      if (i === -1) {
        favs.push(tr);
        toast('Добавлено в любимое');
      } else {
        favs.splice(i, 1);
        toast('Убрано из любимого');
      }
      save(FAV_KEY, favs);
      refreshAll();
    } else if (btn.classList.contains('js-addpl')) {
      if (!tr) { toast('Трек не найден'); return; }
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
    var tracks = (pl.tracks || []).map(normalizePlaylistItem).filter(Boolean);
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
  $('#savePlaylist').addEventListener('click', function () {
    var name = ($('#playlistNameInput').value || '').trim();
    if (!name) { toast('Введи название'); return; }
    playlists.push({ name: name, count: 0, tracks: [] });
    save(PL_KEY, playlists);
    closePlaylistModal();
    renderPlaylists();
    toast('Плейлист «' + name + '» создан');
  });
  $('#playlistNameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#savePlaylist').click(); });

  // ===== Albums =====
  function renderAlbums() {
    var grid = $('#albumGrid');
    if (!grid) return;
    $('#albumEmpty').hidden = albums.length > 0;
    grid.innerHTML = albums.map(function (a, idx) {
      return '<button class="playlist-card" data-album="' + idx + '"><span class="playlist-card__plus">💿</span><b>' + esc(a.name) + '</b><span>' + ((a.tracks || []).length) + ' треков</span></button>';
    }).join('');
    grid.querySelectorAll('[data-album]').forEach(function (card) { card.addEventListener('click', function () { openAlbum(parseInt(card.dataset.album, 10)); }); });
  }
  function openAlbum(idx) { if (!albums[idx]) return; activeAlbumIdx = idx; renderAlbumDetail(); goPage('alview'); }
  function renderAlbumDetail() {
    var a = albums[activeAlbumIdx]; if (!a) return;
    $('#albumViewTitle').textContent = a.name;
    var tracks = (a.tracks || []).map(normalizePlaylistItem).filter(Boolean);
    $('#albumViewEmpty').hidden = tracks.length > 0;
    renderList($('#albumViewList'), tracks);
  }
  function openAlbumModal() { $('#albumNameInput').value = ''; $('#albumModal').hidden = false; $('#albumNameInput').focus(); }
  $('#btnCreateAlbum').addEventListener('click', openAlbumModal);
  $('#cancelAlbum').addEventListener('click', function () { $('#albumModal').hidden = true; });
  $('#saveAlbum').addEventListener('click', function () {
    var name = ($('#albumNameInput').value || '').trim();
    if (!name) { toast('Введи название альбома'); return; }
    if (albums.some(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })) { toast('Такой альбом уже есть'); return; }
    albums.push({ name: name, tracks: [], createdAt: Date.now() }); save(ALBUM_KEY, albums);
    $('#albumModal').hidden = true; renderAlbums(); toast('Альбом «' + name + '» создан');
  });
  $('#albumNameInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#saveAlbum').click(); });
  $('#albumBack').addEventListener('click', function () { goPage('albums'); });

  // ===== Theme modal =====
  $('#openThemeModal').addEventListener('click', function () { $('#themeModal').hidden = false; });
  $('#closeThemeModal').addEventListener('click', function () { $('#themeModal').hidden = true; });
  $('#themeModal').addEventListener('click', function (e) { if (e.target === $('#themeModal')) $('#themeModal').hidden = true; });
  $$('.theme-option').forEach(function (b) {
    b.addEventListener('click', function () {
      applyTheme(b.getAttribute('data-theme-pick'));
      toast('Тема: ' + THEME_NAMES[b.getAttribute('data-theme-pick')]);
    });
  });

  // ===== Settings misc =====
  $('#btnFeedback').addEventListener('click', function () { window.open('https://t.me/EvuMusic', '_blank'); });

  var confirmCb = null;
  function showConfirm(text, cb) { $('#confirmText').textContent = text; $('#confirmOverlay').hidden = false; confirmCb = cb; }
  $('#confirmCancel').addEventListener('click', function () { $('#confirmOverlay').hidden = true; confirmCb = null; });
  $('#confirmOk').addEventListener('click', function () { $('#confirmOverlay').hidden = true; if (confirmCb) confirmCb(); confirmCb = null; });

  $('#btnDelete').addEventListener('click', function () {
    showConfirm('Удалить личный кабинет? Это действие нельзя отменить.', function () {
      library = []; favs = []; playlists = []; albums = [];
      save(LIB_KEY, library); save(FAV_KEY, favs); save(PL_KEY, playlists); save(ALBUM_KEY, albums);
      refreshAll(); renderPlaylists(); renderAlbums();
      toast('Личный кабинет удалён');
    });
  });

  // ===== Player =====
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
        $('#playerProgress').style.width = Math.min(100, (previewAudio.currentTime / dur * 100)) + '%';
      }
    };
    previewAudio.onended = function () {
      $('#playerProgress').style.width = '0%';
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
    if (t.source === 'audius') {
      fetch(t.preview, { method: 'HEAD', mode: 'cors' }).then(function (r) {
        if (r.url && r.url !== t.preview) audioUrl = r.url;
        startAudio(audioUrl, t);
      }).catch(function () { startAudio(t.preview, t); });
    } else {
      startAudio(audioUrl, t);
    }
    showPlayer(t);
    setPlayingUI(true);
  }
  function setPlayingUI(on) {
    playerState.playing = on;
    $('#iconPlay').toggleAttribute('hidden', on);
    $('#iconPause').toggleAttribute('hidden', !on);
    var playerEl = $('#player');
    playerEl.classList.toggle('is-playing', on);
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
    $('#player').hidden = false;
    $('#playerTitle').textContent = t.title;
    $('#playerArtist').textContent = t.artist;
    var c = $('#playerCover');
    var art = t.cover || '';
    if (art) {
      c.innerHTML = '<img src="' + esc(art) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">';
      c.style.background = 'none';
    } else {
      c.innerHTML = '';
      c.style.background = coverColor(String(t.id).length + (t.title || '').length);
      c.textContent = coverLetter(t.title);
    }
    setPlayingUI(true);
  }
  function stopPreview() {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; previewTrackId = null; }
  }

  // ===== Prev / Next по очереди треков =====
  var queueIds = [];

  function queueTracks() {
    return queueIds.map(function (id) { return trackRegistry[id] || favs.find(function (f) { return String(f.id) === id; }); }).filter(Boolean);
  }
  $('#playerPrev').addEventListener('click', function () {
    if (!previewAudio || !previewTrackId) return;
    var q = queueTracks();
    var idx = q.findIndex(function (t) { return String(t.id) === String(previewTrackId); });
    if (idx > 0) { playPreview(q[idx - 1]); return; }
    try { previewAudio.currentTime = 0; } catch (e) {}
    if (previewAudio.paused) { previewAudio.play().catch(function () {}); }
    $('#playerProgress').style.width = '0%';
    setPlayingUI(true);
  });
  $('#playerNext').addEventListener('click', function () {
    if (!previewTrackId) return;
    var q = queueTracks();
    var idx = q.findIndex(function (t) { return String(t.id) === String(previewTrackId); });
    if (idx >= 0 && idx < q.length - 1) { playPreview(q[idx + 1]); }
    else if (q.length) { playPreview(q[0]); }
  });

  // ===== Перемотка (клик/драг по дорожке) =====
  var seekDrag = false;
  var seekEl = $('#playerSeek');

  function seekByPoint(clientX) {
    var r = seekEl.getBoundingClientRect();
    if (!r.width) return;
    var p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    $('#playerProgress').style.width = (p * 100) + '%';
    if (previewAudio && previewAudio.duration && isFinite(previewAudio.duration) && previewAudio.duration > 0) {
      previewAudio.currentTime = p * previewAudio.duration;
    }
  }
  function seekStart(clientX) {
    if (!previewAudio) return;
    seekDrag = true;
    $('#playerProgress').classList.add('dragging');
    seekByPoint(clientX);
    setPlayingUI(true);
  }
  seekEl.addEventListener('mousedown', function (e) { e.preventDefault(); seekStart(e.clientX); });
  window.addEventListener('mousemove', function (e) { if (seekDrag) seekByPoint(e.clientX); });
  window.addEventListener('mouseup', function () { if (seekDrag) { seekDrag = false; $('#playerProgress').classList.remove('dragging'); } });
  seekEl.addEventListener('touchstart', function (e) { seekStart(e.touches[0].clientX); }, { passive: true });
  window.addEventListener('touchmove', function (e) { if (seekDrag && e.touches[0]) seekByPoint(e.touches[0].clientX); });
  window.addEventListener('touchend', function () { if (seekDrag) { seekDrag = false; $('#playerProgress').classList.remove('dragging'); } });

  $('#playerToggle').addEventListener('click', function () {
    if (previewAudio) {
      if (previewAudio.paused) { previewAudio.play(); setPlayingUI(true); }
      else { previewAudio.pause(); setPlayingUI(false); }
      return;
    }
    setPlayingUI(!playerState.playing);
  });

  // ===== Громкость =====
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
    slider.value = val;
    slider.style.setProperty('--vol', val + '%');
    $('#iconVolOn').toggleAttribute('hidden', val === 0);
    $('#iconVolOff').toggleAttribute('hidden', val !== 0);
    try { localStorage.setItem('evu_volume', String(val)); } catch (e) {}
  }
  applyVolume(volume);

  $('#playerVolume').addEventListener('input', function () {
    volume = parseInt(this.value, 10);
    if (volume > 0) lastVolume = volume;
    applyVolume(volume);
  });
  $('#playerMute').addEventListener('click', function () {
    if (volume > 0) { lastVolume = volume; volume = 0; }
    else { volume = lastVolume || 100; }
    applyVolume(volume);
  });

  $('#playerClose').addEventListener('click', function () {
    stopPreview();
    playerState.playing = false;
    $('#player').hidden = true;
    $('#playerProgress').style.width = '0%';
  });

  // ===== Init =====
  renderPlaylists();
  renderAlbums();
  renderMyMusic();
  renderFavs();
  renderSearch();
  favTitle();
})();
