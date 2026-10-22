import Testing
@testable import Todo

@Suite struct Skeleton {
    @Test func builds() { #expect(TodoModule().id == "todo") }
}
