const log = require('pino')()

let lastUpdated = null

process.on('SIGINT', trap)
process.on('SIGQUIT', trap)
process.on('SIGTERM', trap)
process.on('uncaughtException', exception => {
  log.error(exception, 'uncaughtException')
  close()
})

function trap (signal) {
  log.info({ signal }, 'signal')
  close()
}

function close () {
  log.info('closing')
  server.close(() => {
    log.info('closed')
    process.exit(0)
  })
}

const TITLE = process.env.TITLE || 'To-Do List'

const REPOSITORY = process.env.REPOSITORY
if (!REPOSITORY) {
  log.error('no REPOSITORY in env')
  process.exit(1)
}

const USERNAME = process.env.USERNAME
if (!USERNAME) {
  log.error('no USERNAME in env')
  process.exit(1)
}

const PASSWORD = process.env.PASSWORD
if (!PASSWORD) {
  log.error('no PASSWORD in env')
  process.exit(1)
}

const path = require('path')
const addLogs = require('pino-http')({ logger: log })
const refreshPath = '/refresh'
const server = require('http').createServer((request, response) => {
  addLogs(request, response)
  const method = request.method
  if (method === 'GET') return get(request, response)
  if (method === 'POST') {
    if (request.url === refreshPath) {
      return refresh(request, response)
    } else {
      return post(request, response)
    }
  }
  response.statusCode = 405
  response.end()
})

const basicAuth = require('basic-auth')
const escapeHTML = require('escape-html')
const fs = require('fs')
const runParallel = require('run-parallel')
const moment = require('moment-timezone')
const linkifyURLs = require('linkify-urls')

const TZ = 'America/Los_Angeles'
const logos = [
  { emoji: '💸', files: ['tax'] },
  { emoji: '⚖️', files: ['practice'] },
  { emoji: '💧', files: ['waterboy'] },
  {
    image: 'waypoint.svg',
    files: ['waypoint']
  },
  { image: 'lugg.svg', files: ['lugg'] },
  {
    image: 'fontawesome.svg',
    files: ['fontawesome']
  },
  {
    image: 'discourse.svg',
    files: ['discourse', 'hawk']
  },
  {
    image: 'evilmartians.svg',
    files: ['evilmartians']
  },
  {
    image: 'blueoak.svg',
    files: ['blueoak']
  },
  {
    image: 'freecodecamp.svg',
    files: ['freecodecamp']
  }
]

function get (request, response) {
  const auth = basicAuth(request)
  if (!auth || auth.name !== USERNAME || auth.pass !== PASSWORD) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', 'Basic realm=todo')
    return response.end()
  }
  for (const { image } of logos) {
    if (request.url === '/' + image) {
      response.setHeader('Content-Type', 'image/svg+xml')
      return fs.createReadStream(`logos/${image}`)
        .pipe(response)
    }
  }
  fs.readdir(REPOSITORY, (error, entries) => {
    if (error) return internalError(error)
    const withDueDate = entries
      .filter(entry => {
        return entry !== 'sort' && !entry.startsWith('.')
      })
      .map(entry => done => { processFile(entry, done) })
    runParallel(withDueDate, (error, results) => {
      if (error) return internalError(error)
      const todos = results
        .reduce((items, array) => items.concat(array))
        .sort((a, b) => {
          if (a.dateString && b.dateString) {
            return compareDateStrings(a.dateString, b.dateString)
          } else if (a.dateString) {
            return -1
          } else {
            return 1
          }
        })
      render(todos)
    })
  })

  function internalError (error) {
    request.log.error(error)
    response.statusCode = 500
    response.end()
  }

  function render (todos) {
    const withDueDate = []
    const todayMoment = moment()
    const dueToday = []
    const overdue = []
    const upcoming = []
    const ongoing = []
    const basenames = new Set()
    todos.forEach(todo => {
      basenames.add(todo.basename)
      if (todo.dateString) {
        const todoMoment = moment.tz(todo.dateString, TZ)
        withDueDate.push(todo)
        if (todoMoment.isSame(todayMoment, 'day')) {
          todo.today = true
          dueToday.push(todo)
        } else if (todoMoment.isBefore(todayMoment, 'day')) {
          todo.overdue = true
          overdue.push(todo)
        } else {
          upcoming.push(todo)
        }
      } else {
        ongoing.push(todo)
      }
    })
    ongoing.sort((a, b) => a.basename.localeCompare(b.basename))
    const options = Array.from(basenames).map(basename => {
      return `<option>${escapeHTML(basename)}</option>`
    })
    response.end(`
<!doctype html>
<html lang=en-US>
  <head>
    <meta charset=UTF-8>
    <meta name=viewport content=width=device-width,initial-scale=1>
    <title>${escapeHTML(TITLE)}</title>
    <style>
table {
  border-collapse: collapse;
}

a[href] {
  color:inherit;
  text-decoration: none;
}

a[href]:hover {
  text-decoration: underline;
}

.overdue {
  color: darkred;
}

.today {
  color: green;
}

input {
  display: block;
  width: 100%;
  margin: 0.5rem 0;
  padding: 0.5rem;
  box-sizing: border-box;
}

header, main {
  max-width: 50rem;
  margin: 1rem auto;
}

th, td {
  padding: 0.25rem;
  vertical-align: top;
}

.columns {
  columns: 3;
}

.columns h3 {
  break-after: avoid;
}

.columns ul {
  break-indie: avoid-column;
}

.logo {
  display: inline;
  margin-right: 0.5ex;
  max-height: 1.5ex;
  max-width: 1.5ex;
  user-select: none;
}

.file {
  white-space: nowrap;
}
    </style>
  </head>
  <body>
    <header role=banner>
      <h1>${escapeHTML(TITLE)}</h1>
    </header>
    <main role=main>
      <p>Last Updated: ${lastUpdated ? lastUpdated.fromNow() : ''}</p>
      <form method=post action=${refreshPath}>
        <input type=submit value="Refresh">
      </form>
      <h2 id=new>New</h2>
      <form method=post>
        <input placeholder=client name=basename type=text list=basenames required>
        <datalist id=basenames>${options}</datalist>
        <input placeholder=text name=text type=text required>
        <input name=date type=date value=${moment().tz(TZ).format('YYYY-MM-DD')} required>
        <input type=submit>
      </form>
      <h2 id=today>Today</h2>
      ${renderTable(dueToday, false)}
      <h2 id=overdue>Overdue</h2>
      ${renderTable(overdue, true)}
      <h2 id=ongoing>Ongoing</h2>
      <div class=columns>${renderLists(ongoing)}</div>
      <h2 id=upcoming>Upcoming</h2>
      ${renderTable(upcoming, true)}
    </main>
  </body>
</html>
    `.trim())
  }
}

function renderTable (todos, dateColumn) {
  const todayMoment = moment()
  return `
  <table>
    <tbody>
      ${todos.map(row).join('')}
    </tbody>
  </table>
  `.trim()

  function row (todo) {
    let status = ''
    let dateString = todo.dateString || ''
    const todoMoment = moment.tz(dateString, TZ)
    if (dateString) {
      if (todoMoment.isSame(todayMoment, 'day')) status = 'today'
      else if (todoMoment.isBefore(todayMoment)) {
        status = 'overdue'
      }
    }
    if (dateString) {
      if (todo.today) dateString = 'today'
      else dateString = todoMoment.startOf('day').fromNow()
    }
    const basename = todo.basename
    return `
<tr class=${status}>
  <td class=file>
    ${logoFor(basename)}${escapeHTML(basename)}
  </td>
  <td>${linkifyURLs(escapeHTML(lineToDisplay(todo)))}</td>
  ${dateColumn ? `<td title="${todo.dateString}">${dateString}</td>` : ''}
</tr>
    `.trim()
  }
}

function renderLists (todos) {
  let basenames = new Set()
  todos.forEach(todo => {
    basenames.add(todo.basename)
  })
  basenames = Array.from(basenames)
  return basenames
    .map(basename => [
      basename,
      todos.filter(todo => todo.basename === basename)
    ])
    .sort((a, b) => b[1].length - a[1].length)
    .map(([basename, todos]) => {
      const subset = todos.sort((a, b) => {
        return a.line.toLowerCase().localeCompare(b.line.toLowerCase())
      })
      return `
      <h3 id="${escapeHTML(basename)}">
        ${logoFor(basename)}${escapeHTML(basename)}
      </h3>
      <ul>
        ${subset.map((todo) => `<li>${lineToDisplay(todo)}</li>`).join('')}
      </ul>
      `.trim()
    })
    .join('')
}

function lineToDisplay (todo) {
  return todo.line
    .replace(dateRE, '')
    .replace(continuingRE, '')
}

const dateRE = /(\d\d\d\d-\d\d-\d\d)/
const continuingRE = /\.\.\./

function processFile (basename, callback) {
  const file = path.join(REPOSITORY, basename)
  fs.readFile(file, 'utf8', (error, text) => {
    if (error) return callback(error)
    const lines = text
      .split('\n')
      .filter(element => !!element)
    const results = []
    lines.forEach(line => {
      const dateMatch = dateRE.exec(line)
      if (dateMatch) {
        const dateString = dateMatch[1]
        results.push({ dateString, line, basename })
      }
      const continuingMatch = continuingRE.exec(line)
      if (continuingMatch) {
        results.push({ line, continuing: true, basename })
      }
    })
    callback(null, results)
  })
}

const Busboy = require('busboy')
const runSeries = require('run-series')
const spawn = require('child_process').spawn

function post (request, response) {
  const auth = basicAuth(request)
  if (!auth || auth.name !== USERNAME || auth.pass !== PASSWORD) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', 'Basic realm=todo')
    return response.end()
  }
  let basename, text, date
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', (name, value) => {
        if (name === 'basename') {
          basename = value.trim()
        } else if (name === 'text') {
          text = value.trim()
        } else if (name === 'date') {
          date = new Date(value)
        }
      })
      .on('finish', () => {
        request.log.info({ basename, text, date }, 'data')
        const line = text + ' ' + dateToString(date)
        const file = path.join(REPOSITORY, basename)
        runSeries([
          loggedTask('reset', done => {
            resetToOriginMain(done)
          }),
          loggedTask('append', done => {
            fs.appendFile(file, '\n' + line + '\n', done)
          }),
          loggedTask('git add', done => {
            spawnGit(['add', basename], done)
          }),
          loggedTask('git commit', done => {
            spawnGit(['commit', '--allow-empty-message', '-m', ''], done)
          }),
          loggedTask('git push', done => {
            spawnGit(['push'], done)
          })
        ], error => {
          if (error) {
            response.statusCode = 500
            return response.end(error.message)
          }
          response.statusCode = 303
          response.setHeader('Location', '/')
          response.end()
        })

        function loggedTask (message, task) {
          return done => {
            task(error => {
              request.log.info('start: ' + message)
              if (error) return done(error)
              request.log.info('end: ' + message)
              done()
            })
          }
        }
      })
  )
}

function refresh (request, response) {
  resetToOriginMain(error => {
    if (error) {
      response.statusCode = 500
      response.end(error.toString())
    }
    response.statusCode = 303
    response.setHeader('Location', '/')
    response.end()
  })
}

function spawnGit (args, callback) {
  spawn('git', args, { cwd: REPOSITORY })
    .once('close', code => {
      if (code === 0) return callback()
      const chunks = []
      process.stderr
        .on('data', chunk => { chunks.push(chunk) })
        .once('end', () => {
          const output = Buffer.concat(chunks).toString()
          const description = `git ${args.join(' ')}`
          callback(new Error(`${description} failed:\n` + output))
        })
    })
}

function resetToOriginMain (callback) {
  runSeries([
    done => { spawnGit(['fetch', 'origin'], done) },
    done => { spawnGit(['reset', '--hard', 'origin/main'], done) }
  ], error => {
    if (error) return callback(error)
    lastUpdated = moment().tz(TZ)
    callback()
  })
}

server.listen(process.env.PORT || 8080, function () {
  const port = this.address().port
  log.info({ port }, 'listening')
})

resetToOriginMain(() => { log.info('reset') })

const schedule = require('node-schedule')
const EVERY_TEN_MINUTES = '*/10 * * * *'
schedule.scheduleJob(EVERY_TEN_MINUTES, () => {
  resetToOriginMain(error => {
    if (error) return log.error(error)
  })
})

function dateToString (date) {
  return (
    date.getFullYear() + '-' +
    (date.getMonth() + 1).toString().padStart(2, '0') + '-' +
    date.getDate().toString().padStart(2, '0')
  )
}

function compareDateStrings (a, b) {
  return a.trim().localeCompare(b.trim())
}

function logoFor (basename) {
  const logo = logos.find(logo => logo.files.includes(basename))
  if (!logo) return ''
  if (logo.image) return `<img class=logo src=/${logo.image}>`
  if (logo.emoji) return `<span class=logo>${logo.emoji}</span>`
  return ''
}
