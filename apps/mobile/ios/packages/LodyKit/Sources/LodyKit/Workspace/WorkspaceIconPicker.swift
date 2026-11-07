import PhotosUI
import UIKit
import UniformTypeIdentifiers

struct WorkspaceIconPickerError: LocalizedError {
  let code: String
  let message: String
  var errorDescription: String? { message }
}

final class WorkspaceIconPicker: NSObject, PHPickerViewControllerDelegate {
  private var completion: ((Result<WorkspaceIconFile?, Error>) -> Void)?

  @MainActor
  func pick(from controller: UIViewController) async throws -> WorkspaceIconFile? {
    try await withCheckedThrowingContinuation { continuation in
      present(from: controller) { continuation.resume(with: $0) }
    }
  }

  func present(from controller: UIViewController, completion: @escaping (Result<WorkspaceIconFile?, Error>) -> Void) {
    guard self.completion == nil else {
      completion(.failure(WorkspaceIconPickerError(code: "PICKER_BUSY", message: "The workspace icon picker is already open")))
      return
    }
    self.completion = completion
    var configuration = PHPickerConfiguration(photoLibrary: .shared())
    configuration.filter = .images
    configuration.selectionLimit = 1
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = self
    controller.present(picker, animated: true)
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    guard let provider = results.first?.itemProvider else {
      picker.dismiss(animated: true) { [weak self] in self?.finish(nil) }
      return
    }
    provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
      DispatchQueue.main.async { [weak self, weak picker] in
        guard let self, let picker else { return }
        guard let source = data, let image = UIImage(data: source),
              let data = self.jpeg(image),
              let url = ChatAttachment.store(data, name: "workspace-icon.jpg") else {
          picker.dismiss(animated: true) { self.fail("The selected image could not be read") }
          return
        }
        picker.dismiss(animated: true) {
          self.finish(WorkspaceIconFile(url: url, name: "workspace-icon.jpg", type: "image/jpeg", size: data.count))
        }
      }
    }
  }

  private func jpeg(_ image: UIImage) -> Data? {
    let scale = min(1, 1024 / max(image.size.width, image.size.height))
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    guard size.width > 0, size.height > 0 else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let prepared = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
    for quality in stride(from: 0.85, through: 0.2, by: -0.1) {
      if let data = prepared.jpegData(compressionQuality: quality), data.count <= 1_048_576 {
        return data
      }
    }
    return nil
  }

  private func finish(_ file: WorkspaceIconFile?) {
    let completion = completion
    self.completion = nil
    completion?(.success(file))
  }

  private func fail(_ message: String) {
    let completion = completion
    self.completion = nil
    completion?(.failure(WorkspaceIconPickerError(code: "PICKER_FAILED", message: message)))
  }
}
