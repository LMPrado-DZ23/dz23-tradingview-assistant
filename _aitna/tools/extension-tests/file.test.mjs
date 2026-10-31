import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExtension, readCatalog } from './harness.mjs'

// The CSV files are the exchange format of the extension: a parser regression silently corrupts every upload.

const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

function fileWith () {
  const extension = loadExtension(['content_scripts/file.js'])
  const { file } = extension.api('file')
  return file
}

const upload = (content, name = 'params.csv') => ({ name, content })


test('a CSV becomes rows of typed values', async () => {
  const file = fileWith()
  const rows = await file.parseCSV(upload('Parameter,From,To,Step\nlength,10,40,3\nflag,true,false,0'))
  // No phantom column: the row has exactly the header columns
  assert.deepEqual(plain(rows), [
    { parameter: 'length', from: 10, to: 40, step: 3 },
    { parameter: 'flag', from: true, to: false, step: 0 },
  ])
})

test('headers are case-insensitive and quoted values keep their commas', async () => {
  const file = fileWith()
  const rows = await file.parseCSV(upload('Name,Value\n"Stop Loss, %",1.5'))
  assert.deepEqual(plain(rows), [{ name: 'Stop Loss, %', value: 1.5 }])
})

test('empty columns are preserved, in the middle and at the end', async () => {
  const file = fileWith()
  const middle = await file.parseCSV(upload('a,b,c\n1,,3'))
  assert.deepEqual(plain(middle), [{ a: 1, b: '', c: 3 }])
  const trailing = await file.parseCSV(upload('a,b,c\n1,2,'))
  assert.deepEqual(plain(trailing), [{ a: 1, b: 2, c: '' }])
})

test('a file without the csv extension is rejected with a readable message', async () => {
  const file = fileWith()
  await assert.rejects(() => file.parseCSV(upload('a,b\n1,2', 'params.txt')), /\.csv|correct/i)
})

test('a file with a header but no rows is rejected instead of returning an empty table', async () => {
  const file = fileWith()
  await assert.rejects(() => file.parseCSV(upload('Parameter,From,To')))
})

test('an empty file is rejected', async () => {
  const file = fileWith()
  await assert.rejects(() => file.parseCSV(upload('')))
})

test('the results CSV quotes text, keeps numbers and writes filtered rows apart', () => {
  const file = fileWith()
  const csv = file.convertResultsToCSV({
    perfomanceSummary: [{ 'Total PnL': 12.5, comment: 'ok', __length: 20 }],
    filteredSummary: [{ 'Total PnL': 3, comment: 'filtered', __length: 25 }],
  })
  const lines = csv.trim().split('\n')
  assert.equal(lines[0], '"Total PnL","comment","__length"')
  assert.equal(lines[1], '12.5,"ok",20')
  assert.match(lines[2], /Bellow filtered results of tests/)
})

test('the results CSV reports an empty run instead of writing a header only', () => {
  const file = fileWith()
  assert.equal(file.convertResultsToCSV({ perfomanceSummary: [] }), 'There is no data for conversion')
  assert.equal(file.convertResultsToCSV(null), 'There is no data for conversion')
})

test('every message the popup and the scripts use exists in both catalogs', () => {
  const en = readCatalog('en')
  const pt = readCatalog('pt_BR')
  assert.equal(Object.keys(en).length, Object.keys(pt).length)
})
