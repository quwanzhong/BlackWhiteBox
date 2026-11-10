/**
 * 附件下载（M2-4）：后端用 Content-Disposition 给出文件名，
 * 前端只负责把 blob 落到本地，不再二次拼名字。
 */

/** 从 Content-Disposition 解析文件名：优先 RFC 5987 的 filename*（中文原名） */
export function filenameFromDisposition(disposition?: string): string {
  if (!disposition) return ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim())
    } catch {
      /* 编码异常时退回 filename= */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  return plain?.[1]?.trim() || ''
}

/** 用临时 <a download> 触发浏览器保存，随后回收 objectURL */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename || 'heibaihe-report'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
