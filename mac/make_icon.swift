// Draws the app icon: the Merida white knight on a 2x2 piece of the lichess "brown" board.
// usage: swift make_icon.swift <out.iconset> <pieces.merida.css>
import Cocoa

let out = CommandLine.arguments[1]
let css = try! String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let re = try! NSRegularExpression(pattern: #"piece\.knight\.white \{\s*background-image: url\('data:image/svg\+xml;base64,([A-Za-z0-9+/=]+)'\)"#)
let m = re.firstMatch(in: css, range: NSRange(css.startIndex..., in: css))!
let b64 = String(css[Range(m.range(at: 1), in: css)!])
let knight = NSImage(data: Data(base64Encoded: b64)!)!

try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func png(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    let rect = NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8)
    let path = NSBezierPath(roundedRect: rect, xRadius: s * 0.18, yRadius: s * 0.18)
    NSColor(red: 0.941, green: 0.851, blue: 0.710, alpha: 1).setFill()
    path.fill()
    path.addClip()
    NSColor(red: 0.710, green: 0.533, blue: 0.388, alpha: 1).setFill()
    NSRect(x: rect.minX, y: rect.midY, width: rect.width / 2, height: rect.height / 2).fill()
    NSRect(x: rect.midX, y: rect.minY, width: rect.width / 2, height: rect.height / 2).fill()
    knight.draw(in: rect.insetBy(dx: rect.width * 0.1, dy: rect.height * 0.1))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! png(px).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
print("icons ->", out)
