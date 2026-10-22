import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import initSqlJs, { type Database } from 'sql.js'
import {
  getOrCreateTag,
  listEventTags,
  listPhotoTags,
  repairTagIntegrity,
  setPhotoTag,
  toggleNicknameTag
} from '../src/main/services/tag.service.ts'
import { exportDatabase } from '../src/main/db/export.ts'
import { withPersistedTags } from '../src/main/services/tag-persistence.service.ts'

const SQL = await initSqlJs()

function database(t: TestContext): Database {
  const db = new SQL.Database()
  t.after(() => db.close())
  db.run(`
    CREATE TABLE events (id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), deleted_at TEXT
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      name TEXT NOT NULL, color TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE photo_tags (
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (photo_id, tag_id)
    );
    INSERT INTO events VALUES ('event-a', NULL), ('event-b', NULL), ('event-deleted', '2026-01-01');
    INSERT INTO photos VALUES ('photo-1', 'event-a', NULL), ('photo-2', 'event-a', NULL),
      ('photo-3', 'event-b', NULL), ('photo-deleted', 'event-a', '2026-01-01'),
      ('photo-in-deleted-event', 'event-deleted', NULL);
    PRAGMA foreign_keys=ON;
  `)
  return db
}

function count(db: Database, table: string): number {
  assert.ok(['tags', 'photo_tags'].includes(table))
  return Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0])
}

function seedTag(db: Database, id: string, event = 'event-a', name = 'Rick', color = '#123456', date = '2026-01-01'): void {
  db.run('INSERT INTO tags VALUES (?, ?, ?, ?, ?)', [id, event, name, color, date])
}

function link(db: Database, photo: string, tag: string): void {
  db.run('INSERT INTO photo_tags VALUES (?, ?)', [photo, tag])
}

function toggle(db: Database, nickname = 'Rick', photoId = 'photo-1', eventId = 'event-a') {
  return toggleNicknameTag(db, { photoId, eventId, nickname })
}

test('new event: first photo adds, cancels its last visible label, and adds again', (t) => {
  const db = database(t)
  const first = toggle(db)
  assert.equal(first.hasTag, true)
  assert.deepEqual(first.photoTags.map((tag) => tag.name), ['Rick'])
  assert.equal(first.eventTags[0].id, first.tag.id)

  const removed = toggle(db)
  assert.equal(removed.hasTag, false)
  assert.deepEqual(removed.photoTags, [])
  assert.deepEqual(removed.eventTags, [])
  assert.equal(listEventTags(db, 'event-a', false).length, 1)

  const addedAgain = toggle(db)
  assert.equal(addedAgain.hasTag, true)
  assert.equal(addedAgain.tag.id, first.tag.id)
  assert.equal(count(db, 'tags'), 1)
})

test('a previously hidden unused nickname definition is reused with its saved color', (t) => {
  const db = database(t)
  seedTag(db, 'saved-tag')
  assert.deepEqual(listEventTags(db, 'event-a'), [])
  const result = toggle(db)
  assert.equal(result.tag.id, 'saved-tag')
  assert.equal(result.tag.color, '#123456')
  assert.equal(result.hasTag, true)
  assert.equal(toggle(db).hasTag, false)
  assert.equal(count(db, 'tags'), 1)
})

test('nickname trimming and switching do not block cancellation or create extra definitions', (t) => {
  const db = database(t)
  const rick = toggle(db, '  Rick  ')
  const cc = toggle(db, ' CC ')
  assert.notEqual(rick.tag.id, cc.tag.id)
  assert.equal(toggle(db, 'Rick').hasTag, false)
  assert.equal(toggle(db, 'CC').hasTag, false)
  assert.equal(toggle(db, ' Rick ').tag.id, rick.tag.id)
  assert.equal(count(db, 'tags'), 2)
  assert.deepEqual(listPhotoTags(db, 'photo-1').map((tag) => tag.name), ['Rick'])
})

test('same nickname in two events stays isolated', (t) => {
  const db = database(t)
  const a = toggle(db)
  const b = toggle(db, 'Rick', 'photo-3', 'event-b')
  assert.notEqual(a.tag.id, b.tag.id)
  assert.equal(toggle(db).hasTag, false)
  assert.deepEqual(listPhotoTags(db, 'photo-3').map((tag) => tag.id), [b.tag.id])
})

test('manual get-or-create is idempotent for trimmed names, including unused tags', (t) => {
  const db = database(t)
  const first = getOrCreateTag(db, 'event-a', '  Rick ', '#abcdef')
  const again = getOrCreateTag(db, 'event-a', 'Rick', '#ffffff')
  assert.deepEqual(again, first)
  assert.equal(again.color, '#abcdef')
  assert.equal(count(db, 'tags'), 1)
  assert.throws(() => getOrCreateTag(db, 'event-a', '   '), /标签名不能为空/)
})

test('rapid intentional sequences across photos preserve every toggle and one definition', (t) => {
  const db = database(t)
  for (let i = 0; i < 20; i++) {
    assert.equal(toggle(db).hasTag, i % 2 === 0)
    assert.equal(toggle(db, 'Rick', 'photo-2').hasTag, i % 2 === 0)
  }
  assert.equal(count(db, 'tags'), 1)
  assert.equal(count(db, 'photo_tags'), 0)
})

test('missing, deleted and wrong-event photos fail without creating tags', (t) => {
  const db = database(t)
  for (const [photoId, eventId] of [
    ['missing', 'event-a'], ['photo-deleted', 'event-a'], ['photo-1', 'event-b'],
    ['photo-in-deleted-event', 'event-deleted']
  ]) {
    assert.throws(() => toggle(db, 'New nickname', photoId, eventId), /照片不存在或已删除/)
  }
  assert.equal(count(db, 'tags'), 0)
  assert.equal(count(db, 'photo_tags'), 0)
})

test('manual association rejects a foreign-event tag and missing tag without changing links', (t) => {
  const db = database(t)
  const foreign = getOrCreateTag(db, 'event-b', 'Rick')
  assert.throws(() => setPhotoTag(db, 'photo-1', 'event-a', foreign.id), /不属于当前事件/)
  assert.throws(() => setPhotoTag(db, 'photo-1', 'event-a', 'missing'), /标签不存在/)
  assert.equal(count(db, 'photo_tags'), 0)
})

test('association failure rolls back a nickname definition created by the same toggle', (t) => {
  const db = database(t)
  db.run(`CREATE TRIGGER reject_link BEFORE INSERT ON photo_tags
    BEGIN SELECT RAISE(ABORT, 'simulated write constraint'); END`)
  assert.throws(() => toggle(db, 'new nickname'), /simulated write constraint/)
  assert.equal(count(db, 'tags'), 0)
  assert.equal(count(db, 'photo_tags'), 0)
  db.run('DROP TRIGGER reject_link')
  assert.equal(toggle(db, 'new nickname').hasTag, true)
})

test('repair removes missing-parent links, merges trimmed duplicates and preserves user associations', (t) => {
  const db = database(t)
  db.run('PRAGMA foreign_keys=OFF')
  seedTag(db, 'original', 'event-a', ' Rick ', '#123456', '2026-01-01')
  seedTag(db, 'duplicate', 'event-a', 'Rick', '#ffffff', '2026-02-01')
  link(db, 'photo-1', 'original')
  link(db, 'photo-2', 'duplicate')
  link(db, 'missing-photo', 'original')
  link(db, 'photo-1', 'missing-tag')
  db.run('PRAGMA foreign_keys=ON')
  let backups = 0
  const result = repairTagIntegrity(db, undefined, () => backups++)
  assert.equal(result.removedLinks, 2)
  assert.equal(result.mergedTags, 1)
  assert.equal(result.renamedTags, 1)
  assert.equal(backups, 1)
  assert.equal(count(db, 'tags'), 1)
  assert.equal(count(db, 'photo_tags'), 2)
  for (const photoId of ['photo-1', 'photo-2']) {
    const [tag] = listPhotoTags(db, photoId)
    assert.equal(tag.id, 'original')
    assert.equal(tag.name, 'Rick')
    assert.equal(tag.color, '#123456')
  }
  assert.deepEqual(db.exec('PRAGMA foreign_key_check'), [])
  assert.equal(repairTagIntegrity(db, undefined, () => backups++).changed, false)
  assert.equal(backups, 1)
})

test('repair retains unused definitions and labels on soft-deleted photos', (t) => {
  const db = database(t)
  seedTag(db, 'unused')
  seedTag(db, 'trash-only', 'event-a', 'CC')
  link(db, 'photo-deleted', 'trash-only')
  let backups = 0
  assert.equal(repairTagIntegrity(db, 'event-a', () => backups++).changed, false)
  assert.equal(backups, 0)
  assert.equal(count(db, 'tags'), 2)
  assert.equal(count(db, 'photo_tags'), 1)
  assert.deepEqual(listEventTags(db, 'event-a'), [])
  assert.equal(toggle(db).tag.id, 'unused')
})

test('repair scopes dangling links and duplicate definitions to the requested event', (t) => {
  const db = database(t)
  db.run('PRAGMA foreign_keys=OFF')
  seedTag(db, 'a-1')
  seedTag(db, 'a-2')
  seedTag(db, 'b-1', 'event-b')
  seedTag(db, 'b-2', 'event-b')
  link(db, 'missing-a', 'a-1')
  link(db, 'missing-b', 'b-1')
  db.run('PRAGMA foreign_keys=ON')
  const result = repairTagIntegrity(db, 'event-a')
  assert.equal(result.removedLinks, 1)
  assert.equal(result.mergedTags, 1)
  assert.equal(listEventTags(db, 'event-a', false).length, 1)
  assert.equal(listEventTags(db, 'event-b', false).length, 2)
  assert.equal(count(db, 'photo_tags'), 1)
})

test('cross-event and orphan-event labels are moved into the photo event without losing the label', (t) => {
  const db = database(t)
  db.run('PRAGMA foreign_keys=OFF')
  seedTag(db, 'wrong-event', 'event-b', 'Rick', '#113355')
  seedTag(db, 'orphan-event', 'missing-event', 'CC', '#224466')
  link(db, 'photo-1', 'wrong-event')
  link(db, 'photo-2', 'orphan-event')
  db.run('PRAGMA foreign_keys=ON')
  const result = repairTagIntegrity(db)
  assert.equal(result.movedLinks, 2)
  assert.equal(result.detachedTags, 1)
  const [rick] = listPhotoTags(db, 'photo-1')
  const [cc] = listPhotoTags(db, 'photo-2')
  assert.equal(rick.name, 'Rick')
  assert.equal(rick.color, '#113355')
  assert.equal(cc.name, 'CC')
  assert.equal(cc.color, '#224466')
  assert.equal(rick.eventId, 'event-a')
  assert.equal(cc.eventId, 'event-a')
  assert.equal(count(db, 'photo_tags'), 2)
  assert.deepEqual(db.exec('PRAGMA foreign_key_check'), [])
  assert.equal(repairTagIntegrity(db).changed, false)
})

test('an automatic repair that cannot create its backup leaves all original data intact', (t) => {
  const db = database(t)
  db.run('PRAGMA foreign_keys=OFF')
  seedTag(db, 'orphan-link')
  link(db, 'missing-photo', 'orphan-link')
  db.run('PRAGMA foreign_keys=ON')
  assert.throws(() => repairTagIntegrity(db, undefined, () => { throw new Error('backup failed') }), /backup failed/)
  assert.equal(count(db, 'photo_tags'), 1)
  assert.equal(count(db, 'tags'), 1)
})

test('repair failure after partial cleanup rolls back associations, tag names and merged definitions', (t) => {
  const db = database(t)
  db.run('PRAGMA foreign_keys=OFF')
  seedTag(db, 'original', 'event-a', ' Rick ', '#123456', '2026-01-01')
  seedTag(db, 'duplicate', 'event-a', 'Rick', '#ffffff', '2026-02-01')
  link(db, 'photo-1', 'original')
  link(db, 'photo-2', 'duplicate')
  link(db, 'missing-photo', 'duplicate')
  db.run('PRAGMA foreign_keys=ON')
  const originalTags = db.exec('SELECT * FROM tags ORDER BY id')
  const originalLinks = db.exec('SELECT * FROM photo_tags ORDER BY photo_id, tag_id')
  db.run(`CREATE TRIGGER reject_merge BEFORE DELETE ON tags
    BEGIN SELECT RAISE(ABORT, 'simulated repair constraint'); END`)
  let backups = 0
  assert.throws(() => repairTagIntegrity(db, undefined, () => backups++), /simulated repair constraint/)
  assert.equal(backups, 1)
  assert.deepEqual(db.exec('SELECT * FROM tags ORDER BY id'), originalTags)
  assert.deepEqual(db.exec('SELECT * FROM photo_tags ORDER BY photo_id, tag_id'), originalLinks)
})

test('export restores foreign keys after sql.js reopens the connection, even through a repair backup', (t) => {
  const db = database(t)
  toggle(db)
  const data = exportDatabase(db)
  assert.equal(db.exec('PRAGMA foreign_keys')[0].values[0][0], 1)
  assert.throws(() => link(db, 'missing-photo', 'missing-tag'), /FOREIGN KEY constraint failed/)
  const reopened = new SQL.Database(data)
  t.after(() => reopened.close())
  reopened.run('PRAGMA foreign_keys=ON')
  assert.equal(toggle(reopened).hasTag, false)
  assert.equal(toggle(reopened).hasTag, true)
  assert.equal(count(reopened, 'tags'), 1)

  db.run('PRAGMA foreign_keys=OFF')
  link(db, 'missing-photo', listPhotoTags(db, 'photo-1')[0].id)
  db.run('PRAGMA foreign_keys=ON')
  let beforeRepair: Uint8Array | undefined
  const repair = repairTagIntegrity(db, undefined, () => { beforeRepair = exportDatabase(db) })
  assert.equal(repair.removedLinks, 1)
  assert.ok(beforeRepair?.length)
  assert.equal(db.exec('PRAGMA foreign_keys')[0].values[0][0], 1)
  assert.deepEqual(db.exec('PRAGMA foreign_key_check'), [])
})

test('persisted tag mutation returns its authoritative state and reloads from saved bytes', (t) => {
  const db = database(t)
  let saved: Uint8Array | undefined
  const result = withPersistedTags(db, () => toggle(db), () => { saved = exportDatabase(db) })
  assert.equal(result.hasTag, true)
  assert.ok(saved?.length)
  const reopened = new SQL.Database(saved)
  t.after(() => reopened.close())
  reopened.run('PRAGMA foreign_keys=ON')
  assert.deepEqual(listPhotoTags(reopened, 'photo-1'), result.photoTags)
  assert.equal(toggle(reopened).hasTag, false)
})

test('save failure after export restores exact legacy tag data and makes retry add rather than cancel', (t) => {
  const db = database(t)
  seedTag(db, 'original')
  link(db, 'photo-2', 'original')
  db.run('PRAGMA foreign_keys=OFF')
  link(db, 'missing-photo', 'original')
  link(db, 'photo-1', 'missing-tag')
  db.run('PRAGMA foreign_keys=ON')
  const originalTags = db.exec('SELECT * FROM tags ORDER BY id')
  const originalLinks = db.exec('SELECT * FROM photo_tags ORDER BY photo_id, tag_id')
  const originalEvents = db.exec('SELECT * FROM events ORDER BY id')
  const originalPhotos = db.exec('SELECT * FROM photos ORDER BY id')
  const diskError = new Error('simulated disk full after export')
  assert.throws(() => withPersistedTags(db, () => toggle(db), () => {
    db.export()
    throw diskError
  }), (error) => error === diskError)
  assert.deepEqual(db.exec('SELECT * FROM tags ORDER BY id'), originalTags)
  assert.deepEqual(db.exec('SELECT * FROM photo_tags ORDER BY photo_id, tag_id'), originalLinks)
  assert.deepEqual(db.exec('SELECT * FROM events ORDER BY id'), originalEvents)
  assert.deepEqual(db.exec('SELECT * FROM photos ORDER BY id'), originalPhotos)
  assert.equal(db.exec('PRAGMA foreign_keys')[0].values[0][0], 1)
  const retried = withPersistedTags(db, () => toggle(db), () => { exportDatabase(db) })
  assert.equal(retried.hasTag, true)
  assert.equal(retried.tag.id, 'original')
})

test('mutation exception restores both definitions and associations before propagating the same error', (t) => {
  const db = database(t)
  seedTag(db, 'saved-unused', 'event-a', 'CC')
  const originalTags = db.exec('SELECT * FROM tags ORDER BY id')
  let persistenceCalls = 0
  const mutationError = new Error('simulated mutation failure')
  assert.throws(() => withPersistedTags(db, () => {
    toggle(db)
    db.run('DELETE FROM tags WHERE id = ?', ['saved-unused'])
    throw mutationError
  }, () => { persistenceCalls++ }), (error) => error === mutationError)
  assert.equal(persistenceCalls, 0)
  assert.deepEqual(db.exec('SELECT * FROM tags ORDER BY id'), originalTags)
  assert.equal(count(db, 'photo_tags'), 0)
  assert.equal(db.exec('PRAGMA foreign_keys')[0].values[0][0], 1)
})

test('failed persistence restores a complete repair including original dangling rows and duplicate definitions', (t) => {
  const db = database(t)
  db.run('PRAGMA foreign_keys=OFF')
  seedTag(db, 'original', 'event-a', ' Rick ', '#123456', '2026-01-01')
  seedTag(db, 'duplicate', 'event-a', 'Rick', '#ffffff', '2026-02-01')
  link(db, 'photo-1', 'original')
  link(db, 'photo-2', 'duplicate')
  link(db, 'missing-photo', 'duplicate')
  db.run('PRAGMA foreign_keys=ON')
  const originalTags = db.exec('SELECT * FROM tags ORDER BY id')
  const originalLinks = db.exec('SELECT * FROM photo_tags ORDER BY photo_id, tag_id')
  let backups = 0
  assert.throws(() => withPersistedTags(db, () => repairTagIntegrity(db, undefined, () => {
    exportDatabase(db)
    backups++
  }), () => {
    exportDatabase(db)
    throw new Error('repair save failed')
  }), /repair save failed/)
  assert.equal(backups, 1)
  assert.deepEqual(db.exec('SELECT * FROM tags ORDER BY id'), originalTags)
  assert.deepEqual(db.exec('SELECT * FROM photo_tags ORDER BY photo_id, tag_id'), originalLinks)
  assert.equal(db.exec('PRAGMA foreign_keys')[0].values[0][0], 1)
})
