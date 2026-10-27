import Foundation

/// Converts note markdown to plain text and HTML (copy as / export).
/// Line based, matching the editor: every line is one block.
enum MarkdownExport {
    // MARK: Plain text

    static func plainText(_ md: String) -> String {
        var out: [String] = []
        var inCode = false
        let text = md as NSString
        var loc = 0
        var detailsEnd: Int?
        md.enumerateLines { line, _ in
            let full = text.lineRange(for: NSRange(location: loc, length: 0))
            defer { loc = NSMaxRange(full) }
            let p = MarkdownParser.parseLine(line, inCode: inCode)
            let ns = line as NSString
            let content = MarkdownParser.stripInline(ns.substring(with: p.contentRange))
            let indent = String(repeating: "    ", count: p.level)
            switch p.kind {
            case .fence(let opening, _): inCode = opening
            case .code: out.append(line)
            case .rule: out.append("———")
            case .detailsEnd:
                if detailsEnd == loc { detailsEnd = nil } else { out.append(line) }
            case .bullet: out.append(indent + "• " + content)
            case .ordered(let n): out.append(indent + "\(n). " + content)
            case .task(let checked): out.append(indent + (checked ? "☑ " : "☐ ") + content)
            case .quote: out.append(content)
            case .details:
                detailsEnd = MarkdownParser.expanderEnd(after: full, in: text)?.location
                out.append(content)
            case .heading, .paragraph: out.append(content)
            }
        }
        return out.joined(separator: "\n")
    }

    // MARK: HTML

    static func escape(_ s: String) -> String {
        var r = ""
        r.reserveCapacity(s.utf16.count)
        for c in s {
            switch c {
            case "&": r += "&amp;"
            case "<": r += "&lt;"
            case ">": r += "&gt;"
            case "\"": r += "&quot;"
            default: r.append(c)
            }
        }
        return r
    }

    /// Inline markdown of one line's content to HTML.
    static func inlineHTML(_ s: String) -> String {
        let ns = s as NSString
        let spans = MarkdownParser.inlineSpans(ns)
        guard !spans.isEmpty else { return escape(s) }
        // Build open/close tags at UTF-16 positions; markers are dropped.
        var opens: [Int: [String]] = [:], closes: [Int: [String]] = [:]
        var drop = IndexSet()
        for sp in spans {
            for m in sp.markers { drop.insert(integersIn: m.location..<NSMaxRange(m)) }
            let (o, c): (String, String)
            switch sp.kind {
            case .bold: (o, c) = ("<strong>", "</strong>")
            case .italic: (o, c) = ("<em>", "</em>")
            case .boldItalic: (o, c) = ("<strong><em>", "</em></strong>")
            case .strike: (o, c) = ("<del>", "</del>")
            case .underline: (o, c) = ("<u>", "</u>")
            case .code: (o, c) = ("<code>", "</code>")
            case .link(let url), .autolink(let url):
                let href = url.contains("://") || url.hasPrefix("mailto:") ? url : "https://" + url
                (o, c) = ("<a href=\"\(escape(href))\">", "</a>")
            }
            opens[sp.contentRange.location, default: []].append(o)
            closes[NSMaxRange(sp.contentRange), default: []].insert(c, at: 0)
        }
        var out = ""
        var buf: [UInt16] = []
        func flush() {
            if !buf.isEmpty { out += escape(String(utf16CodeUnits: buf, count: buf.count)); buf.removeAll() }
        }
        for i in 0...ns.length {
            if let c = closes[i] { flush(); out += c.joined() }
            if let o = opens[i] { flush(); out += o.joined() }
            if i < ns.length, !drop.contains(i) { buf.append(ns.character(at: i)) }
        }
        flush()
        return out
    }

    /// HTML for a markdown document. `standalone` wraps it in a full page.
    static func html(_ md: String, standalone: Bool = true, title: String = "") -> String {
        var out = ""
        var listStack: [(tag: String, level: Int)] = []
        var inCode = false
        var codeLines: [String] = []
        var codeLang = ""
        var quoteOpen = false
        let text = md as NSString
        var loc = 0
        var detailsEnd: Int?

        func closeAllLists() {
            while let top = listStack.popLast() { out += "</li></\(top.tag)>\n" }
        }
        func closeQuote() { if quoteOpen { out += "</blockquote>\n"; quoteOpen = false } }

        md.enumerateLines { line, _ in
            let full = text.lineRange(for: NSRange(location: loc, length: 0))
            defer { loc = NSMaxRange(full) }
            let p = MarkdownParser.parseLine(line, inCode: inCode)
            let content = (line as NSString).substring(with: p.contentRange)
            switch p.kind {
            case .fence(let opening, let lang):
                if opening {
                    closeAllLists(); closeQuote()
                    inCode = true; codeLines = []; codeLang = lang
                } else {
                    inCode = false
                    let cls = codeLang.isEmpty ? "" : " class=\"language-\(escape(codeLang))\""
                    out += "<pre><code\(cls)>" + escape(codeLines.joined(separator: "\n")) + "</code></pre>\n"
                }
                return
            case .code:
                codeLines.append(line)
                return
            default: break
            }
            switch p.kind {
            case .details:
                closeAllLists(); closeQuote()
                guard let end = MarkdownParser.expanderEnd(after: full, in: text) else {
                    out += "<p>" + inlineHTML(content) + "</p>\n"
                    return
                }
                out += "<details><summary>" + inlineHTML(content) + "</summary>\n"
                detailsEnd = end.location
                return
            case .detailsEnd where detailsEnd == loc:
                closeAllLists(); closeQuote()
                out += "</details>\n"
                detailsEnd = nil
                return
            default: break
            }
            if case .quote = p.kind {} else { closeQuote() }
            switch p.kind {
            case .bullet, .ordered, .task:
                let tag: String = { if case .ordered = p.kind { return "ol" }; return "ul" }()
                while let top = listStack.last, top.level > p.level {
                    out += "</li></\(top.tag)>\n"
                    listStack.removeLast()
                }
                if let top = listStack.last, top.level == p.level {
                    if top.tag == tag {
                        out += "</li>\n"
                    } else {
                        out += "</li></\(top.tag)>\n"
                        listStack.removeLast()
                        out += openList(tag, p)
                        listStack.append((tag, p.level))
                    }
                } else {
                    out += openList(tag, p)
                    listStack.append((tag, p.level))
                }
                if case .task(let checked) = p.kind {
                    out += "<li><input type=\"checkbox\" disabled\(checked ? " checked" : "")> " + inlineHTML(content)
                } else {
                    out += "<li>" + inlineHTML(content)
                }
                return
            default:
                closeAllLists()
            }
            switch p.kind {
            case .heading(let l): out += "<h\(l)>" + inlineHTML(content) + "</h\(l)>\n"
            case .quote:
                if !quoteOpen { out += "<blockquote>\n"; quoteOpen = true }
                out += "<p>" + inlineHTML(content) + "</p>\n"
            case .rule: out += "<hr>\n"
            case .detailsEnd: out += "<p>:::</p>\n"
            case .paragraph:
                if content.trimmingCharacters(in: .whitespaces).isEmpty { out += "<p><br></p>\n" } else { out += "<p>" + inlineHTML(content) + "</p>\n" }
            default: break
            }
        }
        if inCode { out += "<pre><code>" + escape(codeLines.joined(separator: "\n")) + "</code></pre>\n" }
        closeAllLists()
        closeQuote()
        if detailsEnd != nil { out += "</details>\n" }
        guard standalone else { return "<meta charset=\"utf-8\">" + out }
        return """
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><title>\(escape(title))</title>
        <style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:720px;margin:2em auto;padding:0 1em}code{font-family:ui-monospace,monospace;background:#8881;padding:0 .3em;border-radius:4px}pre{background:#8881;padding:.6em 1em;border-radius:6px}blockquote{border-left:2px solid #ff6363;margin:0;padding-left:1em}</style>
        </head><body>
        \(out)</body></html>
        """
    }

    private static func openList(_ tag: String, _ p: ParsedLine) -> String {
        if tag == "ol", case .ordered(let n) = p.kind, n != 1 { return "<ol start=\"\(n)\">" }
        return "<\(tag)>"
    }
}
