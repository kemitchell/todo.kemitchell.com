var log = require('pino')()

var lastUpdated = null

process.on('SIGINT', trap)
process.on('SIGQUIT', trap)
process.on('SIGTERM', trap)
process.on('uncaughtException', function (exception) {
  log.error(exception, 'uncaughtException')
  close()
})

function trap (signal) {
  log.info({ signal }, 'signal')
  close()
}

function close () {
  log.info('closing')
  server.close(function () {
    log.info('closed')
    process.exit(0)
  })
}

var TITLE = process.env.TITLE || 'To-Do List'

var REPOSITORY = process.env.REPOSITORY
if (!REPOSITORY) {
  log.error('no REPOSITORY in env')
  process.exit(1)
}

var USER = process.env.USER
if (!USER) {
  log.error('no USER in env')
  process.exit(1)
}

var PASSWORD = process.env.PASSWORD
if (!PASSWORD) {
  log.error('no PASSWORD in env')
  process.exit(1)
}

var path = require('path')
var addLogs = require('pino-http')({ logger: log })
var parseURL = require('url-parse')
var server = require('http').createServer(function (request, response) {
  addLogs(request, response)
  var parsed = parseURL(request.url, true)
  request.query = parsed.query
  var method = request.method
  if (method === 'GET') return get(request, response)
  if (method === 'POST') return post(request, response)
  response.statusCode = 405
  response.end()
})

var basicAuth = require('basic-auth')
var escapeHTML = require('escape-html')
var fs = require('fs')
var runParallel = require('run-parallel')
var moment = require('moment-timezone')
var linkifyURLs = require('linkify-urls')

var TZ = 'America/Los_Angeles'

function get (request, response) {
  var auth = basicAuth(request)
  if (!auth || auth.name !== USER || auth.pass !== PASSWORD) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', 'Basic realm=todo')
    return response.end()
  }
  fs.readdir(REPOSITORY, function (error, entries) {
    if (error) return internalError(error)
    var withDueDate = entries
      .filter(function (entry) {
        return entry !== 'sort' && !entry.startsWith('.')
      })
      .map(function (entry) {
        return function (done) {
          processFile(entry, done)
        }
      })
    runParallel(withDueDate, function (error, results) {
      if (error) return internalError(error)
      var todos = results
        .reduce(function (items, array) {
          return items.concat(array)
        })
        .sort(function (a, b) {
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
    var withDueDate = []
    var todayMoment = moment()
    var dueToday = []
    var ongoing = []
    var basenames = new Set()
    todos.forEach(function (todo) {
      basenames.add(todo.basename)
      if (todo.dateString) {
        var todoMoment = moment.tz(todo.dateString, TZ)
        withDueDate.push(todo)
        if (todoMoment.isSame(todayMoment, 'day')) {
          todo.today = true
          dueToday.push(todo)
        }
      } else ongoing.push(todo)
    })
    ongoing.sort(function (a, b) {
      return a.basename.localeCompare(b.basename)
    })
    var options = Array.from(basenames).map(function (basename) {
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
  padding: 0.25rem;
  box-sizing: border-box;
}

header, main {
  max-width: 40rem;
  margin: 1rem auto;
}

th, td {
  padding: 0.25rem;
  vertical-align: top;
}
    </style>
  </head>
  <body>
    <header role=banner>
      <h1>${escapeHTML(TITLE)}</h1>
    </header>
    <main role=main>
      <p>Last Updated: ${lastUpdated ? lastUpdated.fromNow() : ''}</p>
      <h2>New</h2>
      <form method=post>
        <label for=basename>Client</label>
        <input name=basename type=text list=basenames required>
        <datalist id=basenames>${options}</datalist>
        <label for=text>Text</label>
        <input name=text type=text required>
        <label for=Date>Date</label>
        <input name=date type=date value=${moment().tz(TZ).format('YYYY-MM-DD')} required>
        <input type=submit>
      </form>
      <h2>Today</h2>
      ${renderTable(dueToday, false)}
      <h2>Tasks</h2>
      ${renderTable(withDueDate, true)}
      <h2>Ongoing</h2>
      ${renderLists(ongoing)}
    </main>
  </body>
</html>
    `.trim())
  }
}

function renderTable (todos, dateColumn) {
  var todayMoment = moment()
  return `
  <table>
    <tbody>
      ${todos.map(row).join('')}
    </tbody>
  </table>
  `.trim()

  function row (todo) {
    var status = ''
    var dateString = todo.dateString || ''
    var todoMoment = moment.tz(dateString, TZ)
    if (dateString) {
      if (todoMoment.isSame(todayMoment, 'day')) status = 'today'
      else if (todoMoment.isBefore(todayMoment)) {
        status = 'overdue'
      }
    }
    if (dateString) {
      if (todo.today) dateString = 'today'
      else dateString = moment(dateString, TZ).fromNow()
    }
    return `
<tr class=${status}>
  <td>${escapeHTML(todo.basename)}</td>
  <td>${linkifyURLs(escapeHTML(lineToDisplay(todo)))}</td>
  ${dateColumn ? `<td title="${todo.dateString}">${dateString}</td>` : ''}
</tr>
    `.trim()
  }
}

function renderLists (todos) {
  var basenames = new Set()
  todos.forEach(function (todo) {
    basenames.add(todo.basename)
  })
  basenames = Array.from(basenames)
  return basenames
    .map(function (basename) {
      var subset = todos
        .filter(function (todo) {
          return todo.basename === basename
        })
        .sort(function (a, b) {
          return a.line.toLowerCase().localeCompare(b.line.toLowerCase())
        })
      return `
      <h3 id="${escapeHTML(basename)}">${escapeHTML(basename)}</h3>
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

var dateRE = /(\d\d\d\d-\d\d-\d\d)/
var continuingRE = /\.\.\./

function processFile (basename, callback) {
  var file = path.join(REPOSITORY, basename)
  fs.readFile(file, 'utf8', function (error, text) {
    if (error) return callback(error)
    var lines = text
      .split('\n')
      .filter(function (element) {
        return !!element
      })
    var results = []
    lines.forEach(function (line) {
      var dateMatch = dateRE.exec(line)
      if (dateMatch) {
        var dateString = dateMatch[1]
        results.push({ dateString, line, basename })
      }
      var continuingMatch = continuingRE.exec(line)
      if (continuingMatch) {
        results.push({ line, continuing: true, basename })
      }
    })
    callback(null, results)
  })
}

var Busboy = require('busboy')
var runSeries = require('run-series')
var spawn = require('child_process').spawn

function post (request, response) {
  var auth = basicAuth(request)
  if (!auth || auth.name !== USER || auth.pass !== PASSWORD) {
    response.statusCode = 401
    response.setHeader('WWW-Authenticate', 'Basic realm=todo')
    return response.end()
  }
  var basename, text, date
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', function (name, value) {
        if (name === 'basename') {
          basename = value.trim()
        } else if (name === 'text') {
          text = value.trim()
        } else if (name === 'date') {
          date = new Date(value)
        }
      })
      .on('finish', function () {
        request.log.info({ basename, text, date }, 'data')
        var line = text + ' ' + dateToString(date)
        var file = path.join(REPOSITORY, basename)
        runSeries([
          loggedTask('reset', function (done) {
            resetToOriginMaster(done)
          }),
          loggedTask('append', function (done) {
            fs.appendFile(file, '\n' + line + '\n', done)
          }),
          loggedTask('git add', function (done) {
            spawnGit(['add', basename], done)
          }),
          loggedTask('git commit', function (done) {
            spawnGit(['commit', '--allow-empty-message', '-m', ''], done)
          }),
          loggedTask('git push', function (done) {
            spawnGit(['push'], done)
          })
        ], function (error) {
          if (error) {
            response.statusCode = 500
            return response.end(error.message)
          }
          response.statusCode = 303
          response.setHeader('Location', '/')
          response.end()
        })

        function loggedTask (message, task) {
          return function (done) {
            task(function (error) {
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

function spawnGit (args, callback) {
  var process = spawn('git', args, { cwd: REPOSITORY })
    .once('close', function (code) {
      if (code === 0) return callback()
      var chunks = []
      process.stderr
        .on('data', function (chunk) {
          chunks.push(chunk)
        })
        .once('end', function () {
          var output = Buffer.concat(chunks).toString()
          var description = `git ${args.join(' ')}`
          callback(new Error(`${description} failed:\n` + output))
        })
    })
}

function resetToOriginMaster (callback) {
  runSeries([
    function (done) {
      spawnGit(['fetch', 'origin'], done)
    },
    function (done) {
      spawnGit(['reset', '--hard', 'origin/master'], done)
    }
  ], function (error) {
    if (error) return callback(error)
    lastUpdated = moment().tz(TZ)
    callback()
  })
}

server.listen(process.env.PORT || 8080, function () {
  var port = this.address().port
  log.info({ port }, 'listening')
})

resetToOriginMaster(function () {
  log.info('reset')
})

var schedule = require('node-schedule')
var EVERY_TEN_MINUTES = '*/10 * * * *'
schedule.scheduleJob(EVERY_TEN_MINUTES, function () {
  resetToOriginMaster(function (error) {
    if (error) return log.error(error)
    log.info('reset')
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
