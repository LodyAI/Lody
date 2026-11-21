import Foundation

@main
struct PasskeyTests {
    @MainActor static func main() throws {
        // Passkey IDs must survive the Capacitor boundary without alternate spellings.
        let credential = Data([0, 255, 254, 253])
        let decoded = try LodyPasskeyCodec.decode(LodyPasskeyCodec.encode(credential))
        precondition(decoded == credential)
        for bad in ["", "AA==", "AB", "a+", "a/", "AA\n"] {
            do { _ = try LodyPasskeyCodec.decode(bad); fatalError("accepted noncanonical credential") }
            catch LodyPasskeyError.invalidRequest {}
        }
        // Missing/truncated authenticator evidence never proves user verification.
        precondition(!LodyPasskeyCodec.userVerified(Data(repeating: 0xff, count: 33)))
        var authenticatorData = Data(count: 37)
        precondition(!LodyPasskeyCodec.userVerified(authenticatorData))
        authenticatorData[32] = 0x04
        precondition(LodyPasskeyCodec.userVerified(authenticatorData))
        // An outstanding system prompt retains ownership until actual native completion.
        let queue = LodyPasskeyCallQueue()
        var order: [Int] = []
        queue.enqueue { order.append(1) }
        queue.enqueue { order.append(2) }
        precondition(order == [1])
        queue.finished()
        precondition(order == [1, 2])
        queue.finished()
        queue.enqueue { order.append(3) }
        precondition(order == [1, 2, 3])
        queue.finished()
        print("Passkey bridge canonical IDs, UV evidence and native completion ownership passed")
    }
}
