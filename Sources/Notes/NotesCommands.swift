import AppKit
import BentoCore

/// Every command of the notes window, with Raycast's shortcuts. Used by the key
/// handler, the actions panel (⌘K), the format bar tooltips and the settings list.
enum NotesCommand: String, CaseIterable {
    case newNote, browse, actions, togglePin, duplicate, copyAs, format, toggleFormatBar
    case find, zoomIn, zoomOut, resetZoom, toggleAutoResize, toggleFloat, toggleScreenSharing
    case export, recentlyDeleted, settings, deleteNote, deleteAll, back, forward, close
    case heading1, heading2, heading3, paragraph, bold, italic, underline, strike, inlineCode, link
    case codeBlock, quote, orderedList, bulletList, taskList, toggleTask, moveUp, moveDown
    case insertImage, toggleVim

    var title: String {
        switch self {
        case .newNote: return "New Note"
        case .browse: return "Browse Notes"
        case .actions: return "Show Actions"
        case .togglePin: return "Pin Note"
        case .duplicate: return "Duplicate Note"
        case .copyAs: return "Copy Note As…"
        case .format: return "Format…"
        case .toggleFormatBar: return "Show Format Bar"
        case .find: return "Find in Note"
        case .zoomIn: return "Zoom In"
        case .zoomOut: return "Zoom Out"
        case .resetZoom: return "Reset Zoom"
        case .toggleAutoResize: return "Enable Window Auto-sizing"
        case .toggleFloat: return "Float on Top"
        case .toggleScreenSharing: return "Hide While Screen Sharing"
        case .export: return "Export…"
        case .recentlyDeleted: return "Recently Deleted Notes"
        case .settings: return "Open Notes Settings"
        case .deleteNote: return "Delete Note"
        case .deleteAll: return "Delete All Notes"
        case .back: return "Go Back"
        case .forward: return "Go Forward"
        case .close: return "Close Window"
        case .heading1: return "Heading 1"
        case .heading2: return "Heading 2"
        case .heading3: return "Heading 3"
        case .paragraph: return "Text"
        case .bold: return "Bold"
        case .italic: return "Italic"
        case .underline: return "Underline"
        case .strike: return "Strikethrough"
        case .inlineCode: return "Code"
        case .link: return "Link"
        case .codeBlock: return "Code Block"
        case .quote: return "Blockquote"
        case .orderedList: return "Ordered List"
        case .bulletList: return "Bullet List"
        case .taskList: return "Task List"
        case .toggleTask: return "Toggle Task"
        case .moveUp: return "Move List Item Up"
        case .moveDown: return "Move List Item Down"
        case .insertImage: return "Insert Image…"
        case .toggleVim: return "Toggle Vim Mode"
        }
    }

    var symbol: String {
        switch self {
        case .newNote: return "plus"
        case .browse: return "list.bullet.rectangle"
        case .actions: return "command"
        case .togglePin: return "pin"
        case .duplicate: return "plus.square.on.square"
        case .copyAs: return "doc.on.clipboard"
        case .format: return "textformat"
        case .toggleFormatBar: return "character"
        case .find: return "magnifyingglass"
        case .zoomIn: return "plus.magnifyingglass"
        case .zoomOut: return "minus.magnifyingglass"
        case .resetZoom: return "1.magnifyingglass"
        case .toggleAutoResize: return "arrow.up.and.down"
        case .toggleFloat: return "macwindow.on.rectangle"
        case .toggleScreenSharing: return "video.slash"
        case .export: return "square.and.arrow.up"
        case .recentlyDeleted: return "arrow.counterclockwise"
        case .settings: return "gearshape"
        case .deleteNote, .deleteAll: return "trash"
        case .back: return "chevron.left"
        case .forward: return "chevron.right"
        case .close: return "xmark"
        case .heading1: return "textformat.size.larger"
        case .heading2: return "textformat.size"
        case .heading3: return "textformat.size.smaller"
        case .paragraph: return "text.alignleft"
        case .bold: return "bold"
        case .italic: return "italic"
        case .underline: return "underline"
        case .strike: return "strikethrough"
        case .inlineCode: return "chevron.left.forwardslash.chevron.right"
        case .link: return "link"
        case .codeBlock: return "curlybraces.square"
        case .quote: return "text.quote"
        case .orderedList: return "list.number"
        case .bulletList: return "list.bullet"
        case .taskList: return "checklist"
        case .toggleTask: return "checkmark.square"
        case .moveUp: return "arrow.up"
        case .moveDown: return "arrow.down"
        case .insertImage: return "photo"
        case .toggleVim: return "keyboard"
        }
    }

    var shortcutString: String? {
        switch self {
        case .newNote: return "cmd+n"
        case .browse: return "cmd+p"
        case .actions: return "cmd+k"
        case .togglePin: return "cmd+shift+p"
        case .duplicate: return "cmd+d"
        case .copyAs: return "cmd+shift+c"
        case .format: return "cmd+shift+comma"
        case .toggleFormatBar: return "cmd+opt+comma"
        case .find: return "cmd+f"
        case .zoomIn: return "cmd+equal"
        case .zoomOut: return "cmd+minus"
        case .resetZoom: return "cmd+0"
        case .toggleAutoResize: return "cmd+shift+slash"
        case .export: return "cmd+shift+e"
        case .settings: return "cmd+comma"
        case .deleteNote: return "ctrl+x"
        case .deleteAll: return "ctrl+shift+x"
        case .back: return "cmd+leftbracket"
        case .forward: return "cmd+rightbracket"
        case .close: return "cmd+w"
        case .heading1: return "cmd+opt+1"
        case .heading2: return "cmd+opt+2"
        case .heading3: return "cmd+opt+3"
        case .paragraph: return "cmd+opt+0"
        case .bold: return "cmd+b"
        case .italic: return "cmd+i"
        case .underline: return "cmd+u"
        case .strike: return "cmd+shift+s"
        case .inlineCode: return "cmd+e"
        case .link: return "cmd+l"
        case .codeBlock: return "cmd+opt+c"
        case .quote: return "cmd+shift+b"
        case .orderedList: return "cmd+shift+7"
        case .bulletList: return "cmd+shift+8"
        case .taskList: return "cmd+shift+9"
        case .toggleTask: return "cmd+return"
        case .moveUp: return "ctrl+cmd+up"
        case .moveDown: return "ctrl+cmd+down"
        case .toggleVim: return "cmd+opt+v"
        case .toggleFloat, .toggleScreenSharing, .recentlyDeleted, .insertImage: return nil
        }
    }

    var shortcut: Shortcut? { shortcutString.flatMap(Shortcut.init) }

    var isFormatting: Bool {
        switch self {
        case .heading1, .heading2, .heading3, .paragraph, .bold, .italic, .underline, .strike, .inlineCode, .link,
             .codeBlock, .quote, .orderedList, .bulletList, .taskList, .toggleTask, .moveUp, .moveDown: return true
        default: return false
        }
    }

    /// Commands listed in the Format… submenu, in Raycast's order.
    static let formatMenu: [NotesCommand] = [.heading1, .heading2, .heading3, .paragraph, .bold, .italic, .underline, .strike,
                                             .inlineCode, .link, .codeBlock, .quote, .orderedList, .bulletList, .taskList,
                                             .toggleTask, .moveUp, .moveDown]

    /// Extra key combinations (⌘+ also zooms in).
    static let aliases: [(Shortcut, NotesCommand)] = [
        (Shortcut("cmd+shift+equal")!, .zoomIn),
        (Shortcut("cmd+kpplus")!, .zoomIn),
        (Shortcut("cmd+kpminus")!, .zoomOut),
        (Shortcut("cmd+kpenter")!, .toggleTask),
    ]

    static func matching(_ e: NSEvent) -> NotesCommand? {
        for c in allCases { if let s = c.shortcut, s.matches(e) { return c } }
        for (s, c) in aliases where s.matches(e) { return c }
        return nil
    }

    /// "⌘P" for tooltips.
    var tooltip: String {
        guard let s = shortcut else { return title }
        return "\(title)  \(s.displayString)"
    }
}
