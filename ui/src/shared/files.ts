/**
 * The base64 payload of a file, without the `data:…;base64,` prefix FileReader adds — what the
 * upload routes take inside their JSON body. `unreadable` is the message the caller shows when
 * the browser cannot read it.
 */
export function readBase64(file: File, unreadable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(unreadable))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}
