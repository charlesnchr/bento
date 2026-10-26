import AppKit
import SwiftUI
import SwiftMath

enum AssistantMath {
    // Protect code and Markdown links before recognizing math delimiters.
    private static let tokens = try! NSRegularExpression(pattern: #"(?s)(`{3,}|~{3,})[^\n]*\n.*?\1|(`+)[^`]*?\2|!?\[[^\]\n]*\]\([^\n]*?\)|\$\$(.+?)\$\$|\\\[(.+?)\\\]|\\\(([^\n]+?)\\\)|(?<![\\\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)"#)

    static func markdown(_ source: String) -> String {
        let original = source as NSString
        let result = NSMutableString(string: source)
        for match in tokens.matches(in: source, range: NSRange(location: 0, length: original.length)).reversed() {
            for group in 3...6 where match.range(at: group).location != NSNotFound {
                let latex = original.substring(with: match.range(at: group))
                // Avoid interpreting ordinary currency ranges as equations.
                if group == 6, latex.first?.isNumber == true, !latex.contains(where: { "=^_\\".contains($0) }) { continue }
                guard latex.count <= 4000 else { continue }
                let encoded = Data(latex.utf8).base64EncodedString()
                let mode = group <= 4 ? "display" : "inline"
                let image = "![Equation](bento-math://" + mode + "/" + encoded + ")"
                result.replaceCharacters(in: match.range, with: mode == "display" ? "\n\n" + image + "\n\n" : image)
                break
            }
        }
        return result as String
    }

    static func equation(_ url: URL) -> (String, Bool)? {
        guard url.scheme == "bento-math", ["display", "inline"].contains(url.host ?? ""),
              let data = Data(base64Encoded: String(url.path.dropFirst())),
              let latex = String(data: data, encoding: .utf8), latex.count <= 4000 else { return nil }
        return (latex, url.host == "display")
    }

    @MainActor static func image(_ latex: String, display: Bool, dark: Bool) -> NSImage? {
        var formula = MathImage(latex: latex, fontSize: display ? 20 : 15,
            textColor: dark ? .white : .black, labelMode: display ? .display : .text)
        let (error, image, _) = formula.asImage()
        return error == nil ? image : nil
    }
}

struct AssistantEquation: View {
    let latex: String
    let display: Bool
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        Group {
            if let image = AssistantMath.image(latex, display: display, dark: colorScheme == .dark) {
                ScrollView(.horizontal) {
                    Image(nsImage: image).accessibilityLabel("Equation: " + latex)
                        .padding(.vertical, display ? 8 : 0)
                }
            } else { Text(latex).font(.system(size: 13, design: .monospaced)).textSelection(.enabled) }
        }.contextMenu {
            Button("Copy LaTeX") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(latex, forType: .string)
            }
        }
    }
}
