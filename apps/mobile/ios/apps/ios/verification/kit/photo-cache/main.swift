import Foundation
let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: directory) }
let a = URL(string: "https://example.com/a")!
let b = URL(string: "https://example.com/b")!
let bytes = Data([1, 2, 3])
let cache = PhotoDiskCache(directory: directory, maxBytes: 6, maxEntries: 2)
cache.write(bytes, for: a)
assert(cache.isFresh(a))
let cachedFile = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first!
try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: cachedFile.path)
assert(!cache.isFresh(a), "Old cache entries need refresh but remain readable offline")
assert(PhotoDiskCache(directory: directory).read(a) == bytes, "Avatar bytes must survive cache reconstruction")
assert(cache.read(b) == nil, "URLs must remain isolated")
cache.write(Data(repeating: 0, count: 7), for: b)
assert(cache.read(b) == nil, "Oversized images must not be persisted")
cache.write(bytes, for: b)
cache.write(bytes, for: URL(string: "https://example.com/c")!)
let count = try FileManager.default.contentsOfDirectory(atPath: directory.path).count
assert(count == 2)
print("Avatar disk cache persistence, bounds and URL isolation passed")
