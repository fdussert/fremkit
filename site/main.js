(function () {
  'use strict'

  var REGISTRY = 'https://fdussert.github.io/fremkit-sietch/index.json'

  // ---------- French strings (English lives in the HTML) ----------
  var FR = {
    'nav.how': 'Fonctionnement', 'nav.features': 'Fonctions', 'nav.widgets': 'Widgets', 'nav.privacy': 'Vie privée',
    'nav.build': 'Créer un widget', 'nav.get': 'Installer Fremkit',
    'hero.eyebrow': 'Dashboard de widgets pour le Corsair Xeneon Edge · macOS',
    'hero.title': 'Tout ce que vous suivez,<br><em>sur un seul bandeau.</em>',
    'hero.lede': 'Fremkit fait du Xeneon Edge, un bandeau tactile de 2560 × 720, le tableau de bord de votre Mac : builds, agenda, imprimante 3D, maison connectée, Claude Code. <strong>Sans iCUE, sans pilote, sans compte.</strong>',
    'copy': 'Copier', 'copied': 'Copié', 'hero.install': 'Guide d’installation', 'hero.how': 'Voir le fonctionnement',
    'hero.fine': 'Libre et open source · MIT · macOS 13+ sur Apple silicon',
    'hero.page0': 'En direct', 'hero.page0s': 'toucher & glisser', 'hero.caption': 'Enregistré sur le dashboard lui-même, au 2560 × 720 de l’Edge, avec des données d’exemple. L’anneau marque où le doigt se pose.',
    'w.sub2': 'Chaque fiche dit qui l’a écrit, ce qu’il lit et ce qui a changé dans la dernière version, avant que vous appuyiez sur Installer.',
    'hero.page1': 'Accueil', 'hero.page1s': 'dev & IA', 'hero.page2': 'Atelier', 'hero.page2s': 'imprimante & maison', 'hero.page3': 'Mesures', 'hero.page3s': 'disques & système', 'hero.shows': 'Affiche',
    'how.kicker': 'Fonctionnement', 'how.title': 'Quatre pièces, <em>toutes sur votre Mac.</em>',
    'how.sub': 'Rien de Corsair ne tourne. Un petit helper natif pilote la dalle tactile, un serveur local alimente les widgets, et votre navigateur sert d’éditeur.',
    'how.helper': 'barre des menus · Swift', 'how.server': 'Serveur local', 'how.widgets': 'HTML · isolés',
    'how.s1t': 'Le helper prend la dalle', 'how.s1': 'Une app de la barre des menus lit le tactile de l’Edge en USB HID avec son propre pilote, tient la souris hors du bandeau et affiche le dashboard en plein écran.',
    'how.s2t': 'Un serveur reste local', 'how.s2': 'Il n’écoute que sur 127.0.0.1, interroge ce dont les widgets ont besoin (votre Mac, votre agenda, votre imprimante) et le pousse par WebSocket.',
    'how.s3t': 'Vous l’arrangez dans un navigateur', 'how.s3': 'L’admin montre la vraie page avec les widgets en direct. Déplacez, redimensionnez, changez de thème : tout s’enregistre seul.',
    'how.s4t': 'Vous le pilotez au doigt', 'how.s4': 'Glissez d’une page à l’autre, appuyez sur des boutons, ouvrez un widget compact en grand dans un popover.',
    'feat.kicker': 'Ce qu’il fait', 'feat.title': 'Fait pour un coup d’œil, <em>pas pour le fixer.</em>',
    'feat.edTab1': 'Éditeur', 'feat.edTab2': 'Écran', 'feat.edTab3': 'Connexions',
    'feat.edT': 'La vraie page, en direct, sous votre souris.',
    'feat.ed': 'Le centre de l’admin, c’est le dashboard lui-même, avec ses widgets vivants. Déplacement et redimensionnement aimantés, chevauchements refusés, flèches du clavier, annuler et rétablir. Tout s’enregistre seul.',
    'tag.dm': 'CARTE DU DISQUE', 'feat.dmT': 'Où est passé l’espace, en anneaux.',
    'feat.dm': 'Un petit scanner en Swift, fourni avec l’app, parcourt votre dossier personnel ou un volume quand vous le demandez, jamais en tâche de fond. Touchez un anneau pour descendre d’un niveau, appui long pour le montrer dans le Finder. Rien n’est jamais supprimé.',
    'feat.nbT': 'Des widgets compacts, en grand au toucher.', 'feat.nb': 'La barre sous chaque page accueille de petits widgets. Touchez-en un : il s’ouvre en grand dans un popover.',
    'feat.tm1': 'Lumières', 'feat.tm2': 'Portail', 'feat.tm3': 'Café',
    'feat.tT': 'Son propre pilote tactile.', 'feat.t': 'Pas d’iCUE, pas de pilote tiers, pas d’extension noyau. Le helper lit la dalle lui-même et garde votre souris hors du bandeau.',
    'feat.thT': 'Un fichier JSON repeint tout.', 'feat.th': 'Palette, polices et taille du texte, portées par le dashboard, l’éditeur et chaque widget. Choisissez-en un, ou écrivez le vôtre.',
    'feat.csQ': 'Ce widget pourra :', 'feat.cs1': 'Lire les canaux <code>github</code>', 'feat.cs2': 'Utiliser une connexion GitHub', 'feat.cs3': 'Aucun accès réseau à lui', 'feat.csBtn': 'Installer',
    'feat.mpT': 'Une marketplace qui demande d’abord.', 'feat.mp': 'Installez widgets et thèmes depuis un registre trié. Vous voyez ce que chacun peut toucher, et une mise à jour qui en veut plus redemande.',
    'feat.bk1': 'Pages et widgets', 'feat.bk2': 'Connexions', 'feat.bk3': 'Bibliothèque de fonds', 'feat.bk4': 'Secrets : ils restent dans le trousseau',
    'feat.bkT': 'Sauvegarder sans rien laisser fuir.', 'feat.bk': 'Un zip contient tout le dashboard et jamais un secret. Restauré sur le même Mac, tout remarche aussitôt.',
    'w.kicker': 'Widgets', 'w.title': 'Fournis, ou <em>à une pression.</em>',
    'w.sub': 'Les widgets qui marchent sur n’importe quel Mac sont fournis avec Fremkit. Ceux qui demandent une imprimante, une box domotique, un NAS ou un compte vivent sur le Sietch, notre registre, et s’installent depuis l’admin.',
    'w.all': 'Tous', 'w.core': 'Fournis', 'w.live': 'La liste du Sietch est lue en direct depuis <a href="https://github.com/fdussert/fremkit-sietch">le registre</a>.',
    'w.badgeCore': 'fourni', 'w.conn': 'connexion', 'w.offline': 'Le registre est injoignable pour l’instant : seuls les widgets fournis sont listés.',
    'p.kicker': 'Vie privée', 'p.title': 'Votre Mac, <em>et rien d’autre.</em>',
    'p.sub': 'Un dashboard de votre propre machine lit des choses qui vous appartiennent. Ces règles valent pour chaque version.',
    'p.1t': 'Local uniquement', 'p.1': 'Le serveur n’écoute que sur 127.0.0.1. Rien sur votre réseau, encore moins sur Internet, ne peut le joindre.',
    'p.2t': 'Secrets au trousseau', 'p.2': 'Jetons et mots de passe vont dans le trousseau macOS. L’API ne les renvoie jamais, ils ne sont jamais journalisés ni sauvegardés.',
    'p.3t': 'Ni télémétrie, ni compte', 'p.3': 'Fremkit ne parle qu’aux services que vous avez configurés. Il n’y a rien à créer.',
    'p.4t': 'Widgets isolés', 'p.4': 'Chaque widget tourne dans un cadre isolé et ne reçoit que les canaux et connexions qu’il a déclarés et que vous avez acceptés.',
    'p.more': 'La liste complète de ce que Fremkit lit sur votre Mac est <a href="https://github.com/fdussert/fremkit#what-fremkit-reads-on-your-mac">dans le README</a>.',
    'b.kicker': 'Créer un widget', 'b.title': 'Un widget, <em>c’est un dossier.</em>',
    'b.sub': 'Un manifeste et une page HTML. Pas de build, pas de framework. L’hôte injecte un petit SDK, votre thème et les données auxquelles vous êtes abonné.',
    'b.1': 'Abonnez-vous à un canal, recevez des instantanés en direct', 'b.2': 'Réglages déclarés dans le manifeste, formulaire dessiné par l’admin',
    'b.3': 'Français et anglais, jetons de thème, mode compact', 'b.4': 'Publiez-le sur le Sietch par une pull request', 'b.cta': 'Lire le guide des widgets',
    'i.kicker': 'Installation', 'i.title': 'Téléchargez, <em>puis le doigt.</em>',
    'i.c1': 'cloner et installer', 'i.o1': 'prérequis', 'i.o2': 'dépendances', 'i.o3': 'identité de signature', 'i.o4': 'helper installé dans ~/Applications',
    'i.a1': '<b>Glissez Fremkit dans Applications</b> depuis le .dmg, ou laissez Homebrew le faire.',
    'i.a2': '<b>Quittez iCUE et Touchscreen Gestures.</b> La dalle tactile n’accepte qu’un seul maître.',
    'i.a3': '<b>Ouvrez Fremkit et accordez deux autorisations</b>, surveillance de l’entrée puis accessibilité. Celle qui manque encore s’affiche dans le menu de la barre des menus, et un clic ouvre le bon panneau des Réglages Système.',
    'i.a4': '<b>Ouvrez l’admin</b> depuis le <span class="kbd">F</span> de la barre des menus et ajoutez vos premiers widgets. Les mises à jour arrivent seules.',
    'i.dmg': 'Télécharger pour macOS', 'i.dmgSub': '.dmg signé et notarisé · se met à jour seul',
    'i.caskSub': 'Cask Homebrew · ni Node ni outils Xcode',
    'i.fda': 'Accès complet au disque, en option, pour la carte du disque',
    'i.srcT': 'Compiler depuis les sources, pour travailler sur Fremkit',
    'i.s1': '<b>Acceptez l’identité de signature.</b> macOS lie les autorisations à la signature : elles survivent ainsi aux recompilations.',
    'i.s2': '<b>Autorisez la surveillance de l’entrée et l’accessibilité</b> pour « Fremkit Helper », puis relancez-le depuis la barre des menus.',
    'i.s3': '<b>Vos changements passent en direct sur l’Edge.</b> Le helper fait tourner le serveur depuis votre checkout.',
    'hero.dl': 'Télécharger pour macOS',
    'i.edge': 'Corsair Xeneon Edge (tout écran marche, sans le tactile)',
    'f.title': 'Bonnes <em>questions.</em>',
    'f.q1': 'Faut-il un Xeneon Edge ?', 'f.a1': 'Non. Tout sauf le pilote tactile marche sur n’importe quel écran, et l’admin tourne dans n’importe quel navigateur du Mac.',
    'f.q2': 'Peut-il tourner à côté d’iCUE ?', 'f.a2': 'Non. La dalle n’accepte qu’un seul maître. Fremkit remplace iCUE et Touchscreen Gestures pour l’Edge au lieu de cohabiter avec eux.',
    'f.q3': 'Windows ? Mac Intel ?', 'f.a3': 'Pas aujourd’hui. Fremkit vise macOS 13 ou plus récent sur Apple silicon.',
    'f.q4': 'Comment se met-il à jour ?', 'f.a4': 'Tout seul, via Sparkle : chaque mise à jour est signée par le projet, et le menu de la barre des menus permet de vérifier tout de suite. Votre dashboard, vos connexions et vos fonds vivent dans ~/Library/Application Support/Fremkit : une mise à jour ou une réinstallation les garde.',
    'f.q5': 'Pourquoi « Fremkit » ?', 'f.a5': 'C’est le kit de survie des Fremen dans Dune. Le registre s’appelle le Sietch pour la même raison.',
    'end.title': 'Donnez un <em>métier</em> à votre Edge.', 'end.sub': 'Clonez, lancez une commande, et mettez ce que vous vérifiez sans arrêt là où un coup d’œil suffit.', 'end.star': 'Étoile sur GitHub',
    'tag.ed': 'ÉDITEUR', 'tag.nb': 'BARRE DE NAVIGATION', 'tag.t': 'TACTILE', 'tag.th': 'THÈMES', 'tag.mp': 'SIETCH', 'tag.bk': 'SAUVEGARDE',
    'foot.sec': 'Sécurité', 'foot.privacy': 'Confidentialité', 'foot.tm': 'Licence MIT. Corsair et Xeneon sont des marques de Corsair Gaming, Inc. Fremkit est un projet indépendant, ni affilié ni approuvé par Corsair.'
  }
  var EN_EXTRA = { copied: 'Copied', 'w.badgeCore': 'built in', 'w.conn': 'connection', 'w.offline': 'The registry cannot be reached right now: only the built-in widgets are listed.' }

  var CORE = [
    ['battery', 'Batteries', 'Batteries', 'Le Mac et ses périphériques Bluetooth', 'The Mac and its Bluetooth peripherals', 'system'],
    ['calendar', 'Prochains rendez-vous', 'Next events', 'L’agenda des jours qui viennent', 'The days ahead, calendar by calendar', 'productivity'],
    ['claude-sessions', 'Sessions Claude', 'Claude sessions', 'Sessions Claude Code en direct', 'Live Claude Code sessions', 'ai'],
    ['claude-usage', 'Quotas Claude', 'Claude limits', 'Quotas 5 h / 7 jours et tokens du jour', '5 h / 7 day limits and today’s tokens', 'ai'],
    ['clipboard', 'Presse-papiers', 'Clipboard', 'Entrées récentes, touchez pour recopier. En mémoire seulement, secrets masqués', 'Recent entries, tap to copy back. Memory only, secrets masked', 'productivity'],
    ['clock', 'Horloge', 'Clock', 'Heure et date', 'Time and date', 'info'],
    ['cpu', 'CPU', 'CPU', 'Charge CPU et température', 'CPU load and temperature', 'system'],
    ['disk', 'Disques', 'Disks', 'Une ligne par disque, comptée comme dans le Finder', 'One row per disk, counted like the Finder', 'system'],
    ['disk-map', 'Carte du disque', 'Disk map', 'Ce qui remplit le disque, en anneaux. Touchez pour descendre, rien n’est jamais supprimé', 'What fills the disk, as rings. Tap to drill in, nothing is ever deleted', 'system'],
    ['memory', 'Mémoire', 'Memory', 'Utilisation mémoire', 'Memory usage', 'system'],
    ['network', 'Réseau', 'Network', 'Débit réseau en direct', 'Live network throughput', 'system'],
    ['notifications', 'Notifications', 'Notifications', 'Pastilles de non-lus du Dock', 'Unread badges from the Dock', 'productivity'],
    ['pomodoro', 'Pomodoro', 'Pomodoro', 'Minuteur de travail et de pauses, au doigt', 'A touch timer for work and breaks', 'productivity'],
    ['processes', 'Processus', 'Processes', 'Top processus', 'Top processes', 'system'],
    ['service-status', 'État des services', 'Service status', 'Pastille verte, orange ou rouge par service, avec la latence', 'A green, amber or red dot per service, with latency', 'dev'],
    ['shortcuts', 'Raccourcis', 'Shortcuts', 'Gros boutons qui ouvrent une app, un lien ou un raccourci', 'Big touch buttons that open an app, a link or a shortcut', 'productivity'],
    ['spotify', 'Spotify', 'Spotify', 'Contrôle Spotify', 'Spotify controls', 'media'],
    ['uptime', 'Uptime', 'Uptime', 'Durée depuis le dernier démarrage', 'Time since the last boot', 'system'],
    ['volume', 'Volume', 'Volume', 'Contrôle du volume', 'Volume controls', 'system'],
    ['weather', 'Météo', 'Weather', 'Météo et prévisions, sans compte (Open-Meteo)', 'Weather and forecast, no account (Open-Meteo)', 'info']
  ].map(function (w) {
    return { id: w[0], name: { fr: w[1], en: w[2] }, description: { fr: w[3], en: w[4] }, category: w[5], source: 'core' }
  })

  var $ = function (s, r) { return (r || document).querySelector(s) }
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)) }
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var lang = 'en'
  var registry = null

  // ---------- i18n ----------
  var EN = {}
  $$('[data-i18n]').forEach(function (el) { EN[el.getAttribute('data-i18n')] = el.textContent })
  $$('[data-i18n-html]').forEach(function (el) { EN[el.getAttribute('data-i18n-html')] = el.innerHTML })
  for (var k in EN_EXTRA) EN[k] = EN_EXTRA[k]

  function t (key) { return (lang === 'fr' ? FR[key] : EN[key]) || EN[key] || key }

  function setLang (next) {
    lang = next === 'fr' ? 'fr' : 'en'
    document.documentElement.lang = lang
    $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')) })
    $$('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')) })
    try { localStorage.setItem('fremkit-lang', lang) } catch (e) {}
    renderWidgets()
    renderThemes()
  }

  var initial = new URLSearchParams(location.search).get('lang')
  if (!initial) { try { initial = localStorage.getItem('fremkit-lang') } catch (e) {} }

  $('#lang').addEventListener('click', function () { setLang(lang === 'en' ? 'fr' : 'en') })

  // ---------- copy ----------
  $$('[data-copy], .cmd').forEach(function (host) {
    var btn = host.classList.contains('copy') ? host : $('.copy', host)
    var text = host.getAttribute('data-copy')
    if (!btn || !text) return
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = t('copied'); btn.classList.add('done')
        setTimeout(function () { btn.textContent = t('copy'); btn.classList.remove('done') }, 1600)
      })
    })
  })

  // ---------- nav border ----------
  var nav = $('.nav')
  function onScroll () {
    nav.classList.toggle('scrolled', window.scrollY > 8)
    tilt()
  }

  // ---------- hero: the Edge straightens as you scroll ----------
  var edge = $('#edge'), stage = $('#stage')
  function tilt () {
    if (reduced) return
    var r = stage.getBoundingClientRect()
    var vh = window.innerHeight
    var p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.75)))
    edge.style.setProperty('--tilt', (22 * (1 - p)).toFixed(2) + 'deg')
    edge.style.setProperty('--scale', (0.94 + 0.06 * p).toFixed(3))
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', tilt)

  // ---------- hero: the recording, then the two real desks ----------
  var shots = $$('.shot'), tabs = $$('.pager button'), touch = $('.touch'), demo = $('#demo')
  var page = 0, STILL = 6500, timer = null
  function show (i, fromUser) {
    page = i
    var shot = shots[i], isVideo = shot.tagName === 'VIDEO'
    shots.forEach(function (s, n) { s.classList.toggle('is-on', n === i) })
    var length = isVideo && demo.duration ? demo.duration * 1000 : STILL
    tabs.forEach(function (b, n) {
      b.classList.remove('is-on'); void b.offsetWidth
      b.style.setProperty('--rotate', length + 'ms')
      b.classList.toggle('is-on', n === i)
      b.setAttribute('aria-selected', n === i)
    })
    clearTimeout(timer)
    if (isVideo) {
      demo.currentTime = 0
      if (!reduced) demo.play().catch(function () {})
    } else {
      demo.pause()
      if (!reduced) {
        touch.style.left = (fromUser ? 50 : 38 + Math.random() * 24) + '%'
        touch.style.top = '96%'
        touch.classList.remove('go'); void touch.offsetWidth; touch.classList.add('go')
      }
    }
    if (!reduced && !isVideo) timer = setTimeout(function () { show((page + 1) % shots.length) }, STILL)
  }
  demo.addEventListener('ended', function () { if (page === 0) show(1) })
  demo.addEventListener('loadedmetadata', function () { if (page === 0) tabs[0].style.setProperty('--rotate', demo.duration * 1000 + 'ms') })
  tabs.forEach(function (b, n) { b.addEventListener('click', function () { show(n, true) }) })

  // ---------- editor tabs ----------
  var adminShot = $('#admin-shot')
  $$('.win-tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('.win-tabs button').forEach(function (x) { x.classList.toggle('is-on', x === b) })
      adminShot.style.opacity = 0
      setTimeout(function () { adminShot.src = 'assets/' + b.getAttribute('data-shot'); adminShot.style.opacity = 1 }, 200)
    })
  })

  // ---------- code tabs ----------
  var pres = $$('.code pre')
  $$('.code-tabs button').forEach(function (b, n) {
    b.addEventListener('click', function () {
      $$('.code-tabs button').forEach(function (x) { x.classList.toggle('is-on', x === b) })
      pres.forEach(function (p, m) { p.classList.toggle('is-on', m === n) })
    })
  })

  // ---------- themes: one capture per theme ----------
  var THEMES = [
    { id: 'fremkit', name: { fr: 'Fremkit', en: 'Fremkit' }, accent: '#d9b36a', bg: '#0b0d10' },
    { id: 'edge', name: { fr: 'Edge', en: 'Edge' }, accent: '#ffae42', bg: '#1b2026' },
    { id: 'brume', name: { fr: 'Brume', en: 'Haze' }, accent: '#7fb3a3', bg: '#171a1d' },
    { id: 'nuit', name: { fr: 'Nuit', en: 'Night' }, accent: '#6aa8ff', bg: '#080b14' },
    { id: 'papier', name: { fr: 'Papier', en: 'Paper' }, accent: '#a2622a', bg: '#efebe1' },
    { id: 'terminal', name: { fr: 'Terminal', en: 'Terminal' }, accent: '#39ff88', bg: '#050807' }
  ]
  THEMES.forEach(function (th) { new Image().src = 'assets/theme-' + th.id + '.webp' })
  var themeIdx = 0, themeTimer = null, themeShot = $('#theme-shot')
  function applyTheme (i) {
    themeIdx = i
    var th = THEMES[i]
    themeShot.style.opacity = 0.35
    setTimeout(function () {
      themeShot.src = 'assets/theme-' + th.id + '.webp'
      themeShot.alt = (lang === 'fr' ? 'Le dashboard de démo avec le thème ' : 'The demo dashboard in the theme ') + (th.name[lang] || th.name.en)
      themeShot.style.opacity = 1
    }, 180)
    $$('#th-chips button').forEach(function (b, n) { b.classList.toggle('is-on', n === i); b.setAttribute('aria-selected', n === i) })
  }
  function renderThemes () {
    var box = $('#th-chips')
    box.innerHTML = ''
    THEMES.forEach(function (th, n) {
      var b = document.createElement('button')
      b.type = 'button'; b.setAttribute('role', 'tab')
      var i = document.createElement('i'); i.style.setProperty('--sw', th.accent); i.style.setProperty('--bgc', th.bg)
      b.appendChild(i); b.appendChild(document.createTextNode(th.name[lang] || th.name.en))
      b.addEventListener('click', function () { clearInterval(themeTimer); applyTheme(n) })
      box.appendChild(b)
    })
    $$('#th-chips button').forEach(function (b, n) { b.classList.toggle('is-on', n === themeIdx) })
  }
  function cycleThemes () {
    if (reduced) return
    clearInterval(themeTimer)
    themeTimer = setInterval(function () { applyTheme((themeIdx + 1) % THEMES.length) }, 3200)
  }

  // ---------- widgets ----------
  var filter = 'all'
  function renderWidgets () {
    var list = CORE.slice()
    if (registry) list = list.concat(registry.widgets.map(function (w) { return Object.assign({ source: 'sietch' }, w) }))
    list.sort(function (a, b) { return (a.name[lang] || a.name.en).localeCompare(b.name[lang] || b.name.en, lang) })
    $('#c-all').textContent = list.length
    $('#c-core').textContent = CORE.length
    $('#c-sietch').textContent = registry ? registry.widgets.length : '…'
    var grid = $('#wgrid')
    grid.innerHTML = ''
    list.filter(function (w) { return filter === 'all' || w.source === filter }).forEach(function (w, n) {
      var card = document.createElement('div')
      card.className = 'w'
      card.style.animationDelay = Math.min(n * 25, 500) + 'ms'
      var top = document.createElement('div'); top.className = 'w-top'
      var b = document.createElement('b'); b.textContent = w.name[lang] || w.name.en
      var badge = document.createElement('span'); badge.className = 'badge ' + w.source
      badge.textContent = w.source === 'core' ? t('w.badgeCore') : 'Sietch'
      top.appendChild(b); top.appendChild(badge)
      var p = document.createElement('p'); p.textContent = w.description[lang] || w.description.en
      var meta = document.createElement('span'); meta.className = 'meta'
      meta.textContent = [w.category, w.connections && w.connections.length ? w.connections.join(', ') + ' ' + t('w.conn') : '', w.version ? 'v' + w.version : '']
        .filter(Boolean).join(' · ')
      card.appendChild(top); card.appendChild(p); card.appendChild(meta)
      grid.appendChild(card)
    })
    if (registry === false && filter !== 'core') {
      var note = document.createElement('p'); note.className = 'fine'; note.textContent = t('w.offline')
      grid.appendChild(note)
    }
  }
  $$('#filters button').forEach(function (b) {
    b.addEventListener('click', function () {
      filter = b.getAttribute('data-f')
      $$('#filters button').forEach(function (x) { x.classList.toggle('is-on', x === b) })
      renderWidgets()
    })
  })

  fetch(REGISTRY, { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json() })
    .then(function (data) {
      registry = { widgets: data.widgets || [] }
      renderWidgets()
    })
    .catch(function () { registry = false; renderWidgets() })

  // ---------- reveal on scroll ----------
  var targets = $$('.section h2, .section .sub, .flow, .steps li, .card, .inv, .code, .term, .after li')
  if ('IntersectionObserver' in window && !reduced) {
    targets.forEach(function (el) { el.classList.add('reveal') })
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return
        var sibs = Array.prototype.indexOf.call(e.target.parentNode.children, e.target)
        e.target.style.transitionDelay = Math.min(sibs, 4) * 70 + 'ms'
        e.target.classList.add('in')
        io.unobserve(e.target)
      })
    }, { rootMargin: '0px 0px -8% 0px' })
    targets.forEach(function (el) { io.observe(el) })
  }

  // ---------- go ----------
  setLang(initial || 'en')
  onScroll()
  show(0)
  cycleThemes()
})()
