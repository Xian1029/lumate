// Local OCR for scanned English textbooks on macOS. No cloud upload required.
import Foundation
import PDFKit
import Vision
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 3, let document = PDFDocument(url: URL(fileURLWithPath: arguments[1])) else {
    fputs("Expected PDF path and comma-separated one-based page numbers\n", stderr)
    exit(2)
}
let numbers = arguments[2].split(separator: ",").compactMap { Int($0) }
let queue = OperationQueue()
queue.maxConcurrentOperationCount = 3
let lock = NSLock()
var output: [[String: Any]] = []
for number in numbers {
    queue.addOperation {
        autoreleasepool {
            var result: [String: Any] = ["page": number, "text": "", "confidence": 0.0]
            do {
                // PDFKit documents are not shared across OCR worker threads.
                guard let local = PDFDocument(url: URL(fileURLWithPath: arguments[1])),
                      let page = local.page(at: number - 1) else {
                    throw NSError(domain: "PDF", code: 1)
                }
                let bounds = page.bounds(for: .mediaBox)
                let image = page.thumbnail(of: NSSize(width: 2000, height: 2000 * bounds.height / bounds.width), for: .mediaBox)
                guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    throw NSError(domain: "PDF", code: 2)
                }
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.recognitionLanguages = ["en-US", "zh-Hans"]
                request.usesLanguageCorrection = true
                try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
                let observations = request.results ?? []
                // Vision otherwise puts exercise labels in a separate column
                // before all exercise text. Restore top-to-bottom page order.
                let ordered = observations.sorted {
                    if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.008 {
                        return $0.boundingBox.midY > $1.boundingBox.midY
                    }
                    return $0.boundingBox.minX < $1.boundingBox.minX
                }
                let candidates = ordered.compactMap { $0.topCandidates(1).first }
                result["text"] = candidates.map { $0.string }.joined(separator: "\n")
                result["confidence"] = candidates.isEmpty ? 0 : candidates.reduce(0.0) { $0 + Double($1.confidence) } / Double(candidates.count)
            } catch {
                result["error"] = error.localizedDescription
            }
            lock.lock()
            output.append(result)
            lock.unlock()
        }
    }
}
queue.waitUntilAllOperationsAreFinished()
output.sort { ($0["page"] as! Int) < ($1["page"] as! Int) }
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
