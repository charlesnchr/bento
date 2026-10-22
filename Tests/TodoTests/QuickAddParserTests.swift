import Foundation
import Testing
@testable import Todo

private let projects = ["Inbox", "Work", "Side Project", "Side", "Plan Tomorrow", "Errands"]
private let labels = ["errands", "Waiting For", "home"]

private func qa(_ s: String, projects: [String] = projects, labels: [String] = labels) -> QuickAddResult {
    QuickAddParser.parse(s, projects: projects, labels: labels, now: Fixed.now, calendar: Fixed.calendar)
}

/// The highlighted substrings by kind, in text order.
private func tokens(_ s: String, _ r: QuickAddResult) -> [String] {
    r.tokens.map { "\($0.kind):" + (s as NSString).substring(with: $0.range) }
}

@Suite struct QuickAdd {
    @Test func everything() {
        let s = "Buy milk tomorrow #Errands @shop p1"
        let r = qa(s)
        #expect(r.title == "Buy milk")
        #expect(r.project == "Errands")
        #expect(r.labels == ["shop"])
        #expect(r.priority == 1)
        #expect(r.due == DueDate(date: "2026-10-22"))
        #expect(!r.clearDue)
        #expect(tokens(s, r) == ["date:tomorrow", "project:#Errands", "label:@shop", "priority:p1"])
    }

    @Test func plainText() {
        let r = qa("  just   a   task ")
        #expect(r == QuickAddResult(title: "just a task", project: nil, labels: [], priority: nil, due: nil,
                                    clearDue: false, tokens: []))
    }

    @Test func multiWordProjectsPreferLongest() {
        var r = qa("#Side Project fix bug")
        #expect(r.project == "Side Project")
        #expect(r.title == "fix bug")
        r = qa("#Side Project fix bug", projects: ["Side"])
        #expect(r.project == "Side")
        #expect(r.title == "Project fix bug")
        r = qa("fix bug #side project")
        #expect(r.project == "Side Project")  // canonical spelling
        #expect(r.title == "fix bug")
        r = qa("fix #Side Projector")
        #expect(r.project == "Side")
        #expect(r.title == "fix Projector")
        r = qa("fix #Side Project, then ship")
        #expect(r.project == "Side Project")
        #expect(r.title == "fix, then ship")
    }

    @Test func unknownAndPartialProjects() {
        #expect(qa("x #foo").project == "foo")
        #expect(qa("x #Workshop").project == "Workshop")  // "Work" must end at a word boundary
        #expect(qa("x #work").project == "Work")
        #expect(qa("x #work.").project == "Work")
        #expect(qa("x #").project == nil)
        #expect(qa("x #").title == "x #")
        #expect(qa("C# tips").project == nil)
        #expect(qa("C# tips").title == "C# tips")
        #expect(qa("see page#2").project == nil)
    }

    @Test func lastProjectWins() {
        let s = "#Work email #Errands"
        let r = qa(s)
        #expect(r.project == "Errands")
        #expect(r.title == "#Work email")
        #expect(tokens(s, r) == ["project:#Errands"])
    }

    @Test func labels() {
        var r = qa("call @phone @Home @home @phone x")
        #expect(r.labels == ["phone", "home"])  // known spelling, deduplicated
        #expect(r.title == "call x")
        #expect(r.tokens.count == 4)
        r = qa("ping @waiting for reply")
        #expect(r.labels == ["Waiting For"])
        #expect(r.title == "ping reply")
        r = qa("x @foo-bar_2 @café @a.b @")
        #expect(r.labels == ["foo-bar_2"])
        #expect(r.title == "x @café @a.b @")
        r = qa("ok @done.")
        #expect(r.labels == ["done"])
        #expect(r.title == "ok.")
    }

    @Test func emailsAndURLsAreNotTokens() {
        let s = "mail bob@example.com about https://x.com/@me/#top and www.y.com/tomorrow"
        let r = qa(s)
        #expect(r.labels.isEmpty)
        #expect(r.project == nil)
        #expect(r.due == nil)
        #expect(r.title == s)
    }

    @Test func priority() {
        #expect(qa("x p1").priority == 1)
        #expect(qa("x P2").priority == 2)
        #expect(qa("p3 x").priority == 3)
        #expect(qa("x p4.").priority == 4)
        #expect(qa("x p4.").title == "x.")
        for s in ["x p5", "x p0", "x p1x", "x top1", "x p11", "x #p1", "x @p1"] {
            #expect(qa(s).priority == nil, "\(s)")
        }
        let r = qa("p1 then p3")
        #expect(r.priority == 3)
        #expect(r.title == "p1 then")
    }

    @Test func dates() {
        var r = qa("Call mom tomorrow at 5pm #Work")
        #expect(r.due == DueDate(date: "2026-10-22", time: "17:00"))
        #expect(r.title == "Call mom")
        r = qa("Pay rent oct 25 p2")
        #expect(r.due == DueDate(date: "2026-10-25"))
        #expect(r.title == "Pay rent")
        r = qa("fri: move tomorrow at 5pm")  // longest wins, the other stays text
        #expect(r.due == DueDate(date: "2026-10-22", time: "17:00"))
        #expect(r.title == "fri: move")
        r = qa("buy 17 eggs")
        #expect(r.due == nil)
        #expect(r.title == "buy 17 eggs")
    }

    @Test func datesInsideProjectsAndLabelsAreIgnored() {
        var r = qa("#Plan Tomorrow write")
        #expect(r.project == "Plan Tomorrow")
        #expect(r.due == nil)
        #expect(r.title == "write")
        r = qa("x #today @tomorrow")
        #expect(r.project == "today")
        #expect(r.labels == ["tomorrow"])
        #expect(r.due == nil)
        r = qa("#Plan Tomorrow write friday")
        #expect(r.due == DueDate(date: "2026-10-23"))
        #expect(r.title == "write")
    }

    @Test func clearDue() {
        let s = "fix #Work no date"
        let r = qa(s)
        #expect(r.clearDue)
        #expect(r.due == nil)
        #expect(r.title == "fix")
        #expect(tokens(s, r) == ["project:#Work", "date:no date"])
        #expect(qa("x no due date").clearDue)
    }

    @Test func punctuationTidy() {
        #expect(qa("Call Bob tomorrow, then email").title == "Call Bob, then email")
        #expect(qa("Buy milk, tomorrow").title == "Buy milk")
        #expect(qa("Buy milk (tomorrow)").title == "Buy milk ()")
        #expect(qa("tomorrow").title == "")
    }

    @Test func utf16RangesWithEmoji() {
        let s = "👨‍👩‍👧 party 🎉 #Side Project @home tomorrow 5pm p2 🎂"
        let r = qa(s)
        #expect(tokens(s, r) == ["project:#Side Project", "label:@home", "date:tomorrow 5pm", "priority:p2"])
        #expect(r.tokens[0].range == NSRange(location: 18, length: 13))
        #expect(r.title == "👨‍👩‍👧 party 🎉 🎂")
        #expect(r.due == DueDate(date: "2026-10-22", time: "17:00"))
    }
}

@Suite struct Completion {
    func ctx(_ s: String, _ caret: Int? = nil) -> (QuickAddResult.Token.Kind, String, NSRange)? {
        QuickAddParser.completionContext(s, caret: caret ?? (s as NSString).length).map { ($0.kind, $0.query, $0.range) }
    }

    @Test func projectAndLabel() {
        var c = ctx("#Wo")
        #expect(c?.0 == .project && c?.1 == "Wo" && c?.2 == NSRange(location: 0, length: 3))
        c = ctx("fix @ho")
        #expect(c?.0 == .label && c?.1 == "ho" && c?.2 == NSRange(location: 4, length: 3))
        c = ctx("fix #")
        #expect(c?.0 == .project && c?.1 == "" && c?.2 == NSRange(location: 4, length: 1))
    }

    @Test func caretInsideWordCoversWholeWord() {
        let c = ctx("a #Work b", 5)
        #expect(c?.1 == "Wo")
        #expect(c?.2 == NSRange(location: 2, length: 5))
    }

    @Test func noContext() {
        #expect(ctx("") == nil)
        #expect(ctx("plain") == nil)
        #expect(ctx("mail a@b") == nil)
        #expect(ctx("C#") == nil)
        #expect(ctx("#work fix") == nil)
        #expect(ctx("#work ") == nil)
        #expect(ctx("#Wo", 0) == nil)
        #expect(ctx("#Wo", 99)?.1 == "Wo")  // clamped
    }

    @Test func emojiOffsets() {
        let s = "🎉 buy @gro"
        let c = ctx(s)
        #expect(c?.1 == "gro")
        #expect(c?.2 == NSRange(location: 7, length: 4))
        #expect((s as NSString).substring(with: c!.2) == "@gro")
    }
}
