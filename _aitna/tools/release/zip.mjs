// Minimal ZIP writer (store method, no compression) used by the release tool.
//
// The project's `release:pack` shelled out to the `zip` CLI, which does not exist on Windows. A store-only ZIP is
// ~40 bytes per entry larger than a deflated one for this artifact and removes the external dependency; Chrome and
// every unzip tool read it, which the release verify step checks by reading the archive back.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

export function crc32 (buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index++)
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xFF]
  return (crc ^ -1) >>> 0
}

function dosDateTime (date = new Date()) {
  // UTC on purpose: the archive must be identical on every machine, whatever its time zone
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2)
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  return { time, date: day }
}

function listFiles (root) {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory())
        walk(path)
      else if (entry.isFile())
        files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

// UTF-8 entry names: the general purpose flag bit 11 tells the reader not to decode them as CP437.
const UTF8_FLAG = 0x0800

// A fixed timestamp makes the archive reproducible: the same tree always yields the same bytes.
export function zipDirectory (root, outPath, { mtime = new Date('1980-01-01T00:00:00Z') } = {}) {
  const { time, date } = dosDateTime(mtime)
  const entries = []
  const localParts = []
  let offset = 0
  for (const path of listFiles(root)) {
    const name = relative(root, path).split(sep).join('/')
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = readFileSync(path)
    const checksum = crc32(data)

    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuffer.copy(local, 30)
    localParts.push(local, data)
    entries.push({ nameBuffer, checksum, size: data.length, offset })
    offset += local.length + data.length
  }

  const centralParts = []
  let centralSize = 0
  for (const entry of entries) {
    const central = Buffer.alloc(46 + entry.nameBuffer.length)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(0, 10) // store
    central.writeUInt16LE(time, 10 + 2) // keeps the same layout as the local header
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(entry.checksum, 16)
    central.writeUInt32LE(entry.size, 20)
    central.writeUInt32LE(entry.size, 24)
    central.writeUInt16LE(entry.nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(entry.offset, 42)
    entry.nameBuffer.copy(central, 46)
    centralParts.push(central)
    centralSize += central.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  const archive = Buffer.concat([...localParts, ...centralParts, end])
  writeFileSync(outPath, archive)
  return { bytes: archive.length, files: entries.length, entries: entries.map((entry) => entry.nameBuffer.toString('utf8')) }
}

// Reads the archive back from the end-of-central-directory: a corrupt file or a missing entry fails here.
export function readZipIndex (path) {
  const buffer = readFileSync(path)
  const minimum = 22
  let endOffset = -1
  for (let index = buffer.length - minimum; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === 0x06054B50) {
      endOffset = index
      break
    }
  }
  if (endOffset < 0)
    throw new Error('not a zip archive: end of central directory not found')
  const count = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  const central = buffer.subarray(centralOffset, centralOffset + centralSize)
  const names = []
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (central.readUInt32LE(cursor) !== 0x02014B50)
      throw new Error(`central directory entry #${index} has a bad signature`)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    names.push(central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return { count, names, bytes: buffer.length, centralOffset }
}

// Bytes of one entry of a store-only archive: the local header carries the sizes, so a scan is enough.
export function readZipEntry (path, name) {
  const buffer = readFileSync(path)
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const size = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const entryName = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const dataStart = offset + 30 + nameLength + extraLength
    if (entryName === name)
      return buffer.subarray(dataStart, dataStart + size)
    offset = dataStart + size
  }
  throw new Error(`entry "${name}" not found in the archive`)
}
