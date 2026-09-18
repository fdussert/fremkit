/**
 * Server-side translations for everything the API hands back to a human: validation errors,
 * refusals, connection-test results, and the few pieces of provider data that are prose rather
 * than numbers.
 *
 * Purely internal messages — log lines, thrown errors nobody renders, widget-authoring
 * complaints — stay in one language on purpose: translating them buys nothing and doubles the
 * surface that has to stay in step.
 *
 * This module deliberately imports nothing from `config/`: the config schema needs `tr()` for its
 * own default page name, and a cycle between the two would leave one of them half-initialised.
 */

export type Locale = 'fr' | 'en'
export type Params = Record<string, string | number>

/**
 * French is the reference dictionary: every key is written here first, and a key missing from
 * `en` falls back to its French text rather than to the bare key.
 */
const fr = {
  // config/schema.ts — layout and connection checks
  'config.defaultPageName': 'Accueil',
  'config.backgroundName': 'nom de fichier invalide',
  'layout.duplicateInstance': 'page {page}: instanceId {instanceId} dupliqué',
  'layout.outsideGrid': 'page {page}: {instanceId} hors grille',
  'layout.tooSmall': 'page {page}: {instanceId} taille {w}×{h} plus petite que le minimum {minW}×{minH} de {widgetId}',
  'layout.overlap': 'page {page}: {a} chevauche {b}',
  'navWidgets.duplicateInstance': 'barre de navigation : instanceId {instanceId} dupliqué',
  'navWidgets.unknownWidget': 'barre de navigation : widget inconnu {widgetId}',
  'navWidgets.notCompact': 'barre de navigation : le widget {widgetId} n’a pas de rendu compact',
  'config.duplicateConnection': 'connexion {id} déclarée deux fois',
  'config.degraded': 'configuration sur disque illisible : corrigez data/fremkit.json puis redémarrez le serveur',

  // app.ts — the global request gate
  'provider.invalidPayload': 'charge utile invalide',
  'clipboard.unknownEntry': 'entrée inconnue',
  'serviceStatus.invalidHost': 'hôte invalide',
  'serviceStatus.invalidHostPort': 'hôte:port invalide',
  'provider.refusedUrl': 'URL refusée',
  'manifest.suggestWhenWithoutSuggest': 'suggestWhen ne vaut que pour un champ qui déclare suggest',
  'manifest.connectionNeedsType': 'un réglage de type connection doit déclarer connectionType',
  'manifest.pickNeedsConnection': 'un réglage de type pick doit déclarer connection',
  'manifest.pickNeedsSource': 'un réglage de type pick doit déclarer source',
  'manifest.listNeedsItemSchema': 'un réglage de type list doit déclarer itemSchema',
  'manifest.defaultSizeTooSmall': 'defaultSize doit être supérieur ou égal à minSize',
  'ws.tooManyChannels': 'trop de canaux',
  'manifest.reservedChannel': 'canal réservé à l’hôte',
  'manifest.privateNetworkHost': 'hôte privé ou local interdit dans permissions.network',
  'bambu.invalidUrl': 'url invalide',
  'config.unknownVersion': 'version de config inconnue : {version}',
  'backup.noArchive': 'aucune archive reçue',
  'backup.badArchive': 'archive illisible',
  'backup.noConfig': 'l’archive ne contient pas fremkit.json',
  'backup.badConfig': 'la configuration de l’archive est invalide',
  'backup.badName': 'nom de fond d’écran invalide dans l’archive',
  'backup.notAnImage': 'un fond d’écran de l’archive n’est pas une image',
  'backup.imageTooLarge': 'un fond d’écran de l’archive est trop grand',
  'backup.writeFailed': 'écriture des fonds d’écran impossible',
  'http.hostNotAllowed': 'hôte non autorisé',
  'http.originNotAllowed': 'origine non autorisée',

  // connections/routes.ts
  'connections.originNotAllowed': 'origine non autorisée',
  'connections.invalidId': 'identifiant de connexion invalide : {id}',
  'connections.secretBound': 'le secret enregistré est lié au champ « {field} » : ressaisissez-le pour le changer',
  'connections.unknownType': 'type de connexion inconnu : {type}',
  'connections.typeImmutable': 'le type d’une connexion existante ne peut pas changer',
  'connections.secretWriteFailed': 'enregistrement du secret impossible ; réessayez',
  'spotify.activateFailed': 'impossible d’ouvrir Spotify',
  'secrets.readFailed': 'trousseau : lecture impossible',
  'secrets.writeFailed': 'trousseau : écriture impossible',
  'secrets.deleteFailed': 'trousseau : suppression impossible',
  'connections.unknown': 'connexion inconnue',
  'connections.usedByEntry': '{widgetId} (page « {page} »)',
  'connections.usedBy': 'Connexion utilisée par : {list}',
  'connections.testFailed': 'Test impossible ({name})',
  'connections.noOptions': 'le type {type} ne propose aucune liste de choix',
  'connections.unknownSource': 'liste de choix inconnue : {source}',
  'connections.optionsFailed': 'liste de choix indisponible',

  // connections/registry.ts — form validation
  'connections.fieldIsSecret': 'le champ « {field} » est secret et ne peut pas être enregistré en clair',
  'connections.unknownField': 'champ inconnu pour le type {type} : {key}',
  'connections.unknownSecretField': 'champ secret inconnu pour le type {type} : {key}',
  'connections.fieldRequired': 'le champ « {field} » est obligatoire',
  'connections.unexpectedValue': 'valeur inattendue pour « {field} » : {value}',
  'connections.invalidColor': 'couleur invalide pour « {field} » : #rrggbb attendu',

  // connections/types/azure-devops.ts
  'ado.unreachable': 'serveur injoignable',
  'ado.connected': 'Connexion établie avec {organization}/{project}',
  'ado.patRefused': 'PAT refusé',
  'ado.notFound': 'organisation ou projet introuvable',
  'ado.unexpected': 'réponse inattendue (HTTP {status})',

  // connections/types/ics.ts
  'ics.unreachable': 'calendrier injoignable',
  'ics.notHttps': 'adresse invalide : une URL https est attendue',
  'ics.notACalendar': 'ce lien ne renvoie pas un calendrier iCalendar',
  'ics.tooLarge': 'calendrier trop volumineux (5 Mo maximum)',
  'ics.tooManyRedirects': 'trop de redirections',
  'ics.unexpected': 'réponse inattendue (HTTP {status})',
  'ics.connected': 'Calendrier lu ({events} évènements)',

  // connections/types/bambu.ts
  'bambu.invalidAddress': 'adresse invalide : une IP ou un nom d’hôte est attendu',
  'bambu.noAnswer': 'aucune réponse de l’imprimante en 10 s',
  'bambu.reachable': 'Imprimante joignable (état : {state})',
  'bambu.refused': 'connexion refusée par l’imprimante (code d’accès ou IP)',

  // connections/types/github.ts
  'github.invalidHost': 'hôte invalide : une URL https est attendue (ex. https://github.exemple.com/api/v3)',
  'github.unreachable': 'GitHub injoignable',
  'github.tokenRefused': 'jeton refusé (portées notifications, repo et Actions attendues)',
  'github.rateLimited': 'quota d’API GitHub épuisé ; réessayez plus tard',
  'github.unexpected': 'réponse inattendue (HTTP {status})',
  'github.connected': 'Connecté à GitHub en tant que {login}',
  'github.connectedFineGrained':
    'Connecté à GitHub en tant que {login} · jeton à granularité fine : notifications indisponibles, revues et Actions OK',
  'github.privateRepo': 'privé',

  // connections/types/homey.ts
  'homey.invalidAddress': 'adresse invalide : une IP ou un nom d’hôte est attendu',
  'homey.unreachable': 'Homey injoignable',
  'homey.unauthorized': 'clé API refusée (portées Appareils et Flows attendues)',
  'homey.unexpected': 'réponse inattendue (HTTP {status})',
  'homey.connected': 'Homey joignable ({name}, v{version})',
  'homey.connectedDevices': 'Homey joignable ({devices} appareils)',

  // providers/bambu.ts — `stg_cur`, the printer's current stage
  'bambu.stage.-1': 'Au repos',
  'bambu.stage.0': 'Impression',
  'bambu.stage.1': 'Préchauffage du plateau',
  'bambu.stage.2': 'Inspection des extrudeuses',
  'bambu.stage.4': 'Changement de filament',
  'bambu.stage.7': 'Nettoyage de la buse',
  'bambu.stage.8': 'Calibration',
  'bambu.stage.9': 'Calibration du plateau',
  'bambu.stage.12': 'Mise en pause',
  'bambu.stage.14': 'Nivellement du plateau',

  // claude/account.ts — names of the usage windows Claude reports
  'claude.limit.session': '5 h',
  'claude.limit.weeklyAll': '7 jours',

  // providers — commands refused
  'provider.localOnly': 'commande réservée à cette machine',
  'provider.urlRefused': 'URL refusée',

  // proxy/routes.ts
  'claude.invalidDismiss': 'identifiant de session invalide',
  'github.invalidCommand': 'commande invalide',
  'homey.invalidCommand': 'commande invalide',
  'volume.invalidLevel': 'niveau de volume invalide',
  'volume.invalidMute': 'valeur de sourdine invalide',
  'homey.notWritable': 'cette capacité n’est pas modifiable',
  'serviceStatus.unknownInstance': 'widget d’état de service inconnu',
  'serviceStatus.noServices': 'aucun service enregistré',
  'shortcuts.unknownInstance': 'widget de raccourcis inconnu',
  'shortcuts.unknownButton': 'bouton inconnu',
  'proxy.badScheme': 'schéma non autorisé',
  'proxy.badUrl': 'url invalide',
  'proxy.privateHost': 'hôte privé ou local: {host}',
  'proxy.tooManyRedirects': 'trop de redirections',
  'proxy.tooLarge': 'réponse trop volumineuse',
  'proxy.upstreamFailed': 'le serveur distant n’a pas répondu',
  'proxy.hostNotAllowed': 'hôte non autorisé: {host}',
  'proxy.missingUrl': 'paramètre url manquant',
  'proxy.redirectNotAllowed': 'redirection vers un hôte non autorisé: {host}',

  // backgrounds/routes.ts
  'backgrounds.missingData': 'données manquantes',
  'backgrounds.unsupportedFormat': 'format non supporté (PNG, JPEG ou WebP)',
  'backgrounds.emptyImage': 'image vide',
  'backgrounds.unknownImage': 'image inconnue',

  // widgets/routes.ts, proxy/routes.ts, bambu/routes.ts
  'widgets.unknown': 'widget inconnu',
  'bambu.unknownConnection': 'connexion inconnue',


  // dock/routes.ts
  'dock.notLocal': 'hôte non local',
  'dock.iconCacheFull': 'cache d’icônes plein',
  'dock.unknownIcon': 'icône inconnue',

  // helper/routes.ts
  'helper.notLocal': 'hôte non local',
  'helper.unavailable': 'assistant Fremkit indisponible',
}

export type MessageKey = keyof typeof fr

const en: Record<MessageKey, string> = {
  'config.defaultPageName': 'Home',
  'config.backgroundName': 'invalid file name',
  'layout.duplicateInstance': 'page {page}: duplicate instanceId {instanceId}',
  'layout.outsideGrid': 'page {page}: {instanceId} outside the grid',
  'layout.tooSmall': 'page {page}: {instanceId} size {w}×{h} is smaller than the {minW}×{minH} minimum of {widgetId}',
  'layout.overlap': 'page {page}: {a} overlaps {b}',
  'navWidgets.duplicateInstance': 'navigation bar: duplicate instanceId {instanceId}',
  'navWidgets.unknownWidget': 'navigation bar: unknown widget {widgetId}',
  'navWidgets.notCompact': 'navigation bar: widget {widgetId} has no compact rendering',
  'config.duplicateConnection': 'connection {id} declared twice',
  'config.degraded': 'configuration on disk is unreadable: fix data/fremkit.json then restart the server',

  'provider.invalidPayload': 'invalid payload',
  'clipboard.unknownEntry': 'unknown entry',
  'serviceStatus.invalidHost': 'invalid host',
  'serviceStatus.invalidHostPort': 'invalid host:port',
  'provider.refusedUrl': 'URL refused',
  'manifest.suggestWhenWithoutSuggest': 'suggestWhen only applies to a field that declares suggest',
  'manifest.connectionNeedsType': 'a connection setting must declare connectionType',
  'manifest.pickNeedsConnection': 'a pick setting must declare connection',
  'manifest.pickNeedsSource': 'a pick setting must declare source',
  'manifest.listNeedsItemSchema': 'a list setting must declare itemSchema',
  'manifest.defaultSizeTooSmall': 'defaultSize must be greater than or equal to minSize',
  'ws.tooManyChannels': 'too many channels',
  'manifest.reservedChannel': 'channel reserved for the host',
  'manifest.privateNetworkHost': 'a private or local host is not allowed in permissions.network',
  'bambu.invalidUrl': 'invalid url',
  'config.unknownVersion': 'unknown config version: {version}',
  'backup.noArchive': 'no archive received',
  'backup.badArchive': 'the archive could not be read',
  'backup.noConfig': 'the archive holds no fremkit.json',
  'backup.badConfig': 'the configuration in the archive is not valid',
  'backup.badName': 'invalid background name in the archive',
  'backup.notAnImage': 'a background in the archive is not an image',
  'backup.imageTooLarge': 'a background in the archive is too large',
  'backup.writeFailed': 'the backgrounds could not be written',
  'http.hostNotAllowed': 'host not allowed',
  'http.originNotAllowed': 'origin not allowed',
  'connections.originNotAllowed': 'origin not allowed',
  'connections.invalidId': 'invalid connection id: {id}',
  'connections.secretBound': 'the stored secret is tied to the “{field}” field: re-enter it to change it',
  'connections.unknownType': 'unknown connection type: {type}',
  'connections.typeImmutable': 'the type of an existing connection cannot be changed',
  'connections.secretWriteFailed': 'could not store the secret; try again',
  'spotify.activateFailed': 'could not open Spotify',
  'secrets.readFailed': 'keychain: could not be read',
  'secrets.writeFailed': 'keychain: could not be written',
  'secrets.deleteFailed': 'keychain: could not be cleared',
  'connections.unknown': 'unknown connection',
  'connections.usedByEntry': '{widgetId} (page “{page}”)',
  'connections.usedBy': 'Connection used by: {list}',
  'connections.testFailed': 'Test failed ({name})',
  'connections.noOptions': 'the {type} type offers no list of choices',
  'connections.unknownSource': 'unknown list of choices: {source}',
  'connections.optionsFailed': 'list of choices unavailable',

  'connections.fieldIsSecret': 'the “{field}” field is a secret and cannot be stored in the clear',
  'connections.unknownField': 'unknown field for type {type}: {key}',
  'connections.unknownSecretField': 'unknown secret field for type {type}: {key}',
  'connections.fieldRequired': 'the “{field}” field is required',
  'connections.unexpectedValue': 'unexpected value for “{field}”: {value}',
  'connections.invalidColor': 'invalid colour for “{field}”: #rrggbb expected',

  'ado.unreachable': 'server unreachable',
  'ado.connected': 'Connected to {organization}/{project}',
  'ado.patRefused': 'PAT refused',
  'ado.notFound': 'organization or project not found',
  'ado.unexpected': 'unexpected response (HTTP {status})',

  'ics.unreachable': 'calendar unreachable',
  'ics.notHttps': 'invalid address: an https URL is expected',
  'ics.notACalendar': 'this link does not return an iCalendar calendar',
  'ics.tooLarge': 'calendar too large (5 MB maximum)',
  'ics.tooManyRedirects': 'too many redirects',
  'ics.unexpected': 'unexpected response (HTTP {status})',
  'ics.connected': 'Calendar read ({events} events)',

  'bambu.invalidAddress': 'invalid address: an IP or a host name is expected',
  'bambu.noAnswer': 'no answer from the printer within 10 s',
  'bambu.reachable': 'Printer reachable (state: {state})',
  'bambu.refused': 'connection refused by the printer (access code or IP)',

  'github.invalidHost': 'invalid host: an https URL is expected (e.g. https://github.example.com/api/v3)',
  'github.unreachable': 'GitHub unreachable',
  'github.tokenRefused': 'token refused (notifications, repo and Actions scopes expected)',
  'github.rateLimited': 'GitHub API quota exhausted; try again later',
  'github.unexpected': 'unexpected response (HTTP {status})',
  'github.connected': 'Connected to GitHub as {login}',
  'github.connectedFineGrained':
    'Connected to GitHub as {login} · fine-grained token: notifications unavailable, reviews and Actions OK',
  'github.privateRepo': 'private',

  'homey.invalidAddress': 'invalid address: an IP or a host name is expected',
  'homey.unreachable': 'Homey unreachable',
  'homey.unauthorized': 'API key refused (Devices and Flows scopes expected)',
  'homey.unexpected': 'unexpected response (HTTP {status})',
  'homey.connected': 'Homey reachable ({name}, v{version})',
  'homey.connectedDevices': 'Homey reachable ({devices} devices)',

  'bambu.stage.-1': 'Idle',
  'bambu.stage.0': 'Printing',
  'bambu.stage.1': 'Preheating the bed',
  'bambu.stage.2': 'Checking the extruders',
  'bambu.stage.4': 'Changing filament',
  'bambu.stage.7': 'Cleaning the nozzle',
  'bambu.stage.8': 'Calibrating',
  'bambu.stage.9': 'Calibrating the bed',
  'bambu.stage.12': 'Pausing',
  'bambu.stage.14': 'Levelling the bed',

  'claude.limit.session': '5 h',
  'claude.limit.weeklyAll': '7 days',

  'provider.localOnly': 'command restricted to this machine',
  'provider.urlRefused': 'URL refused',

  'claude.invalidDismiss': 'invalid session id',
  'github.invalidCommand': 'invalid command',
  'homey.invalidCommand': 'invalid command',
  'volume.invalidLevel': 'invalid volume level',
  'volume.invalidMute': 'invalid mute value',
  'homey.notWritable': 'that capability cannot be written',
  'serviceStatus.unknownInstance': 'unknown service-status widget',
  'serviceStatus.noServices': 'no services saved',
  'shortcuts.unknownInstance': 'unknown shortcuts widget',
  'shortcuts.unknownButton': 'unknown button',
  'proxy.badScheme': 'scheme not allowed',
  'proxy.badUrl': 'invalid url',
  'proxy.privateHost': 'private or local host: {host}',
  'proxy.tooManyRedirects': 'too many redirects',
  'proxy.tooLarge': 'response too large',
  'proxy.upstreamFailed': 'the remote server did not answer',
  'proxy.hostNotAllowed': 'host not allowed: {host}',
  'proxy.missingUrl': 'missing url parameter',
  'proxy.redirectNotAllowed': 'redirect to a host that is not allowed: {host}',

  'backgrounds.missingData': 'missing data',
  'backgrounds.unsupportedFormat': 'unsupported format (PNG, JPEG or WebP)',
  'backgrounds.emptyImage': 'empty image',
  'backgrounds.unknownImage': 'unknown image',

  'widgets.unknown': 'unknown widget',
  'bambu.unknownConnection': 'unknown connection',


  'dock.notLocal': 'host is not local',
  'dock.iconCacheFull': 'icon cache full',
  'dock.unknownIcon': 'unknown icon',

  'helper.notLocal': 'host is not local',
  'helper.unavailable': 'Fremkit Helper is unavailable',
}

const DICTIONARIES: Record<Locale, Record<string, string>> = { fr, en }

/**
 * The language used when a caller has no config store at hand — providers, the proxy, anything
 * running far from a request. Kept in step with the config by `buildApp`, so it is only ever the
 * startup default for the short moment before the first load.
 */
let current: Locale = 'fr'

export function setServerLocale(locale: Locale | undefined): void {
  current = locale === 'en' ? 'en' : 'fr'
}

export function serverLocale(): Locale {
  return current
}

/** `locale` is optional: leaving it out uses whatever the loaded config last set. */
export function tr(locale: Locale | undefined, key: MessageKey, params?: Params): string {
  const target: Locale = locale ?? current
  const text = DICTIONARIES[target][key] ?? fr[key] ?? key
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text
}

/**
 * A text a manifest or a connection type may write either as one string (legacy, shown as is) or
 * as a `{ fr, en }` pair. Resolving falls back the same way `tr()` does.
 */
export type LocalizedText = string | Record<string, string>

export function pick(text: LocalizedText | undefined, locale: Locale | undefined): string {
  if (text === undefined) return ''
  if (typeof text === 'string') return text
  const target: Locale = locale ?? current
  return text[target] ?? text.en ?? text.fr ?? Object.values(text)[0] ?? ''
}
