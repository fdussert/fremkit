import Foundation

/// The language the helper's menus are written in.
public enum Language: String {
    case fr
    case en
}

/// Every text the helper puts in front of a user: the status menu, the state lines behind it, and
/// the admin window's own menu bar.
///
/// Log lines and error descriptions are deliberately absent. They are read by whoever is debugging
/// the helper, never by the person using it, and translating them would only double the surface
/// that has to stay in step.
public enum L10nKey: String, CaseIterable {
    // Server state line
    case serverExternal
    case serverStarting
    case serverRunning
    case serverStopped
    /// One `%d`: seconds until the relaunch.
    case serverRestarting

    // Touch state line
    case touchActive
    case touchAccessibilityMissing
    case touchNotPermitted
    case touchBusy
    /// One `%08X`: the IOKit result code.
    case touchOpenFailed
    case touchNoDisplay
    case touchDisabled

    // Dock reader state line
    case dockDisabled
    case dockAccessibilityMissing
    case dockNoDock
    case dockActive

    // Other state lines
    case fenceMissingPermission
    case loginFailed
    case loginNeedsApproval

    // Status menu actions and toggles
    case openAdmin
    case openAdminInBrowser
    case reloadDashboard
    case toggleTouch
    case toggleFence
    case toggleDock
    case toggleManageServer
    case toggleLaunchAtLogin
    case openLog
    case quit

    // Admin window and its menu bar
    case adminWindowTitle
    case menuHideFremkit
    case menuQuitFremkit
    case menuEdit
    case menuUndo
    case menuRedo
    case menuCut
    case menuCopy
    case menuPaste
    case menuSelectAll
    case menuWindow
    case menuClose
    case menuMinimize
    case menuReload
}

/// French and English tables for `L10nKey`, and the rule that picks between them.
public enum L10n {
    private static let fr: [L10nKey: String] = [
        .serverExternal: "Serveur : externe",
        .serverStarting: "Serveur : démarrage…",
        .serverRunning: "Serveur : lancé",
        .serverStopped: "Serveur : arrêté",
        .serverRestarting: "Serveur : redémarrage dans %d s",

        .touchActive: "Tactile : actif",
        .touchAccessibilityMissing: "Tactile : accessibilité manquante",
        .touchNotPermitted: "Tactile : permission manquante",
        .touchBusy: "Tactile : occupé par un autre driver",
        .touchOpenFailed: "Tactile : erreur d'ouverture (0x%08X)",
        .touchNoDisplay: "Tactile : écran absent",
        .touchDisabled: "Tactile : désactivé",

        .dockDisabled: "Notifications : désactivées",
        .dockAccessibilityMissing: "Notifications : Accessibilité manquante",
        .dockNoDock: "Notifications : Dock introuvable",
        .dockActive: "Notifications : actives",

        .fenceMissingPermission: "Barrière : permission manquante",
        .loginFailed: "Lancement au login : erreur",
        .loginNeedsApproval: "Lancement à l'ouverture : approbation requise dans Réglages Système",

        .openAdmin: "Ouvrir l'admin",
        .openAdminInBrowser: "Admin dans le navigateur",
        .reloadDashboard: "Recharger le dashboard",
        .toggleTouch: "Tactile",
        .toggleFence: "Barrière Edge",
        .toggleDock: "Notifications",
        .toggleManageServer: "Gérer le serveur",
        .toggleLaunchAtLogin: "Lancer au login",
        .openLog: "Journal…",
        .quit: "Quitter",

        .adminWindowTitle: "Fremkit — admin",
        .menuHideFremkit: "Masquer Fremkit",
        .menuQuitFremkit: "Quitter Fremkit",
        .menuEdit: "Édition",
        .menuUndo: "Annuler",
        .menuRedo: "Rétablir",
        .menuCut: "Couper",
        .menuCopy: "Copier",
        .menuPaste: "Coller",
        .menuSelectAll: "Tout sélectionner",
        .menuWindow: "Fenêtre",
        .menuClose: "Fermer",
        .menuMinimize: "Réduire",
        .menuReload: "Recharger",
    ]

    private static let en: [L10nKey: String] = [
        .serverExternal: "Server: external",
        .serverStarting: "Server: starting…",
        .serverRunning: "Server: running",
        .serverStopped: "Server: stopped",
        .serverRestarting: "Server: restarting in %d s",

        .touchActive: "Touch: active",
        .touchAccessibilityMissing: "Touch: Accessibility missing",
        .touchNotPermitted: "Touch: permission missing",
        .touchBusy: "Touch: taken by another driver",
        .touchOpenFailed: "Touch: could not open it (0x%08X)",
        .touchNoDisplay: "Touch: display absent",
        .touchDisabled: "Touch: disabled",

        .dockDisabled: "Notifications: disabled",
        .dockAccessibilityMissing: "Notifications: Accessibility missing",
        .dockNoDock: "Notifications: Dock not found",
        .dockActive: "Notifications: active",

        .fenceMissingPermission: "Fence: permission missing",
        .loginFailed: "Launch at login: failed",
        .loginNeedsApproval: "Open at login: approval required in System Settings",

        .openAdmin: "Open the admin",
        .openAdminInBrowser: "Admin in the browser",
        .reloadDashboard: "Reload the dashboard",
        .toggleTouch: "Touch",
        .toggleFence: "Edge fence",
        .toggleDock: "Notifications",
        .toggleManageServer: "Manage the server",
        .toggleLaunchAtLogin: "Launch at login",
        .openLog: "Log…",
        .quit: "Quit",

        .adminWindowTitle: "Fremkit — admin",
        .menuHideFremkit: "Hide Fremkit",
        .menuQuitFremkit: "Quit Fremkit",
        .menuEdit: "Edit",
        .menuUndo: "Undo",
        .menuRedo: "Redo",
        .menuCut: "Cut",
        .menuCopy: "Copy",
        .menuPaste: "Paste",
        .menuSelectAll: "Select All",
        .menuWindow: "Window",
        .menuClose: "Close",
        .menuMinimize: "Minimize",
        .menuReload: "Reload",
    ]

    /// French for a French system, English for everything else — the same rule the server uses.
    ///
    /// Only the first preferred language counts: it is the one macOS itself draws its menus in,
    /// and a menu bar in two languages at once would read worse than one in the wrong one.
    public static func language(preferred: [String]) -> Language {
        guard let first = preferred.first?.lowercased() else { return .en }
        return first.hasPrefix("fr") ? .fr : .en
    }

    /// Read once: the helper does not survive a language change in System Settings anyway.
    public static let current: Language = language(preferred: Locale.preferredLanguages)

    /// The text for `key`, in `language`. English falls back to French, which holds every key.
    public static func string(_ key: L10nKey, language: Language = current) -> String {
        switch language {
        case .fr: return fr[key] ?? key.rawValue
        case .en: return en[key] ?? fr[key] ?? key.rawValue
        }
    }

    /// Same, with `String(format:)` applied — for the two texts that carry a value.
    public static func string(_ key: L10nKey, _ arguments: CVarArg..., language: Language = current) -> String {
        String(format: string(key, language: language), arguments: arguments)
    }
}
