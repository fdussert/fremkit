import AVFoundation
import FremkitKit
import SwiftUI
import UIKit

/// The camera, looking for the QR code the Mac shows. The first code that is a valid pairing link
/// ends the scan (`PairingFlow.scanned`); anything else is ignored.
struct ScannerView: View {
    let flow: PairingFlow
    @State private var access = CameraAccess.current

    enum CameraAccess {
        case undetermined, allowed, denied, unavailable

        static var current: CameraAccess {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: .allowed
            case .notDetermined: .undetermined
            default: .denied
            }
        }
    }

    var body: some View {
        VStack(spacing: 24) {
            Text("Scan the code")
                .font(.title.bold())
            switch access {
            case .undetermined:
                ProgressView().controlSize(.large)
            case .allowed:
                CameraPreview(onCode: { flow.scanned($0) }, onUnavailable: { access = .unavailable })
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .frame(maxWidth: 640, maxHeight: 480)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                Text("Point the camera at the code the Mac shows.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            case .denied:
                Image(systemName: "camera.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.tint)
                Text("Allow the camera in Settings")
                    .font(.title3)
                    .multilineTextAlignment(.center)
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Text("Open Settings")
                        .frame(minWidth: 200, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                enterCodeInstead
            case .unavailable:
                Text("The camera is not available.")
                    .font(.title3)
                    .multilineTextAlignment(.center)
                enterCodeInstead
            }
            Button("Cancel", role: .cancel) { flow.cancel() }
                .frame(minHeight: 44)
        }
        .padding(40)
        .task {
            // Asked the first time the camera is needed, not at launch.
            guard access == .undetermined else { return }
            access = await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .denied
        }
    }

    private var enterCodeInstead: some View {
        Button { flow.enterCode() } label: {
            Text("Enter the code")
                .frame(minWidth: 200, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }
}

/// The capture session behind the preview, reporting every QR code it reads.
private struct CameraPreview: UIViewControllerRepresentable {
    let onCode: @MainActor (String) -> Void
    let onUnavailable: @MainActor () -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        ScannerController(onCode: onCode, onUnavailable: onUnavailable)
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onCode = onCode
    }
}

/// `AVCaptureSession` is started and stopped off the main thread (both block); the session itself is
/// only configured on the main thread, before it first starts.
private final class Capture: @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "fremkit.scanner")

    func start() {
        queue.async { if !self.session.isRunning { self.session.startRunning() } }
    }

    func stop() {
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }
}

private final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: @MainActor (String) -> Void
    private let onUnavailable: @MainActor () -> Void
    private let capture = Capture()
    private var preview: AVCaptureVideoPreviewLayer?
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private var configured = false

    init(onCode: @escaping @MainActor (String) -> Void, onUnavailable: @escaping @MainActor () -> Void) {
        self.onCode = onCode
        self.onUnavailable = onUnavailable
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configured = configure()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if configured {
            capture.start()
        } else {
            onUnavailable()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        capture.stop()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    /// Keeps the picture upright as the iPad and the interface rotate.
    private func apply(angle: CGFloat) {
        guard let connection = preview?.connection, connection.isVideoRotationAngleSupported(angle) else { return }
        connection.videoRotationAngle = angle
    }

    /// The back camera (the front one when there is none) feeding a QR-only metadata output.
    private func configure() -> Bool {
        let session = capture.session
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
            ?? AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return false }
        session.beginConfiguration()
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            return false
        }
        session.addOutput(output)
        session.commitConfiguration()
        guard output.availableMetadataObjectTypes.contains(.qr) else { return false }
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview
        let rotation = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: preview)
        self.rotation = rotation
        rotationObservation = rotation.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) {
            [weak self] coordinator, _ in
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            Task { @MainActor in self?.apply(angle: angle) }
        }
        return true
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        let codes = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        // The delegate queue is the main queue.
        MainActor.assumeIsolated {
            for code in codes { onCode(code) }
        }
    }
}
