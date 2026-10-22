import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  eventTagMetadataMatches,
  readEventMetadataFile,
  writeEventMetadataFile,
  type EventTagSnapshot
} from '../src/main/services/event-metadata.service.ts'

const snapshot: EventTagSnapshot = {
  eventId: 'event-one',
  tags: [
    { id: 'nick', name: 'Rick', color: '#123456' },
    { id: 'unused', name: '备用', color: '#abcdef' }
  ],
  photoTags: { first: ['nick'], second: [], trashed: ['nick'] }
}

function manifest(): Record<string, any> {
  return {
    id: snapshot.eventId,
    format: 'photopeek-event',
    formatVersion: 1,
    kind: 'event',
    tags: snapshot.tags.map((tag) => ({ ...tag })),
    photos: Object.fromEntries(
      Object.entries(snapshot.photoTags).map(([id, tags]) => [id, { tags: [...tags] }])
    )
  }
}

test('healthy tag metadata includes unused definitions and trashed photo labels', () => {
  const value = manifest()
  value.customExtension = { untouched: true }
  value.tags.reverse()
  assert.equal(eventTagMetadataMatches(value, snapshot), true)
})

test('missing, stale and duplicate definitions or associations need repair', () => {
  for (const corrupt of [
    (value: any) => {
      value.tags.pop()
    },
    (value: any) => {
      value.tags[0].name = 'old nickname'
    },
    (value: any) => {
      value.tags[0].color = '#ffffff'
    },
    (value: any) => {
      value.tags[1] = { ...value.tags[0] }
    },
    (value: any) => {
      value.photos.first.tags = []
    },
    (value: any) => {
      value.photos.second.tags = ['wrong-event-tag']
    },
    (value: any) => {
      value.photos.first.tags = ['nick', 'nick']
    },
    (value: any) => {
      delete value.photos.trashed
    },
    (value: any) => {
      value.photos.orphan = { tags: [] }
    },
    (value: any) => {
      value.id = 'another-event'
    },
    (value: any) => {
      delete value.formatVersion
    }
  ]) {
    const value = manifest()
    corrupt(value)
    assert.equal(eventTagMetadataMatches(value, snapshot), false)
  }
  for (const value of [null, [], 'text', { id: snapshot.eventId }]) {
    assert.equal(eventTagMetadataMatches(value, snapshot), false)
  }
})

test('valid legacy metadata preserves extension fields and needs no backup', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'photopeek-meta-'))
  try {
    const file = path.join(temp, 'event.json')
    const original = { name: 'legacy', extension: { sharing: 'kept' } }
    fs.writeFileSync(file, JSON.stringify(original))
    assert.deepEqual(readEventMetadataFile(file, snapshot.eventId), original)
    assert.deepEqual(fs.readdirSync(temp), ['event.json'])
    assert.deepEqual(readEventMetadataFile(path.join(temp, 'missing.json'), snapshot.eventId), {})
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('damaged, wrong-event and non-object JSON is backed up byte for byte before rebuild', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'photopeek-meta-'))
  try {
    const file = path.join(temp, 'event.json')
    for (const raw of [
      '{"unfinished":',
      '{"id":"wrong-event","extension":"original"}',
      'null',
      '[]',
      '"text"'
    ]) {
      const previousBackups = fs.readdirSync(temp).filter((name) => name.includes('.corrupt-'))
      fs.writeFileSync(file, raw)
      assert.deepEqual(readEventMetadataFile(file, snapshot.eventId), {})
      const newBackups = fs
        .readdirSync(temp)
        .filter((name) => name.includes('.corrupt-') && !previousBackups.includes(name))
      assert.equal(newBackups.length, 1)
      assert.equal(fs.readFileSync(path.join(temp, newBackups[0]), 'utf8'), raw)
      assert.equal(fs.readFileSync(file, 'utf8'), raw)
      writeEventMetadataFile(file, manifest())
      assert.equal(
        eventTagMetadataMatches(JSON.parse(fs.readFileSync(file, 'utf8')), snapshot),
        true
      )
    }
    assert.equal(
      fs.readdirSync(temp).some((name) => name.endsWith('.tmp')),
      false
    )
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('failed serialization keeps the previous manifest intact', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'photopeek-meta-'))
  try {
    const file = path.join(temp, 'event.json')
    writeEventMetadataFile(file, manifest())
    const previous = fs.readFileSync(file, 'utf8')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.throws(() => writeEventMetadataFile(file, circular), /circular/i)
    assert.equal(fs.readFileSync(file, 'utf8'), previous)
    assert.deepEqual(fs.readdirSync(temp), ['event.json'])
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
