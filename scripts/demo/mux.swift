// Usage: crx-mux <manifest.txt, one frame image path per output frame> <fps> <audio.wav | none> <out.mp4>
// Pass "none" for a silent video (no audio track).
// Encodes PNG frames to H.264 and a WAV to AAC into one MP4 with AVFoundation, because the ffmpeg bundled with
// Playwright has no H.264 or audio encoders. macOS only.
import AVFoundation
import CoreImage
import Foundation
import ImageIO

let a = CommandLine.arguments
guard a.count == 5 else { FileHandle.standardError.write(Data("usage: crx-mux frames fps audio.wav out.mp4\n".utf8)); exit(2) }
let manifest = a[1], fps = Int32(a[2])!, silent = a[3] == "none", audioURL = URL(fileURLWithPath: a[3]), outURL = URL(fileURLWithPath: a[4])
let files = try String(contentsOfFile: manifest, encoding: .utf8).split(separator: "\n").map(String.init)
guard let first = files.first, let src0 = CGImageSourceCreateWithURL(URL(fileURLWithPath: first) as CFURL, nil), let img0 = CGImageSourceCreateImageAtIndex(src0, 0, nil) else { print("no frames"); exit(1) }
let W = img0.width, H = img0.height
try? FileManager.default.removeItem(at: outURL)
let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 3_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel, AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2]])
vIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: 1, AVSampleRateKey: 44100, AVEncoderBitRateKey: 96000])
aIn.expectsMediaDataInRealTime = false
writer.add(vIn); if !silent { writer.add(aIn) }
var reader: AVAssetReader? = nil
var aOut: AVAssetReaderTrackOutput? = nil
if !silent {
  let r = try AVAssetReader(asset: AVURLAsset(url: audioURL))
  let o = AVAssetReaderTrackOutput(track: r.asset.tracks(withMediaType: .audio)[0], outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1])
  r.add(o); reader = r; aOut = o
}
guard writer.startWriting(), (reader?.startReading() ?? true) else { print("start failed: \(String(describing: writer.error)) \(String(describing: reader?.error))"); exit(1) }
writer.startSession(atSourceTime: .zero)

let vq = DispatchQueue(label: "v"), aq = DispatchQueue(label: "a"), group = DispatchGroup()
var idx = 0
group.enter()
vIn.requestMediaDataWhenReady(on: vq) {
  while vIn.isReadyForMoreMediaData {
    if idx >= files.count { vIn.markAsFinished(); group.leave(); return }
    autoreleasepool {
      var pb: CVPixelBuffer?
      CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
      if let pb = pb, let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: files[idx]) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(s, 0, nil) {
        CVPixelBufferLockBaseAddress(pb, [])
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: W, height: H, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        ctx?.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
        CVPixelBufferUnlockBaseAddress(pb, [])
        adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(idx), timescale: fps))
      }
      idx += 1
    }
  }
}
if let aOut = aOut {
  group.enter()
  aIn.requestMediaDataWhenReady(on: aq) {
    while aIn.isReadyForMoreMediaData {
      if let sb = aOut.copyNextSampleBuffer() { aIn.append(sb) } else { aIn.markAsFinished(); group.leave(); return }
    }
  }
}
group.wait()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { print("failed: \(String(describing: writer.error))"); exit(1) }
let asset = AVURLAsset(url: outURL)
print(String(format: "wrote %@ video %.2fs audio tracks %d, %dx%d", outURL.path, asset.duration.seconds, asset.tracks(withMediaType: .audio).count, W, H))
