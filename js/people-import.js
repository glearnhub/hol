// Import members from a CSV file (Members page).
//
//   1. Download the template, fill it in (Excel or Google Sheets). A CSV or an Excel file (.xlsx) works.
//   2. Choose the file. It is read in the browser and CHECKED by the database, which reports
//      every row: will be added, will be converted (an existing visitor with the same phone
//      number or email becomes a member), skipped (already a member, possible duplicate) or
//      error. Nothing is saved at this stage.
//   3. Press Import to save the rows that passed.
import { callRpc, errorText } from './admin-common.js'
import { el, $, setChildren, toCsv, downloadFile, toast } from './ui.js'

const TEMPLATE_COLUMNS = [
  'Full name', 'Phone', 'Alternative phone', 'Email', 'Gender', 'Membership type',
  'Membership date', 'Residence', 'Department', 'Deaconess', 'Church', 'Notes',
]

// Header spellings that are understood, by the field they fill (letters and digits only, any case).
const ALIASES = {
  full_name: ['fullname', 'name', 'membername', 'member', 'fullnames'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'tel', 'telephone', 'contact', 'phoneno'],
  alt_phone: ['alternativephone', 'altphone', 'alternatephone', 'phone2', 'secondaryphone', 'otherphone'],
  email: ['email', 'emailaddress'],
  gender: ['gender', 'sex'],
  membership_type: ['membershiptype', 'type', 'membership'],
  membership_date: ['membershipdate', 'datejoined', 'joined', 'joineddate', 'dateofmembership', 'dateofjoining'],
  residence: ['residence', 'residency', 'estate', 'location', 'area', 'address'],
  department: ['department', 'dept', 'ministry', 'servingin'],
  deaconess: ['deaconess', 'mentor', 'assigneddeaconess'],
  church: ['church', 'churchname'],
  notes: ['notes', 'note', 'remarks', 'comments'],
}

const SAMPLE_MARK = /delete this row/i
const MAX_ROWS = 2000

let parsed = null // { fileName, rows: [{ line, ...fields }], skippedSamples }
let lastResult = null
let onDone = () => {}

// ---------------------------------------------------------------------------
// CSV reading: quotes, escaped quotes, line breaks inside cells, BOM, and the
// semicolon or tab separators some Excel installations use.
// ---------------------------------------------------------------------------
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '')
  const firstLine = src.split(/\r\n|\n|\r/, 1)[0] || ''
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0]

  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else { cell += c; if (c === '\n') line++ }
    } else if (c === '"') quoted = true
    else if (c === delimiter) { row.push(cell); cell = '' }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell); cell = ''
      rows.push({ line: rowLine, cells: row })
      row = []
      line++
      rowLine = line
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push({ line: rowLine, cells: row }) }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''))
}

// Day first (17/03/2024), as written in Kenya; year first (2024-03-17) is kept as it is.
function normaliseDate(value) {
  const v = String(value || '').trim()
  if (!v) return ''
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return v // left as typed: the check reports it against its row
}

function readPeople(table) {
  if (table.length < 2) throw new Error('The file has no people in it. It needs a header row and at least one person.')

  const headers = table[0].cells.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''))
  const columnOf = {}
  for (const [field, names] of Object.entries(ALIASES)) {
    const idx = headers.findIndex((h) => names.includes(h))
    if (idx !== -1) columnOf[field] = idx
  }
  const missing = [['full_name', 'Full name'], ['phone', 'Phone']].filter(([f]) => columnOf[f] === undefined).map(([, label]) => label)
  if (missing.length) {
    throw new Error(`The file is missing the column "${missing.join('" and "')}". Download the template and use its column names.`)
  }

  const rows = []
  let skippedSamples = 0
  for (const { line, cells } of table.slice(1)) {
    const get = (field) => (columnOf[field] === undefined ? '' : (cells[columnOf[field]] || '').trim())
    const fullName = get('full_name')
    if (SAMPLE_MARK.test(fullName)) { skippedSamples++; continue }
    rows.push({
      line,
      full_name: fullName,
      phone: get('phone'),
      alt_phone: get('alt_phone'),
      email: get('email'),
      gender: get('gender'),
      membership_type: get('membership_type'),
      membership_date: normaliseDate(get('membership_date')),
      residence: get('residence'),
      department: get('department'),
      deaconess: get('deaconess'),
      church: get('church'),
      notes: get('notes'),
    })
  }
  if (rows.length === 0) throw new Error('The file has no people in it (only the sample rows from the template).')
  if (rows.length > MAX_ROWS) throw new Error(`The file has ${rows.length} people. Import at most ${MAX_ROWS} at a time: split the file into parts.`)
  return { rows, skippedSamples }
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------
export function downloadTemplate() {
  const samples = [
    ['Sample Member One (delete this row)', '0712 000 001', '', 'sample1@example.com', 'Female', 'Member', '2024-01-14', 'Kasarani', 'Choir', 'Deaconess Grace', 'Grace Chapel', 'Example only'],
    ['Sample Member Two (delete this row)', '0733 000 002', '', '', 'Male', 'In Commitment Class', '', 'Rongai', 'Ushers', '', '', ''],
  ]
  const columns = TEMPLATE_COLUMNS.map((header, i) => ({ header, value: (r) => r[i] }))
  downloadFile('members-import-template.csv', toCsv(columns, samples))
  toast('Template downloaded. Fill it in, save it as CSV and choose it here.')
}

// ---------------------------------------------------------------------------
// The check and the import
// ---------------------------------------------------------------------------
const options = () => ({
  p_create_deaconesses: $('#imp-create-dea').checked,
  p_allow_similar: $('#imp-allow-similar').checked,
  p_force_match: $('#imp-force-match').checked,
})

async function check() {
  if (!parsed) return
  const out = $('#imp-result')
  out.replaceChildren(el('p', { class: 'muted' }, 'Checking the file…'))
  $('#imp-go').disabled = true
  try {
    lastResult = await callRpc('admin_import_members', { p_rows: parsed.rows, p_commit: false, ...options() })
    renderResult()
  } catch (e) {
    lastResult = null
    setChildren(out, el('div', { class: 'notice notice-error' }, errorText(e)))
  }
}

const STATUS = {
  new: ['Will be added', 'success'],
  converted: ['Will become a member', 'info'],
  skipped: ['Skipped', 'warning'],
  error: ['Error', 'error'],
}

function renderResult(committed = false) {
  const res = lastResult
  const c = res.counts
  const showAll = $('#imp-show-all').checked
  const rows = res.rows.filter((r) => showAll || committed || (r.status !== 'new' && r.status !== 'converted') || r.status === 'converted')
  const problems = c.skipped + c.errors
  const todo = c.new + c.converted

  setChildren(
    $('#imp-result'),
    parsed.skippedSamples
      ? el('p', { class: 'muted' }, `${parsed.skippedSamples} sample row(s) from the template were ignored.`)
      : null,
    el(
      'div',
      { class: 'stats' },
      statBox(c.new, committed ? 'New members added' : 'New members to add'),
      statBox(c.converted, committed ? 'Visitors made members' : 'Visitors to make members'),
      statBox(c.skipped, 'Skipped'),
      statBox(c.errors, 'Errors')
    ),
    res.new_deaconesses && res.new_deaconesses.length
      ? el('div', { class: 'notice notice-info' }, `${committed ? 'Added to the Deaconesses list' : 'Will be added to the Deaconesses list'}: ${res.new_deaconesses.join(', ')}.`)
      : null,
    committed
      ? el(
          'div',
          { class: 'notice notice-success' },
          `${c.new} new member${c.new === 1 ? '' : 's'} added` +
            (c.converted ? ` and ${c.converted} visitor${c.converted === 1 ? '' : 's'} made member${c.converted === 1 ? '' : 's'} (their history is kept).` : '.') +
            (problems ? ` ${problems} row${problems === 1 ? ' was' : 's were'} not changed: see below.` : '')
        )
      : todo === 0
        ? el('div', { class: 'notice notice-warning' }, 'Nobody in this file can be added yet. Fix the rows below in your file and choose it again.')
        : problems
          ? el('div', { class: 'notice notice-info' }, `${todo} row${todo === 1 ? '' : 's'} will be saved. The ${problems} row${problems === 1 ? '' : 's'} below will not be, until fixed.`)
          : el('div', { class: 'notice notice-success' }, `All ${todo} rows look good.`),
    c.converted && !committed
      ? el('div', { class: 'notice notice-info' }, `${c.converted} ${c.converted === 1 ? 'person is already on record as a visitor' : 'people are already on record as visitors'} (same phone number or email). ${c.converted === 1 ? 'They' : 'They'} will become members, keeping their registrations and attendance, with the details from your file added.`)
      : null,
    rows.length
      ? el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            { class: 'data' },
            el('thead', {}, el('tr', {}, ...['Line', 'Name', 'Phone', 'Result', 'Details'].map((h) => el('th', {}, h)))),
            el(
              'tbody',
              {},
              ...rows.slice(0, 300).map((r) => {
                const [label, tone] = STATUS[r.status]
                return el(
                  'tr',
                  {},
                  el('td', {}, String(r.row)),
                  el('td', {}, r.name || '—'),
                  el('td', {}, r.phone || '—'),
                  el('td', {}, el('span', { class: `badge badge-${tone}` }, committed && r.status === 'new' ? 'Added' : committed && r.status === 'converted' ? 'Made a member' : label)),
                  el('td', {}, r.message || (r.label ? r.label : ''))
                )
              })
            )
          ),
          rows.length > 300 ? el('p', { class: 'muted' }, `Showing the first 300 of ${rows.length} rows. Download the report to see them all.`) : null
        )
      : el('p', { class: 'muted' }, 'Nothing to show: every row is fine.')
  )
  $('#imp-go').disabled = committed || todo === 0
  $('#imp-go').textContent = todo === 1 ? 'Import 1 person' : `Import ${todo} people`
  $('#imp-report').classList.toggle('hidden', problems === 0)
}

function statBox(value, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))
}

async function runImport() {
  if (!lastResult) return
  const { new: added, converted } = lastResult.counts
  if (added + converted === 0) return
  const what = [added ? `add ${added} new member${added === 1 ? '' : 's'}` : null, converted ? `make ${converted} existing visitor${converted === 1 ? ' a member' : 's members'}` : null].filter(Boolean).join(' and ')
  if (!confirm(`Import now? This will ${what}.`)) return
  const button = $('#imp-go')
  button.disabled = true
  button.textContent = 'Importing…'
  try {
    lastResult = await callRpc('admin_import_members', { p_rows: parsed.rows, p_commit: true, ...options() })
    renderResult(true)
    toast(`Import finished: ${lastResult.counts.new} added, ${lastResult.counts.converted} converted`)
    await onDone()
  } catch (e) {
    notice(e)
    button.disabled = false
  }
}

function notice(e) {
  setChildren($('#imp-result'), el('div', { class: 'notice notice-error' }, errorText(e)))
}

function downloadReport() {
  if (!lastResult) return
  const rows = lastResult.rows.filter((r) => r.status !== 'new')
  const columns = [
    { header: 'Line in your file', value: (r) => r.row },
    { header: 'Name', value: (r) => r.name || '' },
    { header: 'Phone', value: (r) => r.phone || '' },
    { header: 'Result', value: (r) => (r.status === 'skipped' ? 'Skipped' : 'Error') },
    { header: 'Why', value: (r) => r.message || '' },
  ]
  downloadFile('members-import-problems.csv', toCsv(columns, rows))
}

// ---------------------------------------------------------------------------
// Excel files (.xlsx, .xls): read with SheetJS, loaded only when one is chosen.
// The first sheet is used, and it looks exactly like the CSV table to the rest of the code.
// ---------------------------------------------------------------------------
function cellText(v) {
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return v === null || v === undefined ? '' : String(v)
}

async function readSpreadsheet(file) {
  let XLSX
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
    XLSX = mod.default || mod
  } catch {
    throw new Error('The Excel reader could not be loaded (check your internet connection), or save the sheet as CSV and choose that file instead.')
  }
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('The Excel file has no sheet in it.')
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true })
  return grid
    .map((cells, i) => ({ line: i + 1, cells: cells.map(cellText) }))
    .filter((r) => r.cells.some((c) => c.trim() !== ''))
}

async function chooseFile(e) {
  const file = e.target.files && e.target.files[0]
  parsed = null
  lastResult = null
  $('#imp-go').disabled = true
  $('#imp-report').classList.add('hidden')
  if (!file) return setChildren($('#imp-result'))
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('That file is too large. Import at most 2000 people at a time.')
    const isExcel = /\.xlsx?$/i.test(file.name)
    const table = isExcel ? await readSpreadsheet(file) : parseCsv(await file.text())
    const { rows, skippedSamples } = readPeople(table)
    parsed = { fileName: file.name, rows, skippedSamples }
    $('#imp-file-note').textContent = `${file.name}: ${rows.length} ${rows.length === 1 ? 'person' : 'people'} found.`
    await check()
  } catch (err) {
    $('#imp-file-note').textContent = ''
    setChildren($('#imp-result'), el('div', { class: 'notice notice-error' }, err.message || 'The file could not be read.'))
  }
}

export function initImport({ onImported }) {
  onDone = onImported || (() => {})
  const dialog = $('#import-dialog')
  $('#import-btn').addEventListener('click', () => {
    parsed = null
    lastResult = null
    $('#imp-file').value = ''
    $('#imp-file-note').textContent = ''
    $('#imp-result').replaceChildren()
    $('#imp-go').disabled = true
    $('#imp-go').textContent = 'Import members'
    $('#imp-report').classList.add('hidden')
    dialog.showModal()
  })
  $('#imp-template').addEventListener('click', downloadTemplate)
  $('#imp-file').addEventListener('change', chooseFile)
  $('#imp-create-dea').addEventListener('change', check)
  $('#imp-allow-similar').addEventListener('change', check)
  $('#imp-force-match').addEventListener('change', check)
  $('#imp-show-all').addEventListener('change', () => lastResult && renderResult(lastResult.committed))
  $('#imp-go').addEventListener('click', runImport)
  $('#imp-report').addEventListener('click', downloadReport)
}
