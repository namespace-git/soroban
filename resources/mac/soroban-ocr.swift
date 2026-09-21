// soroban-ocr — Apple Vision（VNRecognizeTextRequest）を使った OCR ヘルパー。
// macOS のみ。リリースビルド時に arm64 / x64 でコンパイルし lipo で束ねて
// electron-builder の extraResources として Soroban.app に同梱する（package.json 参照）。
//
// 使い方: soroban-ocr <画像のパス>
// 標準出力に JSON を 1 行だけ出す:
//   {"lines":[{"text":"…","x":0.12,"y":0.87,"w":0.5,"h":0.02,"confidence":0.98}, …]}
// x,y,w,h は Vision の boundingBox（0〜1 に正規化、原点は左下）。
// 失敗したら標準エラーにメッセージを出して終了コード 1、画像が読めなければ 2。
//
// macOS 12 以上をターゲット（automaticallyDetectsLanguage 等 13 以降の API は #available で分岐）。

import Foundation
import Vision
import ImageIO
import CoreGraphics

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: soroban-ocr <image-path>", code: 1)
}

let imagePath = arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let imageSource = CGImageSourceCreateWithURL(imageURL as CFURL, nil) else {
    fail("failed to read image: \(imagePath)", code: 2)
}

// EXIF の向きを読んで Vision に渡す（iPhone の写真は向きが入っていることが多い）。
var cgOrientation: CGImagePropertyOrientation = .up
if let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
   let rawOrientation = properties[kCGImagePropertyOrientation] as? UInt32,
   let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) {
    cgOrientation = orientation
}

let requestHandler = VNImageRequestHandler(url: imageURL, orientation: cgOrientation, options: [:])

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ja-JP", "en-US"]
request.usesLanguageCorrection = true
if #available(macOS 13, *) {
    request.automaticallyDetectsLanguage = true
}

do {
    try requestHandler.perform([request])
} catch {
    fail("recognition failed: \(error.localizedDescription)", code: 1)
}

guard let observations = request.results as? [VNRecognizedTextObservation] else {
    fail("no text observations", code: 1)
}

var lines: [[String: Any]] = []
for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox
    lines.append([
        "text": candidate.string,
        "x": Double(box.minX),
        "y": Double(box.minY),
        "w": Double(box.width),
        "h": Double(box.height),
        "confidence": Double(candidate.confidence)
    ])
}

let output: [String: Any] = ["lines": lines]

do {
    let jsonData = try JSONSerialization.data(withJSONObject: output, options: [])
    guard let jsonString = String(data: jsonData, encoding: .utf8) else {
        fail("failed to encode JSON", code: 1)
    }
    print(jsonString)
} catch {
    fail("failed to serialize JSON: \(error.localizedDescription)", code: 1)
}
