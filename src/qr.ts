import jsQR from 'jsqr'
import { exactBytes, loadSdk } from './sdk/engine'

// QR login/link scanning (MSC4108). This build can only scan: the FFI
// exposes QrCodeData.fromBytes but no byte/URI accessor, so displaying a
// code for another device is blocked upstream and lives nowhere in the UI.
// Both supported roles scan a code shown by the other device:
//   - grant: this logged-in device scans a new device's code and authorizes it
//   - login: this fresh device scans an existing device's code and signs in

export interface QrLoginCode { serverName?: string }

// Validated login-code data from raw QR bytes. Pure decode: no server is
// contacted, so unknown/garbage codes fail here before any network use.
export async function decodeQrLoginBytes(bytes: Uint8Array): Promise<QrLoginCode> {
  const sdk = await loadSdk()
  let code
  try {
    code = sdk.QrCodeData.fromBytes(exactBytes(bytes))
  } catch (error) {
    throw new Error(qrDecodeMessage(error))
  }
  try {
    return { serverName: code.serverName() ?? undefined }
  } catch {
    return {}
  }
}

function qrDecodeMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/InvalidPrefix|InvalidVersion|InvalidMode|InvalidIntent|InvalidType/.test(detail)) return 'This QR code is not a Matrix sign-in code. Only scan codes shown by a Matrix app.'
  if (/NotEnoughData|missing some fields/i.test(detail)) return 'This QR code is incomplete or damaged. Ask the other device to show a fresh code.'
  if (/NotUtf8|UrlParse|Base64/i.test(detail)) return 'This QR code is malformed and cannot be used for sign-in.'
  return `This QR code cannot be used for sign-in (${detail.slice(0, 120)}).`
}

// QR payload bytes from image pixels (camera frame or uploaded file).
// Returns undefined when the image holds no readable QR code.
export function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number): Uint8Array | undefined {
  const found = jsQR(data, width, height)
  if (!found) return undefined
  const binary = (found as { binaryData?: ArrayLike<number> }).binaryData
  if (binary && binary.length) return Uint8Array.from(binary)
  return new TextEncoder().encode(found.data)
}

export function qrCameraError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Camera access was denied. Allow camera access or upload a screenshot of the code instead.'
    if (error.name === 'NotFoundError') return 'No camera was found on this device. Upload a screenshot of the code instead.'
    if (error.name === 'NotReadableError') return 'The camera is busy in another app. Close it or upload a screenshot instead.'
  }
  return 'The camera could not be started. Upload a screenshot of the code instead.'
}

export interface QrCamera { stop(): void }

// Live camera scan loop. Resolves each decoded payload through onBytes and
// stops the camera on the first hit; callers keep the loop for empty frames.
export async function scanQrCamera(video: HTMLVideoElement, onBytes: (bytes: Uint8Array) => void): Promise<QrCamera> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  } catch (error) {
    throw new Error(qrCameraError(error))
  }
  video.srcObject = stream
  await video.play().catch(() => {})
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  let stopped = false
  let frame = 0
  const stop = () => {
    stopped = true
    cancelAnimationFrame(frame)
    stream.getTracks().forEach(track => track.stop())
    video.srcObject = null
  }
  const tick = () => {
    if (stopped) return
    if (video.readyState >= 2 && video.videoWidth && context) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      context.drawImage(video, 0, 0)
      const bytes = decodeQrPixels(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
      if (bytes) { onBytes(bytes); return }
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return { stop }
}

// QR payload bytes from an uploaded image file. Throws actionably when the
// file is not an image or holds no readable QR code.
export async function decodeQrFile(file: File): Promise<Uint8Array> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That file is not a readable image. Upload a screenshot or photo of the QR code.')
  }
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser cannot read images. Try a camera scan instead.')
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const bytes = decodeQrPixels(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
  if (!bytes) throw new Error('No QR code was found in that image. Upload a clear screenshot of the code.')
  return bytes
}
