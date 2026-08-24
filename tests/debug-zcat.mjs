/**
 * 临时诊断 v2：分帧 zstd 解压真实会话 jsonl（每帧一条或多条记录），
 * 重放全部事件驱动 tokenBilling 投影，定位第一个破坏 plain-JSON 契约的事件。
 * zstd 帧边界用 magic number (0xFD2FB528) 扫描。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const sid = process.argv[2] ?? '6fe90fa3-1eee-4fd6-be2d-8c1968314280'
const file = `C:/Users/spy31/.dsh/sessions/--D-workshop--/session-${sid}/session.jsonl.zstd`
const buf = readFileSync(file)

/** 扫描所有 zstd 帧起点（magic: 28 B5 2F FD 小端读为 0xFD2FB528）。 */
function frameOffsets(b) {
  const offsets = []
  for (let i = 0; i <= b.length - 4; i++) {
    if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) offsets.push(i)
  }
  return offsets
}
const offsets = frameOffsets(buf)
console.log(`文件 ${buf.length} 字节 · 发现 ${offsets.length} 个 zstd 帧`)

let text = ''
for (let f = 0; f < offsets.length; f++) {
  const end = f + 1 < offsets.length ? offsets[f + 1] : buf.length
  const chunk = buf.subarray(offsets[f], end)
  try {
    text += zstdDecompressSync(chunk).toString('utf8')
  } catch (e) {
    console.log(`帧 ${f} 解压失败（${end - offsets[f]} 字节）: ${e.message}`)
  }
}
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`解压后共 ${lines.length} 行`)
console.log('前 3 行类型:', lines.slice(0, 3).map((l) => { try { return JSON.parse(l).type } catch { return '(解析失败)' } }).join(', '))

// ---- 导出全部行供重放脚本使用 ----
import { writeFileSync } from 'node:fs'
writeFileSync('D:/workshop/.dsh-tmp/session-' + sid + '.jsonl', text)
console.log('已导出到 D:/workshop/.dsh-tmp/session-' + sid + '.jsonl')
