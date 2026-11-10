/**
 * M2-1 · S7：环境密钥加密（AES-256-GCM）。
 *
 * 主密钥来源（优先级从高到低）：
 *   1. 环境变量 `HEIBAIHE_MASTER_KEY`：64 位十六进制，或 base64（解码后必须恰为 32 字节）；
 *   2. 主密钥文件 `MASTER_KEY_FILE`（默认 `DATA_DIR/.master.key`）：首次使用自动生成，
 *      POSIX 权限尽量 0600（Windows 权限模型不同，chmod 失败不阻断启动）。
 *
 * 密文 BLOB 布局：`version(1B) || IV(12B) || authTag(16B) || ciphertext`。
 * - 每次加密使用随机 IV；
 * - AAD 由调用方传入 `envId|key`，把密文绑定到具体环境与键名：
 *   把 A 环境的密文复制到 B 环境记录下，解密会直接失败（防调包）；
 * - 解密只在内存进行：明文不落库、不进事件、不进报告/导出包（调用方负责掩码）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MASTER_KEY_FILE } from '../config.js'

const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export class KeystoreError extends Error {
  constructor(message, code = 'SECRET_DECRYPT_FAILED') {
    super(message)
    this.name = 'KeystoreError'
    this.code = code
  }
}

/**
 * 解析主密钥文本。空值返回 null（表示「没有配置，需要生成/读文件」）。
 * @param {string|Buffer|null|undefined} raw
 * @returns {Buffer|null}
 */
export function parseMasterKey(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === KEY_BYTES) return decoded
  throw new KeystoreError(
    '主密钥必须是 64 位十六进制，或 base64 解码后恰为 32 字节',
    'MASTER_KEY_INVALID'
  )
}

/**
 * 读取主密钥：环境变量 → 文件 → 自动生成并写文件。
 * @param {{ raw?: string, file?: string }} [opts] 仅测试显式传参，生产走默认值
 * @returns {Buffer} 32 字节主密钥
 */
export function loadMasterKey({ raw = process.env.HEIBAIHE_MASTER_KEY, file = MASTER_KEY_FILE } = {}) {
  const fromEnv = parseMasterKey(raw)
  if (fromEnv) return fromEnv

  if (fs.existsSync(file)) {
    const fromFile = parseMasterKey(fs.readFileSync(file, 'utf8'))
    if (fromFile) return fromFile
  }

  const key = crypto.randomBytes(KEY_BYTES)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Windows 不支持 POSIX 权限位，忽略即可（文件仍位于本机数据目录）
  }
  return key
}

/**
 * 用给定主密钥创建加解密器。
 * @param {Buffer} key 32 字节
 */
export function createKeystore(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new KeystoreError('主密钥长度必须为 32 字节', 'MASTER_KEY_INVALID')
  }

  return {
    /**
     * @param {string} plaintext
     * @param {string} [aad] 绑定上下文，约定为 `envId|key`
     * @returns {Buffer}
     */
    encrypt(plaintext, aad = '') {
      const iv = crypto.randomBytes(IV_BYTES)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(String(aad), 'utf8'))
      const data = Buffer.from(String(plaintext), 'utf8')
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext])
    },

    /**
     * @param {Buffer} blob version||IV||tag||ciphertext
     * @param {string} [aad]
     * @returns {string} 明文
     */
    decrypt(blob, aad = '') {
      const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
      if (buf.length < 1 + IV_BYTES + TAG_BYTES || buf[0] !== VERSION) {
        throw new KeystoreError('密文格式不合法或版本不受支持')
      }
      const iv = buf.subarray(1, 1 + IV_BYTES)
      const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
      const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES)
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(Buffer.from(String(aad), 'utf8'))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      } catch {
        throw new KeystoreError('密钥不匹配或密文已损坏（AAD/AuthTag 校验失败）')
      }
    },
  }
}

let cached = null

/** 进程内单例：避免每次读写密钥都解析主密钥文件 */
export function getKeystore() {
  if (!cached) cached = createKeystore(loadMasterKey())
  return cached
}

/** 测试 / 密钥轮换后重置（下次访问重新读取主密钥） */
export function resetKeystore() {
  cached = null
}
