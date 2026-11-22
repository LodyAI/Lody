import Foundation

enum LodyPasskeyError: String, Error {
    case invalidRequest = "invalid_request"
    case unavailable = "unavailable"
    case cancelled = "cancelled"
    case failed = "failed"
}

/// Canonical bridge encoding, fixed vault RP and the authenticator's actual UV bit.
enum LodyPasskeyCodec {
    static let relyingParty = "lody.ai"

    static func encode(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String, maximum: Int = 1024) throws -> Data {
        guard !text.isEmpty, text.utf8.count <= (maximum * 4 + 2) / 3,
              text.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
            throw LodyPasskeyError.invalidRequest
        }
        let base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let padding = String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let bytes = Data(base64Encoded: base64 + padding), !bytes.isEmpty,
              bytes.count <= maximum, encode(bytes) == text else { throw LodyPasskeyError.invalidRequest }
        return bytes
    }

    static func credentialIds(_ values: [String]) throws -> [Data] {
        guard values.count <= 64 else { throw LodyPasskeyError.invalidRequest }
        return try values.map { try decode($0) }
    }

    static func userVerified(_ data: Data) -> Bool {
        data.count >= 37 && data[data.startIndex + 32] & 0x04 != 0
    }
}
